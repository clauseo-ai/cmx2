"""peers for stream.test.ts, in processes of their own, on raw sockets with a small receive buffer.

  read <port> <rate KB/s, 0 flat out> <ka|-> <cursor|-> <need> <timeout s>
      reads /global/event at a steady rate through a 64 KB receive buffer (a slow link on loopback), resuming
      from its last id whenever the daemon closes the stream, until `need` turns have settled. prints
      {"ready": true} once subscribed, then one json line: done, resumes, bytes, frames (logged), gaps, secs.
  stall <port> <ka|->
      subscribes and reads nothing until a line arrives on stdin, then reads for 10 s and prints
      {"closed", "reached", "secs"}.

  race <port> <n> <path>
      n times on fresh connections: GET <path>, then 0 to 2.5 ms later and without waiting for the answer,
      GET /global/event; prints {"n", "lost", "front", "hop"}: an answer lost is a first response missing or
      not whole before the stream's; front and hop say who answered the stream (the front writes `date` first).

`ka` sends a /global/health first on the same connection, so the stream is a kept-alive connection's
second request, as a pooled http client sends it. with PEER_GZIP=1 in the environment, read and stall ask
for the gzip stream (?gzip=1 and Accept-Encoding: gzip); read decodes it as it arrives with python's zlib.
"""

import json
import re
import select
import socket
import sys
import time
import zlib
import os

GZIP = os.environ.get("PEER_GZIP") == "1"
STREAM = "/global/event?gzip=1" if GZIP else "/global/event"
ENC = "Accept-Encoding: gzip\r\n" if GZIP else ""


def connect(port, ka):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
    s.connect(("127.0.0.1", port))
    if ka:
        s.sendall(f"GET /global/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode())
        h = b""
        while b"\r\n\r\n" not in h:
            h += s.recv(65536)
        while not (h.endswith(b"\r\n0\r\n\r\n") or b"content-length" in h.lower() and body_done(h)):
            c = s.recv(65536)
            if not c:
                break
            h += c
    return s


def body_done(h):
    head, _, body = h.partition(b"\r\n\r\n")
    m = re.search(rb"content-length: *(\d+)", head, re.I)
    return m is not None and len(body) >= int(m.group(1))


def read(port, rate, ka, cursor, need, timeout):
    rate = rate * 1024
    last = cursor
    resumes = total = resets = 0
    seqs = []
    settled = set()
    ready = False
    t0 = time.time()
    done = False
    while not done and time.time() - t0 < timeout:
        s = connect(port, ka)
        cur = f"Last-Event-ID: {last}\r\n" if last else ""
        s.sendall(f"GET {STREAM} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\n{ENC}{cur}\r\n".encode())
        buf = b""
        text = b""
        head = False
        inflate = zlib.decompressobj(16 + zlib.MAX_WBITS) if GZIP else None
        started = time.time()
        got = 0
        while time.time() - t0 < timeout:
            try:
                c = s.recv(4096)
            except OSError:
                c = b""
            if not c:
                break
            total += len(c)
            got += len(c)
            if rate > 0:
                ahead = got / rate - (time.time() - started)
                if ahead > 0:
                    time.sleep(ahead)
            buf += c
            if not head:
                i = buf.find(b"\r\n\r\n")
                if i < 0:
                    continue
                if GZIP and b"content-encoding: gzip" not in buf[:i].lower():
                    print(json.dumps({"error": "the stream is not gzip"}), flush=True)
                    sys.exit(1)
                buf = buf[i + 4 :]
                head = True
                if not ready:
                    print(json.dumps({"ready": True}), flush=True)
                    ready = True
            while True:
                e = buf.find(b"\r\n")
                if e < 0:
                    break
                n = int(buf[:e], 16)
                if n == 0 or len(buf) < e + 2 + n + 2:
                    break
                chunk = buf[e + 2 : e + 2 + n]
                text += inflate.decompress(chunk) if inflate else chunk
                buf = buf[e + 2 + n + 2 :]
            while True:
                i = text.find(b"\n\n")
                if i < 0:
                    break
                f = text[:i].decode()
                text = text[i + 2 :]
                m = re.search(r"^id: (\S+)$", f, re.M)
                if m:
                    last = m.group(1)
                    if '"type":"stream.reset"' in f:
                        resets += 1
                    else:
                        seqs.append(int(last.split(":")[1]))
                if '"type":"session.idle"' in f:
                    sid = re.search(r'"sessionID":"([^"]+)"', f)
                    settled.add(sid.group(1) if sid else len(settled))
                    if len(settled) >= need:
                        done = True
            if done:
                break
        s.close()
        if not done:
            resumes += 1
    gaps = sum(1 for a, b in zip(seqs, seqs[1:]) if b != a + 1)
    print(json.dumps({"done": done, "resumes": resumes, "bytes": total, "frames": len(seqs), "gaps": gaps, "resets": resets, "secs": round(time.time() - t0, 1)}), flush=True)


def stall(port, ka):
    s = connect(port, ka)
    s.sendall(f"GET {STREAM} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\n{ENC}\r\n".encode())
    print(json.dumps({"ready": True}), flush=True)
    sys.stdin.readline()
    reached = 0
    closed = False
    t = time.time()
    s.setblocking(False)
    while time.time() - t < 10:
        r, _, _ = select.select([s], [], [], 0.5)
        if r:
            try:
                c = s.recv(1 << 20)
            except OSError:
                c = b""
            if not c:
                closed = True
                break
            reached += len(c)
    print(json.dumps({"closed": closed, "reached": reached, "secs": round(time.time() - t, 2)}), flush=True)


def race(port, n, path):
    lost = front = hop = 0
    for i in range(n):
        gap = (i % 6) * 0.0005
        s = socket.create_connection(("127.0.0.1", port))
        s.settimeout(3)
        s.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode())
        if gap:
            time.sleep(gap)
        s.sendall(f"GET /global/event HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode())
        buf = b""
        t = time.time()
        try:
            while b'"type":"server.connected"' not in buf and time.time() - t < 3:
                c = s.recv(65536)
                if not c:
                    break
                buf += c
        except OSError:
            pass
        s.close()
        heads = re.split(rb"(?=HTTP/1\.1 \d{3} )", buf)
        heads = [h for h in heads if h]
        whole = len(heads) == 2 and heads[0].startswith(b"HTTP/1.1 200") and b"application/json" in heads[0].lower() and b'"type":"server.connected"' in heads[1]
        if not whole:
            lost += 1
        elif heads[1].split(b"\r\n")[1].startswith(b"date: "):
            front += 1
        else:
            hop += 1
    print(json.dumps({"n": n, "lost": lost, "front": front, "hop": hop}), flush=True)


if __name__ == "__main__":
    mode, port = sys.argv[1], int(sys.argv[2])
    if mode == "race":
        race(port, int(sys.argv[3]), sys.argv[4])
    elif mode == "stall":
        stall(port, sys.argv[3] == "ka")
    else:
        rate, ka, cursor, need, timeout = float(sys.argv[3]), sys.argv[4] == "ka", sys.argv[5], int(sys.argv[6]), float(sys.argv[7])
        read(port, rate, ka, None if cursor == "-" else cursor, need, timeout)

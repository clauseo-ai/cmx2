/* the static diagrams: the architecture overview in the readme, the detailed one in docs/architecture.md and
   the sequence of one turn that spawns a helper. one drawing function each, themed by the caller.

   type is 18 units or more everywhere, which is 12 px or more at a 830 px column. that sets how much text
   fits, so the boxes carry a few words each. */

import { Doc } from "./doc.ts";
import type { Theme } from "./theme.ts";

/** clients on the left, the daemon and its parts in the middle, pi and the providers on the right.
    detail adds the package behind each wide box and a second line in the narrow ones. */
export function architecture(t: Theme, detail: boolean): string {
  const W = 1200;
  const H = detail ? 760 : 702;
  const doc = new Doc(
    W,
    H,
    t,
    "cmx2 architecture",
    "clients talk http and server-sent events to one daemon. the daemon holds the server, the engine, tools, helper agents, background jobs, worktrees and a sqlite store. the engine calls pi, which calls the model providers.",
  );

  /* clients */
  doc.add(doc.eyebrow(30, 66, "clients"));
  const clients: [string, string][] = [
    ["boxbox", "web app + server"],
    ["terminal", "cmx2"],
    ["headless", "cmx2 run"],
    ["your scripts", "@cmx2/client"],
  ];
  const CY = [96, 190, 284, 378];
  clients.forEach(([n, s], i) => doc.add(doc.node(30, CY[i]!, 220, 80, n, [s])));
  const cap = detail
    ? ["http in, sse out.", "websocket terminals.", "headless uses a running", "daemon or starts one", "on loopback."]
    : ["http in, sse out.", "headless uses a daemon", "or starts its own."];
  cap.forEach((l, i) => doc.add(doc.text(30, 506 + i * 26, l, "lbm")));

  /* daemon */
  const DX = 310;
  const DW = 580;
  doc.add(`<rect x="${DX}" y="40" width="${DW}" height="${H - 70}" rx="18" class="zone"/>`);
  doc.add(doc.text(DX + 26, 78, "cmx2 daemon", "t"), doc.text(DX + DW - 26, 78, "one bun process", "s", "end"));
  const IX = DX + 26;
  const IW = DW - 52;
  doc.add(doc.node(IX, 96, IW, 80, "server", ["auth, routes, events, run lock"], { pkg: detail ? "@cmx2/server" : undefined }));
  doc.add(doc.node(IX, 212, IW, 80, "engine", ["sessions, effort, prompt cache"], { pkg: detail ? "@cmx2/engine" : undefined }));
  const GH = detail ? 108 : 82;
  const gw = (IW - 16) / 2;
  const R1 = 328;
  const R2 = R1 + GH + 34;
  const grid: [string, string[], number, number][] = [
    ["tools", detail ? ["files, shell, mcp", "+ run script"] : ["files, shell, mcp"], IX, R1],
    ["actors", detail ? ["helpers and routing", "five verbs"] : ["helpers and routing"], IX + gw + 16, R1],
    ["procs", detail ? ["jobs, terminals", "auto-reaped"] : ["jobs, terminals"], IX, R2],
    ["worktrees", detail ? ["checkouts on request", "squash-merge"] : ["checkouts on request"], IX + gw + 16, R2],
  ];
  grid.forEach(([n, l, x, y]) => doc.add(doc.node(x, y, gw, GH, n, l)));
  const SY = R2 + GH + 34;
  doc.add(doc.node(IX, SY, IW, 82, "store", ["sqlite state, jsonl transcripts"], { pkg: detail ? "@cmx2/store" : undefined }));

  /* wires inside the daemon */
  const mid = IX + IW / 2;
  const c1 = IX + gw / 2;
  const c2 = IX + gw + 16 + gw / 2;
  doc.add(doc.wire([[mid, 176], [mid, 212]], { head: true, color: "violet" }));
  doc.add(doc.wire([[c1, 292], [c1, R1]], { head: true, color: "violet" }));
  doc.add(doc.wire([[c2, 292], [c2, R1]], { head: true, color: "violet" }));
  doc.add(doc.wire([[c1, R1 + GH], [c1, R2]], { head: true, color: "violet" }));
  doc.add(doc.wire([[c2, R1 + GH], [c2, R2]], { head: true, color: "violet" }));
  doc.add(doc.wire([[c1, R2 + GH], [c1, SY]], { dash: true }));
  doc.add(doc.wire([[c2, R2 + GH], [c2, SY]], { dash: true }));

  /* clients to the server: a bus on the left, ending at the server's middle */
  const bus = 280;
  const sy = 136;
  clients.forEach((_, i) => {
    const y = CY[i]! + 40;
    doc.add(doc.wire([[250, y], [bus, y]], { color: "violet", dash: i === 2 }));
    if (i > 0) doc.add(doc.wire([[bus, y], [bus, CY[i - 1]! + 40]], { color: "violet" }));
  });
  doc.add(doc.wire([[bus, sy], [IX, sy]], { head: true, color: "violet" }));

  /* pi and providers */
  const PX = 920;
  doc.add(doc.eyebrow(PX, 66, "outside the daemon"));
  doc.add(doc.node(PX, 96, 250, 112, "pi", ["open source loop", "and provider layer"], { ext: true }));
  doc.add(doc.wire([[IX + IW, 252], [895, 252], [895, 152], [PX, 152]], { head: true, color: "violet" }));
  doc.add(doc.wire([[PX + 125, 208], [PX + 125, 268]], { head: true, color: "violet" }));
  doc.add(doc.tag(PX + 125, 238, "https", "lbm"));
  doc.add(doc.node(PX, 268, 250, 170, "model providers", ["anthropic", "google", "or openai-compatible", "endpoint"], { ext: true }));
  ["a provider's cache", "matches the stable", "start of a request."].forEach((l, i) => doc.add(doc.text(PX, 484 + i * 26, l, "lbm")));
  return doc.toString();
}

/** one turn that spawns a helper, as a sequence. calls are solid violet, returns are dashed. */
export function sequence(t: Theme): string {
  const W = 1200;
  const H = 980;
  const doc = new Doc(
    W,
    H,
    t,
    "one turn that spawns a helper",
    "a client posts a prompt. the daemon builds a request with a byte-identical prefix and sends it to the model through pi. the model streams text and a tool call, the daemon runs the tools, spawns a helper that works with its own requests and reports back, then sends the next step and streams the final message to the client.",
  );
  const X = { client: 120, daemon: 420, model: 790, helper: 1080 };
  const head: [keyof typeof X, string, string][] = [
    ["client", "client", "boxbox, scripts"],
    ["daemon", "cmx2 daemon", "server + engine"],
    ["model", "model", "pi + provider"],
    ["helper", "helper agent", "own session"],
  ];
  const TOP = 36;
  const BOT = 912;
  head.forEach(([k, n, l]) => {
    doc.add(doc.node(X[k] - 108, TOP, 216, 82, n, [l], { ext: k === "model" }));
    doc.add(`<path d="M${X[k]} ${TOP + 82}V${BOT}" class="life"/>`);
  });

  const bar = (x: number, y1: number, y2: number, c = "violet") => doc.add(`<rect x="${x - 5}" y="${y1}" width="10" height="${y2 - y1}" rx="3" class="act-${c}"/>`);
  bar(X.daemon, 150, 902);
  bar(X.model, 268, 358, "muted");
  bar(X.model, 556, 624, "muted");
  bar(X.model, 744, 836, "muted");
  bar(X.helper, 506, 674);

  const msg = (from: keyof typeof X, to: keyof typeof X, y: number, label: string, ret = false) => {
    const dir = X[to] > X[from] ? 1 : -1;
    const x1 = X[from] + 5 * dir;
    const x2 = X[to] - 5 * dir;
    doc.add(doc.wire([[x1, y], [x2, y]], { head: true, dash: ret, color: ret ? "muted" : "violet" }));
    doc.add(doc.text(Math.min(x1, x2) + 14, y - 10, label, "lb"));
  };
  const self = (y: number, label: string) => {
    const x = X.daemon + 5;
    doc.add(doc.wire([[x, y], [x + 36, y], [x + 36, y + 30], [x, y + 30]], { head: true, color: "violet" }));
    doc.add(doc.text(x + 52, y + 21, label, "lb"));
  };
  /* the prefix and the tail of a request, in the colours of the hero */
  const cells = (y: number) => {
    for (let i = 0; i < 12; i++) doc.add(`<rect x="${X.daemon + 24 + i * 14}" y="${y}" width="10" height="14" rx="2" class="${i < 9 ? "pre" : "tail"}"/>`);
  };

  msg("client", "daemon", 170, "POST /session/:id/prompt");
  self(208, "auth, lock, build request");
  msg("daemon", "model", 292, "request: same prefix, new tail");
  cells(304);
  msg("model", "daemon", 352, "stream: text, then a tool call", true);
  msg("daemon", "client", 402, "events over sse", true);
  self(446, "permission check, run tools");

  msg("daemon", "helper", 528, "spawn(brief, cheaper model)");
  msg("helper", "model", 582, "its own requests");
  msg("model", "helper", 618, "answer", true);
  msg("helper", "daemon", 668, "report to the parent's mailbox", true);
  doc.add(doc.tag(X.helper, 710, "parked, warm", "lbm"));

  msg("daemon", "model", 770, "next step, report in the tail");
  cells(782);
  msg("model", "daemon", 830, "final message", true);
  msg("daemon", "client", 880, "events: session.status", true);

  doc.add(doc.tag(X.daemon, 944, "every change lands in sqlite and the event log", "lbm"));
  return doc.toString();
}

/* the animated hero, in two layouts: wide (desktop) and tall (phone). one ten second loop: a client sends a
   prompt, the daemon builds a request whose prefix is the same bytes every step (the lit cells) while the
   tail changes, helper agents fan out, light up, report and park, and every client sees the result.

   pure svg and css keyframes, system fonts only, so github plays it inside an <img>. the base styles are a
   still frame (one helper working, one done, two parked); prefers-reduced-motion keeps that frame.

   type is never below 18 units in the wide layout (12 px at a 830 px column) or 19 in the tall one
   (12 px at a 390 px phone). */

import { cssVars, MONO, type Theme } from "./theme.ts";

const D = 10; // loop length in seconds

type Props = Record<string, string | number>;
type Stop = [number, Props];

const fmt = (n: number) => +n.toFixed(3);
const css = (p: Props) => Object.entries(p).map(([k, v]) => `${k}:${v}`).join(";");

function kf(name: string, stops: Stop[]): string {
  const body = stops.map(([t, p]) => `${fmt((t / D) * 100)}%{${css(p)}}`).join("");
  return `@keyframes ${name}{${body}}`;
}

/** hold `init`, then at each step move to `to` over `dur` seconds. ends back on the first state. */
function track(init: Props, steps: [at: number, dur: number, to: Props][]): Stop[] {
  const stops: Stop[] = [[0, init]];
  let cur = init;
  for (const [at, dur, to] of steps) {
    if (stops[stops.length - 1]![0] !== at) stops.push([at, cur]);
    stops.push([at + dur, to]);
    cur = to;
  }
  stops.push([D, cur]);
  return stops;
}

type Trip = [from: number, to: number, dir: 1 | -1];

/** a dot that travels a path: pathLength is 100 and the dash is a point, so only the offset moves */
function trips(list: Trip[]): Stop[] {
  const hidden = (off: number): Props => ({ opacity: 0, "stroke-dashoffset": off });
  const stops: Stop[] = [[0, hidden(0)]];
  for (const [a, b, dir] of list) {
    const s = dir === 1 ? 0 : -100;
    const e = dir === 1 ? -100 : 0;
    stops.push([a - 0.001, hidden(s)]);
    stops.push([a, { opacity: 0, "stroke-dashoffset": s }]);
    stops.push([a + 0.08, { opacity: 1, "stroke-dashoffset": s + (e - s) * 0.1 }]);
    stops.push([b - 0.08, { opacity: 1, "stroke-dashoffset": s + (e - s) * 0.9 }]);
    stops.push([b, { opacity: 0, "stroke-dashoffset": e }]);
  }
  stops.push([D, hidden(0)]);
  return stops;
}

const an = (name: string, ease = "ease-in-out") => `style="animation:${name} ${D}s ${ease} infinite"`;

const STEPS = [1.1, 4.3, 7.5]; // when the tail of the request changes
const FAN = 2.3; // the daemon starts helpers
const DONE = [5.0, 5.9, 6.6, 7.2]; // when each helper finishes
const REPORT = 0.6;
const RESET = 9.5;
const EVENTS = 8.2; // the answer streams to every client

type HState = "idle" | "work" | "done" | "park";
const STILL: HState[] = ["park", "done", "work", "park"];
const HELPERS = ["explore", "edit", "test", "review"];

type Ctx = { anim: string[]; el: string[]; dark: boolean };

/** the wire under a dot, and the dot itself */
function dot(c: Ctx, id: string, d: string, list: Trip[]) {
  c.anim.push(kf(id, trips(list)));
  c.el.push(`<path d="${d}" class="wire"/>`);
  c.el.push(`<path d="${d}" pathLength="100" class="dot" ${an(id, "linear")}/>`);
}

/** four glyphs drawn as strokes, so no font is involved. the mint dot is the full stop */
function wordmark(ox: number, oy: number): string {
  return `<g transform="translate(${ox} ${oy})" fill="none" stroke="var(--ink)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
<path d="M41 7A24 24 0 1 0 41 41"/>
<path d="M70 48V13A13 13 0 0 1 96 13V48M96 13A13 13 0 0 1 122 13V48"/>
<path d="M144 2L190 46M190 2L144 46"/>
<path d="M213 15A21 15 0 0 1 255 15C255 30 224 36 213 48H258"/>
</g><circle cx="${ox + 282}" cy="${oy + 48}" r="6.5" fill="var(--mint)"/>`;
}

const text = (x: number, y: number, s: string, cls: string, anchor?: "end" | "middle") =>
  `<text x="${x}" y="${y}" class="${cls}"${anchor ? ` text-anchor="${anchor}"` : ""}>${s}</text>`;

/** a client chip. a lit outline flashes when it sends or receives. sub is dropped on a phone */
function client(c: Ctx, i: number, x: number, y: number, w: number, h: number, name: string, sub: string | null, send: boolean) {
  const cy = y + h / 2;
  const steps: [number, number, Props][] = send
    ? [[0.1, 0.2, { opacity: 1 }], [1.2, 0.5, { opacity: 0 }], [EVENTS + 0.55, 0.15, { opacity: 1 }], [EVENTS + 1.4, 0.6, { opacity: 0 }]]
    : [[EVENTS + 0.6 + 0.05 * i, 0.15, { opacity: 1 }], [EVENTS + 1.4, 0.6, { opacity: 0 }]];
  c.anim.push(kf(`cl${i}`, track({ opacity: 0 }, steps)));
  const label = sub
    ? text(x + 24, cy - 2, name, "h") + text(x + 24, cy + 24, sub, "s")
    : text(x + 24, cy + 8, name, "h");
  c.el.push(
    `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" class="card"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" class="lit" ${an(`cl${i}`)}/><rect x="${x}" y="${y + 16}" width="4" height="${h - 32}" rx="2" fill="var(--violet)"/>${label}</g>`,
  );
}

/** the request bar: prefix cells stay lit, tail cells change at every step, a sweep crosses the prefix on a cache hit */
function bar(c: Ctx, x0: number, y: number, pitch: number, cw: number, h: number, n: number, pre: number) {
  const px = (i: number) => x0 + i * pitch;
  const prefixEnd = px(pre - 1) + cw;
  const seeded = (k: number) => ((Math.sin(k * 91.7) + 1) * 4973) % 1;
  const TONES = [0.25, 0.55, 0.85, 1];
  let cells = "";
  for (let i = 0; i < n; i++) {
    if (i < pre) cells += `<rect x="${px(i)}" y="${y}" width="${cw}" height="${h}" rx="3" class="pre"/>`;
    else {
      const init = TONES[Math.floor(seeded(i) * 4)]!;
      cells += `<rect x="${px(i)}" y="${y}" width="${cw}" height="${h}" rx="3" class="tail" opacity="${init}" ${an(`tl${i}`, "linear")}/>`;
      const steps: [number, number, Props][] = [];
      STEPS.forEach((s, k) => {
        const next = { opacity: TONES[Math.floor(seeded(i * 7 + k * 13 + 1) * 4)]! };
        const jitter = ((i - pre) * 0.045) % 0.4;
        steps.push([s + jitter, 0.12, { opacity: 0.1 }], [s + jitter + 0.12, 0.2, next]);
      });
      steps.push([RESET + 0.2, 0.3, { opacity: init }]);
      c.anim.push(kf(`tl${i}`, track({ opacity: init }, steps)));
    }
  }
  const glow = c.dark ? `<rect x="${x0}" y="${y}" width="${prefixEnd - x0}" height="${h}" rx="6" fill="var(--mint)" opacity=".5" filter="url(#blur)"/>` : "";
  const away = { transform: "translateX(-60px)" };
  const sweep = STEPS.flatMap((s) => [[s + 0.4, 0.001, away] as [number, number, Props], [s + 0.401, 0.7, { transform: `translateX(${prefixEnd - x0 + 20}px)` }] as [number, number, Props]]);
  c.anim.push(kf("sweep", track(away, sweep)));
  c.el.push(
    `${glow}${cells}<clipPath id="pc"><rect x="${x0}" y="${y}" width="${prefixEnd - x0}" height="${h}" rx="3"/></clipPath><g clip-path="url(#pc)"><rect x="${x0}" y="${y}" width="26" height="${h}" class="sweep" ${an("sweep", "linear")}/></g>`,
  );
  return { px, prefixEnd, end: px(n - 1) + cw };
}

/** a helper card that wakes, works, reports and parks. wire runs from the daemon to the card */
function helper(c: Ctx, i: number, x: number, y: number, w: number, h: number, wire: string) {
  const cy = y + h / 2;
  const k = `h${i}`;
  const start = FAN + 0.6 + 0.12 * i;
  const done = DONE[i]!;
  const parked = done + 1.0;
  dot(c, `fw${i}`, wire, [[FAN + 0.12 * i, FAN + 0.12 * i + 0.65, 1], [done - REPORT, done, -1]]);

  const idle: Props = { stroke: "var(--faint)", fill: "var(--card)" };
  const work: Props = { stroke: "var(--violet)", fill: "var(--violet-fill)" };
  const fin: Props = { stroke: "var(--mint)", fill: "var(--mint-fill)" };
  c.anim.push(kf(`${k}c`, track(idle, [[start, 0.3, work], [done, 0.25, fin], [parked, 0.5, idle], [RESET, 0.4, idle]])));
  const vis = (a: number, b: number): Stop[] => track({ opacity: 0 }, [[a, 0.15, { opacity: 1 }], [b, 0.15, { opacity: 0 }]]);
  c.anim.push(kf(`${k}w`, vis(start, done)), kf(`${k}d`, vis(done, parked)));
  c.anim.push(kf(`${k}p`, track({ opacity: 0 }, [[parked, 0.3, { opacity: 1 }], [RESET, 0.4, { opacity: 0 }]])));
  c.anim.push(kf(`${k}r`, track({ stroke: "var(--faint)" }, [[done, 0.25, { stroke: "var(--mint)" }], [parked, 0.5, { stroke: "var(--faint)" }]])));

  const s = STILL[i]!;
  const cardStroke = s === "work" ? "var(--violet)" : s === "done" ? "var(--mint)" : "var(--faint)";
  const cardFill = s === "work" ? "var(--violet-fill)" : s === "done" ? "var(--mint-fill)" : "var(--card)";
  c.anim.push(
    `.${k} .card{stroke:${cardStroke};fill:${cardFill}}.${k} .ring{stroke:${s === "done" ? "var(--mint)" : "var(--faint)"}}.${k} .w{opacity:${s === "work" ? 1 : 0}}.${k} .d{opacity:${s === "done" ? 1 : 0}}.${k} .p{opacity:${s === "park" ? 1 : 0}}`,
  );
  const rx = x + 32;
  const tx = x + 60;
  c.el.push(
    `<g class="helper ${k}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" class="card" ${an(`${k}c`)}/><rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="11" class="dash p" ${an(`${k}p`)}/>
<circle cx="${rx}" cy="${cy}" r="11" class="ring" ${an(`${k}r`)}/>
<g class="w" ${an(`${k}w`)}><circle cx="${rx}" cy="${cy}" r="11" class="spin"/></g>
<path d="M${rx - 6} ${cy + 1}l4.5 4.5l8-9" class="check d" ${an(`${k}d`)}/>
${text(tx, cy - 2, HELPERS[i]!, "h")}
<text x="${tx}" y="${cy + 24}" class="s w violett" ${an(`${k}w`)}>working</text><text x="${tx}" y="${cy + 24}" class="s d mintt" ${an(`${k}d`)}>done</text><text x="${tx}" y="${cy + 24}" class="s p" ${an(`${k}p`)}>parked</text></g>`,
  );
}

const fonts = { wide: { eyebrow: 18, s: 18, h: 24, big: 26 }, tall: { eyebrow: 19, s: 19, h: 22, big: 24 } };

function wrap(c: Ctx, t: Theme, W: number, H: number, layout: "wide" | "tall"): string {
  const f = fonts[layout];
  const dark = t.name === "dark";
  const style = `${cssVars(t)}
text{font-family:${MONO}}
.eyebrow{font-size:${f.eyebrow}px;letter-spacing:.12em;fill:var(--muted)}
.h{font-size:${f.h}px;font-weight:700;fill:var(--ink)}.h.big{font-size:${f.big}px}
.s{font-size:${f.s}px;fill:var(--muted)}
.mintt{fill:var(--mint)}.ambert{fill:var(--amber)}.violett{fill:var(--violet)}
.card{fill:var(--card);stroke:var(--faint);stroke-width:1.5}.card.strong{stroke:var(--border);stroke-width:2}
.rule{stroke:var(--faint);stroke-width:1;fill:none;opacity:.7}
.pre{fill:var(--mint)}.tail{fill:var(--amber)}
.brace{fill:none;stroke-width:2;stroke-linecap:round}.brace.mint{stroke:var(--mint)}.brace.amber{stroke:var(--amber)}
.sweep{fill:#fff;opacity:${dark ? ".35" : ".55"}}
.wire{fill:none;stroke:var(--faint);stroke-width:1.5}
.dot{fill:none;stroke:var(--violet);stroke-width:9;stroke-linecap:round;stroke-dasharray:0.1 99.9;opacity:0}
.lit{fill:var(--violet-fill);stroke:var(--violet);stroke-width:2;opacity:0}
.ring{fill:none;stroke-width:2.5}
.spin{fill:none;stroke:var(--violet);stroke-width:2.5;stroke-linecap:round;stroke-dasharray:18 52;transform-box:fill-box;transform-origin:center;animation:rot 1s linear infinite}
.check{fill:none;stroke:var(--mint);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.dash{fill:none;stroke:var(--muted);stroke-width:1.2;stroke-dasharray:5 6;opacity:.7}
@keyframes rot{to{transform:rotate(360deg)}}
${c.anim.join("\n")}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.dot{opacity:0}.sweep{opacity:0}}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">cmx2</title>
<desc id="d">clients send prompts to one cmx2 daemon. each model request keeps a byte-identical prefix while only its tail changes. the daemon fans work out to helper agents, which light up, report back and park.</desc>
<defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="var(--bg1)"/><stop offset="1" stop-color="var(--bg2)"/></linearGradient>
<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="var(--grid)"/></pattern>
<filter id="blur" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="9"/></filter></defs>
<style>${style}</style>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="22" fill="url(#bg)" stroke="var(--border)"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="22" fill="url(#grid)"/>
${c.el.join("\n")}
</svg>
`;
}

const cellLabels = (c: Ctx, bx: ReturnType<typeof bar>, braceY: number, labelY: number, pre: number, x0: number, pitch: number) => {
  c.el.push(
    `<path d="M${x0} ${braceY}H${bx.prefixEnd}" class="brace mint"/><path d="M${bx.px(pre)} ${braceY}H${bx.end}" class="brace amber"/>`,
    text(x0, labelY, "same bytes every step", "s mintt"),
    text(bx.end, labelY, "new tail", "s ambert", "end"),
  );
};

/** desktop: clients, the daemon with its request bar, helpers on the right, the provider underneath */
export function hero(t: Theme): string {
  const W = 1200;
  const H = 560;
  const c: Ctx = { anim: [], el: [], dark: t.name === "dark" };
  c.el.push(wordmark(69, 54));
  c.el.push(text(64, 148, "CLIENTS", "eyebrow"), text(900, 56, "HELPER AGENTS", "eyebrow"));

  const cl: [string, string, number][] = [["boxbox", "web app + server", 162], ["terminal", "cmx2, cmx2 run", 254], ["your script", "@cmx2/client", 346]];
  cl.forEach(([n, s, y], i) => {
    const cy = y + 38;
    client(c, i, 64, y, 240, 76, n, s, i === 0);
    const trip: Trip[] = i === 0 ? [[0.3, 0.9, 1], [EVENTS, EVENTS + 0.6, -1]] : [[EVENTS + 0.05 * i, EVENTS + 0.6 + 0.05 * i, -1]];
    dot(c, `cw${i}`, `M304 ${cy}H400`, trip);
  });

  const DX = 400;
  const DY = 76;
  c.el.push(`<rect x="${DX}" y="${DY}" width="400" height="380" rx="16" class="card strong"/>`);
  c.el.push(text(424, 118, "cmx2 daemon", "h big"), text(776, 118, "one per machine", "s", "end"));
  c.el.push(`<path d="M424 136H776" class="rule"/>`, text(424, 168, "every model request", "s"));
  const bx = bar(c, 426, 184, 16, 12, 60, 22, 15);
  cellLabels(c, bx, 262, 292, 15, 426, 16);
  c.el.push(`<path d="M424 314H776" class="rule"/>`, text(424, 350, "sessions, tools, jobs,", "s"), text(424, 376, "worktrees, sqlite", "s"));
  c.el.push(text(424, 430, "clients never talk to a model.", "s"));

  const PY = 494;
  dot(c, "pw", `M600 ${DY + 380}V${PY}`, STEPS.map((s) => [s + 0.2, s + 0.6, 1] as Trip));
  c.anim.push(kf("hit", track({ opacity: 0.28 }, STEPS.flatMap((s) => [[s + 0.6, 0.15, { opacity: 1 }], [s + 1.5, 0.5, { opacity: 0.28 }]] as [number, number, Props][]))));
  c.el.push(`<rect x="430" y="${PY}" width="340" height="46" rx="12" class="card"/>${text(452, PY + 30, "model provider", "s")}<text x="748" y="${PY + 30}" class="s mintt" ${an("hit")} text-anchor="end">cache hit</text>`);

  [76, 178, 280, 382].forEach((y, i) => {
    const cy = y + 37;
    helper(c, i, 900, y, 240, 74, `M800 266C850 266 850 ${cy} 900 ${cy}`);
  });
  return wrap(c, t, W, H, "wide");
}

/** phone: stacked. clients in a row, the daemon, then the helpers in a grid on a shared bus */
export function heroTall(t: Theme): string {
  const W = 600;
  const H = 830;
  const c: Ctx = { anim: [], el: [], dark: t.name === "dark" };
  c.el.push(wordmark(46, 40));
  c.el.push(text(40, 152, "CLIENTS", "eyebrow"));

  const cl: [string, number][] = [["boxbox", 40], ["terminal", 217], ["scripts", 394]];
  cl.forEach(([n, x], i) => {
    client(c, i, x, 166, 166, 56, n, null, i === 0);
    const cx = x + 83;
    const trip: Trip[] = i === 0 ? [[0.3, 0.9, 1], [EVENTS, EVENTS + 0.6, -1]] : [[EVENTS + 0.05 * i, EVENTS + 0.6 + 0.05 * i, -1]];
    dot(c, `cw${i}`, `M${cx} 222V266`, trip);
  });

  c.el.push(`<rect x="40" y="266" width="520" height="318" rx="16" class="card strong"/>`);
  c.el.push(text(64, 312, "cmx2 daemon", "h big"), text(536, 312, "one per machine", "s", "end"));
  c.el.push(`<path d="M64 330H536" class="rule"/>`, text(64, 364, "every model request", "s"));
  c.anim.push(kf("hit", track({ opacity: 0.28 }, STEPS.flatMap((s) => [[s + 0.6, 0.15, { opacity: 1 }], [s + 1.5, 0.5, { opacity: 0.28 }]] as [number, number, Props][]))));
  c.el.push(`<text x="536" y="364" class="s mintt" ${an("hit")} text-anchor="end">cache hit</text>`);
  const bx = bar(c, 66, 380, 21.5, 16.5, 56, 22, 15);
  cellLabels(c, bx, 454, 482, 15, 66, 21.5);
  c.el.push(`<path d="M64 504H536" class="rule"/>`, text(64, 536, "sessions, tools, jobs,", "s"), text(64, 562, "worktrees, sqlite", "s"));

  c.el.push(text(40, 622, "HELPER AGENTS", "eyebrow"));
  const cols = [40, 310];
  const rows = [640, 730];
  for (let i = 0; i < 4; i++) {
    const x = cols[i % 2]!;
    const y = rows[Math.floor(i / 2)]!;
    const cy = y + 37;
    const edge = i % 2 === 0 ? 290 : 310;
    helper(c, i, x, y, 250, 74, `M300 584V${cy}H${edge}`);
  }
  return wrap(c, t, W, H, "tall");
}

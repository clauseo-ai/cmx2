/* a small svg toolkit for the static diagrams: a themed panel, cards, wires and labels. all colour comes from
   css variables, so a drawing never names a hex value. */

import { cssVars, MONO, type Theme } from "./theme.ts";

export type Accent = "violet" | "mint" | "amber" | "none";

export class Doc {
  private parts: string[] = [];
  constructor(
    readonly w: number,
    readonly h: number,
    readonly t: Theme,
    private title: string,
    private desc: string,
  ) {}

  add(...s: string[]) {
    this.parts.push(...s);
    return this;
  }

  text(x: number, y: number, s: string, cls = "s", anchor: "start" | "middle" | "end" = "start") {
    return `<text x="${x}" y="${y}" class="${cls}"${anchor === "start" ? "" : ` text-anchor="${anchor}"`}>${esc(s)}</text>`;
  }

  eyebrow(x: number, y: number, s: string, anchor: "start" | "middle" | "end" = "start") {
    return this.text(x, y, s.toUpperCase(), "eyebrow", anchor);
  }

  /** a card with a title and up to a few muted lines. ext draws it dashed, for what lives outside the daemon */
  node(x: number, y: number, w: number, h: number, title: string, lines: string[] = [], o: { ext?: boolean; accent?: Accent; pkg?: string } = {}) {
    const accent = o.accent ?? (o.ext ? "none" : "violet");
    const out = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" class="card${o.ext ? " ext" : ""}"/>`];
    if (accent !== "none") out.push(`<rect x="${x}" y="${y + 14}" width="4" height="${h - 28}" rx="2" class="ac-${accent}"/>`);
    const tx = x + 20;
    out.push(this.text(tx, y + 31, title, "t"));
    lines.forEach((l, i) => out.push(this.text(tx, y + 58 + i * 24, l, "s")));
    if (o.pkg) out.push(this.text(x + w - 16, y + 31, o.pkg, "pk", "end"));
    return out.join("");
  }

  /** a polyline wire, optionally with an arrowhead at the end (and the start) */
  wire(pts: [number, number][], o: { dash?: boolean; head?: boolean; tail?: boolean; color?: "muted" | "violet" | "mint" | "amber" } = {}) {
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
    const cls = `wire${o.dash ? " dash" : ""} w-${o.color ?? "muted"}`;
    return `<path d="${d}" class="${cls}"${o.head ? ` marker-end="url(#ah-${o.color ?? "muted"})"` : ""}${o.tail ? ` marker-start="url(#ah-${o.color ?? "muted"})"` : ""}/>`;
  }

  /** a label sitting on a wire, with a card-coloured plate behind so the line does not strike through it */
  tag(cx: number, cy: number, s: string, cls = "lb") {
    const w = Math.round(s.length * 10.8 + 18);
    return `<rect x="${cx - w / 2}" y="${cy - 15}" width="${w}" height="30" rx="7" class="plate"/>${this.text(cx, cy + 6, s, cls, "middle")}`;
  }

  toString() {
    const { w, h, t } = this;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(this.title)}</title>
<desc id="d">${esc(this.desc)}</desc>
<defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="var(--bg1)"/><stop offset="1" stop-color="var(--bg2)"/></linearGradient>
<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="var(--grid)"/></pattern>
${(["muted", "violet", "mint", "amber"] as const).map((c) => `<marker id="ah-${c}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1.5 1.5L8 5L1.5 8.5" fill="none" stroke="var(--${c})" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join("")}</defs>
<style>${cssVars(t)}
text{font-family:${MONO}}
.eyebrow{font-size:18px;letter-spacing:.12em;fill:var(--muted)}
.t{font-size:22px;font-weight:700;fill:var(--ink)}.s{font-size:18px;fill:var(--muted)}.pk{font-size:18px;fill:var(--muted)}
.lb{font-size:18px;fill:var(--ink)}.lbm{font-size:18px;fill:var(--muted)}
.plate{fill:var(--card)}.plate.bare{fill:var(--bg1)}
.card{fill:var(--card);stroke:var(--faint);stroke-width:1.5}.card.ext{stroke-dasharray:6 5;fill:none;stroke:var(--muted)}
.zone{fill:none;stroke:var(--border);stroke-width:2}
.ac-violet{fill:var(--violet)}.ac-mint{fill:var(--mint)}.ac-amber{fill:var(--amber)}
.wire{fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.wire.dash{stroke-dasharray:5 5}
.w-muted{stroke:var(--muted)}.w-violet{stroke:var(--violet)}.w-mint{stroke:var(--mint)}.w-amber{stroke:var(--amber)}
.pre{fill:var(--mint)}.tail{fill:var(--amber)}
.life{stroke:var(--faint);stroke-width:1.5;stroke-dasharray:3 6}
.rule{stroke:var(--faint);stroke-width:1;opacity:.7}
.act-violet{fill:var(--violet-fill);stroke:var(--violet);stroke-width:1.5}.act-muted{fill:var(--card);stroke:var(--muted);stroke-width:1.5}
</style>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="22" fill="url(#bg)" stroke="var(--border)"/>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="22" fill="url(#grid)"/>
${this.parts.join("\n")}
</svg>
`;
  }
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

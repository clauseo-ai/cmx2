/* colours and type shared by every generated svg. one palette per colour scheme; the svgs read them as
   css variables, so a diagram's drawing code never names a hex value. */

export type Theme = {
  name: "light" | "dark";
  bg1: string;
  bg2: string;
  border: string;
  ink: string;
  muted: string;
  faint: string;
  card: string;
  violet: string;
  violetFill: string;
  mint: string;
  mintFill: string;
  amber: string;
  amberFill: string;
  grid: string;
};

export const dark: Theme = {
  name: "dark",
  bg1: "#1a1544",
  bg2: "#0b0a1d",
  border: "#332b6e",
  ink: "#f4f4f6",
  muted: "#9a95c9",
  faint: "#3f3879",
  card: "#14112f",
  violet: "#b7abff",
  violetFill: "rgba(183,171,255,0.14)",
  mint: "#8fe6a5",
  mintFill: "rgba(143,230,165,0.12)",
  amber: "#ffb86b",
  amberFill: "rgba(255,184,107,0.12)",
  grid: "rgba(183,171,255,0.10)",
};

export const light: Theme = {
  name: "light",
  bg1: "#fcfbff",
  bg2: "#eeecfb",
  border: "#cdc7f0",
  ink: "#1b1546",
  muted: "#625b8c",
  faint: "#c4bee8",
  card: "#ffffff",
  violet: "#5a43d6",
  violetFill: "rgba(90,67,214,0.09)",
  mint: "#1f9d55",
  mintFill: "rgba(31,157,85,0.10)",
  amber: "#d9700a",
  amberFill: "rgba(217,112,10,0.10)",
  grid: "rgba(90,67,214,0.09)",
};

/** system fonts only: github's image proxy cannot load web fonts */
export const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
export const SANS = 'ui-sans-serif, -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif';

export function cssVars(t: Theme): string {
  return `:root{--bg1:${t.bg1};--bg2:${t.bg2};--border:${t.border};--ink:${t.ink};--muted:${t.muted};--faint:${t.faint};--card:${t.card};--violet:${t.violet};--violet-fill:${t.violetFill};--mint:${t.mint};--mint-fill:${t.mintFill};--amber:${t.amber};--amber-fill:${t.amberFill};--grid:${t.grid}}`;
}

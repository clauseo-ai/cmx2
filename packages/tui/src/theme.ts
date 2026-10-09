import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Color, getTerminalColorMode, type MarkdownTheme, parseColor, type SelectListTheme, styleText, type TerminalColorMode, type TextStyle } from "@earendil-works/pi-tui";

/**
 * the palette. every colour the tui draws comes from one of these slots, so a theme file only has to
 * name the slots it wants to change. values are anything pi-tui's parseColor reads: `#rrggbb`,
 * `oklch(70% 0.12 220)`, `okhsl(...)` or a 0-255 terminal palette index.
 */
export interface Palette {
	/** body text */
	text: string;
	/** secondary text: hints, timings, collapsed reasoning */
	muted: string;
	/** the brand colour: borders, headings, the prompt marker */
	accent: string;
	/** what you typed */
	user: string;
	/** tool names and code */
	tool: string;
	/** done, allowed */
	ok: string;
	/** asks, retries, queued */
	warn: string;
	/** errors, rejects */
	error: string;
	/** the selected row in a picker */
	selection: string;
	/** dialogs' border */
	border: string;
}

/** tuned to read on dark terminals; soft, not neon */
export const DARK: Palette = {
	text: "#d8dee4",
	muted: "#7d8590",
	accent: "#e8a33d",
	user: "#8fb8de",
	tool: "#b39ddb",
	ok: "#7fbf7f",
	warn: "#e8c170",
	error: "#e07a7a",
	selection: "#e8a33d",
	border: "#4b5563",
};

/** the same hues, darker, for light terminals */
export const LIGHT: Palette = {
	text: "#24292f",
	muted: "#6e7781",
	accent: "#b3620b",
	user: "#1f5f99",
	tool: "#6f42c1",
	ok: "#1a7f37",
	warn: "#9a6700",
	error: "#cf222e",
	selection: "#b3620b",
	border: "#afb8c1",
};

export interface ThemeFile {
	/** dark, light, or auto (the default: COLORFGBG when the terminal sets it, else dark) */
	mode?: "dark" | "light" | "auto";
	/** slots to override on top of the chosen base */
	colors?: Partial<Palette>;
}

export type Style = (text: string) => string;

export interface Theme {
	name: "dark" | "light";
	palette: Palette;
	fg: Record<keyof Palette, Style>;
	bold: Style;
	dim: Style;
	italic: Style;
	markdown: MarkdownTheme;
	select: SelectListTheme;
	editor: { borderColor: Style; selectList: SelectListTheme };
}

/** `COLORFGBG=15;0` means light text on a dark background; the last field is the background index */
export function guessMode(env: NodeJS.ProcessEnv = process.env): "dark" | "light" {
	const bg = Number(env.COLORFGBG?.split(";").pop());
	if (Number.isInteger(bg) && (bg === 7 || bg === 15 || (bg >= 9 && bg <= 14 && bg !== 12))) return "light";
	return "dark";
}

/** reads `<config dir>/tui.json`; a missing file is the defaults, a broken one says so and uses them */
export function readThemeFile(configDir: string): { file: ThemeFile; warning?: string } {
	const path = join(configDir, "tui.json");
	if (!existsSync(path)) return { file: {} };
	try {
		const v = JSON.parse(readFileSync(path, "utf8"));
		const t = v?.theme ?? v;
		return { file: typeof t === "object" && t ? (t as ThemeFile) : {} };
	} catch (e) {
		return { file: {}, warning: `${path} is not valid json (${e instanceof Error ? e.message : String(e)}); using the default theme` };
	}
}

/** the profile directory, as the engine computes it (CMX2_CONFIG_DIR, then XDG, then ~/.config/cmx2) */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CMX2_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cmx2");
}

function color(value: string, slot: string, warnings: string[]): Color | undefined {
	try {
		return parseColor(/^\d+$/.test(value) ? Number(value) : value);
	} catch {
		warnings.push(`tui.json: ${slot} ${JSON.stringify(value)} is not a colour; kept the default`);
		return undefined;
	}
}

export function buildTheme(file: ThemeFile = {}, opts: { env?: NodeJS.ProcessEnv; mode?: TerminalColorMode | "none" } = {}): { theme: Theme; warnings: string[] } {
	const warnings: string[] = [];
	const name = file.mode === "dark" || file.mode === "light" ? file.mode : guessMode(opts.env);
	const base = name === "light" ? LIGHT : DARK;
	const palette: Palette = { ...base };
	const colors: Partial<Record<keyof Palette, Color>> = {};
	for (const key of Object.keys(base) as (keyof Palette)[]) {
		const want = file.colors?.[key];
		const parsed = want !== undefined ? color(String(want), key, warnings) : undefined;
		if (parsed) palette[key] = String(want);
		colors[key] = parsed ?? parseColor(base[key]);
	}
	const env = opts.env ?? process.env;
	const plain = opts.mode === "none" || env.NO_COLOR !== undefined;
	const mode: TerminalColorMode = opts.mode && opts.mode !== "none" ? opts.mode : getTerminalColorMode();
	const paint = (s: TextStyle): Style => (plain ? (t) => t : (t) => styleText(t, s, mode));
	const fg = Object.fromEntries((Object.keys(colors) as (keyof Palette)[]).map((k) => [k, paint({ fg: colors[k] })])) as Record<keyof Palette, Style>;
	const bold = paint({ bold: true });
	const dim = paint({ fg: colors.muted });
	const italic = paint({ italic: true });
	const select: SelectListTheme = {
		selectedPrefix: paint({ fg: colors.selection, bold: true }),
		selectedText: paint({ fg: colors.selection, bold: true }),
		description: dim,
		scrollInfo: dim,
		noMatch: paint({ fg: colors.warn }),
	};
	const markdown: MarkdownTheme = {
		heading: paint({ fg: colors.accent, bold: true }),
		link: paint({ fg: colors.user, underline: true }),
		linkUrl: dim,
		code: fg.tool,
		codeBlock: fg.text,
		codeBlockBorder: dim,
		quote: paint({ fg: colors.muted, italic: true }),
		quoteBorder: dim,
		hr: dim,
		listBullet: fg.accent,
		bold,
		italic,
		strikethrough: paint({ strikethrough: true }),
		underline: paint({ underline: true }),
	};
	return { theme: { name, palette, fg, bold, dim, italic, markdown, select, editor: { borderColor: fg.border, selectList: select } }, warnings };
}

/** the theme a start() uses: the file in the profile unless the caller passes one */
export function loadTheme(file?: ThemeFile): { theme: Theme; warnings: string[] } {
	if (file) return buildTheme(file);
	const read = readThemeFile(configDir());
	const built = buildTheme(read.file);
	if (read.warning) built.warnings.unshift(read.warning);
	return built;
}

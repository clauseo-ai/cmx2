import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readDimensions, sniffImage } from "@cmx2/tools";

/**
 * images in the context are bytes, not tokens. a screenshot costs the model a few thousand tokens and the
 * request a megabyte, so a session that looks at many of them hits the provider's request size limit
 * (vertex 30 MB, bedrock 20 MB, anthropic 32 MiB) long before compaction's token threshold: one agent died
 * at 30,585,366 bytes, 96% of it 68 screenshots, at a third of its token threshold.
 *
 * the context keeps the newest images whole and drops the oldest ones the model has already seen, in
 * batches: past the budget, down to `keep` of it. a drop changes the prompt from the first dropped image on,
 * so the cache restarts there and the provider drops the thinking blocks after it (anthropic's
 * `drop_block`); one drop that frees half the budget costs that once, where a drop per image would cost it on
 * every step. a turn's first request drops a little earlier, so a drop rarely lands mid-turn, and a
 * compaction (which rewrites the prompt anyway) takes the chance to drop what is over `keep` for free.
 *
 * a drop is a line in the transcript naming each image by position, applied the same way live and on
 * resume, so the rebuilt context is the same bytes. the transcript keeps every image (rule 15); the model
 * reads a short marker where one was and can read the file again.
 */

export interface ImageSettings {
	/** base64 bytes of images the context may carry before the oldest seen ones are dropped; false turns these drops off (a request over the provider's limit still drops) */
	budget: number | false;
	/** what a drop leaves, as a fraction of the budget */
	keep: number;
}

export const IMAGE_DEFAULTS: ImageSettings = { budget: 12_000_000, keep: 0.4 };

/** a request's byte limit when nothing names one and the endpoint is not the provider's own (vertex takes 30 MB, bedrock and gemini 20 MB) */
export const GATEWAY_REQUEST_BYTES = 20_000_000;
/** images one request may carry when the catalog does not say (anthropic: 100 on 200k-token models, 600 on the rest) */
export const DEFAULT_MAX_IMAGES = 100;
/** the most base64 one image may be on vertex and bedrock; a heavier one fails every request that carries it */
export const MAX_IMAGE_BASE64 = 5_242_880;
/** past 20 images in one request every image must be at most this many pixels on its longest edge */
export const MANY_IMAGE_EDGE = 2000;
/** the share of the request limit a request is held to, for json overhead and the estimate's slack */
export const REQUEST_HEADROOM = 0.9;
/** a turn's first request drops at this share of the budget, so the drop lands between turns rather than inside one */
export const TURN_START_SHARE = 0.75;
/** images past this share of the provider's per-request count drop like bytes past the budget; a drop leaves the lower share */
export const COUNT_HIGH = 0.8;
export const COUNT_KEEP = 0.4;

export type DropReason = "budget" | "turn" | "compaction" | "limit" | "rejected" | "unreadable";

/** the transcript line for a drop; the model never reads it, the context is rebuilt with it applied */
export interface DropRecord {
	role: "drop";
	/** [transcript position, content index] of every image taken out of the context */
	images: Array<[number, number]>;
	reason: DropReason;
	/** base64 image bytes in the context before and after */
	bytes: [number, number];
	/** images in the context before and after */
	count: [number, number];
	timestamp: number;
}

/**
 * what the model reads where a tool's image was. these words are part of the prompt of every session with a
 * drop: changing them moves that prompt once, a cache write on each such session's next request
 */
export const DROPPED_IMAGE = "[image dropped from context to keep requests small; read or capture it again to see it]";
/** what the model reads where an image the user attached was */
export const droppedUserImage = (name?: string) => `[image the user attached${name ? ` (${name})` : ""}, dropped from context to keep requests small]`;
/** what the model reads where an image the provider refused to read was */
export const UNREADABLE_IMAGE = "[image dropped from context: the provider could not read it]";
/** what a request carries in place of image bytes that are not a png, jpeg, gif or webp at all */
export const NOT_AN_IMAGE = "[image left out: its bytes are not a png, jpeg, gif or webp image]";

/** one image in the context */
export interface ContextImage {
	/** index into the context's messages */
	at: number;
	/** transcript position of its message; undefined for a message not written yet, which is never dropped */
	seq: number | undefined;
	/** index into the message's content */
	block: number;
	/** base64 length */
	bytes: number;
	/** attached by the user rather than returned by a tool */
	user: boolean;
	/** a reply after it exists, so the model has looked at it */
	seen: boolean;
}

/** every image the context carries, oldest first */
export function inventory(messages: readonly AgentMessage[], seqOf: (m: AgentMessage) => number | undefined): ContextImage[] {
	let answered = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string };
		if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
			answered = i;
			break;
		}
	}
	const out: ContextImage[] = [];
	messages.forEach((m, at) => {
		const r = m as { role?: string; content?: unknown };
		if ((r.role !== "user" && r.role !== "toolResult") || !Array.isArray(r.content)) return;
		r.content.forEach((b: { type?: string; data?: unknown } | undefined, block) => {
			if (b?.type !== "image" || typeof b.data !== "string") return;
			out.push({ at, seq: seqOf(m), block, bytes: b.data.length, user: r.role === "user", seen: at < answered });
		});
	});
	return out;
}

/** a request's size in bytes from its messages, near enough to hold it under a limit: every string's length plus a little per key and value */
export function requestBytes(messages: readonly unknown[]): number {
	let n = 0;
	const walk = (v: unknown) => {
		if (typeof v === "string") n += v.length + 2;
		else if (Array.isArray(v)) {
			n += 2;
			for (const x of v) walk(x);
		} else if (v && typeof v === "object") {
			n += 2;
			for (const k in v) {
				n += k.length + 4;
				walk((v as Record<string, unknown>)[k]);
			}
		} else n += 6;
	};
	for (const m of messages) walk(m);
	return n;
}

export interface DropLimits {
	/** base64 bytes past which a routine drop runs; Infinity when routine drops are off */
	budget: number;
	/** what a routine drop leaves */
	keepBytes: number;
	/** the provider's images per request, and the routine trigger and what a drop leaves */
	maxImages: number;
	highImages: number;
	keepImages: number;
	/** what the images may weigh for the request to fit the provider's limit (the limit with headroom, less everything else) */
	room: number;
}

export interface DropPlan {
	drop: ContextImage[];
	reason: DropReason;
	bytes: [number, number];
	count: [number, number];
}

/**
 * which images leave the context, if any. `mode` says when this runs: `budget` before any request, `turn`
 * before a turn's first (it triggers earlier), `compaction` right after one (it triggers at `keep`, the
 * prompt changed anyway), `rejected` after the provider refused a request for its size (everything but
 * the newest image may go). a request that would not fit the provider's limit always drops (`limit`), and
 * may then take the user's own images; otherwise images the model has not seen yet and images the user
 * attached stay. the newest images are kept up to the target; once one does not fit, every older candidate
 * goes, so what stays is the recent end of the conversation.
 */
export function planDrop(images: readonly ContextImage[], mode: Exclude<DropReason, "limit" | "unreadable">, l: DropLimits): DropPlan | undefined {
	const total = images.reduce((n, i) => n + i.bytes, 0);
	const count = images.length;
	const heavy = images.filter((i) => i.bytes > MAX_IMAGE_BASE64 && i.seq !== undefined);
	const hard = total > l.room || count > l.maxImages;
	// with the budget off only the provider's limits drop
	const routine = Number.isFinite(l.budget);
	const triggered =
		hard ||
		heavy.length > 0 ||
		mode === "rejected" ||
		(routine &&
			(mode === "compaction"
				? total > l.keepBytes || count > l.keepImages
				: mode === "turn"
					? total > l.budget * TURN_START_SHARE || count > l.highImages * TURN_START_SHARE
					: total > l.budget || count > l.highImages));
	if (!triggered) return undefined;
	const targetBytes = Math.min(l.keepBytes, l.room);
	const targetCount = l.keepImages;
	const newest = images[images.length - 1];
	const droppable = (i: ContextImage, users: boolean) => i.seq !== undefined && (mode === "rejected" ? i !== newest : i.seen && (!i.user || users));
	const pick = (users: boolean): Set<ContextImage> => {
		const out = new Set<ContextImage>(heavy);
		let bytes = 0;
		let n = 0;
		// what cannot go stays and counts against the target
		for (const i of images) {
			if (out.has(i) || droppable(i, users)) continue;
			bytes += i.bytes;
			n++;
		}
		let full = false;
		for (let k = images.length - 1; k >= 0; k--) {
			const i = images[k]!;
			if (out.has(i) || !droppable(i, users)) continue;
			if (!full && bytes + i.bytes <= targetBytes && n < targetCount) {
				bytes += i.bytes;
				n++;
			} else {
				full = true;
				out.add(i);
			}
		}
		return out;
	};
	const left = (s: Set<ContextImage>) => images.reduce((n, i) => n + (s.has(i) ? 0 : i.bytes), 0);
	let drop = pick(mode === "rejected");
	if (hard && (left(drop) > l.room || count - drop.size > l.maxImages)) drop = pick(true);
	if (!drop.size) return undefined;
	const list = images.filter((i) => drop.has(i));
	const after = left(drop);
	// a routine drop is worth its cache rewrite only when it frees a real batch: images it may not take (unseen
	// ones, the user's) can hold the context over the budget, and dropping one screenshot a step behind them
	// would rewrite the cache on every step. a compaction's drop is free, a limit's is not optional
	if (!hard && !heavy.length && (mode === "budget" || mode === "turn") && total - after < (l.budget - l.keepBytes) / 2 && list.length < (l.highImages - l.keepImages) / 2) return undefined;
	return { drop: list, reason: mode === "rejected" ? "rejected" : hard ? "limit" : mode, bytes: [total, after], count: [count, count - list.length] };
}

/** blocks that ride a request as documents (a pdf a user attached); providers count them with images */
export function documentsIn(messages: readonly AgentMessage[]): number {
	let n = 0;
	for (const m of messages) {
		const c = (m as { role?: string; content?: unknown }).content;
		if ((m as { role?: string }).role !== "user" || !Array.isArray(c)) continue;
		for (const b of c) if (b && typeof b === "object" && (b as { document?: unknown }).document) n++;
	}
	return n;
}

/**
 * which images leave after the provider said it could not read one: every image since its last reply, since
 * each earlier one rode a request it answered; when there is none (a model that reads less than the one before
 * it), every image
 */
export function planUnreadable(images: readonly ContextImage[]): (DropPlan & { scope: "unseen" | "all" }) | undefined {
	const named = images.filter((i) => i.seq !== undefined);
	const unseen = named.filter((i) => !i.seen);
	const list = unseen.length ? unseen : named;
	if (!list.length) return undefined;
	const total = images.reduce((n, i) => n + i.bytes, 0);
	const gone = list.reduce((n, i) => n + i.bytes, 0);
	return { drop: list, reason: "unreadable", scope: unseen.length ? "unseen" : "all", bytes: [total, total - gone], count: [images.length, images.length - list.length] };
}

/** the longest edge of base64 image data, from its header; undefined when the header does not say */
export function imageEdge(data: string): number | undefined {
	const bytes = new Uint8Array(Buffer.from(data.slice(0, 65_536), "base64"));
	const mime = sniffImage(bytes);
	const d = mime ? readDimensions(bytes, mime) : undefined;
	return d ? Math.max(d.width, d.height) : undefined;
}

/**
 * the images over the many-image edge (2000 px: past 20 images in a request every image must be under it),
 * which a refusal for it names; dropping them fixes the request without lowering how many images it may carry
 */
export function planOversized(images: readonly ContextImage[], edgeOf: (i: ContextImage) => number | undefined): DropPlan | undefined {
	const list = images.filter((i) => i.seq !== undefined && (edgeOf(i) ?? 0) > MANY_IMAGE_EDGE);
	if (!list.length) return undefined;
	const total = images.reduce((n, i) => n + i.bytes, 0);
	const gone = list.reduce((n, i) => n + i.bytes, 0);
	return { drop: list, reason: "rejected", bytes: [total, total - gone], count: [images.length, images.length - list.length] };
}

/** a message with the named content blocks, where they are images, replaced by the marker their drop's reason calls for; the same message when none is */
export function dropBlocks(m: AgentMessage, blocks: ReadonlyMap<number, DropReason>): AgentMessage {
	const r = m as { role?: string; content?: unknown };
	if (!Array.isArray(r.content)) return m;
	let changed = false;
	const content = r.content.map((b: { type?: string; filename?: unknown } | undefined, i: number) => {
		const reason = blocks.get(i);
		if (!reason || b?.type !== "image") return b;
		changed = true;
		const text = reason === "unreadable" ? UNREADABLE_IMAGE : r.role === "user" ? droppedUserImage(typeof b.filename === "string" ? b.filename : undefined) : DROPPED_IMAGE;
		return { type: "text", text };
	});
	return changed ? ({ ...(m as object), content } as unknown as AgentMessage) : m;
}

/** the images every drop line in a transcript took out, by transcript position, each with its drop's reason */
export function dropsOf(all: readonly unknown[]): Map<number, Map<number, DropReason>> {
	const out = new Map<number, Map<number, DropReason>>();
	for (const m of all) {
		const r = m as { role?: string; images?: unknown; reason?: unknown };
		if (r?.role !== "drop" || !Array.isArray(r.images)) continue;
		const reason = (typeof r.reason === "string" ? r.reason : "budget") as DropReason;
		for (const ref of r.images) {
			if (!Array.isArray(ref) || typeof ref[0] !== "number" || typeof ref[1] !== "number") continue;
			let s = out.get(ref[0]);
			if (!s) out.set(ref[0], (s = new Map()));
			if (!s.has(ref[1])) s.set(ref[1], reason);
		}
	}
	return out;
}

/**
 * the image type base64 data really is, from its first bytes. what this answers decides what every request of
 * every session carries (checkedImages): teaching it a new format renders stored messages differently once,
 * at that upgrade, a cache write on each session holding such an image
 */
export function sniffBase64(data: string): string | undefined {
	return sniffImage(new Uint8Array(Buffer.from(data.slice(0, 24), "base64")));
}

/**
 * a message as a request may carry it: an image whose bytes are not a png, jpeg, gif or webp becomes a
 * marker, and one whose bytes disagree with its declared type goes with the type the bytes say. a provider
 * refuses either on every request (`Could not process image`), and the transcript replays them, so one bad
 * image wedges a session; this is request shaping, the stored message is untouched, and the same message
 * always comes out the same. the same message when every image is fine
 */
export function checkedImages(m: AgentMessage): AgentMessage {
	const r = m as { role?: string; content?: unknown };
	if ((r.role !== "user" && r.role !== "toolResult") || !Array.isArray(r.content)) return m;
	let changed = false;
	const content = r.content.map((b: { type?: string; data?: unknown; mimeType?: unknown } | undefined) => {
		if (b?.type !== "image") return b;
		const real = typeof b.data === "string" ? sniffBase64(b.data) : undefined;
		if (!real) {
			changed = true;
			return { type: "text", text: NOT_AN_IMAGE };
		}
		if (real === b.mimeType) return b;
		changed = true;
		return { ...b, mimeType: real };
	});
	return changed ? ({ ...(m as object), content } as unknown as AgentMessage) : m;
}

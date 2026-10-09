/** canonical agent paths: `/root` for the session the user talks to, `/root/<name>[/<child>]` below it */

export const ROOT_PATH = "/root";

const NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function validName(name: string): boolean {
	return NAME.test(name);
}

export function childPath(parent: string, name: string): string {
	return `${parent}/${name}`;
}

/** 0 for /root, 1 for its children */
export function depthOf(path: string): number {
	return path.split("/").length - 2;
}

export function parentPath(path: string): string | undefined {
	const i = path.lastIndexOf("/");
	return i > 0 ? path.slice(0, i) : undefined;
}

/** true when `a` is a strict ancestor of `b` */
export function isAncestor(a: string, b: string): boolean {
	return b.startsWith(`${a}/`);
}

/** a name from the first words of a brief, when the spawner gave none */
export function nameFrom(brief: string): string {
	const words = brief
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOP.has(w))
		.slice(0, 3);
	const n = words.join("_").slice(0, 32).replace(/_+$/, "");
	return validName(n) ? n : "agent";
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "all", "any", "then", "when", "what", "please"]);

import type { MessageRow, PartRow } from "@cmx2/store";

/** the content type Response.json sets, for answers serialised by hand */
export const JSON_TYPE = "application/json;charset=utf-8";

/**
 * messages as the message routes answer them, one json string per message: `{"info":...,"parts":[...]}`.
 * the store keeps info and part data as JSON.stringify wrote them, so they are spliced in as they are;
 * parsing and stringifying them again gives the same bytes at the cost of the cpu. an archived session's
 * rows are rebuilt (archivedPart may have rewritten a part, and imported rows came from another tool).
 * `tail` gives a part's json to serve instead of the stored one (a running shell's latest output, kept in
 * memory as JSON.stringify wrote it).
 */
export function messagesJson(rows: Array<Pick<MessageRow, "info"> & { parts: Array<Pick<PartRow, "id" | "data">> }>, archived: boolean, tail?: (partId: string) => string | undefined): string[] {
	const data = (p: Pick<PartRow, "id" | "data">) => (tail ? (tail(p.id) ?? p.data) : p.data);
	if (archived) return rows.map((m) => JSON.stringify({ info: JSON.parse(m.info), parts: m.parts.map((p) => JSON.parse(data(p))) }));
	return rows.map((m) => {
		let parts = "";
		for (let i = 0; i < m.parts.length; i++) parts += i ? `,${data(m.parts[i]!)}` : data(m.parts[i]!);
		return `{"info":${m.info},"parts":[${parts}]}`;
	});
}

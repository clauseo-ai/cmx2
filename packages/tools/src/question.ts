import { Type } from "typebox";
import { text, type Tool, defineTool } from "./types.ts";

export interface QuestionPrompt {
	question: string;
	header: string;
	options: Array<{ label: string; description: string }>;
	multiple?: boolean;
}

/** an answer written by the agent the question went to (a helper's spawner), not picked from the options */
export interface AgentAnswer {
	/** the answering agent's path in the tree */
	by: string;
	text: string;
}

/**
 * asks and resolves with one array of chosen labels (or typed answers) per question when the user answers,
 * or with an agent's written answer when the question went to a helper's spawner; rejects when dismissed
 */
export type AskQuestions = (questions: QuestionPrompt[], toolCallId: string, signal?: AbortSignal) => Promise<string[][] | AgentAnswer>;

/** the result's details: the picked labels per question, or an agent's written answer and who wrote it (answers stay empty then) */
export interface QuestionDetails {
	answers: string[][];
	answer?: string;
	by?: string;
}

/** who the question tool reaches: the user, or (for a helper) the agent that started it */
export type QuestionAudience = "user" | "spawner";

const DESCRIPTIONS: Record<QuestionAudience, string> = {
	user: "ask the user one or more questions and wait for the answers. each question offers labelled options; the user picks one (or several with multiple: true) or types their own answer, so options never need an other or catch-all entry. a recommended option goes first with (recommended) at the end of its label. answers come back as the chosen labels, one list per question.",
	spawner:
		"ask the agent that started you one or more questions and wait for its answer. it answers from what it knows, or asks further up the tree (the user is at the top) and passes the answer on. each question offers labelled options; a recommended option goes first with (recommended) at the end of its label. the answer comes back as text.",
};

export class QuestionDismissedError extends Error {
	constructor() {
		super("the user dismissed this question");
	}
}

/**
 * question: the turn waits while the user answers from any client (terminal, phone). wire-compatible
 * with cmx's question requests, so boxbox's decision cards render it unchanged. a helper's question goes
 * to its spawner instead, which answers in text or asks further up.
 */
export function questionTool(ask: AskQuestions, audience: QuestionAudience = "user"): Tool {
	return defineTool({
		name: "question",
		label: "question",
		description: DESCRIPTIONS[audience],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "the full question" }),
					header: Type.String({ description: "a short label for the question, up to 30 characters" }),
					options: Type.Array(
						Type.Object({
							label: Type.String({ description: "1 to 5 words" }),
							description: Type.String({ description: "what choosing this means" }),
						}),
					),
					multiple: Type.Optional(Type.Boolean({ description: "allow more than one choice" })),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(id, params, signal): Promise<{ content: ReturnType<typeof text>[]; details: QuestionDetails }> {
			const got = await ask(params.questions, id, signal);
			if (!Array.isArray(got)) {
				return {
					content: [text(`${got.by} answered: ${got.text}`)],
					details: { answers: params.questions.map(() => []), answer: got.text, by: got.by },
				};
			}
			const answers: string[][] = got;
			const lines = params.questions.map((q, i) => `"${q.question}" = "${(answers[i] ?? []).join(", ") || "unanswered"}"`);
			return {
				content: [text(`the user answered: ${lines.join("; ")}`)],
				details: { answers },
			};
		},
	});
}

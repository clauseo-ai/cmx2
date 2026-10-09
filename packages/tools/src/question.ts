import { Type } from "typebox";
import { text, type Tool, defineTool } from "./types.ts";

export interface QuestionPrompt {
	question: string;
	header: string;
	options: Array<{ label: string; description: string }>;
	multiple?: boolean;
}

/** asks the user and resolves with one array of chosen labels (or typed answers) per question; rejects when dismissed */
export type AskQuestions = (questions: QuestionPrompt[], toolCallId: string, signal?: AbortSignal) => Promise<string[][]>;

export class QuestionDismissedError extends Error {
	constructor() {
		super("the user dismissed this question");
	}
}

/**
 * question: the turn waits while the user answers from any client (terminal, phone). wire-compatible
 * with cmx's question requests, so boxbox's decision cards render it unchanged.
 */
export function questionTool(ask: AskQuestions): Tool {
	return defineTool({
		name: "question",
		label: "question",
		description:
			"ask the user one or more questions and wait for the answers. each question offers labelled options; the user picks one (or several with multiple: true) or types their own answer, so options never need an other or catch-all entry. a recommended option goes first with (recommended) at the end of its label. answers come back as the chosen labels, one list per question.",
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
		async execute(id, params, signal) {
			const answers = await ask(params.questions, id, signal);
			const lines = params.questions.map((q, i) => `"${q.question}" = "${(answers[i] ?? []).join(", ") || "unanswered"}"`);
			return {
				content: [text(`the user answered: ${lines.join("; ")}`)],
				details: { answers },
			};
		},
	});
}

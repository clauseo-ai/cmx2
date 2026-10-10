import { expect, test } from "bun:test";
import { questionTool } from "../src/question.ts";

const QUESTIONS = [{ question: "which browser should i drive?", header: "browser", options: [{ label: "the visible one", description: "attach to it" }, { label: "a fresh one", description: "start another" }] }];

test("the question tool says who it reaches and who answered", async () => {
	expect(questionTool(async () => [["a"]]).description).toStartWith("ask the user");
	const spawner = questionTool(async () => ({ by: "/root", text: "use the visible one" }), "spawner");
	expect(spawner.description).toStartWith("ask the agent that started you");
	const r = await spawner.execute("call_1", { questions: QUESTIONS } as never, undefined as never);
	expect((r.content[0] as { text: string }).text).toBe("/root answered: use the visible one");
	expect(r.details).toEqual({ answers: [[]], answer: "use the visible one", by: "/root" });
	const user = await questionTool(async () => [["a fresh one"]]).execute("call_2", { questions: QUESTIONS } as never, undefined as never);
	expect((user.content[0] as { text: string }).text).toBe('the user answered: "which browser should i drive?" = "a fresh one"');
	expect(user.details).toEqual({ answers: [["a fresh one"]] });
});

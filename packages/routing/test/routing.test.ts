import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROUTING, Routing, RoutingError, type RoutingErrorCode } from "../src/index.ts";

let dir: string;
let routing: Routing;

function write(name: string, body: unknown, bump = 0) {
	const path = join(dir, name);
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	// mtime granularity can hide a rewrite inside the same millisecond; move it on
	const t = new Date(Date.now() + 1000 * (bump + 1));
	utimesSync(path, t, t);
	return path;
}

function errorOf(fn: () => unknown): RoutingError {
	try {
		fn();
	} catch (e) {
		if (e instanceof RoutingError) return e;
		throw e;
	}
	throw new Error("expected a RoutingError");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cmx2-routing-"));
	routing = new Routing({ configDir: () => dir, machine: "testhost" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SHIPPED_TEXT = [
	"models for helpers. spawn names one; your own model is the user's choice and is not in this table.",
	"- haiku: claude-haiku-5-5, high by default. where bounded work starts; about a seventeenth of a sonnet step under 100k tokens of context and about a third past it, so split at 100k when the work splits.",
	"- sonnet: claude-sonnet-5-5, high by default. about 17× a haiku step under 100k tokens of context and about opus medium per task on long contexts, since it writes more per step and takes more steps; a little behind opus on the design and writing boards, so the pick when per-step price matters: short tasks, or one long read that cannot be split.",
	"- opus: claude-opus-5-5, high by default. exploration that shapes a plan, implementation that needs judgment, ui, docs and copy, debugging, code review; about 36× a haiku step under 100k tokens of context, and per task about what sonnet high costs; medium for applying a given defect list or re-checking a delta, since on open work it stops short of the checks.",
	"- fable: claude-fable-5-1, medium by default. second opinion on plans and designs; about 4× opus per task.",
	"off limits: claude-haiku-5-5 never runs at xhigh or max.",
	"where to start, and where to step up when the output falls short (defaults, not limits):",
	"- any bounded task whose brief pins down the behaviour and the checks; the rows below are the exceptions: haiku high; then opus medium.",
	"- lookups: finding files and usages, reading logs and docs, summarising output: haiku medium (low only for one-shot text such as a commit message); then opus medium.",
	"- exploration whose answer shapes a plan: opus medium; then opus high.",
	"- mechanical work: renames, codemods, formatting, commit messages, changelogs, pr text, applying a given list of fixes, merge conflicts where the brief says which side wins (stop and report when claims contradict): haiku (low for text, high for code); then opus medium.",
	"- coding whose behaviour a test or a reference implementation pins down, porting included, split so each helper stays under about 100k tokens of context (haiku stays coherent to about 250k): haiku high; then opus medium.",
	"- coding that needs a decision the brief cannot make: opus medium; then opus high.",
	"- scripted terminal work: fixed steps, known commands, simulator, screenshot and browser checks (one command is a background job, not a helper): haiku high; then opus medium.",
	"- terminal work that may need diagnosis: environments, builds, setup, test loops, ci: opus medium, high for debug-heavy work; then opus xhigh; sonnet max only after opus xhigh fails.",
	"- hard implementation and debugging: unclear cause, races, performance, migrations: opus medium; then opus high, then opus xhigh; fable medium as a second opinion.",
	"- ui, frontend and design systems: opus medium; then opus high.",
	"- docs and user-facing copy: opus medium; then opus high.",
	"- review: correctness, performance against a stated target, fidelity to a reference, and risky changes (security, concurrency, persistence, migrations, public api, anything that sends a user's action to a server): opus medium, high for security, concurrency and persistence; then opus xhigh or fable medium.",
	"- a second opinion on a plan or design: opus high or fable medium, whichever is not running your session.",
	"- reading more than 100k tokens: split it across haiku helpers by file or topic; one sonnet high when it cannot be split.",
	"how to use it:",
	"- haiku is where a task starts unless a row above says otherwise. a spawn above haiku says in why, in one line, why haiku cannot do it; the helper never sees why, and those lines are how the guide gets revised.",
	"- small work that needs your context stays with you; small work that does not goes to haiku, since one step of yours costs tens of haiku steps. a helper starts with none of your context.",
	"- a brief makes the decisions the task contains (rename or reuse, which pattern to follow) and states the targets the result is measured against (frame time, latency, size). a decision the brief cannot make is a reason to start above haiku; difficulty and file count are not, and a missing tool or permission gets fixed, not escalated.",
	"- judge the output when it is back, not the price before. when a helper's output falls short: retry once with a sharper brief, then spawn one step up with after, then do it yourself. no helper is retried more than twice.",
	"- tests and typecheck run before any review. a review goes to risky changes, and to haiku's code when no test or reference pins it down; otherwise the tests and your read of the diff are the check. the defect list goes back to the same writer before anyone steps up.",
	"- a helper past about 250k tokens of context costs about twice as much per step; give the next task to a fresh helper.",
	"- a brief names the files the task touches and attaches the digests it needs with files, not a reading list; a task that needs more than about 150k of context is split or gets its own compaction point.",
	"- your own context is the most expensive in the tree: delegate reading and ask for digests.",
	"- a brief asks for a report under about 300 words, with the detail in a file the report names, and every claim in it naming the check behind it; a claim without a check is not done.",
	"- disjoint work runs in parallel, one writer per area, each writer in its own worktree.",
	"- long watches (builds, test suites) are background jobs with notify, not helpers; a dev server or preview left for the person is a serve job.",
	"- when only helpers or jobs remain, end your turn; their reports wake you.",
].join("\n");

describe("routing", () => {
	test("defaults load and validate", () => {
		const c = routing.current();
		expect(Object.keys(c.models)).toEqual(["haiku", "sonnet", "opus", "fable"]);
		expect(c.caps).toEqual({ running_turns: 50, depth: 3, budget_tokens: null });
		expect(routing.lastError()).toBeUndefined();
		expect(routing.warnings()).toEqual([]);
		expect(routing.version).toBe(1);
	});

	test("the shipped example loads clean and equals the default", () => {
		write("routing.jsonc", readFileSync(new URL("../../../examples/routing.jsonc", import.meta.url), "utf8"));
		expect(routing.lastError()).toBeUndefined();
		expect(routing.current()).toEqual(DEFAULT_ROUTING);
		expect(routing.warnings()).toEqual([]);
	});

	test("every alias resolves with its default effort", () => {
		for (const [alias, m] of Object.entries(DEFAULT_ROUTING.models)) {
			expect(routing.resolve(alias)).toEqual({ alias, model: m.ref, effort: m.effort });
		}
		expect(routing.resolve("opus", { effort: "xhigh" })).toEqual({ alias: "opus", model: "anthropic/claude-opus-5-5", effort: "xhigh" });
	});

	test("aliasOf finds the alias by exact ref, then bare id, and none for a stranger", () => {
		expect(routing.aliasOf("anthropic/claude-sonnet-5-5")).toBe("sonnet");
		expect(routing.aliasOf("vertex/claude-sonnet-5-5")).toBe("sonnet");
		expect(routing.aliasOf("claude-haiku-5-5")).toBe("haiku");
		expect(routing.aliasOf("openai/gpt-6-astra")).toBeUndefined();
		write("routing.jsonc", { models: { cheap: { ref: "vertex/claude-sonnet-5-5", effort: "low", note: "the same model on the proxy" } } });
		// the first alias whose ref matches exactly wins over a bare-id match on an earlier alias
		expect(routing.aliasOf("vertex/claude-sonnet-5-5")).toBe("cheap");
		expect(routing.aliasOf("anthropic/claude-sonnet-5-5")).toBe("sonnet");
	});

	test("editing routing.jsonc changes resolve on the same instance without a flush", () => {
		expect(routing.resolve("opus").effort).toBe("high");
		write("routing.jsonc", { models: { opus: { effort: "medium" } } });
		expect(routing.resolve("opus")).toMatchObject({ model: "anthropic/claude-opus-5-5", effort: "medium" });
		write("routing.jsonc", { models: { opus: { ref: "vertex/claude-opus-5-5" } } }, 1);
		expect(routing.resolve("opus")).toMatchObject({ model: "vertex/claude-opus-5-5", effort: "high" });
		expect(routing.version).toBe(3);
	});

	test("the machine overlay wins over the profile", () => {
		write("routing.jsonc", { models: { opus: { effort: "high" } }, caps: { running_turns: 6 } });
		write("routing.testhost.jsonc", { models: { opus: { effort: "low" } } });
		const c = routing.current();
		expect(c.models.opus!.effort).toBe("low");
		expect(c.caps.running_turns).toBe(6);
		expect(c.caps.depth).toBe(3);
	});

	test("a project layer applies on top", () => {
		const project = join(dir, "proj");
		mkdirSync(join(project, ".cmx2"), { recursive: true });
		writeFileSync(join(project, ".cmx2", "routing.jsonc"), JSON.stringify({ models: { haiku: { ref: "anthropic/claude-fable-5-1", effort: "medium" } } }));
		const r = new Routing({ configDir: () => dir, machine: "testhost", projectDir: project });
		expect(r.resolve("haiku").model).toBe("anthropic/claude-fable-5-1");
		expect(r.resolve("sonnet").model).toBe("anthropic/claude-sonnet-5-5");
	});

	test("a model id stands for the one alias that runs it, with or without a provider", () => {
		expect(routing.resolve("claude-haiku-5-5")).toMatchObject({ alias: "haiku", model: "anthropic/claude-haiku-5-5", effort: "high" });
		expect(routing.resolve("vertex/claude-opus-5-5").alias).toBe("opus");
		expect(routing.aliasForId("claude-nothing-1")).toBeUndefined();
		expect(errorOf(() => routing.resolve("claude-nothing-1")).code).toBe("unknown_model");
		// two aliases on one model: the id names neither
		const project = join(dir, "proj");
		mkdirSync(join(project, ".cmx2"), { recursive: true });
		writeFileSync(join(project, ".cmx2", "routing.jsonc"), JSON.stringify({ models: { haiku: { ref: "anthropic/claude-fable-5-1", effort: "medium" } } }));
		const r = new Routing({ configDir: () => dir, machine: "testhost", projectDir: project });
		expect(r.aliasForId("claude-fable-5-1")).toBeUndefined();
		expect(errorOf(() => r.resolve("claude-fable-5-1")).code).toBe("unknown_model");
	});

	test("invalid jsonc names the file and the last good config stays in force", () => {
		write("routing.jsonc", { models: { opus: { effort: "high" } } });
		expect(routing.current().models.opus!.effort).toBe("high");
		const bad = write("routing.jsonc", "{ models: ", 1);
		expect(routing.current().models.opus!.effort).toBe("high");
		const err = routing.lastError();
		expect(err?.code).toBe("invalid_file");
		expect(err?.message).toContain(bad);
		expect(err?.file).toBe(bad);
		write("routing.jsonc", { models: { opus: { effort: "low" } } }, 2);
		expect(routing.current().models.opus!.effort).toBe("low");
		expect(routing.lastError()).toBeUndefined();
	});

	test("null takes a shipped alias out of the table; the last alias cannot go", () => {
		write("routing.jsonc", { models: { fable: null, haiku: null } });
		expect(routing.lastError()).toBeUndefined();
		expect(Object.keys(routing.current().models)).toEqual(["sonnet", "opus"]);
		expect(errorOf(() => routing.resolve("fable")).message).toBe("no model named fable in routing.jsonc; the models are sonnet, opus");
		expect(routing.render({ canSpawn: true })).not.toContain("- fable:");
		// a later layer may put it back
		write("routing.testhost.jsonc", { models: { fable: { ref: "vertex/claude-fable-5-1", effort: "low", note: "back, on the proxy" } } });
		expect(routing.lastError()).toBeUndefined();
		expect(routing.resolve("fable")).toEqual({ alias: "fable", model: "vertex/claude-fable-5-1", effort: "low" });
		rmSync(join(dir, "routing.testhost.jsonc"));
		expect(Object.keys(routing.current().models)).toEqual(["sonnet", "opus"]);
		write("routing.jsonc", { models: { haiku: null, sonnet: null, opus: null, fable: null } }, 1);
		expect(routing.lastError()?.code).toBe("invalid_model");
		expect(routing.lastError()?.message).toContain("models must be an object with at least one model");
		expect(Object.keys(routing.current().models)).toEqual(["sonnet", "opus"]);
	});

	test("an unknown alias is a typed error naming the aliases", () => {
		const e = errorOf(() => routing.resolve("janitor"));
		expect(e.code).toBe("unknown_model");
		expect(e.message).toBe("no model named janitor in routing.jsonc; the models are haiku, sonnet, opus, fable");
		expect(errorOf(() => routing.resolve("constructor")).code).toBe("unknown_model");
	});

	test("refs, efforts, caps, guide and rules are validated, each error says where", () => {
		const check = (body: unknown, code: RoutingErrorCode, text: string, n: number) => {
			write("routing.jsonc", body, n);
			const e = routing.lastError();
			expect(e?.code).toBe(code);
			expect(e?.message).toContain(text);
		};
		check({ models: { Haiku: { ref: "anthropic/x", effort: "low", note: "n" } } }, "invalid_model", 'models.Haiku: an alias is a lowercase word like "haiku"', 0);
		check({ models: { sonnet: { ref: "sonnet" } } }, "invalid_model", 'models.sonnet.ref must look like "provider/model-id", got "sonnet"', 1);
		check({ models: { sonnet: { effort: "extreme" } } }, "invalid_effort", "models.sonnet.effort must be one of low, medium, high, xhigh, max, got \"extreme\"", 2);
		check({ models: { sonnet: { note: "  " } } }, "invalid_model", "models.sonnet.note must say in one line what the model is for", 3);
		check({ models: { x1: { ref: "a/b", effort: "low" } } }, "invalid_model", "models.x1.note", 4);
		check({ caps: { running_turns: 1 } }, "invalid_caps", "caps.running_turns", 5);
		check({ guide: "start cheap" }, "invalid_guide", "guide must be a list", 6);
		check({ guide: [{ task: "x" }] }, "invalid_guide", "guide[0].start must be a non-empty string", 7);
		check({ guide: [{ task: "x", start: "y", up: "" }] }, "invalid_guide", "guide[0].up must be a non-empty string", 8);
		check({ rules: ["fine", ""] }, "invalid_guide", "rules[1] must be a non-empty string", 9);
		check({ rules: "end your turn" }, "invalid_guide", "rules must be a list of strings", 10);
		check({ models: "haiku" }, "invalid_model", "models must be an object with at least one model", 11);
		write("routing.jsonc", { guide: [{ task: "x", start: "y" }], rules: [] }, 12);
		expect(routing.lastError()).toBeUndefined();
	});

	test("notes, guide and rules keep the house voice: no dashes, no shouting", () => {
		const check = (body: unknown, where: string, n: number) => {
			write("routing.jsonc", body, n);
			const e = routing.lastError();
			expect(e?.code).toBe("invalid_guide");
			expect(e?.message).toContain(`${where} breaks the voice rules (no dashes, no shouting)`);
		};
		check({ models: { opus: { note: "hard work \u2014 and review" } } }, "models.opus.note", 0);
		check({ guide: [{ task: "a \u2013 b", start: "x" }] }, "guide[0].task", 1);
		check({ guide: [{ task: "a", start: "b", up: "you MUST step up" }] }, "guide[0].up", 2);
		check({ rules: ["do it", "IMPORTANT: always"] }, "rules[1]", 3);
		check({ rules: ["DO NOT retry"] }, "rules[0]", 4);
	});

	describe("the never list is config, only the shipped haiku entry is built in", () => {
		test("the shipped list keeps haiku off xhigh and max, on any provider", () => {
			expect(routing.current().never).toEqual({ "claude-haiku-5-5": ["xhigh", "max"] });
			const e = errorOf(() => routing.resolve("haiku", { effort: "xhigh" }));
			expect(e.code).toBe("effort_not_allowed");
			expect(e.message).toBe("claude-haiku-5-5 never runs at xhigh; it runs at low, medium, high");
			expect(routing.resolve("haiku", { effort: "medium" }).effort).toBe("medium");
			expect(routing.allowed("vertex/claude-haiku-5-5", "max")).toBe(false);
			expect(routing.allowedEfforts("anthropic/claude-haiku-5-5")).toEqual(["low", "medium", "high"]);
			expect(routing.resolve("opus", { effort: "xhigh" }).effort).toBe("xhigh");
			expect(routing.resolve("sonnet", { effort: "max" }).effort).toBe("max");
		});

		test("a never entry refuses the effort, by ref or bare id, on any provider", () => {
			write("routing.jsonc", { never: { "anthropic/claude-opus-5-5": ["xhigh"], "claude-sonnet-5-5": ["max"] } });
			expect(routing.lastError()).toBeUndefined();
			const a = errorOf(() => routing.resolve("opus", { effort: "xhigh" }));
			expect(a.code).toBe("effort_not_allowed");
			expect(a.message).toContain("claude-opus-5-5");
			expect(a.message).toContain("low, medium, high, max");
			const b = errorOf(() => routing.resolve("sonnet", { effort: "max" }));
			expect(b.code).toBe("effort_not_allowed");
			expect(b.message).toContain("claude-sonnet-5-5");
			expect(routing.allowed("vertex/claude-opus-5-5", "xhigh")).toBe(false);
			expect(routing.allowed("claude-opus-5-5", "xhigh")).toBe(false);
			expect(routing.allowed("vertex/claude-sonnet-5-5", "max")).toBe(false);
			expect(routing.resolve("opus", { effort: "max" }).effort).toBe("max");
			expect(routing.resolve("sonnet", { effort: "xhigh" }).effort).toBe("xhigh");
		});

		test("an emptied list lifts the entry", () => {
			write("routing.jsonc", { never: { "claude-haiku-5-5": [] } });
			expect(routing.allowed("anthropic/claude-haiku-5-5", "max")).toBe(true);
			expect(routing.resolve("haiku", { effort: "xhigh" }).effort).toBe("xhigh");
		});

		test("an alias default the never list forbids is a load error", () => {
			write("routing.jsonc", { never: { "claude-sonnet-5-5": ["max"] }, models: { sonnet: { effort: "max" } } });
			const e = routing.lastError();
			expect(e?.code).toBe("forbidden_default");
			expect(e?.message).toContain("models.sonnet defaults to max, which claude-sonnet-5-5 never runs at; pick another effort");
			expect(routing.current().models.sonnet!.effort).toBe("high");
			write("routing.jsonc", { models: { haiku: { effort: "xhigh" } } }, 1);
			expect(routing.lastError()?.code).toBe("forbidden_default");
			write("routing.jsonc", { models: { sonnet: { effort: "max" } } }, 2);
			expect(routing.lastError()).toBeUndefined();
			expect(routing.current().models.sonnet!.effort).toBe("max");
		});
	});

	describe("escalation", () => {
		const opus = "anthropic/claude-opus-5-5";
		const sonnet = "anthropic/claude-sonnet-5-5";
		const fable = "anthropic/claude-fable-5-1";
		const haiku = "anthropic/claude-haiku-5-5";

		test("goes up only and stops at each model's shipped ceiling, no automatic max for anyone", () => {
			expect(routing.escalate(opus, "medium")).toBe("high");
			expect(routing.escalate(opus, "high")).toBe("xhigh");
			expect(routing.escalate(opus, "xhigh")).toBeUndefined();
			expect(routing.escalate(sonnet, "low")).toBe("medium");
			expect(routing.escalate(sonnet, "medium")).toBe("high");
			expect(routing.escalate(sonnet, "high")).toBeUndefined();
			expect(routing.escalate(fable, "high")).toBe("xhigh");
			expect(routing.escalate(fable, "xhigh")).toBeUndefined();
			expect(routing.escalate(haiku, "low")).toBe("medium");
			expect(routing.escalate(haiku, "medium")).toBe("high");
			expect(routing.escalate(haiku, "high")).toBeUndefined();
			expect(routing.escalate("openai/gpt-6-astra", "high")).toBe("xhigh");
			expect(routing.escalate("openai/gpt-6-astra", "xhigh")).toBeUndefined();
		});

		test("ceiling keys match by exact ref, then bare id, then the id on any provider", () => {
			expect(routing.escalate("vertex/claude-opus-5-5", "high")).toBe("xhigh");
			expect(routing.escalate("vertex/claude-opus-5-5", "xhigh")).toBeUndefined();
			write("routing.jsonc", { escalation: { ceiling: { "vertex/claude-opus-5-5": "max", "claude-sonnet-5-5": "medium", "anthropic/claude-sonnet-5-5": "max" } } });
			expect(routing.lastError()).toBeUndefined();
			expect(routing.escalate("vertex/claude-opus-5-5", "xhigh")).toBe("max");
			expect(routing.escalate(opus, "xhigh")).toBeUndefined();
			expect(routing.escalate(sonnet, "xhigh")).toBe("max");
			expect(routing.escalate("vertex/claude-sonnet-5-5", "low")).toBe("medium");
			expect(routing.escalate("vertex/claude-sonnet-5-5", "medium")).toBeUndefined();
			write("routing.jsonc", { escalation: { ceiling: { "anthropic/claude-fable-5-1": "high", "openai/gpt-6-astra": "high" } } }, 1);
			// the shipped bare-id entry beats another provider's ref
			expect(routing.escalate("vertex/claude-fable-5-1", "high")).toBe("xhigh");
			expect(routing.escalate("azure/gpt-6-astra", "medium")).toBe("high");
			expect(routing.escalate("azure/gpt-6-astra", "high")).toBeUndefined();
		});

		test("one effort still sets the ceiling for every model, and warns that it replaced the per-model ones", () => {
			write("routing.jsonc", { escalation: { ceiling: "high" } });
			expect(routing.lastError()).toBeUndefined();
			expect(routing.escalate(opus, "high")).toBeUndefined();
			expect(routing.escalate(opus, "low")).toBe("medium");
			expect(routing.warnings()).toEqual(['escalation.ceiling "high" applies to every model and replaces the per-model ceilings']);
			write("routing.jsonc", { escalation: { ceiling: "max" } }, 1);
			expect(routing.escalate(opus, "xhigh")).toBe("max");
			expect(routing.escalate(sonnet, "high")).toBe("xhigh");
			expect(routing.warnings()).toEqual(['escalation.ceiling "max" applies to every model and replaces the per-model ceilings']);
			write("routing.jsonc", { escalation: { ceiling: { "claude-opus-5-5": "high" } } }, 2);
			expect(routing.warnings()).toEqual([]);
		});

		test("skips rungs the never list forbids", () => {
			write("routing.jsonc", { never: { "claude-opus-5-5": ["xhigh"] }, escalation: { ceiling: { "claude-opus-5-5": "max" } } });
			expect(routing.escalate(opus, "high")).toBe("max");
			write("routing.jsonc", { never: { "claude-opus-5-5": ["xhigh"] } }, 1);
			expect(routing.escalate(opus, "high")).toBeUndefined();
		});

		test("a wrong ceiling shape names the fix", () => {
			write("routing.jsonc", { escalation: { ceiling: "extreme" } });
			let e = routing.lastError();
			expect(e?.code).toBe("invalid_effort");
			expect(e?.message).toContain('escalation.ceiling must be one of low, medium, high, xhigh, max for every model, or an object of model to effort with a "default"');
			write("routing.jsonc", { escalation: { ceiling: { "claude-opus-5-5": "huge" } } }, 1);
			e = routing.lastError();
			expect(e?.code).toBe("invalid_effort");
			expect(e?.message).toContain('escalation.ceiling.claude-opus-5-5 must be one of low, medium, high, xhigh, max, got "huge"');
			write("routing.jsonc", { escalation: { ceiling: ["max"] } }, 2);
			expect(routing.lastError()?.code).toBe("invalid_effort");
			// an object over a lower layer's single effort replaces it, so it carries its own default
			write("routing.jsonc", { escalation: { ceiling: "high" } }, 3);
			expect(routing.lastError()).toBeUndefined();
			write("routing.testhost.jsonc", { escalation: { ceiling: { "claude-opus-5-5": "xhigh" } } }, 4);
			e = routing.lastError();
			expect(e?.code).toBe("invalid_effort");
			expect(e?.message).toContain('add "default": "xhigh"');
			expect(e?.file).toContain("routing.testhost.jsonc");
			expect(routing.current().escalation.ceiling).toBe("high");
		});
	});

	describe("version-1 files", () => {
		test("load with their seat keys ignored and one warning per file; shared keys keep working", () => {
			const file = write("routing.jsonc", {
				preset: "fable-led",
				presets: { "fable-led": { driver: "anthropic/claude-fable-5-1" } },
				effort: { engineer: "low" },
				seats: { engineer: "builds" },
				never: { "claude-opus-5-5": ["xhigh"] },
				caps: { running_turns: 6 },
				escalation: { ceiling: { default: "xhigh", "claude-opus-5-5": "high" } },
			});
			expect(routing.lastError()).toBeUndefined();
			const c = routing.current();
			expect(Object.keys(c.models)).toEqual(["haiku", "sonnet", "opus", "fable"]);
			expect(c).not.toHaveProperty("preset");
			expect(c).not.toHaveProperty("seats");
			expect(c.never).toMatchObject({ "claude-opus-5-5": ["xhigh"] });
			expect(c.caps.running_turns).toBe(6);
			expect(routing.escalate("anthropic/claude-opus-5-5", "medium")).toBe("high");
			expect(routing.escalate("anthropic/claude-opus-5-5", "high")).toBeUndefined();
			expect(routing.warnings()).toEqual([`${file} uses version-1 keys (preset, presets, seats, effort); they are ignored. models and guide replace them: see docs/routing.md`]);
		});

		test("a version-2 file with models and a version-1 layer under it both load", () => {
			const a = write("routing.jsonc", { preset: "opus-led" });
			write("routing.testhost.jsonc", { models: { opus: { effort: "high" } } });
			expect(routing.lastError()).toBeUndefined();
			expect(routing.resolve("opus").effort).toBe("high");
			expect(routing.warnings()).toHaveLength(1);
			expect(routing.warnings()[0]).toContain(a);
		});

		test("the warning reaches the onWarnings hook once per config version", () => {
			const seen: string[][] = [];
			const r = new Routing({ configDir: () => dir, machine: "testhost", onWarnings: (w) => seen.push(w) });
			r.current();
			expect(seen).toEqual([]);
			write("routing.jsonc", { effort: { engineer: "low" } });
			r.current();
			r.current();
			expect(seen).toHaveLength(1);
			write("routing.jsonc", { effort: { engineer: "high" } }, 1);
			r.current();
			expect(seen).toHaveLength(2);
		});
	});

	test("render carries the table, the guide and the rules, the never line only when never lists something, no dashes, byte-stable", () => {
		const a = routing.render({ canSpawn: true });
		const b = routing.render({ canSpawn: true });
		expect(a).toBe(b);
		expect(a).toBe(SHIPPED_TEXT);
		expect(a).toContain("off limits: claude-haiku-5-5 never runs at xhigh or max.");
		expect(a).toContain("end your turn");
		expect(a).not.toMatch(/[–—]/);
		expect(a).not.toMatch(/\b(DO NOT|MUST|IMPORTANT)\b/);
		expect(routing.render({ canSpawn: false })).toBe("");
		// a helper's table does not talk about its own model: the first line is shorter and nothing else moves
		const h = routing.render({ canSpawn: true, helper: true });
		expect(h).toBe(routing.render({ canSpawn: true, helper: true }));
		expect(h.split("\n")[0]).toBe("models for helpers. spawn names one.");
		expect(h.split("\n").slice(1)).toEqual(a.split("\n").slice(1));
		expect(a.split("\n")[0]).toContain("your own model is the user's choice");
		expect(routing.render({ canSpawn: false, helper: true })).toBe("");
		write("routing.jsonc", { never: { "claude-haiku-5-5": [] } });
		expect(routing.render({ canSpawn: true })).not.toContain("off limits");
		write("routing.jsonc", { never: { "claude-sonnet-5-5": ["max"], "claude-opus-5-5": ["max", "low"] } }, 1);
		const c = routing.render({ canSpawn: true });
		expect(c).toContain("off limits: claude-haiku-5-5 never runs at xhigh or max; claude-opus-5-5 never runs at low or max; claude-sonnet-5-5 never runs at max.");
		write("routing.jsonc", { guide: [{ task: "t", start: "s." }], rules: ["r"] }, 2);
		expect(routing.render({ canSpawn: true })).toContain("where to start, and where to step up when the output falls short (defaults, not limits):\n- t: s.\nhow to use it:\n- r");
	});
});

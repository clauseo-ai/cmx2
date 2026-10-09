import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { listModels, resolveModel } from "../src/models.ts";

const config = () => loadConfig({ env: { CMX2_CONFIG_DIR: mkdtempSync(join(tmpdir(), "cmx2-models-")), ANTHROPIC_API_KEY: "test" } });

function usage(u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }): Usage {
	const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h } = u;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

test("claude-haiku-5-5 resolves through the catalog with the sonnet 5.5 shape and its own prices", async () => {
	const m = await resolveModel(config(), "anthropic/claude-haiku-5-5");
	expect(m.id).toBe("claude-haiku-5-5");
	expect(m.name).toBe("Claude Haiku 5.5");
	expect(m.provider).toBe("anthropic");
	expect(m.api).toBe("anthropic-messages");
	expect(m.reasoning).toBe(true);
	expect(m.input).toEqual(["text", "image"]);
	expect(m.contextWindow).toBe(1_000_000);
	expect(m.cost).toEqual({
		input: 0.1,
		output: 0.5,
		cacheRead: 0.01,
		cacheWrite: 0.125,
		tiers: [{ inputTokensAbove: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
	});
	const sonnet = await resolveModel(config(), "anthropic/claude-sonnet-5-5");
	expect((m as any).compat).toEqual((sonnet as any).compat);
	expect((m as any).thinkingLevelMap).toEqual((sonnet as any).thinkingLevelMap);
	expect((m as any).promptCache).toEqual({ short: 300, long: 3600 });
	expect((m as any).inputLimits.images.maxPerRequest).toBe(100);
	expect((sonnet as any).inputLimits.images.maxPerRequest).toBe(600);
});

test("the configured endpoint applies to haiku like any catalog model", async () => {
	const c = loadConfig({ env: { CMX2_CONFIG_DIR: mkdtempSync(join(tmpdir(), "cmx2-models-")) } });
	c.providers.anthropic = { baseUrl: "http://127.0.0.1:1" };
	expect((await resolveModel(c, "anthropic/claude-haiku-5-5")).baseUrl).toBe("http://127.0.0.1:1");
});

test("listModels lists haiku with efforts low to max", async () => {
	const all = await listModels(config());
	const haiku = all.find((m) => m.provider === "anthropic" && m.id === "claude-haiku-5-5");
	expect(haiku).toBeDefined();
	expect(haiku!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
	expect(haiku!.images).toBe(true);
	expect(haiku!.cost.input).toBe(0.1);
	// the older haiku is still there, and every model appears once
	expect(all.some((m) => m.id === "claude-haiku-4-5")).toBe(true);
	const ids = all.filter((m) => m.provider === "anthropic").map((m) => m.id);
	expect(new Set(ids).size).toBe(ids.length);
});

test("haiku costs base rates at 50k tokens and the long rates, for input and output, from 100k", async () => {
	const m = await resolveModel(config(), "anthropic/claude-haiku-5-5");
	const small = calculateCost(m, usage({ input: 50_000, output: 10_000 }));
	near(small.input, 0.005);
	near(small.output, 0.005);
	near(small.total, 0.01);
	const big = calculateCost(m, usage({ input: 150_000, output: 10_000 }));
	near(big.input, 0.075);
	near(big.output, 0.025);
	near(big.total, 0.1);
	// the count is input + cache read + cache write, not input alone
	const cached = calculateCost(m, usage({ input: 1_000, cacheRead: 140_000, cacheWrite: 9_000, output: 2_000 }));
	near(cached.input, 0.0005);
	near(cached.cacheRead, 0.007);
	near(cached.cacheWrite, 0.005625);
	near(cached.output, 0.005);
});

test("the tier starts at exactly 100,000 tokens, not 100,001", async () => {
	const m = await resolveModel(config(), "anthropic/claude-haiku-5-5");
	near(calculateCost(m, usage({ input: 99_999 })).input, 0.0099999);
	near(calculateCost(m, usage({ input: 100_000 })).input, 0.05);
});

test("a 1h cache write is priced at twice the input price of the rate that applies", async () => {
	const m = await resolveModel(config(), "anthropic/claude-haiku-5-5");
	const short = calculateCost(m, usage({ cacheWrite: 10_000 }));
	near(short.cacheWrite, 0.00125);
	const hour = calculateCost(m, usage({ cacheWrite: 10_000, cacheWrite1h: 10_000 }));
	near(hour.cacheWrite, 0.002);
	// inside the tier the 1h write is 2 x $0.50 = $1.00 per million
	const tiered = calculateCost(m, usage({ input: 90_000, cacheWrite: 10_000, cacheWrite1h: 10_000 }));
	near(tiered.cacheWrite, 0.01);
});

test("sonnet 5.5 reads its cache at $0.10 per million, and the other prices are pi's", async () => {
	const sonnet = await resolveModel(config(), "anthropic/claude-sonnet-5-5");
	expect(sonnet.cost.cacheRead).toBe(0.1);
	expect(sonnet.cost.input).toBe(2);
	expect(sonnet.cost.output).toBe(10);
	expect(sonnet.cost.cacheWrite).toBe(2.5);
	near(calculateCost(sonnet, usage({ cacheRead: 1_000_000 })).cacheRead, 0.1);
	// opus 5.5 ($0.20) and fable 5.1 ($0.25) were already right
	expect((await resolveModel(config(), "anthropic/claude-opus-5-5")).cost.cacheRead).toBe(0.2);
	expect((await resolveModel(config(), "anthropic/claude-fable-5-1")).cost.cacheRead).toBe(0.25);
});

test("the overlay builds new records: pi's own catalog entry for sonnet is not changed", async () => {
	const { ANTHROPIC_MODELS } = await import("@earendil-works/pi-ai/providers/anthropic.models");
	const piSonnet = (ANTHROPIC_MODELS as unknown as Record<string, { cost: { cacheRead: number } }>)["claude-sonnet-5-5"]!;
	await resolveModel(config(), "anthropic/claude-sonnet-5-5");
	expect(piSonnet.cost.cacheRead).toBe(0.2);
	expect((ANTHROPIC_MODELS as unknown as Record<string, unknown>)["claude-haiku-5-5"]).toBeUndefined();
});

test("a model neither pi nor the overlay knows is still refused", async () => {
	await expect(resolveModel(config(), "anthropic/claude-haiku-9-9")).rejects.toThrow(/not in pi's catalog/);
});

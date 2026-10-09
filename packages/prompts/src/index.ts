import anthropic5 from "./anthropic-5.md" with { type: "text" };
import fallback from "./default.md" with { type: "text" };
import gemini from "./gemini.md" with { type: "text" };
import openai from "./openai.md" with { type: "text" };

/** prompt profiles by model family (`PROMPTS.md` → per-model profiles). the text is read once per session and recorded. */
export type ProfileName = "anthropic-5" | "gemini" | "openai" | "default";

// imported as text so a compiled binary carries them; reading them from disk found nothing in bun's embedded fs
const TEXT: Record<ProfileName, string> = { "anthropic-5": anthropic5, gemini, openai, default: fallback };

export function profileFor(api: string, modelId: string): ProfileName {
	if (api === "anthropic-messages" && /^claude-(opus|sonnet|fable|mythos)-5/.test(modelId)) return "anthropic-5";
	if (api === "google-generative-ai" || /^gemini-/.test(modelId)) return "gemini";
	if (api === "openai-completions" || api === "openai-responses") return "openai";
	return "default";
}

export function profileText(name: ProfileName): string {
	return TEXT[name];
}

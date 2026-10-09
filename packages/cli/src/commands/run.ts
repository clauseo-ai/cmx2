import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { connect, type Daemon } from "../daemon.ts";
import { fail } from "../util.ts";

export const help = `cmx2 run: one prompt, headless. prints the answer and exits

usage:
  cmx2 run [options] "prompt"
  echo "prompt" | cmx2 run [options]

options:
  --model provider/id             the model for a new session (default: model in your profile)
  --effort level                  low, medium, high, xhigh or max for this turn
  --agent name                    run the turn as this agent type (cmx2 agent list shows them)
  --session id                    continue a session instead of starting one here
  --port n                        talk to the daemon on this port; without it cmx2 uses the one on your
                                  profile's port, or starts one inside itself for this run
  --json                          print the assistant message as json instead of its text

the session is a real one: it lists in cmx2 session list and in any client, and stderr names it so
you can continue with cmx2 run --session <id>. tools run in the current directory with your
permission rules; an ask that needs a person is refused, since nobody is there to answer.
exit codes: 0 answered, 1 the model or provider failed (the reason is printed), 2 bad usage.`;

async function call(d: Daemon, method: string, path: string, body?: unknown): Promise<Response> {
	const res = await fetch(`${d.base}${path}`, {
		method,
		headers: { ...d.headers, "content-type": "application/json", "x-cmx2-client": "cmx2 run" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	}).catch((e: unknown) => fail(`the daemon at ${d.base} did not answer: ${e instanceof Error ? e.message : String(e)}`));
	if (res.status === 401) fail("the daemon wants a credential. set CMX2_SERVER_PASSWORD, or run cmx2 pair on this machine once");
	if (!res.ok && res.status !== 202) {
		const err = (await res.json().catch(() => ({}))) as { data?: { message?: string } };
		fail(err.data?.message ?? `the daemon answered ${res.status} to ${method} ${path}`);
	}
	return res;
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	return (await Bun.stdin.text()).trim();
}

export async function main(args: string[]) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			model: { type: "string" },
			effort: { type: "string" },
			agent: { type: "string" },
			session: { type: "string" },
			port: { type: "string" },
			json: { type: "boolean" },
		},
	});
	const prompt = positionals.join(" ").trim() || (await readStdin());
	if (!prompt) fail('what should it do? cmx2 run "explain this repo", or pipe the prompt in');
	if (values.model && !values.model.includes("/")) fail(`--model looks like provider/model-id (anthropic/claude-sonnet-5-5), got ${values.model}`);
	const d = await connect({ port: values.port }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
	try {
		let id = values.session;
		let untitled: string | undefined;
		if (id) {
			await call(d, "GET", `/session/${encodeURIComponent(id)}`);
		} else {
			const directory = realpathSync(process.cwd());
			const created = (await (await call(d, "POST", "/session", { directory, ...(values.model ? { model: values.model } : {}), ...(values.effort ? { effort: values.effort } : {}) })).json()) as { id: string; title: string };
			id = created.id;
			untitled = created.title;
		}
		const slash = values.model?.indexOf("/") ?? -1;
		const res = await call(d, "POST", `/session/${encodeURIComponent(id)}/message`, {
			parts: [{ type: "text", text: prompt }],
			...(values.model && slash > 0 ? { model: { providerID: values.model.slice(0, slash), modelID: values.model.slice(slash + 1) } } : {}),
			...(values.effort ? { effort: values.effort } : {}),
			...(values.agent ? { agent: values.agent } : {}),
		});
		const hint = `; continue it with cmx2 run --session ${id}${values.port ? ` --port ${values.port}` : ""} "..."`;
		if (res.status === 202) {
			const q = (await res.json()) as { messageID?: string };
			console.error(`cmx2: session ${id} is busy with another turn; your prompt waits behind it as ${q.messageID ?? "a queued message"}${hint}`);
			process.exitCode = 3;
			return;
		}
		const msg = (await res.json()) as { info: { error?: { name?: string; data?: { message?: string } }; cost?: number }; parts: Array<{ type: string; text?: string; synthetic?: boolean }> } | null;
		if (values.json) console.log(JSON.stringify(msg, null, 2));
		else {
			const text = (msg?.parts ?? [])
				.filter((p) => p.type === "text" && !p.synthetic && p.text)
				.map((p) => p.text)
				.join("\n\n")
				.trim();
			if (text) console.log(text);
		}
		console.error(`cmx2: session ${id}${hint}`);
		const err = msg?.info.error;
		if (err) {
			console.error(`cmx2: ${err.data?.message ?? err.name ?? "the turn failed"}`);
			process.exitCode = 1;
		} else if (!msg) {
			console.error("cmx2: the turn ended without an answer");
			process.exitCode = 1;
		}
		// a daemon this run started stops with it; give the title request that runs beside the first turn a
		// few seconds to land so the session lists with a name instead of the placeholder
		if (d.stop && untitled !== undefined) {
			for (let i = 0; i < 40; i++) {
				const s = (await fetch(`${d.base}/session/${id}`, { headers: d.headers }).then((r) => r.json()).catch(() => ({}))) as { title?: string };
				if (s.title !== untitled) break;
				await Bun.sleep(200);
			}
		}
	} finally {
		await d.stop?.();
	}
}

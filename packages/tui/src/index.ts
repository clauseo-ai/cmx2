import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Client, Cmx2Error, createClient, type Event, type PermissionRequest, type QuestionRequest } from "@cmx2/client";
import { Editor, Key, matchesKey, type OverlayHandle, ProcessTerminal, type SelectItem, type Terminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { type CommandEntry, Completer } from "./complete.ts";
import { effortsFor, InfoPanel, PermissionDialog, Picker, QuestionDialog } from "./dialogs.ts";
import { agentTree, compact, imageMimeOfPath } from "./format.ts";
import { apply, initialState, mine, oneLine, setMessages, setRoster, type State } from "./state.ts";
import { loadTheme, type Theme, type ThemeFile } from "./theme.ts";
import { StatusBar, TranscriptView } from "./view.ts";

export { apply, initialState, setMessages, setRoster } from "./state.ts";
export { buildTheme, DARK, LIGHT } from "./theme.ts";

export interface StartOptions {
	/** the daemon, e.g. http://127.0.0.1:4097 */
	base: string;
	/** what gets a request past the daemon's auth (a bearer or basic header) */
	headers: Record<string, string>;
	/** the directory sessions start in */
	directory: string;
	/** reopen this session instead of starting a new one on the first message */
	session?: string;
	/** provider/model-id for a new session */
	model?: string;
	/** a theme instead of `<config dir>/tui.json` */
	theme?: ThemeFile;
	/** a terminal other than this process's (tests) */
	terminal?: Terminal;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** the tui's own slash commands; everything else goes to the daemon */
const LOCAL: CommandEntry[] = [
	{ name: "model", description: "pick the model (ctrl+p)" },
	{ name: "effort", description: "move the effort dial (ctrl+o)" },
	{ name: "agent", description: "pick the agent type (ctrl+r)" },
	{ name: "tree", description: "the agent tree (ctrl+t)" },
	{ name: "new", description: "start a fresh session on the next message" },
	{ name: "thinking", description: "show or fold the model's reasoning" },
	{ name: "stop", description: "stop the running turn (esc)" },
	{ name: "quit", description: "leave; the daemon and the session keep going" },
];

function errorText(e: unknown): string {
	if (e instanceof Cmx2Error) return e.message;
	return e instanceof Error ? e.message : String(e);
}

export async function start(opts: StartOptions): Promise<void> {
	const { theme, warnings } = loadTheme(opts.theme);
	const client = createClient({
		baseUrl: opts.base,
		directory: opts.directory,
		fetch: (req) => {
			for (const [k, v] of Object.entries(opts.headers)) req.headers.set(k, v);
			req.headers.set("x-cmx2-client", "tui");
			return fetch(req);
		},
	});
	const app = new App(client, theme, opts);
	for (const w of warnings) app.state.notices.push(w);
	return app.run();
}

class App {
	readonly state: State = initialState();
	private tui: TUI;
	private editor: Editor;
	private transcript: TranscriptView;
	private status: StatusBar;
	private overlay?: { handle: OverlayHandle; kind: string; id?: string };
	private stream = new AbortController();
	private done!: () => void;
	private quitArmed = 0;
	private hintTimer?: ReturnType<typeof setTimeout>;
	/** the picked model goes out with the next prompt */
	private modelPending = false;
	private daemonCommands: CommandEntry[] = [];
	private providers?: { providers: Array<{ id: string; models: Record<string, { id: string; name: string; limit?: { context?: number }; variants?: Record<string, unknown> }> }> };

	constructor(
		private readonly client: Client,
		private readonly theme: Theme,
		private readonly opts: StartOptions,
	) {
		this.tui = new TuiMainScreen(opts.terminal ?? new ProcessTerminal());
		this.transcript = new TranscriptView(this.state, theme, () => this.header());
		this.status = new StatusBar(this.state, theme);
		this.editor = new Editor(this.tui, theme.editor, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.editor.setAutocompleteProvider(
			new Completer(
				() => [...LOCAL, ...this.daemonCommands.filter((c) => !LOCAL.some((l) => l.name === c.name))],
				async (query, signal) => (await client.findFile({ query, limit: "12" }, { signal })).data as string[],
			),
		);
		this.editor.onSubmit = (text) => this.submit(text, "enter");
		if (opts.model) {
			this.state.model = opts.model;
			this.modelPending = true;
		}
		this.tui.addChild(this.transcript);
		this.tui.addChild(this.editor);
		this.tui.addChild(this.status);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => this.globalKey(data));
	}

	private header(): string[] {
		if (this.state.messages.length) return [];
		const t = this.theme;
		return [
			`${t.fg.accent(t.bold("cmx2"))} ${t.dim(this.opts.directory)}`,
			t.dim("enter sends · alt+enter queues while it works · esc stops"),
			t.dim("ctrl+p model · ctrl+o effort · ctrl+r agent · ctrl+t agents · / commands · @ files · ! shell"),
		];
	}

	async run(): Promise<void> {
		const finished = new Promise<void>((r) => (this.done = r));
		this.tui.start();
		this.setTitle();
		void this.loadCatalog();
		if (this.opts.session) await this.open(this.opts.session).catch((e) => this.hint(`could not open ${this.opts.session}: ${errorText(e)}`));
		void this.listen();
		this.tui.requestRender();
		await finished;
	}

	private async loadCatalog() {
		const [cmds, providers, config] = await Promise.allSettled([this.client.commands(), this.client.providers(), this.profileModel()]);
		if (config.status === "fulfilled" && config.value && !this.state.model) {
			this.state.model = config.value;
			this.tui.requestRender();
		}
		if (cmds.status === "fulfilled") this.daemonCommands = (cmds.value.data as Array<{ name: string; description?: string }>).map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) }));
		if (providers.status === "fulfilled") this.providers = providers.value.data as never;
	}

	/** the profile's model, from GET /config when the daemon has it (older daemons do not; the status says default) */
	private async profileModel(): Promise<string | undefined> {
		const res = await fetch(`${this.opts.base}/config`, { headers: { ...this.opts.headers, "x-cmx2-directory": encodeURIComponent(this.opts.directory) } }).catch(() => undefined);
		if (!res?.ok) return undefined;
		const body = (await res.json().catch(() => undefined)) as { model?: unknown } | undefined;
		return typeof body?.model === "string" ? body.model : undefined;
	}

	/** reopens a stored session: its transcript, its agents and its asks */
	private async open(id: string) {
		const s = (await this.client.getSession({ sessionID: id })).data;
		this.state.sessionID = s.id;
		this.state.title = s.title;
		if (s.model) this.state.model = `${s.model.providerID}/${s.model.id}`;
		if (s.effort) this.state.effort = s.effort;
		if (s.status) this.state.status = s.status as State["status"];
		this.state.cost = s.cost;
		setMessages(this.state, (await this.client.messages({ sessionID: id })).data as never);
		await this.refreshRoster();
		for (const p of (await this.client.permissions()).data) apply(this.state, { id: p.id, type: "permission.asked", properties: p } as Event);
		for (const q of (await this.client.questions()).data) apply(this.state, { id: q.id, type: "question.asked", properties: q } as Event);
		this.setTitle();
		this.sync();
	}

	private async refreshRoster() {
		if (!this.state.sessionID) return;
		const r = await this.client.roster({ sessionID: this.state.sessionID }).catch(() => undefined);
		if (r) setRoster(this.state, r.data.agents as never);
	}

	/** the directory's event stream, resumed from the last cursor whenever it drops */
	private async listen() {
		while (!this.stream.signal.aborted) {
			try {
				for await (const f of this.client.events({ signal: this.stream.signal, ...(this.state.cursor ? { lastEventId: this.state.cursor } : {}) })) {
					if (f.cursor) this.state.cursor = f.cursor;
					if (!f.ok) continue;
					this.onEvent(f.event);
				}
			} catch (e) {
				if (this.stream.signal.aborted) return;
				this.hint(`lost the daemon's event stream (${errorText(e)}); reconnecting`);
			}
			if (this.stream.signal.aborted) return;
			await Bun.sleep(1000);
			// a gap in what we saw is closed by reading the state again
			if (this.state.sessionID) await this.open(this.state.sessionID).catch(() => {});
		}
	}

	private onEvent(e: Event) {
		if (e.type === "stream.reset" && this.state.sessionID) {
			this.state.cursor = undefined;
			void this.open(this.state.sessionID).catch(() => {});
			return;
		}
		const changed = apply(this.state, e);
		if (e.type.startsWith("agent.") && mine(this.state, (e.properties as { sessionID?: string }).sessionID)) void this.refreshRoster().then(() => this.tui.requestRender());
		if (e.type === "session.updated" || e.type === "session.status") this.setTitle();
		if (changed) this.sync();
	}

	/** opens the next ask when none is showing, closes one that was answered elsewhere, redraws */
	private sync() {
		const o = this.overlay;
		if (o?.kind === "permission" && !this.state.permissions.some((p) => p.id === o.id)) this.closeOverlay();
		if (o?.kind === "question" && !this.state.questions.some((q) => q.id === o.id)) this.closeOverlay();
		if (!this.overlay || this.overlay.kind === "tree") {
			const p = this.state.permissions[0];
			const q = this.state.questions[0];
			if (p) this.showPermission(p);
			else if (q) this.showQuestion(q);
		}
		this.tui.requestRender();
	}

	private who(sessionID: string): string {
		if (sessionID === this.state.sessionID) return "the model";
		const a = this.state.agents.get(sessionID);
		return a ? `agent ${a.name}` : "an agent";
	}

	private show(kind: string, component: Parameters<TUI["showOverlay"]>[0], id?: string) {
		this.closeOverlay();
		const handle = this.tui.showOverlay(component, { width: "90%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 });
		this.overlay = { handle, kind, ...(id ? { id } : {}) };
		this.tui.requestRender();
	}

	private closeOverlay() {
		if (!this.overlay) return;
		this.overlay.handle.hide();
		this.overlay = undefined;
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private showPermission(ask: PermissionRequest) {
		const d = new PermissionDialog(this.theme, ask, this.who(ask.sessionID));
		d.onReply = (reply) => {
			this.closeOverlay();
			this.state.permissions = this.state.permissions.filter((p) => p.id !== ask.id);
			this.client.replyPermission({ requestID: ask.id }, { reply, by: "tui" }).catch((e) => this.hint(`the answer did not land: ${errorText(e)}`));
			this.sync();
		};
		this.show("permission", d, ask.id);
	}

	private showQuestion(ask: QuestionRequest) {
		const d = new QuestionDialog(this.theme, ask, this.who(ask.sessionID));
		d.onAnswer = (answers) => {
			this.closeOverlay();
			this.state.questions = this.state.questions.filter((q) => q.id !== ask.id);
			this.client.replyQuestion({ requestID: ask.id }, { answers, by: "tui" }).catch((e) => this.hint(`the answer did not land: ${errorText(e)}`));
			this.sync();
		};
		d.onDismiss = () => {
			this.closeOverlay();
			this.state.questions = this.state.questions.filter((q) => q.id !== ask.id);
			this.client.rejectQuestion({ requestID: ask.id }, { by: "tui" }).catch((e) => this.hint(`the dismissal did not land: ${errorText(e)}`));
			this.sync();
		};
		this.show("question", d, ask.id);
	}

	private hint(text: string, ms = 5000) {
		this.status.hint = text;
		clearTimeout(this.hintTimer);
		this.hintTimer = setTimeout(() => {
			this.status.hint = "";
			this.tui.requestRender();
		}, ms);
		this.tui.requestRender();
	}

	private setTitle() {
		const busy = this.state.status.type === "busy" ? "working · " : this.state.permissions.length || this.state.questions.length ? "needs you · " : "";
		this.tui.terminal.setTitle(`${busy}${this.state.title || "cmx2"} · ${basename(this.opts.directory)}`);
	}

	/** keys that work wherever focus is; returns consume for the ones it handled */
	private globalKey(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.overlay && this.overlay.kind !== "permission" && this.overlay.kind !== "question") {
				this.closeOverlay();
				return { consume: true };
			}
			if (!this.overlay && this.editor.getText()) {
				this.editor.setText("");
				return { consume: true };
			}
			if (Date.now() - this.quitArmed < 2000) {
				this.quit();
				return { consume: true };
			}
			this.quitArmed = Date.now();
			this.hint("ctrl+c again to quit; the session keeps running on the daemon", 2000);
			return { consume: true };
		}
		if (this.overlay && this.overlay.kind !== "tree") return undefined;
		if (matchesKey(data, Key.ctrl("p"))) return this.consume(() => this.pickModel());
		if (matchesKey(data, Key.ctrl("o"))) return this.consume(() => this.pickEffort());
		if (matchesKey(data, Key.ctrl("r"))) return this.consume(() => this.pickAgent());
		if (matchesKey(data, Key.ctrl("t"))) return this.consume(() => (this.overlay?.kind === "tree" ? this.closeOverlay() : this.showTree()));
		if (this.overlay) return undefined;
		if (matchesKey(data, Key.escape) && !this.editor.isShowingAutocomplete() && this.state.status.type !== "idle") return this.consume(() => this.stop());
		if (data === "\x1b\r" || matchesKey(data, Key.alt("enter"))) {
			if (this.editor.isShowingAutocomplete()) return undefined;
			const text = this.editor.getExpandedText();
			if (!text.trim()) return { consume: true };
			this.editor.addToHistory(text);
			this.editor.setText("");
			this.submit(text, "queue");
			return { consume: true };
		}
		return undefined;
	}

	private consume(fn: () => void | Promise<void>): { consume: true } {
		void Promise.resolve(fn()).catch((e) => this.hint(errorText(e)));
		return { consume: true };
	}

	private quit() {
		this.stream.abort();
		clearTimeout(this.hintTimer);
		this.tui.stop();
		this.done();
	}

	private async stop() {
		if (!this.state.sessionID) return;
		await this.client.abort({ sessionID: this.state.sessionID });
		this.hint("stopped the turn");
	}

	private async ensureSession(): Promise<string> {
		if (this.state.sessionID) return this.state.sessionID;
		const s = (
			await this.client.createSession({
				directory: this.opts.directory,
				...(this.state.model ? { model: this.state.model } : {}),
				...(this.state.effort ? { effort: this.state.effort as (typeof EFFORTS)[number] } : {}),
			})
		).data;
		this.state.sessionID = s.id;
		this.state.title = s.title;
		if (s.model) this.state.model = `${s.model.providerID}/${s.model.id}`;
		if (s.effort) this.state.effort = s.effort;
		this.modelPending = false;
		this.setTitle();
		return s.id;
	}

	/** `@path` words that name files in the directory ride along as file parts */
	private mentions(text: string) {
		const parts: Array<{ type: string; url: string; filename: string; mime?: string }> = [];
		for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
			const rel = m[1]!.replace(/[.,;:!?)]+$/, "");
			const abs = isAbsolute(rel) ? rel : join(this.opts.directory, rel);
			if (!existsSync(abs)) continue;
			const mime = imageMimeOfPath(abs);
			parts.push({ type: "file", url: pathToFileURL(abs).href, filename: rel, ...(mime ? { mime } : {}) });
		}
		return parts;
	}

	private submit(raw: string, how: "enter" | "queue") {
		const text = raw.trim();
		if (!text) return;
		void this.send(text, how).catch((e) => this.hint(errorText(e), 8000));
	}

	private async send(text: string, how: "enter" | "queue") {
		if (text.startsWith("/")) {
			const [name = "", ...args] = text.slice(1).split(/\s+/);
			if (await this.local(name, args.join(" "))) return;
			const id = await this.ensureSession();
			this.hint(`running /${name}`);
			await this.client.runCommand({ sessionID: id }, { command: name, arguments: args.join(" "), ...(this.state.agent ? { agent: this.state.agent } : {}), ...(this.modelPending && this.state.model ? { model: this.state.model } : {}) });
			this.modelPending = false;
			return;
		}
		if (text.startsWith("!")) {
			const id = await this.ensureSession();
			await this.client.shell({ sessionID: id }, { command: text.slice(1).trim() });
			return;
		}
		const id = await this.ensureSession();
		const parts = [{ type: "text", text }, ...this.mentions(text)];
		if (this.state.status.type !== "idle") {
			if (how === "queue") {
				await this.client.queue({ sessionID: id }, { parts });
				this.hint("queued: it runs when this turn ends");
			} else {
				const clientID = crypto.randomUUID();
				this.state.steers.add(clientID);
				await this.client.steer({ sessionID: id }, { parts, clientID });
				this.hint("steering: it lands at the next tool boundary");
			}
			return;
		}
		const slash = this.state.model?.indexOf("/") ?? -1;
		await this.client.prompt(
			{ sessionID: id },
			{
				parts,
				...(this.modelPending && this.state.model && slash > 0 ? { model: { providerID: this.state.model.slice(0, slash), modelID: this.state.model.slice(slash + 1) } } : {}),
				...(this.state.agent ? { agent: this.state.agent } : {}),
			},
		);
		this.modelPending = false;
	}

	/** the tui's own commands; false when the name is not one of them */
	private async local(name: string, _args: string): Promise<boolean> {
		switch (name) {
			case "model":
				await this.pickModel();
				return true;
			case "effort":
				await this.pickEffort();
				return true;
			case "agent":
				await this.pickAgent();
				return true;
			case "tree":
				this.showTree();
				return true;
			case "thinking":
				this.transcript.showReasoning = !this.transcript.showReasoning;
				this.transcript.invalidate();
				this.hint(this.transcript.showReasoning ? "reasoning shows in full" : "reasoning folded");
				return true;
			case "stop":
				await this.stop();
				return true;
			case "new":
				this.state.sessionID = undefined;
				this.state.title = undefined;
				this.state.messages = [];
				this.state.agents.clear();
				this.state.permissions = [];
				this.state.questions = [];
				this.state.status = { type: "idle" };
				this.state.context = undefined;
				this.state.cost = 0;
				this.state.notices = [];
				this.state.error = undefined;
				this.setTitle();
				this.hint("the next message starts a new session");
				return true;
			case "quit":
			case "exit":
				this.quit();
				return true;
		}
		return false;
	}

	private async pickModel() {
		if (!this.providers) await this.loadCatalog();
		const items: SelectItem[] = [];
		for (const p of this.providers?.providers ?? []) {
			for (const m of Object.values(p.models)) items.push({ value: `${p.id}/${m.id}`, label: m.id, description: `${p.id}${m.limit?.context ? ` · ${compact(m.limit.context)} context` : ""}` });
		}
		if (!items.length) return this.hint("the daemon lists no models; check providers in cmx2.jsonc or run cmx2 doctor");
		const picker = new Picker(this.theme, "model", items, { selected: this.state.model, note: () => [this.theme.dim(`now: ${this.state.model ?? "the profile's default"}`)] });
		picker.onClose = () => this.closeOverlay();
		picker.onPick = (item) => {
			this.closeOverlay();
			this.state.model = item.value;
			this.modelPending = true;
			this.hint(`${item.label} from the next turn`);
		};
		this.show("model", picker);
	}

	private async pickEffort() {
		if (!this.providers) await this.loadCatalog();
		const items = effortsFor(this.providers, this.state.model, EFFORTS).map((e) => ({ value: e, label: e }));
		if (!items.length) return this.hint(`${this.state.model} has no effort levels to pick (the daemon lists none; routing.jsonc never may forbid them all)`);
		const picker = new Picker(this.theme, "effort", items, { selected: this.state.effort, note: () => [this.theme.dim(`now: ${this.state.effort ?? "the profile's default"} · applies from the next turn`)] });
		picker.onClose = () => this.closeOverlay();
		picker.onPick = (item) => {
			this.closeOverlay();
			if (!this.state.sessionID) {
				this.state.effort = item.value;
				this.hint(`effort ${item.value} for the new session`);
				return;
			}
			this.client
				.setEffort({ sessionID: this.state.sessionID }, { effort: item.value as (typeof EFFORTS)[number] })
				.then((r) => {
					this.state.effort = r.data.effort;
					this.hint(r.data.result === "pending" ? `effort ${r.data.effort} after this turn` : `effort ${r.data.effort}`);
				})
				.catch((e) => this.hint(`effort ${item.value} refused: ${errorText(e)}`, 8000));
		};
		this.show("effort", picker);
	}

	private async pickAgent() {
		const list = (await this.client.agents()).data as Array<{ name: string; description?: string; mode?: string; hidden?: boolean }>;
		const items = list.filter((a) => !a.hidden && a.mode !== "subagent").map((a) => ({ value: a.name, label: a.name, ...(a.description ? { description: oneLine(a.description, 120) } : {}) }));
		const picker = new Picker(this.theme, "agent", items, { selected: this.state.agent ?? "build" });
		picker.onClose = () => this.closeOverlay();
		picker.onPick = (item) => {
			this.closeOverlay();
			this.state.agent = item.value === "build" ? undefined : item.value;
			this.hint(`agent ${item.value} from the next message`);
		};
		this.show("agent", picker);
	}

	private showTree() {
		void this.refreshRoster().then(() => this.tui.requestRender());
		const panel = new InfoPanel(this.theme, "agents", () => agentTree(this.state, this.theme, 200), undefined, "live · esc closes");
		panel.onClose = () => this.closeOverlay();
		this.show("tree", panel);
	}
}

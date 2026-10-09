import xterm from "@xterm/headless";

/**
 * runs a command on a real pseudo-terminal (Bun.Terminal) and keeps an xterm screen of what it drew,
 * so a test or a drive can read the screen the way a person sees it and type into it.
 */
export class Pty {
	readonly screen: InstanceType<typeof xterm.Terminal>;
	readonly proc: ReturnType<typeof Bun.spawn>;
	private term: Bun.Terminal;
	private decoder = new TextDecoder();
	raw = "";

	constructor(cmd: string[], opts: { cwd: string; env?: Record<string, string | undefined>; cols?: number; rows?: number }) {
		const cols = opts.cols ?? 100;
		const rows = opts.rows ?? 40;
		this.screen = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
		this.term = new Bun.Terminal({
			cols,
			rows,
			name: "xterm-256color",
			data: (_t, data) => {
				const s = this.decoder.decode(data, { stream: true });
				this.raw += s;
				this.screen.write(s);
			},
		});
		this.proc = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...opts.env }, terminal: this.term });
	}

	/** the visible rows, right-trimmed */
	text(): string {
		const b = this.screen.buffer.active;
		const out: string[] = [];
		for (let y = 0; y < this.screen.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
		while (out.length && !out.at(-1)!.trim()) out.pop();
		return out.join("\n");
	}

	write(data: string) {
		this.term.write(data);
	}

	/** types text a few characters at a time, the way a paste-free person does */
	async type(text: string) {
		for (const ch of text) {
			this.write(ch);
			await Bun.sleep(8);
		}
	}

	async waitFor(test: string | RegExp | ((screen: string) => boolean), timeoutMs = 30_000): Promise<string> {
		const t0 = Date.now();
		for (;;) {
			const s = this.text();
			const ok = typeof test === "string" ? s.includes(test) : test instanceof RegExp ? test.test(s) : test(s);
			if (ok) return s;
			if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${String(test)}; the screen:\n${s}`);
			await Bun.sleep(100);
		}
	}

	/**
	 * resizes the pty and tells the child. Bun.Terminal on macos does not make the pty the child's
	 * controlling terminal, so the kernel sends no SIGWINCH; this sends it the way the kernel would.
	 */
	resize(cols: number, rows: number) {
		this.term.resize(cols, rows);
		this.screen.resize(cols, rows);
		this.proc.kill("SIGWINCH");
	}

	async close() {
		this.proc.kill();
		await this.proc.exited;
		this.term.close();
	}
}

export const KEY = {
	enter: "\r",
	altEnter: "\x1b\r",
	esc: "\x1b",
	up: "\x1b[A",
	down: "\x1b[B",
	tab: "\t",
	ctrl: (c: string) => String.fromCharCode(c.toLowerCase().charCodeAt(0) - 96),
};

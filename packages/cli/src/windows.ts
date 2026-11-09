/**
 * the windows half of `cmx2 serve --install`: a per-user task scheduler task, not a windows service. a service
 * runs in session 0 under its own account and needs a stored password to act as you; a task with an interactive
 * token runs as you, in your session, at logon, and stores nothing.
 *
 * the task's action is `conhost.exe --headless "<cmx2.exe>" serve --supervise ...`. a console program started by
 * a logon task opens a console window (a windows terminal window on windows 11); conhost's --headless, the mode
 * conpty itself uses, gives it a console nobody sees. task scheduler does not restart a task whose process exits,
 * so the process it starts is a supervisor (supervise.ts) that runs the daemon as a child and starts it again.
 */

export interface TaskSpec {
	label: string;
	/** DOMAIN\user, the account the task runs as and whose logon starts it */
	user: string;
	/** the full path of conhost.exe */
	conhost: string;
	binary: string;
	/** service.env, which the supervisor reads: the keys and the CMX2_* paths the daemon needs */
	envFile: string;
	port: number;
	hostname: string;
	workingDirectory: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** one argument quoted the way CommandLineToArgvW reads it back */
export function winQuote(s: string): string {
	if (s && !/[\s"]/.test(s)) return s;
	return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** a command line split the way CommandLineToArgvW splits it (backslashes double only before a quote) */
export function splitWinArgs(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQuote = false;
	let any = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (c === "\\") {
			let n = 0;
			while (line[i] === "\\") {
				n++;
				i++;
			}
			if (line[i] === '"') {
				cur += "\\".repeat(Math.floor(n / 2));
				if (n % 2) cur += '"';
				else {
					inQuote = !inQuote;
					any = true;
				}
			} else {
				cur += "\\".repeat(n);
				i--;
			}
		} else if (c === '"') {
			inQuote = !inQuote;
			any = true;
		} else if (!inQuote && (c === " " || c === "\t")) {
			if (cur || any) out.push(cur);
			cur = "";
			any = false;
		} else cur += c;
	}
	if (cur || any) out.push(cur);
	return out;
}

/** the arguments conhost gets: --headless, then the supervisor's command line */
export function taskArguments(t: Pick<TaskSpec, "binary" | "envFile" | "port" | "hostname">): string {
	return ["--headless", t.binary, "serve", "--supervise", "--env-file", t.envFile, "--port", String(t.port), "--hostname", t.hostname].map(winQuote).join(" ");
}

/**
 * the task definition. LeastPrivilege and an InteractiveToken: it runs as the user who installed it, only while
 * they are logged on, and keeps no password. IgnoreNew keeps a second logon from starting a second supervisor.
 * priority 5 is normal; the default 7 is below normal. RestartOnFailure is a backstop for a launch that failed,
 * since the supervisor itself restarts the daemon
 */
export function renderTaskXml(t: TaskSpec): string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(`cmx2 daemon (${t.hostname}:${t.port}), installed by cmx2 serve --install`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(t.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(t.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(t.conhost)}</Command>
      <Arguments>${xml(taskArguments(t))}</Arguments>
      <WorkingDirectory>${xml(t.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks /XML reads utf-16; a byte order mark tells it which end first */
export function utf16File(text: string): Uint8Array {
	return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
}

/** schtasks output as text: utf-16 when it carries a mark or nul high bytes, else utf-8 */
export function decodeOutput(b: Uint8Array): string {
	if (b[0] === 0xff && b[1] === 0xfe) return Buffer.from(b.subarray(2)).toString("utf16le");
	if (b.length > 1 && b[1] === 0 && b[0] !== 0) return Buffer.from(b).toString("utf16le");
	return Buffer.from(b).toString("utf8").replace(/^\uFEFF/, "");
}

export interface TaskInfo {
	command?: string;
	binary?: string;
	envFile?: string;
	port?: number;
	hostname?: string;
}

/** what a task definition runs, read from its xml (never from schtasks' localized text) */
export function parseTaskXml(text: string): TaskInfo {
	const command = text.match(/<Command>([^<]*)<\/Command>/)?.[1];
	const args = text.match(/<Arguments>([^<]*)<\/Arguments>/)?.[1];
	const info: TaskInfo = {};
	if (command !== undefined) info.command = unxml(command).trim();
	if (args === undefined) return info;
	const argv = splitWinArgs(unxml(args));
	// conhost --headless <binary> ...; a task written by hand may name the binary directly
	const at = argv[0] === "--headless" ? 1 : -1;
	info.binary = at === 1 ? argv[1] : info.command;
	const after = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	info.envFile = after("--env-file");
	const port = Number(after("--port"));
	if (Number.isInteger(port) && port > 0) info.port = port;
	info.hostname = after("--hostname");
	return info;
}

/** windows paths compare without case, with %VARS% expanded and trailing separators dropped */
function samePathEntry(a: string, b: string, env: Record<string, string | undefined>): boolean {
	const norm = (p: string) =>
		p
			.replace(/%([^%]+)%/g, (m, name: string) => {
				const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
				return k ? (env[k] ?? m) : m;
			})
			.replace(/^"(.*)"$/, "$1")
			.replace(/[\\/]+$/, "")
			.replace(/\//g, "\\")
			.toLowerCase();
	return norm(a) === norm(b);
}

/** whether `dir` is one of the entries of a windows PATH value */
export function pathHas(path: string, dir: string, env: Record<string, string | undefined> = process.env): boolean {
	return path.split(";").some((e) => e.trim() && samePathEntry(e.trim(), dir, env));
}

/** the user PATH with `dir` appended, or undefined when it is there already */
export function withPathEntry(current: string, dir: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (pathHas(current, dir, env)) return undefined;
	const kept = current.replace(/;+$/, "");
	return kept ? `${kept};${dir}` : dir;
}

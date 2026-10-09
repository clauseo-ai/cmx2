// opens plain `cmx2` in the quickstart's clean home over a real pty, sends one prompt, prints the screen
import { Pty } from "./pty.ts";
const home = process.argv[2]!;
const env = { HOME: home, PATH: `${home}/.local/bin:/usr/bin:/bin`, PROXY_KEY: "proxy-ignores-this", ANTHROPIC_API_KEY: undefined, CMX2_CONFIG_DIR: undefined, CMX2_DATA_DIR: undefined };
const p = new Pty(["cmx2"], { cwd: `${home}/code/tally`, env, cols: 100, rows: 30 });
const wait = async (re: RegExp, ms = 60_000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (re.test(p.text())) return true;
		await Bun.sleep(200);
	}
	return false;
};
console.log(`first screen up: ${await wait(/idle/)}`);
console.log(p.text());
p.write("which file holds the code? answer with the file name only");
await Bun.sleep(300);
p.write("\r");
await Bun.sleep(1500);
console.log(`answered: ${await wait(/tally\.ts[\s\S]*idle/, 90_000)}`);
console.log("----- screen after the answer -----");
console.log(p.text());
p.write("\x03");
await Bun.sleep(300);
p.write("\x03");
console.log(`exit ${await p.proc.exited}`);
process.exit(0);

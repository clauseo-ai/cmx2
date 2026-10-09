/** a message for the person at the terminal, then exit 2; no stack trace */
export function fail(message: string): never {
	console.error(`cmx2: ${message}`);
	process.exit(2);
}

/** true when the args ask for help */
export function wantsHelp(args: string[]): boolean {
	return args.includes("--help") || args.includes("-h");
}

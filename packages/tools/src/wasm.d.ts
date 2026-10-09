// files imported with `with { type: "file" }` are a path
declare module "*.wasm" {
	const path: string;
	export default path;
}

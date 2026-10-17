import { dlopen, FFIType, ptr } from "bun:ffi";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { arch, cpus, freemem, homedir, loadavg, platform, release, totalmem, uptime } from "node:os";

/**
 * `/global/system`: what machine the daemon runs on and how it is doing, for a client that lists machines.
 * the static half (os name and version, model, cpu, the data volume's mount point) is worked out once, on the
 * first request, and may spawn a few short commands then. the live half (load, memory, disk, uptimes) is read on
 * every request from the kernel without a process: /proc on linux, host_statistics64 on macos, statfs for disk.
 */

export type SystemInfo = {
	os: { platform: string; name: string; version: string; kernel: string; arch: string };
	machine: { model: string | null; identifier: string | null; virtual: boolean };
	cpu: { model: string; cores: number; load: number[] };
	memory: { total: number; available: number };
	disk: { path: string; total: number; available: number } | null;
	uptime: number;
	daemon: { rss: number; uptime: number };
	at: number;
};

type Static = { os: SystemInfo["os"]; machine: SystemInfo["machine"]; cpu: { model: string; cores: number }; mount: string | null };

// ---------- parsers, pure so the fixtures can test them ----------

/** `/etc/os-release`: KEY=value lines, values optionally quoted */
export function parseOsRelease(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (!m) continue;
		let v = m[2] ?? "";
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/\\(["'$`\\])/g, "$1");
		out[m[1] as string] = v;
	}
	return out;
}

/** the distribution's short name and version from os-release: "Debian GNU/Linux" reads "Debian" */
export function linuxRelease(rel: Record<string, string>): { name: string; version: string } {
	const name = (rel.NAME ?? rel.ID ?? "Linux").replace(/\s+GNU\/Linux$/, "").trim() || "Linux";
	const version = rel.VERSION_ID ?? rel.BUILD_ID ?? "";
	return { name, version };
}

/** `/proc/meminfo` in bytes; MemAvailable when the kernel has it (3.14 on), else free plus page cache */
export function parseMeminfo(text: string): { total: number; available: number } {
	const kb: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)/);
		if (m) kb[m[1] as string] = Number(m[2]);
	}
	const total = (kb.MemTotal ?? 0) * 1024;
	const available = (kb.MemAvailable ?? (kb.MemFree ?? 0) + (kb.Buffers ?? 0) + (kb.Cached ?? 0)) * 1024;
	return { total, available };
}

/** page counters from macos, the fields of vm_statistics64 that available memory is made from */
export type VmCounters = { pageSize: number; free: number; wired: number; compressor: number; internal: number; purgeable: number };

/** `vm_stat` output: the same counters host_statistics64 hands the daemon, as text */
export function parseVmStat(text: string): VmCounters {
	const size = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
	const get = (label: string) => Number(text.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
	return {
		pageSize: size,
		free: get("Pages free"),
		wired: get("Pages wired down"),
		compressor: get("Pages occupied by compressor"),
		internal: get("Anonymous pages"),
		purgeable: get("Pages purgeable"),
	};
}

/**
 * available memory on macos the way activity monitor counts it: physical memory less what it calls memory used
 * (app memory, that is anonymous pages less purgeable ones, plus wired plus compressed). file cache and purgeable
 * pages count as available, which os.freemem() leaves out
 */
export function macAvailable(total: number, c: VmCounters): number {
	const used = (Math.max(0, c.internal - c.purgeable) + c.wired + c.compressor) * c.pageSize;
	return Math.max(0, Math.min(total, total - used));
}

/** SystemVersion.plist: ProductName and ProductVersion */
export function parsePlistStrings(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of text.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[m[1] as string] = m[2] as string;
	return out;
}

const FAMILIES: [RegExp, string][] = [
	[/^MacBookPro/, "MacBook Pro"],
	[/^MacBookAir/, "MacBook Air"],
	[/^MacBook\d/, "MacBook"],
	[/^Macmini/, "Mac mini"],
	[/^MacPro/, "Mac Pro"],
	[/^iMacPro/, "iMac Pro"],
	[/^iMac/, "iMac"],
	[/^VirtualMac/, "Apple Virtual Machine"],
];

/**
 * a mac's family name. system_profiler's name wins ("Mac mini"); without it the identifier's prefix answers for
 * intel and early apple silicon models (MacBookPro18,3). newer ones are MacNN,MM and say nothing on their own
 */
export function macFamily(identifier: string | null, profilerName: string | null): string | null {
	const named = profilerName?.trim();
	if (named) return named;
	if (!identifier) return null;
	for (const [re, name] of FAMILIES) if (re.test(identifier)) return name;
	return null;
}

const VIRTUAL = /qemu|kvm|vmware|virtualbox|innotek|xen|bochs|hyper-v|virtual machine|amazon ec2|google compute engine|^google$|digitalocean|droplet|hetzner|vserver|openstack|parallels|bhyve|cloud hypervisor|alibaba cloud ecs|oracle cloud|linode|akamai|scaleway|upcloud|vultr|apple virtualization|standard pc \(/i;

/** linux: a vm or cloud machine, from the dmi strings, the cpu's hypervisor flag or a hypervisor the kernel names */
export function linuxVirtual(vendor: string | null, product: string | null, cpuinfo: string, hypervisorType: string | null): boolean {
	if (hypervisorType?.trim()) return true;
	if (/^flags\s*:.*\bhypervisor\b/m.test(cpuinfo)) return true;
	return [vendor, product].some((s) => !!s && VIRTUAL.test(s.trim()));
}

const ARM_VENDORS: Record<string, string> = { "0x41": "Arm", "0x42": "Broadcom", "0x43": "Cavium", "0x46": "Fujitsu", "0x48": "HiSilicon", "0x4e": "NVIDIA", "0x50": "Applied Micro", "0x51": "Qualcomm", "0x61": "Apple", "0x6d": "Microsoft", "0xc0": "Ampere" };
const ARM_PARTS: Record<string, string> = { "0xd08": "Cortex-A72", "0xd0b": "Cortex-A76", "0xd0c": "Neoverse N1", "0xd40": "Neoverse V1", "0xd49": "Neoverse N2", "0xd4f": "Neoverse V2", "0xd83": "Neoverse V3", "0xd8e": "Neoverse N3" };

/**
 * a cpu name from /proc/cpuinfo when node has none: arm kernels print no "model name", only implementer and part
 * codes. "Arm Neoverse N1", or the vendor alone ("Apple"); null when the file has neither
 */
export function armCpuName(cpuinfo: string): string | null {
	const field = (k: string) => cpuinfo.match(new RegExp(`^${k}\\s*:\\s*(\\S+)`, "mi"))?.[1]?.toLowerCase();
	const impl = field("CPU implementer");
	if (!impl) return null;
	const vendor = ARM_VENDORS[impl] ?? `arm (implementer ${impl})`;
	const part = impl === "0x41" ? ARM_PARTS[field("CPU part") ?? ""] : undefined;
	return part ? `${vendor} ${part}` : vendor;
}

/** a mount point inside the home directory names a person; it reads from ~ instead */
export function safeMount(mount: string, home: string): string {
	if (home && home !== "/" && (mount === home || mount.startsWith(`${home}/`))) return `~${mount.slice(home.length)}`;
	return mount;
}

/** the mount point column of `df -P <path>`: everything from the first "/" after the fifth field */
export function parseDfMount(text: string): string | null {
	const lines = text.trim().split("\n");
	const last = lines[lines.length - 1];
	if (lines.length < 2 || !last) return null;
	const m = last.match(/^\S+(?:\s+\S+){4}\s+(\/.*)$/);
	return m?.[1] ?? null;
}

// ---------- reading the machine ----------

/** what a static read leaves out because a command timed out; such a read is tried again later */
let timedOut = false;

/**
 * one short command's stdout, or null. the timer answers on its own: a child killed at the timeout can leave a
 * helper holding its pipe (system_profiler hands work to an xpc service), and the close event would never come
 */
const run = (cmd: string, args: string[], timeout = 5000) =>
	new Promise<string | null>((resolve) => {
		const child = execFile(cmd, args, { encoding: "utf8", maxBuffer: 1 << 20 }, (err, out) => {
			clearTimeout(timer);
			resolve(err ? null : out);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			resolve(null);
		}, timeout);
	});
const read = (path: string) => readFile(path, "utf8").catch(() => null);

async function readStatic(dataDir: string): Promise<Static> {
	const plat = platform();
	const cores = cpus().length;
	const cpuModel = cpus()[0]?.model?.trim() || "unknown";
	const mountP = run("df", ["-P", dataDir]).then((out) => (out ? parseDfMount(out) : null));
	const base = { platform: plat, kernel: release(), arch: arch() };
	if (plat === "darwin") {
		const [plist, sys, profiler] = await Promise.all([
			read("/System/Library/CoreServices/SystemVersion.plist"),
			run("sysctl", ["-n", "hw.model", "kern.hv_vmm_present", "machdep.cpu.brand_string"]),
			run("system_profiler", ["SPHardwareDataType", "-json", "-detailLevel", "mini"], 8000),
		]);
		const v = parsePlistStrings(plist ?? "");
		const [identifier, vmm, brand] = (sys ?? "").split("\n").map((s) => s.trim());
		let hw: { machine_name?: string; machine_model?: string; chip_type?: string } = {};
		try {
			hw = (JSON.parse(profiler ?? "{}") as { SPHardwareDataType?: (typeof hw)[] }).SPHardwareDataType?.[0] ?? {};
		} catch {}
		const id = identifier || hw.machine_model || null;
		return {
			os: { ...base, name: v.ProductName || "macOS", version: v.ProductVersion ?? "" },
			machine: { model: macFamily(id, hw.machine_name ?? null), identifier: id, virtual: vmm === "1" || /^VirtualMac/.test(id ?? "") },
			cpu: { model: brand || hw.chip_type || cpuModel, cores },
			mount: await mountP,
		};
	}
	if (plat === "linux") {
		const dmi = (f: string) => read(`/sys/class/dmi/id/${f}`).then((s) => s?.trim() || null);
		const [osr, product, vendor, cpuinfo, hyp] = await Promise.all([
			read("/etc/os-release").then((s) => s ?? read("/usr/lib/os-release")),
			dmi("product_name"),
			dmi("sys_vendor"),
			read("/proc/cpuinfo"),
			read("/sys/hypervisor/type"),
		]);
		const { name, version } = linuxRelease(parseOsRelease(osr ?? ""));
		const junk = (s: string | null) => (!s || /^(to be filled|default string|system product name|none|not specified)/i.test(s) ? null : s);
		return {
			os: { ...base, name, version },
			machine: { model: junk(product), identifier: null, virtual: linuxVirtual(vendor, product, cpuinfo ?? "", hyp) },
			cpu: { model: cpuModel === "unknown" ? (armCpuName(cpuinfo ?? "") ?? cpuModel) : cpuModel, cores },
			mount: await mountP,
		};
	}
	return {
		os: { ...base, name: plat === "win32" ? "Windows" : plat, version: release() },
		machine: { model: null, identifier: null, virtual: false },
		cpu: { model: cpuModel, cores },
		mount: await mountP,
	};
}

/** macos page counters from host_statistics64, no process; undefined when the call is not there */
const macCounters = (() => {
	let probe: (() => VmCounters | undefined) | null | undefined;
	return (): VmCounters | undefined => {
		if (probe === undefined) {
			probe = null;
			try {
				// opened on first use, so a daemon nobody asks about its machine binds nothing for it
				const lib = dlopen("/usr/lib/libSystem.B.dylib", {
					mach_host_self: { args: [], returns: FFIType.u32 },
					host_statistics64: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
					host_page_size: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
				});
				const host = lib.symbols.mach_host_self();
				const ps = new BigUint64Array(1);
				if (lib.symbols.host_page_size(host, ptr(ps)) !== 0) throw new Error("host_page_size");
				const pageSize = Number(ps[0]);
				// vm_statistics64 is 152 bytes, HOST_VM_INFO64 (4) with a count of 38 integers
				const buf = new BigUint64Array(19);
				const view = new DataView(buf.buffer);
				const count = new Uint32Array(1);
				probe = () => {
					count[0] = 38;
					if (lib.symbols.host_statistics64(host, 4, ptr(buf), ptr(count)) !== 0) return undefined;
					const u = (o: number) => view.getUint32(o, true);
					return { pageSize, free: u(0), wired: u(12), purgeable: u(88), compressor: u(128), internal: u(140) };
				};
			} catch {
				probe = null;
			}
		}
		return probe?.() ?? undefined;
	};
})();

function memory(): SystemInfo["memory"] {
	const total = totalmem();
	if (platform() === "linux") {
		try {
			const m = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
			if (m.total > 0) return m;
		} catch {}
	}
	if (platform() === "darwin") {
		const c = macCounters();
		if (c) return { total, available: macAvailable(total, c) };
	}
	return { total, available: freemem() };
}

/** the route's answer; the first call works out the static half and later calls reuse it */
export function systemInfo(dataDir: string): () => Promise<SystemInfo> {
	let fixed: Promise<Static> | undefined;
	let retryAt = 0;
	return async () => {
		// a read that lost a command to its timeout is used, and made again after five minutes
		if (!fixed || (retryAt && Date.now() >= retryAt)) {
			retryAt = 0;
			fixed = (async () => {
				timedOut = false;
				const s = await readStatic(dataDir);
				if (timedOut) retryAt = Date.now() + 5 * 60_000;
				return s;
			})();
		}
		const s = await fixed;
		let disk: SystemInfo["disk"] = null;
		if (s.mount) {
			const st = await statfs(dataDir).catch(() => null);
			if (st) disk = { path: safeMount(s.mount, homedir()), total: st.blocks * st.bsize, available: st.bavail * st.bsize };
		}
		return {
			os: s.os,
			machine: s.machine,
			cpu: { ...s.cpu, load: loadavg() },
			memory: memory(),
			disk,
			uptime: Math.round(uptime()),
			daemon: { rss: process.memoryUsage.rss(), uptime: Math.round(process.uptime()) },
			at: Date.now(),
		};
	};
}

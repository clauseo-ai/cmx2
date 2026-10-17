import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { armCpuName, linuxRelease, linuxVirtual, macAvailable, macFamily, parseDfMount, parseMeminfo, parseOsRelease, parsePlistStrings, parseVmStat, safeMount, systemInfo } from "../src/system.ts";

/** the parsers behind /global/system, over recorded files from real machines */
const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "system", name), "utf8");

test("os-release: name and version for ubuntu, debian and a rolling distribution", () => {
	expect(linuxRelease(parseOsRelease(fx("os-release-ubuntu")))).toEqual({ name: "Ubuntu", version: "24.04" });
	expect(linuxRelease(parseOsRelease(fx("os-release-debian")))).toEqual({ name: "Debian", version: "12" });
	expect(linuxRelease(parseOsRelease(fx("os-release-arch")))).toEqual({ name: "Arch Linux", version: "rolling" });
	expect(linuxRelease({})).toEqual({ name: "Linux", version: "" });
	expect(parseOsRelease("ID=ubuntu\nNAME='Single'\n# comment\n").NAME).toBe("Single");
});

test("meminfo: MemAvailable in bytes, and free plus cache on a kernel without it", () => {
	expect(parseMeminfo(fx("meminfo"))).toEqual({ total: 16374456 * 1024, available: 10249540 * 1024 });
	expect(parseMeminfo(fx("meminfo-old"))).toEqual({ total: 2048000 * 1024, available: (512000 + 100000 + 400000) * 1024 });
});

test("vm_stat: available is physical memory less app, wired and compressed pages", () => {
	const c = parseVmStat(fx("vm_stat"));
	expect(c).toEqual({ pageSize: 16384, free: 9949, wired: 167947, compressor: 261449, internal: 363149, purgeable: 28365 });
	const total = 16 * 1024 ** 3;
	const used = (363149 - 28365 + 167947 + 261449) * 16384;
	expect(macAvailable(total, c)).toBe(total - used);
	// more in use than installed (counters read mid-change) never goes negative
	expect(macAvailable(1024, c)).toBe(0);
});

test("SystemVersion.plist: product name and version", () => {
	const v = parsePlistStrings(fx("SystemVersion.plist"));
	expect(v.ProductName).toBe("macOS");
	expect(v.ProductVersion).toBe("26.1");
});

test("mac family: system_profiler's name, else the identifier's prefix", () => {
	expect(macFamily("Mac16,11", "Mac mini")).toBe("Mac mini");
	expect(macFamily("MacBookPro18,3", null)).toBe("MacBook Pro");
	expect(macFamily("Macmini9,1", null)).toBe("Mac mini");
	expect(macFamily("MacBookAir10,1", null)).toBe("MacBook Air");
	expect(macFamily("iMac21,1", null)).toBe("iMac");
	expect(macFamily("iMacPro1,1", null)).toBe("iMac Pro");
	expect(macFamily("MacPro7,1", null)).toBe("Mac Pro");
	expect(macFamily("Mac16,11", null)).toBeNull();
	expect(macFamily(null, null)).toBeNull();
});

test("linux virtual: dmi strings, the hypervisor cpu flag or /sys/hypervisor", () => {
	expect(linuxVirtual("Google", "Google Compute Engine", "", null)).toBe(true);
	expect(linuxVirtual("Amazon EC2", "c7g.large", "", null)).toBe(true);
	expect(linuxVirtual("QEMU", "Standard PC (Q35 + ICH9, 2009)", "", null)).toBe(true);
	expect(linuxVirtual("Dell Inc.", "PowerEdge R640", "flags\t\t: fpu vme de pse hypervisor lahf_lm\n", null)).toBe(true);
	expect(linuxVirtual(null, null, "", "xen\n")).toBe(true);
	expect(linuxVirtual("Dell Inc.", "PowerEdge R640", "flags\t\t: fpu vme de pse lahf_lm\n", null)).toBe(false);
	expect(linuxVirtual(null, null, "", null)).toBe(false);
});

test("arm cpuinfo: vendor and part from the implementer codes", () => {
	expect(armCpuName(fx("cpuinfo-neoverse"))).toBe("Arm Neoverse N1");
	expect(armCpuName("processor\t: 0\nCPU implementer\t: 0x61\nCPU part\t: 0x000\n")).toBe("Apple");
	expect(armCpuName("processor\t: 0\nCPU implementer\t: 0x99\n")).toBe("arm (implementer 0x99)");
	expect(armCpuName("processor\t: 0\nmodel name\t: Intel(R) Xeon(R) CPU @ 2.20GHz\n")).toBeNull();
});

test("df -P: the mount point, spaces included; a mount in the home reads from ~", () => {
	expect(parseDfMount("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 482797652 3 4 98% /System/Volumes/Data\n")).toBe("/System/Volumes/Data");
	expect(parseDfMount("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 100 1 99 1% /mnt/my disk\n")).toBe("/mnt/my disk");
	expect(parseDfMount("garbage")).toBeNull();
	expect(safeMount("/home/someone/data", "/home/someone")).toBe("~/data");
	expect(safeMount("/", "/home/someone")).toBe("/");
});

test("systemInfo on this machine: the agreed shape, static half reused", async () => {
	const read = systemInfo(import.meta.dir);
	const a = await read();
	expect(a.os.platform).toBe(process.platform);
	expect(a.cpu.cores).toBeGreaterThan(0);
	expect(a.cpu.load).toHaveLength(3);
	expect(a.memory.total).toBeGreaterThan(0);
	expect(a.memory.available).toBeGreaterThan(0);
	expect(a.memory.available).toBeLessThanOrEqual(a.memory.total);
	expect(a.daemon.rss).toBeGreaterThan(0);
	if (a.disk) expect(a.disk.total).toBeGreaterThanOrEqual(a.disk.available);
	const b = await read();
	expect(b.os).toBe(a.os);
	expect(b.at).toBeGreaterThanOrEqual(a.at);
}, 20_000);

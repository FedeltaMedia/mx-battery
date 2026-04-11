import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import streamDeck from "@elgato/streamdeck";

import { MouseBatteryAction } from "./actions/mouse-battery";
import { KeyboardBatteryAction } from "./actions/keyboard-battery";

// ---------------------------------------------------------------------------
// File-based diagnostic log — written to <plugin-root>/debug.log
// On Windows: %APPDATA%\Elgato\StreamDeck\Plugins\com.fedeltamedia.mxbattery.sdPlugin\debug.log
// ---------------------------------------------------------------------------
const LOG = join(import.meta.dirname, "..", "debug.log");

function log(...args: unknown[]): void {
	const line = `${new Date().toISOString()}  ${args.map(String).join(" ")}\n`;
	console.log(line.trimEnd());
	try { appendFileSync(LOG, line); } catch { /* best-effort */ }
}

// Start fresh each run
try { writeFileSync(LOG, `=== MX Battery debug log ===\n`); } catch { /* ignore */ }

log("plugin starting");
log("node version :", process.version);
log("platform     :", process.platform, process.arch);
log("plugin dir   :", import.meta.dirname);

// ---------------------------------------------------------------------------
// Verify that node-hid loads and enumerate the Logi Bolt receiver
// ---------------------------------------------------------------------------
try {
	// Dynamic import so we can catch load errors (native addon missing / wrong ABI)
	const hid = await import("node-hid");
	log("node-hid load : OK — exports:", Object.keys(hid).join(", "));

	const devs = hid.devices(0x046D, 0xC548);
	if (devs.length === 0) {
		log("devices()     : 0 results — Logi Bolt receiver not detected");
	} else {
		log(`devices()     : ${devs.length} result(s)`);
		for (const d of devs) {
			log(`  path=${d.path}  usagePage=0x${(d.usagePage ?? 0).toString(16)}  interface=${d.interface}`);
		}
	}

	// Try opening the management interface — open ALL matching paths (Col01+Col02 on Windows)
	const allMgmt = devs.filter(d => d.usagePage === 0xFF00 && d.path);
	if (allMgmt.length === 0) {
		const fallback = devs.filter(d => d.interface === 2 && d.path);
		fallback.forEach(d => allMgmt.push(d));
	}

	if (allMgmt.length > 0) {
		const opened: Awaited<ReturnType<typeof hid.HIDAsync.open>>[] = [];
		for (const d of allMgmt) {
			try {
				log(`open test     : trying ${d.path}`);
				opened.push(await hid.HIDAsync.open(d.path!, { nonExclusive: true }));
				log(`open test     : opened OK`);
			} catch (e) {
				log(`open test ERR : ${e}`);
			}
		}

		if (opened.length > 0) {
			const writeDev = opened[0];

			// Query device index 0x01 and 0x02 — log raw bytes to identify which is mouse/keyboard
			for (const deviceIdx of [0x01, 0x02]) {
				const label = `device_idx=0x${deviceIdx.toString(16).padStart(2,"0")}`;
				try {
					await writeDev.write([0x10, deviceIdx, 0x08, 0x11, 0x00, 0x00, 0x00]);
					log(`write test    : sent query for ${label}`);

					const deadline = Date.now() + 2000;
					let got = false;
					while (Date.now() < deadline) {
						const results = await Promise.all(opened.map(dev => dev.read(300)));
						for (const data of results) {
							if (!data || data.length === 0) continue;
							const hex = Array.from(data).slice(0, 8).map(b => `0x${b.toString(16).padStart(2,"0")}`).join(" ");
							log(`read          : [${hex}]`);
							if (data.length > 4 && (data[0] === 0x10 || data[0] === 0x11)) {
								log(`RESULT        : ${label} → reported device_idx=0x${data[1].toString(16).padStart(2,"0")}  feature=0x${data[2].toString(16).padStart(2,"0")}  battery=${data[4]}%`);
								got = true;
								break;
							}
						}
						if (got) break;
					}
					if (!got) log(`read timeout  : no response for ${label} within 2 s`);
				} catch (e) {
					log(`query ERR ${label}:`, String(e));
				}
			}

			for (const dev of opened) await dev.close().catch(() => {});
		}
	} else {
		log("open test     : skipped — no usagePage/interface-2 match");
	}
} catch (e) {
	log("node-hid FAIL :", String(e));
}

log("registering actions...");

// ---------------------------------------------------------------------------
// Normal plugin startup
// ---------------------------------------------------------------------------
streamDeck.actions.registerAction(new MouseBatteryAction());
streamDeck.actions.registerAction(new KeyboardBatteryAction());

streamDeck.connect();
log("streamDeck.connect() called — plugin ready");

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

	// Try opening the management interface and querying the mouse
	const mgmt = devs.find(d => d.usagePage === 0xFF00) ?? devs.find(d => d.interface === 2);
	if (mgmt?.path) {
		log(`open test     : trying ${mgmt.path}`);
		try {
			const dev = await hid.HIDAsync.open(mgmt.path, { nonExclusive: true });
			log("open test     : opened OK");

			await dev.write([0x10, 0x02, 0x08, 0x11, 0x00, 0x00, 0x00]);
			log("write test    : sent mouse battery query");

			const deadline = Date.now() + 2000;
			let got = false;
			while (Date.now() < deadline) {
				const data = await dev.read(300);
				if (!data) break;
				const hex = Array.from(data).slice(0, 8).map(b => `0x${b.toString(16).padStart(2,"0")}`).join(" ");
				log(`read          : [${hex}]`);
				if (data.length > 4 && (data[0] === 0x10 || data[0] === 0x11) && data[1] === 0x02 && data[2] === 0x08) {
					log(`RESULT        : mouse battery = ${data[4]}%  ✓`);
					got = true;
					break;
				}
			}
			if (!got) log("read timeout  : no matching response within 2 s");
			await dev.close();
		} catch (e) {
			log("open/query ERR:", String(e));
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

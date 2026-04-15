import { HIDAsync, devices } from "node-hid";
import streamDeck from "@elgato/streamdeck";

const VENDOR_ID              = 0x046D;
const PRODUCT_ID             = 0xC548;
const USAGE_PAGE             = 0xFF00;
const UNIFIED_BATTERY_FEATURE = 0x1004;   // HID++ feature code: Unified Battery Status
const FALLBACK_FEATURE_IDX   = 0x08;      // Fallback UnifiedBattery table index

/**
 * Mouse-exclusive HID++ feature codes, tried in order until one is found on a slot.
 * The first slot to have ANY of these is the mouse; the other is the keyboard.
 *
 *   0x2100 — SmartShift (original, older firmware)
 *   0x2111 — SmartShift Enhanced (MX Master 3S and newer mice)
 *   0x2150 — ThumbWheel (MX Master side scroll wheel)
 *   0x2200 — HiRes Vertical Scrolling
 *   0x2201 — HiRes Vertical Scrolling v2
 */
const MOUSE_FEATURES = [0x2100, 0x2111, 0x2150, 0x2200, 0x2201] as const;
const QUERY_TIMEOUT_MS       = 2000;
const POLL_INTERVAL_MS       = 5 * 60 * 1000;

/** Per-device resolved configuration. */
interface DeviceConfig {
	idx:        number;   // Logi Bolt slot index (0x01 or 0x02)
	featureIdx: number;   // Feature table index for UnifiedBattery on this device
}

/**
 * Cached discovery result.  Populated on first poll; lives for the plugin session.
 * Reset to null on startup so it re-discovers after a Stream Deck restart.
 */
let cachedDevices: { mouse: DeviceConfig; keyboard: DeviceConfig } | null = null;

const logger = streamDeck.logger.createScope("BatteryService");

export type BatteryDevice = "mouse" | "keyboard";

export type BatteryEvent =
	| { type: "battery"; device: BatteryDevice; percent: number }
	| { type: "error"; device: BatteryDevice };

type Subscriber = (event: BatteryEvent) => void;

/**
 * Return ALL HID paths for the Logi Bolt management interface.
 *
 * On macOS there is one path.
 * On Windows the HID driver exposes two separate collections per interface:
 *   MI_02&Col01 — output (we write commands here)
 *   MI_02&Col02 — input  (responses arrive here)
 * We must open both and read from all of them.
 */
function findDevicePaths(): string[] {
	try {
		const all = devices(VENDOR_ID, PRODUCT_ID);

		// Primary: all paths with usagePage=0xFF00
		const byUsage = all.filter(d => d.usagePage === USAGE_PAGE && d.path).map(d => d.path!);
		if (byUsage.length > 0) return byUsage;

		// Fallback: all paths on interface 2 (usagePage not populated on some Windows configs)
		const byIface = all.filter(d => d.interface === 2 && d.path).map(d => d.path!);
		if (byIface.length > 0) {
			logger.warn("usagePage filter empty — falling back to interface 2 paths");
			return byIface;
		}

		logger.error("Logi Bolt receiver not found");
		return [];
	} catch (e) {
		logger.error(`Device enumeration failed: ${e}`);
		return [];
	}
}

/**
 * Ask the HID++ Root feature (always at table index 0x00) for the feature-table
 * index of a given HID++ feature code.  Returns 0 if not present or on timeout.
 */
async function queryFeatureIndex(
	writeDev: HIDAsync,
	readDevs: HIDAsync[],
	deviceIdx: number,
	featureCode: number,
): Promise<number> {
	const label = `device=0x${deviceIdx.toString(16).padStart(2, "0")} feat=0x${featureCode.toString(16).padStart(4, "0")}`;
	const hi = (featureCode >> 8) & 0xFF;
	const lo = featureCode & 0xFF;
	try {
		await writeDev.write([0x10, deviceIdx, 0x00, 0x01, hi, lo, 0x00]);
		const deadline = Date.now() + QUERY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const remaining = Math.min(deadline - Date.now(), 300);
			if (remaining <= 0) break;
			const results = await Promise.all(readDevs.map(dev => dev.read(remaining)));
			for (const data of results) {
				if (
					data !== undefined &&
					data.length > 4 &&
					(data[0] === 0x10 || data[0] === 0x11) &&
					data[1] === deviceIdx &&
					data[2] === 0x00
				) {
					logger.info(`Root.getFeature(${label}) → tableIdx=0x${data[4].toString(16)}`);
					return data[4];
				}
			}
		}
		logger.warn(`Root.getFeature(${label}) → timeout`);
	} catch (e) {
		logger.error(`Root.getFeature(${label}): ${e}`);
	}
	return 0;
}

/**
 * Discover per-device slot assignments and UnifiedBattery feature indices.
 *
 * Strategy:
 *   1. For each slot, discover the UnifiedBattery feature table index via
 *      Root.getFeature(0x1004).  Different devices can have different layouts.
 *   2. Identify the mouse by probing for SmartShift (0x2100) — exclusive to
 *      MX Master mice.  The other slot is the keyboard.
 */
async function discoverDevices(
	writeDev: HIDAsync,
	readDevs: HIDAsync[],
): Promise<{ mouse: DeviceConfig; keyboard: DeviceConfig }> {
	// Step 1 — discover UnifiedBattery feature index per slot
	const slotFeatureIdx: Record<number, number> = {};
	for (const idx of [0x01, 0x02]) {
		const fi = await queryFeatureIndex(writeDev, readDevs, idx, UNIFIED_BATTERY_FEATURE);
		slotFeatureIdx[idx] = fi > 0 ? fi : FALLBACK_FEATURE_IDX;
	}

	// Step 2 — identify mouse by finding any mouse-exclusive feature
	for (const idx of [0x01, 0x02]) {
		for (const featureCode of MOUSE_FEATURES) {
			const fi = await queryFeatureIndex(writeDev, readDevs, idx, featureCode);
			if (fi > 0) {
				const other = idx === 0x01 ? 0x02 : 0x01;
				const mouse:    DeviceConfig = { idx,   featureIdx: slotFeatureIdx[idx] };
				const keyboard: DeviceConfig = { idx: other, featureIdx: slotFeatureIdx[other] };
				logger.info(
					`Identified mouse at slot 0x${idx.toString(16)} via feature 0x${featureCode.toString(16).padStart(4, "0")} ` +
					`(battFeat=0x${mouse.featureIdx.toString(16)}), ` +
					`keyboard at slot 0x${other.toString(16)} (battFeat=0x${keyboard.featureIdx.toString(16)})`,
				);
				return { mouse, keyboard };
			}
		}
	}

	logger.warn("No mouse-exclusive feature found on any slot — using defaults (mouse=0x02 feat=0x08, keyboard=0x01 feat=0x08)");
	return {
		mouse:    { idx: 0x02, featureIdx: FALLBACK_FEATURE_IDX },
		keyboard: { idx: 0x01, featureIdx: FALLBACK_FEATURE_IDX },
	};
}

/**
 * Query battery percentage for one device.
 *
 * @param writeDev   Device handle for sending commands (Col01 / macOS path).
 * @param readDevs   ALL open handles to read from (Col01+Col02 on Windows).
 * @param deviceIdx  Logi Bolt slot index.
 * @param featureIdx Feature table index for UnifiedBattery on this device.
 */
async function queryBattery(
	writeDev: HIDAsync,
	readDevs: HIDAsync[],
	deviceIdx: number,
	featureIdx: number,
): Promise<number> {
	const label = `slot=0x${deviceIdx.toString(16).padStart(2, "0")} feat=0x${featureIdx.toString(16).padStart(2, "0")}`;
	try {
		await writeDev.write([0x10, deviceIdx, featureIdx, 0x11, 0x00, 0x00, 0x00]);
		logger.info(`Sent battery query for ${label}`);

		const deadline = Date.now() + QUERY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const remaining = Math.min(deadline - Date.now(), 300);
			if (remaining <= 0) break;

			// Read from ALL open paths in parallel — on Windows the matching response
			// arrives on Col02, not Col01, so we must check every path.
			const results = await Promise.all(readDevs.map(dev => dev.read(remaining)));

			for (const data of results) {
				if (
					data !== undefined &&
					data.length > 4 &&
					(data[0] === 0x10 || data[0] === 0x11) &&
					data[1] === deviceIdx &&
					data[2] === featureIdx
				) {
					logger.info(`${label} → ${data[4]}%`);
					return data[4];
				}
			}
		}

		logger.warn(`No response for ${label} within ${QUERY_TIMEOUT_MS} ms`);
		return -1;
	} catch (e) {
		logger.error(`Battery query error for ${label}: ${e}`);
		return -1;
	}
}

async function pollAllBatteries(): Promise<Record<BatteryDevice, number>> {
	const paths = findDevicePaths();
	if (paths.length === 0) return { mouse: -1, keyboard: -1 };

	// Open every matching path (Col01 + Col02 on Windows, single path on macOS)
	const opened: HIDAsync[] = [];
	for (const path of paths) {
		try {
			opened.push(await HIDAsync.open(path, { nonExclusive: true }));
		} catch (e) {
			logger.error(`Cannot open ${path}: ${e}`);
		}
	}

	if (opened.length === 0) return { mouse: -1, keyboard: -1 };

	// Always write to the first path (Col01 / the macOS path)
	const writeDev = opened[0];

	try {
		if (!cachedDevices) {
			cachedDevices = await discoverDevices(writeDev, opened);
		}
		const mouse    = await queryBattery(writeDev, opened, cachedDevices.mouse.idx,    cachedDevices.mouse.featureIdx);
		const keyboard = await queryBattery(writeDev, opened, cachedDevices.keyboard.idx, cachedDevices.keyboard.featureIdx);
		return { mouse, keyboard };
	} finally {
		for (const dev of opened) await dev.close().catch(() => {});
	}
}

class BatteryService {
	private readonly subscribers = new Set<Subscriber>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly lastEvent: Partial<Record<BatteryDevice, BatteryEvent>> = {};

	subscribe(fn: Subscriber): () => void {
		this.subscribers.add(fn);

		for (const event of Object.values(this.lastEvent) as BatteryEvent[]) {
			try { fn(event); } catch {}
		}

		if (this.subscribers.size === 1) {
			void this.poll();
			this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
		}

		return () => {
			this.subscribers.delete(fn);
			if (this.subscribers.size === 0 && this.timer !== null) {
				clearInterval(this.timer);
				this.timer = null;
			}
		};
	}

	refresh(): Promise<void> {
		return this.poll();
	}

	private async poll(): Promise<void> {
		const results = await pollAllBatteries();

		for (const [key, pct] of Object.entries(results) as [BatteryDevice, number][]) {
			const event: BatteryEvent =
				pct < 0
					? { type: "error", device: key }
					: { type: "battery", device: key, percent: pct };

			this.lastEvent[key] = event;
			this.emit(event);
		}
	}

	private emit(event: BatteryEvent): void {
		for (const fn of this.subscribers) {
			try { fn(event); } catch (e) {
				logger.error(`Subscriber threw: ${e}`);
			}
		}
	}
}

export const batteryService = new BatteryService();

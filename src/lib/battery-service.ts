import { HIDAsync, devices } from "node-hid";
import streamDeck from "@elgato/streamdeck";

const VENDOR_ID         = 0x046D;
const PRODUCT_ID        = 0xC548;
const USAGE_PAGE        = 0xFF00;
const FEATURE_IDX       = 0x08;    // firmware index of HID++ feature 0x1004 (Unified Battery)
const QUERY_TIMEOUT_MS  = 2000;
const POLL_INTERVAL_MS  = 5 * 60 * 1000;

/** Default indices (macOS pairing order). Overridden at runtime by discoverDeviceIndices(). */
const DEVICE_IDX = {
	mouse:    0x02,   // MX Master 3S
	keyboard: 0x01,   // MX Keys S
} as const;

/** SmartShift wheel feature — present on MX Master mice, never on keyboards. */
const SMART_SHIFT_FEATURE = 0x2100;

/** Cached result of device-index discovery; refreshed each plugin session. */
let cachedDeviceIdx: { mouse: number; keyboard: number } | null = null;

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
 * Query battery for one device.
 *
 * @param writeDev  The device handle to send the command on (Col01 / only path on macOS).
 * @param readDevs  ALL open device handles to read from. On Windows, Col02 carries the
 *                  response while Col01 returns empty reads — so we race them all.
 */
async function queryBattery(
	writeDev: HIDAsync,
	readDevs: HIDAsync[],
	deviceIdx: number,
): Promise<number> {
	const label = `device_idx=0x${deviceIdx.toString(16).padStart(2, "0")}`;
	try {
		await writeDev.write([0x10, deviceIdx, FEATURE_IDX, 0x11, 0x00, 0x00, 0x00]);
		logger.info(`Sent query for ${label}`);

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
					data[2] === FEATURE_IDX
				) {
					logger.info(`${label} → ${data[4]}%`);
					return data[4];
				}
			}
		}

		logger.warn(`No response for ${label} within ${QUERY_TIMEOUT_MS} ms`);
		return -1;
	} catch (e) {
		logger.error(`Query error for ${label}: ${e}`);
		return -1;
	}
}

/**
 * Ask the HID++ Root feature (index 0x00) for the feature-table index of a
 * given feature code.  Returns 0 if the feature is not present on that device.
 */
async function queryFeatureIndex(
	writeDev: HIDAsync,
	readDevs: HIDAsync[],
	deviceIdx: number,
	featureCode: number,
): Promise<number> {
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
					return data[4];
				}
			}
		}
	} catch (e) {
		logger.error(`queryFeatureIndex(0x${deviceIdx.toString(16)}, 0x${featureCode.toString(16)}): ${e}`);
	}
	return 0;
}

/**
 * Dynamically discover which Logi Bolt device slot is the mouse and which is
 * the keyboard by probing for the SmartShift (0x2100) feature — present only
 * on MX Master mice.  Falls back to hardcoded defaults if detection fails.
 */
async function discoverDeviceIndices(
	writeDev: HIDAsync,
	readDevs: HIDAsync[],
): Promise<{ mouse: number; keyboard: number }> {
	try {
		for (const idx of [0x01, 0x02]) {
			const featIdx = await queryFeatureIndex(writeDev, readDevs, idx, SMART_SHIFT_FEATURE);
			if (featIdx > 0) {
				const other = idx === 0x01 ? 0x02 : 0x01;
				logger.info(`Discovered: mouse=0x${idx.toString(16)}, keyboard=0x${other.toString(16)}`);
				return { mouse: idx, keyboard: other };
			}
		}
	} catch (e) {
		logger.error(`Device discovery error: ${e}`);
	}
	logger.warn("Could not auto-detect device indices — using defaults (mouse=0x02, keyboard=0x01)");
	return { ...DEVICE_IDX };
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
		if (!cachedDeviceIdx) {
			cachedDeviceIdx = await discoverDeviceIndices(writeDev, opened);
		}
		const mouse    = await queryBattery(writeDev, opened, cachedDeviceIdx.mouse);
		const keyboard = await queryBattery(writeDev, opened, cachedDeviceIdx.keyboard);
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

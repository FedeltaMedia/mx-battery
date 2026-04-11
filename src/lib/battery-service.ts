import { HIDAsync, devices } from "node-hid";
import streamDeck from "@elgato/streamdeck";

const VENDOR_ID         = 0x046D;
const PRODUCT_ID        = 0xC548;
const USAGE_PAGE        = 0xFF00;
const FEATURE_IDX       = 0x08;    // firmware index of HID++ feature 0x1004 (Unified Battery)
const QUERY_TIMEOUT_MS  = 2000;
const POLL_INTERVAL_MS  = 5 * 60 * 1000;

const DEVICE_IDX = {
	mouse:    0x02,   // MX Master 3S
	keyboard: 0x01,   // MX Keys S
} as const;

const logger = streamDeck.logger.createScope("BatteryService");

export type BatteryDevice = "mouse" | "keyboard";

export type BatteryEvent =
	| { type: "battery"; device: BatteryDevice; percent: number }
	| { type: "error"; device: BatteryDevice };

type Subscriber = (event: BatteryEvent) => void;

/**
 * Find the HID path for the Logi Bolt HID++ management interface.
 *
 * Primary: match by usage_page=0xFF00 (works on macOS, works on Windows when populated).
 * Fallback: on Windows, usage_page may be 0 for vendor-specific interfaces.
 *           The HID++ management interface is always interface number 2 on Logi Bolt.
 */
function findDevicePath(): string | undefined {
	let all: ReturnType<typeof devices>;
	try {
		all = devices(VENDOR_ID, PRODUCT_ID);
	} catch (e) {
		console.error(`[MXBattery] devices() threw: ${e}`);
		return undefined;
	}

	console.log(`[MXBattery] Enumerated ${all.length} device(s) for VID=0x${VENDOR_ID.toString(16)} PID=0x${PRODUCT_ID.toString(16)}:`);
	for (const d of all) {
		console.log(`  path=${d.path}  usagePage=0x${(d.usagePage ?? 0).toString(16)}  interface=${d.interface}`);
	}

	// Primary: usage page filter
	const byUsage = all.find(d => d.usagePage === USAGE_PAGE && d.path);
	if (byUsage?.path) {
		console.log(`[MXBattery] Using device (usagePage match): ${byUsage.path}`);
		return byUsage.path;
	}

	// Fallback: interface 2 (HID++ management endpoint on all Logi Bolt receivers)
	const byIface = all.find(d => d.interface === 2 && d.path);
	if (byIface?.path) {
		console.warn(`[MXBattery] usagePage filter found nothing — falling back to interface 2: ${byIface.path}`);
		return byIface.path;
	}

	console.error(`[MXBattery] No usable interface found. Is the Logi Bolt receiver plugged in?`);
	return undefined;
}

/**
 * Query battery for one device on an already-open HIDAsync handle.
 *
 * Writes the HID++ request then reads in a loop, discarding unrelated reports
 * until a matching response arrives or the timeout elapses.
 *
 * Response filter accepts report ID 0x10 (short) AND 0x11 (long) because the
 * firmware may use either format depending on platform/firmware version.
 */
async function queryBattery(dev: HIDAsync, deviceIdx: number): Promise<number> {
	const label = `device_idx=0x${deviceIdx.toString(16).padStart(2, "0")}`;
	try {
		const msg = [0x10, deviceIdx, FEATURE_IDX, 0x11, 0x00, 0x00, 0x00];
		console.log(`[MXBattery] write ${label}: ${msg.map(b => `0x${b.toString(16).padStart(2,"0")}`).join(" ")}`);
		await dev.write(msg);

		const deadline = Date.now() + QUERY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const data = await dev.read(Math.min(remaining, 300));

			if (data === undefined) {
				console.warn(`[MXBattery] read timed out for ${label}`);
				break;
			}

			const hex = Array.from(data).slice(0, 8).map(b => `0x${b.toString(16).padStart(2,"0")}`).join(" ");
			console.log(`[MXBattery] read ${label}: [${hex}]`);

			// Accept both 0x10 (short HID++) and 0x11 (long HID++) response formats.
			// The firmware may use either depending on platform.
			if (
				data.length > 4 &&
				(data[0] === 0x10 || data[0] === 0x11) &&
				data[1] === deviceIdx &&
				data[2] === FEATURE_IDX
			) {
				console.log(`[MXBattery] matched response for ${label}: ${data[4]}%`);
				return data[4];
			}
			// Unrelated report — keep reading.
		}

		console.warn(`[MXBattery] no matching response for ${label} within ${QUERY_TIMEOUT_MS} ms`);
		return -1;
	} catch (e) {
		console.error(`[MXBattery] exception for ${label}: ${e}`);
		return -1;
	}
}

async function pollAllBatteries(): Promise<Record<BatteryDevice, number>> {
	const path = findDevicePath();
	if (!path) return { mouse: -1, keyboard: -1 };

	let dev: HIDAsync;
	try {
		dev = await HIDAsync.open(path, { nonExclusive: true });
		console.log(`[MXBattery] opened: ${path}`);
	} catch (e) {
		console.error(`[MXBattery] open failed for ${path}: ${e}`);
		return { mouse: -1, keyboard: -1 };
	}

	try {
		const mouse    = await queryBattery(dev, DEVICE_IDX.mouse);
		const keyboard = await queryBattery(dev, DEVICE_IDX.keyboard);
		console.log(`[MXBattery] poll result — mouse: ${mouse}%, keyboard: ${keyboard}%`);
		return { mouse, keyboard };
	} finally {
		await dev.close().catch(() => {});
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

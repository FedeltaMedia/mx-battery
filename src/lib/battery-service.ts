import { HIDAsync, devices } from "node-hid";
import streamDeck from "@elgato/streamdeck";

const VENDOR_ID         = 0x046D;
const PRODUCT_ID        = 0xC548;
const USAGE_PAGE        = 0xFF00;
const FEATURE_IDX       = 0x08;    // firmware index of HID++ feature 0x1004 (Unified Battery)
const QUERY_TIMEOUT_MS  = 2000;    // per-device query timeout
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

/** Find the HID path of the Logi Bolt receiver's HID++ management interface. */
function findDevicePath(): string | undefined {
	try {
		const all = devices(VENDOR_ID, PRODUCT_ID);
		const match = all.find(d => d.usagePage === USAGE_PAGE);
		if (!match?.path) {
			logger.warn(`No device found for VID=0x${VENDOR_ID.toString(16)} PID=0x${PRODUCT_ID.toString(16)} usagePage=0x${USAGE_PAGE.toString(16)}. Found: ${JSON.stringify(all.map(d => ({ usagePage: d.usagePage, path: d.path })))}`);
		}
		return match?.path;
	} catch (e) {
		logger.error(`Device enumeration failed: ${e}`);
		return undefined;
	}
}

/**
 * Query battery for one device on an already-open HIDAsync handle.
 *
 * Writes the HID++ request then reads in a loop, discarding any unsolicited
 * reports until a matching response arrives or the timeout elapses.
 *
 * This loop is required on Windows where the OS may queue other HID reports
 * (e.g. device-connection notifications) ahead of our query response.
 */
async function queryBattery(dev: HIDAsync, deviceIdx: number): Promise<number> {
	try {
		// HID++ Unified Battery (feature 0x1004, fn=1 getStatus):
		// [reportId=0x10, deviceIdx, featureIdx, fn<<4|0x01, 0, 0, 0]
		await dev.write([0x10, deviceIdx, FEATURE_IDX, 0x11, 0x00, 0x00, 0x00]);

		// Read responses in a loop until we find the matching one or time out.
		// Expected response layout: [0x11, deviceIdx, featureIdx, 0x11, percent, ...]
		const deadline = Date.now() + QUERY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const data = await dev.read(Math.min(remaining, 300));

			if (data === undefined) break; // timed out waiting for any data

			if (
				data.length > 4 &&
				data[0] === 0x11 &&
				data[1] === deviceIdx &&
				data[2] === FEATURE_IDX
			) {
				return data[4];
			}
			// Otherwise it was an unsolicited report — keep reading.
		}

		logger.warn(`No matching response for device_idx=0x${deviceIdx.toString(16).padStart(2, "0")} within ${QUERY_TIMEOUT_MS} ms`);
		return -1;
	} catch (e) {
		logger.error(`Query error for device_idx=0x${deviceIdx.toString(16).padStart(2, "0")}: ${e}`);
		return -1;
	}
}

/**
 * Open the Logi Bolt HID++ interface once, query both devices sequentially, close.
 * Opens non-exclusively so other software (e.g. Logi Options+) can coexist.
 */
async function pollAllBatteries(): Promise<Record<BatteryDevice, number>> {
	const path = findDevicePath();
	if (!path) {
		return { mouse: -1, keyboard: -1 };
	}

	let dev: HIDAsync;
	try {
		dev = await HIDAsync.open(path, { nonExclusive: true });
	} catch (e) {
		logger.error(`Failed to open HID device at ${path}: ${e}`);
		return { mouse: -1, keyboard: -1 };
	}

	try {
		const mouse    = await queryBattery(dev, DEVICE_IDX.mouse);
		const keyboard = await queryBattery(dev, DEVICE_IDX.keyboard);
		logger.info(`Poll result — mouse: ${mouse}%, keyboard: ${keyboard}%`);
		return { mouse, keyboard };
	} finally {
		await dev.close().catch(() => {});
	}
}

class BatteryService {
	private readonly subscribers = new Set<Subscriber>();
	private timer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Cache the last result per device so late subscribers get instant data
	 * without waiting up to 5 minutes for the next scheduled poll.
	 */
	private readonly lastEvent: Partial<Record<BatteryDevice, BatteryEvent>> = {};

	/**
	 * Register a subscriber. Returns an unsubscribe function.
	 *
	 * - Emits cached values to the new subscriber immediately.
	 * - If this is the first subscriber, starts the poll timer and fires immediately.
	 * - Poll timer stops automatically when the last subscriber unsubscribes.
	 */
	subscribe(fn: Subscriber): () => void {
		this.subscribers.add(fn);

		// Send cached data immediately so the key shows a value on first appear
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

	/** Force an immediate refresh (e.g. on key press). */
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

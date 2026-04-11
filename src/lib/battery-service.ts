import { HIDAsync, devices } from "node-hid";
import streamDeck from "@elgato/streamdeck";

const VENDOR_ID         = 0x046D;
const PRODUCT_ID        = 0xC548;
const USAGE_PAGE        = 0xFF00;
const FEATURE_IDX       = 0x08;    // firmware index of HID++ feature 0x1004 (Unified Battery)
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
		return devices(VENDOR_ID, PRODUCT_ID).find(d => d.usagePage === USAGE_PAGE)?.path;
	} catch (e) {
		logger.error(`Device enumeration failed: ${e}`);
		return undefined;
	}
}

/**
 * Query battery for one device on an already-open HIDAsync handle.
 * Flushes stale data, writes the HID++ request, then waits up to 1500 ms
 * for a matching response.
 */
async function queryBattery(dev: HIDAsync, deviceIdx: number): Promise<number> {
	try {
		// Flush any buffered data left over from previous interactions
		for (let i = 0; i < 10; i++) {
			if (await dev.read(5) === undefined) break;
		}

		// HID++ Unified Battery (feature 0x1004, fn=1): [reportId, deviceIdx, featureIdx, fn<<4|0x01, 0,0,0]
		await dev.write([0x10, deviceIdx, FEATURE_IDX, 0x11, 0x00, 0x00, 0x00]);

		// Wait for the matching response (response byte layout: [0x11, deviceIdx, featureIdx, 0x11, percent, ...])
		const response = await dev.read(1500);
		if (
			response !== undefined &&
			response.length > 4 &&
			response[0] === 0x11 &&
			response[1] === deviceIdx &&
			response[2] === FEATURE_IDX
		) {
			return response[4];
		}

		logger.warn(`No matching response for device_idx=0x${deviceIdx.toString(16).padStart(2, "0")}`);
		return -1;
	} catch (e) {
		logger.error(`Query error for device_idx=0x${deviceIdx.toString(16).padStart(2, "0")}: ${e}`);
		return -1;
	}
}

/**
 * Open the Logi Bolt HID++ interface once, query both devices sequentially, close.
 */
async function pollAllBatteries(): Promise<Record<BatteryDevice, number>> {
	const path = findDevicePath();
	if (!path) {
		logger.warn("Logi Bolt receiver not found (VID=0x046D PID=0xC548 usagePage=0xFF00)");
		return { mouse: -1, keyboard: -1 };
	}

	let dev: HIDAsync;
	try {
		dev = await HIDAsync.open(path);
	} catch (e) {
		logger.error(`Failed to open HID device: ${e}`);
		return { mouse: -1, keyboard: -1 };
	}

	try {
		const mouse    = await queryBattery(dev, DEVICE_IDX.mouse);
		const keyboard = await queryBattery(dev, DEVICE_IDX.keyboard);
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
	 * - If this is the first subscriber, starts the poll timer and fires immediately.
	 * - If cached values are available, emits them to the new subscriber right away.
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

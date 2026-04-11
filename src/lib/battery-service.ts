import { execFile } from "child_process";
import path from "path";
import streamDeck from "@elgato/streamdeck";

const __dirname = import.meta.dirname;

/**
 * Absolute path to the Python helper bundled alongside plugin.js in bin/.
 * At runtime __dirname resolves to the bin/ directory inside the .sdPlugin folder.
 */
const PYTHON = "/usr/local/bin/python3";
const SCRIPT = path.join(__dirname, "battery.py");
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const logger = streamDeck.logger.createScope("BatteryService");

export type BatteryDevice = "mouse" | "keyboard";

export type BatteryEvent =
	| { type: "battery"; device: BatteryDevice; percent: number }
	| { type: "error"; device: BatteryDevice };

type Subscriber = (event: BatteryEvent) => void;

function queryBattery(device: BatteryDevice): Promise<number> {
	return new Promise((resolve) => {
		execFile(PYTHON, [SCRIPT, device], { timeout: 6000 }, (err, stdout) => {
			if (err) {
				logger.error(`Battery query failed for ${device}: ${err.message}`);
				resolve(-1);
				return;
			}
			const pct = parseInt(stdout.trim(), 10);
			resolve(isNaN(pct) || pct < 0 ? -1 : Math.min(100, pct));
		});
	});
}

class BatteryService {
	private subscribers = new Set<Subscriber>();
	private timer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Subscribe to battery events. Returns an unsubscribe function.
	 * The poll timer starts when the first subscriber registers and stops
	 * when the last one unsubscribes.
	 */
	subscribe(fn: Subscriber): () => void {
		this.subscribers.add(fn);
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

	/** Force an immediate poll (e.g. on key press). */
	refresh(): Promise<void> {
		return this.poll();
	}

	private async poll(): Promise<void> {
		for (const device of ["mouse", "keyboard"] as BatteryDevice[]) {
			const pct = await queryBattery(device);
			const event: BatteryEvent =
				pct < 0
					? { type: "error", device }
					: { type: "battery", device, percent: pct };
			this.emit(event);
		}
	}

	private emit(event: BatteryEvent): void {
		for (const fn of this.subscribers) {
			try {
				fn(event);
			} catch (e) {
				logger.error(`Subscriber threw: ${e}`);
			}
		}
	}
}

export const batteryService = new BatteryService();

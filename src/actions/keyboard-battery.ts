import { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import type { KeyAction } from "@elgato/streamdeck";

import { batteryService, BatteryEvent } from "../lib/battery-service";
import { makeBatteryImage, makeErrorImage } from "../lib/battery-image";

@action({ UUID: "com.fedeltamedia.mxbattery.keyboard" })
export class KeyboardBatteryAction extends SingletonAction {
	/** All currently visible instances of this action on the deck. */
	private readonly instances = new Map<string, KeyAction>();
	private unsubscribe?: () => void;

	override onWillAppear(ev: WillAppearEvent): void {
		if (!ev.action.isKey()) return;

		const isFirst = this.instances.size === 0;
		this.instances.set(ev.action.id, ev.action);

		// Show loading state immediately
		void ev.action.setImage(makeErrorImage());
		void ev.action.setTitle("");

		if (isFirst) {
			this.unsubscribe = batteryService.subscribe(this.handleEvent.bind(this));
		}
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.instances.delete(ev.action.id);
		if (this.instances.size === 0) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		}
	}

	override onKeyDown(_ev: KeyDownEvent): void {
		void batteryService.refresh();
	}

	private handleEvent(event: BatteryEvent): void {
		if (event.device !== "keyboard") return;

		const image =
			event.type === "battery"
				? makeBatteryImage(event.percent)
				: makeErrorImage();

		for (const act of this.instances.values()) {
			void act.setImage(image);
			void act.setTitle("");
		}
	}
}

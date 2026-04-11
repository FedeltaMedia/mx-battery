import streamDeck from "@elgato/streamdeck";

import { MouseBatteryAction } from "./actions/mouse-battery";
import { KeyboardBatteryAction } from "./actions/keyboard-battery";

streamDeck.actions.registerAction(new MouseBatteryAction());
streamDeck.actions.registerAction(new KeyboardBatteryAction());

streamDeck.connect();

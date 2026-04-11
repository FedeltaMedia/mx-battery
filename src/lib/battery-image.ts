/**
 * Generates a data-URI SVG image of a battery gauge for display on a Stream Deck key.
 *
 * @param percent  Battery level 0-100
 * @returns        data:image/svg+xml;base64,... string
 */
export function makeBatteryImage(percent: number): string {
	const color =
		percent >= 50 ? "#4CAF50" :   // green
		percent >= 20 ? "#FF9800" :   // orange
		                "#F44336";    // red

	// Fill bar spans x=13..101 (88px wide) inside a 144x144 canvas
	const fillWidth = Math.round((percent / 100) * 88);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <!-- battery body outline -->
  <rect x="8" y="40" width="112" height="60" rx="8" fill="none" stroke="${color}" stroke-width="5"/>
  <!-- positive terminal nub -->
  <rect x="120" y="54" width="14" height="32" rx="3" fill="${color}"/>
  <!-- fill level -->
  <rect x="13" y="45" width="${fillWidth}" height="50" rx="4" fill="${color}" opacity="0.85"/>
  <!-- percentage label -->
  <text x="66" y="72" font-family="-apple-system,Helvetica Neue,Arial,sans-serif"
        font-size="28" font-weight="700" fill="#ffffff"
        text-anchor="middle" dominant-baseline="middle">${percent}%</text>
</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Generates a gray "unknown / error" battery image.
 */
export function makeErrorImage(): string {
	const color = "#666666";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect x="8" y="40" width="112" height="60" rx="8" fill="none" stroke="${color}" stroke-width="5"/>
  <rect x="120" y="54" width="14" height="32" rx="3" fill="${color}"/>
  <text x="66" y="72" font-family="-apple-system,Helvetica Neue,Arial,sans-serif"
        font-size="32" font-weight="700" fill="${color}"
        text-anchor="middle" dominant-baseline="middle">--</text>
</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

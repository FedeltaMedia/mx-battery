/**
 * Copies runtime native dependencies into the .sdPlugin folder so they are
 * included in the packaged .streamDeckPlugin file.
 *
 * node-hid v3.3.0 ships prebuilt binaries for ALL platforms inside its npm
 * package, so a single build on any OS produces a cross-platform plugin:
 *   prebuilds/HID-darwin-arm64/   ← macOS Apple Silicon
 *   prebuilds/HID-darwin-x64/     ← macOS Intel
 *   prebuilds/HID-win32-x64/      ← Windows 64-bit
 *   prebuilds/HID-win32-ia32/     ← Windows 32-bit
 *   prebuilds/HID-win32-arm64/    ← Windows ARM
 *
 * pkg-prebuilds selects the right binary at runtime.
 */
const fs   = require('fs');
const path = require('path');

const src = 'node_modules';
const dst = 'com.fedeltamedia.mxbattery.sdPlugin/node_modules';

const dependencies = [
	'node-hid',
	'pkg-prebuilds',
];

if (fs.existsSync(dst)) {
	console.log('Removing existing plugin node_modules...');
	fs.rmSync(dst, { recursive: true });
}

fs.mkdirSync(dst, { recursive: true });

for (const mod of dependencies) {
	const srcPath = path.join(src, mod);
	const dstPath = path.join(dst, mod);

	if (fs.existsSync(srcPath)) {
		console.log(`Copying ${mod}...`);
		fs.cpSync(srcPath, dstPath, { recursive: true });
	} else {
		console.warn(`Warning: ${mod} not found in node_modules — run npm install first`);
		process.exit(1);
	}
}

console.log('Dependencies copied.');

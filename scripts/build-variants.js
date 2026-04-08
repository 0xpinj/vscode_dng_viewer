#!/usr/bin/env node
/**
 * Build script that produces two .vsix variants:
 *   1. vscode-dng-viewer-<version>.vsix          — Modern (custom editors, ^1.86.0)
 *   2. vscode-dng-viewer-legacy-<version>.vsix    — Legacy (command-only, ^1.74.0)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkgOriginal = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgOriginal);

function run(cmd) {
	console.log(`> ${cmd}`);
	execSync(cmd, { cwd: root, stdio: 'inherit' });
}

function writePkg(obj) {
	fs.writeFileSync(pkgPath, JSON.stringify(obj, null, 2) + '\n');
}

function restore() {
	fs.writeFileSync(pkgPath, pkgOriginal);
}

// ── Build modern variant ──────────────────────────────────────────────
console.log('\n=== Building MODERN variant ===\n');

const modernPkg = JSON.parse(pkgOriginal);
modernPkg.engines.vscode = '^1.86.0';
// Keep everything: customEditors + commands + menus
writePkg(modernPkg);

// Bundle with the standard entry point
run('npx esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --sourcemap');
run(`npx vsce package --no-dependencies -o vscode-dng-viewer-${pkg.version}.vsix`);

// ── Build legacy variant ──────────────────────────────────────────────
console.log('\n=== Building LEGACY variant ===\n');

const legacyPkg = JSON.parse(pkgOriginal);
legacyPkg.name = 'vscode-dng-viewer-legacy';
legacyPkg.displayName = 'DNG Viewer (Legacy)';
legacyPkg.engines.vscode = '^1.74.0';
// Remove customEditors — they cause service worker errors on old VS Code
delete legacyPkg.contributes.customEditors;
// Point bundle script to legacy entry point
legacyPkg.scripts.bundle = legacyPkg.scripts.bundle.replace('src/extension.ts', 'src/extension-legacy.ts');
writePkg(legacyPkg);

// Bundle with the legacy entry point (no custom editor registration)
run('npx esbuild src/extension-legacy.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --sourcemap');
run(`npx vsce package --no-dependencies -o vscode-dng-viewer-legacy-${pkg.version}.vsix`);

// ── Restore original package.json ─────────────────────────────────────
restore();
console.log('\n✓ Restored original package.json');
console.log(`\nOutput:`);
console.log(`  vscode-dng-viewer-${pkg.version}.vsix         (modern, ^1.86.0)`);
console.log(`  vscode-dng-viewer-legacy-${pkg.version}.vsix  (legacy, ^1.74.0)`);

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { decodeDng } from './dngDecoder';

export function activate(context: vscode.ExtensionContext) {
	const tempFiles: string[] = [];
	let activeServer: http.Server | null = null;

	// Command-based opener: decode DNG → serve JPEG via temp HTTP server → open in browser.
	// Works with VS Code Remote Development (port forwarding).
	// Avoids webviews entirely (service worker bug on VS Code 1.85 remote).
	context.subscriptions.push(
		vscode.commands.registerCommand('dngViewer.open', async (uri?: vscode.Uri) => {
			if (!uri) {
				const uris = await vscode.window.showOpenDialog({
					canSelectMany: false,
					filters: { 'DNG Files': ['dng', 'DNG'] },
				});
				if (!uris || uris.length === 0) { return; }
				uri = uris[0];
			}

			try {
				const result = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Decoding DNG...' },
					async () => {
						return await decodeDng(uri!.fsPath);
					}
				);

				// Close any previous preview server
				if (activeServer) {
					activeServer.close();
					activeServer = null;
				}

				const baseName = path.basename(uri.fsPath, path.extname(uri.fsPath));
				const jpegBuf = result.jpegBuffer;
				const metaJson = JSON.stringify(result.metadata, null, 2);

				// Serve an HTML page with the image + metadata
				const server = http.createServer((req, res) => {
					if (req.url === '/image.jpg') {
						res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(jpegBuf.length) });
						res.end(jpegBuf);
					} else {
						// Serve a simple HTML viewer
						const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${baseName} — DNG Preview</title>
<style>
	body { margin: 0; background: #1e1e1e; color: #ccc; font-family: system-ui; display: flex; flex-direction: column; height: 100vh; }
	.toolbar { padding: 8px 16px; background: #252526; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
	.toolbar button { background: #0e639c; color: #fff; border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; }
	.toolbar button:hover { background: #1177bb; }
	.toolbar .info { font-size: 13px; opacity: 0.7; }
	.container { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: center; }
	.container img { max-width: 100%; max-height: 100%; object-fit: contain; }
	.meta { display: none; position: fixed; right: 0; top: 40px; bottom: 0; width: 350px; background: #252526; border-left: 1px solid #333; overflow: auto; padding: 12px; font-size: 12px; }
	.meta.visible { display: block; }
	.meta pre { white-space: pre-wrap; word-break: break-all; }
</style></head><body>
<div class="toolbar">
	<span><strong>${baseName}.dng</strong></span>
	<span class="info">${result.width} × ${result.height}</span>
	<button onclick="document.querySelector('.meta').classList.toggle('visible')">EXIF</button>
</div>
<div class="container"><img src="/image.jpg" alt="${baseName}"></div>
<div class="meta"><pre>${metaJson.replace(/</g, '&lt;')}</pre></div>
</body></html>`;
						res.writeHead(200, { 'Content-Type': 'text/html' });
						res.end(html);
					}
				});

				activeServer = server;

				await new Promise<void>((resolve, reject) => {
					server.listen(0, '127.0.0.1', async () => {
						try {
							const addr = server.address() as { port: number };
							const localUri = vscode.Uri.parse(`http://127.0.0.1:${addr.port}/`);
							const externalUri = await vscode.env.asExternalUri(localUri);
							await vscode.env.openExternal(externalUri);
							resolve();
						} catch (e) {
							reject(e);
						}
					});
					server.on('error', reject);
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`DNG Viewer: ${message}`);
			}
		})
	);

	// Clean up on deactivation
	context.subscriptions.push({
		dispose() {
			if (activeServer) { activeServer.close(); }
			for (const f of tempFiles) {
				try { fs.unlinkSync(f); } catch { /* ignore */ }
			}
		}
	});
}

export function deactivate() {}

import * as vscode from 'vscode';
import { decodeDng } from './dngDecoder';

/**
 * Sets HTML once (loading state) and uses postMessage to push decoded data.
 * This avoids reassigning webview.html which destroys/recreates the iframe
 * and triggers a service worker registration error on VS Code 1.85.
 */
export async function showDngInWebview(
	panel: vscode.WebviewPanel,
	uri: vscode.Uri,
	extensionUri: vscode.Uri,
): Promise<void> {

	const styleUri = panel.webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'viewer.css')
	);
	const scriptUri = panel.webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'viewer.js')
	);

	// Set HTML exactly ONCE — starts in loading state
	panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
</head>
<body class="loading">
	<div class="loading-container" id="loading-container">
		<div class="spinner"></div>
		<p>Decoding DNG file...</p>
	</div>

	<div class="error-container" id="error-container" style="display:none;">
		<h2>Failed to decode DNG file</h2>
		<p id="error-message"></p>
	</div>

	<div id="viewer-container" style="display:none;">
		<div class="toolbar">
			<button id="btn-zoom-fit" title="Fit to window">Fit</button>
			<button id="btn-zoom-100" title="Actual size (100%)">100%</button>
			<button id="btn-zoom-in" title="Zoom in">+</button>
			<button id="btn-zoom-out" title="Zoom out">&minus;</button>
			<span id="zoom-level" class="zoom-level">100%</span>
			<span class="separator"></span>
			<span class="image-info" id="image-info"></span>
			<span class="separator"></span>
			<button id="btn-toggle-meta" title="Toggle EXIF metadata">EXIF</button>
		</div>
		<div class="content">
			<div class="image-container" id="image-container">
				<img id="preview-image" alt="DNG Preview" draggable="false">
			</div>
			<div class="metadata-panel" id="metadata-panel" style="display:none;">
				<h3>EXIF Metadata</h3>
				<pre id="metadata-content"></pre>
			</div>
		</div>
	</div>

	<script src="${scriptUri}"></script>
</body>
</html>`;

	// Decode and send result via postMessage (no second html assignment)
	try {
		const result = await decodeDng(uri.fsPath);
		const jpegDataUri = `data:image/jpeg;base64,${result.jpegBuffer.toString('base64')}`;
		panel.webview.postMessage({
			type: 'loaded',
			jpegDataUri,
			metadata: result.metadata,
			width: result.width,
			height: result.height,
			originalWidth: result.originalWidth,
			originalHeight: result.originalHeight,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		panel.webview.postMessage({
			type: 'error',
			message,
		});
	}
}

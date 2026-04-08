import * as vscode from 'vscode';
import { DngDocument } from './dngDocument';
import { decodeDng } from './dngDecoder';

export class DngPreviewProvider implements vscode.CustomReadonlyEditorProvider<DngDocument> {
	public static readonly viewType = 'dngViewer.preview';

	private readonly _extensionUri: vscode.Uri;
	private readonly _context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		this._extensionUri = context.extensionUri;
	}

	async openCustomDocument(uri: vscode.Uri): Promise<DngDocument> {
		return new DngDocument(uri);
	}

	async resolveCustomEditor(
		document: DngDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			enableForms: false,
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'media'),
			],
		};

		// Set HTML exactly ONCE (loading state + hidden viewer + hidden error).
		// Then use postMessage to push data — avoids service worker re-registration bug on VS Code 1.85.
		webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

		// Decode and push result
		await this._decodeAndPost(document, webviewPanel);

		// Watch for changes to this specific file on disk
		const fileName = document.uri.path.split('/').pop() || '*';
		const dirUri = vscode.Uri.joinPath(document.uri, '..');
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(dirUri, fileName)
		);
		watcher.onDidChange(async () => {
			// Clear cache so it re-decodes
			document.jpegDataUri = undefined as any;
			await this._decodeAndPost(document, webviewPanel);
		});
		webviewPanel.onDidDispose(() => watcher.dispose());
	}

	private async _decodeAndPost(document: DngDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		try {
			if (!document.jpegDataUri) {
				const result = await decodeDng(document.uri.fsPath);
				document.jpegDataUri = `data:image/jpeg;base64,${result.jpegBuffer.toString('base64')}`;
				document.metadata = result.metadata;
				document.width = result.width;
				document.height = result.height;
				document.originalWidth = result.originalWidth;
				document.originalHeight = result.originalHeight;
			}

			webviewPanel.webview.postMessage({
				type: 'loaded',
				jpegDataUri: document.jpegDataUri,
				metadata: document.metadata,
				width: document.width,
				height: document.height,
				originalWidth: document.originalWidth,
				originalHeight: document.originalHeight,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			webviewPanel.webview.postMessage({
				type: 'error',
				message,
			});
		}
	}

	private _getHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'viewer.css')
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'viewer.js')
		);

		return /* html */ `<!DOCTYPE html>
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
	}
}

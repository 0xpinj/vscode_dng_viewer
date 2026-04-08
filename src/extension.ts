import * as vscode from 'vscode';
import * as path from 'path';
import { DngPreviewProvider } from './dngPreviewProvider';
import { showDngInWebview } from './webviewHelper';

export function activate(context: vscode.ExtensionContext) {
	// Register custom editor (modern VS Code — auto-opens .dng files)
	const provider = new DngPreviewProvider(context);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			DngPreviewProvider.viewType,
			provider,
			{
				supportsMultipleEditorsPerDocument: true,
			}
		)
	);

	// Register command-based opener (fallback for legacy VS Code)
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

			const fileName = path.basename(uri.fsPath);
			const panel = vscode.window.createWebviewPanel(
				'dngViewer.commandPreview',
				`DNG: ${fileName}`,
				vscode.ViewColumn.Active,
				{
					enableScripts: true,
					enableForms: false,
					localResourceRoots: [
						vscode.Uri.joinPath(context.extensionUri, 'media'),
					],
				},
			);

			await showDngInWebview(panel, uri, context.extensionUri);
		})
	);
}

export function deactivate() {}

import * as vscode from 'vscode';

export class DngDocument implements vscode.CustomDocument {
	public readonly uri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	/** Cached decoded JPEG as a data URI. Set after first decode. */
	public jpegDataUri: string | undefined;
	/** Cached metadata. */
	public metadata: Record<string, unknown> | undefined;
	/** Preview image width after decode/downsample. */
	public width: number | undefined;
	/** Preview image height after decode/downsample. */
	public height: number | undefined;
	/** Original image width from the DNG file. */
	public originalWidth: number | undefined;
	/** Original image height from the DNG file. */
	public originalHeight: number | undefined;

	constructor(uri: vscode.Uri) {
		this.uri = uri;
	}

	dispose(): void {
		this._disposables.forEach(d => d.dispose());
		this._disposables.length = 0;
	}
}

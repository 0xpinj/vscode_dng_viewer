import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { decodeDngDirect } from './dngDirectDecoder';

const execFileAsync = promisify(execFile);

export interface DecodeResult {
	jpegBuffer: Buffer;
	metadata: Record<string, unknown>;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
}

/**
 * Attempt fast-path: extract an embedded JPEG thumbnail via exifr.
 * Returns null if no thumbnail is found.
 */
async function tryExifrThumbnail(filePath: string): Promise<DecodeResult | null> {
	try {
		const exifr = await import('exifr');
		const thumbBuf = await exifr.thumbnail(filePath);
		if (!thumbBuf || (thumbBuf as Uint8Array).length === 0) {
			return null;
		}

		const meta = await exifr.parse(filePath, true);

		const jpeg = require('jpeg-js') as typeof import('jpeg-js');
		const decoded = jpeg.decode(Buffer.from(thumbBuf), { useTArray: true, formatAsRGBA: false });

		// Extract original image dimensions from EXIF metadata
		const origWidth = (meta?.ImageWidth ?? meta?.ExifImageWidth ?? decoded.width) as number;
		const origHeight = (meta?.ImageHeight ?? meta?.ExifImageHeight ?? decoded.height) as number;

		return {
			jpegBuffer: Buffer.from(thumbBuf),
			metadata: meta || {},
			width: decoded.width,
			height: decoded.height,
			originalWidth: origWidth,
			originalHeight: origHeight,
		};
	} catch {
		return null;
	}
}

/** Find all available raw decode tools (ordered by preference). */
async function findAllDcraw(): Promise<string[]> {
	const candidates = [
		'dcraw_emu',
		'/usr/lib/libraw/dcraw_emu',
		'simple_dcraw',
		'/usr/lib/libraw/simple_dcraw',
		'dcraw',
	];
	const found: string[] = [];
	const fs = require('fs');
	for (const cmd of candidates) {
		try {
			if (cmd.startsWith('/')) {
				if (fs.existsSync(cmd)) { found.push(cmd); }
			} else {
				await execFileAsync('which', [cmd]);
				found.push(cmd);
			}
		} catch {
			// not found
		}
	}
	return found;
}

/**
 * Parse a PPM (P6 binary) buffer into width, height, and RGB pixel data.
 */
function parsePpm(buf: Buffer): { width: number; height: number; pixels: Buffer } {
	// PPM P6 format: "P6\n<width> <height>\n<maxval>\n<binary RGB>"
	let offset = 0;

	// Read magic
	const magic = buf.slice(0, 2).toString('ascii');
	if (magic !== 'P6') {
		throw new Error(`Expected PPM P6 format, got "${magic}"`);
	}
	offset = 2;

	// Skip whitespace and comments
	function skipWhitespaceAndComments() {
		while (offset < buf.length) {
			const ch = buf[offset];
			if (ch === 0x23) { // '#' comment
				while (offset < buf.length && buf[offset] !== 0x0A) { offset++; }
				offset++; // skip newline
			} else if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D) {
				offset++;
			} else {
				break;
			}
		}
	}

	skipWhitespaceAndComments();

	// Read width
	let widthStr = '';
	while (offset < buf.length && buf[offset] >= 0x30 && buf[offset] <= 0x39) {
		widthStr += String.fromCharCode(buf[offset++]);
	}
	skipWhitespaceAndComments();

	// Read height
	let heightStr = '';
	while (offset < buf.length && buf[offset] >= 0x30 && buf[offset] <= 0x39) {
		heightStr += String.fromCharCode(buf[offset++]);
	}
	skipWhitespaceAndComments();

	// Read maxval
	let maxvalStr = '';
	while (offset < buf.length && buf[offset] >= 0x30 && buf[offset] <= 0x39) {
		maxvalStr += String.fromCharCode(buf[offset++]);
	}
	// Skip exactly one whitespace byte after maxval
	offset++;

	const width = parseInt(widthStr, 10);
	const height = parseInt(heightStr, 10);
	const maxval = parseInt(maxvalStr, 10);

	if (!width || !height || !maxval) {
		throw new Error(`Invalid PPM header: ${width}x${height} maxval=${maxval}`);
	}

	let pixels: Buffer;
	if (maxval <= 255) {
		pixels = buf.slice(offset, offset + width * height * 3);
	} else {
		// 16-bit PPM: convert to 8-bit
		const pixelCount = width * height * 3;
		pixels = Buffer.alloc(pixelCount);
		for (let i = 0; i < pixelCount; i++) {
			const val16 = (buf[offset + i * 2] << 8) | buf[offset + i * 2 + 1];
			pixels[i] = Math.round((val16 / maxval) * 255);
		}
	}

	return { width, height, pixels };
}

/**
 * Try decoding with a single tool. Returns PPM buffer or null on failure.
 */
async function tryDecode(dcraw: string, filePath: string, halfSize: boolean, useCameraWb: boolean): Promise<{ ppmBuffer: Buffer; stderr: string } | null> {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const isDcrawEmu = dcraw.includes('dcraw_emu');

	if (isDcrawEmu) {
		// dcraw_emu writes output to a file beside the input.
		// Copy to temp dir, decode there, read the output.
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dng-'));
		const baseName = path.basename(filePath);
		const tmpInput = path.join(tmpDir, baseName);
		try {
			fs.copyFileSync(filePath, tmpInput);
			const args: string[] = [];
			if (useCameraWb) { args.push('-w'); } else { args.push('-a'); }
			if (halfSize) { args.push('-h'); }
			args.push(tmpInput);

			let stderrText = '';
			await new Promise<void>((resolve, reject) => {
				const proc = require('child_process').execFile(
					dcraw, args,
					{ maxBuffer: 10 * 1024 * 1024 },
					(err: Error | null) => {
						if (err) { reject(err); return; }
						resolve();
					}
				);
				proc.stderr?.on('data', (d: Buffer) => { stderrText += d.toString(); });
			});

			// Find output file (not the input copy)
			const files = fs.readdirSync(tmpDir).filter((f: string) => f !== baseName);
			if (files.length === 0) {
				return null; // decoded without error but no output = unsupported format
			}
			const ppmBuffer = fs.readFileSync(path.join(tmpDir, files[0]));
			return { ppmBuffer, stderr: stderrText };
		} catch {
			return null;
		} finally {
			try {
				const entries = fs.readdirSync(tmpDir);
				for (const e of entries) { fs.unlinkSync(path.join(tmpDir, e)); }
				fs.rmdirSync(tmpDir);
			} catch { /* best effort */ }
		}
	} else {
		// dcraw / simple_dcraw: -c writes PPM to stdout
		const args: string[] = ['-c'];
		if (useCameraWb) { args.push('-w'); } else { args.push('-a'); }
		if (halfSize) { args.push('-h'); }
		args.push(filePath);

		try {
			let stderrText = '';
			const ppmBuffer = await new Promise<Buffer>((resolve, reject) => {
				const proc = require('child_process').execFile(
					dcraw, args,
					{ encoding: 'buffer' as BufferEncoding, maxBuffer: 200 * 1024 * 1024 },
					(err: Error | null, stdout: Buffer) => {
						if (err) { reject(err); return; }
						if (!stdout || stdout.length === 0) { reject(new Error('empty output')); return; }
						resolve(stdout);
					}
				);
				proc.stderr?.on('data', (d: Buffer) => { stderrText += d.toString(); });
			});
			return { ppmBuffer, stderr: stderrText };
		} catch {
			return null;
		}
	}
}

/**
 * Full decode path: try all available raw decode tools in sequence.
 */
async function fullDecode(filePath: string): Promise<DecodeResult> {
	const config = vscode.workspace.getConfiguration('dngViewer');
	const halfSize = config.get<boolean>('halfSize', true);
	const useCameraWb = config.get<boolean>('useCameraWb', true);
	const demosaicMode = config.get<string>('demosaicMode', 'fast');
	const previewMaxWidth = config.get<number>('previewMaxWidth', 1000);

	const tools = await findAllDcraw();
	if (tools.length === 0) {
		throw new Error(
			'No raw decoder found on your system.\n' +
			'Install one of:\n' +
			'  Linux:   sudo apt install libraw-bin   (or dcraw)\n' +
			'  macOS:   brew install libraw   (or dcraw)\n' +
			'  Windows: download dcraw from https://www.dechifro.org/dcraw/'
		);
	}

	// Extract EXIF metadata once (used for original dimensions + metadata panel)
	let origWidth = 0, origHeight = 0;
	let exifMetadata: Record<string, unknown> = {};
	try {
		const exifr = await import('exifr');
		const meta = await exifr.parse(filePath, true);
		if (meta) {
			exifMetadata = meta;
			origWidth = (meta.ImageWidth ?? meta.ExifImageWidth ?? 0) as number;
			origHeight = (meta.ImageHeight ?? meta.ExifImageHeight ?? 0) as number;
		}
	} catch { /* best-effort */ }

	const errors: string[] = [];
	for (const tool of tools) {
		const result = await tryDecode(tool, filePath, halfSize, useCameraWb);
		if (result && result.ppmBuffer.length > 0) {
			try {
				const { width, height, pixels } = parsePpm(result.ppmBuffer);
				return await encodePpmToResult(pixels, width, height, previewMaxWidth, exifMetadata, origWidth || width, origHeight || height);
			} catch (e) {
				errors.push(`${tool}: PPM parse failed — ${e instanceof Error ? e.message : e}`);
			}
		} else {
			errors.push(`${tool}: no output (format not supported)`);
		}
	}

	// Last resort: try pure-JS TIFF/DNG decoder (handles float32 HDR, etc.)
	try {
		const direct = decodeDngDirect(filePath, demosaicMode === 'full');
		if (direct) {
			return await encodePpmToResult(direct.pixels, direct.width, direct.height, previewMaxWidth, exifMetadata, origWidth || direct.width, origHeight || direct.height);
		}
		errors.push('direct JS decoder: format not supported');
	} catch (e) {
		errors.push(`direct JS decoder: ${e instanceof Error ? e.message : e}`);
	}

	throw new Error(
		`None of the available decoders (${tools.join(', ')}, JS-direct) could decode this DNG file.\n` +
		`Details:\n${errors.map(e => '  • ' + e).join('\n')}`
	);
}

/** Box-downsample RGB pixels to fit within maxWidth. */
function downsampleRgb(pixels: Buffer, width: number, height: number, maxWidth: number): { pixels: Buffer; width: number; height: number } {
	if (width <= maxWidth) { return { pixels, width, height }; }
	const scale = maxWidth / width;
	const newW = Math.round(width * scale);
	const newH = Math.round(height * scale);
	const out = Buffer.alloc(newW * newH * 3);

	for (let dy = 0; dy < newH; dy++) {
		const sy0 = (dy / newH) * height;
		const sy1 = ((dy + 1) / newH) * height;
		const yStart = Math.floor(sy0);
		const yEnd = Math.min(Math.ceil(sy1), height);

		for (let dx = 0; dx < newW; dx++) {
			const sx0 = (dx / newW) * width;
			const sx1 = ((dx + 1) / newW) * width;
			const xStart = Math.floor(sx0);
			const xEnd = Math.min(Math.ceil(sx1), width);

			let r = 0, g = 0, b = 0, count = 0;
			for (let sy = yStart; sy < yEnd; sy++) {
				for (let sx = xStart; sx < xEnd; sx++) {
					const si = (sy * width + sx) * 3;
					r += pixels[si];
					g += pixels[si + 1];
					b += pixels[si + 2];
					count++;
				}
			}
			const di = (dy * newW + dx) * 3;
			out[di] = Math.round(r / count);
			out[di + 1] = Math.round(g / count);
			out[di + 2] = Math.round(b / count);
		}
	}
	return { pixels: out, width: newW, height: newH };
}

function encodePpmToResult(pixels: Buffer, width: number, height: number, maxWidth?: number, metadata?: Record<string, unknown>, originalWidth?: number, originalHeight?: number): DecodeResult {
	// Downsample for faster JPEG encoding and smaller output
	const limit = maxWidth ?? 1000;
	const ds = downsampleRgb(pixels, width, height, limit);

	const jpeg = require('jpeg-js') as typeof import('jpeg-js');
	const rgbaData = Buffer.alloc(ds.width * ds.height * 4);
	for (let i = 0, j = 0; i < ds.pixels.length; i += 3, j += 4) {
		rgbaData[j] = ds.pixels[i];
		rgbaData[j + 1] = ds.pixels[i + 1];
		rgbaData[j + 2] = ds.pixels[i + 2];
		rgbaData[j + 3] = 255;
	}

	const encoded = jpeg.encode({ data: rgbaData, width: ds.width, height: ds.height }, 90);

	return {
		jpegBuffer: Buffer.from(encoded.data),
		metadata: metadata || {},
		width: ds.width,
		height: ds.height,
		originalWidth: originalWidth ?? width,
		originalHeight: originalHeight ?? height,
	};
}

/**
 * Decode a DNG file to JPEG.
 * Tries exifr thumbnail extraction first, falls back to dcraw full decode.
 */
export async function decodeDng(filePath: string): Promise<DecodeResult> {
	// Fast path: try embedded thumbnail
	const thumbResult = await tryExifrThumbnail(filePath);
	if (thumbResult) {
		return thumbResult;
	}

	// Full decode via dcraw
	return fullDecode(filePath);
}

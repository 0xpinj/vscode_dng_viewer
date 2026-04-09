/**
 * Pure JavaScript DNG/TIFF decoder for floating-point and integer image data.
 * Handles formats that dcraw/LibRaw 0.18 cannot (e.g. float32 HDR DNG from Spheron cameras).
 * Supports: uncompressed, deflate-compressed, with horizontal/float predictors.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';

// TIFF tag constants
const TAG_NEW_SUBFILE_TYPE = 254;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_HEIGHT = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_PREDICTOR = 317;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_HEIGHT = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_SUB_IFDS = 330;
const TAG_SAMPLE_FORMAT = 339;
const TAG_CFA_REPEAT_PATTERN_DIM = 33421;
const TAG_CFA_PATTERN = 33422;

interface TiffReader {
	buf: Buffer;
	le: boolean;
}

interface IfdEntry {
	tag: number;
	type: number;
	count: number;
	valueOffset: number;
}

function readU16(r: TiffReader, off: number): number {
	return r.le ? r.buf.readUInt16LE(off) : r.buf.readUInt16BE(off);
}

function readU32(r: TiffReader, off: number): number {
	return r.le ? r.buf.readUInt32LE(off) : r.buf.readUInt32BE(off);
}

function readF32(r: TiffReader, off: number): number {
	return r.le ? r.buf.readFloatLE(off) : r.buf.readFloatBE(off);
}

const TYPE_SIZES: Record<number, number> = {
	1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8
};

function parseIfd(r: TiffReader, offset: number): { entries: IfdEntry[]; nextIfd: number } {
	if (offset + 2 > r.buf.length) { return { entries: [], nextIfd: 0 }; }
	const count = readU16(r, offset);
	const entries: IfdEntry[] = [];
	for (let i = 0; i < count; i++) {
		const eo = offset + 2 + i * 12;
		if (eo + 12 > r.buf.length) { break; }
		const tag = readU16(r, eo);
		const type = readU16(r, eo + 2);
		const cnt = readU32(r, eo + 4);
		const typeSize = TYPE_SIZES[type] || 1;
		const valueOffset = cnt * typeSize <= 4 ? eo + 8 : readU32(r, eo + 8);
		entries.push({ tag, type, count: cnt, valueOffset });
	}
	const nextOff = offset + 2 + count * 12;
	const nextIfd = (nextOff + 4 <= r.buf.length) ? readU32(r, nextOff) : 0;
	return { entries, nextIfd };
}

function getVal(r: TiffReader, e: IfdEntry): number {
	switch (e.type) {
		case 1: case 7: return r.buf[e.valueOffset];
		case 3: return readU16(r, e.valueOffset);
		case 4: return readU32(r, e.valueOffset);
		default: return readU32(r, e.valueOffset);
	}
}

function getVals(r: TiffReader, e: IfdEntry): number[] {
	const v: number[] = [];
	let off = e.valueOffset;
	for (let i = 0; i < e.count; i++) {
		switch (e.type) {
			case 1: case 7: v.push(r.buf[off]); off += 1; break;
			case 3: v.push(readU16(r, off)); off += 2; break;
			case 4: v.push(readU32(r, off)); off += 4; break;
			default: v.push(readU32(r, off)); off += 4; break;
		}
	}
	return v;
}

function findTag(entries: IfdEntry[], tag: number): IfdEntry | undefined {
	return entries.find(e => e.tag === tag);
}

/** Undo floating-point horizontal differencing predictor (TIFF Predictor 3). */
function undoFloatPredictor(data: Uint8Array, width: number, height: number, channels: number, bytesPerSample: number): Buffer {
	const rowBytes = width * channels * bytesPerSample;
	const out = Buffer.alloc(data.length);
	const predictorStride = channels * bytesPerSample;

	for (let y = 0; y < height; y++) {
		const rowOff = y * rowBytes;
		if (rowOff + rowBytes > data.length) {
			throw new Error(`Predictor 3 row ${y} is truncated`);
		}

		// Step 1: Undo byte-level horizontal differencing
		// First pixel's bytes are stored as-is; subsequent are deltas
		const temp = Buffer.alloc(rowBytes);
		for (let b = 0; b < predictorStride; b++) {
			temp[b] = data[rowOff + b];
		}
		for (let b = predictorStride; b < rowBytes; b++) {
			temp[b] = (temp[b - predictorStride] + data[rowOff + b]) & 0xFF;
		}

		// Step 2: Un-transpose bytes
		// The bytes are stored in "byte-plane" order: all byte[0]'s, then byte[1]'s, etc.
		const sampleCount = width * channels;
		for (let s = 0; s < sampleCount; s++) {
			for (let b = 0; b < bytesPerSample; b++) {
				out[rowOff + s * bytesPerSample + b] = temp[b * sampleCount + s];
			}
		}
	}
	return out;
}

// Exported for regression coverage of multi-row TIFF Predictor 3 decoding.
export function undoFloatPredictorForTest(data: Uint8Array, width: number, height: number, channels: number, bytesPerSample: number): Buffer {
	return undoFloatPredictor(data, width, height, channels, bytesPerSample);
}

/** Undo integer horizontal differencing predictor (TIFF Predictor 2). */
function undoIntPredictor(data: Uint8Array, width: number, height: number, channels: number, bytesPerSample: number): Buffer {
	const out = Buffer.from(data);
	const rowSamples = width * channels;
	const rowBytes = rowSamples * bytesPerSample;

	for (let y = 0; y < height; y++) {
		const rowOff = y * rowBytes;
		if (bytesPerSample === 1) {
			for (let i = channels; i < rowSamples; i++) {
				out[rowOff + i] = (out[rowOff + i] + out[rowOff + i - channels]) & 0xFF;
			}
		} else if (bytesPerSample === 2) {
			for (let i = channels; i < rowSamples; i++) {
				const prev = out.readUInt16LE(rowOff + (i - channels) * 2);
				const cur = out.readUInt16LE(rowOff + i * 2);
				out.writeUInt16LE((prev + cur) & 0xFFFF, rowOff + i * 2);
			}
		}
	}
	return out;
}

function halfToFloat(h: number): number {
	const s = (h >> 15) & 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) {
		if (m === 0) { return s ? -0 : 0; }
		return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
	}
	if (e === 31) {
		return m === 0 ? (s ? -Infinity : Infinity) : NaN;
	}
	return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
}

export interface DirectDecodeResult {
	pixels: Buffer; // RGB 8-bit
	width: number;
	height: number;
}

/**
 * Attempt to decode a DNG file directly by parsing TIFF structure.
 * Throws descriptive errors if decoding fails.
 * Returns null only for non-TIFF files.
 */
export function decodeDngDirect(filePath: string, fullDemosaic: boolean = false): DirectDecodeResult | null {
	const buf = fs.readFileSync(filePath);
	if (buf.length < 8) { return null; }

	const byteOrder = buf.toString('ascii', 0, 2);
	let le: boolean;
	if (byteOrder === 'II') { le = true; }
	else if (byteOrder === 'MM') { le = false; }
	else { return null; }

	const r: TiffReader = { buf, le };
	if (readU16(r, 2) !== 42) { return null; }

	const ifd0Off = readU32(r, 4);

	// Collect all IFDs to search (IFD0, next IFDs, SubIFDs)
	const ifdOffsets: number[] = [ifd0Off];
	const { entries: ifd0Entries, nextIfd } = parseIfd(r, ifd0Off);
	if (nextIfd > 0 && nextIfd < buf.length) { ifdOffsets.push(nextIfd); }

	const subIfdEntry = findTag(ifd0Entries, TAG_SUB_IFDS);
	if (subIfdEntry) {
		for (const off of getVals(r, subIfdEntry)) {
			if (off > 0 && off < buf.length) { ifdOffsets.push(off); }
		}
	}

	// Also follow linked IFDs (IFD1, IFD2, ...)
	let nextOff = nextIfd;
	const seen = new Set<number>([ifd0Off, nextIfd]);
	while (nextOff > 0 && nextOff < buf.length) {
		const parsed = parseIfd(r, nextOff);
		if (parsed.nextIfd > 0 && parsed.nextIfd < buf.length && !seen.has(parsed.nextIfd)) {
			ifdOffsets.push(parsed.nextIfd);
			seen.add(parsed.nextIfd);
			nextOff = parsed.nextIfd;
		} else {
			break;
		}
	}

	// Collect diagnostics for all IFDs
	const ifdInfos: string[] = [];
	let bestIfd: { entries: IfdEntry[]; width: number; height: number; isCfa: boolean } | null = null;

	for (const ifdOff of ifdOffsets) {
		try {
			const { entries } = parseIfd(r, ifdOff);
			const wEntry = findTag(entries, TAG_IMAGE_WIDTH);
			const hEntry = findTag(entries, TAG_IMAGE_HEIGHT);
			if (!wEntry || !hEntry) {
				ifdInfos.push(`IFD@${ifdOff}: no width/height tags`);
				continue;
			}

			const w = getVal(r, wEntry);
			const h = getVal(r, hEntry);

			const photometric = findTag(entries, TAG_PHOTOMETRIC);
			const photoVal = photometric ? getVal(r, photometric) : -1;
			const compEntry = findTag(entries, TAG_COMPRESSION);
			const compVal = compEntry ? getVal(r, compEntry) : 1;
			const bpsEntry = findTag(entries, TAG_BITS_PER_SAMPLE);
			const bpsVal = bpsEntry ? getVal(r, bpsEntry) : 8;
			const sfEntry = findTag(entries, TAG_SAMPLE_FORMAT);
			const sfVal = sfEntry ? getVal(r, sfEntry) : 1;
			const sppEntry = findTag(entries, TAG_SAMPLES_PER_PIXEL);
			const sppVal = sppEntry ? getVal(r, sppEntry) : 1;
			const nsfEntry = findTag(entries, TAG_NEW_SUBFILE_TYPE);
			const nsfVal = nsfEntry ? getVal(r, nsfEntry) : -1;
			const hasTiles = findTag(entries, TAG_TILE_OFFSETS);
			const hasStrips = findTag(entries, TAG_STRIP_OFFSETS);

			ifdInfos.push(`IFD@${ifdOff}: ${w}x${h} photo=${photoVal} comp=${compVal} bps=${bpsVal} sf=${sfVal} spp=${sppVal} nsf=${nsfVal} ${hasTiles ? 'tiles' : hasStrips ? 'strips' : 'no-data'}`);

			const isCfa = !!(photometric && photoVal === 32803);

			// Prefer non-CFA, but accept CFA as fallback
			if (!bestIfd
				|| (!isCfa && bestIfd.isCfa) // non-CFA beats CFA
				|| (isCfa === bestIfd.isCfa && w * h > bestIfd.width * bestIfd.height)) {
				bestIfd = { entries, width: w, height: h, isCfa };
			}
		} catch (e) {
			ifdInfos.push(`IFD@${ifdOff}: parse error — ${e instanceof Error ? e.message : e}`);
			continue;
		}
	}

	if (!bestIfd) {
		throw new Error(`No usable image IFDs found. Found ${ifdOffsets.length} IFDs:\n${ifdInfos.map((i: string) => '  ' + i).join('\n')}`);
	}

	const { entries, width, height } = bestIfd;

	const bps = findTag(entries, TAG_BITS_PER_SAMPLE);
	const bitsPerSample = bps ? getVal(r, bps) : 8;
	const comp = findTag(entries, TAG_COMPRESSION);
	const compression = comp ? getVal(r, comp) : 1;
	const sppTag = findTag(entries, TAG_SAMPLES_PER_PIXEL);
	const samplesPerPixel = sppTag ? getVal(r, sppTag) : 1;
	const sfTag = findTag(entries, TAG_SAMPLE_FORMAT);
	const sampleFormat = sfTag ? getVal(r, sfTag) : 1; // 1=uint, 3=float
	const predTag = findTag(entries, TAG_PREDICTOR);
	const predictor = predTag ? getVal(r, predTag) : 1;

	// Only handle uncompressed (1) and deflate (8, 32946)
	if (compression !== 1 && compression !== 8 && compression !== 32946) {
		throw new Error(
			`Unsupported compression=${compression} in ${width}x${height} IFD (bps=${bitsPerSample} sf=${sampleFormat} spp=${samplesPerPixel}).\n` +
			`All IFDs:\n${ifdInfos.map(i => '  ' + i).join('\n')}`
		);
	}

	const bytesPerSample = bitsPerSample / 8;

	// Read image data from strips or tiles
	let rawData: Buffer;

	const tileOffs = findTag(entries, TAG_TILE_OFFSETS);
	const tileBcs = findTag(entries, TAG_TILE_BYTE_COUNTS);
	const stripOffs = findTag(entries, TAG_STRIP_OFFSETS);
	const stripBcs = findTag(entries, TAG_STRIP_BYTE_COUNTS);

	if (tileOffs && tileBcs) {
		const twTag = findTag(entries, TAG_TILE_WIDTH);
		const thTag = findTag(entries, TAG_TILE_HEIGHT);
		const tileW = twTag ? getVal(r, twTag) : width;
		const tileH = thTag ? getVal(r, thTag) : height;
		const offsets = getVals(r, tileOffs);
		const byteCounts = getVals(r, tileBcs);

		const rowBytes = width * samplesPerPixel * bytesPerSample;
		rawData = Buffer.alloc(height * rowBytes);

		const tilesAcross = Math.ceil(width / tileW);
		const tileRowBytes = tileW * samplesPerPixel * bytesPerSample;

		for (let i = 0; i < offsets.length; i++) {
			let tile: Buffer = buf.slice(offsets[i], offsets[i] + byteCounts[i]);
			if (compression === 8 || compression === 32946) {
				try { tile = Buffer.from(zlib.inflateSync(tile)); } catch { continue; }
			}

			// Undo predictor on this tile
			if (predictor === 3) {
				tile = undoFloatPredictor(tile, tileW, tileH, samplesPerPixel, bytesPerSample);
			} else if (predictor === 2) {
				tile = undoIntPredictor(tile, tileW, tileH, samplesPerPixel, bytesPerSample);
			}

			const tileRow = Math.floor(i / tilesAcross);
			const tileCol = i % tilesAcross;
			const startX = tileCol * tileW;
			const startY = tileRow * tileH;

			for (let y = 0; y < tileH && (startY + y) < height; y++) {
				const srcOff = y * tileRowBytes;
				const dstOff = (startY + y) * rowBytes + startX * samplesPerPixel * bytesPerSample;
				const copyLen = Math.min(tileRowBytes, (width - startX) * samplesPerPixel * bytesPerSample);
				if (srcOff + copyLen <= tile.length) {
					tile.copy(rawData, dstOff, srcOff, srcOff + copyLen);
				}
			}
		}
	} else if (stripOffs && stripBcs) {
		const offsets = getVals(r, stripOffs);
		const byteCounts = getVals(r, stripBcs);
		const rpsTag = findTag(entries, TAG_ROWS_PER_STRIP);
		const rowsPerStrip = rpsTag ? getVal(r, rpsTag) : height;

		const chunks: Buffer[] = [];
		for (let i = 0; i < offsets.length; i++) {
			let strip: Buffer = buf.slice(offsets[i], offsets[i] + byteCounts[i]);
			if (compression === 8 || compression === 32946) {
				try { strip = Buffer.from(zlib.inflateSync(strip)); } catch { continue; }
			}

			const stripRows = Math.min(rowsPerStrip, height - i * rowsPerStrip);
			if (predictor === 3) {
				strip = undoFloatPredictor(strip, width, stripRows, samplesPerPixel, bytesPerSample);
			} else if (predictor === 2) {
				strip = undoIntPredictor(strip, width, stripRows, samplesPerPixel, bytesPerSample);
			}

				chunks.push(strip);
		}
		rawData = Buffer.concat(chunks);
	} else {
		throw new Error(
			`No strip or tile data in ${width}x${height} IFD (comp=${compression} bps=${bitsPerSample} sf=${sampleFormat} spp=${samplesPerPixel}).\n` +
			`All IFDs:\n${ifdInfos.map(i => '  ' + i).join('\n')}`
		);
	}

	// Convert to 8-bit RGB
	const pixelCount = width * height;
	const result = Buffer.alloc(pixelCount * 3);
	const outCh = Math.min(samplesPerPixel, 3);

	if (bestIfd.isCfa && samplesPerPixel === 1) {
		// CFA/Bayer demosaicing
		const cfaDimEntry = findTag(entries, TAG_CFA_REPEAT_PATTERN_DIM);
		const cfaPatEntry = findTag(entries, TAG_CFA_PATTERN);

		// CFA color: 0=Red, 1=Green, 2=Blue
		let cfaPattern = [0, 1, 1, 2]; // RGGB default
		if (cfaPatEntry && cfaDimEntry) {
			const patBytes = getVals(r, cfaPatEntry);
			if (patBytes.length >= 4) { cfaPattern = patBytes.slice(0, 4); }
		}

		// Build color index map: cfaColor[y % 2][x % 2] = 0(R), 1(G), 2(B)
		const cfaColor = [
			[cfaPattern[0], cfaPattern[1]],
			[cfaPattern[2], cfaPattern[3]],
		];

		// Helper to read one sample from rawData as float64
		const readSample = (i: number): number => {
			if (sampleFormat === 3 && bitsPerSample === 32) {
				const off = i * 4;
				if (off + 4 > rawData.length) { return 0; }
				const v = le ? rawData.readFloatLE(off) : rawData.readFloatBE(off);
				return Number.isFinite(v) ? v : 0;
			} else if (sampleFormat === 3 && bitsPerSample === 16) {
				const off = i * 2;
				if (off + 2 > rawData.length) { return 0; }
				const v = halfToFloat(le ? rawData.readUInt16LE(off) : rawData.readUInt16BE(off));
				return Number.isFinite(v) ? v : 0;
			} else if (bitsPerSample === 16) {
				const off = i * 2;
				if (off + 2 > rawData.length) { return 0; }
				return le ? rawData.readUInt16LE(off) : rawData.readUInt16BE(off);
			} else if (bitsPerSample === 8) {
				return i < rawData.length ? rawData[i] : 0;
			}
			return 0;
		};

		let rgb: Float64Array;
		let outW: number, outH: number;

		if (fullDemosaic) {
			// Full bilinear demosaicing — full resolution output
			outW = width;
			outH = height;
			rgb = new Float64Array(outW * outH * 3);

			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const idx = y * width + x;
					const color = cfaColor[y & 1][x & 1];
					rgb[idx * 3 + color] = readSample(idx);

					for (let c = 0; c < 3; c++) {
						if (c === color) { continue; }
						let sum = 0, count = 0;
						for (let dy = -1; dy <= 1; dy++) {
							for (let dx = -1; dx <= 1; dx++) {
								const ny = y + dy, nx = x + dx;
								if (ny < 0 || ny >= height || nx < 0 || nx >= width) { continue; }
								if (cfaColor[ny & 1][nx & 1] === c) {
									sum += readSample(ny * width + nx);
									count++;
								}
							}
						}
						if (count > 0) { rgb[idx * 3 + c] = sum / count; }
					}
				}
			}
		} else {
			// Fast half-size: each 2x2 Bayer block → 1 RGB pixel
			outW = Math.floor(width / 2);
			outH = Math.floor(height / 2);
			rgb = new Float64Array(outW * outH * 3);

			for (let by = 0; by < outH; by++) {
				for (let bx = 0; bx < outW; bx++) {
					const y0 = by * 2, x0 = bx * 2;
					const vals = [
						readSample(y0 * width + x0),
						readSample(y0 * width + x0 + 1),
						readSample((y0 + 1) * width + x0),
						readSample((y0 + 1) * width + x0 + 1),
					];
					const colors = [
						cfaColor[0][0], cfaColor[0][1],
						cfaColor[1][0], cfaColor[1][1],
					];
					const ch = [0, 0, 0];
					const cnt = [0, 0, 0];
					for (let k = 0; k < 4; k++) {
						const v = vals[k];
						if (Number.isFinite(v)) {
							ch[colors[k]] += v;
							cnt[colors[k]]++;
						}
					}
					const outIdx = (by * outW + bx) * 3;
					for (let c = 0; c < 3; c++) {
						rgb[outIdx + c] = cnt[c] > 0 ? ch[c] / cnt[c] : 0;
					}
				}
			}
		}

		// Auto-expose and gamma
		const totalOut = outW * outH;
		let maxVal = 0;
		for (let i = 0; i < rgb.length; i++) {
			if (rgb[i] > maxVal) { maxVal = rgb[i]; }
		}
		if (maxVal <= 0) { maxVal = 1; }

		const scale = 1.0 / maxVal;
		const gamma = 1.0 / 2.2;

		const cfaResult = Buffer.alloc(totalOut * 3);
		for (let p = 0; p < totalOut; p++) {
			for (let c = 0; c < 3; c++) {
				let v = rgb[p * 3 + c];
				if (v < 0) { v = 0; }
				v = Math.pow(v * scale, gamma);
				cfaResult[p * 3 + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
			}
		}

		return { pixels: cfaResult, width: outW, height: outH };
	} else if (sampleFormat === 3 && bitsPerSample === 32) {
		// 32-bit float — auto-expose and gamma
		let maxVal = 0;
		const totalSamples = pixelCount * samplesPerPixel;
		for (let i = 0; i < totalSamples && (i + 1) * 4 <= rawData.length; i++) {
			const v = le ? rawData.readFloatLE(i * 4) : rawData.readFloatBE(i * 4);
			if (Number.isFinite(v) && v > maxVal) { maxVal = v; }
		}
		if (maxVal <= 0) { maxVal = 1; }

		const scale = 1.0 / maxVal;
		const gamma = 1.0 / 2.2;

		for (let p = 0; p < pixelCount; p++) {
			for (let c = 0; c < 3; c++) {
				const srcC = c < outCh ? c : 0;
				const idx = (p * samplesPerPixel + srcC) * 4;
				if (idx + 4 > rawData.length) { break; }
				let v = le ? rawData.readFloatLE(idx) : rawData.readFloatBE(idx);
				if (!Number.isFinite(v) || v < 0) { v = 0; }
				v = Math.pow(v * scale, gamma);
				result[p * 3 + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
			}
		}
	} else if (sampleFormat === 3 && bitsPerSample === 16) {
		// 16-bit half-float
		let maxVal = 0;
		const totalSamples = pixelCount * samplesPerPixel;
		for (let i = 0; i < totalSamples && (i + 1) * 2 <= rawData.length; i++) {
			const raw = le ? rawData.readUInt16LE(i * 2) : rawData.readUInt16BE(i * 2);
			const v = halfToFloat(raw);
			if (Number.isFinite(v) && v > maxVal) { maxVal = v; }
		}
		if (maxVal <= 0) { maxVal = 1; }

		const scale = 1.0 / maxVal;
		const gamma = 1.0 / 2.2;

		for (let p = 0; p < pixelCount; p++) {
			for (let c = 0; c < 3; c++) {
				const srcC = c < outCh ? c : 0;
				const idx = (p * samplesPerPixel + srcC) * 2;
				if (idx + 2 > rawData.length) { break; }
				const raw = le ? rawData.readUInt16LE(idx) : rawData.readUInt16BE(idx);
				let v = halfToFloat(raw);
				if (!Number.isFinite(v) || v < 0) { v = 0; }
				v = Math.pow(v * scale, gamma);
				result[p * 3 + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
			}
		}
	} else if (bitsPerSample === 16) {
		// 16-bit unsigned integer
		for (let p = 0; p < pixelCount; p++) {
			for (let c = 0; c < 3; c++) {
				const srcC = c < outCh ? c : 0;
				const idx = (p * samplesPerPixel + srcC) * 2;
				if (idx + 2 > rawData.length) { break; }
				const v = le ? rawData.readUInt16LE(idx) : rawData.readUInt16BE(idx);
				result[p * 3 + c] = Math.round(v / 257);
			}
		}
	} else if (bitsPerSample === 8) {
		// 8-bit unsigned integer
		for (let p = 0; p < pixelCount; p++) {
			for (let c = 0; c < 3; c++) {
				const srcC = c < outCh ? c : 0;
				const idx = p * samplesPerPixel + srcC;
				if (idx >= rawData.length) { break; }
				result[p * 3 + c] = rawData[idx];
			}
		}
	} else {
		throw new Error(
			`Unsupported sample format: bps=${bitsPerSample} sf=${sampleFormat} spp=${samplesPerPixel} in ${width}x${height} IFD.\n` +
			`All IFDs:\n${ifdInfos.map(i => '  ' + i).join('\n')}`
		);
	}

	return { pixels: result, width, height };
}

'use strict';

const assert = require('assert');
const { undoFloatPredictorForTest } = require('../out/dngDirectDecoder.js');

function encodeFloatPredictor(raw, width, height, channels, bytesPerSample) {
	const rowBytes = width * channels * bytesPerSample;
	const sampleCount = width * channels;
	const predictorStride = channels * bytesPerSample;
	const encoded = Buffer.alloc(raw.length);

	for (let y = 0; y < height; y++) {
		const rowOff = y * rowBytes;
		const temp = Buffer.alloc(rowBytes);

		for (let s = 0; s < sampleCount; s++) {
			for (let b = 0; b < bytesPerSample; b++) {
				temp[b * sampleCount + s] = raw[rowOff + s * bytesPerSample + b];
			}
		}

		for (let i = 0; i < predictorStride; i++) {
			encoded[rowOff + i] = temp[i];
		}
		for (let i = predictorStride; i < rowBytes; i++) {
			encoded[rowOff + i] = (temp[i] - temp[i - predictorStride] + 256) & 0xFF;
		}
	}

	return encoded;
}

function run() {
	const width = 3;
	const height = 2;
	const channels = 1;
	const bytesPerSample = 4;

	const raw = Buffer.from([
		0x10, 0x11, 0x12, 0x13,
		0x20, 0x21, 0x22, 0x23,
		0x30, 0x31, 0x32, 0x33,
		0x40, 0x41, 0x42, 0x43,
		0x50, 0x51, 0x52, 0x53,
		0x60, 0x61, 0x62, 0x63,
	]);

	const encoded = encodeFloatPredictor(raw, width, height, channels, bytesPerSample);
	const decoded = undoFloatPredictorForTest(encoded, width, height, channels, bytesPerSample);

	assert.deepStrictEqual(decoded, raw, 'Predictor 3 decode should round-trip multi-row data');
	console.log('float predictor regression test passed');
}

run();

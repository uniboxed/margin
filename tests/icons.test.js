import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/icons.js';

const { sniffType, toBase64, dataUrl } = globalThis.Margin.icons;
const bytes = (...v) => new Uint8Array(v);
const text = (s) => new TextEncoder().encode(s);

test('sniffType recognizes icon formats by their bytes, rejects everything else', () => {
  assert.equal(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), 'image/png');
  assert.equal(sniffType(bytes(0x00, 0x00, 0x01, 0x00, 0x01)), 'image/x-icon');
  assert.equal(sniffType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif');
  assert.equal(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffType(text('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(sniffType(text('﻿ <?xml version="1.0"?><svg/>')), 'image/svg+xml');
  assert.equal(sniffType(text('<!doctype html><title>404</title>')), null, 'HTML error page');
  assert.equal(sniffType(bytes()), null);
});

test('toBase64 / dataUrl match Node’s encoder, including large inputs', () => {
  const big = new Uint8Array(100_000).map((_, i) => i % 251);
  assert.equal(toBase64(big), Buffer.from(big).toString('base64'));
  assert.equal(dataUrl('image/png', bytes(1, 2, 3)), 'data:image/png;base64,AQID');
});

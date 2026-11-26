import assert from 'node:assert/strict';
import pngjs from 'pngjs';
import { G2, lensFrame } from '../src/g2.js';
import { startReplay } from '../src/replay.js';

const regions = lensFrame(startReplay().state).filter(({ name }) => ['status', 'spread', 'action'].includes(name));
export function glassesPixels(bytes) {
  assert.ok(bytes.length >= 33 && bytes.readUInt32BE(16) === G2.width && bytes.readUInt32BE(20) === G2.height &&
    bytes[24] === 8 && bytes[25] === 6, 'Expected a 576x288 8-bit RGBA simulator PNG');
  const png = pngjs.PNG.sync.read(bytes);
  const masks = {};
  let alpha = 0;
  for (const { name, x, y, width, height } of regions) {
    const mask = new Uint8Array(width * height);
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
      const p = ((y + dy) * png.width + x + dx) * 4;
      if (png.data[p + 3] > 0) alpha++;
      mask[dy * width + dx] = Number(png.data[p + 3] > 0 && (png.data[p] | png.data[p + 1] | png.data[p + 2]) > 0);
    }
    masks[name] = mask;
  }
  const lit = masks.status.reduce((a, b) => a + b, 0);
  assert.ok(alpha > 0 && lit >= 20 && lit < masks.status.length / 2, 'Blank or uniform glasses status region');
  return { alpha, lit, masks };
}

export function pixelDiff(a, b, ...regions) {
  let diff = 0;
  for (const region of regions) {
    const before = a.masks[region];
    const after = b.masks[region];
    for (let i = 0; i < before.length; i++) diff += Number(before[i] !== after[i]);
  }
  return diff;
}

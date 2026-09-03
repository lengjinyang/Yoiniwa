import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

// Tauri's ICO decoder uses the first frame as the runtime window icon.
// Reorder only the directory: retain every original size and encoded pixel byte.
const path = new URL('../build/yoiniwa.ico', import.meta.url);
const icon = readFileSync(path);
assert(icon.length >= 6 && icon.readUInt16LE(0) === 0 && icon.readUInt16LE(2) === 1, 'Invalid ICO header');
const count = icon.readUInt16LE(4);
const directoryEnd = 6 + count * 16;
assert(count > 0 && directoryEnd <= icon.length, 'Invalid ICO directory');
const entries = Array.from({ length: count }, (_, index) => {
  const entry = Buffer.from(icon.subarray(6 + index * 16, 22 + index * 16));
  const offset = entry.readUInt32LE(12);
  const length = entry.readUInt32LE(8);
  assert(length > 0 && offset >= directoryEnd && offset + length <= icon.length, 'Invalid ICO frame');
  return entry;
});
const area = (entry) => (entry[0] || 256) * (entry[1] || 256);
entries.sort((left, right) => area(right) - area(left));
const prepared = Buffer.from(icon);
entries.forEach((entry, index) => entry.copy(prepared, 6 + index * 16));
assert(prepared.subarray(directoryEnd).equals(icon.subarray(directoryEnd)), 'ICO pixels must not change');
if (!prepared.equals(icon)) writeFileSync(path, prepared);
console.log(`Window icon: ${entries[0][0] || 256} x ${entries[0][1] || 256}; retained ${count} frames`);

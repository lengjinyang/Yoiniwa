import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import unzipper from 'unzipper';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node create-v1-project-fixture.mjs <input.refcanvas> <output.refcanvas>');
const directory = await unzipper.Open.file(path.resolve(input));
const target = createWriteStream(path.resolve(output));
const archive = new ZipArchive({ zlib: { level: 0 } });
const completed = new Promise((resolve, reject) => {
  target.once('close', resolve); target.once('error', reject); archive.once('error', reject);
});
archive.pipe(target);
for (const entry of directory.files) {
  if (entry.path === 'manifest.json') {
    const manifest = JSON.parse((await entry.buffer()).toString('utf8'));
    archive.append(JSON.stringify({ ...manifest, version: 1 }), { name: entry.path });
  } else archive.append(entry.stream(), { name: entry.path, store: true });
}
await archive.finalize();
await completed;

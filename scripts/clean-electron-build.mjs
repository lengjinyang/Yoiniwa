import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(workspaceRoot, 'dist-electron');
await fs.rm(outputDirectory, { recursive: true, force: true });

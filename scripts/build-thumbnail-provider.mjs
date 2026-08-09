import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'build', 'thumbnail-provider', 'YoiniwaThumbnailProvider.cpp');
const outputDirectory = path.join(root, 'build', 'thumbnail-provider');
const output = path.join(outputDirectory, 'YoiniwaThumbnailProvider.dll');

if (process.platform !== 'win32') {
  console.log('Skipping Windows thumbnail provider build on this platform.');
  process.exit(0);
}

const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const installationPath = execFileSync(vswhere, [
  '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
], { encoding: 'utf8' }).trim();
if (!installationPath) throw new Error('Visual Studio C++ Build Tools are required to build the Windows thumbnail provider.');

const developerCommand = path.join(installationPath, 'Common7', 'Tools', 'VsDevCmd.bat');
await fs.mkdir(outputDirectory, { recursive: true });
await Promise.all(['YoiniwaThumbnailProvider.dll', 'YoiniwaThumbnailProvider.lib', 'YoiniwaThumbnailProvider.exp', 'YoiniwaThumbnailProvider.obj']
  .map((name) => fs.rm(path.join(outputDirectory, name), { force: true })));

const quote = String.fromCharCode(34);
const command = [
  '@echo off',
  'call ' + quote + developerCommand + quote + ' -arch=x64 -host_arch=x64 >nul',
  'if errorlevel 1 exit /b %errorlevel%',
  'cl.exe /nologo /std:c++17 /EHsc /O2 /LD /DUNICODE /D_UNICODE /Fo' + quote + path.join(outputDirectory, 'YoiniwaThumbnailProvider.obj') + quote + ' ' + quote + source + quote + ' /link /OUT:' + quote + output + quote + ' /IMPLIB:' + quote + path.join(outputDirectory, 'YoiniwaThumbnailProvider.lib') + quote,
].join('\r\n');
const batchFile = path.join(outputDirectory, 'build-thumbnail-provider.cmd');
await fs.writeFile(batchFile, command, 'utf8');
try { execFileSync('cmd.exe', ['/d', '/c', batchFile], { cwd: root, stdio: 'inherit' }); }
finally { await fs.rm(batchFile, { force: true }); }
await Promise.all(['YoiniwaThumbnailProvider.lib', 'YoiniwaThumbnailProvider.exp', 'YoiniwaThumbnailProvider.obj']
  .map((name) => fs.rm(path.join(outputDirectory, name), { force: true })));

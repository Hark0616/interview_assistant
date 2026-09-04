import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const manifestPath = path.join(projectDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) {
  throw new Error('manifest.json no declara Manifest V3.');
}

const jsFiles = new Set([
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((item) => item.js || []),
  'panelManager.js',
  'popup.js',
  'panel.js',
]);

for (const relativeFile of jsFiles) {
  if (!relativeFile) continue;
  const file = path.join(projectDir, relativeFile);
  if (!fs.existsSync(file)) throw new Error(`Falta el script declarado: ${relativeFile}`);
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`Manifest V3 válido; ${jsFiles.size} scripts declarados comprobados.`);

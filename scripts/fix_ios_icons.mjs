#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const targets = [
  path.join(repoRoot, 'src-tauri', 'icons_ios_current'),
  path.join(repoRoot, 'src-tauri', 'gen', 'apple', 'Assets.xcassets', 'AppIcon.appiconset'),
];

async function listPngs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function stripAlpha(pngPath) {
  try {
    const image = sharp(pngPath);
    const { hasAlpha } = await image.metadata();
    if (!hasAlpha) return false;
    await image
      .flatten({ background: '#ffffff' }) // remove alpha by compositing over white
      .png({ force: true })
      .toFile(pngPath + '.tmp');
    await fs.rename(pngPath + '.tmp', pngPath);
    return true;
  } catch (err) {
    console.error('Failed to process', pngPath, err.message);
    return false;
  }
}

async function main() {
  let processed = 0;
  for (const dir of targets) {
    const files = await listPngs(dir);
    for (const f of files) {
      if (await stripAlpha(f)) processed += 1;
    }
  }
  console.log(`iOS icon alpha-strip done. Files modified: ${processed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


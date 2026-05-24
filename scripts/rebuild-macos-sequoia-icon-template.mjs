#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'design', 'macos-sequoia-app-icon-template');

const canvas = { width: 2040, height: 1990 };
const measurements = {
  source: 'Template - Icon - App.psd',
  sourceCanvas: { width: 2040, height: 1990 },
  measuredFromRenderedPsd: true,
  opticalMask: {
    family: 'superellipse approximation',
    exponent: 5.2,
    note: 'The PSD uses a macOS squircle-like mask, not a full-bleed iOS rounded-square mask.',
  },
  tiles: [
    { name: '@2x 512px', x: 40, y: 260, size: 512, bodyInset: 50, exportPx: 512, points: 256, scale: '@2x' },
    { name: '@2x 256px', x: 570, y: 260, size: 256, bodyInset: 25, exportPx: 256, points: 128, scale: '@2x' },
    { name: '@2x 64px', x: 850, y: 260, size: 64, bodyInset: 6, exportPx: 64, points: 32, scale: '@2x' },
    { name: '@2x 32px', x: 1020, y: 260, size: 32, bodyInset: 2, exportPx: 32, points: 16, scale: '@2x' },
    { name: '@2x 1024px', x: 40, y: 860, size: 1024, bodyInset: 100, exportPx: 1024, points: 512, scale: '@2x' },
    { name: '@1x 256px', x: 1250, y: 260, size: 256, bodyInset: 25, exportPx: 256, points: 256, scale: '@1x' },
    { name: '@1x 128px', x: 1526, y: 260, size: 128, bodyInset: 12, exportPx: 128, points: 128, scale: '@1x' },
    { name: '@1x 32px', x: 1702, y: 260, size: 32, bodyInset: 2, exportPx: 32, points: 32, scale: '@1x' },
    { name: '@1x 16px', x: 1862, y: 260, size: 16, bodyInset: 1, exportPx: 16, points: 16, scale: '@1x' },
    { name: '@1x 512px', x: 1250, y: 860, size: 512, bodyInset: 50, exportPx: 512, points: 512, scale: '@1x' },
  ],
};

function fmt(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function superellipsePath(x, y, width, height, exponent = 5.2, steps = 128) {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const points = [];

  for (let i = 0; i < steps; i += 1) {
    const theta = (Math.PI * 2 * i) / steps;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const px = cx + rx * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const py = cy + ry * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    points.push([fmt(px), fmt(py)]);
  }

  return `M ${points.map(([px, py]) => `${px} ${py}`).join(' L ')} Z`;
}

function checkerPattern(id, size = 16) {
  return `
    <pattern id="${id}" width="${size * 2}" height="${size * 2}" patternUnits="userSpaceOnUse">
      <rect width="${size * 2}" height="${size * 2}" fill="#d8d8d8"/>
      <rect width="${size}" height="${size}" fill="#cfcfcf"/>
      <rect x="${size}" y="${size}" width="${size}" height="${size}" fill="#cfcfcf"/>
    </pattern>`;
}

function textBlock(x, y, lines, size = 18, weight = 600) {
  const tspans = lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : size * 1.25}">${line}</tspan>`)
    .join('');
  return `<text x="${x}" y="${y}" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="#000">${tspans}</text>`;
}

function tileGroup(tile, options = {}) {
  const { showLabel = true, shadow = true, idPrefix = 'tile' } = options;
  const body = tile.size - tile.bodyInset * 2;
  const bodyX = tile.x + tile.bodyInset;
  const bodyY = tile.y + tile.bodyInset;
  const pathData = superellipsePath(bodyX, bodyY, body, body, measurements.opticalMask.exponent);
  const patternId = `${idPrefix}-checker-${tile.exportPx}-${tile.x}-${tile.y}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const shadowFilter = shadow ? `filter="url(#icon-shadow)"` : '';

  return `
    <g id="${tile.name.replace(/\s+/g, '-')}">
      <defs>${checkerPattern(patternId, tile.size >= 512 ? 16 : Math.max(2, Math.round(tile.size / 32)))}</defs>
      ${showLabel ? textBlock(tile.x, tile.y - 42, [`${tile.exportPx}px x ${tile.exportPx}px`, `(${tile.points}pt x ${tile.points}pt ${tile.scale})`], Math.max(11, Math.min(18, tile.size / 18)), 500) : ''}
      <rect x="${tile.x}" y="${tile.y}" width="${tile.size}" height="${tile.size}" fill="url(#${patternId})"/>
      <rect x="${tile.x}" y="${tile.y}" width="${tile.size}" height="${tile.size}" fill="none" stroke="#8f8f8f" stroke-opacity="0.22"/>
      <rect x="${bodyX}" y="${bodyY}" width="${body}" height="${body}" fill="none" stroke="#1677ff" stroke-width="${Math.max(1, tile.size / 256)}" stroke-dasharray="${Math.max(3, tile.size / 64)} ${Math.max(3, tile.size / 64)}" opacity="0.72"/>
      <path d="${pathData}" fill="#fff" ${shadowFilter}/>
      <path d="${pathData}" fill="none" stroke="#111" stroke-opacity="0.08" stroke-width="${Math.max(1, tile.size / 256)}"/>
      <line x1="${tile.x + tile.size / 2}" y1="${tile.y}" x2="${tile.x + tile.size / 2}" y2="${tile.y + tile.size}" stroke="#1677ff" stroke-opacity="0.22"/>
      <line x1="${tile.x}" y1="${tile.y + tile.size / 2}" x2="${tile.x + tile.size}" y2="${tile.y + tile.size / 2}" stroke="#1677ff" stroke-opacity="0.22"/>
    </g>`;
}

function fullTemplateSvg() {
  const groups = measurements.tiles.map((tile) => tileGroup(tile)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="icon-shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="12" stdDeviation="10" flood-color="#000" flood-opacity="0.24"/>
    </filter>
  </defs>
  <rect width="${canvas.width}" height="${canvas.height}" fill="#dcdcdc"/>
  ${textBlock(39, 60, ['App Icons'], 40, 700)}
  ${textBlock(39, 90, ['Select File > Generator > Image Assets to export assets'], 16, 500).replace('fill="#000"', 'fill="#707070"')}
  ${textBlock(1734, 60, ['macOS Sequoia'], 36, 700)}
  ${textBlock(40, 180, ['@2x'], 40, 500)}
  ${textBlock(1220, 180, ['@1x'], 40, 500)}
  ${groups}
  ${textBlock(38, 1970, ['Rebuilt SVG helper based on measured geometry from Apple macOS Sequoia Photoshop production template. Not an official Apple file.'], 15, 500).replace('fill="#000"', 'fill="#707070"')}
</svg>
`;
}

function masterSvg() {
  const tile = { name: 'macOS master 1024px', x: 0, y: 0, size: 1024, bodyInset: 100, exportPx: 1024, points: 512, scale: '@2x' };
  const body = tile.size - tile.bodyInset * 2;
  const pathData = superellipsePath(tile.bodyInset, tile.bodyInset, body, body, measurements.opticalMask.exponent);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${checkerPattern('checker', 16)}
    <clipPath id="macos-icon-mask">
      <path d="${pathData}"/>
    </clipPath>
  </defs>
  <rect width="1024" height="1024" fill="url(#checker)"/>
  <rect x="0" y="0" width="1024" height="1024" fill="none" stroke="#111" stroke-opacity="0.35"/>
  <rect x="100" y="100" width="824" height="824" fill="none" stroke="#1677ff" stroke-width="4" stroke-dasharray="16 16"/>
  <path d="${pathData}" fill="#fff" fill-opacity="0.9"/>
  <path d="${pathData}" fill="none" stroke="#111" stroke-opacity="0.16" stroke-width="2"/>
  <line x1="512" y1="0" x2="512" y2="1024" stroke="#1677ff" stroke-opacity="0.35"/>
  <line x1="0" y1="512" x2="1024" y2="512" stroke="#1677ff" stroke-opacity="0.35"/>
  <text x="24" y="48" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', Arial, sans-serif" font-size="24" font-weight="600" fill="#111">macOS app icon master: 1024px canvas</text>
  <text x="24" y="84" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', Arial, sans-serif" font-size="18" fill="#333">Optical body: 824px, inset: 100px each side</text>
</svg>
`;
}

function readme() {
  return `# macOS Sequoia App Icon SVG Template

This folder contains a Figma-friendly SVG rebuild of Apple's macOS Sequoia Photoshop production template for app icons.

Files:

- \`macos-sequoia-app-icon-template.svg\`: full production-board layout rebuilt as vector SVG.
- \`macos-sequoia-app-icon-master-1024.svg\`: focused 1024px master canvas with the measured macOS icon body and guides.
- \`measurements.json\`: measured tile positions and optical body insets from the rendered PSD.

Measured geometry from \`Template - Icon - App.psd\`:

- PSD canvas: \`2040 x 1990\`
- 1024 export tile: positioned at \`x=40, y=860\`
- 1024 tile optical icon body: \`824 x 824\`
- 1024 tile optical inset: \`100px\` on each side
- 512 tile optical icon body: \`412 x 412\`
- 512 tile optical inset: \`50px\` on each side

Usage in Figma:

1. Drag \`macos-sequoia-app-icon-master-1024.svg\` into Figma.
2. Put the icon artwork inside the blue dashed optical body box, not edge-to-edge on the 1024 canvas.
3. Export the macOS source from the full 1024 canvas with transparency.
4. Use a separate iOS source if you need a full-bleed iOS AppIcon.

Important: this is a clean-room helper rebuilt from measured template geometry. It is not an official Apple file and does not replace Apple's original production templates.
`;
}

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'macos-sequoia-app-icon-template.svg'), fullTemplateSvg());
await fs.writeFile(path.join(outDir, 'macos-sequoia-app-icon-master-1024.svg'), masterSvg());
await fs.writeFile(path.join(outDir, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
await fs.writeFile(path.join(outDir, 'README.md'), readme());
await sharp(path.join(outDir, 'macos-sequoia-app-icon-template.svg'), { density: 144 })
  .resize({ width: 1200 })
  .png()
  .toFile(path.join(outDir, 'template-preview.png'));
await sharp(path.join(outDir, 'macos-sequoia-app-icon-master-1024.svg'))
  .png()
  .toFile(path.join(outDir, 'master-1024-preview.png'));

console.log(`Wrote ${path.relative(repoRoot, outDir)}`);

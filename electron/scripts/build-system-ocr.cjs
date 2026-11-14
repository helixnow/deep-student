const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');

module.exports = function buildSystemOcr(output, arch) {
  if (process.platform !== 'darwin') throw new Error('Building macOS Vision OCR requires macOS');
  mkdirSync(dirname(output), { recursive: true });
  execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos11.0`,
    join(__dirname, '../native/system-ocr.swift'), '-o', output], { stdio: 'inherit' });
};

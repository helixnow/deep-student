// 用法：node scripts/stills.mjs 1.0 2.4 3.8 …（单位：脚本秒，与场景代码里的时间一致）→ out/stills/t-XX.XX.png
// STILL_DIR=out/xxx 换输出目录；STILL_SCALE=1 出整幅（默认 0.5）。
const PACE = 2; // 与 src/lib/time.ts 的 PACE 保持一致
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webpackOverride } from '../webpack-override.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const times = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
if (times.length === 0) {
  console.error('usage: node scripts/stills.mjs <seconds...>');
  process.exit(1);
}
const scale = Number(process.env.STILL_SCALE ?? 0.5);
const outDir = process.env.STILL_DIR ? path.resolve(process.env.STILL_DIR) : path.join(root, 'out', 'stills');
fs.mkdirSync(outDir, { recursive: true });

const serveUrl = await bundle({
  entryPoint: path.join(root, 'src/index.ts'),
  webpackOverride,
  publicDir: path.join(root, 'public'),
});
const browserExecutable = process.env.REMOTION_CHROME ?? null;
const chromiumOptions = { gl: 'angle' };
const composition = await selectComposition({ serveUrl, id: 'DeepStudentPV', browserExecutable, chromiumOptions });
for (const s of times) {
  const frame = Math.min(composition.durationInFrames - 1, Math.round(s * PACE * composition.fps));
  const output = path.join(outDir, `t-${s.toFixed(2)}.png`);
  await renderStill({ composition, serveUrl, frame, output, scale, browserExecutable, chromiumOptions });
  console.log(output);
}

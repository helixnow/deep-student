// 用法：node scripts/check.mjs [--out out/check] [--scale 0.5] [--compare <目录>] <合成:帧[,帧…]>…
// 例：node scripts/check.mjs --out out/exam AppUiGallery:10,11 Insert-exam-sprint:0,90,180 DeepStudentPV:600
// 打一次包，按服务器上的基线配置（swangle 软件渲染、半幅）渲出指定帧 → <out>/<合成>-<帧>.png。
// --compare：与该目录里的同名文件逐字节比对。任何一帧渲染失败或比对不一致都以非零退出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// webpack-override.mjs 在加载时按 cwd 定位工程，先切目录再导入
process.chdir(root);
const { webpackOverride } = await import('../webpack-override.mjs');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const outDir = path.resolve(option('--out', 'out/check'));
const scale = Number(option('--scale', '0.5'));
const compareDir = option('--compare', null);
const targets = args.map((arg) => {
  const [id, frames = '0'] = arg.split(':');
  return [id, frames.split(',').map(Number)];
});
if (targets.length === 0) {
  console.error('usage: node scripts/check.mjs [--out dir] [--scale n] [--compare dir] <composition:frame[,frame…]>…');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const tmp = path.resolve(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir());
const bundleDir = fs.mkdtempSync(path.join(tmp, 'pv-bundle-'));
const started = Date.now();
const serveUrl = await bundle({
  entryPoint: path.join(root, 'src/index.ts'),
  outDir: bundleDir,
  webpackOverride,
  publicDir: path.join(root, 'public'),
  enableCaching: false,
});
const bundled = fs.readdirSync(bundleDir);
const megabytes = bundled.reduce((sum, file) => sum + fs.statSync(path.join(bundleDir, file)).size, 0) / 1048576;
console.log(`bundle: ${bundled.length} files, ${megabytes.toFixed(0)} MB, ${Math.round((Date.now() - started) / 1000)}s`);

const browserExecutable = process.env.REMOTION_CHROME ?? null;
const chromiumOptions = { gl: 'swangle' };
let failed = 0;
for (const [id, frames] of targets) {
  let composition;
  try {
    composition = await selectComposition({ serveUrl, id, browserExecutable, chromiumOptions });
  } catch (error) {
    failed += frames.length;
    console.error(`FAIL ${id}: ${error instanceof Error ? error.message : error}`);
    continue;
  }
  for (const frame of frames) {
    const name = `${id}-${String(frame).padStart(4, '0')}.png`;
    const output = path.join(outDir, name);
    try {
      await renderStill({ composition, serveUrl, frame, output, scale, browserExecutable, chromiumOptions });
      let verdict = '';
      if (compareDir) {
        const reference = path.join(compareDir, name);
        if (!fs.existsSync(reference)) verdict = ' (no reference)';
        else if (fs.readFileSync(reference).equals(fs.readFileSync(output))) verdict = ' identical';
        else {
          verdict = ' DIFFERS';
          failed += 1;
        }
      }
      console.log(`ok ${output}${verdict}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${id}:${frame}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
fs.rmSync(bundleDir, { recursive: true, force: true });
console.log(failed === 0 ? 'check: all frames ok' : `check: ${failed} frame(s) failed`);
process.exit(failed === 0 ? 0 : 1);

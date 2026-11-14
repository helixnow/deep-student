#!/usr/bin/env node
/**
 * 离线混音检查：把 src/audio/Soundtrack.tsx 解析出的音效 cue（文件、帧、音量）按帧对齐叠到 score.wav × SCORE_GAIN 上，
 * 分轨测响度，用来校准各层级音量，不必每次都跑 Remotion 渲染。
 *
 *   node scripts/audio/sfx/mixcheck.mjs [--wav out.wav] [--from s] [--to s]   （秒为成片秒）
 *
 * 输出：缺失文件、各层 cue 数与密度、配乐 / 音效 / 总混的积分响度与真峰值、每层 cue 相对周围配乐的响度差。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as D from './dsp.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const FPS = 60;
const AUDIO = path.join(D.ROOT, 'public', 'audio');
const TMP = path.join(D.ROOT, '.cache', 'sfx', 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const named = new Map();
const scan = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (/\.tsx?$/.test(e.name)) {
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        if (/^[./]/.test(m[2])) continue;
        const set = named.get(m[2]) ?? new Set();
        for (const raw of m[1].split(',')) {
          const n = raw.trim();
          if (n && !n.startsWith('type ')) set.add(n.split(/\s+as\s+/)[0].trim());
        }
        named.set(m[2], set);
      }
    }
  }
};
scan(path.join(D.ROOT, 'src'));
scan(path.join(D.ROOT, '..', 'src'));
named.set('react/jsx-runtime', new Set(['jsx', 'jsxs', 'Fragment']));

const bundle = path.join(TMP, 'soundtrack.bundle.mjs');
await build({
  stdin: {
    contents: "export { SFX_CUES, SCORE_GAIN } from './src/audio/Soundtrack';",
    resolveDir: D.ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  outfile: bundle,
  logLevel: 'error',
  plugins: [
    {
      name: 'stub-externals',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (a) => (a.path.startsWith('@app') ? undefined : { path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents:
            'const f = new Proxy(function () { return f; }, { get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? [][Symbol.iterator] : f) });' +
            'export default f;' +
            [...(named.get(a.path) ?? [])].map((n) => `export const ${n} = f;`).join(''),
          loader: 'js',
        }));
        b.onResolve({ filter: /\.\w+$/ }, (a) => (/\.(tsx?|m?js|json)$/.test(a.path) ? undefined : { path: a.path, namespace: 'asset' }));
        b.onLoad({ filter: /.*/, namespace: 'asset' }, () => ({ contents: 'export default ""', loader: 'js' }));
      },
    },
  ],
});
const { SFX_CUES: allCues, SCORE_GAIN } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);

const from = Number(opt('--from', 0));
const to = Number(opt('--to', Infinity));
const cues = allCues.filter((c) => c.frame / FPS >= from && c.frame / FPS < to);

const missing = [...new Set(allCues.map((c) => c.file))].filter((f) => !fs.existsSync(path.join(AUDIO, `${f}.wav`)));
console.log(`cue 总数 ${allCues.length}（检查区间内 ${cues.length}）· 引用文件 ${new Set(allCues.map((c) => c.file)).size} 个 · 缺失 ${missing.length ? missing.join(', ') : '无'}`);
if (missing.length) process.exitCode = 1;

const tiers = ['hero', 'cue', 'ui', 'tex'];
const byTier = Object.fromEntries(tiers.map((t) => [t, allCues.filter((c) => c.tier === t)]));
console.log('各层 cue 数：' + tiers.map((t) => `${t} ${byTier[t].length}`).join(' · '));
const gaps = allCues.slice(1).map((c, i) => (c.frame - allCues[i].frame) / FPS);
const dense = gaps.filter((g) => g < 0.12).length;
let maxPerSec = 0;
for (const c of allCues) maxPerSec = Math.max(maxPerSec, allCues.filter((d) => d.frame >= c.frame && d.frame < c.frame + FPS).length);
console.log(`相邻间隔 < 120 ms（成片）${dense} 处 · 任意 1 s 内最多 ${maxPerSec} 声`);
const fam = {};
for (const c of allCues) fam[c.file] = (fam[c.file] ?? 0) + 1;
console.log('文件使用次数：' + Object.entries(fam).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}×${n}`).join(' '));

const score = D.decode(path.join(AUDIO, 'score.wav'));
const t0 = Math.round(from * D.SR);
const t1 = Math.min(D.len(score), Number.isFinite(to) ? Math.round(to * D.SR) : D.len(score));
const N = t1 - t0;
const music = score.map((c) => c.slice(t0, t1).map((v) => v * SCORE_GAIN));
const sfx = [new Float32Array(N), new Float32Array(N)];
const cache = new Map();
for (const c of cues) {
  if (!cache.has(c.file)) cache.set(c.file, D.decode(path.join(AUDIO, `${c.file}.wav`)));
  const src = cache.get(c.file);
  const at = Math.round((c.frame / FPS) * D.SR) - t0;
  for (let k = 0; k < 2; k++) {
    const s = src[k];
    const d = sfx[k];
    for (let i = 0; i < s.length && at + i < N; i++) if (at + i >= 0) d[at + i] += s[i] * c.volume;
  }
}
const total = [0, 1].map((k) => music[k].map((v, i) => v + sfx[k][i]));

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
console.log(`\n区间 ${fmt(from)}–${fmt(t1 / D.SR)} s（成片秒）`);
console.log(`配乐 × ${SCORE_GAIN}  积分 ${fmt(D.integrated(music))} LUFS · 真峰值 ${fmt(D.truePeak(music))} dBTP`);
console.log(`音效            积分 ${fmt(D.integrated(sfx))} LUFS · 真峰值 ${fmt(D.truePeak(sfx))} dBTP`);
console.log(`总混            积分 ${fmt(D.integrated(total))} LUFS · 真峰值 ${fmt(D.truePeak(total))} dBTP · 最大短期 ${fmt(D.shortTermMax(total))} LUFS`);

let pk = 0;
let pkAt = 0;
for (const c of total) for (let i = 0; i < N; i++) if (Math.abs(c[i]) > pk) [pk, pkAt] = [Math.abs(c[i]), i];
const near = cues.filter((c) => Math.abs(c.frame / FPS - from - pkAt / D.SR - 0.05) < 0.3).map((c) => c.file);
console.log(`总混样点峰值 ${fmt(D.db(pk))} dBFS @ ${fmt(from + pkAt / D.SR)} s（附近音效：${near.join(', ') || '无'}）`);

const slice = (ch, a, b) => ch.map((c) => c.slice(Math.max(0, Math.round(a * D.SR)), Math.min(N, Math.round(b * D.SR))));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
console.log('\n各层 cue 在混音里的事件响度（hero 取 2 s 窗、卡片扇 1.2 s，其余 0.25 s），以及相对周围配乐最大瞬时响度的差：');
for (const t of tiers) {
  const rows = cues
    .filter((c) => c.tier === t)
    .map((c) => {
      const s = c.frame / FPS - from;
      const win = t === 'hero' ? 2 : c.file.startsWith('cards') ? 1.2 : 0.25;
      const ev = D.eventLoudness(slice(sfx, s, s + win));
      const bed = D.momentaryMax(slice(music, s - 0.3, s + win + 0.05));
      return { c, ev, rel: ev - bed };
    })
    .filter((r) => Number.isFinite(r.ev));
  if (!rows.length) continue;
  if (args.includes('--list') && opt('--list') === t)
    for (const r of rows) console.log(`    ${(r.c.frame / FPS).toFixed(2).padStart(7)} s  ${r.c.file.padEnd(14)} vol ${r.c.volume.toFixed(3)}  事件 ${fmt(r.ev)}  相对 ${fmt(r.rel)}`);
  const rel = rows.map((r) => r.rel).filter(Number.isFinite);
  console.log(
    `  ${t.padEnd(4)}  事件响度中位 ${fmt(median(rows.map((r) => r.ev)))} LUFS · 相对配乐 中位 ${fmt(median(rel))} LU（最小 ${fmt(Math.min(...rel))}，最大 ${fmt(Math.max(...rel))}）`,
  );
}

const wav = opt('--wav');
if (wav) {
  D.writeWav(path.resolve(wav), total);
  console.log(`\n→ ${wav}`);
}

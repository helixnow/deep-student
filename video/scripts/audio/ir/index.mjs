// 开源脉冲响应加载：const ir = loadIR('room'); convolve(L, R, ir, { wet: 0.3, preDelayMs: 12 })
// 文件由 node scripts/audio/fetch-samples.mjs 下载到 .cache/ir/（OpenAIR，CC BY 4.0，需署名，见 IR_INFO[name].credit）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IRS, IR_LICENSE } from '../instruments/catalog.mjs';
import { readWav, resampleSinc } from '../instruments/dsp.mjs';

export { convolve } from './convolve.mjs';

const SR = 48000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const irDir = path.join(root, '.cache', 'ir');

/** { room: { desc, credit, license, file }, wood: …, hall: … } */
export const IR_INFO = Object.fromEntries(IRS.map((i) => [i.name, { desc: i.desc, credit: i.credit, license: IR_LICENSE, file: i.file, url: i.url }]));
export const IR_NAMES = IRS.map((i) => i.name);

const cache = new Map();

/** Schroeder 反向积分估算 RT60（取 -5 到 -25 dB 段外推，T20）。 */
export function estimateRT60(x, sr = SR) {
  const e = new Float64Array(x.length);
  let acc = 0;
  for (let i = x.length - 1; i >= 0; i--) {
    acc += x[i] * x[i];
    e[i] = acc;
  }
  const db = (i) => 10 * Math.log10(e[i] / e[0] + 1e-30);
  let i5 = -1;
  let i25 = -1;
  for (let i = 0; i < x.length; i++) {
    if (i5 < 0 && db(i) <= -5) i5 = i;
    if (db(i) <= -25) { i25 = i; break; }
  }
  if (i5 < 0 || i25 < 0) return NaN;
  return ((i25 - i5) / sr) * 3;
}

/**
 * 读取脉冲响应，返回 { L, R, sr: 48000, name, rt60, credit }。
 * opts.direct: 'remove'（默认，去掉直达声，只留反射与混响，适合发送式混响）| 'keep'
 * opts.maxSec: 截断长度（默认 4 秒，末尾淡出）
 * 归一化：两声道能量和 = 1，白噪声过卷积后 RMS 大致不变。
 */
export function loadIR(name, { direct = 'remove', maxSec = 4 } = {}) {
  const key = `${name}|${direct}|${maxSec}`;
  if (cache.has(key)) return cache.get(key);
  const info = IR_INFO[name];
  if (!info) throw new Error(`未知 IR "${name}"（可选：${IR_NAMES.join(' / ')}）`);
  const file = path.join(irDir, info.file);
  if (!fs.existsSync(file)) throw new Error(`IR 未下载：${file}（运行 node scripts/audio/fetch-samples.mjs）`);
  const { sr, channels } = readWav(fs.readFileSync(file));
  let ch = channels.length >= 2 ? channels.slice(0, 2) : [channels[0], channels[0]];
  if (sr !== SR) {
    const step = sr / SR;
    ch = ch.map((c) => resampleSinc(c, step, Math.floor(c.length / step), { half: 24 }));
  }
  // 直达声位置 = 绝对值峰值；从峰值前 1 ms 开始
  let pk = 0;
  let at = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > pk) [pk, at] = [Math.abs(c[i]), i];
  const start = Math.max(0, at - Math.round(0.001 * SR));
  const len = Math.min(ch[0].length - start, Math.round(maxSec * SR));
  ch = ch.map((c) => c.slice(start, start + len));
  // 去直流
  for (const c of ch) {
    let m = 0;
    for (let i = 0; i < c.length; i++) m += c[i];
    m /= c.length;
    for (let i = 0; i < c.length; i++) c[i] -= m;
  }
  if (direct === 'remove') {
    const d0 = Math.round(0.0025 * SR);
    const d1 = Math.round(0.007 * SR);
    for (const c of ch) for (let i = 0; i < Math.min(d1, c.length); i++) c[i] *= i < d0 ? 0 : 0.5 - 0.5 * Math.cos((Math.PI * (i - d0)) / (d1 - d0));
  }
  const fo = Math.min(Math.round(0.3 * SR), len >> 2);
  for (const c of ch) for (let i = 0; i < fo; i++) c[len - 1 - i] *= (i / fo) ** 2;
  let energy = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) energy += c[i] * c[i];
  const g = 1 / Math.sqrt(energy / 2);
  for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= g;
  const ir = { L: ch[0], R: ch[1], sr: SR, name, rt60: estimateRT60(ch[0]), credit: info.credit, license: IR_LICENSE };
  cache.set(key, ir);
  return ir;
}

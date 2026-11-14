// 纯 JS 分块 FFT 卷积（离线 overlap-add）。立体声输入与立体声 IR：outL = inL ⊛ irL，outR = inR ⊛ irR。
// 两个声道打包成一个复数 FFT（L 实部、R 虚部），每块只做一次正变换和一次逆变换。
//
// convolve(inL, inR, ir, { wet = 1, dry = 0, preDelayMs = 0, block = 0 })
//   ir: { L: Float32Array, R: Float32Array }（48 kHz；loadIR() 的返回值）
//   返回 { L, R }，长度 = 输入长度 + 预延迟 + IR 长度 - 1；dry 为原信号直通增益。
import { fft } from '../instruments/dsp.mjs';

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

export function convolve(inL, inR, ir, { wet = 1, dry = 0, preDelayMs = 0, block = 0, sr = 48000 } = {}) {
  inR = inR ?? inL;
  const irL = ir.L;
  const irR = ir.R ?? ir.L;
  const M = Math.max(irL.length, irR.length);
  const pre = Math.round((preDelayMs / 1000) * sr);
  const n = inL.length;
  const outLen = n + pre + M - 1;
  const L = new Float32Array(outLen);
  const R = new Float32Array(outLen);
  if (dry) for (let i = 0; i < n; i++) { L[i] += inL[i] * dry; R[i] += inR[i] * dry; }
  if (!wet || n === 0) return { L, R };

  // 块长：IR 较长时取与 IR 同量级，FFT 尺寸 = 2 的幂 ≥ B + M - 1
  const B = block || Math.max(4096, nextPow2(M) >> 0);
  const N = nextPow2(B + M - 1);
  // IR 频谱（同样打包：irL 实部、irR 虚部，再拆开）
  const hr = new Float64Array(N);
  const hi = new Float64Array(N);
  for (let i = 0; i < irL.length; i++) hr[i] = irL[i];
  for (let i = 0; i < irR.length; i++) hi[i] = irR[i];
  fft(hr, hi);
  const HLr = new Float64Array(N);
  const HLi = new Float64Array(N);
  const HRr = new Float64Array(N);
  const HRi = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const j = (N - k) % N;
    // 拆分两个实信号的频谱
    HLr[k] = 0.5 * (hr[k] + hr[j]);
    HLi[k] = 0.5 * (hi[k] - hi[j]);
    HRr[k] = 0.5 * (hi[k] + hi[j]);
    HRi[k] = -0.5 * (hr[k] - hr[j]);
  }
  const xr = new Float64Array(N);
  const xi = new Float64Array(N);
  for (let s = 0; s < n; s += B) {
    const len = Math.min(B, n - s);
    xr.fill(0);
    xi.fill(0);
    for (let i = 0; i < len; i++) {
      xr[i] = inL[s + i];
      xi[i] = inR[s + i];
    }
    fft(xr, xi);
    // Y = XL·HL + i·XR·HR，其中 XL、XR 由打包频谱拆出
    const yr = new Float64Array(N);
    const yi = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const j = (N - k) % N;
      const XLr = 0.5 * (xr[k] + xr[j]);
      const XLi = 0.5 * (xi[k] - xi[j]);
      const XRr = 0.5 * (xi[k] + xi[j]);
      const XRi = -0.5 * (xr[k] - xr[j]);
      const ALr = XLr * HLr[k] - XLi * HLi[k];
      const ALi = XLr * HLi[k] + XLi * HLr[k];
      const ARr = XRr * HRr[k] - XRi * HRi[k];
      const ARi = XRr * HRi[k] + XRi * HRr[k];
      yr[k] = ALr - ARi;
      yi[k] = ALi + ARr;
    }
    fft(yr, yi, true);
    const o = s + pre;
    const m = Math.min(N, len + M - 1, outLen - o);
    for (let i = 0; i < m; i++) {
      L[o + i] += yr[i] * wet;
      R[o + i] += yi[i] * wet;
    }
  }
  return { L, R };
}

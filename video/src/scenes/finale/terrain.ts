/**
 * 收尾「知识地形」的高度场：JS 与 GLSL 共用同一个解析函数，
 * 网格位移、逐像素等高线、山头标注和那一页纸的高度因此严格一致。
 * 坐标：地面是 XY 平面，Z 朝上；教材第 134 页平放在原点那座山的山顶。
 *
 * 高度 = 山体包络（若干椭圆高斯，决定每座山在哪、多高）× 脊状分形噪声（山脊与冲沟），
 * 原点附近噪声淡出，山顶保持平整。
 */

import { FN } from './beats';

export type Bump = {
  /** 山顶在地面上的位置（未扭曲坐标） */
  x: number;
  y: number;
  /** 高度 */
  h: number;
  /** 半径 */
  s: number;
  /** 椭圆长轴方向（弧度）与短长轴比 */
  rot?: number;
  asp?: number;
  /** 2 = 高斯，越大山顶越平 */
  pow?: number;
};

export type NamedPeak = Bump & { name: string; count: number };

const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 第一座是教材这一页所在的主题，山顶做平，纸能稳稳平放。 */
export const NAMED: NamedPeak[] = [
  { name: '微分中值定理', count: 386, x: 0, y: 0, h: 4.4, s: 3.5, pow: 3.4 },
  { name: '雅思写作', count: 133, x: -10, y: 8, h: 4.2, s: 4.0, rot: 0.6, asp: 0.7 },
  { name: '大模型与数学证明', count: 52, x: 11, y: 11, h: 5.4, s: 4.8, rot: -0.4, asp: 0.75 },
  { name: '线性代数', count: 241, x: -19, y: 23, h: 7.4, s: 6.6, rot: 0.9, asp: 0.62 },
  { name: '概率论', count: 168, x: 21, y: 28, h: 7.0, s: 6.2, rot: -0.7, asp: 0.7 },
  { name: '机器学习', count: 152, x: 2, y: 39, h: 9.6, s: 8.2, rot: 0.15, asp: 0.68 },
  { name: '有机化学', count: 176, x: -31, y: 45, h: 8.6, s: 7.8, rot: 1.1, asp: 0.66 },
  { name: '考研英语', count: 214, x: 34, y: 48, h: 7.6, s: 7.6, rot: -1.0, asp: 0.7 },
];

/** 山脊与台地：把主峰连成连绵的山系，谷底也不是一马平川。 */
const RIDGES: Bump[] = [
  { x: 0, y: 26, h: 1.6, s: 34, asp: 0.8 },
  { x: -14, y: 15, h: 2.8, s: 3.6, rot: 0.8, asp: 0.45 },
  { x: -4, y: 18, h: 2.4, s: 3.4, rot: 0.2, asp: 0.5 },
  { x: 15, y: 20, h: 3.2, s: 3.8, rot: -0.9, asp: 0.45 },
  { x: -25, y: 34, h: 4.8, s: 5.0, rot: 0.9, asp: 0.45 },
  { x: -9, y: 32, h: 4.4, s: 4.6, rot: 0.4, asp: 0.5 },
  { x: 11, y: 34, h: 5.0, s: 4.8, rot: -0.5, asp: 0.45 },
  { x: 28, y: 38, h: 4.6, s: 4.8, rot: -0.9, asp: 0.5 },
  { x: -17, y: 52, h: 6.2, s: 6.4, rot: 0.3, asp: 0.5 },
  { x: 18, y: 54, h: 6.6, s: 6.6, rot: -0.3, asp: 0.5 },
  { x: 2, y: 60, h: 7.4, s: 8.4, rot: 0.0, asp: 0.45 },
  { x: -42, y: 60, h: 6.6, s: 9.0, rot: 0.6, asp: 0.6 },
  { x: 44, y: 64, h: 7.0, s: 9.0, rot: -0.6, asp: 0.6 },
  { x: -7, y: -10, h: 1.6, s: 3.8, rot: 0.3, asp: 0.6 },
  { x: 10, y: -7, h: 1.9, s: 3.4, rot: -0.5, asp: 0.6 },
];

/** 散落的小丘：固定种子，避开主峰山顶。 */
const HILLS: Bump[] = (() => {
  const r = mulberry(20261002);
  const out: Bump[] = [];
  let guard = 0;
  while (out.length < 26 && guard++ < 2000) {
    const x = (r() - 0.5) * 96;
    const y = -22 + r() * 90;
    if (Math.hypot(x, y) < 7) continue;
    if (NAMED.some((p) => Math.hypot(p.x - x, p.y - y) < p.s)) continue;
    const far = Math.min(1, Math.max(0, (y + 10) / 50));
    out.push({ x, y, h: 1 + r() * (1.6 + far * 3), s: 1.8 + r() * (1.6 + far * 1.8), rot: r() * Math.PI, asp: 0.55 + r() * 0.4 });
  }
  return out;
})();

export const BUMPS: Bump[] = [...NAMED, ...RIDGES, ...HILLS];
export const NB = BUMPS.length;

/** 低频扭曲：让山体轮廓有天然的曲折，而不是一个个正椭圆。 */
const wx = (x: number, y: number) => 1.1 * Math.sin(0.21 * y + 1.7) + 0.55 * Math.sin(0.47 * y - 0.8 + 0.3 * x);
const wy = (x: number, y: number) => 1.1 * Math.cos(0.19 * x - 0.4) + 0.55 * Math.cos(0.43 * x + 2.1 - 0.2 * y);
export const warp = (x: number, y: number): [number, number] => [x + wx(x, y), y + wy(x, y)];

/** 山体中心放在扭曲空间里，山顶就正好落在声明的 (x, y)。 */
export const BUMP_UNIFORMS = (() => {
  const a: number[] = [];
  const b: number[] = [];
  for (const p of BUMPS) {
    const [cx, cy] = warp(p.x, p.y);
    const rot = p.rot ?? 0;
    a.push(cx, cy, p.h, p.s);
    b.push(Math.cos(rot), Math.sin(rot), p.asp ?? 1, (p.pow ?? 2) * 0.5);
  }
  return { a, b };
})();

// ── 2D simplex 噪声（Ashima / Gustavson 版，与下方 GLSL 逐行对应） ──
const mod289 = (x: number) => x - Math.floor(x * (1 / 289)) * 289;
const permute = (x: number) => mod289((x * 34 + 10) * x);
const fract = (x: number) => x - Math.floor(x);
const C0 = 0.211324865405187;
const C1 = 0.366025403784439;
const C2 = -0.577350269189626;
const C3 = 0.024390243902439;
export const snoise = (vx: number, vy: number) => {
  const s = (vx + vy) * C1;
  let ix = Math.floor(vx + s);
  let iy = Math.floor(vy + s);
  const t = (ix + iy) * C0;
  const x0x = vx - ix + t;
  const x0y = vy - iy + t;
  const i1x = x0x > x0y ? 1 : 0;
  const i1y = 1 - i1x;
  const x1x = x0x + C0 - i1x;
  const x1y = x0y + C0 - i1y;
  const x2x = x0x + C2;
  const x2y = x0y + C2;
  ix = mod289(ix);
  iy = mod289(iy);
  const p0 = permute(permute(iy) + ix);
  const p1 = permute(permute(iy + i1y) + ix + i1x);
  const p2 = permute(permute(iy + 1) + ix + 1);
  let m0 = Math.max(0.5 - (x0x * x0x + x0y * x0y), 0);
  let m1 = Math.max(0.5 - (x1x * x1x + x1y * x1y), 0);
  let m2 = Math.max(0.5 - (x2x * x2x + x2y * x2y), 0);
  m0 = m0 * m0 * m0 * m0;
  m1 = m1 * m1 * m1 * m1;
  m2 = m2 * m2 * m2 * m2;
  const g = (p: number, m: number, px: number, py: number) => {
    const x = 2 * fract(p * C3) - 1;
    const h = Math.abs(x) - 0.5;
    const a0 = x - Math.floor(x + 0.5);
    return m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h)) * (a0 * px + h * py);
  };
  return 130 * (g(p0, m0, x0x, x0y) + g(p1, m1, x1x, x1y) + g(p2, m2, x2x, x2y));
};

/** 脊状分形：1 − |噪声| 平方后逐层用上一层加权，得到尖锐的山脊线。 */
const RIDGE_FREQ = 0.048;
const RIDGE_GAIN = 0.42;
/** 噪声对包络的调制：高度 × (1 + 脊 × MUL − SUB)。 */
const RIDGE_MUL = 0.95;
const RIDGE_SUB = 0.3;
/**
 * 山脊用平滑绝对值 √(n² + ε²) 代替 |n|，再除以 (1 − ε) 让脊顶仍是 1。
 * 硬 |n| 在每条噪声零线上留下一道折痕，四层叠起来满山都是棱：晕渲成一块块三角面，等高线在棱上折断。
 */
const RIDGE_SOFT = 0.12;
const ridgeN = (s: number) => (1 - Math.sqrt(s * s + RIDGE_SOFT * RIDGE_SOFT)) / (1 - RIDGE_SOFT);
export const ridged = (x: number, y: number) => {
  let sum = 0;
  let amp = 0.6;
  let f = RIDGE_FREQ;
  let prev = 1;
  for (let o = 0; o < 4; o++) {
    let n = ridgeN(snoise(x * f + o * 17.3, y * f - o * 9.1));
    n *= n;
    sum += n * amp * prev;
    prev = n;
    f *= 2.03;
    amp *= RIDGE_GAIN;
  }
  return sum;
};

const smooth = (e0: number, e1: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
};

/** 原点附近（那一页所在的平顶）不加噪声。 */
const CALM = { r0: 2.2, r1: 5.5 } as const;
/** 山体整体的竖向夸张。 */
export const RELIEF = 1.18;
/** 平原上的缓坡起伏：让等高线在谷地里也有长而曲折的走线。 */
const PLAIN = { amp: 1.5, freq: 0.032, r0: 4.5, r1: 10 } as const;
const plainAt = (x: number, y: number) =>
  PLAIN.amp *
  (0.62 * (snoise(x * PLAIN.freq + 3.7, y * PLAIN.freq - 1.9) * 0.5 + 0.5) + 0.38 * (snoise(x * PLAIN.freq * 2.3 - 5.1, y * PLAIN.freq * 2.3 + 7.3) * 0.5 + 0.5)) *
  smooth(PLAIN.r0, PLAIN.r1, Math.hypot(x, y));

/** 完全长成后的高度。 */
export const heightAt = (x: number, y: number) => {
  const [qx, qy] = warp(x, y);
  const { a, b } = BUMP_UNIFORMS;
  let env = 0;
  for (let i = 0; i < NB; i++) {
    const dx = qx - a[i * 4];
    const dy = qy - a[i * 4 + 1];
    const rx = b[i * 4] * dx + b[i * 4 + 1] * dy;
    const ry = (-b[i * 4 + 1] * dx + b[i * 4] * dy) / b[i * 4 + 2];
    const q = (rx * rx + ry * ry) / (a[i * 4 + 3] * a[i * 4 + 3]);
    env += a[i * 4 + 2] * Math.exp(-(q ** b[i * 4 + 3]));
  }
  const rough = smooth(CALM.r0, CALM.r1, Math.hypot(x, y)) * smooth(0.6, 2.4, env);
  return RELIEF * env * (1 + rough * (ridged(x, y) * RIDGE_MUL - RIDGE_SUB)) + plainAt(x, y);
};

/** 生长：从那一页向外扩散，波前经过处地面隆起。单位为脚本秒。 */
export const GROW = { t0: FN.veil1 - 0.02, speed: 15, dur: 1.9 } as const;
export const growthAt = (t: number, x: number, y: number) => {
  const k = Math.min(1, Math.max(0, (t - GROW.t0 - Math.hypot(x, y) / GROW.speed) / GROW.dur));
  return k * k * (3 - 2 * k);
};
export const surfaceAt = (t: number, x: number, y: number) => growthAt(t, x, y) * heightAt(x, y);

/** 等高距（世界单位）与计曲线间隔（每几条一根粗线）。 */
export const CONTOUR = { interval: 0.34, major: 5 } as const;

/** 那一页所在山顶每长过一根计曲线的时刻（配乐用）。 */
export const majorRingTimes = () => {
  const step = CONTOUR.interval * CONTOUR.major;
  const out: number[] = [];
  let next = step;
  for (let t = GROW.t0; t <= GROW.t0 + GROW.dur + 0.01; t += 0.002) {
    if (surfaceAt(t, 0, 0) >= next) {
      out.push(t);
      next += step;
    }
  }
  return out;
};

/** 在声明位置附近爬坡，找到真正的山顶（噪声与相邻山体会把它推开一点）。 */
export const SUMMITS = NAMED.map((p) => {
  let x = p.x;
  let y = p.y;
  let step = 0.5;
  let best = heightAt(x, y);
  for (let it = 0; it < 300 && step > 0.004; it++) {
    let moved = false;
    for (const [dx, dy] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
      [step, step],
      [-step, -step],
      [step, -step],
      [-step, step],
    ]) {
      const v = heightAt(x + dx, y + dy);
      if (v > best) {
        best = v;
        x += dx;
        y += dy;
        moved = true;
        break;
      }
    }
    if (!moved) step *= 0.5;
  }
  return { ...p, sx: x, sy: y, top: best };
});

export const GLSL_TERRAIN = /* glsl */ `
#define NB ${NB}
uniform vec4 uBumpA[NB];
uniform vec4 uBumpB[NB];
uniform float uT;
uniform float uGrow0;
uniform float uGrowSpeed;
uniform float uGrowDur;

vec2 warpP(vec2 p) {
  return p + vec2(
    1.1 * sin(0.21 * p.y + 1.7) + 0.55 * sin(0.47 * p.y - 0.8 + 0.3 * p.x),
    1.1 * cos(0.19 * p.x - 0.4) + 0.55 * cos(0.43 * p.x + 2.1 - 0.2 * p.y)
  );
}

vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute3(vec3 x) { return mod289v3(((x * 34.0) + 10.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(${C0}, ${C1}, ${C2}, ${C3});
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289v2(i);
  vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float ridged(vec2 p) {
  float sum = 0.0;
  float amp = 0.6;
  float f = ${RIDGE_FREQ};
  float prev = 1.0;
  for (int o = 0; o < 4; o++) {
    float fo = float(o);
    float sn = snoise(vec2(p.x * f + fo * 17.3, p.y * f - fo * 9.1));
    float n = (1.0 - sqrt(sn * sn + ${(RIDGE_SOFT * RIDGE_SOFT).toFixed(4)})) / ${(1 - RIDGE_SOFT).toFixed(4)};
    n *= n;
    sum += n * amp * prev;
    prev = n;
    f *= 2.03;
    amp *= ${RIDGE_GAIN};
  }
  return sum;
}

// x = 高度，y = 第一座山（教材所在主题）包络占比
vec2 terrainH(vec2 p) {
  vec2 q = warpP(p);
  float env = 0.0;
  float m = 0.0;
  for (int i = 0; i < NB; i++) {
    vec2 d = q - uBumpA[i].xy;
    vec2 r = vec2(uBumpB[i].x * d.x + uBumpB[i].y * d.y, (-uBumpB[i].y * d.x + uBumpB[i].x * d.y) / uBumpB[i].z);
    float k = dot(r, r) / (uBumpA[i].w * uBumpA[i].w);
    float v = uBumpA[i].z * exp(-pow(k, uBumpB[i].w));
    env += v;
    if (i == 0) m = v;
  }
  float rough = smoothstep(${CALM.r0.toFixed(2)}, ${CALM.r1.toFixed(2)}, length(p)) * smoothstep(0.6, 2.4, env);
  float pf = ${PLAIN.freq};
  float plain = ${PLAIN.amp} * (0.62 * (snoise(vec2(p.x * pf + 3.7, p.y * pf - 1.9)) * 0.5 + 0.5)
    + 0.38 * (snoise(vec2(p.x * pf * 2.3 - 5.1, p.y * pf * 2.3 + 7.3)) * 0.5 + 0.5))
    * smoothstep(${PLAIN.r0.toFixed(2)}, ${PLAIN.r1.toFixed(2)}, length(p));
  float h = ${RELIEF} * env * (1.0 + rough * (ridged(p) * ${RIDGE_MUL} - ${RIDGE_SUB})) + plain;
  return vec2(h, m / max(env, 1e-3));
}

float growth(vec2 p) {
  float k = clamp((uT - uGrow0 - length(p) / uGrowSpeed) / uGrowDur, 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}
`;

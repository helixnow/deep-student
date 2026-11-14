import { Euler, MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, ease, HEIGHT, keys, prog, WIDTH } from '../../lib/time';
import { CUT_ZOOM, HITS, RV, STRIP } from './beats';
import { CARD_ASPECT, type CardType } from './textures';

/** 3D 资料纵深的纯数据层：布局 / 相似度 / 相机 / 探针 / 投影，全部是 t 的确定性函数。 */

export const FOV = 35;
const TAN = Math.tan(MathUtils.degToRad(FOV / 2));
const ASPECT = WIDTH / HEIGHT;

const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── 相机 ──────────────────────────────────────────────
export const CAM0_Z = 10;
/** 匹配剪辑时 3D 向量条离镜头的距离；向量条屏幕宽与 DOM（zoom=CUT_ZOOM）一致。 */
export const STRIP_D = 3;

const camZ = (t: number) =>
  keys(t, [
    [RV.cut, CAM0_Z],
    [RV.probe, CAM0_Z - 1.4, ease.linear],
    [8.3, -54, ease.inOutCubic],
    [8.6, -54.6, ease.linear],
  ]);

export const camPose = (t: number) => {
  const z = camZ(t);
  const x = keys(t, [[RV.cut, 0], [7.55, 1.3], [8.3, 0]]);
  const y = keys(t, [[RV.cut, 0], [7.55, -0.45], [8.3, 0]]);
  const roll = keys(t, [[RV.cut, 0], [7.45, -3.2], [8.2, 0]]);
  const look = keys(t, [[RV.cut, 0], [7.6, 1], [8.15, 0]]);
  const pos = new Vector3(x, y, z);
  const target = new Vector3(x * 0.4 - look * 0.6, y * 0.4 + look * 0.25, z - 12);
  return { pos, target, roll };
};

const _cam = new PerspectiveCamera(FOV, ASPECT, 0.05, 400);
export const applyCam = (cam: PerspectiveCamera, t: number) => {
  const { pos, target, roll } = camPose(t);
  cam.fov = FOV;
  cam.aspect = ASPECT;
  cam.near = 0.05;
  cam.far = 400;
  cam.position.copy(pos);
  cam.up.set(0, 1, 0);
  cam.lookAt(target);
  cam.rotateZ(MathUtils.degToRad(roll));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
};
export const camAtT = (t: number) => applyCam(_cam, t);

/** 世界坐标 → 屏幕像素（1920×1080）。 */
export const toScreen = (t: number, p: Vector3) => {
  const cam = camAtT(t);
  const v = p.clone().project(cam);
  const behind = p.clone().applyMatrix4(cam.matrixWorldInverse).z > 0;
  return { x: (v.x * 0.5 + 0.5) * WIDTH, y: (-v.y * 0.5 + 0.5) * HEIGHT, behind };
};

/** 镜头局部坐标（右/上/前，单位：世界单位）→ 世界坐标。 */
export const camLocal = (t: number, x: number, y: number, d: number) => {
  const cam = camAtT(t);
  return new Vector3(x, y, -d).applyMatrix4(cam.matrixWorld);
};

/** 在距离 d 处，屏幕像素与世界单位的换算。 */
export const pxPerUnit = (d: number) => HEIGHT / (2 * d * TAN);

// ── 查询向量条（3D）与探针 ───────────────────────────
export const strip3D = () => {
  const unit = CUT_ZOOM / pxPerUnit(STRIP_D); // 1 个 DOM 像素 × CUT_ZOOM → 屏幕像素 → 世界单位
  const pitch = STRIP.pitch * unit;
  return { pitch, unit, cell: STRIP.cell * unit };
};

/** 命中纸片在资料堆里的原始位置。 */
export const HIT_BASE = [new Vector3(-2.4, 0.9, -66), new Vector3(0.5, -0.5, -69), new Vector3(2.9, 1.1, -64.5)];
/** HITS 数组顺序与 HIT_BASE 一一对应：[笔记, 教材, 记忆]。 */
export const HIT_ORDER = HITS.map((h) => h.kind);
export const HIT_CENTROID = HIT_BASE.reduce((a, b) => a.clone().add(b), new Vector3()).multiplyScalar(1 / 3);
export const PROBE_REST = new Vector3(0.35, 0.4, -62.5);

export const probePos = (t: number) => {
  const lead = keys(t, [[RV.probe, STRIP_D], [7.4, 5.5, ease.outCubic], [7.75, 8.5]]);
  const { pos } = camPose(t);
  const free = new Vector3(pos.x * 0.6, pos.y * 0.6 - 0.15, pos.z - lead);
  const settle = prog(t, 7.62, 7.86, ease.inOutCubic);
  return free.lerp(PROBE_REST, settle);
};

// ── 扫描脉冲 ──────────────────────────────────────────
/** 波前速度（世界单位 / 脚本秒）：扫描窗口 7.12–7.82 内要扫过雾里看得见的整片纸（约 70 单位深）。 */
export const PULSE_SPEED = 95;
export const PULSES = Array.from({ length: 8 }, (_, k) => RV.scan + k * 0.085);
const PULSE_ORIGINS = PULSES.map((e) => probePos(e));
export const pulseOrigin = (k: number) => PULSE_ORIGINS[k];

// ── 资料卡布局 ────────────────────────────────────────
export type Card = {
  type: CardType;
  variant: number;
  pos: Vector3;
  rot: Euler;
  scale: number;
  sim: number;
  phase: number;
  /** 第一个扫描脉冲抵达的时刻（脚本秒）。 */
  reveal: number;
};

const TYPE_WEIGHTS: Array<[CardType, number]> = [
  ['page', 0.38],
  ['note', 0.18],
  ['memory', 0.12],
  ['photo', 0.1],
  ['anki', 0.12],
  ['mindmap', 0.1],
];
export const VARIANTS: Record<CardType, number> = { page: 8, note: 5, memory: 4, photo: 3, anki: 3, mindmap: 3 };

let CARDS: Card[] | null = null;
export const cards = (): Card[] => {
  if (CARDS) return CARDS;
  const r = mulberry(20260930);
  const out: Card[] = [];
  for (let z = -1.5; z > -128; z -= 2.5) {
    for (let gx = -21; gx <= 21; gx += 2.15) {
      for (let gy = -12; gy <= 12; gy += 2.2) {
        if (r() > 0.085) continue;
        const pos = new Vector3(gx + (r() - 0.5) * 1.6, gy + (r() - 0.5) * 1.6, z + (r() - 0.5) * 2.2);
        // 镜头通道：路径附近留空
        const corridor = (pos.x / 3.1) ** 2 + (pos.y / 2.1) ** 2;
        if (corridor < 1 && pos.z > -70) continue;
        if (HIT_BASE.some((h) => h.distanceTo(pos) < 1.7)) continue;
        if (pos.distanceTo(PROBE_REST) < 1.6) continue;
        let pick = r();
        let type: CardType = 'page';
        for (const [tp, w] of TYPE_WEIGHTS) {
          if ((pick -= w) <= 0) {
            type = tp;
            break;
          }
        }
        const d = pos.distanceTo(HIT_CENTROID);
        const sim = clamp(0.1 + 0.66 * Math.exp(-(d * d) / (2 * 7.5 * 7.5)) + (r() - 0.5) * 0.24, 0.02, 0.79);
        const reveal = Math.min(...PULSES.map((e, k) => e + PULSE_ORIGINS[k].distanceTo(pos) / PULSE_SPEED));
        const tilt = r() < 0.06 ? 2 : 1;
        out.push({
          type,
          variant: Math.floor(r() * VARIANTS[type]),
          pos,
          rot: new Euler((r() - 0.5) * 0.14 * tilt, (r() - 0.5) * 0.24 * tilt, (r() - 0.5) * 0.08 * tilt),
          scale: 0.95 + r() * 0.4,
          sim,
          phase: r() * Math.PI * 2,
          reveal,
        });
      }
    }
  }
  CARDS = out;
  return out;
};

export const cardSize = (type: CardType) => ({ w: 1, h: CARD_ASPECT[type] });

// ── 命中纸片抽离后的位置（镜头前一排） ─────────────────
export const HIT_D = 4.6;
export const HIT_W = 0.96;
export const HIT_H = HIT_W * 1.33;
export const HIT_SLOT_X = [-1.28, 0, 1.28];
export const HIT_SLOT_Y = 0.12;

/** 交接时刻命中卡在屏幕上的矩形（DOM 替身从这里接手）。 */
export const hitScreenRect = (i: number, t: number = RV.reveal) => {
  const c = camLocal(t, HIT_SLOT_X[i], HIT_SLOT_Y, HIT_D);
  const s = toScreen(t, c);
  const ppu = pxPerUnit(HIT_D);
  const w = HIT_W * ppu * (i === 1 ? 1.08 : 1);
  const h = HIT_H * ppu * (i === 1 ? 1.08 : 1);
  return { x: s.x - w / 2, y: s.y - h / 2, w, h };
};

export const _q = new Quaternion();

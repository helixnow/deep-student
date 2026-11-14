import type { CSSProperties, ReactNode } from 'react';
import { clamp, ease, type Ease, HEIGHT, lerp, WIDTH } from './time';

export type Cam = { x: number; y: number; zoom: number; rx: number; ry: number; rz: number };
export type CamKey = [time: number, cam: Partial<Cam>, easeIn?: Ease];

const DEFAULT: Cam = { x: WIDTH / 2, y: HEIGHT / 2, zoom: 1, rx: 0, ry: 0, rz: 0 };

/** 关键帧相机：未声明的分量沿用上一帧的值。 */
export const camAt = (t: number, frames: CamKey[]): Cam => {
  const full: Array<[number, Cam, Ease]> = [];
  let prev = DEFAULT;
  for (const [time, cam, e] of frames) {
    prev = { ...prev, ...cam };
    full.push([time, prev, e ?? ease.inOutCubic]);
  }
  if (t <= full[0][0]) return full[0][1];
  for (let i = 1; i < full.length; i++) {
    const [t1, c1, e] = full[i];
    const [t0, c0] = full[i - 1];
    if (t <= t1) {
      const k = e(clamp((t - t0) / Math.max(1e-6, t1 - t0)));
      // zoom 用对数插值，推拉速度在视觉上才均匀
      const zoom = Math.exp(lerp(Math.log(c0.zoom), Math.log(c1.zoom), k));
      return {
        x: lerp(c0.x, c1.x, k),
        y: lerp(c0.y, c1.y, k),
        zoom,
        rx: lerp(c0.rx, c1.rx, k),
        ry: lerp(c0.ry, c1.ry, k),
        rz: lerp(c0.rz, c1.rz, k),
      };
    }
  }
  return full[full.length - 1][1];
};

/**
 * 关键帧相机的时间域高斯平均：关键帧处的速度不再归零或突变（「推—停—推」的顿挫、从静止全速起步）。
 * cuts 是硬切点：平均窗口不跨过它（匹配剪辑前后是两个机位）。先平滑，再 clampCam。
 */
export const smoothCam = (t: number, frames: CamKey[], { sigma = 0.035, cuts = [] as number[] } = {}): Cam => {
  const lo = Math.max(-Infinity, ...cuts.filter((c) => c <= t));
  const hi = Math.min(Infinity, ...cuts.filter((c) => c > t));
  // 靠近硬切点时窗口收窄到零：切点那一帧的机位必须分毫不差（匹配剪辑靠它对位）
  const step = Math.min(sigma * 0.5, Math.min(t - lo, hi - t) / 8);
  let w = 0;
  let x = 0;
  let y = 0;
  let lz = 0;
  for (let i = -8; i <= 8; i++) {
    const k = Math.exp(-((i / 4) ** 2) / 2);
    const c = camAt(t + i * step, frames);
    w += k;
    x += c.x * k;
    y += c.y * k;
    lz += Math.log(c.zoom) * k;
  }
  return { ...camAt(t, frames), x: x / w, y: y / w, zoom: Math.exp(lz / w) };
};

/** 2D 桌面镜头：取景框不越出 1920×1080 的桌面（否则边缘会露出桌面外的底色）。 */
export const clampCam = (c: Cam): Cam => {
  if (c.zoom <= 1) return { ...c, x: WIDTH / 2, y: HEIGHT / 2 };
  const hw = WIDTH / 2 / c.zoom;
  const hh = HEIGHT / 2 / c.zoom;
  return { ...c, x: clamp(c.x, hw, WIDTH - hw), y: clamp(c.y, hh, HEIGHT - hh) };
};

/** 世界坐标 → 屏幕坐标（仅在无旋转时精确，交互镜头都保持零旋转）。 */
export const project = (cam: Cam, wx: number, wy: number) => ({
  x: WIDTH / 2 + (wx - cam.x) * cam.zoom,
  y: HEIGHT / 2 + (wy - cam.y) * cam.zoom,
});

export const CameraView = ({
  cam,
  children,
  perspective = 2400,
  style,
}: {
  cam: Cam;
  children: ReactNode;
  perspective?: number;
  style?: CSSProperties;
}) => (
  <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', perspective, ...style }}>
    <div
      style={{
        position: 'absolute',
        left: WIDTH / 2,
        top: HEIGHT / 2,
        width: 0,
        height: 0,
        transformStyle: 'preserve-3d',
        transform: `rotateX(${cam.rx}deg) rotateY(${cam.ry}deg) rotateZ(${cam.rz}deg) scale(${cam.zoom}) translate(${-cam.x}px, ${-cam.y}px)`,
      }}
    >
      {children}
    </div>
  </div>
);

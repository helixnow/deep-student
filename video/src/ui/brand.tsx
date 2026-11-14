import type { CSSProperties } from 'react';
import { brand } from '../theme';
import { clamp, prog, ease } from '../lib/time';

/** public/logo-black.svg 的三段子路径：机身外轮廓 / D 形开口 / 眼眶。 */
export const LOGO_OUTER =
  'M10 29.6379C10 22.764 10 19.327 11.3378 16.7015C12.5145 14.3921 14.3921 12.5145 16.7015 11.3378C19.327 10 22.764 10 29.6379 10H96.3621C103.236 10 106.673 10 109.298 11.3378C111.608 12.5145 113.486 14.3921 114.662 16.7015C116 19.327 116 22.764 116 29.6379V35.6632C116 63.7837 116 77.844 110.527 88.5846C105.714 98.0323 98.0323 105.714 88.5846 110.527C77.844 116 63.7837 116 35.6632 116H29.6379C22.764 116 19.327 116 16.7015 114.662C14.3921 113.486 12.5145 111.608 11.3378 109.298C10 106.673 10 103.236 10 96.3621V29.6379Z';
export const LOGO_D =
  'M32.6636 38.85H53.598C72.1285 38.85 87.1504 53.8719 87.1504 72.4024C87.1504 90.9329 72.1285 105.955 53.598 105.955H32.6636C32.3707 105.955 32.2242 105.955 32.1004 105.952C25.4999 105.819 20.181 100.5 20.048 93.9C20.0456 93.7761 20.0456 93.6297 20.0456 93.3368V51.468C20.0456 51.1751 20.0456 51.0286 20.048 50.9048C20.181 44.3043 25.4999 38.9854 32.1004 38.8524C32.2242 38.85 32.3707 38.85 32.6636 38.85Z';
export const LOGO_EYE =
  'M95.8062 44.6188C103.183 44.6188 109.163 38.6866 109.163 31.3688C109.163 24.0511 103.183 18.1188 95.8062 18.1188C88.4294 18.1188 82.4493 24.0511 82.4493 31.3688C82.4493 38.6866 88.4294 44.6188 95.8062 44.6188Z';
export const EYE_CENTER = { x: 95.8062, y: 31.3688 };
export const D_CENTER = { x: 53.6, y: 72.4 };
export const PUPIL = { cx: 102.292, cy: 31.391, r: 5.1 };

export const LogoMark = ({
  id,
  size,
  color = brand.ink,
  pupilColor = brand.ink,
  reveal = 1,
  dOpen = 1,
  eyeOpen = 1,
  blink = 1,
  pupilScale = 1,
  pupilDx = 0,
  pupilDy = 0,
  style,
}: {
  id: string;
  size: number;
  color?: string;
  pupilColor?: string;
  reveal?: number;
  dOpen?: number;
  eyeOpen?: number;
  blink?: number;
  pupilScale?: number;
  /** 瞳孔相对默认位置的偏移（viewBox 单位），用于「瞥一眼」。 */
  pupilDx?: number;
  pupilDy?: number;
  style?: CSSProperties;
}) => {
  const r = 4 + reveal * 150;
  const eyeT = `translate(${EYE_CENTER.x} ${EYE_CENTER.y}) scale(${eyeOpen} ${eyeOpen * blink}) translate(${-EYE_CENTER.x} ${-EYE_CENTER.y})`;
  const dT = `translate(${D_CENTER.x} ${D_CENTER.y}) scale(${dOpen}) translate(${-D_CENTER.x} ${-D_CENTER.y})`;
  const pT = `translate(${EYE_CENTER.x} ${EYE_CENTER.y}) scale(1 ${blink}) translate(${-EYE_CENTER.x} ${-EYE_CENTER.y})`;
  return (
    <svg width={size} height={size} viewBox="0 0 126 126" style={{ overflow: 'visible', ...style }}>
      <defs>
        <clipPath id={`${id}-reveal`}>
          <circle cx={EYE_CENTER.x} cy={EYE_CENTER.y} r={r} />
        </clipPath>
        <mask id={`${id}-holes`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="166" height="166">
          <rect x="-20" y="-20" width="166" height="166" fill="white" />
          {dOpen > 0.001 ? <path d={LOGO_D} fill="black" transform={dT} /> : null}
          {eyeOpen > 0.001 ? <path d={LOGO_EYE} fill="black" transform={eyeT} /> : null}
        </mask>
      </defs>
      <path d={LOGO_OUTER} fill={color} mask={`url(#${id}-holes)`} clipPath={`url(#${id}-reveal)`} />
      <g transform={pT}>
        <circle cx={PUPIL.cx + pupilDx} cy={PUPIL.cy + pupilDy} r={PUPIL.r * pupilScale} fill={pupilColor} />
      </g>
    </svg>
  );
};

export const PaperGrid = ({
  color = brand.gridLine,
  size = 28,
  offsetX = 0,
  offsetY = 0,
  mask = true,
  style,
}: {
  color?: string;
  size?: number;
  offsetX?: number;
  offsetY?: number;
  mask?: boolean;
  style?: CSSProperties;
}) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `${offsetX}px ${offsetY}px`,
      maskImage: mask ? 'radial-gradient(ellipse 95% 85% at 50% 40%, #000 40%, transparent 100%)' : undefined,
      WebkitMaskImage: mask ? 'radial-gradient(ellipse 95% 85% at 50% 40%, #000 40%, transparent 100%)' : undefined,
      ...style,
    }}
  />
);

/** 瞳点：学习者的注意力与指针（永远代表用户，不代表 AI）。 */
export const Pupil = ({
  x,
  y,
  t,
  clicks = [],
  opacity = 1,
  size = 18,
  color = brand.pupil,
  glow = 1,
}: {
  x: number;
  y: number;
  t: number;
  clicks?: number[];
  opacity?: number;
  size?: number;
  color?: string;
  glow?: number;
}) => {
  let press = 0;
  const rings: Array<{ k: number; key: number }> = [];
  for (const c of clicks) {
    const d = t - c;
    if (d >= -0.08 && d < 0.1) press = Math.max(press, 1 - Math.abs(d) / 0.1);
    if (d >= 0 && d < 0.5) rings.push({ k: d / 0.5, key: c });
  }
  const s = 1 - press * 0.28;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, opacity, pointerEvents: 'none' }}>
      {rings.map(({ k, key }) => (
        <div
          key={key}
          style={{
            position: 'absolute',
            left: -size * (0.5 + k * 1.4),
            top: -size * (0.5 + k * 1.4),
            width: size * (1 + k * 2.8),
            height: size * (1 + k * 2.8),
            borderRadius: '50%',
            border: `2px solid ${color}`,
            opacity: (1 - ease.outCubic(k)) * 0.7,
          }}
        />
      ))}
      <div
        style={{
          position: 'absolute',
          left: -size / 2,
          top: -size / 2,
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          transform: `scale(${s})`,
          boxShadow: `0 0 0 ${5 * glow}px hsl(215 72% 42% / ${0.14 * glow}), 0 2px 6px hsl(220 30% 10% / 0.25), inset 0 0 0 2px hsl(0 0% 100% / 0.9)`,
        }}
      />
    </div>
  );
};

/** 路径点序列上的瞳点位置：每段 [到达时刻, x, y]，段间用品牌缓动。 */
export const pathAt = (t: number, pts: Array<[number, number, number]>) => {
  if (t <= pts[0][0]) return { x: pts[0][1], y: pts[0][2] };
  for (let i = 1; i < pts.length; i++) {
    const [t1, x1, y1] = pts[i];
    const [t0, x0, y0] = pts[i - 1];
    if (t <= t1) {
      const k = prog(t, t0, t1, ease.inOutCubic);
      // 轻微弧线，避免机械直线
      const arc = Math.sin(k * Math.PI) * clamp(Math.hypot(x1 - x0, y1 - y0) * 0.08, 0, 40);
      return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k - arc };
    }
  }
  const last = pts[pts.length - 1];
  return { x: last[1], y: last[2] };
};

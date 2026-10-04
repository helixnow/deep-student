import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill } from 'remotion';
import { ease, lerp, prog, SCRIPT_S } from '../../lib/time';
import { brand, font } from '../../theme';
import { LogoMark, Pupil, PUPIL } from '../../ui/brand';
import { FN } from './beats';
import { pinScreen } from './KnowledgeTerrain';

/**
 * 片尾：全片代表用户注意力的瞳点从知识地形的山顶（那一页纸）起飞，Logo 以眼眶为圆心展开，
 * 瞳点落位成 Logo 的瞳孔（Logo 224px 时瞳孔直径正好 18px，与瞳点等大）。
 */
const LOGO = { cx: 960, cy: 412, size: 224 };
const SCALE = LOGO.size / 126;
const LOGO_PUPIL = { x: LOGO.cx - LOGO.size / 2 + PUPIL.cx * SCALE, y: LOGO.cy - LOGO.size / 2 + PUPIL.cy * SCALE };

const Rise = ({ t, at, children, style }: { t: number; at: number; children: ReactNode; style?: CSSProperties }) => {
  const k = prog(t, at, at + 0.32, ease.brand);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        textAlign: 'center',
        opacity: k,
        filter: `blur(${(1 - k) * 8}px)`,
        transform: `translateY(${(1 - k) * 14}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const EndCard = ({ t }: { t: number }) => {
  if (t < FN.pupil0) return null;
  const fly = prog(t, FN.pupilFly, FN.pupilLand, ease.inOutCubic);
  const start = pinScreen(Math.min(t, FN.pupilFly));
  const px = lerp(start.x, LOGO_PUPIL.x, fly);
  const py = lerp(start.y, LOGO_PUPIL.y, fly) - Math.sin(fly * Math.PI) * 70;
  const dotIn = 1;
  const handover = prog(t, FN.eye0 + 0.02, FN.eye0 + 0.12);
  const reveal = prog(t, FN.reveal0, FN.reveal1, ease.brand);
  const eyeOpen = prog(t, FN.eye0, FN.eye0 + 0.16, ease.overshoot);
  const dOpen = prog(t, FN.d0, FN.d0 + 0.26, ease.brand);
  const b = (t - FN.blink) / 0.14;
  const blink = b > 0 && b < 1 ? 1 - 0.92 * Math.sin(b * Math.PI) : 1;
  const glance = prog(t, FN.glance, FN.glance + 0.12, ease.brand) * (1 - prog(t, FN.glance + 0.4, FN.glance + 0.52, ease.brand));
  // 落定后的长停留里镜头极慢地推近，画面不至于完全静止
  const drift = prog(t, FN.reveal1, SCRIPT_S, ease.linear);
  return (
    <AbsoluteFill style={{ fontFamily: font.ui, transform: `scale(${1 + 0.035 * drift}) translateY(${-6 * drift}px)`, transformOrigin: '50% 46%' }}>
      {reveal > 0 ? (
        <LogoMark
          id="endcard"
          size={LOGO.size}
          color={brand.ink}
          pupilColor={brand.pupil}
          reveal={reveal}
          dOpen={dOpen}
          eyeOpen={eyeOpen}
          blink={blink}
          pupilScale={handover}
          pupilDx={-2.6 * glance}
          pupilDy={1.1 * glance}
          style={{ position: 'absolute', left: LOGO.cx - LOGO.size / 2, top: LOGO.cy - LOGO.size / 2 }}
        />
      ) : null}
      {handover < 1 ? <Pupil x={px} y={py} t={t} opacity={dotIn * (1 - handover)} glow={1 - reveal * 0.7} /> : null}
      <Rise t={t} at={FN.word0} style={{ top: LOGO.cy + LOGO.size / 2 + 36 }}>
        <span style={{ fontFamily: font.display, fontSize: 66, fontWeight: 600, letterSpacing: '-0.015em', color: brand.ink }}>DeepStudent</span>
      </Rise>
      <Rise t={t} at={FN.tag0} style={{ top: LOGO.cy + LOGO.size / 2 + 128 }}>
        <span style={{ fontFamily: font.serif, fontSize: 44, fontWeight: 500, letterSpacing: '0.06em', color: brand.ink }}>只专注学习本身就够了，剩下的都交给我。</span>
      </Rise>
      <Rise t={t} at={FN.url0} style={{ top: LOGO.cy + LOGO.size / 2 + 214 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 16, fontSize: 20, color: brand.ink3 }}>
          <span style={{ fontFamily: font.mono, color: brand.ink2 }}>deepstudent.cn</span>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: brand.accent }} />
          <span>开源（AGPL-3.0）</span>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: brand.accent }} />
          <span>本地优先</span>
        </span>
      </Rise>
      <Rise t={t} at={FN.platforms0} style={{ top: LOGO.cy + LOGO.size / 2 + 254 }}>
        <span style={{ fontSize: 18, letterSpacing: '0.08em', color: brand.ink3 }}>Windows · macOS · Linux · Android</span>
      </Rise>
    </AbsoluteFill>
  );
};

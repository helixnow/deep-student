import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill } from 'remotion';
import { ease, lerp, prog, SCRIPT_S } from '../../lib/time';
import { squeeze } from '../../overlays/Supers';
import { brand, font } from '../../theme';
import { LogoMark, Pupil, PUPIL } from '../../ui/brand';
import { FN } from './beats';
import { pinScreen } from './KnowledgeTerrain';

/**
 * 片尾：全片代表用户注意力的瞳点从知识地形的山顶（那一页纸）起飞，Logo 以眼眶为圆心展开，
 * 瞳点落位成 Logo 的瞳孔（Logo 224px 时瞳孔直径正好 18px，与瞳点等大）。
 * 版式三层：Logo 与字标一组 → 口号独处 → 一行很轻的网址与平台。
 */
const LOGO = { cx: 960, cy: 400, size: 224 };
const SCALE = LOGO.size / 126;
const LOGO_PUPIL = { x: LOGO.cx - LOGO.size / 2 + PUPIL.cx * SCALE, y: LOGO.cy - LOGO.size / 2 + PUPIL.cy * SCALE };
const TAGLINE = '只专注学习本身就够了，剩下的都交给我';
const INFO = ['开源', '本地优先', 'Windows', 'macOS', 'Linux', 'Android', 'WebUI'];

/** 与字幕同一套动作：柔焦升起。 */
const Rise = ({ t, at, children, style }: { t: number; at: number; children: ReactNode; style?: CSSProperties }) => {
  const k = prog(t, at, at + 0.4, ease.brand);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        textAlign: 'center',
        opacity: k,
        filter: k < 0.99 ? `blur(${(1 - k) * 4}px)` : undefined,
        transform: `translateY(${(1 - k) * 10}px)`,
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
  const handover = prog(t, FN.eye0 + 0.02, FN.eye0 + 0.12);
  const reveal = prog(t, FN.reveal0, FN.reveal1, ease.inOutCubic);
  const eyeOpen = prog(t, FN.eye0, FN.eye0 + 0.16, ease.overshoot);
  const dOpen = prog(t, FN.d0, FN.d0 + 0.26, ease.brand);
  const b = (t - FN.blink) / 0.14;
  const blink = b > 0 && b < 1 ? 1 - 0.92 * Math.sin(b * Math.PI) : 1;
  const glance = prog(t, FN.glance, FN.glance + 0.12, ease.brand) * (1 - prog(t, FN.glance + 0.4, FN.glance + 0.52, ease.brand));
  // 落定后的长停留里只有 Logo 极慢地长大（以瞳孔为圆心，瞳点交接的位置不动）；文字不缩放，否则基线会逐像素跳
  const drift = prog(t, FN.reveal1, SCRIPT_S, ease.linear);
  const logoScale = (0.94 + 0.06 * reveal) * (1 + 0.035 * drift);
  const bottom = LOGO.cy + LOGO.size / 2;
  return (
    <AbsoluteFill style={{ fontFamily: font.super }}>
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
          pupilDx={-4.5 * glance}
          pupilDy={1.8 * glance}
          style={{
            position: 'absolute',
            left: LOGO.cx - LOGO.size / 2,
            top: LOGO.cy - LOGO.size / 2,
            transform: `scale(${logoScale})`,
            transformOrigin: `${PUPIL.cx * SCALE}px ${PUPIL.cy * SCALE}px`,
          }}
        />
      ) : null}
      {handover < 1 ? <Pupil x={px} y={py} t={t} opacity={1 - handover} glow={1 - reveal * 0.7} /> : null}
      <Rise t={t} at={FN.word0} style={{ top: bottom + 18 }}>
        <span style={{ fontSize: 56, fontWeight: 600, letterSpacing: '-0.01em', color: brand.ink }}>DeepStudent</span>
      </Rise>
      <Rise t={t} at={FN.tag0} style={{ top: bottom + 140 }}>
        <span style={{ position: 'relative', fontFamily: font.serif, fontSize: 44, fontWeight: 400, letterSpacing: '0.02em', color: brand.ink }}>
          {squeeze(TAGLINE)}
          <span style={{ position: 'absolute' }}>。</span>
        </span>
      </Rise>
      <Rise t={t} at={FN.info0} style={{ top: bottom + 254 }}>
        <span style={{ fontSize: 20, letterSpacing: '0.02em', color: brand.ink3 }}>
          <span style={{ color: brand.ink2 }}>deepstudent.cn</span>
          {INFO.map((s) => (
            <span key={s}>
              <span style={{ margin: '0 0.5em' }}>·</span>
              {s}
            </span>
          ))}
        </span>
      </Rise>
    </AbsoluteFill>
  );
};

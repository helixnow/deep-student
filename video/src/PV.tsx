import type { ReactNode } from 'react';
import { AbsoluteFill, getInputProps } from 'remotion';
import './global.css';
import { Soundtrack } from './audio/Soundtrack';
import { prog, useTime } from './lib/time';
import { Supers } from './overlays/Supers';
import { DAY } from './scenes/day/beats';
import { SceneDay } from './scenes/day/SceneDay';
import { FN } from './scenes/finale/beats';
import { EndCard } from './scenes/finale/EndCard';
import { KnowledgeTerrain } from './scenes/finale/KnowledgeTerrain';
import { RV } from './scenes/retrieval/beats';
import { Archive3D } from './scenes/retrieval/Archive3D';
import { FREEZE, MIN0, MIN1, minimizeAt } from './scenes/review/handoff';
import { WK, SceneReview } from './scenes/review/SceneReview';
import { SceneClassic } from './scenes/SceneClassic';
import { SceneYou } from './scenes/you/SceneYou';
import { brand } from './theme';
import { resolveTimeline } from './timeline/schedule';
import { PaperGrid } from './ui/brand';
import { useFontsReady } from './ui/tex';

const Minimize = ({ t, children }: { t: number; children: ReactNode }) => {
  if (t <= MIN0) return <>{children}</>;
  const m = minimizeAt(t);
  return (
    <AbsoluteFill
      style={{
        transform: `translate(${m.x - m.c0.x}px, ${m.y - m.c0.y}px) scale(${m.sx}, ${m.sy})`,
        transformOrigin: `${m.c0.x}px ${m.c0.y}px`,
        opacity: 1 - prog(m.k, 0.8, 1),
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const PV = () => {
  useFontsReady();
  const outT = useTime();
  const { mainT: t, active } = resolveTimeline(outT);
  const ActiveInsert = active?.insert.Scene;
  return (
    <AbsoluteFill style={{ background: brand.paper, overflow: 'hidden' }}>
      {/* 地形淡回纸面时网格一起收掉：片尾是一张干净的纸，Logo 不和格线叠在一起 */}
      <PaperGrid style={{ opacity: 1 - prog(t, FN.fade0, FN.fade1) }} />
      {t >= FN.kb0 && t < FN.fade1 ? <KnowledgeTerrain t={t} /> : null}
      {t >= DAY.start && t < DAY.end + 0.6 ? <SceneDay t={t} /> : null}
      <SceneYou t={t} />
      {t >= WK.night0 && t < WK.out1 ? <SceneReview t={t} /> : null}
      {t < MIN1 ? (
        <Minimize t={t}>
          <SceneClassic t={Math.min(t, FREEZE)} hidePupil={t > MIN0} />
        </Minimize>
      ) : null}
      {t >= RV.cut && t < RV.reveal + 0.16 ? <Archive3D t={t} /> : null}
      <EndCard t={t} />
      {ActiveInsert ? <ActiveInsert t={active.localT} /> : null}
      {active ? (active.insert.supers ? <Supers t={active.localT} items={active.insert.supers} /> : null) : <Supers t={t} />}
      {getInputProps().noAudio === true ? null : <Soundtrack />}
    </AbsoluteFill>
  );
};

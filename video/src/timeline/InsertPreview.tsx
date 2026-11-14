import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import '../global.css';
import { ALL_INSERTS } from '../inserts';
import { PACE } from '../lib/time';
import { Supers } from '../overlays/Supers';
import { brand } from '../theme';
import { useFontsReady } from '../ui/tex';

/** 单个插入段的检查用合成（Insert-<id>）：纸色底上单独播放这一段和它自己的字幕，t 为段内脚本秒。不进成片。 */
export const InsertPreview = ({ id }: { id: string }) => {
  useFontsReady();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const insert = ALL_INSERTS.find((item) => item.id === id);
  if (!insert) throw new Error(`[InsertPreview] unknown insert "${id}"`);
  const { Scene, supers } = insert;
  const t = frame / fps / PACE;
  return (
    <AbsoluteFill style={{ background: brand.paper, overflow: 'hidden' }}>
      <Scene t={t} />
      {supers ? <Supers t={t} items={supers} /> : null}
    </AbsoluteFill>
  );
};

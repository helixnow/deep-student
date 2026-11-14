import { Img } from 'remotion';
import { project, type Cam } from '../../lib/camera';
import { clamp, ease, PACE, prog } from '../../lib/time';
import { CLASSIC_ASSISTANT_TOP, TL_PITCH } from '../../ui/chat';
import { CW, PAGE_ORIGIN, PDF_TOOLBAR } from '../../ui/classic';
import { PAGE_H, PAGE_W, quoteFlashAlpha, TextbookPage } from '../../ui/TextbookPage';
import { hitScreenRect } from './archive';
import { useArchiveAssets } from './assets';
import { HITS, RV } from './beats';

const ASPECT = 1.33;
/** 检索行在世界坐标中的落点（助手块顶 + 时间线行距 TL_PITCH；x 落在工具图标上）。 */
export const ROW_Y = [CW.title + CLASSIC_ASSISTANT_TOP + TL_PITCH, CW.title + CLASSIC_ASSISTANT_TOP + 2 * TL_PITCH];
const ROW_X = CW.chatX + 32 + 12;

const FLIGHTS = [
  { t0: RV.reveal + 0.06, t1: RV.land2, to: 'row0' as const },
  { t0: RV.reveal + 0.02, t1: RV.land1, to: 'page' as const },
  { t0: RV.reveal + 0.1, t1: RV.land3, to: 'row1' as const },
];

/**
 * 3D → 界面的交接替身（屏幕坐标）：命中纸片从 3D 最后一帧的位置接手。
 * 教材页飞进右侧 PDF 面板：起飞时是 3D 里那张贴图，飞行前段换成面板里同一个 TextbookPage（第 134 页，带定位高亮），
 * 落点与面板里已翻好的那页逐像素重合，落地即撤；另两张沿弧线收进对应的检索行。
 */
export const Handoff = ({ t, cam }: { t: number; cam: Cam }) => {
  const assets = useArchiveAssets();
  if (!assets || t < RV.reveal || t > RV.land3 + 0.02) return null;
  return (
    <>
      {HITS.map((h, i) => {
        const f = FLIGHTS[i];
        const a = hitScreenRect(i);
        const page = f.to === 'page';
        let b: { x: number; y: number; w: number; h: number };
        if (page) {
          // 落点 = 面板里第 134 页的可见部分（页顶到面板滚动区底，底下是工具条）
          const p = project(cam, PAGE_ORIGIN.x, PAGE_ORIGIN.y);
          b = { x: p.x, y: p.y, w: PAGE_W * cam.zoom, h: (CW.h - PDF_TOOLBAR - PAGE_ORIGIN.y) * cam.zoom };
        } else {
          const p = project(cam, ROW_X, ROW_Y[f.to === 'row0' ? 0 : 1] + 2);
          const hh = 24 * cam.zoom;
          b = { x: p.x, y: p.y, w: hh / ASPECT, h: hh };
        }
        const k = prog(t, f.t0, f.t1, page ? ease.inOutQuint : ease.inOutCubic);
        if (k >= 1) return null;
        // 小卡先缩后走：尺寸收得比位置快，飞行中不压住侧栏
        const ks = page ? k : Math.sqrt(k);
        const lift = Math.sin(k * Math.PI) * (page ? 30 : 56);
        const x = a.x + (b.x - a.x) * k;
        const y = a.y + (b.y - a.y) * k - lift;
        const w = a.w + (b.w - a.w) * ks;
        const hgt = a.h + (b.h - a.h) * ks;
        const mid = Math.sin(k * Math.PI);
        const shadow = `0 ${8 + 26 * mid}px ${24 + 44 * mid}px hsl(220 30% 14% / ${0.1 + 0.12 * mid}), 0 0 0 1px hsl(220 12% 16% / 0.06)`;
        if (!page) {
          return (
            <Img
              key={h.title}
              src={assets.hitUrls[i]}
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: w,
                height: hgt,
                borderRadius: 4 + 6 * mid,
                opacity: clamp((1 - k) / 0.3),
                transform: `rotate(${mid * (i - 1) * -3}deg)`,
                boxShadow: shadow,
              }}
            />
          );
        }
        // 教材页：贴图 → 真实页面的交叉淡化放在飞行前段（运动最快时），落地前已是同一张页面
        const swap = prog(k, 0.08, 0.34, ease.inOutCubic);
        const scale = w / PAGE_W;
        return (
          <div
            key={h.title}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: w,
              height: hgt,
              borderRadius: 4,
              overflow: 'hidden',
              boxShadow: shadow,
              background: '#fff',
            }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, width: PAGE_W, height: PAGE_H, transform: `scale(${scale})`, transformOrigin: '0 0', opacity: swap }}>
              <TextbookPage page={134} flash={quoteFlashAlpha((t - RV.land1) * PACE) || 0.48} />
            </div>
            {swap < 1 ? <Img src={assets.hitUrls[i]} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 1 - swap }} /> : null}
          </div>
        );
      })}
    </>
  );
};

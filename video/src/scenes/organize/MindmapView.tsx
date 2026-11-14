import { ease, prog } from '../../lib/time';
import { S } from '../../strings';
import type { Tokens } from '../../theme';
import { CW } from '../../ui/classic';
import { graphFrame, MindmapGraph, MM_NODES, nodeColor, nodePos, nodeSize, type LayoutId } from '../../ui/mindmap';
import {
  MmCanvasControls,
  MmCanvasDots,
  MmPanelHeader,
  MmPanelToolbar,
  MmReciteRow,
  MP,
  MP_BTN,
  MP_MASK_BTN,
  MP_REVEAL_ALL_BTN,
  STRUCT_POP,
  structCellCenter,
  StructureGrid,
  type MiniRect,
  type StructCell,
} from '../../ui/mindmapPanel';

/**
 * 03 整理（后半）的节拍表，单位为脚本秒。
 * 对话里点导图卡「打开」→ 导图在会话右侧面板打开（替换 PDF）→ 切两次结构（点选即关弹层）
 * → 背诵：一键遮住要点 → 逐个点开 → 全部揭示 → 镜头回到对话。
 */
export const MM = {
  open: 11.56, // CHAT_OPEN_ATTACHMENT_PREVIEW type=mindmap：右侧面板换成导图
  structClicks: [12.4, 13.1], // 点「切换结构」
  picks: [12.68, 13.38], // 组织结构图(向下) → 逻辑图(向右)
  reciteClick: 13.84, // 点「背诵」
  maskClick: 14.08, // 一键遮住要点
  reveals: [14.3, 14.44, 14.58], // 逐个点开
  revealAll: 14.76, // 全部揭示
  close0: 14.96, // 镜头回到对话
  close1: 15.3,
} as const;

/** 右侧面板（与 PDF 面板同一槽位）；零件坐标相对 1px 左边框内侧。 */
export const PANEL = { x: CW.panelX, y: CW.title, w: CW.panel, h: CW.h - CW.title } as const;
const IN_X = PANEL.x + 1;
const IN_W = PANEL.w - 1;
const CANVAS_TOP = MP.header + MP.toolbar;
/** 画布容器保持打开时的高度：背诵行出现时整体下移、不重新 fitView（probe-clw-book 根节点 +71）。 */
const CANVAS_H = PANEL.h - CANVAS_TOP;
/** fitView({ padding: 0.2, maxZoom: 1 }) */
const FIT = 1 / 1.2;
const MAX_SCALE = 1;
/** 换结构：节点位移动画 + 300ms fitView。 */
const MORPH = 0.18;
const SEQ: LayoutId[] = ['mindRight', 'org', 'logic'];
const PICK: StructCell[] = ['orgDown', 'logicRight'];
const CURRENT: Array<{ cell: StructCell; name: string }> = [
  { cell: 'mindRight', name: S.mm.presetRight },
  { cell: 'orgDown', name: S.mm.presetOrg },
];
const LEAVES = MM_NODES.filter((n) => n.depth === 2).map((n) => n.id);
/** 逐个点开的三片叶子（自上而下），剩下的交给「全部揭示」。 */
const CLICKED = ['rolle1', 'lag1', 'lag2'];
/** 揭示：背景 300ms 渐变（transition-colors duration-300）。 */
const REVEAL_S = 0.15;

const pressAt = (t: number, at: number, w = 0.1) => Math.max(0, 1 - Math.abs(t - at) / w);

export const layoutAt = (t: number) => {
  let i = 0;
  while (i < MM.picks.length && t >= MM.picks[i]) i++;
  if (i === 0) return { from: SEQ[0], to: SEQ[0], k: 0 };
  return { from: SEQ[i - 1], to: SEQ[i], k: prog(t, MM.picks[i - 1], MM.picks[i - 1] + MORPH, ease.inOutCubic) };
};

const reciteRowH = (t: number) => (t < MM.reciteClick ? 0 : t < MM.maskClick ? MP.reciteTall : MP.reciteShort);

/** 面板内容从 PDF 换成导图的进度（同一个附件面板换内容）。 */
export const mindPanelK = (t: number) => prog(t, MM.open, MM.open + 0.06);

// ── 交互落点（世界坐标） ──────────────────────────────
const STRUCT_BTN = { x: IN_X + MP_BTN.structure.x, y: PANEL.y + MP_BTN.structure.y };
const RECITE_BTN = { x: IN_X + MP_BTN.recite.x, y: PANEL.y + MP_BTN.recite.y };
const MASK_BTN = { x: IN_X + MP_MASK_BTN.x, y: PANEL.y + CANVAS_TOP + MP_MASK_BTN.y };
const REVEAL_ALL_BTN = { x: IN_X + MP_REVEAL_ALL_BTN.x, y: PANEL.y + CANVAS_TOP + MP_REVEAL_ALL_BTN.y };
const cellWorld = (cell: StructCell) => {
  const c = structCellCenter(cell);
  return { x: IN_X + STRUCT_POP.x + c.x, y: PANEL.y + STRUCT_POP.y + c.y };
};
/** 遮盖后（背诵行一行高）逻辑图里某个节点的世界坐标。 */
const leafWorld = (id: string) => {
  const f = graphFrame('logic', 'logic', 1, IN_W, CANVAS_H, FIT, MAX_SCALE);
  const p = nodePos('logic', 'logic', 1, id);
  return { x: IN_X + IN_W / 2 + (p.x - f.cx) * f.scale, y: PANEL.y + CANVAS_TOP + MP.reciteShort + CANVAS_H / 2 + (p.y - f.cy) * f.scale };
};

/** 本段瞳点路径（[到达时刻, x, y]，世界坐标），接在对话里点「打开」之后。 */
export const ORGANIZE_PUPIL: Array<[number, number, number]> = (() => {
  const pts: Array<[number, number, number]> = [];
  const at = (time: number, p: { x: number; y: number }) => pts.push([time, p.x, p.y]);
  at(12.05, { x: PANEL.x + PANEL.w * 0.5, y: PANEL.y + 330 });
  MM.structClicks.forEach((s, i) => {
    at(s - 0.05, STRUCT_BTN);
    at(s + 0.06, STRUCT_BTN);
    at(MM.picks[i] - 0.05, cellWorld(PICK[i]));
    at(MM.picks[i] + 0.06, cellWorld(PICK[i]));
  });
  at(MM.reciteClick - 0.05, RECITE_BTN);
  at(MM.reciteClick + 0.06, RECITE_BTN);
  at(MM.maskClick - 0.05, MASK_BTN);
  at(MM.maskClick + 0.05, MASK_BTN);
  CLICKED.forEach((id, i) => {
    const p = leafWorld(id);
    at(MM.reveals[i] - 0.03, p);
    at(MM.reveals[i] + 0.04, p);
  });
  at(MM.revealAll - 0.05, REVEAL_ALL_BTN);
  at(MM.revealAll + 0.08, REVEAL_ALL_BTN);
  at(MM.close0, { x: REVEAL_ALL_BTN.x + 60, y: REVEAL_ALL_BTN.y + 90 });
  return pts;
})();
export const ORGANIZE_CLICKS = [...MM.structClicks, ...MM.picks, MM.reciteClick, MM.maskClick, ...MM.reveals, MM.revealAll];
export const organizePupilOpacity = (t: number) => 1 - prog(t, MM.close0 - 0.1, MM.close0);

/** 结构弹层：打开 250ms zoom-fade-in，点选后 150ms 淡出（ui-zoom-fade-in / out）。 */
const popoverAt = (t: number) => {
  for (let i = 0; i < MM.structClicks.length; i++) {
    const open = MM.structClicks[i];
    const close = MM.picks[i];
    if (t >= open && t < close + 0.075) {
      const kIn = prog(t, open, open + 0.125, ease.brand);
      const kOut = prog(t, close, close + 0.075, ease.brand);
      return { i, opacity: kIn * (1 - kOut), scale: t < close ? 0.97 + 0.03 * kIn : 1 - 0.01 * kOut };
    }
  }
  return null;
};

const revealK = (t: number, id: string) => {
  const i = CLICKED.indexOf(id);
  const at = i >= 0 ? MM.reveals[i] : MM.revealAll;
  return prog(t, at, at + REVEAL_S, ease.inOutCubic);
};

// ── 场景 ──────────────────────────────────────────────
export const MindmapPanel = ({ t, tk }: { t: number; tk: Tokens }) => {
  if (t < MM.open) return null;
  const L = layoutAt(t);
  const rowH = reciteRowH(t);
  const frame = graphFrame(L.from, L.to, L.k, IN_W, CANVAS_H, FIT, MAX_SCALE);
  const pop = popoverAt(t);

  const masked = t >= MM.maskClick;
  const revealed = Object.fromEntries(LEAVES.map((id) => [id, revealK(t, id)]));
  const count = MM.reveals.filter((r) => t >= r).length + (t >= MM.revealAll ? LEAVES.length - CLICKED.length : 0);
  const fill = LEAVES.reduce((s, id) => s + revealed[id], 0) / LEAVES.length;
  const recite = masked ? { active: true, whole: true, mask: prog(t, MM.maskClick, MM.maskClick + 0.02), revealed } : undefined;
  const rowIn = prog(t, MM.reciteClick, MM.reciteClick + 0.075, ease.brand);

  const mini = {
    nodes: MM_NODES.map((n): MiniRect => {
      const p = nodePos(L.from, L.to, L.k, n.id);
      const s = nodeSize(n);
      return { x: p.x - s.w / 2, y: p.y - s.h / 2, w: s.w, h: s.h, color: n.depth === 0 ? 'rgba(101, 105, 114, 0.7)' : nodeColor(n, tk.dark) };
    }),
    view: {
      x: frame.cx - IN_W / 2 / frame.scale,
      y: frame.cy - CANVAS_H / 2 / frame.scale,
      w: IN_W / frame.scale,
      h: (CANVAS_H - rowH) / frame.scale,
    },
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: PANEL.x,
        top: PANEL.y,
        width: PANEL.w,
        height: PANEL.h,
        boxSizing: 'border-box',
        background: tk.background,
        borderLeft: `1px solid ${tk.border}`,
        boxShadow: '-12px 0 32px rgba(0,0,0,0.08)',
        overflow: 'hidden',
        opacity: mindPanelK(t),
      }}
    >
      <div style={{ position: 'absolute', left: 0, top: CANVAS_TOP + rowH, width: IN_W, height: CANVAS_H }}>
        <MmCanvasDots />
        <MindmapGraph tk={tk} from={L.from} to={L.to} k={L.k} width={IN_W} height={CANVAS_H} fit={FIT} maxScale={MAX_SCALE} recite={recite} theme="editor" />
      </div>
      <MmCanvasControls h={PANEL.h} zoomPct={Math.round(frame.scale * 100)} mini={mini} />
      {rowH > 0 ? (
        <div style={{ position: 'absolute', left: 0, right: 0, top: CANVAS_TOP, height: rowH, opacity: rowIn, transform: `translateY(${(1 - rowIn) * -4}px)` }}>
          <MmReciteRow
            masked={masked}
            revealed={count}
            total={LEAVES.length}
            fill={fill}
            maskPress={pressAt(t, MM.maskClick, 0.08)}
            revealAllHover={prog(t, MM.revealAll - 0.06, MM.revealAll - 0.02)}
            revealAllPress={pressAt(t, MM.revealAll, 0.08)}
          />
        </div>
      ) : null}
      <MmPanelHeader title="微分中值定理" />
      <MmPanelToolbar
        structureActive={pop !== null && t < MM.picks[pop.i]}
        structurePress={Math.max(...MM.structClicks.map((s) => pressAt(t, s)))}
        recite={t >= MM.reciteClick}
        recitePress={pressAt(t, MM.reciteClick)}
      />
      {pop ? (
        <StructureGrid
          current={CURRENT[pop.i].cell}
          currentName={CURRENT[pop.i].name}
          hot={t >= MM.picks[pop.i] - 0.1 ? PICK[pop.i] : undefined}
          press={pressAt(t, MM.picks[pop.i], 0.08)}
          style={{ left: STRUCT_POP.x, top: STRUCT_POP.y, opacity: pop.opacity, transform: `scale(${pop.scale})`, transformOrigin: 'top center' }}
        />
      ) : null}
    </div>
  );
};

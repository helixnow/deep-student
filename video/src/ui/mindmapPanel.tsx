import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsVertical,
  BookOpen,
  Check,
  CornersOut,
  DotsThree,
  Eye,
  EyeSlash,
  FileText,
  Fire,
  GearSix,
  GitBranch,
  GitFork,
  Hand,
  MagnifyingGlass,
  Minus,
  Plus,
  SelectionPlus,
  SquaresFour,
  Users,
  X,
} from '@phosphor-icons/react';
import type { CSSProperties, ReactNode } from 'react';
import { font } from '../theme';
import { S } from '../strings';

/**
 * 03 整理：对话里点导图卡「打开」后，导图在会话右侧面板打开（MindmapCitationCard → CHAT_OPEN_ATTACHMENT_PREVIEW type=mindmap）。
 * 面板外壳几何取自真机（probe-clv-open / clw-* / clx-*，x 相对面板左缘、y 相对面板顶）。
 */
export const MP = { header: 40.5, toolbar: 36, reciteTall: 71, reciteShort: 39.5 } as const;
const FG = 'rgb(42, 45, 50)';
const MUTED = 'rgb(101, 105, 114)';
const PRI = 'rgb(30, 94, 184)';
const LINE = 'rgb(224, 224, 224)';
const SURFACE = 'rgb(252, 252, 252)';
const at = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x, top: y });

export const MmPanelHeader = ({ title }: { title: string }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: MP.header, boxSizing: 'border-box', borderBottom: '1px solid rgb(238, 238, 238)', background: '#fff', fontFamily: font.ui }}>
    <FileText size={16} color={MUTED} style={at(12.5, 12.3)} />
    <span style={{ ...at(35.5, 11.3), display: 'inline-flex', alignItems: 'baseline', gap: 7, whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 12, fontWeight: 500, lineHeight: '18px', color: FG }}>{title}</span>
      <span style={{ fontSize: 11, lineHeight: '16.5px', color: MUTED }}>({S.mm.typeLabel})</span>
    </span>
    <ArrowSquareOut size={14} color={MUTED} style={at(662.3, 13.3)} />
    <X size={16} color={MUTED} style={at(689.3, 12.3)} />
  </div>
);

/** 工具条按钮中心（面板坐标）：瞳点据此落点。 */
export const MP_BTN = { structure: { x: 519.5, y: 58 }, recite: { x: 590, y: 58 } } as const;

const IconBtn = ({ cx, active, press = 0, children }: { cx: number; active?: boolean; press?: number; children: ReactNode }) => (
  <span
    style={{
      ...at(cx - 14.5, 44),
      width: 29,
      height: 28,
      borderRadius: 5,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'rgb(59, 63, 69)',
      background: active ? 'rgb(240, 240, 240)' : 'transparent',
      transform: `scale(${1 - press * 0.1})`,
    }}
  >
    {children}
  </span>
);

/** 面板宽 720 时右侧只剩图标：切换结构 / 样式 | 背诵 / 隐藏已完成 / 搜索 | 更多。 */
export const MmPanelToolbar = ({ structureActive, structurePress = 0, structureTip = 0, recite, recitePress = 0 }: { structureActive: boolean; structurePress?: number; structureTip?: number; recite: boolean; recitePress?: number }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: MP.header + MP.toolbar, fontFamily: font.ui, pointerEvents: 'none' }}>
    <span style={{ position: 'absolute', left: 0, right: 0, top: MP.header + MP.toolbar - 1, height: 1, background: LINE }} />
    <span style={{ ...at(8.4, 44), width: 125.2, height: 28, boxSizing: 'border-box', borderRadius: 9, background: 'rgb(240, 240, 240)' }} />
    <FileText size={14} color={FG} style={at(23, 51)} />
    <span style={{ ...at(41, 49.8), fontSize: 11, fontWeight: 500, lineHeight: '16.5px', color: FG }}>{S.mm.outline}</span>
    <span style={{ ...at(68, 47), width: 63, height: 22, borderRadius: 7, background: '#fff', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)' }} />
    <GitFork size={14} color={FG} style={at(83.5, 51)} />
    <span style={{ ...at(101.8, 49.8), fontSize: 11, fontWeight: 500, lineHeight: '16.5px', color: FG }}>{S.mm.mindmap}</span>
    <span style={{ ...at(143.5, 51), width: 1, height: 14, background: LINE }} />
    <ArrowCounterClockwise size={16} color={MUTED} style={at(164, 50)} />
    <ArrowClockwise size={16} color="rgba(101, 105, 114, 0.45)" style={at(199, 50)} />
    <span style={{ ...at(223.5, 51), width: 1, height: 14, background: LINE }} />
    <span style={{ ...at(252.5, 55.5), width: 5, height: 5, borderRadius: 9999, background: 'rgba(101, 105, 114, 0.45)' }} />
    <span style={{ ...at(264.5, 53), fontSize: 11, fontWeight: 500, lineHeight: '11px', color: MUTED }}>{S.mm.saved}</span>
    <IconBtn cx={MP_BTN.structure.x} active={structureActive} press={structurePress}>
      <GitFork size={16} />
    </IconBtn>
    <IconBtn cx={550}>
      <GearSix size={16} />
    </IconBtn>
    <span style={{ ...at(570, 51), width: 1, height: 14, background: LINE }} />
    <IconBtn cx={MP_BTN.recite.x} active={recite} press={recitePress}>
      <BookOpen size={16} />
    </IconBtn>
    <IconBtn cx={621}>
      <EyeSlash size={16} />
    </IconBtn>
    <IconBtn cx={654}>
      <MagnifyingGlass size={16} />
    </IconBtn>
    <span style={{ ...at(675, 51), width: 1, height: 14, background: LINE }} />
    <IconBtn cx={697}>
      <DotsThree size={16} weight="bold" />
    </IconBtn>
    {structureTip > 0.001 ? (
      <span style={{ ...at(MP_BTN.structure.x - 35, 80), opacity: structureTip, height: 31.5, padding: '0 11px', boxSizing: 'border-box', borderRadius: 5, background: FG, color: '#fff', fontSize: 12, fontWeight: 500, lineHeight: '31.5px', whiteSpace: 'nowrap' }}>
        {S.mm.switchStructure}
      </span>
    ) : null}
  </div>
);

const RowBtn = ({ x, w, icon, label, disabled }: { x: number; w: number; icon?: ReactNode; label: string; disabled?: boolean }) => (
  <span style={{ ...at(x, 5.3), width: w, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: disabled ? 'rgba(101, 105, 114, 0.45)' : MUTED, whiteSpace: 'nowrap' }}>
    {icon}
    {label}
  </span>
);

/** 「一键遮住要点」按钮中心（背诵行坐标，行顶 = 工具条底）。 */
export const MP_MASK_BTN = { x: 88.5 + 125.5 / 2, y: 5.3 + 14 } as const;
/** 遮盖后「全部揭示」按钮中心（背诵行坐标）。 */
export const MP_REVEAL_ALL_BTN = { x: 392.5 + 99.5 / 2, y: 5.3 + 14 } as const;
/** --mm-warning：背诵图标与进度条。 */
const WARN = 'rgb(195, 136, 34)';

/**
 * 背诵模式行（ReciteStatusBar，probe-clw-book / clx-mask）：未遮盖时两行（一键遮住要点 / 手动挖空 | 难点优先 | 全部揭示 / 重新遮盖 + 第二行退出，后三项禁用）；
 * 遮盖后一行（进度条 + n/总 | 难点优先 | 全部揭示 / 重新遮盖 / 退出；80472a30d 起去掉同义的百分比与「剩余 N」）。
 */
export const MmReciteRow = ({ masked, revealed, total, fill, maskPress = 0, revealAllHover = 0, revealAllPress = 0 }: { masked: boolean; revealed: number; total: number; fill: number; maskPress?: number; revealAllHover?: number; revealAllPress?: number }) => {
  const h = masked ? MP.reciteShort : MP.reciteTall;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: h, background: SURFACE, borderBottom: `1px solid ${LINE}`, fontFamily: font.ui }}>
      <BookOpen size={16} color={WARN} style={at(10.5, 11.3)} />
      <span style={{ ...at(33.5, 10.3), fontSize: 12, fontWeight: 500, lineHeight: '18px', color: FG }}>{S.mm.recite}</span>
      {masked ? (
        <>
          <span style={{ ...at(88.5, 15.3), width: 84, height: 8, borderRadius: 9999, background: LINE, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', borderRadius: 9999, width: `${fill * 100}%`, background: WARN }} />
          </span>
          {revealAllHover > 0.001 ? (
            <span style={{ ...at(392.5, 5.3), width: 99.5, height: 28, borderRadius: 9, background: 'rgb(240, 240, 240)', opacity: revealAllHover, transform: `scale(${1 - revealAllPress * 0.06})` }} />
          ) : null}
          <span style={{ ...at(179.5, 11), fontSize: 11, lineHeight: '16.5px', color: MUTED, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {revealed}/{total}
          </span>
          <span style={{ ...at(270, 12.3), width: 1, height: 14, background: LINE }} />
          <RowBtn x={278} w={99.5} icon={<Fire size={14} />} label={S.mm.reviewStart} />
          <span style={{ ...at(384.5, 12.3), width: 1, height: 14, background: LINE }} />
          <RowBtn x={392.5} w={99.5} icon={<Eye size={14} />} label={S.mm.revealAll} />
          <RowBtn x={499} w={99.5} icon={<EyeSlash size={14} />} label={S.mm.resetAll} />
          <RowBtn x={605.5} w={73.5} icon={<X size={14} />} label={S.mm.exit} />
        </>
      ) : (
        <>
          <span style={{ ...at(88.5, 5.3), width: 125.5, height: 28, borderRadius: 9, background: maskPress > 0 ? 'rgb(240, 240, 240)' : 'transparent', transform: `scale(${1 - maskPress * 0.06})` }} />
          <RowBtn x={88.5} w={125.5} icon={<EyeSlash size={14} />} label={S.mm.maskAll} />
          <RowBtn x={221} w={78.5} label={S.mm.manualBlank} />
          <span style={{ ...at(306.5, 12.3), width: 1, height: 14, background: LINE }} />
          <RowBtn x={314.5} w={99.5} icon={<Fire size={14} />} label={S.mm.reviewStart} disabled />
          <span style={{ ...at(421, 12.3), width: 1, height: 14, background: LINE }} />
          <RowBtn x={429} w={99.5} icon={<Eye size={14} />} label={S.mm.revealAll} disabled />
          <RowBtn x={535.5} w={99.5} icon={<EyeSlash size={14} />} label={S.mm.resetAll} disabled />
          <span style={{ ...at(10.5, 36.8), height: 28, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: MUTED }}>
            <X size={14} />
            {S.mm.exit}
          </span>
        </>
      )}
    </div>
  );
};

// ── 选择结构（StructureSelector） ─────────────────────────
export type StructCell = 'mindRight' | 'mindLeft' | 'mindBoth' | 'logicRight' | 'logicLeft' | 'logicBoth' | 'logicRight2' | 'orgDown' | 'orgUp' | 'orgRight' | 'orgLeft';
const STRUCT_ROWS: Array<{ label: string; icon: ReactNode; cells: StructCell[] }> = [
  { label: S.mm.structMindmap, icon: <SquaresFour size={16} />, cells: ['mindRight', 'mindLeft', 'mindBoth'] },
  { label: S.mm.structLogic, icon: <GitBranch size={16} />, cells: ['logicRight', 'logicLeft', 'logicBoth', 'logicRight2'] },
  { label: S.mm.structOrg, icon: <Users size={16} />, cells: ['orgDown', 'orgUp', 'orgRight', 'orgLeft'] },
];
/** 80472a30d 去掉复述标题的底部提示（分隔线 + 一行字，25.5px） */
export const STRUCT_POP = { x: 245.5, y: 79, w: 288, h: 246 } as const;
const CELL_X = [8, 76.5, 145, 213.5];
const ROW_Y = [60, 130, 200];
/** 某格按钮中心（弹层坐标）。 */
export const structCellCenter = (cell: StructCell) => {
  const r = STRUCT_ROWS.findIndex((row) => row.cells.includes(cell));
  const c = STRUCT_ROWS[r].cells.indexOf(cell);
  return { x: CELL_X[c] + 33.25, y: ROW_Y[r] + 19 };
};

/** 结构缩略图（40×28）：根节点实心块 + 连线 + 子节点短条。 */
const Glyph = ({ cell, color }: { cell: StructCell; color: string }) => {
  const bar = (x: number, y: number) => <rect key={`${x}-${y}`} x={x} y={y} width={6} height={3.6} rx={1} fill={color} opacity={0.75} />;
  const elbow = (x0: number, y0: number, xm: number, ys: number[], x1: number) => <path d={ys.map((y) => `M${x0} ${y0} H${xm} V${y} H${x1}`).join(' ')} stroke={color} strokeWidth={1.3} fill="none" />;
  const curve = (x0: number, y0: number, ys: number[], x1: number) => <path d={ys.map((y) => `M${x0} ${y0} C${(x0 + x1) / 2} ${y0} ${(x0 + x1) / 2} ${y} ${x1} ${y}`).join(' ')} stroke={color} strokeWidth={1.3} fill="none" />;
  const ys = [6.8, 14, 21.2];
  let body: ReactNode;
  switch (cell) {
    case 'mindRight':
      body = <>{curve(14, 14, ys, 27)}<rect x={3} y={11} width={11} height={6} rx={1.5} fill={color} />{ys.map((y) => bar(28, y - 1.8))}</>;
      break;
    case 'mindLeft':
      body = <>{curve(26, 14, ys, 13)}<rect x={26} y={11} width={11} height={6} rx={1.5} fill={color} />{ys.map((y) => bar(6, y - 1.8))}</>;
      break;
    case 'mindBoth':
      body = <>{curve(14.5, 14, [8, 20], 9)}{curve(25.5, 14, [8, 20], 31)}<rect x={14.5} y={11} width={11} height={6} rx={1.5} fill={color} />{[8, 20].map((y) => bar(2.5, y - 1.8))}{[8, 20].map((y) => bar(31.5, y - 1.8))}</>;
      break;
    case 'logicRight':
    case 'logicRight2':
      body = <>{elbow(14, 14, cell === 'logicRight' ? 20 : 17, ys, 27)}<rect x={3} y={11} width={11} height={6} rx={1.5} fill={color} />{ys.map((y) => bar(28, y - 1.8))}</>;
      break;
    case 'logicLeft':
      body = <>{elbow(26, 14, 20, ys, 13)}<rect x={26} y={11} width={11} height={6} rx={1.5} fill={color} />{ys.map((y) => bar(6, y - 1.8))}</>;
      break;
    case 'logicBoth':
      body = <>{elbow(14.5, 14, 11, [8, 20], 9)}{elbow(25.5, 14, 29, [8, 20], 31)}<rect x={14.5} y={11} width={11} height={6} rx={1.5} fill={color} />{[8, 20].map((y) => bar(2.5, y - 1.8))}{[8, 20].map((y) => bar(31.5, y - 1.8))}</>;
      break;
    case 'orgDown':
      body = <><path d="M20 9 V14 M8 14 H32 M8 14 V19 M20 14 V19 M32 14 V19" stroke={color} strokeWidth={1.3} fill="none" /><rect x={14.5} y={3} width={11} height={6} rx={1.5} fill={color} />{[5, 17, 29].map((x) => bar(x, 19.5))}</>;
      break;
    case 'orgUp':
      body = <><path d="M20 19 V14 M8 14 H32 M8 14 V9 M20 14 V9 M32 14 V9" stroke={color} strokeWidth={1.3} fill="none" /><rect x={14.5} y={19} width={11} height={6} rx={1.5} fill={color} />{[5, 17, 29].map((x) => bar(x, 4.9))}</>;
      break;
    case 'orgRight':
      body = <>{elbow(15, 14, 21, ys, 27)}<rect x={2} y={10.5} width={13} height={7} rx={1.5} fill={color} />{ys.map((y) => bar(28, y - 1.8))}</>;
      break;
    case 'orgLeft':
      body = <>{elbow(25, 14, 19, ys, 13)}<rect x={25} y={10.5} width={13} height={7} rx={1.5} fill={color} />{ys.map((y) => bar(6, y - 1.8))}</>;
      break;
  }
  return (
    <svg width={40} height={28} viewBox="0 0 40 28">
      {body}
    </svg>
  );
};

/** 选择结构弹层：标题 + 右上「当前: 预设名」（预设名主色加粗）、三类结构格；点选即关闭（StructureSelector handlePresetSelect）。 */
export const StructureGrid = ({ current, currentName, hot, press = 0, style }: { current: StructCell; currentName: string; hot?: StructCell; press?: number; style?: CSSProperties }) => (
  <div style={{ position: 'absolute', width: STRUCT_POP.w, height: STRUCT_POP.h, boxSizing: 'border-box', borderRadius: 12, background: SURFACE, border: `1px solid ${LINE}`, boxShadow: '0 12px 32px rgba(0, 0, 0, 0.12)', fontFamily: font.ui, ...style }}>
    <span style={{ ...at(11, 7.3), fontSize: 15, fontWeight: 600, lineHeight: '22.5px', color: FG }}>{S.mm.selectStructure}</span>
    <span style={{ position: 'absolute', right: 11, top: 10.3, fontSize: 11, lineHeight: '16.5px', color: MUTED, whiteSpace: 'nowrap' }}>
      {S.mm.structureCurrent} <span style={{ color: PRI, fontWeight: 500 }}>{currentName}</span>
    </span>
    {STRUCT_ROWS.map((row, r) => (
      <div key={row.label}>
        <span style={{ ...at(11, ROW_Y[r] - 21), color: MUTED, display: 'inline-flex' }}>{row.icon}</span>
        <span style={{ ...at(33, ROW_Y[r] - 22), fontSize: 13, fontWeight: 600, lineHeight: '20px', color: MUTED }}>{row.label}</span>
        {row.cells.map((cell, c) => {
          const on = cell === current;
          const isHot = cell === hot && !on;
          return (
            <span
              key={cell}
              style={{
                ...at(CELL_X[c] - 1, ROW_Y[r] - 1),
                width: 66.5,
                height: 38,
                borderRadius: 5,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: on ? 'rgba(30, 94, 184, 0.1)' : isHot ? 'rgb(240, 240, 240)' : 'transparent',
                transform: cell === hot ? `scale(${1 - press * 0.05})` : undefined,
              }}
            >
              <Glyph cell={cell} color={on ? PRI : MUTED} />
              {on ? <Check size={12} weight="bold" color={PRI} style={{ position: 'absolute', right: 3, top: 3 }} /> : null}
            </span>
          );
        })}
      </div>
    ))}
  </div>
);

/** 画布点阵底（React Flow Background：Dots，gap 20、size 1、--mm-text-muted、opacity 0.3）。 */
export const MmCanvasDots = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      backgroundImage: 'radial-gradient(circle, rgba(101, 105, 114, 0.7) 0.6px, transparent 1px)',
      backgroundSize: '20px 20px',
      backgroundPosition: '10px 10px',
      opacity: 0.3,
    }}
  />
);

export type MiniRect = { x: number; y: number; w: number; h: number; color: string };
const MINI = { w: 104, h: 68 } as const;

/** 小地图（React Flow MiniMap 104×68）：节点按分支色画实心块，视口外罩 foreground / 0.08。坐标均为图坐标。 */
const MmMiniMap = ({ nodes, view }: { nodes: MiniRect[]; view: Omit<MiniRect, 'color'> }) => {
  let x0 = view.x;
  let y0 = view.y;
  let x1 = view.x + view.w;
  let y1 = view.y + view.h;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w);
    y1 = Math.max(y1, n.y + n.h);
  }
  const s = Math.min(MINI.w / (x1 - x0), MINI.h / (y1 - y0));
  const ox = (MINI.w - (x1 - x0) * s) / 2 - x0 * s;
  const oy = (MINI.h - (y1 - y0) * s) / 2 - y0 * s;
  const R = (r: Omit<MiniRect, 'color'>) => ({ x: ox + r.x * s, y: oy + r.y * s, width: r.w * s, height: r.h * s });
  const v = R(view);
  return (
    <svg width={MINI.w} height={MINI.h} style={{ position: 'absolute', left: 0, top: 0 }}>
      {nodes.map((n, i) => (
        <rect key={i} {...R(n)} rx={5 * s} fill={n.color} />
      ))}
      <path d={`M0 0H${MINI.w}V${MINI.h}H0Z M${v.x} ${v.y}v${v.height}h${v.width}v${-v.height}Z`} fill="rgba(42, 45, 50, 0.08)" fillRule="evenodd" />
    </svg>
  );
};

/** 画布浮层：左下 + / − / 适应，右下小地图，底部「框选 | 拖动画布 | 滚轮缩放 | 百分比」。h = 面板高。 */
export const MmCanvasControls = ({ h, zoomPct, mini }: { h: number; zoomPct: number; mini: { nodes: MiniRect[]; view: Omit<MiniRect, 'color'> } }) => (
  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: font.ui }}>
    <span style={{ ...at(17, h - 96), width: 28, height: 80, boxSizing: 'border-box', borderRadius: 6, background: SURFACE, border: `1px solid ${LINE}` }} />
    <Plus size={12} color={FG} style={at(25, h - 88.5)} />
    <Minus size={12} color={FG} style={at(25, h - 62.4)} />
    <CornersOut size={12} color={FG} style={at(25, h - 35.6)} />
    <span style={{ ...at(718 - 8 - MINI.w, h - 47 - MINI.h), width: MINI.w, height: MINI.h, boxSizing: 'border-box', borderRadius: 6, background: SURFACE, border: `1px solid ${LINE}`, overflow: 'hidden' }}>
      <MmMiniMap nodes={mini.nodes} view={mini.view} />
    </span>
    <span style={{ ...at(427.9, h - 39), width: 284.1, height: 30, boxSizing: 'border-box', borderRadius: 6, background: SURFACE, border: `1px solid ${LINE}`, color: FG }}>
      <SelectionPlus size={15} style={at(9, 6.5)} />
      <span style={{ ...at(29, 8.5), fontSize: 11, fontWeight: 500, lineHeight: '11px' }}>{S.mm.selectMode}</span>
      <span style={{ ...at(60, 2), width: 78, height: 24, borderRadius: 4, background: 'rgba(30, 94, 184, 0.1)' }} />
      <Hand size={15} weight="fill" color={PRI} style={at(67, 6.5)} />
      <span style={{ ...at(87, 8.5), fontSize: 11, fontWeight: 600, lineHeight: '11px', color: PRI }}>{S.mm.panMode}</span>
      <span style={{ ...at(142, 7), width: 1, height: 14, background: LINE }} />
      <ArrowsVertical size={15} style={at(154, 6.5)} />
      <span style={{ ...at(174, 8.5), fontSize: 11, fontWeight: 500, lineHeight: '11px' }}>滚轮缩放</span>
      <span style={{ ...at(226, 7), width: 1, height: 14, background: LINE }} />
      <span style={{ position: 'absolute', right: 10, top: 8.5, fontSize: 11, fontWeight: 600, lineHeight: '11px', fontVariantNumeric: 'tabular-nums' }}>{zoomPct}%</span>
    </span>
  </div>
);

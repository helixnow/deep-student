import { ArrowCounterClockwise, ArrowLeft, ArrowRight, BookOpen, CaretDown, CaretRight, DotsThree, FileText, FolderSimple, List, MagnifyingGlass, Plus, Robot, TreeStructure, X } from '@phosphor-icons/react';
import { Easing } from 'remotion';
import type { CSSProperties, ReactNode } from 'react';
import { font } from '../theme';
import { HANDOUT_TITLE, LectureSlide, SLIDE_H, SLIDE_W } from './media';
import { FG, LINE, MUTED, NOTE_TITLE, PRI, T as WinT } from './research';

/** resource 的 at / research 的 T 吃窗口坐标（内部扣 (1, 39)）；本文件写标题栏坐标与内容坐标，不再扣 */
const at = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x, top: y });
const T = (p: Parameters<typeof WinT>[0]) => <WinT {...p} x={p.x + 1} y={p.y + 39} />;

/**
 * 08 笔记：调研报告存成的笔记在笔记应用（workbench apps/notes，默认 1240×760）里打开；
 * 对话里让 AI 改「主要发现」→ 笔记窗 clean，note_replace 走前端直写（noteDriver applyDestructiveDirect，约 90ms）：
 * 窗口标题栏下 AgentStrip（正在操作 → 已完成，保留 4s 后收拢）、首个改动段落蓝色渐隐 1.1s、
 * 编辑器顶部「AI 刚修改了这篇笔记 · 撤销本次修改」。
 * 几何取自真机 DOM 取证：probe-nt-note-1（打开时）、probe-nx-strip / probe-nx-after（stageManager 真跑 apply_ops 后）；
 * 标题栏内容用标题栏坐标（窗口坐标 − (1, 1)），内容区用内容坐标（窗口坐标 − (1, 39)）。
 */
export const NOTES_W = 1240;
export const NOTES_H = 760;

const EXPLORER_BG = 'rgb(250, 250, 250)';
const SOFT = 'rgba(42, 45, 50, 0.05)';
const SEL = 'rgba(42, 45, 50, 0.1)';
const LIST_NUM = 'rgba(42, 45, 50, 0.6)';
/** AgentStrip：min-height 28 + 下边框 1；出现时整个应用内容下移这么多 */
const STRIP_H = 29;
/** 撤销条（notes-ai-checkpoint-bar）高 39.5，编辑器头部 36 → 40.5，正文下移 4.5 */
const BAR_H = 39.5;
const BAR_DY = 4.5;
/** canvas_executor build_note_agent_op 的 label（模式 = 正则 search 的字符数） */
const STRIP_LABEL = '替换笔记内容（模式长度 33）';
const pri = (a: number) => `rgba(30, 94, 184, ${a})`;
const info = (a: number) => `rgba(38, 107, 217, ${a})`;
const success = (a: number) => `rgba(37, 147, 95, ${a})`;
const SUCCESS = 'rgb(37, 147, 95)';
/** .agent-flash：info/0.3 → 0，1.1s CSS ease-out */
const flashEase = Easing.bezier(0, 0, 0.58, 1);
export const NOTE_FLASH_S = 1.1;

export const NotesTitlebar = ({ saving, title = NOTE_TITLE }: { saving: boolean; title?: string }) => (
  <>
    <span style={{ ...at(272, 0), width: 200, height: 37, background: '#fff' }}>
      <FileText size={13} color={MUTED} style={at(10, 12)} />
      <span style={{ ...at(26.2, 12), width: 141.8, fontSize: 13, fontWeight: 500, lineHeight: '13px', color: FG, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      <X size={12} color={MUTED} style={at(177, 12.5)} />
    </span>
    <List size={16} color={MUTED} style={at(962, 11)} />
    <span style={{ ...at(996.8, 13), fontSize: 11, fontWeight: 500, lineHeight: '11px', color: 'rgba(101, 105, 114, 0.55)', whiteSpace: 'nowrap' }}>{saving ? '保存中…' : '已保存'}</span>
    <span style={{ ...at(1037, 4.5), width: 62, height: 28, display: 'inline-flex', alignItems: 'center', gap: 5, paddingLeft: 10, boxSizing: 'border-box', fontSize: 12, fontWeight: 500, color: MUTED }}>
      <BookOpen size={14} />
      阅读
    </span>
    <span style={{ ...at(1101, 4.5), width: 59, height: 28, display: 'inline-flex', alignItems: 'center', gap: 4, paddingLeft: 9, boxSizing: 'border-box', fontSize: 12, fontWeight: 500, color: MUTED }}>
      页面
      <CaretDown size={10} />
    </span>
  </>
);

// ── 左栏：文件树 ──────────────────────────────────────
type TreeNode = { name: string; mindmap?: boolean; selected?: boolean };
/** 资料库根目录（新建的笔记排在第 2 位）：音视频那段只多了讲义，调研那段再多出调研报告 */
export const TREE_HANDOUT: TreeNode[] = [{ name: '中值定理证明套路' }, { name: HANDOUT_TITLE, selected: true }, { name: '微分中值定理', mindmap: true }, { name: '高数错题本（8 月）' }];
const TREE_RESEARCH: TreeNode[] = [{ name: '中值定理证明套路' }, { name: NOTE_TITLE, selected: true }, { name: HANDOUT_TITLE }, { name: '微分中值定理', mindmap: true }, { name: '高数错题本（8 月）' }];
const treeY = (i: number) => 206.7 + 30 * i;

const Explorer = ({ tree }: { tree: TreeNode[] }) => (
  <div style={{ ...at(0, 0), width: 271, height: 720, background: EXPLORER_BG, borderRight: `1px solid ${LINE}` }}>
    <T x={12} y={10.6} size={12} weight={600} lh={16.8} color={MUTED}>
      文件
    </T>
    <ArrowLeft size={14} color={MUTED} style={{ ...at(95, 12), opacity: 0.45 }} />
    <ArrowRight size={14} color={MUTED} style={{ ...at(118, 12), opacity: 0.45 }} />
    <Plus size={12} color={FG} weight="bold" style={at(178, 13)} />
    <T x={193} y={10.6} size={12} weight={500} lh={16.8}>
      新建
    </T>
    <CaretDown size={10} color={FG} style={at(220, 14.5)} />
    <DotsThree size={16} color={MUTED} weight="bold" style={at(243, 11)} />
    <div style={{ ...at(8, 38), width: 255, height: 30, boxSizing: 'border-box', borderRadius: 5, background: SOFT, border: '1px solid rgba(224, 224, 224, 0.6)' }}>
      <MagnifyingGlass size={13} color={MUTED} style={at(8, 7.5)} />
      <T x={25} y={5.5} size={13} lh={18.2} color={MUTED}>
        搜索文件...
      </T>
    </div>
    <CaretRight size={10} color={MUTED} style={at(8, 79)} />
    <T x={19} y={76} size={12} weight={600} lh={16.8} color={MUTED}>
      标签筛选
    </T>
    <T x={235} y={76} size={12} lh={16.8} color={MUTED}>
      清空
    </T>
    <CaretRight size={10} color={MUTED} style={at(12, 109.5)} />
    <T x={26} y={107.1} size={11} weight={600} lh={15.4} color={MUTED}>
      灵感
    </T>
    <T x={257.6} y={107.1} size={11} weight={500} lh={15.4} color={MUTED}>
      0
    </T>
    <div style={{ ...at(10, 133.8), width: 251, height: 28, borderRadius: 7, background: SOFT }}>
      {['文件树', '笔记列表', '掌握状态', '近期复习'].map((label, i) => (
        <span
          key={label}
          style={{
            ...at(2 + i * 62.25, 2),
            width: 60.3,
            height: 24,
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            color: i === 0 ? FG : MUTED,
            background: i === 0 ? '#fff' : 'transparent',
            boxShadow: i === 0 ? '0 1px 2px rgba(0, 0, 0, 0.1)' : undefined,
          }}
        >
          {label}
        </span>
      ))}
    </div>
    <div style={{ ...at(6, 172.8), width: 259, height: 26, borderRadius: 5, background: 'rgba(30, 94, 184, 0.14)' }}>
      <FolderSimple size={13} color={FG} weight="fill" style={at(9, 6.5)} />
      <T x={27} y={5.3} size={11} weight={500} lh={15.4}>
        资料库根目录
      </T>
    </div>
    {tree.map((n, i) => (
      <div key={n.name}>
        {n.selected ? <span style={{ ...at(0, treeY(i) - 5.9), width: 271, height: 30, borderRadius: 6, background: SEL }} /> : null}
        {n.mindmap ? <TreeStructure size={15} color={MUTED} style={at(57, treeY(i) + 1.6)} /> : <FileText size={15} color={MUTED} style={at(57, treeY(i) + 1.6)} />}
        <span style={{ ...at(78, treeY(i)), width: n.mindmap ? 166 : 139, fontSize: 13, fontWeight: n.selected ? 500 : 400, lineHeight: '18.2px', color: FG, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
      </div>
    ))}
  </div>
);

// ── 正文 ──────────────────────────────────────────────
const H2 = ({ y, children }: { y: number; children: ReactNode }) => (
  <T x={401} y={y} size={24} weight={600} lh={31.2}>
    {children}
  </T>
);
const H3 = ({ y, children }: { y: number; children: ReactNode }) => (
  <T x={401} y={y} size={20} weight={600} lh={26}>
    {children}
  </T>
);
/** 段落：块高 32、行高 24，文字顶比块顶低 4。 */
const Para = ({ x = 401, y, children }: { x?: number; y: number; children: ReactNode }) => (
  <span style={{ ...at(x, y + 4), width: 1109 - x, fontSize: 16, lineHeight: '24px', color: FG }}>{children}</span>
);

/** 「主要发现」三条：原稿两行 / 两行 / 一行，AI 改写后各一行（与取证的 note_replace 同文）。 */
const FINDINGS_OLD = [
  '形式化证明成为主流路线：模型负责搜索证明路径，Lean 等证明助手逐步验证，结论可机器检查 [搜索-1][搜索-2]',
  '过程监督比只看最终答案更可靠：对推理链逐步打分，竞赛题准确率与可解释性同时提升 [搜索-3]',
  '检索增强适合本科分析学：先检索可用的定理与引理，再组织证明 [知识库-1]',
];
const FINDINGS_NEW = [
  '形式化证明：模型提出思路，Lean 逐步验证，结论可机器检查 [搜索-1][搜索-2]',
  '过程监督：给推理链逐步打分，比只看最终答案更可靠 [搜索-3]',
  '检索增强：先找可用的定理与引理，再组织证明 [知识库-1]',
];
const ROWS_OLD = [2, 2, 1];

/** 直改后 noteDriver 用首个差异行定位承载段落（主要发现第 1 条），整段文字底色渐隐 */
const Document = ({ applied, flashS }: { applied: boolean; flashS: number }) => {
  const rows = applied ? [1, 1, 1] : ROWS_OLD;
  const items = applied ? FINDINGS_NEW : FINDINGS_OLD;
  const flash = applied && flashS >= 0 && flashS < NOTE_FLASH_S ? 0.3 * (1 - flashEase(flashS / NOTE_FLASH_S)) : 0;
  let y = 366.8;
  const list = items.map((text, i) => {
    const top = y;
    y += 8 + rows[i] * 24;
    return (
      <div key={i}>
        <span style={{ ...at(401, top + 4), width: 24, fontSize: 16, lineHeight: '24px', color: LIST_NUM }}>{i + 1}.</span>
        <Para x={435} y={top}>
          {i === 0 && flash > 0 ? <span style={{ borderRadius: 2, background: info(flash) }}>{text}</span> : text}
        </Para>
      </div>
    );
  });
  const dy = y - (366.8 + 8 * 3 + 5 * 24);
  return (
    <>
      <T x={401} y={105} size={40} weight={700} lh={48}>
        {NOTE_TITLE}
      </T>
      <H2 y={196.8}>📋 调研概述</H2>
      {[238.4, 270.4].map((by) => (
        <span key={by} style={{ ...at(411, by + 13.5), width: 5.5, height: 5.5, borderRadius: '50%', background: FG }} />
      ))}
      <Para x={435} y={238.4}>
        <b style={{ fontWeight: 700 }}>调研时间</b>：2026 年 10 月
      </Para>
      <Para x={435} y={270.4}>
        <b style={{ fontWeight: 700 }}>调研范围</b>：大模型在数学证明中的三种用法——形式化证明、过程监督与自我验证、检索增强
      </Para>
      <H2 y={325.2}>🔍 主要发现</H2>
      {list}
      <H2 y={533.5 + dy}>📊 详细分析</H2>
      <H3 y={584.7 + dy}>形式化证明</H3>
      <Para y={621.1 + dy}>把定理翻译成 Lean / Isabelle 代码，证明助手负责验证每一步，模型只需提出下一步策略……</Para>
      <H3 y={669.1 + dy}>过程监督与自我验证</H3>
      <Para y={705.5 + dy}>奖励模型对每一步推理打分，配合自我验证在生成后回查……</Para>
      <H2 y={762.1 + dy}>💡 结论与建议</H2>
    </>
  );
};

// ── AgentStrip（WindowShell 标题栏下的细条，agent-visuals.css） ─────────────
const StripBtn = ({ x, label, enabled }: { x: number; label: string; enabled: boolean }) => (
  <span style={{ ...at(x, 3), width: 40, height: 22, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 500, color: MUTED, opacity: enabled ? 1 : 0.5 }}>
    {label}
  </span>
);

/** host 行高 0fr↔1fr（200ms）裁出条；条自身入场淡入 + 下落 4px（240ms）。acting 双色 tint，done 绿 tint（撤销可点）。 */
const AgentStrip = ({ k, enter, done }: { k: number; enter: number; done: boolean }) => (
  <div style={{ ...at(0, 0), width: NOTES_W - 2, height: STRIP_H * k, overflow: 'hidden' }}>
    <div
      style={{
        ...at(0, 0),
        width: NOTES_W - 2,
        height: STRIP_H,
        boxSizing: 'border-box',
        borderBottom: '1px solid rgba(224, 224, 224, 0.45)',
        background: done
          ? `linear-gradient(180deg, ${success(0.12)} 0%, ${success(0.07)} 100%)`
          : `linear-gradient(100deg, ${pri(0.12)} 0%, ${info(0.09)} 60%, ${pri(0.07)} 100%)`,
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.22)',
        opacity: enter,
        transform: `translateY(${(1 - enter) * -4}px)`,
      }}
    >
      <span style={{ ...at(10, 10.5), width: 7, height: 7, borderRadius: 999, background: done ? SUCCESS : PRI, boxShadow: done ? undefined : `0 0 6px ${pri(0.45)}` }} />
      <span style={{ ...at(25, 6.8), fontSize: 12, lineHeight: '14.4px', color: FG, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {done ? 'AI 已完成操作' : `AI 正在操作：${STRIP_LABEL}`}
      </span>
      <StripBtn x={1100} label="暂停" enabled={!done} />
      <StripBtn x={1144} label="停止" enabled={!done} />
      <StripBtn x={1188} label="撤销" enabled={done} />
    </div>
  </div>
);

// ── 撤销条（NotesCrepeEditor notes-ai-checkpoint-bar，ui-rise-in 150ms） ─────────
const CheckpointBar = ({ k }: { k: number }) => (
  <div style={{ ...at(0, (1 - k) * 4), width: 966, height: BAR_H, boxSizing: 'border-box', borderTop: '1px solid rgba(224, 224, 224, 0.5)', background: pri(0.05), opacity: k }}>
    <Robot size={14} color={PRI} style={at(129, 13.3)} />
    <T x={150} y={12.5} size={11} lh={15.4}>
      AI 刚修改了这篇笔记
    </T>
    <span style={{ ...at(694, 7.1), width: 111.5, height: 26.3, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11, fontWeight: 500, color: MUTED }}>
      <ArrowCounterClockwise size={12} />
      撤销本次修改
    </span>
    <span style={{ ...at(809, 6.3), width: 28, height: 28, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: MUTED }}>
      <X size={12} />
    </span>
  </div>
);

export type NotesState = {
  /** note_replace 已写入（setMarkdown 整篇瞬变） */
  applied: boolean;
  /** 写入后经过的真实秒数（改动段落 1.1s 渐隐）；未写入为负 */
  flashS: number;
  /** AgentStrip host 行高 0→1（presence 出现 200ms 展开、清除后 200ms 收拢） */
  strip: number;
  /** AgentStrip 自身入场 0→1（240ms） */
  stripEnter: number;
  /** presence：acting（约 90ms）→ done（保留 4s 供撤销） */
  stripDone: boolean;
  /** 撤销条入场 0→1；出现后编辑器头部长 4.5px */
  bar: number;
};

/** 音视频「生成讲义」存成的笔记（handoutToMarkdown：标题 / 摘要 / 分节标题 + [媒体@…] 锚点 / 正文 / 配图 + 图注），scroll 为正文滚动量 */
const HandoutDoc = ({ scroll }: { scroll: number }) => {
  const figW = 708;
  const figH = (figW * SLIDE_H) / SLIDE_W;
  return (
    <div style={{ position: 'absolute', left: 0, top: -scroll, width: NOTES_W, height: 1400 }}>
      <T x={401} y={105} size={40} weight={700} lh={48}>
        {HANDOUT_TITLE}
      </T>
      <Para y={170}>本节回答「什么样的矩阵能相似对角化」：从定理 5.6 的特征向量判据出发，给出特征值互异的充分条件，再用几何重数与代数重数处理重特征值，最后以例 5.9 走完整个判断与求 P 的流程。</Para>
      <H2 y={262}>一、相似对角化与判定定理</H2>
      {/* crepe mediaRef 插件：[媒体@id:mm:ss] 原文保留，primary 色 + primary/8 底 */}
      <Para y={305}>
        <span style={{ color: PRI, background: pri(0.08), borderRadius: 4, padding: '0 2px', fontVariantNumeric: 'tabular-nums' }}>[媒体@file_la5p4k7W:00:00]</span>
      </Para>
      <Para y={341}>矩阵 A 能相似对角化，等价于能找到 n 个线性无关的特征向量；把它们排成 P，P⁻¹AP 就是以对应特征值为对角元的 Λ。</Para>
      <H3 y={405}>定理 5.6</H3>
      <Para y={441}>n 阶矩阵 A 可对角化，当且仅当 A 有 n 个线性无关的特征向量。把 AP = PΛ 按列拆开，第 i 列正是 Aξᵢ = λᵢξᵢ；P 可逆恰好要求这些列线性无关。</Para>
      <div style={{ ...at(401, 513), width: figW, height: figH, borderRadius: 8, overflow: 'hidden', boxShadow: `0 0 0 1px ${LINE}` }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: SLIDE_W, height: SLIDE_H, transform: `scale(${figW / SLIDE_W})`, transformOrigin: '0 0' }}>
          <LectureSlide pos={50} />
        </div>
      </div>
      <Para y={513 + figH + 8}>
        <i>图 1 定理 5.6 与 P、Λ 的构成</i>
      </Para>
      <span style={{ ...at(411, 513 + figH + 64 + 13.5), width: 5.5, height: 5.5, borderRadius: '50%', background: FG }} />
      <Para x={435} y={513 + figH + 64}>
        P 的第 i 列与 Λ 的第 i 个对角元一一对应，顺序要一致
      </Para>
    </div>
  );
};

export const HandoutNotesView = ({ scroll }: { scroll: number }) => (
  <div style={{ position: 'absolute', inset: 0, fontFamily: font.sys, background: '#fff', overflow: 'hidden' }}>
    <Explorer tree={TREE_HANDOUT} />
    <div style={{ ...at(272, 0), width: 966, height: 698, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: -272, top: 0, width: NOTES_W, height: NOTES_H }}>
        <HandoutDoc scroll={scroll} />
      </div>
    </div>
    <div style={{ ...at(272, 698), width: 966, height: 22, boxSizing: 'border-box', borderTop: `1px solid ${LINE}`, background: 'rgba(240, 240, 240, 0.26)' }}>
      <T x={9} y={2.8} size={11} lh={15.4} color={MUTED}>
        {TREE_HANDOUT.length} 个文件
      </T>
    </div>
  </div>
);

export const NotesView = ({ s }: { s: NotesState }) => (
  <div style={{ position: 'absolute', inset: 0, fontFamily: font.sys, background: '#fff', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', left: 0, top: STRIP_H * s.strip, width: NOTES_W - 2, height: NOTES_H - 40 }}>
      <Explorer tree={TREE_RESEARCH} />
      <div style={{ ...at(272, 0), width: 966, height: 698, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: -272, top: s.bar > 0 ? BAR_DY : 0, width: NOTES_W, height: NOTES_H }}>
          <Document applied={s.applied} flashS={s.flashS} />
        </div>
        {s.bar > 0 ? <CheckpointBar k={s.bar} /> : null}
      </div>
      <div style={{ ...at(272, 698), width: 966, height: 22, boxSizing: 'border-box', borderTop: `1px solid ${LINE}`, background: 'rgba(240, 240, 240, 0.26)' }}>
        <T x={9} y={2.8} size={11} lh={15.4} color={MUTED}>
          {TREE_RESEARCH.length} 个文件
        </T>
      </div>
    </div>
    {s.strip > 0 ? <AgentStrip k={s.strip} enter={s.stripEnter} done={s.stripDone} /> : null}
  </div>
);

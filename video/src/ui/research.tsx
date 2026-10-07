import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsClockwise,
  ArrowUp,
  BookOpen,
  Brain,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChartLineUp,
  ChatCircleDots,
  Check,
  CheckCircle,
  CircleNotch,
  ClipboardText,
  Clock,
  ClockCounterClockwise,
  Copy,
  Database,
  Desktop,
  DotsThree,
  DownloadSimple,
  File as FileIcon,
  FilePlus,
  Files,
  FileText,
  FolderPlus,
  FunnelSimple,
  GearSix,
  Globe,
  HardDrive,
  Info,
  Lightning,
  List,
  ListChecks,
  MagnifyingGlass,
  Microphone,
  Notebook,
  PenNib,
  Plus,
  SortAscending,
  SquaresFour,
  Star,
  Stop,
  Translate,
  Trash,
  WarningCircle,
  WarningDiamond,
  Wrench,
  type Icon,
} from '@phosphor-icons/react';
import deepseekIcon from '@app-public/icons/providers/deepseek.svg';
import { ACTIVITY_GAP_EXTRA } from './chat';
import { StudyChatIcon } from '@app/components/icons/StudySidebarIcons';
import essayIcon from '@app/features/workbench/icons/app-icons/essay.svg';
import examIcon from '@app/features/workbench/icons/app-icons/exam.svg';
import fileIcon from '@app/features/workbench/icons/app-icons/file.svg';
import mindmapIcon from '@app/features/workbench/icons/app-icons/mindmap.svg';
import notesIcon from '@app/features/workbench/icons/app-icons/notes.svg';
import textbookIcon from '@app/features/workbench/icons/app-icons/textbook.svg';
import translationIcon from '@app/features/workbench/icons/app-icons/translation.svg';
import type { CSSProperties, ReactNode } from 'react';
import { Img } from 'remotion';
import { clamp, ease, PACE } from '../lib/time';
import { font, type Tokens } from '../theme';
import { LogoMark } from './brand';
import { at } from './resource';

/**
 * 08 调研：对话应用（ChatAppWindow + ModernSidebar + ChatV2Page）与资源库（Finder 式 files 应用）。
 * 走产品真实链路：新对话空态 → `/res` 技能命令补全 → 发送（令牌被剥掉、激活调研模式）→ 加载技能组 → ask_user 选深度
 * → 任务面板逐条打勾（完成后不会自动收起）→ 手动收起看回答 → 首轮结束自动起名 → 追问论文 → arXiv 结果 → 论文下载卡；
 * 资源库打开是「全部文件」网格，点侧栏「知识库索引」看索引状态。
 * 几何取自真机 DOM 取证（video/out/cap/probe-rc-*.txt、probe-rcp-*.txt、probe-hd-*.txt，窗口坐标，含 1px 边框与 38px 标题栏）；
 * 流式内容与 wb2.mjs 的 research 剧本同序（论文列表改成产品能正确渲染的单行条目）。
 */
export const CHAT_W = 1080;
export const CHAT_H = 720;
export const HUB_W = 980;
export const HUB_H = 660;

export const FG = 'rgb(42, 45, 50)';
export const FG2 = 'rgb(59, 63, 69)';
export const MUTED = 'rgb(101, 105, 114)';
export const PRI = 'rgb(30, 94, 184)';
export const GREEN = 'rgb(37, 147, 95)';
const NAV_BG = 'rgb(242, 242, 242)';
const SEL_BG = 'rgba(42, 45, 50, 0.1)';
export const LINE = 'rgba(224, 224, 224, 0.7)';
export const LINE_SOFT = 'rgba(224, 224, 224, 0.5)';
const SECTION_FG = 'rgba(101, 105, 114, 0.72)';
const PANEL_LINE = 'rgba(224, 224, 224, 0.574)';

export const RESEARCH_Q = '调研：大模型现在怎样辅助数学证明？整理成一篇笔记';
export const PAPER_Q = '再找 2026 年 LLM 数学推理的论文，下载最相关的一篇';
export const NOTE_Q = '打开这篇笔记，把主要发现改精炼些';
const SLASH_DONE = '/research-mode ';
export const SESSION_TITLE = '大模型辅助数学证明';
export const NOTE_TITLE = '大模型辅助数学证明：现状与方法';
const TODO_TITLE = '大模型辅助数学证明调研';
const PAPER = 'Process-Supervised Language Models for Formal Theorem Proving';

export const STEPS = ['明确调研范围与检索关键词', '检索形式化证明方向的最新进展', '检索过程监督与自我验证方法', '检索本地资料中的相关笔记与教材', '交叉核对信息并整理观点', '撰写调研报告并存为笔记'];

/** 侧栏「对话」分区：第一幕那场对话（昨晚 21:00 前后）与它侧栏里的旧会话，相对时间按 20:05 算（SessionRow：<24h 用小时、<7 天用天）。 */
const OLD_SESSIONS: Array<[string, string]> = [
  ['讲透拉格朗日中值定理', '23小时前'],
  ['线性代数：特征值的直觉', '2天前'],
  ['英语作文批改 · Task 2', '3天前'],
  ['有机化学反应机理整理', '4天前'],
  ['概率论错题复盘', '6天前'],
];

/** 时间轴（脚本秒）：SceneDay 按 beats 填好传进来。 */
export type ResearchTL = {
  focus: number;
  type0: number;
  tab: number;
  q0: number;
  q1: number;
  send: number;
  ask: number;
  pick: number;
  submit: number;
  steps: number;
  stepDur: number;
  done: number;
  collapse: number;
  title: number;
  /** 改笔记：点进输入框 → 打字 → 发送 → 工具（加载技能 / 打开、观察、读取、替换笔记）→ 笔记窗里直改落地 */
  focus3: number;
  n0: number;
  n1: number;
  send3: number;
  edit: number;
  focus2: number;
  f0: number;
  f1: number;
  send2: number;
  save: number;
  saved: number;
};

const grow = (t: number, a: number, d = 0.05) => ease.wbOut(clamp((t - a) / d));
const typed = (text: string, t: number, a: number, b: number) => (t < a ? '' : text.slice(0, Math.round(text.length * clamp((t - a) / (b - a)))));
/** 产品动画按真实时长写，片中脚本秒 = 真实秒 / PACE */
const spin = (t: number, periodS: number) => ((t * PACE) / periodS) * 360;

export const T = ({ x, y, size, weight = 400, lh, color = FG, style, children }: { x: number; y: number; size: number; weight?: number; lh: number; color?: string; style?: CSSProperties; children: ReactNode }) => (
  <span style={{ ...at(x, y), fontSize: size, fontWeight: weight, lineHeight: `${lh}px`, color, whiteSpace: 'nowrap', ...style }}>{children}</span>
);

const Spinner = ({ x, y, size, t, color = PRI }: { x: number; y: number; size: number; t: number; color?: string }) => (
  <span style={{ ...at(x, y), width: size, height: size, display: 'inline-flex', transform: `rotate(${spin(t, 1)}deg)` }}>
    <CircleNotch size={size} color={color} weight="bold" />
  </span>
);

// ── 标题栏 ────────────────────────────────────────────
/** 对话窗标题栏：边栏开关（SidebarFrameWithLeftRailIcon）+ 居中会话名（缺省「新对话」，订阅 store.title）。 */
export const ChatTitlebar = ({ title, next, k }: { title: string; next?: string; k: number }) => (
  <>
    <span style={{ width: 28, height: 28, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M9 5v14" />
      </svg>
    </span>
    <span style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', fontWeight: 600, opacity: next ? 1 - k : 1 }}>{title}</span>
    {next ? <span style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', fontWeight: 600, opacity: k }}>{next}</span> : null}
  </>
);

// ── 侧栏 ──────────────────────────────────────────────
export const StreamingRing = ({ x, y, t }: { x: number; y: number; t: number }) => {
  const r = 6.75;
  const c = 2 * Math.PI * r;
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" style={{ ...at(x, y), transform: `rotate(${spin(t, 1.1)}deg)` }}>
      <circle cx={8} cy={8} r={r} stroke="rgba(42, 45, 50, 0.14)" strokeWidth={2.5} />
      <circle cx={8} cy={8} r={r} stroke={FG} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${c * 0.34} ${c * 0.66}`} transform="rotate(-90 8 8)" />
    </svg>
  );
};

export type SidebarRow = { title: string; time: string; active?: boolean; streaming?: boolean; enter?: number };

export const ChatSidebar = ({ rows, t }: { rows: SidebarRow[]; t: number }) => (
  <>
    <span style={{ ...at(1, 39), width: 271, height: 681, background: NAV_BG }} />
    <T x={15} y={45.8} size={18} weight={600} lh={18} style={{ fontFamily: font.display }}>
      DeepStudent
    </T>
    <FunnelSimple size={15} color={MUTED} style={at(206.8, 47.3)} />
    <MagnifyingGlass size={16} weight="bold" color={MUTED} style={at(236, 46.8)} />
    <span className="ds-icon" style={{ ...at(15.8, 84.5), width: 18, height: 18, display: 'inline-flex', color: FG }}>
      <StudyChatIcon className="ds-icon" />
    </span>
    <T x={40.5} y={86.5} size={14} lh={14}>
      新会话
    </T>
    <span style={{ ...at(225.8, 84.8), width: 29.5, height: 17.5, boxSizing: 'border-box', borderRadius: 5, border: '1px solid rgba(0,0,0,0.1)', background: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: 500, lineHeight: '15.5px', textAlign: 'center', color: MUTED }}>⌘N</span>
    <T x={19.5} y={140.3} size={13} lh={18} color={SECTION_FG}>
      课题
    </T>
    <CaretDown size={12.3} color={MUTED} style={at(216.9, 143.1)} />
    <FolderPlus size={12.3} color={MUTED} style={at(241.4, 143.1)} />
    <T x={19.5} y={179.5} size={13} lh={18} color={SECTION_FG}>
      对话
    </T>
    {rows.slice(0, 5).map((r, i) => {
      const y = 202 + 33.75 * i;
      const e = r.enter ?? 1;
      return (
        <div key={`${r.title}-${i}`} style={{ position: 'absolute', inset: 0, opacity: e, transform: `translateY(${(1 - e) * 4}px)` }}>
          {r.active ? <span style={{ ...at(8, y), width: 257, height: 32, borderRadius: 14, background: SEL_BG }} /> : null}
          <T x={40.5} y={y + 9} size={14} lh={14} style={{ width: 180.5, overflow: 'hidden' }}>
            {r.title}
          </T>
          {r.streaming ? (
            <StreamingRing x={240.9} y={y + 8.7} t={t} />
          ) : (
            <T x={160} y={y + 9.4} size={11} lh={13.2} color={MUTED} style={{ width: 95.3, textAlign: 'right' }}>
              {r.time}
            </T>
          )}
        </div>
      );
    })}
    <T x={38.5} y={374.3} size={12} lh={12} color={MUTED}>
      展开显示
    </T>
  </>
);

// ── 输入框 ────────────────────────────────────────────
const Caret = ({ on }: { on: boolean }) => (on ? <span style={{ display: 'inline-block', width: 1.5, height: 18, marginLeft: 1, verticalAlign: '-3px', background: FG }} /> : null);

const ModelPick = ({ x, y }: { x: number; y: number }) => (
  <>
    <Img src={deepseekIcon} style={{ ...at(x, y), width: 15, height: 15, filter: 'grayscale(1) brightness(0.32)' }} />
    <T x={x + 18.5} y={y + 1} size={13} weight={600} lh={13} color={MUTED}>
      高
    </T>
    <CaretDown size={13} color={FG} style={at(x + 35, y + 1)} />
  </>
);

/** 发送键：空 → 灰底灰箭头；有字 → 黑底白箭头；流式中 → 黑底白方块（停止）。 */
const SendKey = ({ x, y, mode, press }: { x: number; y: number; mode: 'idle' | 'ready' | 'stop'; press: number }) => (
  <span
    style={{
      ...at(x, y),
      width: 28,
      height: 28,
      borderRadius: 9999,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: mode === 'idle' ? 'rgb(240, 240, 240)' : '#000',
      transform: `scale(${1 - 0.1 * press})`,
    }}
  >
    {mode === 'stop' ? <Stop size={12} weight="fill" color="#fff" /> : <ArrowUp size={16} weight="bold" color={mode === 'idle' ? MUTED : '#fff'} />}
  </span>
);

type ComposerProps = { text: string; caret: boolean; mode: 'idle' | 'ready' | 'stop'; press: number; hint?: boolean };

/** 空态居中输入框（chat-empty-composer-layout，560 宽）。 */
const EmptyComposer = ({ text, caret, mode, press }: ComposerProps) => (
  <>
    <span style={{ ...at(396, 349.8), width: 560, height: 98, boxSizing: 'border-box', borderRadius: 16, border: `1px solid ${LINE}`, background: '#fff' }} />
    <span style={{ ...at(411, 365.3), width: 533.5, fontSize: 15, lineHeight: '24.375px', color: text ? FG : 'rgba(101, 105, 114, 0.7)', whiteSpace: 'pre' }}>
      {text || '请输入问题...'}
      <Caret on={caret} />
    </span>
    <Plus size={18} color={MUTED} style={at(416, 413.3)} />
    <ModelPick x={814} y={414.8} />
    <Microphone size={14} color={FG2} style={at(885.8, 415.3)} />
    <SendKey x={916.5} y={408.3} mode={mode} press={press} />
  </>
);

/** 对话态输入框（贴底 616 宽，上沿直角接任务面板）。 */
export const DockComposer = ({ text, caret, mode, press, hint }: ComposerProps) => (
  <>
    <span style={{ ...at(368, 613), width: 616, height: 98, boxSizing: 'border-box', borderRadius: '0 0 16px 16px', border: `1px solid ${LINE}`, background: '#fff' }} />
    <span style={{ ...at(383, 628.5), width: 586, fontSize: 15, lineHeight: '24.375px', color: text ? FG : 'rgba(101, 105, 114, 0.7)', whiteSpace: 'pre' }}>
      {text || '请输入问题...'}
      <Caret on={caret} />
    </span>
    <Plus size={18} color={MUTED} style={at(388, 676.5)} />
    {hint ? (
      <T x={659.5} y={678} size={10} lh={15} color="rgba(101, 105, 114, 0.6)">
        按 Enter 发送，Shift + Enter 换行
      </T>
    ) : null}
    <ModelPick x={842} y={678} />
    <Microphone size={14} color={FG2} style={at(913.8, 678.5)} />
    <SendKey x={944.5} y={671.5} mode={mode} press={press} />
  </>
);

/** 斜杠技能补全（SkillSlashPopover）：贴在输入框左上。 */
const SlashPopover = ({ k }: { k: number }) => (
  <div style={{ position: 'absolute', inset: 0, opacity: k, transform: `translateY(${(1 - k) * 4}px)` }}>
    <span style={{ ...at(411, 179.8), width: 280, height: 171, boxSizing: 'border-box', borderRadius: 14, border: `1px solid ${LINE_SOFT}`, background: 'rgba(252, 252, 252, 0.94)', boxShadow: '0 8px 24px rgba(0,0,0,0.08), 0 0 0 1px rgba(224,224,224,0.4)' }} />
    <Lightning size={14} color={PRI} style={at(422.5, 189.1)} />
    <T x={443.5} y={187.8} size={11} weight={500} lh={16.5} color="rgba(42, 45, 50, 0.8)">
      技能命令
    </T>
    <T x={659.8} y={187.8} size={11} lh={16.5} color={MUTED}>
      /res
    </T>
    <span style={{ ...at(415.5, 215.8), width: 271, height: 50.3, borderRadius: 7, background: 'rgb(237, 237, 237)' }} />
    {[
      { y: 224.6, name: '调研模式', id: '/research-mode', idX: 514.3, desc: '系统化的调研助手，帮助用户完成深度调研任务。使用 AI 内部任务进度', w: 188.5, check: true },
      { y: 274.8, name: 'learning-resource', id: '/learning-resource', idX: 569.6, desc: '学习资源只读发现能力组。当用户需要浏览、搜索或读取学习资料（笔记、教', w: 215, check: false },
    ].map((it) => (
      <div key={it.id}>
        <span style={{ ...at(426, it.y), width: 24.5, height: 24.5, borderRadius: 7, background: 'rgba(30, 94, 184, 0.1)' }} />
        <Lightning size={14} color={PRI} style={at(431.3, it.y + 5.2)} />
        <T x={461} y={it.y - 1.8} size={12} weight={500} lh={18}>
          {it.name}
        </T>
        <T x={it.idX} y={it.y - 0.3} size={10} lh={15} color={MUTED}>
          {it.id}
        </T>
        <T x={461} y={it.y + 18} size={11} lh={16.5} color={MUTED} style={{ width: it.w, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {it.desc}
        </T>
        {it.check ? <Check size={16} color={PRI} style={at(660, it.y)} /> : null}
      </div>
    ))}
    <span style={{ ...at(412, 319.8), width: 278, height: 1, background: LINE_SOFT }} />
    {[
      ['↑', 422.5, 14.9],
      ['↓', 439.2, 14.9],
      ['Tab', 484.6, 24.3],
      ['↵', 510.7, 17],
      ['Esc', 558.2, 24.1],
    ].map(([k2, x, w]) => (
      <span key={k2 as string} style={{ ...at(x as number, 326.1), width: w as number, height: 18.5, borderRadius: 3.5, background: 'rgb(240, 240, 240)', fontSize: 10, lineHeight: '18.5px', textAlign: 'center', color: MUTED }}>
        {k2}
      </span>
    ))}
    {[
      ['导航', 457.6],
      ['确认', 531.2],
      ['关闭', 585.8],
    ].map(([l, x]) => (
      <T key={l as string} x={x as number} y={327.8} size={10} lh={15} color={MUTED}>
        {l}
      </T>
    ))}
  </div>
);

// ── 消息块 ────────────────────────────────────────────
export const UserBubble = ({ y, text, time = '20:05' }: { y: number; text: string; time?: string }) => (
  <>
    <span style={{ position: 'absolute', right: 1078 - 984 + 1, top: y - 39, maxWidth: 560, boxSizing: 'border-box', padding: '10.5px 14px', borderRadius: 12, background: 'rgb(240, 240, 240)', fontSize: 16, lineHeight: '26.4px', color: FG, whiteSpace: 'nowrap' }}>{text}</span>
    <Copy size={16} color={MUTED} style={at(917.1, y + 63.9)} />
    <T x={947.9} y={y + 65.3} size={11} lh={13.2} color="rgba(101, 105, 114, 0.5)">
      {time}
    </T>
  </>
);

/** 思考摘要行（activity-timeline-thinking-trigger），y = 文字顶。 */
const ThinkRow = ({ y }: { y: number }) => (
  <>
    <Brain size={15} color={PRI} style={at(372.8, y + 6.2)} />
    <T x={398.8} y={y} size={16} lh={27.52} color={MUTED}>
      已用时 1 秒
    </T>
    <CaretRight size={12} color="rgba(101, 105, 114, 0.5)" style={at(483.5, y + 7.7)} />
  </>
);

/** 工具摘要行（activity-timeline-tool-trigger），y = 文字顶。group：「已调用 N 个工具」，状态灰字、末尾折叠箭头。 */
export const ToolRow = ({ y, label, w, icon: Ico, done, ms, group }: { y: number; label: string; w: number; icon: Icon; done: boolean; ms?: string; group?: boolean }) => {
  const x2 = 398.8 + w + 5.2;
  return (
    <>
      <Ico size={14} color={MUTED} style={at(373.3, y + 6.7)} />
      <T x={398.8} y={y} size={16} lh={27.52} color={MUTED}>
        {label}
      </T>
      {group ? (
        <>
          <T x={x2} y={y + 3.3} size={12} lh={21} color="rgba(101, 105, 114, 0.7)">
            {done ? '执行完成' : '执行中...'}
          </T>
          <CaretRight size={12} color={MUTED} style={at(x2 + (done ? 53.3 : 52), y + 7.8)} />
        </>
      ) : done ? (
        <>
          <CheckCircle size={14} color={MUTED} style={at(x2, y + 6.7)} />
          <T x={x2 + 19.3} y={y + 3.2} size={12} lh={21} color={GREEN}>
            执行完成
          </T>
          {ms ? (
            <T x={x2 + 72.5} y={y + 3.2} size={12} lh={21} color="rgba(101, 105, 114, 0.7)">
              {ms}
            </T>
          ) : null}
        </>
      ) : (
        <>
          <T x={x2} y={y + 3.2} size={12} lh={21} color={PRI}>
            执行中...
          </T>
          <T x={x2 + 51.9} y={y + 3.2} size={12} lh={21} color="rgba(101, 105, 114, 0.7)">
            1s
          </T>
        </>
      )}
    </>
  );
};

type StepSt = 'done' | 'run' | 'todo';

/** 待办更新行（✓ / ● 前缀，可展开）：y = 按钮顶。 */
const TodoRow = ({ y, text, color, open }: { y: number; text: string; color: string; open: boolean }) => (
  <>
    {open ? <CaretDown size={14} color={MUTED} style={at(409.3, y + 6.1)} /> : <CaretRight size={14} color={MUTED} style={at(409.3, y + 6.1)} />}
    <T x={430.3} y={y + 7.6} size={11} weight={500} lh={11} color={color}>
      {text}
    </T>
  </>
);

/** 展开的待办快照（行内列表，行距 23）：y = 容器顶。 */
const TodoSnapshot = ({ y, st, t }: { y: number; st: StepSt[]; t: number }) => (
  <>
    <span style={{ ...at(397.8, y), width: 586.3, height: 143.5, boxSizing: 'border-box', borderRadius: 5, border: `1px solid ${LINE_SOFT}`, background: 'rgba(240, 240, 240, 0.3)' }} />
    {STEPS.map((s, i) => {
      const ry = y + 6.3 + 23 * i;
      const k = st[i];
      if (k === 'run') {
        return (
          <div key={s}>
            <span style={{ ...at(391.8, ry - 3.5), width: 598.3, height: 23, borderRadius: 3.5, background: 'rgba(30, 94, 184, 0.1)' }} />
            <span style={{ ...at(398.8, ry), width: 16, height: 16, borderRadius: 9999, background: PRI, color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center' }}>{i + 1}</span>
            <T x={421.8} y={ry} size={11} weight={500} lh={14}>
              {s}
            </T>
            <Spinner x={969.4} y={ry + 0.2} size={15.1} t={t} />
          </div>
        );
      }
      return (
        <div key={s}>
          {k === 'done' ? (
            <span style={{ ...at(405.8, ry), width: 16, height: 16, borderRadius: 9999, background: 'rgba(37, 147, 95, 0.18)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Check size={12} weight="bold" color={GREEN} />
            </span>
          ) : (
            <span style={{ ...at(405.8, ry), width: 16, height: 16, boxSizing: 'border-box', borderRadius: 9999, border: `1px solid ${LINE}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ width: 4, height: 4, borderRadius: 9999, background: 'rgba(101, 105, 114, 0.5)' }} />
            </span>
          )}
          <T x={428.8} y={ry} size={11} lh={14} color={k === 'done' ? GREEN : MUTED} style={k === 'done' ? { textDecoration: 'line-through' } : undefined}>
            {s}
          </T>
        </div>
      );
    })}
  </>
);

/** 「N 个结果」来源行：y = 图标顶。 */
export const SourcesRow = ({ y, n, searching, x0 = 368, open = 0 }: { y: number; n: number; searching: boolean; x0?: number; open?: number }) => (
  <>
    <MagnifyingGlass size={16} color={MUTED} style={at(x0, y)} />
    <T x={x0 + 22} y={y + 1.3} size={13.3} weight={600} lh={13.3} color={FG2}>
      {n} 个结果
    </T>
    <CaretRight size={16} color={MUTED} style={{ ...at(x0 + 79.6, y), transform: open > 0 ? `rotate(${open * 90}deg)` : undefined }} />
    {searching ? (
      <T x={x0 + 107.6} y={y - 0.3} size={11} lh={16.5} color={MUTED}>
        正在检索来源…
      </T>
    ) : null}
  </>
);

/** 助手消息页脚：模型名 · 复制 / 重试 / 更多 · 时间。y = 图标按钮顶。 */
export const AssistantFooter = ({ y, time = '20:05', x0 = 368 }: { y: number; time?: string; x0?: number }) => (
  <>
    <T x={x0} y={y + 6.9} size={11} weight={500} lh={13.2} color="rgba(101, 105, 114, 0.7)">
      deepseek-v4
    </T>
    <Copy size={16} color={MUTED} style={at(x0 + 95.4, y + 6)} />
    <ArrowCounterClockwise size={16} color={MUTED} style={at(x0 + 125.2, y + 6)} />
    <DotsThree size={16} weight="bold" color={MUTED} style={at(x0 + 154.9, y + 6)} />
    <T x={x0 + 183.9} y={y + 7.4} size={11} lh={13.2} color="rgba(101, 105, 114, 0.5)">
      {time}
    </T>
  </>
);

export const Badge = ({ x, y, label }: { x: number; y: number; label: string }) => (
  <span style={{ ...at(x, y), height: 17.5, padding: '0 4.5px', borderRadius: 9, background: 'rgba(30, 94, 184, 0.1)', color: PRI, fontSize: 11, fontWeight: 500, lineHeight: '17.5px' }}>{label}</span>
);

export const P = ({ x = 368, y, text, weight = 400 }: { x?: number; y: number; text: ReactNode; weight?: number }) => (
  <T x={x} y={y} size={16} weight={weight} lh={27.52}>
    {text}
  </T>
);

/** 有序列表一项：标记 + 加粗小标题 + 正文（逐行写死，与取证换行一致）。 */
const Li = ({ y, n, lines }: { y: number; n: number; lines: ReactNode[] }) => (
  <>
    <T x={372} y={y} size={16} lh={27.52} style={{ width: 18, textAlign: 'right' }}>
      {n}.
    </T>
    {lines.map((l, i) => (
      <T key={i} x={394} y={y + 27.5 * i} size={16} lh={27.52}>
        {l}
      </T>
    ))}
  </>
);

// ── 任务面板（AgentTaskPanel） ─────────────────────────
type PanelState = { st: StepSt[]; sources: number; kb: boolean; done: number };

const PANEL_BASE = 263.5;
const PANEL_SRC = 291.2;
const PANEL_FULL = 480;

const TaskPanel = ({ top, h, s, t, collapseHover }: { top: number; h: number; s: PanelState; t: number; collapseHover: number }) => {
  const doneN = s.st.filter((x) => x === 'done').length;
  return (
    <div style={{ ...at(368, top), width: 616, height: h, overflow: 'hidden', boxSizing: 'border-box', borderRadius: '16px 16px 0 0', border: `1px solid ${PANEL_LINE}`, borderBottom: 'none', background: 'rgb(252, 252, 252)' }}>
      <div style={{ position: 'absolute', left: -368, top: 38 - top }}>
        <ListChecks size={15} color={PRI} style={at(383, top + 11.3)} />
        <T x={405} y={top + 9.8} size={12} weight={600} lh={18}>
          {TODO_TITLE}
        </T>
        <T x={927.6} y={top + 12.2} size={11} lh={13.2} color={MUTED}>
          {doneN}/6
        </T>
        <span style={{ ...at(952, top + 10.3), width: 17, height: 17, borderRadius: 9, background: collapseHover > 0 ? `rgba(42,45,50,${0.08 * collapseHover})` : 'transparent' }} />
        <CaretUp size={10} weight="bold" color={MUTED} style={at(955.5, top + 13.8)} />
        <span style={{ ...at(383, top + 36.5), width: 586, height: 1, background: PANEL_LINE }} />
        <T x={383} y={top + 42.7} size={10} weight={600} lh={15} color={MUTED}>
          计划
        </T>
        {STEPS.map((name, i) => {
          const y = top + 73.5 + 32 * i;
          const k = s.st[i];
          return (
            <div key={name}>
              {k === 'done' ? (
                <Check size={14} weight="bold" color={GREEN} style={at(385, y + 2)} />
              ) : k === 'run' ? (
                <span style={{ ...at(383, y), width: 18, height: 18, borderRadius: 9999, background: PRI, color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '18px', textAlign: 'center' }}>{i + 1}</span>
              ) : (
                <span style={{ ...at(383, y), width: 18, height: 18, boxSizing: 'border-box', borderRadius: 9999, border: `1px solid ${LINE}` }} />
              )}
              <T x={409.8} y={y} size={13} weight={500} lh={17.875} color={k === 'done' ? GREEN : k === 'run' ? FG : MUTED} style={k === 'done' ? { textDecoration: 'line-through' } : undefined}>
                {name}
              </T>
              {k === 'run' ? <Spinner x={954.3} y={y + 1.3} size={16.4} t={t} /> : null}
            </div>
          );
        })}
        <span style={{ ...at(383, top + 262), width: 586, height: 1, background: PANEL_LINE }} />
        {s.sources > 0 ? (
          <>
            <MagnifyingGlass size={12} color={MUTED} style={at(383, top + 270.6)} />
            <T x={402} y={top + 270} size={11} weight={500} lh={13.2} color={FG2}>
              来源
            </T>
            <T x={429.3} y={top + 270} size={11} lh={13.2} color={FG2}>
              {s.sources}
            </T>
            <Globe size={11} color={MUTED} style={at(443.3, top + 271.1)} />
            {s.kb ? <BookOpen size={11} color={MUTED} style={at(457.8, top + 271.1)} /> : null}
            <T x={s.kb ? 475.8 : 461.3} y={top + 270} size={11} lh={13.2} color={MUTED}>
              本条消息的来源
            </T>
          </>
        ) : null}
        {s.done > 0 ? (
          <div style={{ opacity: s.done }}>
            <span style={{ ...at(383, top + 290.2), width: 586, height: 1, background: PANEL_LINE }} />
            <T x={383} y={top + 296.4} size={10} weight={600} lh={15} color={MUTED}>
              产物
            </T>
            <T x={409.3} y={top + 299.2} size={10} lh={12} color={MUTED}>
              1
            </T>
            <Notebook size={12} color={PRI} style={at(390, top + 322.9)} />
            <T x={409} y={top + 322.3} size={11} lh={13.2}>
              {NOTE_TITLE}
            </T>
            <T x={913} y={top + 322.9} size={10} lh={12} color={MUTED}>
              笔记·刚刚
            </T>
            <span style={{ ...at(383, top + 348.2), width: 586, height: 1, background: PANEL_LINE }} />
            <T x={383} y={top + 354.4} size={10} weight={600} lh={15} color={MUTED}>
              变更
            </T>
            <T x={409.3} y={top + 357.2} size={10} lh={12} color={MUTED}>
              1
            </T>
            <span style={{ ...at(383, top + 374.7), width: 222.7, height: 21, boxSizing: 'border-box', borderRadius: 9999, border: `1px solid ${LINE}` }} />
            <FilePlus size={11} color={MUTED} style={at(391, top + 379.7)} />
            <T x={407.3} y={top + 379.2} size={10} lh={12} color={MUTED}>
              新建
            </T>
            <T x={432.7} y={top + 378.6} size={11} lh={13.2} color={FG2}>
              {NOTE_TITLE}
            </T>
            <span style={{ ...at(369, top + 402.7), width: 614, height: 1, background: PANEL_LINE }} />
            <CheckCircle size={14} weight="fill" color={GREEN} style={at(383, top + 414.4)} />
            <T x={401} y={top + 412.4} size={12} weight={500} lh={18} color={GREEN}>
              任务完成
            </T>
            <T x={383} y={top + 433.9} size={12} lh={19.5} color={FG2}>
              🎉 所有任务已完成！
            </T>
            <T x={383} y={top + 456.9} size={10} lh={15} color={MUTED}>
              1 处变更 · 1 个产物
            </T>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** 收起后的任务条（输入框上方小条：标题 ∨ 进度条 6/6）。 */
const TaskBar = ({ k }: { k: number }) => (
  <div style={{ position: 'absolute', inset: 0, opacity: k }}>
    <ListChecks size={12} color={FG2} style={at(378.5, 594.8)} />
    <T x={395.8} y={595.3} size={11} weight={500} lh={11} color={FG2}>
      {TODO_TITLE}
    </T>
    <CaretDown size={10} weight="bold" color={FG2} style={at(522, 595.8)} />
    <span style={{ ...at(540.8, 599.3), width: 31.5, height: 3, borderRadius: 9999, background: PRI }} />
    <T x={579.3} y={593.3} size={10} weight={500} lh={15} color={MUTED}>
      6/6
    </T>
  </div>
);

/** ask_user 卡（BlockingAskUserBar），顶替输入框。 */
const AskBar = ({ k, picked, hover, submitPress }: { k: number; picked: boolean; hover: 'opt' | 'submit' | null; submitPress: number }) => (
  <div style={{ position: 'absolute', inset: 0, opacity: k, transform: `translateY(${(1 - k) * 10}px)` }}>
    <span style={{ ...at(368, 432.5), width: 616, height: 278.5, boxSizing: 'border-box', borderRadius: '0 0 16px 16px', border: `1px solid ${LINE}`, background: '#fff' }} />
    <ChatCircleDots size={16} color={PRI} style={at(393.5, 458)} />
    <T x={416.5} y={454.5} size={12} weight={500} lh={21}>
      这次调研希望做到多深？
    </T>
    <T x={416.5} y={479} size={11} lh={17.5} color={MUTED}>
      了解你的偏好后，我会据此决定检索范围和报告结构。
    </T>
    {[
      ['中等深度：结构化报告，覆盖主要方法与代表工作', true],
      ['快速概览：要点式总结', false],
      ['深度调研：逐项对比，附完整引用来源', false],
    ].map(([label, rec], i) => {
      const y = 503.5 + 50.5 * i;
      const first = i === 0;
      const bg = first ? (picked ? 'rgb(239, 237, 237)' : 'rgb(244, 242, 243)') : 'rgb(252, 252, 252)';
      const bd = first ? `rgba(30, 94, 184, ${picked ? 0.24 : 0.35})` : LINE_SOFT;
      return (
        <div key={label as string}>
          <span style={{ ...at(414.5, y), width: 547.5, height: 43.5, boxSizing: 'border-box', borderRadius: 14, border: `1px solid ${bd}`, background: bg, transform: first && hover === 'opt' ? 'scale(0.995)' : undefined }} />
          <T x={426} y={y + 12.8} size={12} weight={500} lh={18} color={MUTED}>
            {i + 1}.
          </T>
          <T x={457.5} y={y + 11.3} size={12} weight={500} lh={21}>
            {label}
            {rec ? <span style={{ color: MUTED, marginLeft: 4 }}>(推荐)</span> : null}
          </T>
          {rec ? <Info size={14} color="rgba(101, 105, 114, 0.6)" style={at(897, y + 14.8)} /> : null}
          {first && picked ? <Check size={16} color={PRI} style={at(930.5, y + 13.8)} /> : null}
        </div>
      );
    })}
    <span style={{ ...at(414.5, 655), width: 443.5, height: 34, boxSizing: 'border-box', borderRadius: 12, border: `1px solid ${LINE_SOFT}` }} />
    <T x={427} y={663.5} size={12} lh={17} color="rgba(101, 105, 114, 0.6)">
      或输入自定义回答...
    </T>
    <T x={876.5} y={670.4} size={11} weight={500} lh={11} color={MUTED}>
      忽略
    </T>
    <span style={{ ...at(917, 662.8), width: 45, height: 26.3, borderRadius: 9999, background: hover === 'submit' ? 'rgba(42,45,50,0.08)' : 'transparent', transform: `scale(${1 - 0.06 * submitPress})` }} />
    <T x={928.5} y={670.4} size={11} weight={500} lh={11} color={picked ? FG : 'rgba(101, 105, 114, 0.5)'}>
      提交
    </T>
  </div>
);

/** ask_user 回答后留在消息里的结果卡：y = 容器顶。 */
const AskResult = ({ y }: { y: number }) => (
  <>
    <span style={{ ...at(397.8, y), width: 586.3, height: 72.3, boxSizing: 'border-box', borderRadius: 14, border: `1px solid ${LINE}`, background: 'rgb(252, 252, 252)', overflow: 'hidden' }}>
      <span style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 35.6, background: 'rgb(253, 253, 253)', borderBottom: `1px solid ${LINE}` }} />
    </span>
    <CheckCircle size={16} color="rgba(37, 147, 95, 0.8)" style={at(409.3, y + 10.3)} />
    <T x={432.3} y={y + 8} size={12} weight={500} lh={20.64}>
      这次调研希望做到多深？
    </T>
    <T x={409.3} y={y + 43.6} size={12} lh={20.64} color={MUTED}>
      已选择:
    </T>
    <T x={455.8} y={y + 43.6} size={12} weight={500} lh={20.64}>
      中等深度：结构化报告，覆盖主要方法与代表工作
    </T>
    <T x={726.8} y={y + 44.4} size={11} lh={18.92} color={MUTED}>
      (用户选择)
    </T>
  </>
);

/** 「创建笔记」工具卡（展开头 + 打开按钮）：y = 容器顶。 */
const NoteToolCard = ({ y }: { y: number }) => (
  <>
    <span style={{ ...at(397.8, y), width: 586.3, height: 31.6, boxSizing: 'border-box', borderRadius: 7, border: '1px solid rgb(224, 224, 224)', background: 'rgba(252, 252, 252, 0.5)' }} />
    <span style={{ ...at(398.8, y + 1), width: 584.3, height: 26.3, borderRadius: '7px 7px 0 0', background: 'rgb(232, 232, 232)' }} />
    <FilePlus size={16} color={FG} style={at(410.3, y + 6.1)} />
    <T x={433.3} y={y + 8.1} size={12} weight={500} lh={12}>
      创建笔记
    </T>
    <T x={488.3} y={y + 8.6} size={11} weight={500} lh={11} color={GREEN}>
      执行完成
    </T>
    <T x={539.3} y={y + 8.6} size={11} weight={500} lh={11} color={MUTED}>
      387ms
    </T>
    <ArrowSquareOut size={14} color={FG} style={at(933, y + 7.1)} />
    <CaretRight size={14} color={FG} style={at(957.5, y + 7.1)} />
  </>
);

// ── 论文下载卡（paperSave） ───────────────────────────
const PAPER_STAGES: Array<{ s: string; label: string; icon: Icon; w: number }> = [
  { s: 'resolving', label: '解析地址', icon: MagnifyingGlass, w: 5 },
  { s: 'downloading', label: '下载中', icon: DownloadSimple, w: 60 },
  { s: 'deduplicating', label: '去重检查', icon: Copy, w: 5 },
  { s: 'storing', label: '存储中', icon: HardDrive, w: 10 },
  { s: 'processing', label: '文本提取', icon: FileText, w: 10 },
  { s: 'indexing', label: '建立索引', icon: Database, w: 10 },
];
const PAPER_BYTES = 2488320;
const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

/** k ∈ [0, 1]：0 = 解析地址开始，1 = 已保存。各阶段时长按产品权重分配，下载段按字节均匀推进。 */
const PaperCard = ({ y, k, t }: { y: number; k: number; t: number }) => {
  const done = k >= 1;
  let acc = 0;
  let idx = 0;
  let inner = 0;
  for (let i = 0; i < PAPER_STAGES.length; i++) {
    const w = PAPER_STAGES[i].w / 100;
    if (k < acc + w || i === PAPER_STAGES.length - 1) {
      idx = i;
      inner = clamp((k - acc) / w);
      break;
    }
    acc += w;
  }
  const stage = PAPER_STAGES[idx];
  const downloading = stage.s === 'downloading';
  const pct = done ? 100 : downloading ? 5 + inner * 60 : PAPER_STAGES.slice(0, idx).reduce((a, x) => a + x.w, 0) + stage.w * 0.5;
  const RowIcon = done ? CheckCircle : stage.icon;
  const pulse = !done && !downloading ? 0.55 + 0.45 * Math.abs(Math.cos(t * PACE * Math.PI)) : 1;
  return (
    <>
      <span style={{ ...at(368, y), width: 616, height: 97.5, boxSizing: 'border-box', borderRadius: 7, border: `1px solid ${LINE_SOFT}`, background: 'rgb(252, 252, 252)' }} />
      <span style={{ ...at(379.5, y + 13.7), width: 26.5, height: 26.5, borderRadius: 5, background: 'rgba(30, 94, 184, 0.1)' }} />
      <DownloadSimple size={16} color={PRI} style={at(384.8, y + 19)} />
      <T x={413} y={y + 9.7} size={12} weight={500} lh={18}>
        论文下载
      </T>
      <T x={413} y={y + 27.7} size={11} lh={16.5} color={MUTED}>
        {done ? '1/1 篇完成' : '下载中 0/1'}
      </T>
      {done ? <CheckCircle size={16} color={GREEN} style={at(956.5, y + 19)} /> : <Spinner x={955} y={y + 17.5} size={19} t={t} />}
      <span style={{ ...at(368, y + 50.5), width: 616, height: 1, background: LINE_SOFT }} />
      <RowIcon size={14} color={done ? GREEN : PRI} style={{ ...at(379.5, y + 63), opacity: pulse }} />
      <T x={400.5} y={y + 61} size={12} lh={18} color={done ? MUTED : FG}>
        {PAPER}
      </T>
      <span style={{ position: 'absolute', right: 1078 - 971.5, top: y + 61.7 - 39, display: 'flex', gap: 6, fontSize: 11, lineHeight: '16.5px', color: MUTED, whiteSpace: 'nowrap' }}>
        {done ? (
          <span style={{ color: GREEN }}>已保存</span>
        ) : (
          <>
            <span style={{ color: 'rgba(101, 105, 114, 0.6)' }}>arXiv</span>
            {downloading ? <span>{`${mb(PAPER_BYTES * Math.max(0.18, inner))} / ${mb(PAPER_BYTES)}`}</span> : null}
            <span style={{ color: PRI }}>{stage.label}</span>
          </>
        )}
      </span>
      <span style={{ ...at(379.5, y + 84.2), width: 593, height: 5.3, borderRadius: 9999, background: 'rgba(240, 240, 240, 0.4)', overflow: 'hidden' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, borderRadius: 9999, background: done ? GREEN : PRI }} />
      </span>
    </>
  );
};

// ── 消息列：按时间追加块，内容超出时贴底滚动 ─────────────
type Block = { h: number; k: number; el: (y: number) => ReactNode };

const ANSWER_LEN = 160;

export const ResearchChat = ({ tk, t, tl }: { tk: Tokens; t: number; tl: ResearchTL }) => {
  void tk;
  const stepAt = (i: number) => tl.steps + 0.02 + i * tl.stepDur;
  const stepDone = (i: number) => stepAt(i) + tl.stepDur * 0.88;
  const st: StepSt[] = STEPS.map((_, i) => (t >= stepDone(i) ? 'done' : t >= stepAt(i) ? 'run' : 'todo'));
  const toolAt = (i: number) => stepAt(i) + tl.stepDur * 0.28;
  const toolDone = (i: number) => stepAt(i) + tl.stepDur * 0.72;
  const srcAt = toolAt(1) + tl.stepDur * 0.15;
  const nSources = t >= toolDone(3) ? 6 : t >= toolDone(2) ? 4 : t >= toolDone(1) ? 3 : t >= srcAt ? 2 : 0;
  const searching = t >= toolAt(1) && t < toolDone(3);

  // 会话阶段
  const conv = grow(t, tl.send + 0.01, 0.05);
  const askK = grow(t, tl.ask, 0.06) * (1 - grow(t, tl.submit + 0.02, 0.05));
  const panelIn = grow(t, tl.steps, 0.08);
  const panelBaseH = PANEL_BASE + (PANEL_SRC - PANEL_BASE) * grow(t, srcAt, 0.05);
  const fullK = grow(t, tl.done, 0.08);
  const colK = grow(t, tl.collapse + 0.02, 0.08);
  const panelH = (panelBaseH + (PANEL_FULL - panelBaseH) * fullK) * panelIn * (1 - colK);
  const streaming1 = t >= tl.send && t < tl.done;
  const streaming3 = t >= tl.send3 && t < tl.edit + 0.26;
  const streaming2 = t >= tl.send2 && t < tl.saved + 0.2;

  // 输入框
  const draft1 = t < tl.type0 ? '' : t < tl.tab ? typed('/res', t, tl.type0, tl.type0 + 0.12) : SLASH_DONE + typed(RESEARCH_Q, t, tl.q0, tl.q1);
  const draft3 = typed(NOTE_Q, t, tl.n0, tl.n1);
  const draft2 = typed(PAPER_Q, t, tl.f0, tl.f1);
  const blink = Math.floor(t * PACE * 2) % 2 === 0;
  const slashK = t >= tl.type0 && t < tl.tab ? clamp((t - tl.type0) / 0.12) : 0;

  // 侧栏
  const rowIn = grow(t, tl.send + 0.01, 0.075);
  const titled = grow(t, tl.title, 0.06);
  const rows: SidebarRow[] =
    t < tl.send + 0.01
      ? OLD_SESSIONS.map(([title, time]) => ({ title, time }))
      : [
          { title: titled >= 0.5 ? SESSION_TITLE : '未命名会话', time: '刚刚', active: true, streaming: streaming1 || streaming3 || streaming2, enter: rowIn },
          ...OLD_SESSIONS.map(([title, time]) => ({ title, time })),
        ];

  // 消息列
  const blocks: Block[] = [];
  const add = (a: number, h: number, el: (y: number) => ReactNode, d = 0.05) => {
    if (t >= a) blocks.push({ h: h * grow(t, a, d), k: grow(t, a, d), el });
  };
  const text1 = typed('好的，我先加载调研要用的工具，再和你确认这次调研的深度。', t, tl.send + 0.1, tl.send + 0.19);
  add(tl.send + 0.02, 112.4, (y) => <UserBubble y={y} text={RESEARCH_Q} />);
  add(tl.send + 0.06, 38.2 + ACTIVITY_GAP_EXTRA, (y) => <ThinkRow y={y} />);
  add(tl.send + 0.1, 45.7, (y) => <P y={y} text={text1} />);
  add(tl.send + 0.2, 36.5, (y) => <ToolRow y={y} label="加载技能组" w={80} icon={Wrench} done={t >= tl.send + 0.27} ms="264ms" />);
  add(tl.submit + 0.03, 81.2, (y) => <AskResult y={y} />);
  add(tl.submit + 0.07, 38.3, (y) => <ThinkRow y={y} />);
  // 以下行内块的 y 都是按钮顶（工具 / 思考摘要的文字顶比按钮顶高 1.5px）
  add(tl.submit + 0.11, 39.1, (y) =>
    t < tl.steps ? <ToolRow y={y - 1.5} label="初始化待办" w={80} icon={ListChecks} done={false} /> : <TodoRow y={y} text="0 / 6 个任务完成" color={MUTED} open={false} />,
  );
  const TOOL_OF: Array<{ label: string; w: number; icon: Icon; group?: boolean } | null> = [
    null,
    { label: '已调用 2 个工具', w: 113.7, icon: SquaresFour, group: true },
    { label: '网络搜索', w: 64, icon: Globe },
    { label: '统一搜索', w: 64, icon: MagnifyingGlass },
    null,
    null,
  ];
  STEPS.forEach((name, i) => {
    const a = stepAt(i);
    const nextRun = i < 5 ? stepAt(i + 1) : Infinity;
    const openK = grow(t, a, 0.05) * (1 - grow(t, nextRun, 0.05));
    const snap: StepSt[] = STEPS.map((_, j) => (j < i ? 'done' : j === i ? 'run' : 'todo'));
    add(a, 39.1 + 148.9 * openK, (y) => (
      <>
        <TodoRow y={y} text={`● ${name}`} color={MUTED} open={openK > 0.5} />
        {openK > 0.02 ? (
          <div style={{ position: 'absolute', inset: 0, opacity: openK }}>
            <TodoSnapshot y={y + 33.9} st={snap} t={t} />
          </div>
        ) : null}
      </>
    ));
    const tool = TOOL_OF[i];
    if (tool) add(toolAt(i), 43.2, (y) => <ToolRow y={y - 1.5} label={tool.label} w={tool.w} icon={tool.icon} group={tool.group} done={t >= toolDone(i)} />);
    if (i === 4) add(toolAt(i), 39.9, (y) => <ThinkRow y={y - 1.5} />);
    if (i === 5) add(toolAt(i), 45.6, (y) => <NoteToolCard y={y} />);
    add(stepDone(i), i === 5 ? 28.7 + ACTIVITY_GAP_EXTRA : 39.1, (y) => <TodoRow y={y} text={`✓ ${name}`} color={GREEN} open={false} />);
  });
  const ansAt = stepDone(5) + 0.005;
  if (t >= ansAt) {
    const n = Math.round(ANSWER_LEN * clamp((t - ansAt) / Math.max(0.01, tl.done - 0.01 - ansAt)));
    const seg = (y: number) => {
      let left = n;
      const take = (s: string) => {
        const r = s.slice(0, Math.max(0, left));
        left -= s.length;
        return r;
      };
      const l1 = take(`调研完成，报告已保存为笔记「${NOTE_TITLE}」。`);
      const l2 = take('主要发现');
      const a1 = take('形式化证明');
      const a2 = take('：模型提出证明策略，Lean 等证明助手逐步验证，结论可以机器检查');
      const b1 = take('过程监督');
      const b2 = take('：对推理链逐步打分，比只看最终答案更可靠');
      const c1 = take('检索增强');
      const c2 = take('：先找到可用的定理和引理再组织证明，和你笔记里的中值定理套路一致');
      const l3 = take('点上方「创建笔记」右侧的按钮可以直接打开报告。');
      return (
        <>
          <P y={y} text={l1} />
          {l2 ? <P y={y + 50.4} text={l2} weight={600} /> : null}
          {a1 ? <Li y={y + 95.7} n={1} lines={[<><b style={{ fontWeight: 600 }}>{a1}</b>{a2}</>]} /> : null}
          {a2.length > 20 ? (
            <>
              <Badge x={395.8} y={y + 129} label="[网1]" />
              <Badge x={438.5} y={y + 129} label="[网2]" />
            </>
          ) : null}
          {b1 ? <Li y={y + 153.7} n={2} lines={[<><b style={{ fontWeight: 600 }}>{b1}</b>{b2}</>]} /> : null}
          {b2.length > 15 ? <Badge x={788} y={y + 159.5} label="[网3]" /> : null}
          {c1 ? <Li y={y + 184.2} n={3} lines={[<><b style={{ fontWeight: 600 }}>{c1}</b>{c2}</>]} /> : null}
          {c2.length > 20 ? <Badge x={395.8} y={y + 217.4} label="[1]" /> : null}
          {l3 ? <P y={y + 248.4} text={l3} /> : null}
        </>
      );
    };
    blocks.push({ h: 305.7 * clamp((t - ansAt) / Math.max(0.01, tl.done - ansAt)), k: 1, el: seg });
  }
  // 末块高度含到输入区的留白：来源行在流式中是末块（图标顶距面板 46.8），完成后接页脚（页脚按钮顶距输入区 45）
  if (nSources > 0) add(srcAt, t >= tl.done ? 39.6 : 46.8, (y) => <SourcesRow y={y} n={nSources} searching={searching} />);
  add(tl.done, 45, (y) => <AssistantFooter y={y} />);
  // 改笔记：canvas-note 技能要求先用 workbench-tools 打开并聚焦笔记再改（可见笔记演示），
  // 工作台工具 + note_read + note_replace 收成一组；note_replace 在笔记窗里直写落地时这组完成
  add(tl.send3 + 0.02, 127.4, (y) => <UserBubble y={y + 15} text={NOTE_Q} time="20:06" />);
  add(tl.send3 + 0.06, 39.7, (y) => <ThinkRow y={y} />);
  add(tl.send3 + 0.1, 36.5, (y) => <ToolRow y={y - 1.5} label="加载技能组" w={80} icon={Wrench} done={t >= tl.send3 + 0.16} ms="186ms" />);
  add(tl.send3 + 0.19, 36.5 + ACTIVITY_GAP_EXTRA, (y) => <ToolRow y={y - 1.5} label="已调用 4 个工具" w={113.7} icon={SquaresFour} group done={t >= tl.edit + 0.02} />);
  const noteAt = tl.edit + 0.06;
  const note1 = '已把「主要发现」改成三条短句，笔记已经自动保存。';
  const note2 = '不满意可以点笔记顶部的「撤销本次修改」恢复原文。';
  const noteN = Math.round((note1.length + note2.length) * clamp((t - noteAt) / 0.16));
  add(noteAt, 78.1, (y) => (
    <>
      <P y={y} text={note1.slice(0, noteN)} />
      <P y={y + 27.5} text={note2.slice(0, Math.max(0, noteN - note1.length))} />
    </>
  ));
  add(noteAt + 0.2, 45, (y) => <AssistantFooter y={y} time="20:06" />);
  // 追问（片中节奏压缩：工具 → 论文列表 → 下载卡 → 收尾都比原来紧）
  add(tl.send2 + 0.02, 127.4, (y) => <UserBubble y={y + 15} text={PAPER_Q} time="20:07" />);
  add(tl.send2 + 0.05, 39.7, (y) => <ThinkRow y={y} />);
  const toolsDone = tl.send2 + 0.26;
  add(tl.send2 + 0.08, 36.5 + ACTIVITY_GAP_EXTRA, (y) => <ToolRow y={y - 1.5} label="已调用 2 个工具" w={113.7} icon={SquaresFour} group done={t >= toolsDone} />);
  const L0 = toolsDone + 0.01;
  const intro = typed('在 arXiv 上找到 3 篇 2026 年的相关论文：', t, L0, L0 + 0.04);
  add(L0, 49.4, (y) => <P y={y} text={intro} />);
  const items: Array<[string, string[]]> = [
    [PAPER, ['（2026-', '03）']],
    ['Self-Verifying Chain-of-Thought for Competition Mathematics', ['（2026-05）']],
    ['Lean-Augmented Retrieval for Undergraduate Analysis Proofs', ['（2026-07）']],
  ];
  items.forEach(([title, rest], i) => {
    const a = L0 + 0.04 + i * 0.04;
    const full = title.length + rest.join('').length;
    const n = Math.round(full * clamp((t - a) / 0.04));
    const tt = title.slice(0, n);
    const r = rest.join('').slice(0, Math.max(0, n - title.length));
    const lines: ReactNode[] =
      i === 0
        ? [<><b style={{ fontWeight: 600 }}>{tt}</b>{r.slice(0, rest[0].length)}</>, r.slice(rest[0].length)]
        : [<><b style={{ fontWeight: 600 }}>{tt}</b>{r}</>];
    add(a, i === 0 ? 58 : i === 1 ? 30.5 : 40.1, (y) => <Li y={y} n={i + 1} lines={lines} />, 0.03);
  });
  const p2At = L0 + 0.04 + 3 * 0.04;
  add(p2At, 47.1, (y) => <P y={y} text={typed('第 1 篇和你的调研主题最相关，我把它下载到资料库。', t, p2At, p2At + 0.03)} />, 0.03);
  add(tl.save, 117.1, (y) => <PaperCard y={y} k={clamp((t - tl.save) / (tl.saved - tl.save))} t={t} />);
  const finAt = tl.saved + 0.03;
  const fin1 = `已下载并保存到学习资源：《Process-Supervised Language Models for Formal`;
  const fin2 = 'Theorem Proving》。文本提取和索引已经完成，之后在对话里就能检索到它。';
  const finN = Math.round((fin1.length + fin2.length) * clamp((t - finAt) / 0.14));
  add(finAt, 78.1, (y) => (
    <>
      <P y={y} text={fin1.slice(0, finN)} />
      <P y={y + 27.5} text={fin2.slice(0, Math.max(0, finN - fin1.length))} />
    </>
  ));
  add(finAt + 0.17, 45, (y) => <AssistantFooter y={y} time="20:07" />);

  // 贴底：内容底不越过输入区（ask 卡 / 任务面板 / 收起条 / 输入框）
  const barK = colK;
  const panelTop = 613 - panelH;
  const limit = askK > 0.01 ? 432.5 + (613 - 432.5) * (1 - askK) : Math.min(panelTop, barK > 0 ? 613 - 20 * barK : 613);
  let natural = 60;
  for (const b of blocks) natural += b.h;
  const offset = Math.min(0, limit - natural);
  let y = 60 + offset;
  const els: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (y < 800 && y + b.h > -400) {
      els.push(
        <div key={i} style={{ position: 'absolute', inset: 0, opacity: b.k }}>
          {b.el(y)}
        </div>,
      );
    }
    y += b.h;
  });

  const draftNow = t < tl.send ? draft1 : t < tl.send3 ? (t >= tl.n0 ? draft3 : '') : t < tl.send2 && t >= tl.f0 ? draft2 : '';
  const composerMode = streaming1 || streaming3 || streaming2 ? 'stop' : draftNow ? 'ready' : 'idle';
  const sendPress = Math.max(0, 1 - Math.abs(t - tl.send) / 0.06, 1 - Math.abs(t - tl.send3) / 0.06, 1 - Math.abs(t - tl.send2) / 0.06);
  const focused1 = t >= tl.focus && t < tl.send;
  const focused3 = t >= tl.focus3 && t < tl.send3;
  const focused2 = t >= tl.focus2 && t < tl.send2;
  const focusedDock = focused3 || focused2;
  const dockDraft = t < tl.send3 ? (t >= tl.n0 ? draft3 : '') : t < tl.send2 && t >= tl.f0 ? draft2 : '';
  const dockTyping = focused3 ? t >= tl.n0 : t >= tl.f0;
  const hover: 'opt' | 'submit' | null = t >= tl.pick - 0.08 && t < tl.pick + 0.04 ? 'opt' : t >= tl.submit - 0.08 && t < tl.submit + 0.04 ? 'submit' : null;
  const collapseHover = t >= tl.collapse - 0.08 && t < tl.collapse + 0.04 ? 1 : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: font.sys, background: '#fff', overflow: 'hidden' }}>
      <ChatSidebar rows={rows} t={t} />
      {conv < 1 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - conv }}>
          <LogoMark id="chat-empty" size={27.5} color="rgb(120, 123, 129)" pupilColor="rgb(120, 123, 129)" style={{ ...at(662.2, 223.2) }} />
          <T x={492.3} y={275.5} size={24.5} weight={500} lh={30.625} style={{ width: 367.5, textAlign: 'center' }}>
            把一个好奇心，变成一个小收获？
          </T>
          <EmptyComposer text={draft1} caret={focused1 && (blink || draft1.length > 0)} mode={draft1 ? 'ready' : 'idle'} press={sendPress} />
          <T x={602.2} y={460.1} size={11} lh={16.5} color={MUTED}>
            今日待复习
          </T>
          <WarningDiamond size={14} color={MUTED} style={at(671.2, 461.3)} />
          <T x={688.7} y={460.1} size={11} lh={16.5} color={MUTED}>
            错题复习
          </T>
          <T x={736.2} y={460.1} size={11} weight={500} lh={16.5}>
            1
          </T>
          {slashK > 0 ? <SlashPopover k={slashK} /> : null}
        </div>
      ) : null}
      {conv > 0 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: conv }}>
          <div style={{ position: 'absolute', left: 272, top: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: -272, top: 0, width: CHAT_W - 2, height: CHAT_H - 2 }}>{els}</div>
          </div>
          {panelH > 1 ? (
            <TaskPanel top={panelTop} h={panelH} s={{ st, sources: nSources, kb: nSources >= 6, done: fullK }} t={t} collapseHover={collapseHover} />
          ) : null}
          {barK > 0 ? <TaskBar k={barK} /> : null}
          {askK < 0.99 ? (
            <div style={{ position: 'absolute', inset: 0, opacity: 1 - askK }}>
              <DockComposer
                text={t >= tl.send ? dockDraft : ''}
                caret={focusedDock && (blink || dockDraft.length > 0)}
                mode={composerMode}
                press={sendPress}
                hint={focusedDock && !dockTyping}
              />
            </div>
          ) : null}
          {askK > 0.01 ? <AskBar k={askK} picked={t >= tl.pick + 0.01} hover={hover} submitPress={Math.max(0, 1 - Math.abs(t - tl.submit) / 0.06)} /> : null}
        </div>
      ) : null}
    </div>
  );
};

/** 指针目标（窗口坐标）。 */
export const CHAT_PT = {
  composer: { x: 520, y: 378 },
  send: { x: 930.5, y: 422.3 },
  opt1: { x: 640, y: 525 },
  submit: { x: 939.5, y: 676 },
  collapse: { x: 960.5, y: 133 + 18.8 },
  composer2: { x: 560, y: 641 },
  send2: { x: 958.5, y: 685.5 },
} as const;

// ── 资源库（files 应用） ─────────────────────────────
type HubItem = { name: string; type: 'file' | 'note' | 'translation' | 'essay' | 'exam' | 'mindmap' | 'textbook'; chunks: number };
/** 与知识库索引里的 9 份资料一致（按更新时间倒序：论文、调研笔记刚建）。 */
const HUB_ITEMS: HubItem[] = [
  { name: `${PAPER}.pdf`, type: 'file', chunks: 38 },
  { name: NOTE_TITLE, type: 'note', chunks: 6 },
  { name: '测试效应', type: 'translation', chunks: 4 },
  { name: '雅思大作文：大学教育该不该免费', type: 'essay', chunks: 4 },
  { name: '高数期中模拟卷', type: 'exam', chunks: 18 },
  { name: '微分中值定理', type: 'mindmap', chunks: 7 },
  { name: '中值定理证明套路', type: 'note', chunks: 5 },
  { name: '高等数学（第七版）上册.pdf', type: 'textbook', chunks: 412 },
  { name: '高数错题本（8 月）', type: 'note', chunks: 9 },
];
/** 索引视图「已索引」分组里露出的前 6 行（取证 probe-hd-2 的顺序：导图不在前 6 行）。 */
const INDEX_ORDER = [0, 1, 2, 3, 4, 6];
const HUB_ICON: Record<HubItem['type'], string> = { file: fileIcon, note: notesIcon, translation: translationIcon, essay: essayIcon, exam: examIcon, mindmap: mindmapIcon, textbook: textbookIcon };
const TYPE_CHIP: Partial<Record<HubItem['type'], { label: string; color: string; icon: Icon; w: number }>> = {
  file: { label: '文件', color: 'rgb(107, 114, 128)', icon: FileIcon, w: 53.5 },
  note: { label: '笔记', color: 'rgb(38, 107, 217)', icon: Notebook, w: 53.5 },
  translation: { label: '翻译', color: 'rgb(6, 182, 212)', icon: Translate, w: 53.5 },
  essay: { label: '作文', color: 'rgb(236, 72, 153)', icon: PenNib, w: 53.5 },
  exam: { label: '题目集', color: 'rgb(195, 136, 34)', icon: ClipboardText, w: 64.5 },
};

export type HubView = 'all' | 'index';

/** 资源库标题栏：后退 / 前进 · 网格 / 列表 · 新建 / 排序 / 新建文件夹 / 刷新（索引视图只有排序 / 刷新）· 居中视图名 · 搜索框。 */
export const HubTitlebar = ({ view }: { view: HubView }) => {
  const ico = (I: Icon, x: number) => <I size={16} color={MUTED} style={{ position: 'absolute', left: x - 1, top: 11.5 - 1 }} />;
  return (
    <>
      <span style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
        {ico(CaretLeft, 82.5)}
        {ico(CaretRight, 108.8)}
        <span style={{ position: 'absolute', left: 137.8 - 1, top: 7.3 - 1, width: 24.5, height: 24.5, borderRadius: 9, background: '#fff' }} />
        {ico(SquaresFour, 142)}
        {ico(List, 168.3)}
        {view === 'all' ? (
          <>
            {ico(Plus, 201.5)}
            {ico(SortAscending, 234.8)}
            {ico(FolderPlus, 268)}
            {ico(ArrowClockwise, 301.3)}
          </>
        ) : (
          <>
            {ico(SortAscending, 201.5)}
            {ico(ArrowClockwise, 234.8)}
          </>
        )}
        <span style={{ position: 'absolute', left: 0, right: 0, top: 13 - 1, textAlign: 'center', fontSize: 13, fontWeight: 500, lineHeight: '13px', color: 'rgba(42, 45, 50, 0.85)' }}>{view === 'all' ? '全部文件' : '知识库索引'}</span>
        <span style={{ position: 'absolute', left: 804 - 1, top: 5.5 - 1, width: 168, height: 28, borderRadius: 10.5, background: view === 'all' ? '#fff' : 'rgba(239, 239, 239, 0.3)' }} />
        <MagnifyingGlass size={14} color="rgba(42, 45, 50, 0.45)" style={{ position: 'absolute', left: 812.8 - 1, top: 12.5 - 1 }} />
        <span style={{ position: 'absolute', left: 833 - 1, top: 12 - 1, fontSize: 13, fontWeight: 500, lineHeight: '15px', color: 'rgba(42, 45, 50, 0.4)' }}>{view === 'all' ? '搜索资源...' : '当前视图不支持搜索'}</span>
      </span>
    </>
  );
};

const HubSidebar = ({ view, kbHover }: { view: HubView; kbHover: number }) => {
  const row = (y: number, I: Icon, label: string, active: boolean, sub?: string) => (
    <div key={label}>
      {active ? <span style={{ ...at(8, y), width: 257, height: sub ? 40.5 : 32, borderRadius: 14, background: SEL_BG }} /> : null}
      <I size={18} color={FG} style={at(15.8, y + (sub ? 11.3 : 7))} />
      <T x={40.5} y={y + (sub ? 6.3 : 9)} size={14} lh={14}>
        {label}
      </T>
      {sub ? (
        <T x={40.5} y={y + 20.3} size={10} lh={14} color={MUTED}>
          {sub}
        </T>
      ) : null}
    </div>
  );
  return (
    <>
      <span style={{ ...at(1, 39), width: 271, height: 620, background: NAV_BG }} />
      <T x={15} y={50} size={12} lh={16} color={SECTION_FG}>
        学习资料
      </T>
      {row(70.5, Desktop, '桌面', false)}
      {row(104.3, Files, '全部文件', view === 'all')}
      {row(138, ClockCounterClockwise, '最近', false)}
      {row(171.8, Star, '收藏', false)}
      <T x={15} y={211.3} size={12} lh={16} color={SECTION_FG}>
        AI 知识
      </T>
      {row(231.8, Trash, '回收站', false)}
      {kbHover > 0 && view === 'all' ? <span style={{ ...at(8, 265.5), width: 257, height: 40.5, borderRadius: 14, background: `rgba(42, 45, 50, ${0.06 * kbHover})` }} /> : null}
      {row(265.5, Database, '知识库索引', view === 'index', '将学习资料转换为可检索内容')}
      {row(307.8, Brain, 'AI 记忆', false, '保存偏好与长期事实')}
    </>
  );
};

const HubGrid = () => (
  <>
    <span style={{ ...at(273, 39), width: 706, height: 585, background: '#fff' }} />
    {HUB_ITEMS.map((it, i) => {
      const col = i % 7;
      const r = Math.floor(i / 7);
      const x = 306.5 + 95 * col;
      const y = 53.5 + 128 * r;
      return (
        <div key={it.name}>
          <span style={{ ...at(x, y), width: 42, height: 48, borderRadius: '22.5%', background: 'linear-gradient(180deg, #ffffff, #eef1f5)', boxShadow: 'inset 0 0 0 0.5px rgba(31, 41, 55, 0.16)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <Img src={HUB_ICON[it.type]} style={{ width: '78%', height: '78%', objectFit: 'contain' }} />
          </span>
          <span
            style={{
              ...at(x - 16, y + 50.3),
              width: 74,
              fontSize: 11,
              lineHeight: '13.75px',
              color: 'rgba(42, 45, 50, 0.85)',
              textAlign: 'center',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-all',
            }}
          >
            {it.name}
          </span>
        </div>
      );
    })}
    <span style={{ ...at(273, 624), width: 707, height: 35, boxSizing: 'border-box', borderTop: '1px solid rgb(224, 224, 224)', background: '#fff' }} />
    <T x={283.5} y={633.8} size={11} lh={16.5} color={MUTED}>
      {HUB_ITEMS.length} 个项目
    </T>
  </>
);

const Ring = ({ x, y }: { x: number; y: number }) => {
  const size = 56;
  const sw = 6;
  const r = (size - sw) / 2;
  return (
    <svg width={size} height={size} style={{ ...at(x, y), transform: 'rotate(-90deg)' }}>
      <defs>
        <linearGradient id="kb-ring" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={PRI} />
          <stop offset="100%" stopColor="hsl(142 76% 36%)" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(240, 240, 240, 0.3)" strokeWidth={sw} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#kb-ring)" strokeWidth={sw} strokeLinecap="round" />
    </svg>
  );
};

const HubIndex = () => (
  <>
    <span style={{ ...at(273, 39), width: 706, height: 620, background: '#fff' }} />
    <span style={{ ...at(273, 39), width: 706, height: 59.3, background: 'rgba(240, 240, 240, 0.2)' }} />
    <span style={{ ...at(290.5, 51.3), width: 24.5, height: 24.5, borderRadius: 7, background: 'rgba(30, 94, 184, 0.1)' }} />
    <Info size={16} color={PRI} style={at(294.8, 55.5)} />
    <T x={325.5} y={49.5} size={12} weight={500} lh={18}>
      知识库索引
    </T>
    <T x={325.5} y={69.3} size={11} lh={17.5} color={MUTED}>
      学习资料保存在资料库中；完成索引后，AI 才能在对话中检索这些内容。索引是检索用的派生数据，不会生成另一份资料。
    </T>
    <span style={{ ...at(273, 98.3), width: 706, height: 139.3, background: 'rgba(255, 255, 255, 0.7)', borderTop: '1px solid rgba(0,0,0,0.06)' }} />
    <Ring x={283.5} y={107} />
    <T x={283.5} y={117} size={14} weight={600} lh={21} style={{ width: 56, textAlign: 'center' }}>
      100%
    </T>
    <T x={283.5} y={138} size={10} lh={15} color="rgba(101, 105, 114, 0.8)" style={{ width: 56, textAlign: 'center' }}>
      9/9
    </T>
    {(
      [
        [350, 117.6, Database, '总向量数', '503'],
        [664.5, 117.6, ChartLineUp, '向量维度', '1024'],
        [350, 135.9, WarningCircle, '索引错误', '0'],
        [664.5, 135.9, Clock, '待更新', '0'],
      ] as Array<[number, number, Icon, string, string]>
    ).map(([x, y, Ico, l, v]) => (
      <div key={l}>
        <Ico size={12} color={MUTED} style={at(x, y + 2.3)} />
        <T x={x + 17.3} y={y} size={11} lh={16.5} color={MUTED}>
          {l}
          <span style={{ marginLeft: 5.2, fontWeight: 600, color: FG }}>{v}</span>
        </T>
      </div>
    ))}
    <span style={{ ...at(283.5, 170), width: 87.7, height: 24.5, borderRadius: 9999, background: 'rgba(37, 147, 95, 0.1)' }} />
    <CheckCircle size={14} color={GREEN} style={at(293.3, 175.3)} />
    <T x={314.3} y={176.8} size={11} weight={500} lh={11} color={GREEN}>
      已索引<span style={{ marginLeft: 7 }}>9</span>
    </T>
    {(
      [
        [295, Lightning, '一键索引'],
        [388.3, ArrowsClockwise, '刷新'],
        [459.5, DotsThree, ''],
      ] as Array<[number, Icon, string]>
    ).map(([x, Ico, l]) => (
      <div key={x}>
        <Ico size={14} color={MUTED} style={at(x, 207.6)} />
        {l ? (
          <T x={x + 20} y={209.1} size={11} weight={500} lh={11} color={MUTED}>
            {l}
          </T>
        ) : null}
      </div>
    ))}
    <span style={{ ...at(273, 237.5), width: 706, height: 45, background: 'rgba(255, 255, 255, 0.7)', borderTop: '1px solid rgba(0,0,0,0.05)' }} />
    <T x={287} y={251.3} size={11} weight={500} lh={16.5} color="rgba(101, 105, 114, 0.8)">
      类型筛选
    </T>
    <span style={{ ...at(338, 244.5), width: 404, height: 30, boxSizing: 'border-box', borderRadius: 7, border: '1px solid rgba(0,0,0,0.04)', background: 'rgba(240, 240, 240, 0.5)' }} />
    <span style={{ ...at(340.8, 247.3), width: 41.5, height: 24.5, borderRadius: 5, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }} />
    {[
      ['全部', 340.8, 41.5],
      ['笔记', 384, 41.5],
      ['教材', 427.3, 41.5],
      ['题目集', 470.5, 52.5],
      ['翻译', 524.8, 41.5],
      ['作文', 568, 41.5],
      ['导图', 611.3, 41.5],
      ['文件', 654.5, 41.5],
      ['图片', 697.8, 41.5],
    ].map(([l, x, w]) => (
      <T key={l as string} x={x as number} y={254} size={11} weight={500} lh={11} color={l === '全部' ? FG : MUTED} style={{ width: w as number, textAlign: 'center' }}>
        {l}
      </T>
    ))}
    <span style={{ ...at(273, 282.5), width: 706, height: 29, background: 'rgba(37, 147, 95, 0.1)' }} />
    <CaretDown size={14} color={FG} style={at(288, 289.5)} />
    <CheckCircle size={14} weight="fill" color={FG} style={at(309, 289.5)} />
    <T x={330} y={291} size={11} weight={500} lh={11} color={GREEN}>
      已索引
    </T>
    <T x={369.7} y={291} size={11} lh={11} color="rgba(101, 105, 114, 0.7)">
      (9)
    </T>
    {INDEX_ORDER.map((n) => HUB_ITEMS[n]).map((it, i) => {
      const y = 311.5 + 56.5 * i;
      const chip = TYPE_CHIP[it.type]!;
      const nameX = 311.5 + chip.w + 11;
      const ChipIcon = chip.icon;
      return (
        <div key={it.name}>
          {i > 0 ? <span style={{ ...at(273, y), width: 706, height: 1, background: 'rgba(224, 224, 224, 0.35)' }} /> : null}
          <CaretRight size={14} color="rgba(101, 105, 114, 0.5)" style={at(287, y + 20.8)} />
          <span style={{ ...at(311.5, y + 17.8), width: chip.w, height: 20, borderRadius: 5, background: chip.color.replace('rgb(', 'rgba(').replace(')', ', 0.1)') }} />
          <ChipIcon size={14} color={chip.color} style={at(318.5, y + 20.8)} />
          <T x={336} y={y + 19.5} size={11} weight={500} lh={16.5} color={chip.color}>
            {chip.label}
          </T>
          <T x={nameX} y={y + 8.8} size={13} weight={500} lh={16.25} color="rgba(42, 45, 50, 0.9)" style={{ width: 474, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {it.name}
          </T>
          <span style={{ ...at(nameX, y + 26.8), height: 20, padding: '0 4px', borderRadius: 3.5, background: 'rgba(240, 240, 240, 0.6)', fontSize: 11, lineHeight: '20px', color: 'rgba(101, 105, 114, 0.8)', display: 'inline-flex', gap: 0 }}>{it.chunks} 块</span>
          <T x={nameX + (it.chunks >= 10 ? 44 : 37)} y={y + 28.5} size={11} lh={16.5} color="rgba(101, 105, 114, 0.8)">
            d=1024
          </T>
          <span style={{ ...at(nameX + (it.chunks >= 10 ? 88.9 : 81.9), y + 28.3), width: 32.5, height: 17, boxSizing: 'border-box', borderRadius: 3.5, border: '1px solid rgba(30, 94, 184, 0.2)', background: 'rgba(30, 94, 184, 0.05)', fontSize: 10, lineHeight: '15px', textAlign: 'center', color: PRI }}>文本</span>
          <span style={{ ...at(860, y + 16.8), width: 66.5, height: 22, boxSizing: 'border-box', borderRadius: 5, border: '1px solid rgba(37, 147, 95, 0.3)', background: 'rgba(37, 147, 95, 0.1)' }} />
          <CheckCircle size={14} color={GREEN} style={at(868, y + 20.8)} />
          <T x={885.5} y={y + 19.5} size={11} weight={500} lh={16.5} color={GREEN}>
            已索引
          </T>
        </div>
      );
    })}
    <span style={{ ...at(273, 631.8), width: 706, height: 27.3, boxSizing: 'border-box', borderTop: '1px solid rgba(224, 224, 224, 0.5)', background: '#fff' }} />
    <CaretRight size={14} color={MUTED} style={at(287, 639)} />
    <GearSix size={14} color={MUTED} style={at(313, 639)} />
    <T x={334} y={640.4} size={11} weight={500} lh={11} color={MUTED}>
      索引诊断面板
    </T>
  </>
);

/** 资源库窗口内容：view 切换时淡入。 */
export const HubWindow = ({ view, k, kbHover }: { view: HubView; k: number; kbHover: number }) => (
  <div style={{ position: 'absolute', inset: 0, fontFamily: font.sys, background: 'rgb(252, 252, 252)', overflow: 'hidden' }}>
    <HubSidebar view={view} kbHover={kbHover} />
    {view === 'all' || k < 1 ? <HubGrid /> : null}
    {view === 'index' ? (
      <div style={{ position: 'absolute', inset: 0, opacity: k }}>
        <HubIndex />
      </div>
    ) : null}
  </div>
);

/** 侧栏「知识库索引」中心（窗口坐标）。 */
export const HUB_PT = { kb: { x: 120, y: 285.8 } } as const;

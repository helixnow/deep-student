import {
  ArrowUp,
  Brain,
  CaretDown,
  CaretRight,
  CheckCircle,
  Copy,
  MagnifyingGlass,
  Microphone,
  Plus,
  Quotes,
  X,
} from '@phosphor-icons/react';
import deepseekIcon from '@app-public/icons/providers/deepseek.svg';
import photoAux from '../assets/photos/aux.webp';
import photoMvt from '../assets/photos/mvt.webp';
import type { CSSProperties } from 'react';
import { Img } from 'remotion';
import { brand, font, type Tokens } from '../theme';
import { SWEEP } from '../lib/motion';
import { S } from '../strings';

export const Shimmer = ({ text, t, tk, style }: { text: string; t: number; tk: Tokens; style?: CSSProperties }) => {
  const phase = ((t % 1.5) / 1.5) * 200;
  return (
    <span
      style={{
        backgroundImage: `linear-gradient(90deg, ${tk.mutedFg} 0%, ${tk.mutedFg} 35%, ${tk.foreground} 50%, ${tk.mutedFg} 65%, ${tk.mutedFg} 100%)`,
        backgroundSize: '200% 100%',
        backgroundPosition: `${100 - phase}% 0`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        ...style,
      }}
    >
      {text}
    </span>
  );
};

/** 工具运行光扫：105°、白 42%，translateX(-130% → 130%)。 */
export const Sweep = ({ k, radius = 6, alpha = SWEEP.whiteAlpha }: { k: number; radius?: number; alpha?: number }) => (
  <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: radius, pointerEvents: 'none' }}>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        transform: `translateX(${-130 + k * 260}%)`,
        background: `linear-gradient(${SWEEP.angleDeg}deg, transparent 30%, rgba(255,255,255,${alpha}) 50%, transparent 70%)`,
      }}
    />
  </div>
);

const C_FG = 'rgb(42, 45, 50)';
const C_MUTED = 'rgb(101, 105, 114)';

/** 待发送的选区引用（ContextRefChips，typeId=selection：玫红药丸 + Quotes 图标 + 显示名 + ×）。 */
export const RefChip = ({ label, tk, removable = true, style }: { label: string; tk: Tokens; removable?: boolean; style?: CSSProperties }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5.25,
      height: 23.5,
      boxSizing: 'border-box',
      padding: '0 10.5px',
      borderRadius: 999,
      background: tk.dark ? brand.rose900a : brand.rose100,
      color: tk.dark ? brand.rose300 : brand.rose700,
      fontFamily: font.ui,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: '16.5px',
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    <Quotes size={12} weight="bold" />
    {label}
    {removable ? <X size={10} weight="bold" style={{ marginLeft: 3.5, opacity: 0.6 }} /> : null}
  </span>
);

/** 用户拍的两张错题照片（片中内容素材，不是产品界面；scripts/photos/make-photos.py 程序渲染）：0 = 中值定理，1 = 辅助函数。 */
export const PHOTO_SRC = [photoMvt, photoAux];
export const PhotoThumb = ({ seed, size }: { seed: number; size: number }) => (
  <Img src={PHOTO_SRC[seed % PHOTO_SRC.length]} style={{ display: 'block', width: size, height: size, objectFit: 'cover' }} />
);

/** 输入框里的附件药丸（AttachmentPreviewChips：26.3 高、20px 圆形缩略图 + 文件名 11px/600）。 */
export const AttachPill = ({ name, tk, seed = 0 }: { name: string; tk: Tokens; seed?: number }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      height: 26.3,
      padding: '0 12px 0 6.3px',
      borderRadius: 999,
      border: '1px solid rgba(224, 224, 224, 0.8)',
      background: tk.dark ? tk.card : 'rgb(252, 252, 252)',
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
      fontFamily: font.ui,
      fontSize: 11,
      fontWeight: 600,
      lineHeight: '11px',
      color: tk.dark ? tk.foreground : C_FG,
      whiteSpace: 'nowrap',
      boxSizing: 'border-box',
    }}
  >
    <span style={{ width: 20, height: 20, borderRadius: '50%', overflow: 'hidden', display: 'inline-block', flexShrink: 0 }}>
      <PhotoThumb seed={seed} size={20} />
    </span>
    <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
  </span>
);

/** 发送键（28）：空 → 灰底灰箭头；有字 → 黑底白箭头。 */
export const SendButton = ({ tk, active, press = 0 }: { tk: Tokens; active: boolean; press?: number }) => (
  <span
    style={{
      width: 28,
      height: 28,
      borderRadius: '50%',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      background: active ? (tk.dark ? '#fff' : '#000') : 'rgb(240, 240, 240)',
      color: active ? (tk.dark ? '#000' : '#fff') : C_MUTED,
      transform: `scale(${1 - press * 0.12})`,
    }}
  >
    <ArrowUp size={16} weight="bold" />
  </span>
);

export const COMPOSER_W = 656;
/** 输入框纵向几何（probe-clu-att / cla-0）：上下 11.5、引用行 34、附件行 26.3 + 7、文本框 40、底栏 7 + 28。 */
export const CP = { padL: 15, padR: 11.5, padY: 11.5, refRow: 34, attRow: 26.3, gap: 7, text: 40, bar: 28 } as const;
export const composerHeight = (refs: number, atts: number) => CP.padY * 2 + (refs ? CP.refRow : 0) + (atts ? CP.attRow + CP.gap : 0) + CP.text + CP.gap + CP.bar;

export const Composer = ({
  tk,
  text,
  caret = false,
  attachments = [],
  refs = [],
  sendPress = 0,
  chipIn = 1,
}: {
  tk: Tokens;
  text: string;
  caret?: boolean;
  attachments?: string[];
  refs?: string[];
  sendPress?: number;
  focused?: boolean;
  chipIn?: number;
}) => (
  <div
    style={{
      width: COMPOSER_W,
      boxSizing: 'border-box',
      borderRadius: 16,
      border: '1px solid rgba(224, 224, 224, 0.7)',
      background: tk.background,
      padding: `${CP.padY}px ${CP.padR}px ${CP.padY}px ${CP.padL}px`,
      fontFamily: font.ui,
    }}
  >
    {refs.length > 0 ? (
      <div style={{ height: CP.refRow, display: 'flex', alignItems: 'center', gap: 5.25, padding: '0 7px' }}>
        {refs.map((r) => (
          <RefChip key={r} label={r} tk={tk} style={{ opacity: chipIn, transform: `scale(${0.9 + 0.1 * chipIn})` }} />
        ))}
      </div>
    ) : null}
    {attachments.length > 0 ? (
      <div style={{ height: CP.attRow, marginBottom: CP.gap, display: 'flex', gap: 7 }}>
        {attachments.map((a, i) => (
          <AttachPill key={a} name={a} tk={tk} seed={i} />
        ))}
      </div>
    ) : null}
    <div style={{ height: CP.text, boxSizing: 'border-box', paddingTop: 7.8, fontSize: 15, lineHeight: '24.375px', color: text ? (tk.dark ? tk.foreground : C_FG) : 'rgba(101, 105, 114, 0.7)', whiteSpace: 'nowrap' }}>
      {text || S.placeholder}
      {caret ? <span style={{ display: 'inline-block', width: 1.5, height: 18, marginLeft: 1, verticalAlign: '-3px', background: tk.dark ? tk.foreground : C_FG }} /> : null}
    </div>
    <div style={{ position: 'relative', height: CP.bar, marginTop: CP.gap, color: C_MUTED }}>
      <Plus size={18} style={{ position: 'absolute', left: 5, top: 5 }} />
      {/* 右侧：模型（deepseek 图标 + 推理强度「高」▾）/ 语音 / 发送，x 自右缘量（probe-clu-att） */}
      <Img src={deepseekIcon} style={{ position: 'absolute', right: 115.5, top: 6.5, width: 15, height: 15, filter: 'grayscale(1) brightness(0.32)' }} />
      <span style={{ position: 'absolute', right: 99, top: 7.5, fontSize: 13, fontWeight: 600, lineHeight: '13px' }}>高</span>
      <CaretDown size={13} color={C_FG} style={{ position: 'absolute', right: 82.5, top: 7.5 }} />
      <Microphone size={14} color="rgb(59, 63, 69)" style={{ position: 'absolute', right: 44.8, top: 7 }} />
      <span style={{ position: 'absolute', right: 0, top: 0 }}>
        <SendButton tk={tk} active={text.length > 0} press={sendPress} />
      </span>
    </div>
  </div>
);

/** 通用文件图标（learning-hub ResourceIcons.GenericFileIcon：灰底文档 + 折角 + 三条线，48 视框）。 */
const GenericFileIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <path d="M10 4C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44H38C39.1046 44 40 43.1046 40 42V14L30 4H10Z" fill="#F1F0EF" />
    <path d="M10 4C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44H38C39.1046 44 40 43.1046 40 42V14L30 4H10Z" stroke="#E0E0E0" strokeWidth={1} fill="none" />
    <path d="M30 4V13C30 13.5523 30.4477 14 31 14H40" fill="rgba(255, 255, 255, 0.5)" />
    <path d="M30 4L40 14H31C30.4477 14 30 13.5523 30 13V4Z" fill="rgba(0, 0, 0, 0.05)" />
    <g transform="translate(0, 2)">
      <rect x={14} y={18} width={20} height={2} rx={1} fill="#787774" fillOpacity={0.3} />
      <rect x={14} y={24} width={16} height={2} rx={1} fill="#787774" fillOpacity={0.2} />
      <rect x={14} y={30} width={12} height={2} rx={1} fill="#787774" fillOpacity={0.2} />
    </g>
  </svg>
);

const TILE: CSSProperties = { width: 56, height: 56, boxSizing: 'border-box', borderRadius: 10.5, overflow: 'hidden', border: '1px solid rgba(224, 224, 224, 0.4)', background: '#fff', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)', position: 'relative', flexShrink: 0 };

/** 用户消息高度：气泡 47.4 + 方块行 7 + 56 + 操作行 10.5 + 28（probe-clr-pdf）；助手块再隔 26.5。 */
export const USER_MSG_H = 47.4 + 7 + 56 + 10.5 + 28;
export const USER_TO_ASSISTANT = USER_MSG_H + 26.5;
/** 第一幕对话列（聊天区局部坐标）：用户消息顶 / 助手块顶。 */
export const CLASSIC_USER_TOP = 24;
export const CLASSIC_ASSISTANT_TOP = CLASSIC_USER_TOP + USER_TO_ASSISTANT;

/**
 * 用户消息（MessageItem + ContextRefsDisplay）：气泡在上；附件与引用统一成 56×56 方块排在气泡**下方**、右对齐，
 * 顺序 图片 → 文件 → 引用（引用 = 通用文件图标 + 截断显示名）；最下是 复制 + 时间。
 */
export const UserMessage = ({
  tk,
  text,
  attachments = [],
  refs = [],
  time,
}: {
  tk: Tokens;
  text: string;
  attachments?: string[];
  refs?: string[];
  time: string;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', fontFamily: font.ui }}>
    <div
      style={{
        maxWidth: 560,
        boxSizing: 'border-box',
        background: tk.dark ? 'hsl(0 0% 14% / 0.6)' : 'rgb(240, 240, 240)',
        borderRadius: 12,
        padding: '10.5px 14px',
        fontSize: 16,
        lineHeight: '26.4px',
        color: tk.dark ? tk.foreground : C_FG,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
    {attachments.length + refs.length > 0 ? (
      <div style={{ marginTop: 7, display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
        {attachments.map((a, i) => (
          <span key={a} style={TILE}>
            <PhotoThumb seed={i} size={56} />
          </span>
        ))}
        {refs.map((r) => (
          <span key={r} style={{ ...TILE, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ marginTop: 4.4 }}>
              <GenericFileIcon size={32} />
            </span>
            <span style={{ width: 54, padding: '0 3.5px', boxSizing: 'border-box', fontSize: 10, fontWeight: 500, lineHeight: '15px', textAlign: 'center', color: 'rgba(42, 45, 50, 0.8)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r}</span>
          </span>
        ))}
      </div>
    ) : null}
    <div style={{ marginTop: 10.5, height: 28, display: 'flex', alignItems: 'center', gap: 14.8, paddingRight: 5.2 }}>
      <Copy size={16} color={C_MUTED} />
      <span style={{ fontSize: 11, lineHeight: '13.2px', color: 'rgba(101, 105, 114, 0.5)' }}>{time}</span>
    </div>
  </div>
);

export const TimelineRow = ({
  tk,
  kind,
  label,
  status,
  shimmer = false,
  t,
  sweepK,
  rail = true,
}: {
  tk: Tokens;
  kind: 'thinking' | 'search';
  label: string;
  status?: string;
  shimmer?: boolean;
  t: number;
  sweepK?: number;
  rail?: boolean;
}) => (
  <div style={{ position: 'relative', height: 28, display: 'flex', alignItems: 'center', gap: 8, fontFamily: font.ui, fontSize: 14 }}>
    {rail ? (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: kind === 'thinking' ? tk.primary : tk.border,
          marginRight: 4,
          flexShrink: 0,
        }}
      />
    ) : null}
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0 6px', height: 28 }}>
      {kind === 'thinking' ? (
        <Brain size={15} weight={shimmer ? 'fill' : 'regular'} color={tk.primary} />
      ) : (
        <MagnifyingGlass size={15} color={tk.mutedFg} />
      )}
      {shimmer ? (
        <Shimmer text={label} t={t} tk={tk} />
      ) : (
        <span style={{ color: kind === 'thinking' ? tk.mutedFg : tk.foreground }}>{label}</span>
      )}
      {status ? <span style={{ color: tk.mutedFg, fontSize: 13 }}>{status}</span> : null}
      <CaretRight size={12} color={tk.mutedFg} />
      {sweepK !== undefined ? <Sweep k={sweepK} radius={6} /> : null}
    </span>
  </div>
);

/** 知识库引用角标 [n]（与 08 / 09 取证同款：17.5 高、圆角 9、11px/500）；glow 是检索落点的片中高光。 */
export const CitationBadge = ({ n, tk, glow = 0, press = 0 }: { n: number | string; tk: Tokens; glow?: number; press?: number }) => (
  <span
    style={{
      display: 'inline-block',
      height: 17.5,
      padding: '0 4.5px',
      margin: '0 4px',
      borderRadius: 9,
      verticalAlign: 'middle',
      position: 'relative',
      top: -1.5,
      transform: press > 0 ? `scale(${1 - press * 0.08})` : undefined,
      background: `color-mix(in srgb, rgb(30, 94, 184) ${10 + glow * 20 + press * 14}%, transparent)`,
      color: tk.dark ? tk.primary : 'rgb(30, 94, 184)',
      fontFamily: font.ui,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: '17.5px',
      boxShadow: glow > 0 ? `0 0 ${16 * glow}px ${tk.primary}` : undefined,
    }}
  >
    [{n}]
  </span>
);

/** PDF 页码角标「第N页」（probe-clr-pdf：9.8px/500 蓝字、细框、圆角 5.25，无图标）。 */
export const PdfBadge = ({ page, tk, press = 0 }: { page: number; tk: Tokens; press?: number }) => {
  const c = tk.dark ? 'hsl(215 80% 72%)' : 'rgb(26, 111, 230)';
  return (
    <span
      style={{
        display: 'inline-block',
        height: 18.5,
        boxSizing: 'border-box',
        padding: '0 6.5px',
        margin: '0 4px',
        borderRadius: 5.25,
        verticalAlign: 'middle',
        position: 'relative',
        top: -1.5,
        fontFamily: font.ui,
        fontSize: 9.8,
        fontWeight: 500,
        lineHeight: '16.5px',
        color: c,
        background: `rgba(48, 125, 232, ${0.08 + press * 0.12})`,
        border: '1px solid rgba(48, 125, 232, 0.2)',
        transform: `scale(${1 - press * 0.06})`,
      }}
    >
      第{page}页
    </span>
  );
};

const TL_MUTED = 'rgb(101, 105, 114)';
/** 时间线行间距（probe-clr-pdf：思考行文字顶 262.8 → 工具行 299.5）。 */
export const TL_PITCH = 36.7;
/** 思考 / 工具步骤行与紧随正文之间的空隙比旧版多出的量（--chat-activity-content-gap 0.75rem → 1.125rem，efa10dfd9） */
export const ACTIVITY_GAP_EXTRA = 5.25;

/** 思考摘要行：思考中「正在思考 N 秒…」（扫光），结束后收起为「已用时 N 秒」。 */
export const ThinkLine = ({ tk, label, shimmer, t }: { tk: Tokens; label: string; shimmer: boolean; t: number }) => (
  <div style={{ height: 27.52, display: 'flex', alignItems: 'center', fontFamily: font.ui, fontSize: 16, lineHeight: '27.52px', color: TL_MUTED, whiteSpace: 'nowrap' }}>
    <Brain size={15} color="rgb(30, 94, 184)" style={{ marginLeft: 4.8, flexShrink: 0 }} />
    <span style={{ marginLeft: 11 }}>{shimmer ? <Shimmer text={label} t={t} tk={tk} /> : label}</span>
    <CaretRight size={12} color="rgba(101, 105, 114, 0.5)" style={{ marginLeft: 5.4 }} />
  </div>
);

/** 工具行：图标 + 工具名 + 「执行中... 1s」→「⊙ 执行完成 耗时」。 */
export const ToolLine = ({ tk, label, done, ms, sweepK }: { tk: Tokens; label: string; done: boolean; ms: string; sweepK?: number }) => (
  <div style={{ position: 'relative', height: 27.52, display: 'flex', alignItems: 'center', fontFamily: font.ui, fontSize: 16, lineHeight: '27.52px', color: TL_MUTED, whiteSpace: 'nowrap' }}>
    <MagnifyingGlass size={14} color={TL_MUTED} style={{ marginLeft: 5.3, flexShrink: 0 }} />
    <span style={{ marginLeft: 11.5 }}>{label}</span>
    {done ? (
      <>
        <CheckCircle size={14} color={TL_MUTED} style={{ marginLeft: 5.2 }} />
        <span style={{ marginLeft: 5.3, fontSize: 12, lineHeight: '21px', color: 'rgb(37, 147, 95)' }}>执行完成</span>
        <span style={{ marginLeft: 5.2, fontSize: 12, lineHeight: '21px', color: 'rgba(101, 105, 114, 0.7)' }}>{ms}</span>
      </>
    ) : (
      <>
        <span style={{ marginLeft: 5.2, fontSize: 12, lineHeight: '21px', color: 'rgb(30, 94, 184)' }}>执行中...</span>
        <span style={{ marginLeft: 5.2, fontSize: 12, lineHeight: '21px', color: 'rgba(101, 105, 114, 0.7)' }}>1s</span>
      </>
    )}
    {sweepK !== undefined ? <Sweep k={sweepK} radius={6} /> : null}
  </div>
);

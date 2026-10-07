import logoUrl from '@app-public/logo-black.svg';
import { CaretDown, SquaresFour } from '@phosphor-icons/react';
import { AbsoluteFill } from 'remotion';
import { camAt, CameraView, project, type Cam, type CamKey } from '../lib/camera';
import { DUR, userBubbleSpring } from '../lib/motion';
import { clamp, ease, keys, lerp, PACE, prog, springAt } from '../lib/time';
import { S } from '../strings';
import { font, light, type Tokens } from '../theme';
import { Pupil, pathAt } from '../ui/brand';
import {
  CitationBadge,
  CLASSIC_ASSISTANT_TOP,
  CLASSIC_USER_TOP,
  Composer,
  composerHeight,
  COMPOSER_W,
  CP,
  PdfBadge,
  RefChip,
  ACTIVITY_GAP_EXTRA,
  ThinkLine,
  TL_PITCH,
  ToolLine,
  UserMessage,
} from '../ui/chat';
import {
  ClassicWindow,
  CW,
  OLD_SESSIONS,
  SEL_ADD_CX,
  SEL_ADD_TO_CHAT,
  SEL_TOOLBAR_W,
  HighlightMenu,
  PAGE_ORIGIN,
  pageShadow,
  PdfPanel,
  SelectionToolbar,
  Toast,
} from '../ui/classic';
import { CARD_OPEN_BTN, MindmapCard } from '../ui/mindmap';
import { AssistantFooter, SourcesRow, type SidebarRow } from '../ui/research';
import { SourcesPanel, SOURCES_PANEL_H } from '../ui/sources';
import { PAGE_H, quoteFlashAlpha, SELECTION_BOX, TextbookPage, THEOREM_CHARS } from '../ui/TextbookPage';
import { Tex } from '../ui/tex';
import { AnkiBlock, ankiActionCenter, ankiLayout } from '../ui/anki';
import { MindmapPanel, mindPanelK, MM, ORGANIZE_CLICKS, ORGANIZE_PUPIL, organizePupilOpacity } from './organize/MindmapView';
import { PR } from './practice/beats';
import { CUT_ZOOM, POST, RV, STRIP, STRIP_WORLD } from './retrieval/beats';
import { Handoff } from './retrieval/Handoff';
import { Vectorize } from './retrieval/Vectorize';

/** 选区引用显示名 = 资源标题 + 「第 N 页」（selectionRef.buildSelectionDisplayName，locator page:132）。 */
export const REF_LABEL = '高等数学（第七版）上册 第 132 页';
export const PHOTOS = ['错题-中值定理.jpg', '错题-辅助函数.jpg'];
export const PROMPT = '讲透这一节：画导图、出卡片';
export const SESSION_TITLE = '讲透拉格朗日中值定理';
const SENT_AT = 4.5;

const THREAD_X = CW.chatX + 32;
const chatY = (localY: number) => CW.title + localY;

/** 空态布局：logo + 标题 + 居中输入框（chat-empty-composer-layout）。 */
const EMPTY = { logoTop: 360, titleTop: 432, composerTop: 500 };
/** 空态输入框：引用行 + 两张照片附件行；发出后贴底只剩文本框 + 底栏。 */
const COMPOSER_H_FULL = composerHeight(1, PHOTOS.length);
const COMPOSER_H_DOCKED = composerHeight(0, 0);
const DOCK_TOP = CW.h - CW.title - 16 - COMPOSER_H_DOCKED;

const SEL = {
  x: PAGE_ORIGIN.x + SELECTION_BOX.x,
  y: PAGE_ORIGIN.y + SELECTION_BOX.y,
  w: SELECTION_BOX.w,
  h: SELECTION_BOX.h,
};
const TOOLBAR_Y = SEL.y + SEL.h + 8;
const TOOLBAR_X = SEL.x + SEL.w / 2 - SEL_TOOLBAR_W / 2;
const QUOTE_BTN = { x: TOOLBAR_X + SEL_ADD_CX, y: TOOLBAR_Y + 14.5 };
const CHIP_SLOT = { x: THREAD_X + CP.padL + 7, y: chatY(EMPTY.composerTop) + CP.padY + (CP.refRow - 23.5) / 2 };
const SEND_BTN = { x: THREAD_X + COMPOSER_W - CP.padR - 14, y: chatY(EMPTY.composerTop) + COMPOSER_H_FULL - CP.padY - 14 };
const TEXT_POS = { x: THREAD_X + CP.padL + 110, y: chatY(EMPTY.composerTop) + CP.padY + CP.refRow + CP.attRow + CP.gap + 7.8 + 12 };

/** 助手块顶比原版（150）下移的量：用户消息改成「气泡 + 下方附件方块 + 复制 / 时间」后变高。 */
const SHIFT = CLASSIC_ASSISTANT_TOP - 150;
/** 回答正文 16px / 27.52，段间距 18.88，公式块与段落外边距折叠（probe-clp-12）。 */
const LH = 27.52;
const PGAP = 18.88;
const FORMULA_H = 28;
const ANSWER_TOP = CLASSIC_ASSISTANT_TOP + 122 + ACTIVITY_GAP_EXTRA;
const ANSWER_LINES = {
  l1: ANSWER_TOP,
  l2: ANSWER_TOP + LH,
  formula: ANSWER_TOP + 2 * LH + PGAP,
  l3: ANSWER_TOP + 2 * LH + PGAP + FORMULA_H + PGAP,
  l4: ANSWER_TOP + 3 * LH + PGAP + FORMULA_H + PGAP,
  l5: ANSWER_TOP + 4 * LH + 2 * PGAP + FORMULA_H + PGAP,
};
/** 导图卡：段落之后 29.4（probe-clp-12 段底 → 卡顶）。 */
const MSG = { user: CLASSIC_USER_TOP, assistant: CLASSIC_ASSISTANT_TOP, answer: ANSWER_TOP, card: ANSWER_LINES.l5 + LH + 29.4 };

/** 流式输出：按 3 字一块原位生长（产品没有逐字渐显）。 */
const CPS = 150;
const L3 = '证明的关键是构造辅助函数 φ(x)，把问题化归为罗尔定理';
/** 回答四行与各行开始流出的时刻（公式块在第 2、3 行之间整块出现）。 */
const ANS = (() => {
  const l1 = '拉格朗日中值定理说的是：只要 f(x) 在 [a, b] 上连续、在 (a, b)';
  const l2 = '内可导，曲线上就一定有一点的切线与两端连线平行';
  const l4 = '你上次在 ξ 的取值上丢过分——它严格落在开区间内';
  const s1 = 8.05 + POST;
  const s2 = s1 + [...l1].length / CPS;
  const sf = s2 + [...l2].length / CPS + 0.03;
  const s3 = sf + 0.08;
  const s4 = s3 + [...L3].length / CPS + 0.03;
  const s5 = s4 + [...l4].length / CPS + 0.03;
  return { l1, l2, l3: L3, l4, s1, s2, sf, s3, s4, s5 };
})();
let measureCtx: CanvasRenderingContext2D | null = null;
const textW = (s: string, px: number) => {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return [...s].length * px;
  measureCtx.font = `${px}px ${font.ui}`;
  return measureCtx.measureText(s).width;
};
/** 回答里 [2]（出处 = 教材第 134 页「引进辅助函数 … 根据罗尔定理」）：指针点它 → 右侧跳页并闪烁命中句。 */
const cite2 = () => ({ x: THREAD_X + textW(L3, 16) + 4 + 11, y: chatY(ANSWER_LINES.l3) + LH / 2 });
const CITE_CLICK = 9.1 + POST;

/** 消息列可见底：输入框顶上 24；「产物」药丸出现后再让出一行（页脚底 → 药丸顶 23，probe-cza-bottom）。 */
const VIS_BOTTOM = DOCK_TOP - 24;

/** 导图卡之后：一句引导语（卡底 + 16.8）+ Anki 卡片块（段底 + 19.6），聊天区局部坐标。 */
const LEAD = '接下来逐张生成卡片，先看正面回忆，再翻面核对。';
const LEAD_Y = MSG.card + 280 + 16.8;
const ANKI_Y = LEAD_Y + LH + 19.6;
const CARD_AT = 9.5 + POST;

/**
 * 来源面板（SourcePanelV2）：助手消息一有来源就排在所有块后面，流式期间跟着正文往下走（cap/clq-04）。
 * 内容底下 30 是「N 个结果」折叠行（图标顶），点 [2] 后行下 29.1 展开 176.7 高的来源区（300ms），之后一直开着；
 * 消息收尾时页脚在折叠行下 37.4（probe-cza-bottom），展开区把它整体往下推。
 */
const SRC = { row: 30, rowH: 16, panelTop: 29.1, footer: 37.4, tail: 20 };
const SOURCES_Y = SRC.row;
const FOOTER_Y = SRC.row + SRC.footer;
const tailK = (t: number) => prog(t, PR.done, PR.done + 0.1);
const expandK = (t: number) => prog(t, CITE_CLICK + 0.03, CITE_CLICK + 0.03 + 0.15, ease.inOutCubic);
/** 目标卡 usp-citation-pulse：2s 真实时间。 */
const pulseK = (t: number) => prog(t, CITE_CLICK + 0.03, CITE_CLICK + 0.03 + 2 / PACE);

/** 工具行（思考 / 统一搜索 / 记忆搜索）底边，回答第一行出来之前来源行贴在它下面。 */
const TOOLS_BOTTOM = MSG.assistant + 2 * TL_PITCH + LH;
const answerEdge = (t: number) => {
  if (t >= ANS.s5) return ANSWER_LINES.l5 + LH;
  if (t >= ANS.s4) return ANSWER_LINES.l4 + LH;
  if (t >= ANS.s3) return ANSWER_LINES.l3 + LH;
  if (t >= ANS.sf) return ANSWER_LINES.formula + FORMULA_H;
  if (t >= ANS.s2) return ANSWER_LINES.l2 + LH;
  if (t >= ANS.s1) return ANSWER_LINES.l1 + LH;
  return TOOLS_BOTTOM;
};
/** 消息里最后一块内容的底边（聊天区局部坐标）。 */
const contentEdge = (t: number) => {
  let b = answerEdge(t);
  if (t >= CARD_AT) b = Math.max(b, MSG.card + 280);
  if (t >= PR.lead) b = Math.max(b, LEAD_Y + LH);
  if (t >= PR.block) b = Math.max(b, ANKI_Y + ankiLayout(t).h);
  return b;
};
const contentBottom = (t: number) => contentEdge(t) + SRC.row + SRC.rowH + SOURCES_PANEL_H * expandK(t) + (SRC.footer + SRC.tail - SRC.rowH) * tailK(t);

/** 导图卡出现时贴底滚动（stick-to-bottom），让整张卡和下面已展开的来源区露在输入框之上。 */
const CARD_SCROLL = Math.max(0, MSG.card + 280 + SRC.row + SRC.rowH + SOURCES_PANEL_H - VIS_BOTTOM);
export const CARD = { x: THREAD_X, y: chatY(MSG.card - CARD_SCROLL), w: COMPOSER_W, h: 280 };
export const OPEN_BTN = { x: CARD.x + CARD.w - CARD_OPEN_BTN.right, y: CARD.y + CARD_OPEN_BTN.top };
/** 点「打开」的时刻：导图随后在右侧面板打开（MM.open）。 */
const OPEN_CLICK = 10.5 + POST;
const stickTarget = (t: number) => Math.max(CARD_SCROLL, contentBottom(t) - (VIS_BOTTOM - 19 * tailK(t)));
/** 聊天区滚动：导图卡出现时贴底一次；回到对话后跟着流式内容贴底（use-stick-to-bottom 有缓动，这里取 0.08s 滑动平均）。 */
const chatScroll = (t: number) => {
  if (t < PR.scroll0) return CARD_SCROLL * prog(t, CARD_AT, CARD_AT + 0.2, ease.outCubic);
  let s = 0;
  for (let k = 0; k < 8; k++) s += stickTarget(t - k * 0.011);
  return lerp(CARD_SCROLL, s / 8, prog(t, PR.scroll0, PR.scroll1, ease.inOutCubic));
};
/** 卡片生成完、贴底滚动稳定后卡片块在世界坐标里的原点。 */
const SETTLED = PR.done + 0.2;
const FINAL_SCROLL = stickTarget(SETTLED);
const ANKI_WORLD = { x: THREAD_X, y: chatY(ANKI_Y - FINAL_SCROLL) };
const REVIEW_BTN = (() => {
  const c = ankiActionCenter('review', SETTLED);
  return { x: ANKI_WORLD.x + c.x, y: ANKI_WORLD.y + c.y };
})();

export const CLASSIC_CAM: CamKey[] = [
  [0, { x: 1085, y: 560, zoom: 0.9 }],
  // 2.1 才推进：左侧留白给开场第二句「其余的事，交给它。」
  [2.1, { x: 1160, y: 530, zoom: 1.02 }, ease.inOutCubic],
  [2.5, { x: SEL.x + SEL.w / 2, y: SEL.y + 90, zoom: 1.85 }, ease.inOutCubic],
  [3.0, { x: SEL.x + SEL.w / 2 + 10, y: SEL.y + 104, zoom: 1.8 }, ease.linear],
  [3.6, { x: CW.w / 2, y: CW.h / 2, zoom: 1.0 }, ease.outCubic],
  [4.0, { x: CW.w / 2 - 6, y: CW.h / 2 + 4, zoom: 1.015 }, ease.linear],
  [4.35, { x: THREAD_X + COMPOSER_W / 2, y: chatY(EMPTY.composerTop) + COMPOSER_H_FULL / 2, zoom: 1.6 }, ease.inOutCubic],
  [4.55, { x: THREAD_X + COMPOSER_W / 2, y: chatY(EMPTY.composerTop) + COMPOSER_H_FULL / 2, zoom: 1.62 }, ease.linear],
  [5.2, { x: THREAD_X + COMPOSER_W / 2, y: chatY(170 + SHIFT), zoom: 1.6 }, ease.inOutCubic],
  [5.98, { x: THREAD_X + COMPOSER_W / 2, y: chatY(196 + SHIFT), zoom: 1.65 }, ease.linear],
  // 02 看清：推向气泡看向量化（取气泡与向量条的中点），再顺着向量条匹配剪辑进 3D
  [6.32, { x: THREAD_X + COMPOSER_W / 2 + 10, y: chatY((MSG.user + 23.7 + STRIP.cy) / 2), zoom: 2.1 }, ease.inOutCubic],
  [6.62, { x: STRIP_WORLD.x, y: 262 + SHIFT, zoom: 2.28 }, ease.inOutCubic],
  [RV.cut, { x: STRIP_WORLD.x, y: STRIP_WORLD.y, zoom: CUT_ZOOM }, ease.inCubic],
  // 3D 期间相机跳到全窗机位，3D 淡出时界面已就位
  [RV.cut + 0.005, { x: CW.w / 2, y: CW.h / 2, zoom: 0.93 }, ease.linear],
  [RV.reveal, { x: CW.w / 2, y: CW.h / 2, zoom: 0.93 }, ease.linear],
  [9.0, { x: CW.w / 2, y: CW.h / 2, zoom: 1.0 }, ease.outCubic],
  [8.5 + POST - 0.2, { x: THREAD_X + COMPOSER_W / 2, y: chatY(360 + SHIFT), zoom: 1.5 }, ease.inOutCubic],
  [8.9 + POST, { x: THREAD_X + COMPOSER_W / 2, y: chatY(372 + SHIFT), zoom: 1.52 }, ease.linear],
  [9.45 + POST, { x: CW.panelX + CW.panel / 2, y: 470, zoom: 1.25 }, ease.inOutCubic],
  [9.85 + POST, { x: CW.panelX + CW.panel / 2 + 6, y: 476, zoom: 1.27 }, ease.linear],
  [10.2 + POST, { x: CARD.x + CARD.w / 2, y: CARD.y + CARD.h / 2 - 10, zoom: 1.6 }, ease.inOutQuint],
  [OPEN_CLICK, { x: CARD.x + CARD.w / 2, y: CARD.y + CARD.h / 2 - 10, zoom: 1.64 }, ease.linear],
  // 03 整理（后半）：点「打开」后导图在右侧面板打开，镜头横移过去（窗口右缘留在画内）；切结构、背诵都在面板里，逐步推近
  [MM.open + 0.5, { x: 1100, y: 372, zoom: 1.45 }, ease.inOutCubic],
  [MM.structClicks[0] - 0.1, { x: 1104, y: 370, zoom: 1.47 }, ease.linear],
  [MM.picks[1] + 0.2, { x: 1110, y: 368, zoom: 1.49 }, ease.linear],
  [MM.reciteClick + 0.16, { x: 1120, y: 386, zoom: 1.51 }, ease.inOutCubic],
  [MM.close0, { x: 1130, y: 390, zoom: 1.53 }, ease.linear],
  [MM.close1, { x: CARD.x + CARD.w / 2, y: CARD.y + CARD.h / 2 + 40, zoom: 1.45 }, ease.inOutCubic],
  // 04 练习：跟住贴底滚动的卡片块，生成完推向「复习这批」
  [PR.scroll1, { x: THREAD_X + COMPOSER_W / 2, y: ANKI_WORLD.y + 200, zoom: 1.42 }, ease.inOutCubic],
  [PR.done, { x: THREAD_X + COMPOSER_W / 2 + 4, y: ANKI_WORLD.y + 240, zoom: 1.46 }, ease.linear],
  [PR.reviewClick, { x: REVIEW_BTN.x + 40, y: CW.h - 540 / 1.62, zoom: 1.62 }, ease.inOutCubic],
];

const PRACTICE_PUPIL: Array<[number, number, number]> = [
  [PR.done + 0.02, ANKI_WORLD.x + 470, ANKI_WORLD.y + 200],
  [PR.reviewClick - 0.05, REVIEW_BTN.x, REVIEW_BTN.y],
  [PR.reviewClick + 0.3, REVIEW_BTN.x, REVIEW_BTN.y],
];

export const classicCam = (t: number): Cam => camAt(t, CLASSIC_CAM);

const selectedChars = (t: number) => Math.round(THEOREM_CHARS * prog(t, 1.98, 2.42, ease.inOutCubic));

const typedText = (t: number) => {
  const chars = [...PROMPT];
  const n = Math.floor(clamp((t - 3.98) / 0.46) * chars.length);
  return chars.slice(0, n).join('');
};

const Answer = ({ tk, t }: { tk: Tokens; t: number }) => {
  const reveal = (start: number, len: number) => Math.max(0, Math.min(len, Math.floor(((t - start) * CPS) / 3) * 3));
  const line = (s: string, start: number) => [...s].slice(0, reveal(start, [...s].length)).join('');
  const { l1, l2, l3, l4, s1, s2, sf, s3, s4, s5 } = ANS;
  const badge = (n: number | string, at: number) =>
    t >= at ? (
      <CitationBadge n={n} tk={tk} glow={1 - prog(t, at, at + 0.5, ease.outCubic)} press={n === 2 ? Math.max(0, 1 - Math.abs(t - CITE_CLICK) / 0.1) : 0} />
    ) : null;
  const base = { position: 'absolute' as const, left: 32, fontSize: 16, lineHeight: `${LH}px`, color: tk.foreground, whiteSpace: 'nowrap' as const };
  return (
    <div style={{ fontFamily: font.ui }}>
      <div style={{ ...base, top: ANSWER_LINES.l1 }}>{line(l1, s1)}</div>
      <div style={{ ...base, top: ANSWER_LINES.l2 }}>
        {line(l2, s2)}
        {badge(1, s2 + [...l2].length / CPS)}
        {t >= s2 + [...l2].length / CPS ? '。' : ''}
      </div>
      <div
        style={{
          ...base,
          top: ANSWER_LINES.formula,
          width: COMPOSER_W,
          textAlign: 'center',
          fontSize: 20,
          opacity: prog(t, sf, sf + 0.1),
        }}
      >
        <Tex tex="f(b)-f(a)=f'(\xi)(b-a),\quad \xi\in(a,b)" />
      </div>
      <div style={{ ...base, top: ANSWER_LINES.l3 }}>
        {line(l3, s3)}
        {badge(2, s3 + [...l3].length / CPS)}
        {t >= s3 + [...l3].length / CPS ? '。' : ''}
      </div>
      <div style={{ ...base, top: ANSWER_LINES.l4 }}>
        {line(l4, s4)}
        {badge('忆1', s4 + [...l4].length / CPS)}
        {t >= s4 + [...l4].length / CPS ? '。' : ''}
      </div>
      <div style={{ ...base, top: ANSWER_LINES.l5 }}>
        {line('完整证明见教材 ', s5)}
        {t >= s5 + 0.06 ? <PdfBadge page={134} tk={tk} /> : null}
      </div>
    </div>
  );
};

const ChatColumn = ({ tk, t }: { tk: Tokens; t: number }) => {
  const sent = t >= SENT_AT;
  const emptyFade = 1 - prog(t, 4.5, 4.66);
  const dockK = prog(t, 4.5, 4.5 + 0.2 + 0.1, ease.brand);
  const composerTop = sent ? EMPTY.composerTop + (DOCK_TOP - EMPTY.composerTop) * dockK : EMPTY.composerTop;
  const userK = springAt(t, 4.56, userBubbleSpring);
  const asstK = prog(t, 5.5, 5.5 + DUR.messageEnter, ease.brand);
  const thinkingSec = Math.floor((Math.min(t, RV.done) - 5.5) * PACE) + 1;
  const retrievalDone = t >= RV.done;
  const row0Done = t >= RV.land2;
  const row1Done = t >= RV.land3;
  const rowFlash = (at: number) => (t >= at ? Math.exp(-(t - at) * PACE * 3) : 0);
  const sweep = (start: number) => ((t - start) % 0.8) / 0.8;
  const cardEnter = (_n: unknown, i: number) => prog(t, 9.55 + POST + i * 0.04, 9.55 + POST + i * 0.04 + DUR.mindmapNodeEnter, ease.wbOut);
  const scroll = chatScroll(t);
  const edge = contentEdge(t);
  const open = expandK(t);
  const tail = tailK(t);
  const leadChars = [...LEAD];
  const leadN = Math.max(0, Math.min(leadChars.length, Math.floor(((t - PR.lead) * CPS) / 3) * 3));
  return (
    <>
      {emptyFade > 0 ? (
        <div style={{ position: 'absolute', left: 0, width: CW.chatW, top: EMPTY.logoTop, opacity: emptyFade, fontFamily: font.ui }}>
          <div style={{ width: 56, height: 56, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img src={logoUrl} width={36} height={36} style={{ filter: 'brightness(0) invert(0.55)' }} />
          </div>
          <div style={{ marginTop: 16, textAlign: 'center', fontSize: 24, fontWeight: 500, color: tk.foreground }}>{S.emptyTitle}</div>
        </div>
      ) : null}

      <div style={{ position: 'absolute', inset: 0, transform: scroll > 0 ? `translateY(${-scroll}px)` : undefined }}>
      {sent ? (
        <div
          style={{
            position: 'absolute',
            left: 32,
            width: COMPOSER_W,
            top: MSG.user,
            opacity: userK,
            transform: `scale(${0.95 + 0.05 * userK})`,
            transformOrigin: 'right top',
          }}
        >
          <UserMessage tk={tk} text={PROMPT} attachments={PHOTOS} refs={[REF_LABEL]} time="21:00" />
        </div>
      ) : null}

      {t >= 5.5 ? (
        <div style={{ position: 'absolute', left: 32, top: MSG.assistant, opacity: asstK, transform: `translateY(${(1 - asstK) * 4}px)` }}>
          <ThinkLine tk={tk} t={t} shimmer={!retrievalDone} label={retrievalDone ? S.thought(thinkingSec) : S.thinking(thinkingSec)} />
          {t >= 6.0 ? (
            <div style={{ marginTop: TL_PITCH - 27.52, opacity: prog(t, 6.0, 6.15), borderRadius: 8, background: `hsl(215 72% 42% / ${0.12 * rowFlash(RV.land2)})` }}>
              <ToolLine tk={tk} label={S.unifiedSearch} done={row0Done} ms="1.1s" sweepK={row0Done ? undefined : sweep(6.0)} />
            </div>
          ) : null}
          {t >= 6.1 ? (
            <div style={{ marginTop: TL_PITCH - 27.52, opacity: prog(t, 6.1, 6.25), borderRadius: 8, background: `hsl(152 60% 36% / ${0.12 * rowFlash(RV.land3)})` }}>
              <ToolLine tk={tk} label={S.memorySearch} done={row1Done} ms="718ms" sweepK={row1Done ? undefined : sweep(6.1)} />
            </div>
          ) : null}
        </div>
      ) : null}

      {t >= 8.0 + POST ? <Answer tk={tk} t={t} /> : null}

      {t >= 9.5 + POST ? (
        <div style={{ position: 'absolute', left: 32, top: MSG.card }}>
          <MindmapCard tk={tk} width={COMPOSER_W} enter={cardEnter} openPress={Math.max(0, 1 - Math.abs(t - OPEN_CLICK) / 0.1)} />
        </div>
      ) : null}

      {leadN > 0 ? (
        <div style={{ position: 'absolute', left: 32, top: LEAD_Y, fontFamily: font.ui, fontSize: 16, lineHeight: `${LH}px`, color: tk.foreground, whiteSpace: 'nowrap' }}>
          {leadChars.slice(0, leadN).join('')}
        </div>
      ) : null}
      <div style={{ position: 'absolute', left: 32, top: ANKI_Y }}>
        <AnkiBlock
          tk={tk}
          t={t}
          reviewHover={prog(t, PR.reviewClick - 0.08, PR.reviewClick - 0.03)}
          reviewPress={Math.max(0, 1 - Math.abs(t - PR.reviewClick) / 0.1)}
        />
      </div>
      {t >= RV.done ? (
        // research.tsx 的零件按对话窗坐标摆放（at() 扣掉 1px 边框与 39px 标题栏），这里补回来
        <div style={{ position: 'absolute', left: 1, top: edge + 39, opacity: prog(t, RV.done, RV.done + 0.08), fontFamily: font.ui }}>
          <SourcesRow x0={32} y={SOURCES_Y} n={3} searching={false} open={open} />
          {tail > 0 ? (
            <div style={{ position: 'absolute', left: 0, top: SOURCES_PANEL_H * open, opacity: tail }}>
              <AssistantFooter x0={32} y={FOOTER_Y} time="21:00" />
            </div>
          ) : null}
        </div>
      ) : null}
      {open > 0 ? (
        <div style={{ position: 'absolute', left: 32, top: edge + SRC.row + SRC.panelTop, width: COMPOSER_W, height: SOURCES_PANEL_H * open, overflow: 'hidden' }}>
          <SourcesPanel tk={tk} width={COMPOSER_W} pulse={pulseK(t)} />
        </div>
      ) : null}
      </div>

      {tail > 0 ? (
        <span style={{ position: 'absolute', left: 32 + 8.8, top: composerTop - 20, height: 15.5, display: 'inline-flex', alignItems: 'center', gap: 5, opacity: tail, fontFamily: font.ui, fontSize: 11, fontWeight: 500, color: 'rgb(59, 63, 69)' }}>
          <SquaresFour size={12} />
          {S.artifacts(1)}
          <CaretDown size={10} />
        </span>
      ) : null}

      <div style={{ position: 'absolute', left: 32, top: composerTop }}>
        <Composer
          tk={tk}
          text={sent ? '' : typedText(t)}
          caret={!sent && t >= 3.95 && Math.floor(t * 2.2) % 2 === 0}
          attachments={sent ? [] : PHOTOS}
          refs={sent ? [] : t >= 3.48 ? [REF_LABEL] : []}
          chipIn={prog(t, 3.48, 3.58)}
          focused={t >= 3.9 && !sent}
          sendPress={Math.max(0, 1 - Math.abs(t - 4.5) / 0.1)}
        />
      </div>
    </>
  );
};

/** S1 漂浮教材页的 3D 姿态。 */
const pageTilt = (t: number) => ({
  ry: keys(t, [
    [0, 8],
    [2.0, -4, ease.inOutCubic],
    [2.4, 0, ease.outCubic],
  ]),
  rx: keys(t, [
    [0, 5],
    [2.0, 1.5],
    [2.4, 0, ease.outCubic],
  ]),
  lift: keys(t, [
    [0, 0],
    [2.4, 1],
  ]),
});

export const SceneClassic = ({ t, hidePupil = false }: { t: number; hidePupil?: boolean }) => {
  const tk = light;
  const cam = classicCam(t);
  const chrome = prog(t, 2.25, 2.7, ease.inOutCubic);
  // 面板淡入到全不透明（chrome = 1）才撤掉漂浮页，交接时下面那页已经完全一样
  const floatVisible = t < 2.7;
  const tilt = pageTilt(t);
  const selected = selectedChars(t);
  const toolbarK = prog(t, 2.55, 2.55 + 0.15, ease.brand);
  const selectionUi = t >= 2.55 && t < 3.25;
  const selUiFade = 1 - prog(t, 3.05, 3.25);
  const chipK = prog(t, 3.02, 3.5, ease.inOutCubic);
  // 命中页还在飞的时候面板先以硬弹簧翻到第 134 页并停稳，飞来的那页正好盖上同一位置（交接不叠影）
  const snapK = springAt(t, RV.reveal + 0.06, { stiffness: 420, damping: 26 });
  const panelScroll = 2 * (PAGE_H + 16) * snapK;
  const pageLabel = snapK < 0.3 ? 132 : snapK < 0.75 ? 133 : 134;
  // 定位到句子：落页那一刻与点 [2]（产品跳页后在文本层找到命中片段再闪）各闪一次
  const quoteFlash = Math.max(quoteFlashAlpha((t - RV.land1) * PACE), quoteFlashAlpha((t - CITE_CLICK - 0.05) * PACE));

  const chipPos = (() => {
    const a = { x: SEL.x + SEL.w / 2 - 120, y: SEL.y + 30 };
    const b = CHIP_SLOT;
    const k = chipK;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k - Math.sin(k * Math.PI) * 220 };
  })();

  const pupilWorld = pathAt(t, [
    [0.3, PAGE_ORIGIN.x + 640, PAGE_ORIGIN.y + 44],
    [1.7, PAGE_ORIGIN.x + 640, PAGE_ORIGIN.y + 44],
    [1.98, SEL.x + 40, SEL.y + 14],
    [2.42, SEL.x + 300, SEL.y + 50],
    [2.9, QUOTE_BTN.x, QUOTE_BTN.y],
    [3.05, QUOTE_BTN.x, QUOTE_BTN.y],
    [3.5, CHIP_SLOT.x + 120, CHIP_SLOT.y + 12],
    [3.95, TEXT_POS.x, TEXT_POS.y],
    [4.4, SEND_BTN.x, SEND_BTN.y],
    [4.6, SEND_BTN.x, SEND_BTN.y],
    [5.3, THREAD_X + 420, chatY(360 + SHIFT)],
    [8.6 + POST, THREAD_X + 420, chatY(360 + SHIFT)],
    [CITE_CLICK - 0.1, cite2().x, cite2().y],
    [CITE_CLICK + 0.05, cite2().x, cite2().y],
    [9.9 + POST, OPEN_BTN.x - 60, OPEN_BTN.y + 40],
    [10.42 + POST, OPEN_BTN.x, OPEN_BTN.y],
  ]);
  const practice = t >= PR.scroll0;
  const organize = t > OPEN_CLICK && !practice;
  // 新会话是草稿、不进侧栏；发出后顶到「对话」最上面显示「未命名会话」+ 转圈，首轮（到卡片生成完）结束后自动起名
  const titled = t >= PR.done + 0.12;
  const sessions: SidebarRow[] =
    t < SENT_AT
      ? OLD_SESSIONS
      : [{ title: titled ? SESSION_TITLE : '未命名会话', time: '刚刚', active: true, streaming: !titled, enter: prog(t, SENT_AT + 0.01, SENT_AT + 0.085) }, ...OLD_SESSIONS];
  const trackWorld = practice ? pathAt(t, PRACTICE_PUPIL) : organize ? pathAt(t, [[OPEN_CLICK, OPEN_BTN.x, OPEN_BTN.y], ...ORGANIZE_PUPIL]) : pupilWorld;
  const pupilScreen = project(cam, trackWorld.x, trackWorld.y);
  const pupilOpacity = practice
    ? prog(t, PR.done, PR.done + 0.1)
    : organize
      ? organizePupilOpacity(t)
      : prog(t, 0.3, 0.55) * (1 - prog(t, 5.9, 6.1)) + prog(t, 8.5 + POST, 8.7 + POST);
  const mindK = mindPanelK(t);

  return (
    <AbsoluteFill>
      <CameraView cam={cam}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: CW.w, height: CW.h }}>
          <ClassicWindow
            tk={tk}
            t={t}
            title={titled ? SESSION_TITLE : undefined}
            terminal={t >= SENT_AT}
            sessions={sessions}
            chromeOpacity={chrome}
            style={{ opacity: chrome > 0 ? 1 : 0, background: chrome < 1 ? 'transparent' : tk.background, boxShadow: chrome < 1 ? 'none' : undefined }}
            chat={<ChatColumn tk={tk} t={t} />}
            panel={
              <div style={{ opacity: chrome }}>
                {mindK < 1 ? (
                  <PdfPanel tk={tk} selected={selected} scrollY={panelScroll} pageLabel={pageLabel} flash={quoteFlash} pagesHidden={t >= RV.reveal && t < RV.land1} />
                ) : null}
                <MindmapPanel t={t} tk={tk} />
              </div>
            }
          />
          {floatVisible ? (
            <div
              style={{
                position: 'absolute',
                left: PAGE_ORIGIN.x,
                top: PAGE_ORIGIN.y,
                // 落平之后不再走 3D 合成层：否则文字栅格化与下面面板里的同一页对不齐，交接那一帧会跳
                transform: tilt.rx === 0 && tilt.ry === 0 ? undefined : `perspective(1600px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
                transformOrigin: '50% 40%',
                // 落定时正好收成面板里那一页的投影
                boxShadow: `0 ${40 - tilt.lift * 38}px ${90 - tilt.lift * 80}px rgba(24,28,36,${0.16 * (1 - tilt.lift)}), ${pageShadow(tilt.lift)}`,
                borderRadius: 4,
              }}
            >
              <TextbookPage page={132} selected={selected} />
            </div>
          ) : null}

          {selectionUi ? (
            <>
              <div style={{ position: 'absolute', left: SEL.x + SEL.w / 2 - 76, top: SEL.y - 8 - 38, opacity: toolbarK * selUiFade, transform: `translateY(${(1 - toolbarK) * 4}px)` }}>
                <HighlightMenu tk={tk} />
              </div>
              <div style={{ position: 'absolute', left: TOOLBAR_X, top: TOOLBAR_Y, opacity: toolbarK * selUiFade, transform: `translateY(${(1 - toolbarK) * 4}px)` }}>
                <SelectionToolbar tk={tk} hot={t > 2.85 ? SEL_ADD_TO_CHAT : -1} press={Math.max(0, 1 - Math.abs(t - 3.0) / 0.1)} />
              </div>
            </>
          ) : null}

          {t >= 3.0 && t < 3.52 ? (
            <div
              style={{
                position: 'absolute',
                left: chipPos.x,
                top: chipPos.y,
                transform: `scale(${1 + Math.sin(chipK * Math.PI) * 0.35})`,
                transformOrigin: '0 50%',
                filter: `drop-shadow(0 ${10 * Math.sin(chipK * Math.PI)}px 16px hsl(220 25% 12% / ${0.22 * Math.sin(chipK * Math.PI)}))`,
              }}
            >
              <RefChip label={REF_LABEL} tk={tk} />
            </div>
          ) : null}

          {t >= 3.1 && t < 4.3 ? (
            <div
              style={{
                position: 'absolute',
                left: CW.w / 2,
                top: 54,
                transform: `translate(-50%, ${(1 - prog(t, 3.1, 3.32, ease.brand)) * -10}px) scale(${0.98 + 0.02 * prog(t, 3.1, 3.32)})`,
                opacity: prog(t, 3.1, 3.2) * (1 - prog(t, 4.1, 4.3)),
              }}
            >
              <Toast tk={tk} text={S.refAdded} sub={REF_LABEL} />
            </div>
          ) : null}

          <Vectorize t={t} />
        </div>
      </CameraView>
      <Handoff t={t} cam={cam} />
      <Pupil x={pupilScreen.x} y={pupilScreen.y} t={t} opacity={hidePupil ? 0 : clamp(pupilOpacity)} clicks={[3.0, 4.5, CITE_CLICK, OPEN_CLICK, ...ORGANIZE_CLICKS, PR.reviewClick]} />
    </AbsoluteFill>
  );
};

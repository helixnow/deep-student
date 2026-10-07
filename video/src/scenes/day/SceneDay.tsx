import type { ReactNode } from 'react';
import { AbsoluteFill } from 'remotion';
import { camAt, CameraView, clampCam, project, type CamKey } from '../../lib/camera';
import { ease, PACE, prog } from '../../lib/time';
import { S } from '../../strings';
import { dark, light, type Tokens } from '../../theme';
import { Pupil, pathAt } from '../../ui/brand';
import { agendaOpenCenter, AgendaWidget, BriefingWidget, DesktopShortcuts, shortcutCenter, type ShortcutId } from '../../ui/desk';
import { ESSAY_H, ESSAY_PT, ESSAY_SCROLL, ESSAY_STREAM, ESSAY_W, EssayView, type EssayStage, type EssayState, type EssayTarget } from '../../ui/essay';
import { EXAM_DROP_RIGHT, EXAM_H, EXAM_PT, EXAM_SCROLL, EXAM_W, ExamToast, ExamView, FileChip, type ExamStage, type ExamState, type ExamTarget } from '../../ui/exam';
import { HandoutNotesView, NOTES_H, NOTES_W, NotesTitlebar, NotesView, type NotesState } from '../../ui/notes';
import { CHAT_H, CHAT_PT, CHAT_W, ChatTitlebar, HUB_H, HUB_PT, HUB_W, HubTitlebar, HubWindow, ResearchChat, SESSION_TITLE, type ResearchTL } from '../../ui/research';
import { MORNING_DUE, POMO_RECT, PomodoroWindowBody, pomoTitle, TODO_H, TODO_ITEMS, TODO_W, TodoApp, todoPlayCenter, todoRowCenter, TodoToolbar, type TodoState } from '../../ui/todo';
import { ResourceTitlebar, SIDEBAR_COLLAPSE_S } from '../../ui/resource';
import { ANSWER_LEN, ASK_CHIP_PT, ASK_QUESTION, ASK_SEEK_TO, AppsPanel, BiliDialog, contentToWin, COURSE, DLG_PT, HANDOUT_PHASES, HANDOUT_TITLE, LIB_PT, MEDIA_H, MEDIA_W, MediaLibrary, MediaStudy, pageName, STUDY_PAGE, STUDY_PT, type AppsPanelState, type DialogStage, type DialogState, type LibraryState, type StudyState, type StudyTab } from '../../ui/media';
import { TRANS_H, TRANS_LEN, TRANS_PT, TRANS_W, TranslateView, type TransStage, type TransState, type TransTarget } from '../../ui/translate';
import { APP_NAMES, Dock, dockBounceAt, dockIconCenter, type DockBadge, GENIE_S, IND_S, MenuBar, menuClock, TIP_DELAY_S, TIP_FADE_S, trafficCenter, Wallpaper, WbWindow, winLife, type Rect } from '../../ui/workbench';
import { nightDock, nightMenubar } from '../review/SceneReview';
import { DAY, DBL, RESEARCH_STEP, wallDrift } from './beats';

/**
 * 第二幕「第二天」：夜里复习完的学习桌面迎来清晨，之后按产品里真实的路径打开应用：
 * 日程小组件「待办 →」→ 待办「今日」→ 开始专注 → 双击桌面「显示桌面」→ 双击桌面快捷方式打开题目集 / 作文批改 / 翻译
 * → 再次「显示桌面」→ Dock「全部应用」打开音视频（B 站链接导入、边看边跟字幕、点字幕跳转）→ 黄灯收起
 * → Dock 还原对话（调研 + 追问论文）→ Dock 打开资源库 → 知识库索引。
 * 桌面（壁纸 / 快捷方式 / 小组件 / 菜单栏 / Dock）全程常驻，窗口在其上开合；镜头是 2D 推拉。
 */
export const TODO_RECT: Rect = { x: 48, y: 88, w: TODO_W, h: TODO_H };
/** 级联落位（windowStore nextCascadeOrigin，最小化的窗口也占槽）：待办 0 号槽、番茄钟 1 号槽，题目集落在 2 号槽。 */
export const EXAM_RECT: Rect = { x: 96, y: 136, w: EXAM_W, h: EXAM_H };
/** 题目集窗口坐标（含边框与标题栏，即 DOM 取证坐标）→ 桌面坐标。 */
const examPt = (p: { x: number; y: number }) => ({ x: EXAM_RECT.x + p.x, y: EXAM_RECT.y + p.y });

/** 07 时番茄钟投射窗已随会话结束关掉、1 号槽空出：作文批改落 1 号槽，翻译落 3 号槽（待办 0 / 作文 1 / 题目集 2）。 */
export const ESSAY_RECT: Rect = { x: 72, y: 112, w: ESSAY_W, h: ESSAY_H };
export const TRANS_RECT: Rect = { x: 120, y: 160, w: TRANS_W, h: TRANS_H };
const essayPt = (p: { x: number; y: number }) => ({ x: ESSAY_RECT.x + p.x, y: ESSAY_RECT.y + p.y });
const transPt = (p: { x: number; y: number }) => ({ x: TRANS_RECT.x + p.x, y: TRANS_RECT.y + p.y });
/** 对话窗口昨晚就开着（最小化），位置不在级联槽上；默认尺寸 1080×720（chat/register.ts defaultFrame）。 */
export const CHAT_RECT: Rect = { x: 560, y: 110, w: CHAT_W, h: CHAT_H };
/** 音视频 1100×700（system/register.tsx defaultFrame）级联落 4 号槽（0–3 号槽被待办 / 作文 / 题目集 / 翻译占着，最小化的也占槽）。 */
export const MEDIA_RECT: Rect = { x: 144, y: 184, w: MEDIA_W, h: MEDIA_H };
/** 资源库 980×660 级联落 5 号槽（4 号槽被最小化的音视频占着）。 */
export const HUB_RECT: Rect = { x: 168, y: 208, w: HUB_W, h: HUB_H };
/** 08a「生成讲义」存成的笔记从音视频「本课讲义」打开（DSTU_OPEN_NOTE）：笔记窗 1240×760 落级联 5 号槽，看完点红灯关掉（之后资源库仍落 5 号槽）。 */
export const HANDOUT_RECT: Rect = { x: 168, y: 208, w: NOTES_W, h: NOTES_H };
/** 讲义笔记窗开合时刻 */
const HO_OPEN = DAY.handoutOpen + 0.02;
const HO_CLOSE = DAY.handoutClose + 0.01;
const handoutOn = (t: number) => t >= HO_OPEN && t < HO_CLOSE;
/** 音视频窗口内容坐标 → 桌面坐标 */
const mediaPt = (p: { x: number; y: number }) => {
  const w = contentToWin(p);
  return { x: MEDIA_RECT.x + w.x, y: MEDIA_RECT.y + w.y };
};
/** 08 AI 打开的笔记窗 1240×760（notes/register.ts defaultFrame），取证落在级联 1 号槽；盖住对话窗左大半，输入框右段还露着。 */
export const NOTES_RECT: Rect = { x: 72, y: 112, w: NOTES_W, h: NOTES_H };
const chatPt = (p: { x: number; y: number }) => ({ x: CHAT_RECT.x + p.x, y: CHAT_RECT.y + p.y });
/** 点对话窗露在笔记窗右边的那截输入框（对话窗回到最前并聚焦输入框）。 */
const CHAT_RAISE = { x: 880, y: 641 };
const hubPt = (p: { x: number; y: number }) => ({ x: HUB_RECT.x + p.x, y: HUB_RECT.y + p.y });

const pressAt = (t: number, at: number, w = 0.08) => Math.max(0, 1 - Math.abs(t - at) / w);

/** 「显示桌面」：第二击后窗口开始 genie。 */
const SHOW_MIN = DAY.showDesk + DBL + 0.02;
const SHOW_MIN2 = DAY.showDesk2 + DBL + 0.02;
/** Dock 图标点按时刻（还原对话 / 打开资源库）。 */
const CHAT_CLICK = DAY.researchOpen - 0.02;
const APPS_CLICK = DAY.mediaApps;
/** 音视频窗口：Enter 后面板退场 100ms，窗口才开（不在 Dock 上 → 从窗口中心放大）；点黄灯后 genie 进 Dock */
const MEDIA_MIN = DAY.mediaMin + 0.01;
const HUB_CLICK = DAY.hubIndex - 0.02;

// ── 桌面状态 ─────────────────────────────────────────
/** 有窗口的应用（含最小化），按最早开窗保序。番茄钟在 07 的时间跳转处已结束（会话结束即收起投射窗口）。 */
const runningAt = (t: number): string[] => {
  const r = [...nightDock(DAY.start).running];
  if (t >= DAY.todayOpen) r.push('todo');
  if (t >= DAY.todayFocus && t < DAY.essayOpen) r.push('pomodoro');
  if (t >= DAY.examOpen) r.push('exam');
  if (t >= DAY.essayOpen) r.push('essay');
  if (t >= DAY.translateOpen) r.push('translation');
  if (t >= DAY.mediaOpen) r.push('media');
  if ((t >= HO_OPEN && t < HO_CLOSE + 0.06) || t >= DAY.noteOpen) r.push('notes');
  if (t >= DAY.hubIndex) r.push('files');
  return r;
};
const FIRST_OPEN: Record<string, number> = {
  todo: DAY.todayOpen,
  pomodoro: DAY.todayFocus,
  exam: DAY.examOpen,
  essay: DAY.essayOpen,
  translation: DAY.translateOpen,
  media: DAY.mediaOpen,
  notes: DAY.noteOpen,
  files: DAY.hubIndex,
};

/** 闪卡到期数：清晨 MORNING_DUE（见 todo.tsx）；07 的时间跳转之后「复习到期卡片」已完成。 */
const dueAt = (t: number) => (t < DAY.clock ? nightMenubar(t).due : t < DAY.essayOpen ? MORNING_DUE : 0);
/** 今日待办完成数（简报的「已完成 n/4」与日程列表随章节推进）。 */
const doneAt = (t: number) => (t < DAY.essayOpen ? 0 : t < DAY.researchOpen ? 2 : 3);

const focusLeft = (t: number) => {
  const left = Math.max(0, 25 * 60 - Math.floor((t - DAY.todayFocus) * PACE));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
};

/** 菜单栏：时钟翻页前与夜里那段逐帧一致；白天随焦点窗口切换应用名、随章节走时间。 */
const dayMenubar = (t: number) => {
  if (t < DAY.clock) return { ...nightMenubar(t), pomo: null as string | null };
  const app =
    t < DAY.todayOpen
      ? S.desk.appName
      : t < SHOW_MIN
        ? APP_NAMES.todo
        : t < DAY.examOpen
          ? S.desk.appName
          : t < DAY.essayOpen
            ? APP_NAMES.exam
            : t < DAY.translateOpen
              ? APP_NAMES.essay
              : t < SHOW_MIN2
                ? APP_NAMES.translation
                : t >= DAY.mediaOpen && t < MEDIA_MIN
                  ? handoutOn(t)
                    ? APP_NAMES.notes
                    : APP_NAMES.media
                  : t < DAY.researchOpen
                  ? S.desk.appName
                  : t < DAY.noteOpen
                    ? APP_NAMES.chat
                    : t < DAY.chatBack
                      ? APP_NAMES.notes
                      : t < DAY.hubIndex
                        ? APP_NAMES.chat
                        : APP_NAMES.files;
  const clock = t < DAY.essayOpen ? menuClock(3, 7, 30) : t < DAY.translateOpen ? menuClock(3, 14, 10) : t < DAY.mediaApps ? menuClock(3, 15, 40) : t < DAY.researchOpen ? menuClock(3, 16, 50) : menuClock(3, 20, 5);
  const pomo = t >= DAY.todayFocus && t < DAY.essayOpen ? focusLeft(t) : null;
  return { app, clock, due: dueAt(t), pomo };
};

/** 有可见窗口时小组件淡到 0.55（280ms ease-out）。 */
const dimAt = (t: number) => {
  const on = (a: number) => prog(t, a, a + 0.14, ease.wbOut);
  const off = (a: number) => prog(t, a, a + 0.14, ease.wbOut);
  return Math.max(on(DAY.todayOpen) * (1 - off(SHOW_MIN + GENIE_S)), on(DAY.examOpen) * (1 - off(SHOW_MIN2 + GENIE_S)), on(DAY.mediaOpen) * (1 - off(MEDIA_MIN + GENIE_S)), on(DAY.researchOpen));
};

const night = (t: number) => 1 - prog(t, DAY.dawn0, DAY.dawn1, ease.inOutCubic);
const themeK = (t: number) => prog(t, DAY.theme0, DAY.theme1, ease.inOutCubic);

// ── 各段内容状态 ─────────────────────────────────────
const TODO_ROW_IN = 26.78;
const TODO_ROW_OUT = 27.92;
const todoState = (t: number): TodoState => ({
  view: 'today',
  navHover: 0,
  navPress: 0,
  rowHover: prog(t, TODO_ROW_IN, TODO_ROW_IN + 0.03) * (1 - prog(t, TODO_ROW_OUT, TODO_ROW_OUT + 0.03)),
  playHover: t >= DAY.todayFocus - 0.2 && t < TODO_ROW_OUT ? 1 : 0,
  playPress: pressAt(t, DAY.todayFocus),
  focusing: t >= DAY.todayFocus,
  remaining: t >= DAY.todayFocus ? focusLeft(t) : '25:00',
  ring: t >= DAY.todayFocus ? ((t - DAY.todayFocus) * PACE) / 1500 : 0,
});

// 07：作文批改。流式整段压到约 1.1 脚本秒（后端 wire 格式按原始字符匀速流出）；批完自动平滑滚回顶部分数卡（66797e169），全宽下雷达同屏
const ESSAY_STREAM_T: [number, number] = [DAY.essayStream, DAY.essayDone - 0.03];
const ESSAY_RATE = ESSAY_STREAM.total / (ESSAY_STREAM_T[1] - ESSAY_STREAM_T[0]);
const ESSAY_SCROLL_UP: [number, number] = [DAY.essayDone + 0.02, DAY.essayDone + 0.24];
/** 指针离开作文结果区（去点桌面「翻译」） */
const ESSAY_LEAVE = DAY.translateLaunch - 0.42;
const ESSAY_CLICKS: Array<[EssayTarget, number]> = [
  ['new', DAY.essayNew],
  ['grade', DAY.essayGrade],
  ['polish', DAY.essayPolish],
];

const essayState = (t: number): EssayState => {
  const stage: EssayStage = t < DAY.essayNew + 0.02 ? 'home' : t < DAY.essayGrade + 0.01 ? 'draft' : t < DAY.essayDone ? 'grading' : 'done';
  const pressAtT = ESSAY_CLICKS.find(([, c]) => Math.abs(t - c) < 0.08)?.[1];
  return {
    stage,
    enter: stage === 'home' ? 1 : prog(t, DAY.essayNew + 0.02, DAY.essayNew + 0.07),
    collapse: prog(t, DAY.essayNew + 0.02, DAY.essayNew + 0.02 + SIDEBAR_COLLAPSE_S),
    pasted: t >= DAY.essayPaste + 0.04,
    hover: ESSAY_CLICKS.find(([, c]) => t >= c - 0.09 && t < c + 0.05)?.[0] ?? null,
    press: pressAtT === undefined ? 0 : pressAt(t, pressAtT),
    lock: prog(t, DAY.essayGrade + 0.01, DAY.essayGrade + 0.11),
    stream: ESSAY_STREAM.total * prog(t, ...ESSAY_STREAM_T),
    rate: ESSAY_RATE,
    sinceDone: t - DAY.essayDone,
    scroll: ESSAY_SCROLL.done + (ESSAY_SCROLL.top - ESSAY_SCROLL.done) * ease.inOutCubic(prog(t, ...ESSAY_SCROLL_UP)),
    tab: t >= DAY.essayPolish + 0.01 ? 'polish' : 'overview',
    tabEnter: prog(t, DAY.essayPolish + 0.01, DAY.essayPolish + 0.11),
    resultHover: prog(t, DAY.essayDone, DAY.essayDone + 0.1) * (1 - prog(t, ESSAY_LEAVE, ESSAY_LEAVE + 0.1)),
    thumb: t >= DAY.essayDone ? 1 - prog(t, ESSAY_SCROLL_UP[1] + 0.45, ESSAY_SCROLL_UP[1] + 0.55) : 0,
    clock: t * PACE,
  };
};

// 07：翻译。完成即自动保存，会话有了原文 → 新建引导条消失
const TRANS_STREAM_T: [number, number] = [DAY.translateStream, DAY.translateDone - 0.02];
const TRANS_CLICKS: Array<[TransTarget, number]> = [
  ['new', DAY.translateNew],
  ['run', DAY.translateRun],
];

const transState = (t: number): TransState => {
  const stage: TransStage = t < DAY.translateNew + 0.02 ? 'home' : t < DAY.translateRun + 0.01 ? 'draft' : t < DAY.translateDone ? 'running' : 'done';
  const pressAtT = TRANS_CLICKS.find(([, c]) => Math.abs(t - c) < 0.08)?.[1];
  return {
    stage,
    enter: stage === 'home' ? 1 : prog(t, DAY.translateNew + 0.02, DAY.translateNew + 0.07),
    collapse: prog(t, DAY.translateNew + 0.02, DAY.translateNew + 0.02 + SIDEBAR_COLLAPSE_S),
    hint: prog(t, DAY.translateNew + 0.02, DAY.translateNew + 0.22),
    pasted: t >= DAY.translatePaste + 0.04,
    hover: TRANS_CLICKS.find(([, c]) => t >= c - 0.09 && t < c + 0.05)?.[0] ?? null,
    press: pressAtT === undefined ? 0 : pressAt(t, pressAtT),
    run: TRANS_LEN * prog(t, ...TRANS_STREAM_T),
    sinceDone: t - DAY.translateDone,
    clock: t * PACE,
  };
};

// 08a：音视频
/** 字幕播放倍速：成片里一句一句地往下走（真实 1× 时一句要 3–5 秒，镜头里来不及看） */
const PLAY_RATE = 4;
/** 跳转之后放慢：被点的那一句多停一会儿 */
const PLAY_RATE_AFTER = 2;
const typed = (t: number) => {
  const q = '音视频';
  const n = t < DAY.mediaType ? 0 : Math.min(q.length, 1 + Math.floor((t - DAY.mediaType) / 0.06));
  return q.slice(0, n);
};
const appsPanelState = (t: number): AppsPanelState => ({
  k: prog(t, APPS_CLICK + 0.01, APPS_CLICK + 0.11, ease.brand) * (1 - prog(t, DAY.mediaEnter, DAY.mediaEnter + 0.1, ease.inCubic)),
  query: typed(t),
  searchK: prog(t, DAY.mediaType, DAY.mediaType + 0.1),
  press: pressAt(t, DAY.mediaEnter, 0.04),
});
const libraryState = (t: number): LibraryState => ({
  imported: prog(t, DAY.mediaImported + 0.02, DAY.mediaImported + 0.2),
  biliHover: t >= DAY.mediaBili - 0.09 && t < DAY.mediaBili + 0.05 ? 1 : 0,
  biliPress: pressAt(t, DAY.mediaBili),
  rowHover: t >= DAY.mediaRow - 0.1 && t < DAY.mediaRow + 0.04 ? STUDY_PAGE : null,
  rowPress: pressAt(t, DAY.mediaRow),
});
const DLG_STAGES: Array<[DialogStage, number]> = [
  ['input', DAY.mediaBili],
  ['parsing', DAY.mediaParse + 0.01],
  ['probe', DAY.mediaProbe],
  ['batch', DAY.mediaImport + 0.01],
];
const BATCH_T: [number, number] = [DAY.mediaImport + 0.02, DAY.mediaImported - 0.04];
const dialogState = (t: number): DialogState => {
  let i = 0;
  DLG_STAGES.forEach(([, at], k) => {
    if (t >= at) i = k;
  });
  const [stage, since] = DLG_STAGES[i];
  return {
    k: prog(t, DAY.mediaBili + 0.02, DAY.mediaBili + 0.12, ease.brand) * (1 - prog(t, DAY.mediaImported, DAY.mediaImported + 0.07, ease.inCubic)),
    stage,
    from: DLG_STAGES[Math.max(0, i - 1)][0],
    grow: i === 0 ? 1 : prog(t, since, since + (stage === 'probe' ? 0.12 : 0.06)),
    pasted: t >= DAY.mediaPaste + 0.03,
    batch: COURSE.pages.length * prog(t, ...BATCH_T),
    hover: t >= DAY.mediaParse - 0.09 && t < DAY.mediaParse + 0.05 ? 'parse' : t >= DAY.mediaImport - 0.09 && t < DAY.mediaImport + 0.05 ? 'confirm' : null,
    press: Math.max(pressAt(t, DAY.mediaParse), pressAt(t, DAY.mediaImport)),
    t: t * PACE,
  };
};
const mediaPos = (t: number) =>
  t < DAY.mediaPlay + 0.01 ? 0 : t < DAY.askSeek + 0.01 ? (t - DAY.mediaPlay - 0.01) * PACE * PLAY_RATE : ASK_SEEK_TO + (t - DAY.askSeek - 0.01) * PACE * PLAY_RATE_AFTER;
/** 分区切换：点下即换（SegmentedControl） */
const TAB_CLICKS: Array<[StudyTab, number]> = [
  ['ask', DAY.askTab],
  ['handout', DAY.handoutTab],
  ['practice', DAY.practiceTab],
];
const hoverAt = (t: number, at: number, pre = 0.09, post = 0.03) => (t >= at - pre && t < at + post ? 1 : 0);
const typedQ = (t: number) => {
  const chars = [...ASK_QUESTION];
  const k = prog(t, DAY.askType, DAY.askSend - 0.05);
  return t < DAY.askSend + 0.01 ? chars.slice(0, Math.floor(chars.length * k)).join('') : '';
};
const handoutPhase = (t: number) => {
  if (t < DAY.handoutGen + 0.01 || t >= DAY.handoutDone) return null;
  const k = (t - DAY.handoutGen - 0.01) / (DAY.handoutDone - DAY.handoutGen - 0.01);
  return HANDOUT_PHASES.reduce((cur, [p, at]) => (k >= at ? p : cur), HANDOUT_PHASES[0][0]);
};
const studyState = (t: number): StudyState => {
  const tabHit = TAB_CLICKS.find(([, c]) => t >= c - 0.09 && t < c + 0.03);
  return {
    enter: prog(t, DAY.mediaRow + 0.02, DAY.mediaRow + 0.08),
    pos: mediaPos(t),
    playing: t >= DAY.mediaPlay + 0.01,
    // 指针移到播放器上控制条出现，点完播放移去右侧分区后 150ms 淡出
    controls: prog(t, DAY.mediaPlay - 0.12, DAY.mediaPlay - 0.08) * (1 - prog(t, DAY.mediaPlay + 0.24, DAY.mediaPlay + 0.32)),
    playHover: t >= DAY.mediaPlay - 0.09 ? 1 : 0,
    playPress: pressAt(t, DAY.mediaPlay),
    seekFlash: prog(t, DAY.askSeek + 0.005, DAY.askSeek + 0.07),
    t: t * PACE,
    tab: TAB_CLICKS.reduce<StudyTab>((cur, [id, c]) => (t >= c + 0.01 ? id : cur), 'transcript'),
    tabHover: tabHit ? tabHit[0] : null,
    tabPress: tabHit ? pressAt(t, tabHit[1]) : 0,
    // 对话层直接盖住分区原内容（演示 .demo-chat-active 把原内容 display:none），不交叉淡化
    askLayer: t >= DAY.askStart + 0.01 ? 1 : 0,
    askStartHover: hoverAt(t, DAY.askStart),
    askStartPress: pressAt(t, DAY.askStart),
    typed: typedQ(t),
    composerFocus: t >= DAY.askStart + 0.02,
    sendPress: pressAt(t, DAY.askSend),
    sent: prog(t, DAY.askSend + 0.01, DAY.askSend + 0.05),
    thinking: t >= DAY.askSend + 0.04 && t < DAY.askAnswer,
    // 流速让「▶ 05:20」在被点之前已在画面里停留 1 秒以上（成片）
    answer: ANSWER_LEN * prog(t, DAY.askAnswer, DAY.askAnswer + 0.46),
    chipHover: t >= DAY.askSeek - 0.1 && t < DAY.askSeek + 0.2 ? 1 : 0,
    chipPress: pressAt(t, DAY.askSeek),
    phase: handoutPhase(t),
    genHover: hoverAt(t, DAY.handoutGen),
    genPress: pressAt(t, DAY.handoutGen),
    handoutK: prog(t, DAY.handoutDone, DAY.handoutDone + 0.06),
    itemHover: hoverAt(t, DAY.handoutOpen, 0.1, 0.05),
    itemPress: pressAt(t, DAY.handoutOpen),
    pcHover: hoverAt(t, DAY.practiceCards),
    pcPress: pressAt(t, DAY.practiceCards),
    practiceLayer: t >= DAY.practiceCards + 0.01 ? 1 : 0,
    cards: Math.max(0, (t - DAY.practiceCards - 0.06) / 0.11),
    watchedMin: 1,
  };
};
/** 讲义笔记：打开后停在开头，再往下滚到配图 */
const handoutScroll = (t: number) => 300 * ease.inOutCubic(prog(t, DAY.handoutScroll, DAY.handoutScroll + 0.3));

// 08：对话里的时间轴（打字、ask_user、任务面板、追问、论文下载）
const RESEARCH_TL: ResearchTL = {
  focus: DAY.researchType - 0.06,
  type0: DAY.researchType,
  tab: DAY.researchTab,
  q0: DAY.researchTab + 0.04,
  // 打完字停一拍再按发送（指针按下时问题已经打全）
  q1: DAY.researchSend - 0.16,
  send: DAY.researchSend,
  ask: DAY.researchAsk,
  pick: DAY.researchPick,
  submit: DAY.researchSubmit,
  steps: DAY.researchSteps,
  stepDur: RESEARCH_STEP,
  done: DAY.researchDone,
  collapse: DAY.researchCollapse,
  title: DAY.researchTitle,
  focus3: DAY.noteType - 0.04,
  n0: DAY.noteType,
  n1: DAY.noteSend - 0.06,
  send3: DAY.noteSend,
  edit: DAY.noteEdit,
  focus2: DAY.chatBack,
  f0: DAY.paperType,
  f1: DAY.paperSend - 0.06,
  send2: DAY.paperSend,
  save: DAY.paperSave,
  saved: DAY.paperSaved,
};

// 08 笔记窗：apply_ops 到达（presence acting）→ 约 90ms 写入 → done 保留 4s → presence 清除、条收拢（各 200ms）
const NOTE_RUN = DAY.noteEdit - 0.03;
const NOTE_DONE = DAY.noteEdit + 0.015;
const NOTE_CLEAR = NOTE_DONE + 4 / PACE;
const notesState = (t: number): NotesState => ({
  applied: t >= DAY.noteEdit,
  flashS: (t - DAY.noteEdit) * PACE,
  strip: prog(t, NOTE_RUN, NOTE_RUN + 0.2 / PACE, ease.brand) * (1 - prog(t, NOTE_CLEAR, NOTE_CLEAR + 0.2 / PACE, ease.brand)),
  stripEnter: prog(t, NOTE_RUN, NOTE_RUN + 0.24 / PACE, ease.brand),
  stripDone: t >= NOTE_DONE,
  bar: prog(t, NOTE_DONE + 0.005, NOTE_DONE + 0.005 + 0.15 / PACE, ease.brand),
});

// 06：判错后先滚出「AI 解析」按钮，流式输出时再往下滚一次；「已加入今日复习」是修正版提示
const EXAM_SCROLL1: [number, number] = [DAY.examSubmit + 0.24, DAY.examSubmit + 0.48];
const EXAM_SCROLL2: [number, number] = [DAY.examAI + 0.77, DAY.examAI + 1.17];
const AI_THINK = DAY.examAI + 0.02;
const AI_STREAM: [number, number] = [DAY.examAI + 0.14, DAY.examAI + 1.95];
const TOAST_AT = DAY.examSubmit + 0.05;
const TOAST_DUR = 1.8;

const EXAM_CLICKS: Array<[ExamTarget, number]> = [
  ['new', DAY.examNew],
  ['parse', DAY.examParse],
  ['view', DAY.examView],
  ['q7', DAY.examQ7],
  ['optA', DAY.examPick],
  ['submit', DAY.examSubmit],
  ['ai', DAY.examAI],
];
const EXAM_STAGES: Array<[ExamStage, number]> = [
  ['home', DAY.examOpen],
  ['launcher', DAY.examNew + 0.02],
  ['upload', DAY.examDrop + 0.02],
  ['parsing', DAY.examParse + 0.02],
  ['summary', DAY.examParsed],
  ['grid', DAY.examView + 0.02],
  ['practice', DAY.examQ7 + 0.02],
];

/** 试卷从屏幕右侧拖进启动台（从 Finder 拖入的文件，不是桌面上的东西）；瞳点就是拖拽指针。 */
const CHIP_FROM = { x: 1990, y: 610 };
const chipPath = (): Array<[number, number, number]> => {
  const to = examPt(EXAM_PT.drop);
  return [
    [DAY.examGrab, CHIP_FROM.x, CHIP_FROM.y],
    [DAY.examDrop - 0.04, to.x, to.y],
  ];
};
/** 指针越过启动台右边界（dragenter）的时刻 */
const DRAG_IN = (() => {
  for (let t = DAY.examGrab; t < DAY.examDrop; t += 0.004) if (pathAt(t, chipPath()).x < EXAM_RECT.x + EXAM_DROP_RIGHT) return t;
  return DAY.examDrop;
})();

const examState = (t: number): ExamState => {
  const [stage, since] = EXAM_STAGES.reduce((cur, s) => (t >= s[1] ? s : cur), EXAM_STAGES[0]);
  const pressAtT = EXAM_CLICKS.find(([, c]) => Math.abs(t - c) < 0.08)?.[1];
  const aiK = prog(t, AI_STREAM[0], AI_STREAM[1]);
  return {
    stage,
    enter: stage === 'home' ? 1 : prog(t, since, since + 0.05),
    collapse: prog(t, DAY.examNew + 0.02, DAY.examNew + 0.02 + SIDEBAR_COLLAPSE_S),
    timer: (() => {
      const sec = Math.max(0, Math.floor((t - DAY.examQ7) * PACE));
      return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    })(),
    created: t >= DAY.examNew + 0.02,
    renamed: prog(t, DAY.examParsed + 0.06, DAY.examParsed + 0.16),
    drag: t < DAY.examDrop + 0.02 ? prog(t, DRAG_IN, DRAG_IN + 0.04) : 0,
    hover: EXAM_CLICKS.find(([, c]) => t >= c - 0.09 && t < c + 0.05)?.[0] ?? null,
    press: pressAtT === undefined ? 0 : pressAt(t, pressAtT),
    parse: prog(t, DAY.examParse + 0.03, DAY.examParsed - 0.02),
    picked: t >= DAY.examPick + 0.01,
    submitted: prog(t, DAY.examSubmit + 0.03, DAY.examSubmit + 0.1),
    scroll:
      EXAM_SCROLL[0] * ease.inOutCubic(prog(t, ...EXAM_SCROLL1)) + (EXAM_SCROLL[1] - EXAM_SCROLL[0]) * ease.inOutCubic(prog(t, ...EXAM_SCROLL2)),
    ai: t < AI_THINK ? 'idle' : t < AI_STREAM[0] ? 'thinking' : aiK < 1 ? 'stream' : 'done',
    aiK: t < AI_STREAM[0] ? prog(t, AI_THINK, AI_STREAM[0]) : aiK,
  };
};

/** 瞳点捏住文件卡片左上角附近；落下时缩小淡出。 */
const CHIP_GRIP = { x: 34, y: 26 };
const chipPose = (t: number) => {
  const p = pathAt(t, chipPath());
  return {
    x: p.x - CHIP_GRIP.x,
    y: p.y - CHIP_GRIP.y,
    lift: 1 - prog(t, DAY.examDrop - 0.06, DAY.examDrop + 0.04),
    opacity: (t >= DAY.examGrab - 0.02 ? 1 : 0) * (1 - prog(t, DAY.examDrop, DAY.examDrop + 0.12)),
    scale: 1 - 0.3 * prog(t, DAY.examDrop - 0.02, DAY.examDrop + 0.12),
  };
};

// ── 镜头 ──────────────────────────────────────────────
const FULL = { x: 960, y: 540, zoom: 1 };
const DAY_CAM: CamKey[] = [
  [DAY.start, FULL],
  [DAY.dawn1, { x: 960, y: 540, zoom: 1.015 }, ease.linear],
  [25.25, { x: 960, y: 540, zoom: 1.015 }, ease.linear],
  // 推到右列小组件：今天的日程与到期卡片
  [25.8, { x: 1193, y: 430, zoom: 1.32 }, ease.inOutCubic],
  [DAY.todayOpen + 0.05, { x: 1193, y: 430, zoom: 1.32 }, ease.linear],
  // 转到待办窗口（今日视图）
  [26.6, { x: 768, y: 470, zoom: 1.25 }, ease.inOutCubic],
  [27.2, { x: 790, y: 470, zoom: 1.27 }, ease.linear],
  [DAY.todayFocus + 0.15, { x: 760, y: 520, zoom: 1.34 }, ease.inOutCubic],
  [28.2, { x: 760, y: 520, zoom: 1.35 }, ease.linear],
  // 退到全景：菜单栏 ⏱、Dock 上的番茄钟与红点
  [28.65, FULL, ease.inOutCubic],
  [DAY.examOpen + 0.1, FULL, ease.linear],
  // 06：窗口 + 右侧桌面（试卷从屏幕右缘拖进来）→ 推进识别导入 → 题库全貌 → 做题（取景含屏幕顶部，提示在那里）→ 推近 AI 解析
  [DAY.examNew - 0.12, { x: 800, y: 500, zoom: 1.15 }, ease.inOutCubic],
  [DAY.examGrab + 0.05, { x: 860, y: 500, zoom: 1.15 }, ease.linear],
  [DAY.examDrop + 0.22, { x: 536, y: 470, zoom: 1.55 }, ease.inOutCubic],
  [DAY.examParse + 0.1, { x: 536, y: 470, zoom: 1.55 }, ease.linear],
  [DAY.examParse + 0.5, { x: 536, y: 462, zoom: 1.6 }, ease.inOutCubic],
  [DAY.examParsed - 0.02, { x: 536, y: 462, zoom: 1.6 }, ease.linear],
  // 完成页的「查看题目」在栏底（窗口 y≈629），取景下缘要盖住它
  [DAY.examParsed + 0.2, { x: 536, y: 470, zoom: 1.65 }, ease.inOutCubic],
  [DAY.examView - 0.02, { x: 536, y: 472, zoom: 1.65 }, ease.linear],
  [DAY.examView + 0.24, { x: 536, y: 466, zoom: 1.4 }, ease.inOutCubic],
  [DAY.examQ7 - 0.02, { x: 536, y: 466, zoom: 1.4 }, ease.linear],
  [DAY.examQ7 + 0.26, { x: 602.5, y: 406, zoom: 1.33 }, ease.inOutCubic],
  [TOAST_AT + TOAST_DUR - 0.25, { x: 602.5, y: 406, zoom: 1.33 }, ease.linear],
  [TOAST_AT + TOAST_DUR + 0.3, { x: 552.5, y: 606, zoom: 1.75 }, ease.inOutCubic],
  [DAY.essayLaunch - 0.62, { x: 552.5, y: 610, zoom: 1.77 }, ease.linear],
  [DAY.essayLaunch - 0.25, FULL, ease.inOutCubic],
  [DAY.essayOpen + 0.1, FULL, ease.linear],
  // 07：作文窗口 → 新建 → 输入区（粘贴）→ 模型行（开始批改）→ 结果区（流式批注）→ 分数卡 / 雷达 → 润色提升
  [DAY.essayNew - 0.12, { x: 512, y: 460, zoom: 1.3 }, ease.inOutCubic],
  [DAY.essayNew + 0.06, { x: 512, y: 460, zoom: 1.3 }, ease.linear],
  [DAY.essayPaste - 0.04, { x: 540, y: 430, zoom: 1.45 }, ease.inOutCubic],
  [DAY.essayGrade + 0.05, { x: 560, y: 450, zoom: 1.45 }, ease.inOutCubic],
  [DAY.essayStream + 0.25, { x: 512, y: 430, zoom: 1.55 }, ease.inOutCubic],
  [DAY.essayDone, { x: 512, y: 440, zoom: 1.55 }, ease.linear],
  [DAY.essayScoreUp + 0.3, { x: 500, y: 450, zoom: 1.6 }, ease.inOutCubic],
  [DAY.essayPolish - 0.05, { x: 500, y: 450, zoom: 1.6 }, ease.linear],
  [DAY.essayPolish + 0.3, { x: 512, y: 440, zoom: 1.6 }, ease.inOutCubic],
  [DAY.translateLaunch - 0.75, { x: 514, y: 442, zoom: 1.61 }, ease.linear],
  [DAY.translateLaunch - 0.3, FULL, ease.inOutCubic],
  [DAY.translateOpen + 0.1, FULL, ease.linear],
  // 翻译窗口 → 新建 → 原文框（粘贴）→ 翻译 → 左右两栏看译文流出、保存
  [DAY.translateNew - 0.12, { x: 700, y: 520, zoom: 1.3 }, ease.inOutCubic],
  [DAY.translateNew + 0.06, { x: 700, y: 520, zoom: 1.3 }, ease.linear],
  [DAY.translatePaste - 0.03, { x: 640, y: 500, zoom: 1.42 }, ease.inOutCubic],
  [DAY.translateRun + 0.3, { x: 700, y: 520, zoom: 1.5 }, ease.inOutCubic],
  [DAY.showDesk2 - 0.45, { x: 720, y: 500, zoom: 1.55 }, ease.linear],
  [DAY.showDesk2 - 0.1, FULL, ease.inOutCubic],
  // 08a：全部应用面板 → 库页标题行 → 弹窗（链接 / 解析，随后拉开看分 P 列表）→ 新导入的列表 → 学习页（右侧字幕在画内，底边让给字幕条）
  [APPS_CLICK + 0.02, FULL, ease.linear],
  [APPS_CLICK + 0.2, { x: 960, y: 540, zoom: 1.22 }, ease.inOutCubic],
  [DAY.mediaEnter, { x: 960, y: 540, zoom: 1.24 }, ease.linear],
  [DAY.mediaOpen + 0.18, { x: 820, y: 470, zoom: 1.32 }, ease.inOutCubic],
  [DAY.mediaBili - 0.02, { x: 830, y: 470, zoom: 1.33 }, ease.linear],
  [DAY.mediaBili + 0.18, { x: 870, y: 530, zoom: 1.5 }, ease.inOutCubic],
  [DAY.mediaProbe, { x: 870, y: 530, zoom: 1.5 }, ease.linear],
  [DAY.mediaProbe + 0.16, { x: 850, y: 540, zoom: 1.3 }, ease.inOutCubic],
  [DAY.mediaImported - 0.02, { x: 850, y: 540, zoom: 1.3 }, ease.linear],
  [DAY.mediaImported + 0.16, { x: 760, y: 500, zoom: 1.3 }, ease.inOutCubic],
  [DAY.mediaRow - 0.02, { x: 760, y: 500, zoom: 1.3 }, ease.linear],
  [DAY.mediaRow + 0.2, { x: 700, y: 590, zoom: 1.25 }, ease.inOutCubic],
  [DAY.mediaPlay + 0.2, { x: 700, y: 590, zoom: 1.25 }, ease.linear],
  // 问答：播放器（跳转后换页）+ 右侧分区同在画内，左下角字幕落在播放器下方的黑边上
  [DAY.askTab + 0.05, { x: 770, y: 560, zoom: 1.4 }, ease.inOutCubic],
  [DAY.askSeek + 0.28, { x: 772, y: 560, zoom: 1.41 }, ease.linear],
  // 讲义：推近分区 → 笔记窗弹开后转向讲义正文（左缘留给字幕）
  [DAY.handoutTab + 0.12, { x: 1000, y: 520, zoom: 1.5 }, ease.inOutCubic],
  [DAY.handoutOpen, { x: 1000, y: 522, zoom: 1.5 }, ease.linear],
  [DAY.handoutOpen + 0.26, { x: 690, y: 600, zoom: 1.35 }, ease.inOutCubic],
  [DAY.handoutClose - 0.1, { x: 692, y: 602, zoom: 1.36 }, ease.linear],
  // 练习：回到分区，卡片在画内往下长
  [DAY.handoutClose + 0.24, { x: 1000, y: 560, zoom: 1.45 }, ease.inOutCubic],
  [DAY.mediaMin - 0.25, { x: 1000, y: 562, zoom: 1.46 }, ease.linear],
  [DAY.mediaMin + 0.2, FULL, ease.inOutCubic],
  [DAY.researchOpen + 0.1, FULL, ease.linear],
  // 08：空态输入框（技能命令补全）→ 消息与 ask_user 卡 → 任务面板 → 收起后整窗（侧栏 / 标题起名）→ 追问与论文下载卡
  // → 退全景点 Dock → 资源库「全部文件」→ 知识库索引。主列在右、底边留给左下角字幕
  [DAY.researchType - 0.08, { x: 1236, y: 430, zoom: 1.55 }, ease.inOutCubic],
  [DAY.researchSend - 0.02, { x: 1236, y: 440, zoom: 1.55 }, ease.linear],
  [DAY.researchSend + 0.25, { x: 1236, y: 470, zoom: 1.4 }, ease.inOutCubic],
  [DAY.researchAsk + 0.04, { x: 1236, y: 560, zoom: 1.45 }, ease.inOutCubic],
  [DAY.researchSubmit + 0.04, { x: 1236, y: 560, zoom: 1.45 }, ease.linear],
  [DAY.researchSteps + 0.25, { x: 1236, y: 585, zoom: 1.45 }, ease.inOutCubic],
  [DAY.researchDone - 0.02, { x: 1236, y: 585, zoom: 1.45 }, ease.linear],
  [DAY.researchDone + 0.16, { x: 1236, y: 560, zoom: 1.4 }, ease.inOutCubic],
  [DAY.researchCollapse - 0.02, { x: 1236, y: 560, zoom: 1.4 }, ease.linear],
  [DAY.researchCollapse + 0.2, { x: 1085, y: 470, zoom: 1.15 }, ease.inOutCubic],
  [DAY.noteType - 0.02, { x: 1085, y: 470, zoom: 1.15 }, ease.linear],
  // 改笔记：推近对话看发出与工具行 → 笔记窗弹入后转向笔记（标题栏下的条、撤销条、主要发现都在画内）→ 回对话点露出来的输入框
  [DAY.noteSend + 0.06, { x: 1236, y: 480, zoom: 1.35 }, ease.inOutCubic],
  [DAY.noteOpen - 0.02, { x: 1236, y: 480, zoom: 1.35 }, ease.linear],
  // 镜头贴左边界（clampCam：x ≥ 960 / zoom）、略推近：正文起点落在左下字幕右侧，文件树让给字幕
  [DAY.noteOpen + 0.26, { x: 620, y: 471, zoom: 1.55 }, ease.inOutCubic],
  [DAY.chatBack - 0.3, { x: 620, y: 474, zoom: 1.55 }, ease.linear],
  // 对话窗回到最前后，笔记窗（底边 872）还在它下面、比对话窗（底边 830）长出一截：取景下缘压在 830 以内，不露出底下那条正文
  [DAY.chatBack - 0.04, { x: 1236, y: 444, zoom: 1.4 }, ease.inOutCubic],
  [DAY.paperSend + 0.08, { x: 1236, y: 444, zoom: 1.4 }, ease.linear],
  [DAY.paperSaved + 0.02, { x: 1236, y: 455, zoom: 1.45 }, ease.inOutCubic],
  [DAY.hubIndex - 0.06, FULL, ease.inOutCubic],
  [DAY.hubIndex + 0.1, FULL, ease.linear],
  [DAY.hubIndex + 0.36, { x: 664, y: 564, zoom: 1.2 }, ease.inOutCubic],
  [DAY.hubKb + 0.04, { x: 664, y: 564, zoom: 1.2 }, ease.linear],
  [DAY.hubKb + 0.28, { x: 744, y: 584, zoom: 1.3 }, ease.inOutCubic],
  [DAY.end - 0.2, { x: 759, y: 584, zoom: 1.33 }, ease.linear],
  [DAY.end + 0.4, { x: 759, y: 584, zoom: 1.25 }, ease.inOutCubic],
];

// ── 瞳点 ──────────────────────────────────────────────
const AGENDA_BTN = agendaOpenCenter();
const ROW = { x: TODO_RECT.x + todoRowCenter().x, y: TODO_RECT.y + todoRowCenter().y };
const PLAY = { x: TODO_RECT.x + todoPlayCenter().x, y: TODO_RECT.y + todoPlayCenter().y };
/** 桌面空白处（双击「显示桌面」）：待办窗口与右列小组件之间 / 07 两个窗口左下方。 */
const DESK_SPOT = { x: 1250, y: 820 };
const DESK_SPOT2 = { x: 200, y: 800 };
const SC = (id: ShortcutId) => shortcutCenter(id);
/** 「翻译」快捷方式只露出作文窗口左缘（x=72）以左的那半截 */
const TR_SC = { x: SC('translation').x - 8, y: SC('translation').y };
const AGENDA_CLICK = DAY.todayOpen - 0.02;

const PUPIL_PATH: Array<[number, number, number]> = (() => {
  const ex = Object.fromEntries(Object.entries(EXAM_PT).map(([k, p]) => [k, examPt(p)])) as Record<keyof typeof EXAM_PT, { x: number; y: number }>;
  const es = Object.fromEntries(Object.entries(ESSAY_PT).map(([k, p]) => [k, essayPt(p)])) as Record<keyof typeof ESSAY_PT, { x: number; y: number }>;
  const tp = Object.fromEntries(Object.entries(TRANS_PT).map(([k, p]) => [k, transPt(p)])) as Record<keyof typeof TRANS_PT, { x: number; y: number }>;
  const cp = Object.fromEntries(Object.entries(CHAT_PT).map(([k, p]) => [k, chatPt(p)])) as Record<keyof typeof CHAT_PT, { x: number; y: number }>;
  const kb = hubPt(HUB_PT.kb);
  const raise = chatPt(CHAT_RAISE);
  const chatIcon = dockIconCenter('chat', runningAt(CHAT_CLICK));
  const filesIcon = dockIconCenter('files', runningAt(HUB_CLICK));
  const appsIcon = dockIconCenter('__apps__', runningAt(APPS_CLICK));
  const md = {
    bili: mediaPt(LIB_PT.bili),
    row: mediaPt(LIB_PT.row(STUDY_PAGE)),
    play: mediaPt(STUDY_PT.play),
    tabAsk: mediaPt(STUDY_PT.tab('ask')),
    tabHandout: mediaPt(STUDY_PT.tab('handout')),
    tabPractice: mediaPt(STUDY_PT.tab('practice')),
    askStart: mediaPt(STUDY_PT.askStart),
    send: mediaPt(STUDY_PT.send),
    chip: mediaPt(ASK_CHIP_PT),
    gen: mediaPt(STUDY_PT.handoutGen),
    item: mediaPt(STUDY_PT.handoutItem),
    cards: mediaPt(STUDY_PT.practiceCards),
  };
  const hoRed = { x: HANDOUT_RECT.x + trafficCenter(0).x, y: HANDOUT_RECT.y + trafficCenter(0).y };
  const hoWheel = { x: HANDOUT_RECT.x + 900, y: HANDOUT_RECT.y + 560 };
  const yellow = { x: MEDIA_RECT.x + trafficCenter(1).x, y: MEDIA_RECT.y + trafficCenter(1).y };
  return [
    // 今日：日程小组件「待办 →」→ 第 2 行 → ▷ 开始专注 → 双击桌面空白 → 双击「题目集」
    [25.45, AGENDA_BTN.x + 140, AGENDA_BTN.y + 170],
    [AGENDA_CLICK - 0.05, AGENDA_BTN.x, AGENDA_BTN.y],
    [AGENDA_CLICK + 0.1, AGENDA_BTN.x, AGENDA_BTN.y],
    [TODO_ROW_IN, ROW.x, ROW.y],
    [27.0, ROW.x + 40, ROW.y + 4],
    [DAY.todayFocus - 0.05, PLAY.x, PLAY.y],
    [DAY.todayFocus + 0.4, PLAY.x + 40, PLAY.y + 60],
    [DAY.showDesk - 0.1, DESK_SPOT.x, DESK_SPOT.y],
    [DAY.showDesk + 0.12, DESK_SPOT.x, DESK_SPOT.y],
    [DAY.examLaunch - 0.06, SC('exam').x, SC('exam').y],
    [DAY.examLaunch + DBL + 0.06, SC('exam').x, SC('exam').y],
    // 06：新建题目集 →（隐去，从屏幕右缘拖着试卷进来）→ 解析文档 → 查看题目 → 第 7 题 → A → 提交 → 滚动 → AI 解析
    [DAY.examNew - 0.07, ex.newExam.x, ex.newExam.y],
    [DAY.examNew + 0.2, ex.newExam.x + 4, ex.newExam.y + 3],
    ...chipPath(),
    [DAY.examDrop + 0.1, ex.drop.x + 6, ex.drop.y + 4],
    [DAY.examParse - 0.07, ex.parse.x, ex.parse.y],
    [DAY.examParse + 0.06, ex.parse.x, ex.parse.y],
    [DAY.examParsed - 0.3, ex.parse.x + 255, ex.parse.y + 120],
    [DAY.examView - 0.07, ex.view.x, ex.view.y],
    [DAY.examView + 0.06, ex.view.x, ex.view.y],
    [DAY.examQ7 - 0.07, ex.q7.x, ex.q7.y],
    [DAY.examQ7 + 0.06, ex.q7.x, ex.q7.y],
    [DAY.examPick - 0.07, ex.optA.x, ex.optA.y],
    [DAY.examPick + 0.05, ex.optA.x, ex.optA.y],
    [DAY.examSubmit - 0.07, ex.submit.x, ex.submit.y],
    [DAY.examSubmit + 0.06, ex.submit.x, ex.submit.y],
    [EXAM_SCROLL1[0] - 0.02, ex.wheel.x, ex.wheel.y],
    [EXAM_SCROLL1[1] + 0.02, ex.wheel.x, ex.wheel.y],
    [DAY.examAI - 0.07, ex.ai.x, ex.ai.y - EXAM_SCROLL[0]],
    [DAY.examAI + 0.06, ex.ai.x, ex.ai.y - EXAM_SCROLL[0]],
    [EXAM_SCROLL2[0] - 0.05, ex.aside.x, ex.aside.y - 40],
    [EXAM_SCROLL2[1] + 0.3, ex.aside.x + 10, ex.aside.y - 25],
    // 07：双击「作文批改」→ 新建 → 点进输入框粘贴 → 开始批改 → 停在结果区（滚动看分数 / 雷达）→ 润色提升；
    // 双击「翻译」（快捷方式右半截被作文窗口挡住，点露出来的那半）→ 新建 → 点进原文框粘贴 → 翻译 → 让开译文栏
    [DAY.essayLaunch - 0.45, SC('essay').x + 170, SC('essay').y + 120],
    [DAY.essayLaunch - 0.06, SC('essay').x, SC('essay').y],
    [DAY.essayLaunch + DBL + 0.06, SC('essay').x, SC('essay').y],
    [DAY.essayNew - 0.07, es.newEssay.x, es.newEssay.y],
    [DAY.essayNew + 0.06, es.newEssay.x, es.newEssay.y],
    [DAY.essayPaste - 0.07, es.input.x, es.input.y],
    [DAY.essayPaste + 0.06, es.input.x, es.input.y],
    [DAY.essayGrade - 0.07, es.grade.x, es.grade.y],
    [DAY.essayGrade + 0.06, es.grade.x, es.grade.y],
    [DAY.essayStream + 0.22, es.wheel.x, es.wheel.y],
    [DAY.essayRadar + 0.27, es.wheel.x + 6, es.wheel.y + 4],
    [DAY.essayPolish - 0.07, es.polish.x, es.polish.y],
    [DAY.essayPolish + 0.06, es.polish.x, es.polish.y],
    [DAY.essayPolish + 0.45, es.polish.x + 150, es.polish.y + 160],
    [DAY.translateLaunch - 0.4, TR_SC.x + 200, TR_SC.y + 110],
    [DAY.translateLaunch - 0.06, TR_SC.x, TR_SC.y],
    [DAY.translateLaunch + DBL + 0.06, TR_SC.x, TR_SC.y],
    [DAY.translateNew - 0.07, tp.newTranslation.x, tp.newTranslation.y],
    [DAY.translateNew + 0.06, tp.newTranslation.x, tp.newTranslation.y],
    [DAY.translatePaste - 0.07, tp.input.x, tp.input.y],
    [DAY.translatePaste + 0.06, tp.input.x, tp.input.y],
    [DAY.translateRun - 0.07, tp.run.x, tp.run.y],
    [DAY.translateRun + 0.06, tp.run.x, tp.run.y],
    [DAY.translateRun + 0.45, tp.run.x - 170, tp.run.y + 2],
    // 显示桌面 → Dock「对话」还原
    [DAY.showDesk2 - 0.3, DESK_SPOT2.x + 160, DESK_SPOT2.y - 90],
    [DAY.showDesk2 - 0.04, DESK_SPOT2.x, DESK_SPOT2.y],
    [DAY.showDesk2 + DBL + 0.05, DESK_SPOT2.x, DESK_SPOT2.y],
    // 08a：Dock「全部应用」→（打字时指针停着）→ 标题行「B 站链接」→ 链接框 → 解析 → 导入 → P4 → 播放 → 移到字幕 → 点那一句 → 黄灯
    [APPS_CLICK - 0.06, appsIcon.x, appsIcon.y],
    [APPS_CLICK + 0.12, appsIcon.x, appsIcon.y],
    [DAY.mediaEnter + 0.04, appsIcon.x - 60, appsIcon.y - 180],
    [DAY.mediaBili - 0.07, md.bili.x, md.bili.y],
    [DAY.mediaBili + 0.06, md.bili.x, md.bili.y],
    [DAY.mediaPaste - 0.07, DLG_PT.input.x, DLG_PT.input.y],
    [DAY.mediaPaste + 0.04, DLG_PT.input.x, DLG_PT.input.y],
    [DAY.mediaParse - 0.07, DLG_PT.parse.x, DLG_PT.parse.y],
    [DAY.mediaParse + 0.06, DLG_PT.parse.x, DLG_PT.parse.y],
    [DAY.mediaImport - 0.07, DLG_PT.confirm.x, DLG_PT.confirm.y],
    [DAY.mediaImport + 0.06, DLG_PT.confirm.x, DLG_PT.confirm.y],
    [DAY.mediaRow - 0.07, md.row.x, md.row.y],
    [DAY.mediaRow + 0.05, md.row.x, md.row.y],
    [DAY.mediaPlay - 0.07, md.play.x, md.play.y],
    [DAY.mediaPlay + 0.05, md.play.x, md.play.y],
    [DAY.askTab - 0.07, md.tabAsk.x, md.tabAsk.y],
    [DAY.askTab + 0.05, md.tabAsk.x, md.tabAsk.y],
    [DAY.askStart - 0.07, md.askStart.x, md.askStart.y],
    [DAY.askStart + 0.05, md.askStart.x, md.askStart.y],
    [DAY.askSend - 0.07, md.send.x, md.send.y],
    [DAY.askSend + 0.05, md.send.x, md.send.y],
    [DAY.askAnswer + 0.3, md.send.x - 40, md.send.y - 90],
    [DAY.askSeek - 0.07, md.chip.x, md.chip.y],
    [DAY.askSeek + 0.06, md.chip.x, md.chip.y],
    [DAY.handoutTab - 0.07, md.tabHandout.x, md.tabHandout.y],
    [DAY.handoutTab + 0.05, md.tabHandout.x, md.tabHandout.y],
    [DAY.handoutGen - 0.07, md.gen.x, md.gen.y],
    [DAY.handoutGen + 0.05, md.gen.x, md.gen.y],
    [DAY.handoutOpen - 0.08, md.item.x, md.item.y],
    [DAY.handoutOpen + 0.05, md.item.x, md.item.y],
    [DAY.handoutScroll - 0.04, hoWheel.x, hoWheel.y],
    [DAY.handoutScroll + 0.34, hoWheel.x + 6, hoWheel.y + 4],
    [DAY.handoutClose - 0.08, hoRed.x, hoRed.y],
    [DAY.handoutClose + 0.05, hoRed.x, hoRed.y],
    [DAY.practiceTab - 0.07, md.tabPractice.x, md.tabPractice.y],
    [DAY.practiceTab + 0.05, md.tabPractice.x, md.tabPractice.y],
    [DAY.practiceCards - 0.07, md.cards.x, md.cards.y],
    [DAY.practiceCards + 0.05, md.cards.x, md.cards.y],
    [DAY.practiceCards + 0.4, md.cards.x + 60, md.cards.y + 180],
    [DAY.mediaMin - 0.07, yellow.x, yellow.y],
    [DAY.mediaMin + 0.06, yellow.x, yellow.y],
    [CHAT_CLICK - 0.06, chatIcon.x, chatIcon.y],
    [CHAT_CLICK + 0.12, chatIcon.x, chatIcon.y],
    // 08：点进输入框（打字时指针停着）→ 发送 →「中等深度」→「提交」→（任务进行中隐去）→ 面板 ^ → 输入框 → 发送（改笔记）→
    //（笔记窗里 AI 直改时隐去）→ 点对话窗露出来的输入框 → 发送（追问论文）→ Dock「资源库」→ 侧栏「知识库索引」
    [RESEARCH_TL.focus - 0.07, cp.composer.x, cp.composer.y],
    [RESEARCH_TL.focus + 0.06, cp.composer.x, cp.composer.y],
    [DAY.researchSend - 0.07, cp.send.x, cp.send.y],
    [DAY.researchSend + 0.06, cp.send.x, cp.send.y],
    [DAY.researchPick - 0.07, cp.opt1.x, cp.opt1.y],
    [DAY.researchPick + 0.05, cp.opt1.x, cp.opt1.y],
    [DAY.researchSubmit - 0.07, cp.submit.x, cp.submit.y],
    [DAY.researchSubmit + 0.06, cp.submit.x, cp.submit.y],
    [DAY.researchSubmit + 0.32, cp.submit.x - 60, cp.submit.y - 40],
    [DAY.researchCollapse - 0.3, cp.collapse.x - 80, cp.collapse.y + 120],
    [DAY.researchCollapse - 0.07, cp.collapse.x, cp.collapse.y],
    [DAY.researchCollapse + 0.06, cp.collapse.x, cp.collapse.y],
    [RESEARCH_TL.focus3 - 0.08, cp.composer2.x, cp.composer2.y],
    [RESEARCH_TL.focus3 + 0.05, cp.composer2.x, cp.composer2.y],
    [DAY.noteSend - 0.07, cp.send2.x, cp.send2.y],
    [DAY.noteSend + 0.06, cp.send2.x, cp.send2.y],
    [DAY.noteSend + 0.32, cp.send2.x - 120, cp.send2.y - 60],
    [DAY.chatBack - 0.3, raise.x + 40, raise.y + 110],
    [DAY.chatBack - 0.07, raise.x, raise.y],
    [DAY.chatBack + 0.05, raise.x, raise.y],
    [DAY.paperSend - 0.07, cp.send2.x, cp.send2.y],
    [DAY.paperSend + 0.06, cp.send2.x, cp.send2.y],
    [DAY.paperSend + 0.32, cp.send2.x - 120, cp.send2.y - 60],
    [HUB_CLICK - 0.45, filesIcon.x + 150, filesIcon.y - 200],
    [HUB_CLICK - 0.06, filesIcon.x, filesIcon.y],
    [HUB_CLICK + 0.12, filesIcon.x, filesIcon.y],
    [DAY.hubKb - 0.07, kb.x, kb.y],
    [DAY.hubKb + 0.06, kb.x, kb.y],
    [DAY.hubKb + 0.4, kb.x + 160, kb.y + 120],
  ];
})();

const dbl = (at: number) => [at, at + DBL];
const CLICKS = [
  AGENDA_CLICK,
  DAY.todayFocus,
  ...dbl(DAY.showDesk),
  ...dbl(DAY.examLaunch),
  ...EXAM_CLICKS.map(([, c]) => c),
  ...dbl(DAY.essayLaunch),
  DAY.essayNew,
  DAY.essayPaste,
  DAY.essayGrade,
  DAY.essayPolish,
  ...dbl(DAY.translateLaunch),
  DAY.translateNew,
  DAY.translatePaste,
  DAY.translateRun,
  ...dbl(DAY.showDesk2),
  APPS_CLICK,
  DAY.mediaBili,
  DAY.mediaPaste,
  DAY.mediaParse,
  DAY.mediaImport,
  DAY.mediaRow,
  DAY.mediaPlay,
  DAY.askTab,
  DAY.askStart,
  DAY.askSend,
  DAY.askSeek,
  DAY.handoutTab,
  DAY.handoutGen,
  DAY.handoutOpen,
  DAY.handoutClose,
  DAY.practiceTab,
  DAY.practiceCards,
  DAY.mediaMin,
  CHAT_CLICK,
  RESEARCH_TL.focus,
  DAY.researchSend,
  DAY.researchPick,
  DAY.researchSubmit,
  DAY.researchCollapse,
  RESEARCH_TL.focus3,
  DAY.noteSend,
  DAY.chatBack,
  DAY.paperSend,
  HUB_CLICK,
  DAY.hubKb,
];

/** 瞳点可见区间：各段动作前后淡入淡出。 */
const PUPIL_SHOW: Array<[number, number]> = [
  [25.45, DAY.examNew + 0.2],
  [DAY.examGrab, EXAM_SCROLL2[1] + 0.35],
  [DAY.essayLaunch - 0.45, DAY.essayPolish + 0.5],
  [DAY.translateLaunch - 0.4, DAY.translateRun + 0.5],
  [DAY.showDesk2 - 0.3, DAY.researchSend + 0.3],
  [DAY.researchPick - 0.25, DAY.researchSubmit + 0.32],
  [DAY.researchCollapse - 0.3, DAY.noteSend + 0.32],
  [DAY.chatBack - 0.3, DAY.paperSend + 0.32],
  [HUB_CLICK - 0.45, DAY.hubKb + 0.45],
];
const pupilOpacity = (t: number) => Math.max(0, ...PUPIL_SHOW.map(([a, b]) => Math.min(prog(t, a, a + 0.12), 1 - prog(t, b - 0.14, b))));

/** 双击桌面快捷方式：第一击选中（焦点底 + 标签高亮），每击按下时插画缩到 0.94；窗口打开后焦点移走。 */
const shortcutState = (t: number) => {
  for (const [id, at, open] of [
    ['exam', DAY.examLaunch, DAY.examOpen],
    ['essay', DAY.essayLaunch, DAY.essayOpen],
    ['translation', DAY.translateLaunch, DAY.translateOpen],
  ] as Array<[ShortcutId, number, number]>) {
    if (t >= at - 0.03 && t < open + 0.02) {
      return { selected: { id, k: t >= at ? 1 : 0 }, pressed: { id, k: Math.max(pressAt(t, at, 0.04), pressAt(t, at + DBL, 0.04)) } };
    }
  }
  return {};
};

const dockTipAt = (t: number) => {
  for (const [id, at] of [
    ['__apps__', APPS_CLICK],
    ['chat', CHAT_CLICK],
    ['files', HUB_CLICK],
  ] as Array<[string, number]>) {
    const h0 = at - 0.36;
    if (t >= h0 && t < at + 0.2) return { id, k: prog(t, h0 + TIP_DELAY_S, h0 + TIP_DELAY_S + TIP_FADE_S, ease.wbOut) * (1 - prog(t, at + 0.1, at + 0.16)) };
  }
  return undefined;
};

const Desktop = ({ t }: { t: number }) => {
  const k = themeK(t);
  const bar = dayMenubar(t);
  const dim = dimAt(t);
  const sc = shortcutState(t);
  const done = doneAt(t);
  const pending = TODO_ITEMS.slice(t < DAY.essayOpen ? 0 : t < DAY.researchOpen ? 2 : 3);
  const day = t < DAY.clock ? 2 : 3;
  const agendaPress = pressAt(t, AGENDA_CLICK, 0.06);
  const layer = (tk: Tokens, opacity: number, children: ReactNode) => (opacity > 0.001 ? <div style={{ position: 'absolute', inset: 0, opacity }}>{children}</div> : null);
  const widgets = (tk: Tokens) => (
    <>
      <AgendaWidget tk={tk} dim={dim} day={day} items={pending} openPress={agendaPress} />
      <BriefingWidget tk={tk} dim={dim} due={bar.due} done={day === 2 ? 2 : done} total={day === 2 ? 2 : 4} />
    </>
  );
  return (
    <>
      <Wallpaper drift={wallDrift(t)} night={night(t)} />
      <DesktopShortcuts tk={k > 0.5 ? light : dark} selected={sc.selected} pressed={sc.pressed} />
      {layer(dark, 1 - k, widgets(dark))}
      {layer(light, k, widgets(light))}
    </>
  );
};

const Chrome = ({ t, running }: { t: number; running: string[] }) => {
  const k = themeK(t);
  const bar = dayMenubar(t);
  const badges: Record<string, DockBadge> = {};
  if (bar.due > 0) badges.flashcards = { kind: 'count', value: bar.due };
  if (bar.pomo) badges.pomodoro = { kind: 'dot' };
  const indicator = Object.fromEntries(Object.entries(FIRST_OPEN).map(([id, at]) => [id, (t - at) / IND_S]));
  // 笔记先在 08a 为讲义开过一次（随后关掉），08 再开时指示点重新入场
  if (t < DAY.noteOpen) indicator.notes = (t - HO_OPEN) / IND_S;
  const bounce = { todo: dockBounceAt(t, DAY.todayOpen), media: dockBounceAt(t, DAY.mediaOpen), files: dockBounceAt(t, DAY.hubIndex) };
  const tip = dockTipAt(t);
  const press = { __apps__: pressAt(t, APPS_CLICK, 0.07), chat: pressAt(t, CHAT_CLICK, 0.07), files: pressAt(t, HUB_CLICK, 0.07) };
  const layer = (tk: Tokens, opacity: number, children: ReactNode) => (opacity > 0.001 ? <div style={{ position: 'absolute', inset: 0, opacity }}>{children}</div> : null);
  const both = (tk: Tokens) => (
    <>
      <MenuBar tk={tk} app={bar.app} clock={bar.clock} due={bar.due} pomo={bar.pomo} />
      <Dock tk={tk} running={running} bounce={bounce} tip={tip} press={press} badges={badges} indicator={indicator} />
    </>
  );
  return (
    <>
      {layer(dark, 1 - k, both(dark))}
      {layer(light, k, both(light))}
    </>
  );
};

export const SceneDay = ({ t }: { t: number }) => {
  const tk = light;
  const cam = clampCam(camAt(t, DAY_CAM));
  const running = runningAt(t);
  const icon = (id: string, at: number) => dockIconCenter(id, runningAt(at));

  const todo = winLife(t, TODO_RECT, { openAt: DAY.todayOpen, openFrom: icon('todo', DAY.todayOpen), minimizeAt: SHOW_MIN, minimizeTo: icon('todo', SHOW_MIN) });
  const pomoWin = winLife(t, POMO_RECT, { openAt: SHOW_MIN, minimizeAt: SHOW_MIN, minimizeTo: icon('pomodoro', SHOW_MIN) });
  const exam = winLife(t, EXAM_RECT, { openAt: DAY.examOpen, minimizeAt: SHOW_MIN2, minimizeTo: icon('exam', SHOW_MIN2) });
  const essay = winLife(t, ESSAY_RECT, { openAt: DAY.essayOpen, minimizeAt: SHOW_MIN2, minimizeTo: icon('essay', SHOW_MIN2) });
  const trans = winLife(t, TRANS_RECT, { openAt: DAY.translateOpen, minimizeAt: SHOW_MIN2, minimizeTo: icon('translation', SHOW_MIN2) });
  const media = winLife(t, MEDIA_RECT, { openAt: DAY.mediaOpen, openFrom: null, minimizeAt: MEDIA_MIN, minimizeTo: icon('media', MEDIA_MIN) });
  const chat = winLife(t, CHAT_RECT, { restoreAt: DAY.researchOpen, restoreFrom: icon('chat', DAY.researchOpen) });
  const notes = winLife(t, NOTES_RECT, { openAt: DAY.noteOpen, openFrom: null });
  const handout = winLife(t, HANDOUT_RECT, { openAt: HO_OPEN, openFrom: null, closeAt: HO_CLOSE });
  const hub = winLife(t, HUB_RECT, { openAt: DAY.hubIndex, openFrom: icon('files', DAY.hubIndex) });
  // 笔记窗在点回对话窗之前压在对话窗上面，之后退到下面
  const notesEl = notes.visible ? (
    <WbWindow tk={tk} rect={NOTES_RECT} focused={t < DAY.chatBack} toolbar={<NotesTitlebar saving={false} />} style={notes.style}>
      <NotesView s={notesState(t)} />
    </WbWindow>
  ) : null;
  const hubView = t < DAY.hubKb + 0.01 ? 'all' : 'index';

  const exit = prog(t, DAY.end - 0.3, DAY.end + 0.2, ease.inOutCubic);
  const chip = chipPose(t);
  const pw = pathAt(t, PUPIL_PATH);
  const ps = project(cam, pw.x, pw.y);
  const pOpacity = pupilOpacity(t);

  return (
    <AbsoluteFill style={{ opacity: 1 - exit, transform: `scale(${1 - 0.04 * exit})` }}>
      <CameraView cam={cam}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080 }}>
          <Desktop t={t} />
          {pomoWin.visible ? (
            <WbWindow tk={tk} rect={POMO_RECT} title={pomoTitle} focused={false} style={pomoWin.style}>
              <PomodoroWindowBody tk={tk} remaining={focusLeft(t)} ring={((t - DAY.todayFocus) * PACE) / 1500} />
            </WbWindow>
          ) : null}
          {todo.visible ? (
            <WbWindow tk={tk} rect={TODO_RECT} focused={t < SHOW_MIN} toolbar={<TodoToolbar tk={tk} view="today" />} style={todo.style}>
              <TodoApp tk={tk} s={todoState(t)} />
            </WbWindow>
          ) : null}
          {exam.visible ? (
            <WbWindow tk={tk} rect={EXAM_RECT} toolbar={<ResourceTitlebar title={APP_NAMES.exam} rail={t < DAY.examNew + 0.02} />} focused={t < DAY.essayOpen} style={exam.style}>
              <ExamView tk={tk} s={examState(t)} />
            </WbWindow>
          ) : null}
          {essay.visible ? (
            <WbWindow tk={tk} rect={ESSAY_RECT} toolbar={<ResourceTitlebar title={APP_NAMES.essay} rail={t < DAY.essayNew + 0.02} />} focused={t < DAY.translateOpen} style={essay.style}>
              <EssayView tk={tk} s={essayState(t)} />
            </WbWindow>
          ) : null}
          {trans.visible ? (
            <WbWindow tk={tk} rect={TRANS_RECT} toolbar={<ResourceTitlebar title={APP_NAMES.translation} rail={t < DAY.translateNew + 0.02} />} focused={t < SHOW_MIN2} style={trans.style}>
              <TranslateView tk={tk} s={transState(t)} />
            </WbWindow>
          ) : null}
          {media.visible ? (
            <WbWindow tk={tk} rect={MEDIA_RECT} focused={!handoutOn(t)} title={t < DAY.mediaRow + 0.02 ? APP_NAMES.media : `${APP_NAMES.media} · ${pageName(STUDY_PAGE)}`} style={media.style}>
              {t < DAY.mediaRow + 0.08 ? <MediaLibrary tk={tk} s={libraryState(t)} /> : null}
              {t >= DAY.mediaRow + 0.02 ? <MediaStudy tk={tk} s={studyState(t)} /> : null}
            </WbWindow>
          ) : null}
          {handout.visible ? (
            <WbWindow tk={tk} rect={HANDOUT_RECT} toolbar={<NotesTitlebar saving={false} title={HANDOUT_TITLE} />} style={handout.style}>
              <HandoutNotesView scroll={handoutScroll(t)} />
            </WbWindow>
          ) : null}
          <AppsPanel tk={tk} s={appsPanelState(t)} />
          {t >= DAY.chatBack ? notesEl : null}
          {chat.visible ? (
            <WbWindow
              tk={tk}
              rect={CHAT_RECT}
              focused={(t < DAY.noteOpen || t >= DAY.chatBack) && t < DAY.hubIndex}
              toolbar={<ChatTitlebar title="新对话" next={SESSION_TITLE} k={prog(t, DAY.researchTitle, DAY.researchTitle + 0.06)} />}
              style={chat.style}
            >
              <ResearchChat tk={tk} t={t} tl={RESEARCH_TL} />
            </WbWindow>
          ) : null}
          {t < DAY.chatBack ? notesEl : null}
          {hub.visible ? (
            <WbWindow tk={tk} rect={HUB_RECT} toolbar={<HubTitlebar view={hubView} />} style={hub.style}>
              <HubWindow view={hubView} k={prog(t, DAY.hubKb + 0.01, DAY.hubKb + 0.06)} kbHover={t >= DAY.hubKb - 0.12 && t < DAY.hubKb + 0.02 ? 1 : 0} />
            </WbWindow>
          ) : null}
          {chip.opacity > 0.001 ? (
            <div style={{ position: 'absolute', left: chip.x, top: chip.y, opacity: chip.opacity, transform: `scale(${chip.scale})`, transformOrigin: `${CHIP_GRIP.x}px ${CHIP_GRIP.y}px` }}>
              <FileChip tk={tk} lift={chip.lift} />
            </div>
          ) : null}
          <Chrome t={t} running={running} />
          {t >= DAY.mediaBili && t < DAY.mediaImported + 0.1 ? <BiliDialog tk={tk} s={dialogState(t)} /> : null}
          <ExamToast tk={tk} life={t - TOAST_AT} dur={TOAST_DUR} />
          <ExamToast tk={tk} life={t - DAY.handoutDone - 0.02} dur={DAY.handoutOpen - DAY.handoutDone + 0.3} text={S.media.handout.saved(HANDOUT_TITLE)} action={S.media.handout.openNote} />
        </div>
      </CameraView>
      <Pupil x={ps.x} y={ps.y} t={t} opacity={pOpacity} clicks={CLICKS} />
    </AbsoluteFill>
  );
};

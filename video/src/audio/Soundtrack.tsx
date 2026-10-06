import { Audio, Sequence, staticFile } from 'remotion';
import { FPS, PACE } from '../lib/time';
import { DAY, DBL, researchStepDone } from '../scenes/day/beats';
import { FN } from '../scenes/finale/beats';
import { YOU } from '../scenes/you/SceneYou';
import { ESSAY_STREAM } from '../ui/essay';
import { EXAM_PARSE_MARKS } from '../ui/exam';
import { TRANS_LEN, TRANS_PARAS } from '../ui/translate';
import { STEPS } from '../ui/research';
import { GROW, majorRingTimes } from '../scenes/finale/terrain';
import { MM } from '../scenes/organize/MindmapView';
import { PR } from '../scenes/practice/beats';
import { POST, RV } from '../scenes/retrieval/beats';
import { REVIEW_MEMORY, REVIEW_MEMORY_FRESH, WK } from '../scenes/review/SceneReview';
import { memoryDuePasses } from '../ui/flashcards';

/**
 * 配乐 + 音效。样本由 scripts/synth-score.mjs 生成（public/audio/）；
 * 音效时刻全部引用各段节拍常量，改节拍时声音跟着走。
 */
type Sfx = 'click' | 'tick' | 'whoosh-up' | 'whoosh-down' | 'pop' | 'flip' | 'boom' | 'ping' | 'note-low' | 'note-mid' | 'note-high' | 'note-top' | 'chime' | 'swell';
type Cue = [time: number, sfx: Sfx, volume: number];

const PROMPT_LEN = [...'讲透这一节：画导图、出卡片'].length;
/** 06 解析进度（0–1）→ 脚本秒，与 SceneDay 的 examState.parse 同一区间。 */
const parseT = (k: number) => DAY.examParse + 0.03 + (DAY.examParsed - 0.02 - DAY.examParse - 0.03) * k;
/** 07 流式位置 → 脚本秒，与 SceneDay 的 essayState.stream / transState.run 同一区间。 */
const essayStreamT = (raw: number) => DAY.essayStream + ((DAY.essayDone - 0.03 - DAY.essayStream) * raw) / ESSAY_STREAM.total;
const transStreamT = (c: number) => DAY.translateStream + ((DAY.translateDone - 0.02 - DAY.translateStream) * c) / TRANS_LEN;
const RATING_NOTE: Record<number, Sfx> = { 1: 'note-low', 2: 'note-mid', 3: 'note-mid', 4: 'note-high' };
const REVEAL_NOTES: Sfx[] = ['note-low', 'note-mid', 'note-high', 'note-top'];
const CURVE_NOTES: Sfx[] = ['note-low', 'note-mid', 'note-high'];

const CUES: Cue[] = [
  // 01 读懂：划选 → 引用芯片 → 打字 → 发送
  [2.0, 'whoosh-up', 0.18],
  [3.0, 'click', 0.35],
  [3.5, 'pop', 0.28],
  ...Array.from({ length: PROMPT_LEN }, (_, i): Cue => [3.98 + (i * 0.46) / PROMPT_LEN, 'tick', 0.12]),
  [4.5, 'click', 0.35],
  [4.52, 'whoosh-up', 0.22],
  // 02 看清：匹配剪辑进 3D → 扫描 → 命中 → 回到界面
  [RV.cut, 'boom', 0.62],
  ...Array.from({ length: 8 }, (_, k): Cue => [RV.scan + k * 0.085, 'ping', 0.22 * (1 - k * 0.09)]),
  [RV.select, 'note-high', 0.3],
  [RV.extract, 'whoosh-up', 0.3],
  [RV.reveal, 'whoosh-down', 0.3],
  [RV.land1, 'pop', 0.3],
  [RV.land2, 'tick', 0.22],
  [RV.land3, 'tick', 0.22],
  [9.1 + POST, 'click', 0.35],
  [9.5 + POST, 'pop', 0.22],
  [10.5 + POST, 'click', 0.35],
  // 03 整理：右侧面板打开导图 → 两次切结构（开弹层 / 点选）→ 背诵：遮住 → 逐个揭示（上行琶音）→ 全部揭示 → 回到对话
  [MM.open, 'whoosh-up', 0.2],
  ...MM.structClicks.map((s): Cue => [s, 'click', 0.33]),
  ...MM.picks.flatMap((s): Cue[] => [
    [s, 'click', 0.33],
    [s + 0.02, 'flip', 0.16],
  ]),
  [MM.reciteClick, 'click', 0.33],
  [MM.maskClick, 'click', 0.33],
  ...MM.reveals.map((r, i): Cue => [r, REVEAL_NOTES[i], 0.32]),
  [MM.revealAll, 'click', 0.3],
  [MM.revealAll + 0.02, REVEAL_NOTES[3], 0.32],
  [MM.close0, 'whoosh-down', 0.26],
  // 04 练习：卡片逐张落入 → 点「复习这批」→ 缩进 Dock → 闪卡窗口弹开 → 翻面 / 评分
  ...Array.from({ length: 12 }, (_, i): Cue => [PR.cards0 + i * PR.cardGap, 'tick', 0.1 + (i % 3) * 0.02]),
  [PR.done, 'note-mid', 0.22],
  [PR.reviewClick, 'click', 0.35],
  [PR.reviewClick + 0.04, 'whoosh-down', 0.32],
  [WK.open0, 'whoosh-up', 0.26],
  [WK.open0 + 0.02, 'pop', 0.3],
  ...WK.cards.flatMap((c): Cue[] => [
    [c.show, 'click', 0.33],
    [c.show + 0.02, 'flip', 0.32],
    [c.rate, 'click', 0.33],
    [c.rate + 0.02, RATING_NOTE[c.rating], 0.32],
  ]),
  // 05 记住：退出 → 统计；记忆曲线从左展开，依次扫过本次三张卡的下次复习点（重来 1 分钟 → 良好 10 分钟 → 简单 15 天）
  [WK.exit, 'click', 0.28],
  [WK.stats, 'click', 0.28],
  ...memoryDuePasses(REVIEW_MEMORY, WK.stats + 0.03, REVIEW_MEMORY_FRESH).map((s, i): Cue => [s, CURVE_NOTES[i], 0.3]),
  // 夜里收场（点黄灯，闪卡窗口 genie 进 Dock）→ 清晨
  [WK.minimize, 'click', 0.3],
  [WK.out0 + 0.02, 'whoosh-down', 0.18],
  [DAY.dawn0 + 0.1, 'swell', 0.4],
  [DAY.clock, 'tick', 0.14],
  // 今日：日程小组件「待办 →」→ 开始专注 → 显示桌面 → 双击「题目集」
  [DAY.todayOpen - 0.02, 'click', 0.3],
  [DAY.todayOpen + 0.02, 'pop', 0.26],
  [DAY.todayFocus, 'click', 0.33],
  [DAY.todayFocus + 0.03, 'note-mid', 0.22],
  [DAY.showDesk, 'click', 0.26],
  [DAY.showDesk + DBL, 'click', 0.26],
  [DAY.showDesk + DBL + 0.03, 'whoosh-down', 0.2],
  [DAY.examLaunch, 'click', 0.26],
  [DAY.examLaunch + DBL, 'click', 0.26],
  // 06 检验：新建题目集 → 拖入试卷 → 解析文档（逐页识别、逐题入库）→ 查看题目 → 第 7 题 → 选 A 提交 → 判错 → AI 解析
  [DAY.examOpen + 0.02, 'pop', 0.24],
  [DAY.examNew, 'click', 0.3],
  [DAY.examDrop, 'pop', 0.3],
  [DAY.examParse, 'click', 0.33],
  ...EXAM_PARSE_MARKS.pages.map((k): Cue => [parseT(k), 'tick', 0.12]),
  ...Array.from({ length: 6 }, (_, i): Cue => [parseT(EXAM_PARSE_MARKS.q0 + ((EXAM_PARSE_MARKS.q1 - EXAM_PARSE_MARKS.q0) * (i + 0.5)) / 6), 'tick', 0.09]),
  [DAY.examParsed, 'note-mid', 0.24],
  [DAY.examView, 'click', 0.3],
  [DAY.examQ7, 'click', 0.3],
  [DAY.examPick, 'click', 0.33],
  [DAY.examSubmit, 'click', 0.33],
  [DAY.examSubmit + 0.04, 'note-low', 0.26],
  [DAY.examSubmit + 0.07, 'pop', 0.16],
  [DAY.examAI, 'click', 0.3],
  // 07 写作与精读：双击「作文批改」→ 新建 → 粘贴 → 开始批改 → 批注逐条闭合 → 流完 → 分数卡 → 润色提升；
  // 双击「翻译」→ 新建 → 粘贴 → 翻译 → 逐段流出 → 保存
  [DAY.essayLaunch, 'click', 0.26],
  [DAY.essayLaunch + DBL, 'click', 0.26],
  [DAY.essayOpen + 0.02, 'pop', 0.24],
  [DAY.essayNew, 'click', 0.3],
  [DAY.essayPaste, 'click', 0.3],
  [DAY.essayPaste + 0.04, 'tick', 0.16],
  [DAY.essayGrade, 'click', 0.33],
  ...ESSAY_STREAM.marks.map((raw): Cue => [essayStreamT(raw), 'tick', 0.1]),
  [DAY.essayDone, 'note-mid', 0.22],
  [DAY.essayScoreUp + 0.2, 'note-high', 0.22],
  [DAY.essayPolish, 'click', 0.33],
  [DAY.essayPolish + 0.02, 'flip', 0.2],
  [DAY.translateLaunch, 'click', 0.26],
  [DAY.translateLaunch + DBL, 'click', 0.26],
  [DAY.translateOpen + 0.02, 'pop', 0.24],
  [DAY.translateNew, 'click', 0.3],
  [DAY.translatePaste, 'click', 0.3],
  [DAY.translatePaste + 0.04, 'tick', 0.16],
  [DAY.translateRun, 'click', 0.33],
  ...TRANS_PARAS.map((c): Cue => [transStreamT(c), 'tick', 0.12]),
  [DAY.translateDone + 0.02, 'note-mid', 0.2],
  [DAY.showDesk2, 'click', 0.26],
  [DAY.showDesk2 + DBL, 'click', 0.26],
  [DAY.showDesk2 + DBL + 0.03, 'whoosh-down', 0.2],
  // 08a 音视频：Dock「全部应用」→ 打「音视频」→ Enter 开窗 →「B 站链接」→ 粘贴 → 解析 → 导入 5 个分 P（逐 P 一声）→
  // 点 P4 → 播放 → 点字幕跳转 → 黄灯收进 Dock
  [DAY.mediaApps, 'click', 0.28],
  [DAY.mediaApps + 0.02, 'pop', 0.18],
  ...Array.from({ length: 3 }, (_, i): Cue => [DAY.mediaType + i * 0.06, 'tick', 0.12]),
  [DAY.mediaEnter, 'tick', 0.16],
  [DAY.mediaOpen + 0.02, 'pop', 0.24],
  [DAY.mediaBili, 'click', 0.3],
  [DAY.mediaBili + 0.03, 'pop', 0.2],
  [DAY.mediaPaste, 'click', 0.26],
  [DAY.mediaPaste + 0.04, 'tick', 0.16],
  [DAY.mediaParse, 'click', 0.3],
  [DAY.mediaProbe, 'note-mid', 0.22],
  [DAY.mediaImport, 'click', 0.33],
  ...Array.from({ length: 5 }, (_, i): Cue => [DAY.mediaImport + 0.02 + ((DAY.mediaImported - 0.06 - DAY.mediaImport) * (i + 1)) / 5, 'tick', 0.12]),
  [DAY.mediaImported + 0.02, 'note-high', 0.22],
  [DAY.mediaRow, 'click', 0.3],
  [DAY.mediaRow + 0.03, 'whoosh-up', 0.16],
  [DAY.mediaPlay, 'click', 0.3],
  [DAY.mediaSeek, 'click', 0.33],
  [DAY.mediaSeek + 0.02, 'flip', 0.2],
  [DAY.mediaMin, 'click', 0.28],
  [DAY.mediaMin + 0.03, 'whoosh-down', 0.18],
  // 08 调研：Dock 还原对话 → 点进输入框打 /res → 发出 → 选深度、提交 → 6 步逐条打勾 → 任务完成 → 收起面板 →
  // 让 AI 改笔记（笔记窗弹入 → 直改落地）→ 点回对话 → 追问 → 论文已保存 → Dock 打开资源库 → 知识库索引
  [DAY.researchOpen - 0.02, 'click', 0.3],
  [DAY.researchOpen + 0.02, 'whoosh-up', 0.2],
  [DAY.researchType - 0.06, 'click', 0.22],
  [DAY.researchSend, 'click', 0.26],
  [DAY.researchSend + 0.02, 'whoosh-up', 0.16],
  [DAY.researchAsk, 'pop', 0.18],
  [DAY.researchPick, 'click', 0.26],
  [DAY.researchSubmit, 'click', 0.26],
  ...STEPS.map((_, i): Cue => [researchStepDone(i), 'tick', 0.16]),
  [DAY.researchDone + 0.02, 'pop', 0.26],
  [DAY.researchCollapse, 'click', 0.26],
  [DAY.noteType - 0.04, 'click', 0.2],
  [DAY.noteSend, 'click', 0.26],
  [DAY.noteSend + 0.02, 'whoosh-up', 0.16],
  [DAY.noteOpen, 'whoosh-up', 0.22],
  [DAY.noteOpen + 0.02, 'pop', 0.26],
  [DAY.noteEdit, 'note-high', 0.24],
  [DAY.chatBack, 'click', 0.24],
  [DAY.paperSend, 'click', 0.26],
  [DAY.paperSend + 0.02, 'whoosh-up', 0.16],
  [DAY.paperSaved, 'note-mid', 0.22],
  [DAY.hubIndex - 0.02, 'click', 0.3],
  [DAY.hubIndex + 0.02, 'pop', 0.24],
  [DAY.hubKb, 'click', 0.26],
  [DAY.end - 0.32, 'note-high', 0.24],
  // 09 懂你：记忆逐条写入 → 技能 → MCP → 多模型（每次横移一声）
  ...Array.from({ length: 4 }, (_, i): Cue => [YOU.memory + 0.15 + i * 0.24, 'tick', 0.12]),
  [YOU.skills - 0.12, 'whoosh-up', 0.2],
  ...Array.from({ length: 6 }, (_, i): Cue => [YOU.skills + 0.1 + i * 0.1, 'tick', 0.08]),
  [YOU.mcp - 0.12, 'whoosh-up', 0.2],
  ...Array.from({ length: 4 }, (_, i): Cue => [YOU.mcp + 0.2 + i * 0.11, 'click', 0.18]),
  [YOU.mcp + 0.9, 'ping', 0.16],
  [YOU.models - 0.12, 'whoosh-up', 0.2],
  [YOU.out0 - 0.1, 'note-high', 0.2],
  // 收尾：纸面隆起，山顶每长过一根计曲线轻响一下 → 镜头抬起看见整片地形
  [FN.kb0 - 0.1, 'swell', 0.36],
  [GROW.t0 + 0.04, 'whoosh-up', 0.16],
  ...majorRingTimes().map((t, i): Cue => [t, 'ping', 0.15 - i * 0.025]),
  [FN.pull0 + 0.72, 'whoosh-up', 0.2],
  // 片尾：瞳点出现 → 飞入 Logo → 钟声 → 眨眼
  [FN.pupil0, 'tick', 0.16],
  [FN.pupilLand - 0.02, 'pop', 0.26],
  [FN.reveal0, 'chime', 0.55],
  [FN.blink, 'tick', 0.1],
];

const frameOf = (t: number) => Math.max(0, Math.round(t * PACE * FPS));

/** 整体响度目标约 −17 LUFS（网页视频常用），峰值留 ~2dB 余量。 */
const SCORE_GAIN = 0.75;
const SFX_GAIN = 1.3;

export const Soundtrack = () => (
  <>
    <Audio src={staticFile('audio/score.wav')} volume={SCORE_GAIN} />
    {CUES.map(([t, name, v], i) => (
      <Sequence key={i} from={frameOf(t)} layout="none">
        <Audio src={staticFile(`audio/${name}.wav`)} volume={Math.min(1, v * SFX_GAIN)} />
      </Sequence>
    ))}
  </>
);

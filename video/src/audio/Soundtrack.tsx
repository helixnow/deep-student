import { Audio, Sequence, staticFile } from 'remotion';
import { FPS, PACE, rand } from '../lib/time';
import { DAY, DBL, researchStepDone } from '../scenes/day/beats';
import { INSERT_WINDOWS, shiftMainTime } from '../timeline/schedule';
import { FN } from '../scenes/finale/beats';
import { MCP_AT, YOU } from '../scenes/you/SceneYou';
import { ESSAY_STREAM } from '../ui/essay';
import { EXAM_PARSE_MARKS } from '../ui/exam';
import { TRANS_LEN, TRANS_PARAS } from '../ui/translate';
import { STEPS } from '../ui/research';
import { mcpTL, memoryTL } from '../ui/you';
import { majorRingTimes } from '../scenes/finale/terrain';
import { MM } from '../scenes/organize/MindmapView';
import { PR } from '../scenes/practice/beats';
import { POST, RV } from '../scenes/retrieval/beats';
import { REVIEW_MEMORY, REVIEW_MEMORY_FRESH, WK } from '../scenes/review/SceneReview';
import { memoryDuePasses } from '../ui/flashcards';

/**
 * 配乐 + 音效。音效由 scripts/sfx-v2.mjs 用开源素材（Kenney / VCSL / Freesound，CC0）加工到 public/audio/，
 * 只引用带编号的文件（<族>-<编号>.wav）；音效时刻全部引用各段节拍常量，改节拍时声音跟着走。
 *
 * 层级（目标事件响度见 TIER_LUFS）：
 *   hero  剪辑与英雄时刻：匹配剪辑、两次过场光波、片尾钟声
 *   cue   音高提示（D 大调五声）：判定、揭示序列、重要任务完成
 *   ui    确认性操作：点击、窗口进出 Dock、大的镜头运动
 *   tex   纹理：打字、逐张 / 逐页 / 逐步、窗口弹出
 * 删减规则：发送不再叠 whoosh；点击后 0.05 脚本秒内的 pop 只在开窗时保留；同一串纹理 ≤ 4 声、间隔 ≥ 0.1 脚本秒；
 * 一批卡片用一声卡片扇；音高提示本身就是按键反馈（评分、全部揭示）时不再叠点击。
 */
const VARIANTS = {
  click: 3,
  key: 4,
  tick: 3,
  pop: 3,
  flip: 3,
  'whoosh-up': 2,
  'whoosh-down': 2,
  boom: 1,
  swell: 1,
  chime: 1,
  ping: 1,
  'note-low': 1,
  'note-mid': 1,
  'note-high': 1,
  'note-top': 1,
} as const;
type Family = keyof typeof VARIANTS;
/** 不轮换、直接按名字引用的文件：两种卡片扇、钟琴五声音阶。 */
type Fixed = 'cards-1' | 'cards-2' | 'bell-d6' | 'bell-e6' | 'bell-fs6' | 'bell-a6' | 'bell-b6' | 'bell-d7';
type Sfx = Family | Fixed;
type Tier = 'hero' | 'cue' | 'ui' | 'tex';
/** [脚本秒, 音效, 层级, 相对层级的增减 dB] */
type Cue = [time: number, sfx: Sfx, tier: Tier, accent?: number];

/** 各层在成片里的目标事件响度（100 ms 窗最大 K 加权响度，LUFS）。 */
const TIER_LUFS: Record<Tier, number> = { hero: -17, cue: -22, ui: -25, tex: -30 };
/** 各层的确定性音量起伏（± dB）。 */
const TIER_JITTER: Record<Tier, number> = { hero: 0, cue: 0.75, ui: 1.5, tex: 2 };
/** scripts/sfx-v2.mjs 的文件响度约定：boom / swell / chime 为 −16 LUFS，其余 −22 LUFS。 */
const fileLufs = (s: Sfx) => (s === 'boom' || s === 'swell' || s === 'chime' ? -16 : -22);
/** swell-1.wav 最强点在文件第 1.2 秒（成片秒）。 */
const SWELL_PEAK = 1.2;

const PROMPT_LEN = [...'讲透这一节：画导图、出卡片'].length;
/** 01 打字：13 个字只落 4 下键声（不等距，像真人打字）。 */
const PROMPT_KEYS = [0, 3, 7, 10];
/** 06 解析进度（0–1）→ 脚本秒，与 SceneDay 的 examState.parse 同一区间。 */
const parseT = (k: number) => DAY.examParse + 0.03 + (DAY.examParsed - 0.02 - DAY.examParse - 0.03) * k;
/** 07 流式位置 → 脚本秒，与 SceneDay 的 essayState.stream / transState.run 同一区间。 */
const essayStreamT = (raw: number) => DAY.essayStream + ((DAY.essayDone - 0.03 - DAY.essayStream) * raw) / ESSAY_STREAM.total;
const transStreamT = (c: number) => DAY.translateStream + ((DAY.translateDone - 0.02 - DAY.translateStream) * c) / TRANS_LEN;
/** 一串里每隔一个取一个，最多 max 个。 */
const thin = <T,>(xs: readonly T[], max = 4) => xs.filter((_, i) => i % 2 === 0).slice(0, max);

const RATING_NOTE: Record<number, Sfx> = { 1: 'note-low', 2: 'note-mid', 3: 'note-mid', 4: 'note-high' };
const REVEAL_NOTES: Sfx[] = ['note-low', 'note-mid', 'note-high'];
const CURVE_NOTES: Sfx[] = ['note-low', 'note-mid', 'note-high'];
const RING_BELLS: Sfx[] = ['bell-d6', 'bell-fs6', 'bell-a6', 'bell-b6', 'bell-d7'];
const MEM = memoryTL(YOU.memory);
const MCP = mcpTL(MCP_AT);

const CUES: Cue[] = [
  // 01 读懂：「添加到对话」→ 引用芯片落进输入框 → 打字 → 发送
  [3.0, 'click', 'ui'],
  [3.5, 'pop', 'tex'],
  ...PROMPT_KEYS.map((i): Cue => [3.98 + (i * 0.46) / PROMPT_LEN, 'key', 'tex']),
  [4.5, 'click', 'ui'],
  // 02 看清：匹配剪辑进 3D → 扫描（声呐回声逐次变弱）→ 命中 → 抽离 → 回到界面 → 教材页落进面板 → 点引用 → 导图卡 → 打开
  [RV.cut, 'boom', 'hero'],
  ...thin(Array.from({ length: 8 }, (_, k) => RV.scan + k * 0.085)).map((s, k): Cue => [s, 'ping', 'tex', 2 - k * 3]),
  [RV.select, 'note-high', 'cue'],
  [RV.extract, 'whoosh-up', 'ui'],
  [RV.reveal, 'whoosh-down', 'ui', -3],
  [RV.land1, 'pop', 'ui'],
  [9.1 + POST, 'click', 'ui'],
  [9.5 + POST, 'pop', 'tex'],
  [10.5 + POST, 'click', 'ui'],
  // 03 整理：右侧面板打开导图 → 两次切结构（点选 + 版式翻动）→ 背诵：遮住 → 逐个揭示（上行琶音）→ 全部揭示 → 回到对话
  [MM.open, 'whoosh-up', 'tex'],
  ...MM.structClicks.map((s): Cue => [s, 'click', 'ui']),
  ...MM.picks.flatMap((s): Cue[] => [
    [s, 'click', 'ui'],
    [s + 0.02, 'flip', 'tex'],
  ]),
  [MM.reciteClick, 'click', 'ui'],
  [MM.maskClick, 'click', 'ui'],
  ...MM.reveals.map((r, i): Cue => [r, REVEAL_NOTES[i], 'cue']),
  [MM.revealAll + 0.02, 'note-top', 'cue'],
  [MM.close0, 'whoosh-down', 'tex'],
  // 04 练习：12 张卡一声卡片扇 → 生成完成 → 点「复习这批」→ 缩进 Dock → 闪卡窗口弹开 → 显示答案（翻面）/ 评分（音高即反馈）
  [PR.cards0, 'cards-1', 'ui'],
  [PR.done, 'note-mid', 'cue'],
  [PR.reviewClick, 'click', 'ui'],
  [PR.reviewClick + 0.04, 'whoosh-down', 'ui'],
  [WK.open0, 'whoosh-up', 'ui'],
  ...WK.cards.flatMap((c): Cue[] => [
    [c.show, 'click', 'ui', -3],
    [c.show + 0.02, 'flip', 'ui'],
    [c.rate + 0.02, RATING_NOTE[c.rating], 'cue'],
  ]),
  // 05 记住：退出 → 统计；记忆曲线扫过本次三张卡的下次复习点（重来 1 分钟 → 良好 10 分钟 → 简单 15 天）
  [WK.exit, 'click', 'ui'],
  [WK.stats, 'click', 'ui'],
  ...memoryDuePasses(REVIEW_MEMORY, WK.stats + 0.03, REVIEW_MEMORY_FRESH).map((s, i): Cue => [s, CURVE_NOTES[i], 'cue', i < 2 ? -2 : 0]),
  // 夜里收场（点黄灯，闪卡窗口 genie 进 Dock）→ 清晨：光波在亮色主题翻转时最强
  [WK.minimize, 'click', 'ui'],
  [WK.out0 + 0.02, 'whoosh-down', 'ui'],
  [DAY.theme0 - SWELL_PEAK / PACE, 'swell', 'hero'],
  [DAY.clock, 'tick', 'tex'],
  // 今日：日程小组件「待办 →」→ 开始专注 → 显示桌面 → 双击「题目集」
  [DAY.todayOpen - 0.02, 'click', 'ui'],
  [DAY.todayOpen + 0.02, 'pop', 'tex'],
  [DAY.todayFocus, 'click', 'ui'],
  [DAY.showDesk, 'click', 'ui'],
  [DAY.showDesk + DBL, 'click', 'ui', -3],
  [DAY.showDesk + DBL + 0.03, 'whoosh-down', 'ui'],
  [DAY.examLaunch, 'click', 'ui'],
  [DAY.examLaunch + DBL, 'click', 'ui', -3],
  [DAY.examOpen + 0.02, 'pop', 'tex'],
  // 06 检验：新建 → 拖入试卷（纸落下）→ 解析（逐页翻过、逐题入库）→ 查看题目 → 第 7 题 → 选 A 提交 → 判错 → AI 解析
  [DAY.examNew, 'click', 'ui'],
  [DAY.examDrop, 'pop', 'ui'],
  [DAY.examParse, 'click', 'ui'],
  ...EXAM_PARSE_MARKS.pages.map((k): Cue => [parseT(k), 'flip', 'tex', -3]),
  ...thin(Array.from({ length: 6 }, (_, i) => parseT(EXAM_PARSE_MARKS.q0 + ((EXAM_PARSE_MARKS.q1 - EXAM_PARSE_MARKS.q0) * (i + 0.5)) / 6)), 3).map((s): Cue => [s, 'tick', 'tex']),
  [DAY.examParsed, 'note-mid', 'cue'],
  [DAY.examView, 'click', 'ui'],
  [DAY.examQ7, 'click', 'ui'],
  [DAY.examPick, 'click', 'ui'],
  [DAY.examSubmit, 'click', 'ui'],
  [DAY.examSubmit + 0.04, 'note-low', 'cue'],
  [DAY.examAI, 'click', 'ui'],
  // 07 写作与精读：双击「作文批改」→ 新建 → 粘贴（⌘V）→ 开始批改 → 批注逐条闭合 → 分数卡 → 润色提升；
  // 双击「翻译」→ 新建 → 粘贴 → 翻译 → 逐段流出 → 保存 → 显示桌面
  [DAY.essayLaunch, 'click', 'ui'],
  [DAY.essayLaunch + DBL, 'click', 'ui', -3],
  [DAY.essayOpen + 0.02, 'pop', 'tex'],
  [DAY.essayNew, 'click', 'ui'],
  [DAY.essayPaste, 'click', 'ui'],
  [DAY.essayPaste + 0.04, 'key', 'tex'],
  [DAY.essayGrade, 'click', 'ui'],
  ...thin(ESSAY_STREAM.marks).map((raw): Cue => [essayStreamT(raw), 'tick', 'tex']),
  [DAY.essayScoreUp + 0.2, 'note-high', 'cue'],
  [DAY.essayPolish, 'click', 'ui'],
  [DAY.essayPolish + 0.02, 'flip', 'tex'],
  [DAY.translateLaunch, 'click', 'ui'],
  [DAY.translateLaunch + DBL, 'click', 'ui', -3],
  [DAY.translateOpen + 0.02, 'pop', 'tex'],
  [DAY.translateNew, 'click', 'ui'],
  [DAY.translatePaste, 'click', 'ui'],
  [DAY.translatePaste + 0.04, 'key', 'tex'],
  [DAY.translateRun, 'click', 'ui'],
  ...TRANS_PARAS.map((c): Cue => [transStreamT(c), 'tick', 'tex']),
  [DAY.translateDone + 0.02, 'note-mid', 'cue'],
  [DAY.showDesk2, 'click', 'ui'],
  [DAY.showDesk2 + DBL, 'click', 'ui', -3],
  [DAY.showDesk2 + DBL + 0.03, 'whoosh-down', 'ui'],
  // 08a 音视频：Dock「全部应用」→ 打「音视频」→ Enter 开窗 →「B 站链接」→ 粘贴 → 解析 → 结果出现 → 导入 5 个分 P → 完成 →
  // 点 P4 → 播放
  [DAY.mediaApps, 'click', 'ui'],
  [DAY.mediaType, 'key', 'tex'],
  [DAY.mediaType + 0.12, 'key', 'tex'],
  [DAY.mediaEnter, 'key', 'tex', 2],
  [DAY.mediaBili, 'click', 'ui'],
  [DAY.mediaPaste, 'click', 'ui'],
  [DAY.mediaPaste + 0.04, 'key', 'tex'],
  [DAY.mediaParse, 'click', 'ui'],
  [DAY.mediaProbe, 'pop', 'tex'],
  [DAY.mediaImport, 'click', 'ui'],
  ...thin(Array.from({ length: 5 }, (_, i) => DAY.mediaImport + 0.02 + ((DAY.mediaImported - 0.06 - DAY.mediaImport) * (i + 1)) / 5), 3).map((s): Cue => [s, 'tick', 'tex']),
  [DAY.mediaImported + 0.02, 'note-high', 'cue'],
  [DAY.mediaRow, 'click', 'ui'],
  [DAY.mediaPlay, 'click', 'ui'],
  // 问答：分区 → 就这门课提问 → 打字 → 发送 → 点时间引用跳转
  [DAY.askTab, 'click', 'ui'],
  [DAY.askStart, 'click', 'ui'],
  ...[0, 2, 4].map((i): Cue => [DAY.askType + 0.02 + i * 0.05, 'key', 'tex']),
  [DAY.askSend, 'click', 'ui'],
  [DAY.askSeek, 'click', 'ui'],
  // 讲义：分区 → 生成讲义（阶段推进）→ 完成 → 打开笔记（开窗）→ 红灯关窗
  [DAY.handoutTab, 'click', 'ui'],
  [DAY.handoutGen, 'click', 'ui'],
  ...[0.3, 0.56, 0.8].map((k): Cue => [DAY.handoutGen + 0.01 + (DAY.handoutDone - DAY.handoutGen - 0.01) * k, 'tick', 'tex']),
  [DAY.handoutDone, 'note-mid', 'cue'],
  [DAY.handoutOpen, 'click', 'ui'],
  [DAY.handoutOpen + 0.03, 'pop', 'tex'],
  [DAY.handoutClose, 'click', 'ui'],
  // 练习：分区 → 制作闪卡（4 张卡一声小卡片扇）→ 黄灯收进 Dock
  [DAY.practiceTab, 'click', 'ui'],
  [DAY.practiceCards, 'click', 'ui'],
  [DAY.practiceCards + 0.06, 'cards-2', 'tex', 2],
  [DAY.mediaMin, 'click', 'ui'],
  [DAY.mediaMin + 0.03, 'whoosh-down', 'ui'],
  // 08 调研：Dock 还原对话 → 点进输入框打 /res、Tab 补全 → 发出 → 选深度、提交 → 6 步逐条打勾 → 任务完成 → 收起面板 →
  // 让 AI 改笔记（笔记窗弹入 → 直改落地）→ 点回对话 → 追问 → 论文已保存 → Dock 打开资源库 → 知识库索引 → 第二幕收束
  [DAY.researchOpen - 0.02, 'click', 'ui'],
  [DAY.researchOpen + 0.02, 'whoosh-up', 'ui', -3],
  [DAY.researchType - 0.06, 'click', 'ui', -3],
  [DAY.researchTab, 'key', 'tex'],
  [DAY.researchSend, 'click', 'ui'],
  [DAY.researchAsk, 'pop', 'tex'],
  [DAY.researchPick, 'click', 'ui'],
  [DAY.researchSubmit, 'click', 'ui'],
  ...STEPS.map((_, i): Cue => [researchStepDone(i), 'tick', 'tex']),
  [DAY.researchDone + 0.02, 'note-mid', 'cue'],
  [DAY.researchCollapse, 'click', 'ui'],
  [DAY.noteType - 0.04, 'click', 'ui', -3],
  [DAY.noteSend, 'click', 'ui'],
  [DAY.noteOpen, 'whoosh-up', 'ui', -3],
  [DAY.noteEdit, 'note-high', 'cue'],
  [DAY.chatBack, 'click', 'ui'],
  [DAY.paperSend, 'click', 'ui'],
  [DAY.paperSaved, 'note-mid', 'cue'],
  [DAY.hubIndex - 0.02, 'click', 'ui'],
  [DAY.hubIndex + 0.02, 'pop', 'tex'],
  [DAY.hubKb, 'click', 'ui'],
  [DAY.end - 0.32, 'note-top', 'cue'],
  // 09 懂你：记忆检索（工具开始 / 完成）→ 横移到技能 → MCP（工具开始 / 完成 / 找到）→ 多模型
  [MEM.tool, 'tick', 'tex'],
  [MEM.toolDone, 'tick', 'tex'],
  [YOU.skills - 0.12, 'whoosh-up', 'ui', -3],
  ...[0, 2, 4].map((i): Cue => [YOU.skills + 0.1 + i * 0.1, 'tick', 'tex']),
  [YOU.mcp - 0.12, 'whoosh-up', 'ui', -3],
  [MCP.tool, 'tick', 'tex'],
  [MCP.toolDone, 'tick', 'tex'],
  [MCP.done, 'bell-e6', 'tex', 2],
  [YOU.models - 0.12, 'whoosh-up', 'ui', -3],
  [YOU.out0 - 0.1, 'note-high', 'cue'],
  // 收尾：光波在那一页完全浮现时最强 → 山顶每长过一根计曲线一声钟琴（五声音阶上行）→ 镜头抬起看见整片地形
  [FN.veil1 - SWELL_PEAK / PACE, 'swell', 'hero'],
  ...majorRingTimes().map((t, i): Cue => [t, RING_BELLS[i % RING_BELLS.length], 'cue', -4]),
  [FN.pull0 + 0.72, 'whoosh-up', 'ui', -3],
  // 片尾：瞳点出现 → 飞入 Logo、钟声 → 眨眼
  [FN.pupil0, 'tick', 'tex'],
  [FN.reveal0, 'chime', 'hero'],
  [FN.blink, 'tick', 'tex', -3],
];

const frameOf = (t: number) => Math.max(0, Math.round(t * PACE * FPS));
const seedOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7);

/** 按时间排序后逐条定文件与音量：同族变体按确定性伪随机轮换（不与上一次相同），音量按层级目标 + 起伏。 */
const resolve = (cues: Cue[], gain: number) => {
  const count: Partial<Record<Sfx, number>> = {};
  const last: Partial<Record<Sfx, number>> = {};
  return [...cues]
    .sort((a, b) => a[0] - b[0])
    .map(([t, sfx, tier, accent = 0], i) => {
      const n: number = sfx in VARIANTS ? VARIANTS[sfx as Family] : 0;
      let file: string = sfx;
      if (n > 0) {
        const k = (count[sfx] = (count[sfx] ?? 0) + 1);
        let v = Math.floor(rand(k * 7.31 + seedOf(sfx)) * n);
        if (n > 1 && v === last[sfx]) v = (v + 1) % n;
        last[sfx] = v;
        file = `${sfx}-${v + 1}`;
      }
      const jitter = (rand(i * 3.7 + 11) * 2 - 1) * TIER_JITTER[tier];
      const volume = Math.min(1, 10 ** ((TIER_LUFS[tier] + accent + jitter - fileLufs(sfx)) / 20) * gain);
      return { t, frame: frameOf(t), file, tier, volume };
    });
};

/** score.wav 已在 scripts/score-v2.mjs 里做成 −17 LUFS / −1.5 dBTP 母带（网页视频常用），这里不再衰减。 */
export const SCORE_GAIN = 1;
/** 音效总推子（按层级算出的音量再乘它，上限 1）。 */
export const SFX_GAIN = 1;
/** 原片音效按插入段顺延，再合并各插入段自带的 cues（新增插入段后需同步更新配乐脚本延长 score.wav）。 */
const ALL_CUES: Cue[] = [
  ...CUES.map(([t, sfx, tier, accent]): Cue => [shiftMainTime(t), sfx, tier, accent]),
  ...INSERT_WINDOWS.flatMap((w) =>
    (w.insert.cues ?? []).map(([localT, sfx, tier, accent]): Cue => [w.start + localT, sfx as Sfx, tier, accent]),
  ),
];
export const SFX_CUES = resolve(ALL_CUES, SFX_GAIN);

export const Soundtrack = () => (
  <>
    <Audio src={staticFile('audio/score.wav')} volume={SCORE_GAIN} />
    {SFX_CUES.map(({ frame, file, volume }, i) => (
      <Sequence key={i} from={frame} layout="none" name={file}>
        <Audio src={staticFile(`audio/${file}.wav`)} volume={volume} />
      </Sequence>
    ))}
  </>
);

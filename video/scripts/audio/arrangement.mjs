/**
 * DeepStudent 宣传片配乐 v2 · 编曲（全部时间为成片秒）。
 *
 * 只描述「弹什么、何时弹、多响」：音符由下面的模式 / 动机 / 声部进行生成，渲染与混音在 mix.mjs。
 * 关键画面时刻直接解析 src/ 里的节拍常量（RV / PR / WK / MM / DAY / YOU / FN / SUPERS），
 * 改节拍后重渲即可跟上；解析失败时退回文件末尾的镜像值并在 BEAT_SOURCES 里标出。
 *
 * 曲式（成片秒）
 *   0–46     第一幕：开场动机（两张标题卡一问一答）→ 读懂（钢琴三音循环，D 持续低音）→ 看清（13.75 3D 匹配剪辑，低音沉到 G1）
 *            → 引用 → 整理（22 轻鼓 + 马林巴）→ 练习 → 32.75 入夜（只剩弦乐，B 小调 / 放慢）
 *   46–52    过场：清晨，D 利底亚，无脉冲；48 第二幕标题处动机放宽一倍
 *   52–124   第二幕：今日（A–D 双音八分脉冲）→ 检验（十六分拨弦 + 干鼓，68.5 判错处停拍）→ 写作与精读（收）
 *            → 音视频（92 起，半拍底鼓 + 八分低音）→ 调研（鼓回来，114.25 任务完成重音，vi–♭VII 上扬）
 *   124–140.2 第三幕：124 抽空静止，125.2 标题处动机起句，127.24 全编制，速度 148 BPM（全片最快）
 *   140.2–156.46 收尾：登顶，D 持续低音，钟琴微光，动机前三音悬而不决
 *   156.46–166 片尾：Logo 展开前一拍静止，动机以最简形态（独奏 + 低音 D）随 Logo 各层落下
 *
 * 速度图：0–124 为 120 BPM；124–140.2 为 40 拍（148.15 BPM），让 125.2 / 127.24 / 132.1 / 136.96 / 140.2 都落在拍点；
 * 140.2 起回到 120 BPM，Logo 展开 156.46 恰好落在八分音符网格上（156.45）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');
const PACE = 2;
export const DURATION = 166;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;
const F = (script) => r3(script * PACE);
const hashStr = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
export const mulberry = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── 1. 节拍常量 ─────────────────────────────────────────────

/** 跳过字符串与注释，截出从 start（指向 `{`）开始的完整对象字面量。 */
const sliceObject = (code, start) => {
  let depth = 0;
  let str = null;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (str) {
      if (c === '\\') i++;
      else if (c === str) str = null;
      continue;
    }
    if (c === '/' && n === '/') {
      const e = code.indexOf('\n', i);
      i = e < 0 ? code.length : e;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = code.indexOf('*/', i + 2);
      i = e < 0 ? code.length : e + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') str = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return null;
};

const stripComments = (code) => {
  let out = '';
  let str = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (str) {
      out += c;
      if (c === '\\') out += code[++i] ?? '';
      else if (c === str) str = null;
      continue;
    }
    if (c === '/' && n === '/') {
      const e = code.indexOf('\n', i);
      i = e < 0 ? code.length : e - 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = code.indexOf('*/', i + 2);
      i = e < 0 ? code.length : e + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') str = c;
    out += c;
  }
  return out;
};

export const BEAT_SOURCES = {};

const readConst = (rel, name) => {
  try {
    const code = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const m = code.match(new RegExp(`export const ${name}\\s*=\\s*\\{`));
    if (!m) throw new Error(`没找到 export const ${name}`);
    const body = sliceObject(code, m.index + m[0].length - 1);
    const clean = stripComments(body).replace(/\s+as\s+(const|[A-Z]\w*)\b/g, '');
    const value = Function(`"use strict";return (${clean});`)();
    BEAT_SOURCES[name] = `src/${rel.replaceAll('\\', '/')}`;
    return { ...MIRROR[name], ...value };
  } catch (e) {
    BEAT_SOURCES[name] = `镜像值（${e.message}）`;
    return MIRROR[name];
  }
};

const readSupers = () => {
  try {
    const code = fs.readFileSync(path.join(SRC, 'overlays', 'Supers.tsx'), 'utf8');
    const out = {};
    for (const m of code.matchAll(/\{\s*s:\s*([\d.]+),\s*e:\s*([\d.]+),\s*text:\s*'([^']*)'/g)) out[m[3]] = +m[1];
    if (!Object.keys(out).length) throw new Error('SUPERS 为空');
    BEAT_SOURCES.SUPERS = 'src/overlays/Supers.tsx';
    return out;
  } catch (e) {
    BEAT_SOURCES.SUPERS = `镜像值（${e.message}）`;
    return MIRROR.SUPERS;
  }
};

const readHandoff = () => {
  try {
    const code = fs.readFileSync(path.join(SRC, 'scenes', 'review', 'handoff.ts'), 'utf8');
    const min1 = +code.match(/export const MIN1\s*=\s*([\d.]+)/)[1];
    const off = +code.match(/export const MIN0\s*=\s*PR\.reviewClick\s*\+\s*([\d.]+)/)[1];
    BEAT_SOURCES.handoff = 'src/scenes/review/handoff.ts';
    return { min1, off };
  } catch (e) {
    BEAT_SOURCES.handoff = `镜像值（${e.message}）`;
    return { min1: MIRROR.MIN1, off: MIRROR.MIN0 - MIRROR.PR.reviewClick };
  }
};

/** 镜像值：解析失败时的兜底（2026-11 的节拍表）。 */
const MIRROR = {
  RV: { cut: 6.9, scan: 7.12, select: 7.78, extract: 7.92, reveal: 8.42, land1: 8.74 },
  PR: { cards0: 15.5, done: 16.0, reviewClick: 16.34 },
  WK: { night0: 16.36, open0: 16.7, stats: 19.92, minimize: 22.5, out1: 23.0 },
  MM: { open: 11.56, reveals: [14.3, 14.44, 14.58], revealAll: 14.76, close0: 14.96 },
  DAY: {
    dawn0: 23.05, todayOpen: 26.0, examOpen: 30.0, examSubmit: 34.28, examAI: 34.98, essayLaunch: 37.86,
    translateLaunch: 42.71, showDesk2: 45.45, mediaApps: 46.0, mediaMin: 53.56, researchOpen: 54.0,
    researchDone: 57.12, noteEdit: 58.4, paperSaved: 60.54, end: 62.0,
  },
  YOU: { in0: 63.7, memory: 63.85, answer: 64.9, skills: 66.1, mcp: 67.35, models: 68.5, out0: 69.45 },
  FN: {
    kb0: 69.6, veil1: 70.3, pull0: 70.1, pull1: 75.4, fade0: 77.5, pupil0: 77.55, reveal0: 78.23, reveal1: 78.78,
    eye0: 78.53, word0: 78.85, tag0: 79.45, blink: 80.7,
  },
  MIN0: 16.38,
  MIN1: 16.62,
  SUPERS: {
    '学习本身，\\n已经够难了。': 0.15, '其余的事，\\n交给它。': 1.33, '选中原文，直接问它。': 2.8, '今天的安排，它已经列好。': 24.0,
    '调研，它自主完成。': 54.4, '它越来越懂你。': 62.6, '从一页纸，|到一整座知识库。': 70.35,
  },
};

const RV = readConst('scenes/retrieval/beats.ts', 'RV');
const PR = readConst('scenes/practice/beats.ts', 'PR');
const DAY = readConst('scenes/day/beats.ts', 'DAY');
const FN = readConst('scenes/finale/beats.ts', 'FN');
const WK = readConst('scenes/review/SceneReview.tsx', 'WK');
const YOU = readConst('scenes/you/SceneYou.tsx', 'YOU');
const MM = readConst('scenes/organize/MindmapView.tsx', 'MM');
const SUP = readSupers();
const HANDOFF = readHandoff();
const superAt = (prefix) => {
  const k = Object.keys(SUP).find((x) => x.startsWith(prefix));
  if (k === undefined) throw new Error(`SUPERS 里没有「${prefix}…」`);
  return SUP[k];
};

// ── 2. 速度图 ───────────────────────────────────────────────

const ACT3 = F(DAY.end); // 124
const FINALE = F(FN.pull0); // 140.2
const SEGMENTS = [
  { t0: 0, t1: ACT3, bpm: 120 },
  { t0: ACT3, t1: FINALE, bpm: (40 * 60) / (FINALE - ACT3) },
  { t0: FINALE, t1: Infinity, bpm: 120 },
];
{
  let b = 0;
  for (const s of SEGMENTS) {
    s.spb = 60 / s.bpm;
    s.b0 = b;
    s.beats = Number.isFinite(s.t1) ? Math.round((s.t1 - s.t0) / s.spb) : Infinity;
    b += s.beats;
  }
}
const segAtTime = (t) => SEGMENTS.find((s) => t < s.t1) ?? SEGMENTS[SEGMENTS.length - 1];
const segAtBeat = (b) => SEGMENTS.find((s) => b < s.b0 + s.beats) ?? SEGMENTS[SEGMENTS.length - 1];

export const TEMPO = {
  bpm: 120,
  segments: SEGMENTS.map(({ t0, t1, bpm, b0 }) => ({ t0, t1: Number.isFinite(t1) ? t1 : DURATION, bpm: r3(bpm), beat0: b0 })),
  beatAt: (t) => {
    const s = segAtTime(t);
    return s.b0 + (t - s.t0) / s.spb;
  },
  timeAt: (b) => {
    const s = segAtBeat(b);
    return s.t0 + (b - s.b0) * s.spb;
  },
  spbAt: (t) => segAtTime(t).spb,
  /** 量化到网格：div=2 为八分、4 为十六分。 */
  q: (t, div = 2) => r4(TEMPO.timeAt(Math.round(TEMPO.beatAt(t) * div) / div)),
  /** 绝对小节号（4/4）+ 拍 → 成片秒。 */
  bar: (n, beat = 0) => TEMPO.timeAt(n * 4 + beat),
};
const tb = (beat) => r4(TEMPO.timeAt(beat));
const bar = (n, beat = 0) => r4(TEMPO.bar(n, beat));

// ── 3. 声画同步点 ───────────────────────────────────────────

const HIT_DEFS = [
  ['title1', '开场标题卡 1「学习本身，已经够难了。」', 'SUPERS[0].s', superAt('学习本身'), '动机前半句：F♯–A–E 悬在 E 上（不解决）'],
  ['title2', '开场标题卡 2「其余的事，交给它。」', 'SUPERS[1].s', superAt('其余的事'), '动机落到 D + 低音 D 进入，Dmaj9 弦乐铺底'],
  ['ask', '「选中原文，直接问它。」', 'SUPERS[2].s', superAt('选中原文'), '无（留给划选 / 打字音效）'],
  ['rvCut', '3D 匹配剪辑', 'RV.cut', RV.cut, '钢琴脉冲在前一个八分音符停下，和弦提前一个八分换到 Gmaj9(♯11)，低音等 boom 过后（14.25）沉到 G1'],
  ['rvReveal', '3D 退场、回到界面', 'RV.reveal', RV.reveal, '钢琴脉冲在下一拍（17.0）回来'],
  ['mmOpen', '导图面板打开', 'MM.open', MM.open, '22.0 起轻鼓 + 马林巴已在小节线上进入（提前 1 小节铺好）'],
  ['mmRevealAll', '背诵全部揭示', 'MM.revealAll', MM.revealAll, '马林巴 / 木块在 28.5 退出，把逐个揭示的音高提示音让出来'],
  ['prDone', '卡片生成完成', 'PR.done', PR.done, 'Asus4 → A(add9) 解决'],
  ['night', '入夜：「复习这批」后窗口缩进 Dock', 'PR.reviewClick → MIN0', PR.reviewClick + HANDOFF.off, '全体打击 / 脉冲切断，只剩弦乐与低音 B1；钢琴低八度 B；垫音低通从 5k 关到 1.1k'],
  ['nightDock', '窗口完全收进 Dock', 'MIN1', HANDOFF.min1, '（同上，夜色收拢完成）'],
  ['wkMinimize', '夜里收场：闪卡窗口进 Dock', 'WK.minimize', WK.minimize, '弦乐在 45.4 前放掉，45.5–46.0 近乎静止'],
  ['dawn', '清晨（夜 → 晨）', 'DAY.dawn0', DAY.dawn0, 'E/D（D 利底亚）弦乐 + 手摇钟三点微光，无脉冲'],
  ['act2Title', '第二幕标题「今天的安排，它已经列好。」', 'SUPERS[今天的安排].s', superAt('今天的安排'), '主动机放宽一倍（四分–四分–二分–全音符），钢琴高音区 + 手摇钟'],
  ['today', '今日：待办打开', 'DAY.todayOpen', DAY.todayOpen, 'A–D 双音八分脉冲开始（半拍脉冲）'],
  ['exam', '检验：题目集窗口', 'DAY.examOpen', DAY.examOpen, '十六分拨弦 + 干鼓进入，Gmaj9 低音 G1'],
  ['examSubmit', '提交 → 判错', 'DAY.examSubmit', DAY.examSubmit, '68.5 停拍（只留弦乐），70.0 随 AI 解析恢复'],
  ['examAI', 'AI 解析', 'DAY.examAI', DAY.examAI, '律动恢复'],
  ['essay', '写作与精读开始', 'DAY.essayLaunch', DAY.essayLaunch, '76.0 换和弦，鼓收成每小节一下'],
  ['media', '音视频段起点（Dock「全部应用」）', 'DAY.mediaApps', DAY.mediaApps, 'Bm11 + 半拍底鼓 + 八分低音同时进入'],
  ['research', '调研：对话窗口还原', 'DAY.researchOpen', DAY.researchOpen, 'Dmaj9，鼓回来'],
  ['researchDone', '调研完成（6/6）', 'DAY.researchDone', DAY.researchDone, '弦乐短促和弦 + 金属轻击 + 底鼓重音（114.25）'],
  ['act2End', '第二幕结束', 'DAY.end', DAY.end, 'vi–♭VII 上扬在此一刀切断：全片最大的抽空'],
  ['act3Title', '第三幕标题「它越来越懂你。」', 'SUPERS[它越来越懂你].s', superAt('它越来越懂你'), '动机起句（钢琴八度 + 弦乐齐奏），无伴奏'],
  ['youIn', '第一块面板浮现', 'YOU.in0', YOU.in0, '127.24 全编制落拍（impact + 底鼓 + Dmaj9）'],
  ['youSkills', '技能面板', 'YOU.skills', YOU.skills, '132.10 换 Em9，动机钩子落在 D'],
  ['youMcp', 'MCP 面板', 'YOU.mcp', YOU.mcp, '134.73 换 Gmaj9(♯11)（切分提前）'],
  ['youModels', '多模型面板', 'YOU.models', YOU.models, '136.96 换 Asus4，动机钩子再落一次'],
  ['kb0', '知识地形开始', 'FN.kb0', FN.kb0, '139.80 鼓与脉冲停一拍，留给 swell 音效'],
  ['pull0', '镜头从一页纸拉远', 'FN.pull0', FN.pull0, '收尾落拍：Dadd9 + 低音 D + 轻 impact（速度图让它正好落在小节线）'],
  ['finTitle', '收尾标题「从一页纸，到一整座知识库。」', 'SUPERS[从一页纸].s', superAt('从一页纸'), '无（让字幕独占）'],
  ['pull1', '主运动结束', 'FN.pull1', FN.pull1, '动机前三音中的 E 悬停，弦乐渐弱'],
  ['fade0', '地形淡回纸面', 'FN.fade0', FN.fade0, '弦乐放掉（154.95）'],
  ['reveal0', 'Logo 以眼眶为圆心展开', 'FN.reveal0', FN.reveal0, '前一拍（155.95–156.45）整体静止；动机最简形态从 F♯ 起'],
  ['eye0', '眼眶张开', 'FN.eye0', FN.eye0, '动机第 3 音 E'],
  ['word0', '字标', 'FN.word0', FN.word0, '动机落在 D：全曲解决'],
  ['blink', '眨眼', 'FN.blink', FN.blink, '钟琴 A6 一点闪光'],
];

export const HITS = HIT_DEFS.map(([id, label, src, script, action]) => {
  const t = F(script);
  const q8 = TEMPO.q(t, 2);
  const q16 = TEMPO.q(t, 4);
  return { id, label, src, script: r3(script), t, q8, q16, beat: r3(TEMPO.beatAt(t)), action };
});
const H = Object.fromEntries(HITS.map((h) => [h.id, h]));
/** 音乐实际落点（与 q8 不同的几处：提前 / 延后到小节线，或片尾按画面精确落） */
const MUSIC_AT = {
  rvReveal: 17,
  mmOpen: 22,
  examAI: TEMPO.q(H.examAI.t),
  essay: 76,
  dawn: 46,
  youIn: tb(256),
  youSkills: tb(268),
  youMcp: tb(274.5),
  youModels: tb(280),
  kb0: tb(287),
  fade0: tb(317.5),
  reveal0: F(FN.reveal0),
  eye0: F(FN.eye0),
  word0: F(FN.word0),
  blink: F(FN.blink),
};
for (const h of HITS) h.music = r4(MUSIC_AT[h.id] ?? h.q8);

// ── 4. 和弦（时间轴） ────────────────────────────────────────
// MIDI：D2=38 A2=45 D3=50 F♯3=54 A3=57 C♯4=61 E4=64 …；tones 为上方声部（中音区），bass 为低音。

const C = (t, sym, bass, tones) => ({ t: r4(t), sym, bass, tones });
const NC = (t) => ({ t: r4(t), sym: 'N.C.', nc: true, bass: null, tones: [] });

export const CHORDS = [
  // 第一幕：低音从 D 一级级爬到 A，再上到夜里的 B，然后 A、G 退回来
  C(0, 'Dsus2', 38, [57, 62, 64]),
  C(3, 'Dmaj9', 38, [54, 57, 61, 64]),
  C(6, 'Em9', 40, [55, 59, 62, 66]),
  C(10, 'F♯m11', 42, [57, 59, 61, 64]),
  C(TEMPO.q(H.rvCut.t), 'Gmaj9(♯11)', 31, [50, 57, 59, 61, 66]),
  C(18, 'A6/9', 33, [52, 59, 61, 66]),
  C(22, 'D(add9)/F♯', 42, [57, 62, 64, 66]),
  C(26, 'Gmaj7(♯11)', 43, [59, 61, 62, 66]),
  C(30, 'Asus4(add9)', 45, [57, 59, 62, 64]),
  C(H.prDone.q8, 'A(add9)', 45, [57, 59, 61, 64]),
  C(H.night.q8, 'Bm(add9)', 35, [54, 59, 61, 62]),
  C(38, 'Bm11/A', 33, [54, 59, 62, 64]),
  C(42, 'Gmaj7(♯11)', 31, [54, 59, 61, 62]),
  // 过场：D 利底亚（E/D 的 G♯）→ 动机落在 Dmaj9
  C(46, 'E/D', 38, [52, 56, 59, 66]),
  C(48, 'Dmaj9', 38, [54, 57, 61, 64]),
  C(50, 'Gmaj9/D', 38, [55, 59, 66, 69]),
  // 第二幕
  C(52, 'D(add9)', 38, [54, 57, 62, 64]),
  C(56, 'G6/9/D', 38, [55, 59, 64, 69]),
  C(60, 'Gmaj9', 31, [54, 57, 59, 62]),
  C(64, 'Em11', 40, [55, 59, 62, 69]),
  C(68, 'Bm9', 35, [54, 57, 61, 62]),
  C(72, 'Asus4', 33, [52, 57, 62, 64]),
  C(74, 'A(add9)', 33, [52, 57, 59, 61]),
  C(76, 'D/F♯', 42, [57, 62, 64, 69]),
  C(80, 'Gmaj7(♯11)', 43, [59, 61, 62, 66]),
  C(84, 'Em9', 40, [55, 59, 62, 66]),
  C(88, 'Asus2', 33, [52, 57, 59, 64]),
  C(92, 'Bm11', 35, [54, 57, 62, 64]),
  C(96, 'Gmaj9', 31, [54, 57, 59, 62]),
  C(100, 'D(add9)/F♯', 42, [57, 62, 64, 66]),
  C(104, 'Asus4', 33, [57, 59, 62, 64]),
  C(106, 'A', 33, [57, 61, 64, 69]),
  C(108, 'Dmaj9', 38, [54, 57, 61, 64]),
  C(112, 'Em9', 40, [55, 59, 62, 66]),
  C(116, 'Gmaj9(♯11)', 31, [54, 57, 59, 61]),
  // 上扬：低音 G–B–C 上行到第三幕的 D；音效提示音（D5 / F♯5 / A5 / D6）在这里也都是和弦音或张力音
  C(120, 'Bm11', 35, [54, 57, 62, 64]),
  C(122, 'Cmaj9(♯11)', 36, [52, 59, 62, 66]),
  NC(ACT3),
  // 第三幕（148 BPM，小节 62 = 124.0，小节 64 = 127.24）
  C(bar(64), 'Dmaj9', 38, [54, 57, 61, 64]),
  C(bar(66), 'F♯m11', 42, [57, 59, 61, 64]),
  C(bar(67), 'Em9', 40, [55, 59, 62, 66]),
  C(bar(68, 2.5), 'Gmaj9(♯11)', 31, [54, 57, 59, 61]),
  C(bar(70), 'Asus4', 33, [57, 59, 62, 64]),
  C(bar(71), 'A(add9)', 33, [57, 59, 61, 64]),
  // 收尾（120 BPM，小节 72 = 140.2）：D 持续低音上的上方结构
  C(bar(72), 'Dadd9', 38, [54, 57, 62, 64]),
  C(bar(74), 'Gmaj9/D', 38, [55, 59, 66, 69]),
  C(bar(76), 'Em11/D', 38, [55, 59, 64, 69]),
  C(bar(78), 'A7sus4/D', 38, [55, 57, 62, 64]),
  NC(tb(319.5)),
  C(F(FN.reveal0), 'D6/9', 38, [54, 57, 59, 64]),
];
CHORDS.forEach((c, i) => (c.t1 = i + 1 < CHORDS.length ? CHORDS[i + 1].t : DURATION));
export const chordAt = (t) => {
  let c = CHORDS[0];
  for (const x of CHORDS) {
    if (x.t <= t + 1e-6) c = x;
    else break;
  }
  return c;
};

// ── 5. 主动机 ───────────────────────────────────────────────
// F♯ – A – E – D：小三度上行、纯五度跳到九音 E（全句唯一的「意外」），级进落回主音。
// 原型节奏：♪ ♪ ♩ | 𝅝（第 4 音落在强拍）。全部在 D 大调五声音阶内，与音效的音高提示音同一音阶。
export const MOTIF = {
  names: ['F♯', 'A', 'E', 'D'],
  midi: [66, 69, 76, 74],
  beats: [-2, -1.5, -1, 0],
  rhythm: '♪ ♪ ♩ | 𝅝（第 4 音落强拍）',
};

// ── 6. 音轨 ────────────────────────────────────────────────

const TR = {};
const mk = (id, role, bus, gain, pan, reverb, extra = {}) => (TR[id] = { id, role, bus, gain, pan, reverb, events: [], ...extra });
const add = (tr, t, dur, midi, vel, o = {}) => {
  if (!(vel > 0) || !(dur > 0)) return;
  const ev = { t: r4(t), dur: r4(dur), vel: clamp(vel, 0.02, 1), ...o };
  if (midi !== undefined && midi !== null) ev.midi = midi;
  tr.events.push(ev);
};
const X = { exact: true };
const val = (v, t) => (typeof v === 'function' ? v(t) : v);
const ramp = (t0, v0, t1, v1) => (t) => v0 + (v1 - v0) * clamp((t - t0) / (t1 - t0));
/** 在 [t0, t1) 内按 step 拍遍历网格；pos 为小节内拍位（0–3.75）。 */
const grid = (t0, t1, step, fn) => {
  let b = Math.ceil(TEMPO.beatAt(t0) / step - 1e-6) * step;
  for (let k = 0; ; k++, b = r4(b + step)) {
    const t = TEMPO.timeAt(b);
    if (t >= t1 - 1e-6) break;
    const pos = r4(b - 4 * Math.floor(b / 4));
    fn(t, b, pos, k);
  }
};
const spb = (t) => TEMPO.spbAt(t);

const piano = mk('piano', 'piano', 'keys', 1.0, -0.06, 0.2);
const motifP = mk('piano_motif', 'piano', 'keys', 1.0, 0.0, 0.26);
const mallet = mk('mallet', 'mallet', 'keys', 0.55, 0.32, 0.24);
const bells = mk('bells', 'bells', 'keys', 0.36, 0.2, 0.5);
const pluck = mk('pluck', 'pluck', 'keys', 0.5, -0.3, 0.2);
const strings = mk('strings', 'strings_long', 'strings', 0.85, 0.0, 0.42);
const lead = mk('strings_lead', 'strings_long', 'strings', 0.62, 0.08, 0.48);
const spicc = mk('spiccato', 'strings_short', 'strings', 0.55, 0.22, 0.26);
const pad = mk('pad', 'pad', 'strings', 0.24, 0.0, 0.5);
const bass = mk('bass', 'bass', 'bass', 0.85, 0.0, 0.04);
const kick = mk('kick', 'kick', 'perc', 0.9, 0.0, 0.03, { sidechain: true });
const snare = mk('snare', 'snare', 'perc', 0.3, -0.05, 0.12);
const clap = mk('clap', 'clap', 'perc', 0.4, 0.06, 0.14);
const hat = mk('hat', 'hat', 'perc', 0.18, 0.32, 0.06);
const shaker = mk('shaker', 'shaker', 'perc', 0.2, -0.34, 0.08);
const wood = mk('wood', 'perc_wood', 'perc', 0.34, 0.22, 0.1);
const metal = mk('metal', 'perc_metal', 'perc', 0.26, -0.2, 0.3);
const impact = mk('impact', 'impact', 'fx', 0.7, 0.0, 0.32, { sidechain: true });
const swell = mk('swell', 'swell', 'fx', 0.42, 0.0, 0.3);

// ── 7. 织体生成器 ────────────────────────────────────────────

/** 和弦长音：每个和弦段一组音，段间重叠一点做连奏。 */
const sustain = (tr, t0, t1, { vel = 0.3, cello = false, top = false, low = 0, overlap = 0.12, exact = false, spread = 0.5, o = {} } = {}) => {
  for (const c of CHORDS) {
    if (c.nc) continue;
    const s = Math.max(c.t, t0);
    const e = Math.min(c.t1, t1);
    if (e - s < 0.05) continue;
    const last = e >= t1 - 1e-6;
    const notes = c.tones.map((m) => m + low);
    if (top) notes.push(c.tones[c.tones.length - 2] + 12);
    if (cello) notes.unshift(c.bass + 12);
    notes.forEach((m, i) =>
      add(tr, s, e - s + (last ? 0 : overlap), m, val(vel, s) * (i === 0 ? 1 : 0.9), {
        pan: (i / Math.max(1, notes.length - 1) - 0.5) * spread,
        ...(exact ? X : {}),
        ...o,
      }),
    );
  }
};

/** 钢琴三音循环：三音一轮压在四拍上，重音逐小节错位（Reich 式的多重节拍）。 */
const cycle = (tr, t0, t1, { vel = 0.4, oct = 0, step = 0.5, legato = 1.7, order = [0, 2, 1], dbl = 0, pick = (c) => c.tones.slice(-3) } = {}) => {
  let k = 0;
  grid(t0, t1, step, (t, b, pos) => {
    const c = chordAt(t + 1e-3);
    if (c.nc) return;
    const cell = pick(c).map((m) => m + oct);
    const m = cell[order[k++ % order.length] % cell.length];
    const acc = pos === 0 ? 1.16 : Number.isInteger(pos) ? 1.0 : 0.82;
    const d = spb(t) * step * legato;
    add(tr, t, d, m, val(vel, t) * acc);
    if (dbl && Number.isInteger(pos)) add(tr, t, d, m + 12, val(vel, t) * acc * dbl);
  });
};

/** 拨弦 / 琶音：六音一轮压在十六分音符上。 */
const arp = (tr, t0, t1, { vel = 0.28, oct = 12, step = 0.25, legato = 1.6, order = [0, 1, 2, 3, 2, 1], pick = (c) => c.tones.slice(-4) } = {}) => {
  let k = 0;
  grid(t0, t1, step, (t, b, pos) => {
    const c = chordAt(t + 1e-3);
    if (c.nc) return;
    const cell = pick(c).map((m) => m + oct);
    const m = cell[order[k++ % order.length] % cell.length];
    const acc = pos === 0 ? 1.2 : Number.isInteger(pos) ? 1.05 : pos % 0.5 === 0 ? 0.9 : 0.75;
    add(tr, t, spb(t) * step * legato, m, val(vel, t) * acc, { pan: Math.sin(k * 1.7) * 0.25 });
  });
};

/** 按小节内拍位放音：fn(t, pos, barNo) → { midi?, vel, dur? } | null。 */
const hits = (tr, t0, t1, positions, fn, step = 0.25) => {
  grid(t0, t1, step, (t, b, pos) => {
    if (!positions.includes(pos)) return;
    const r = fn(t, pos, Math.floor(b / 4));
    if (r) add(tr, t, r.dur ?? 0.25, r.midi, r.vel, r.o ?? {});
  });
};

/** 抽掉 [a, b) 内起音的音符（制造重音前的空拍）。 */
const rest = (trs, a, b) => {
  for (const tr of trs) tr.events = tr.events.filter((e) => e.t < a - 1e-6 || e.t >= b - 1e-6);
};

/** 主动机：times 为四个音的起点，durs 为时值。同一句标同一个 group，折回音区时整句一起移八度、轮廓不变。 */
let motifNo = 0;
const motif = (tr, times, { oct = 0, vel = 0.45, durs = [0.6, 0.6, 1.0, 3.0], notes = MOTIF.midi, velShape = [0.95, 0.92, 1.05, 1.0], o = X } = {}) => {
  const group = `motif${motifNo++}`;
  times.forEach((t, i) => t !== null && add(tr, t, durs[i], notes[i] + oct, vel * velShape[i], { ...o, group }));
};
/** 低音的八度跳音：上方超过 D3 时改为向下跳（低音提琴采样的最高根音在 B2 附近）。 */
const pop = (r) => (r + 12 <= 50 ? r + 12 : r - 12);
/** 采样器的音色变体（catalog.mjs 的 variant）；不支持时采样器按默认音色处理。 */
const V = (variant, o = {}) => ({ ...o, params: { ...(o.params ?? {}), variant } });

// ── 8. 编排 ────────────────────────────────────────────────

// 开场（0–6）：两张标题卡一问一答。独奏钢琴，近、干。
{
  const t1 = H.title1.q8; // 0.75
  motif(motifP, [t1, t1 + 0.5, t1 + 1.0, null], { vel: 0.46, durs: [0.8, 0.8, 1.6] });
  const t2 = H.title2.q8; // 3.0
  add(motifP, t2, 3.2, 74, 0.5, X);
  add(motifP, t2, 3.2, 50, 0.34, X);
  add(motifP, t2, 3.4, 38, 0.3, X);
  add(strings, t1, t2 - t1 + 0.1, 50, 0.2, X);
  add(strings, t1, t2 - t1 + 0.1, 57, 0.18, X);
  sustain(strings, t2, 13.75, { vel: 0.28 });
  sustain(pad, t2, 13.75, { vel: 0.26 });
}

// 读懂（6–13.75）：钢琴三音循环（中音区），D→E→F♯ 的低音
cycle(piano, 6, 13.75, { vel: ramp(6, 0.32, 13.5, 0.44) });
for (const t of [6, 10]) add(piano, t, 3.8, chordAt(t).bass + 12, 0.28);
hits(bass, 6, 13.75, [0], (t, pos, n) => (n % 2 === 1 ? { midi: chordAt(t).bass, vel: 0.42, dur: 3.9 } : null));

// 看清（13.75–17）：脉冲停下，弦乐张开；低音等 boom 过后再沉下去
{
  const cut = TEMPO.q(H.rvCut.t);
  sustain(strings, cut, 17, { vel: 0.5, cello: true, top: true, exact: true, spread: 0.8, o: V('trem') });
  sustain(strings, 17, 18, { vel: 0.38, exact: true });
  sustain(pad, cut, 18, { vel: 0.34 });
  add(bass, cut + 0.5, 18 - cut - 0.5, 31, 0.5, X);
  add(bells, 15.0, 2.0, 90, 0.2);
  add(bells, 16.0, 2.0, 85, 0.17);
}

// 引用（17–22）
cycle(piano, 17, 22, { vel: ramp(17, 0.36, 22, 0.42) });
add(piano, 18, 3.8, 45, 0.28);
add(bass, 18, 3.9, 33, 0.42);
sustain(strings, 18, 32.75, { vel: 0.3 });
sustain(pad, 18, 32.75, { vel: 0.24 });

// 整理（22–30）+ 练习（30–32.75）：轻鼓、马林巴反拍
cycle(piano, 22, 32.75, { vel: (t) => (t >= 28.5 && t < 30 ? 0.34 : 0.42) });
for (const t of [22, 26, 30]) add(piano, t, 3.8, chordAt(t).bass + 12, 0.28);
hits(mallet, 22, 28.5, [0.5, 1.5, 2.5, 3.5], (t, pos) => {
  const c = chordAt(t + 1e-3).tones.slice(-2);
  return { midi: c[pos === 1.5 || pos === 3.5 ? 0 : 1] + 12, vel: pos === 1.5 ? 0.34 : 0.27, dur: 0.4 };
});
hits(kick, 22, 32.75, [0, 2], (t, pos) => ({ vel: pos === 0 ? 0.52 : 0.42, dur: 0.3 }));
hits(wood, 22, 28.5, [1, 3], () => ({ vel: 0.26, dur: 0.1 }));
hits(wood, 30, 32.75, [1, 3], () => ({ vel: 0.22, dur: 0.1 }));
hits(bass, 22, 32.75, [0, 2], (t) => ({ midi: chordAt(t + 1e-3).bass, vel: 0.46, dur: 0.95 }));

// 入夜（32.75–46）：一刀切到夜色，只剩弦乐与低音；钢琴放慢成附点四分的摇篮曲
{
  const n = H.night.q8;
  add(piano, n, 3.6, 35, 0.44, X);
  add(piano, n, 3.6, 47, 0.36, X);
  add(bass, n, 38 - n, 35, 0.44, X);
  add(bass, 38, 4, 33, 0.4);
  add(bass, 42, 3.2, 31, 0.38);
  sustain(strings, n, 45.4, { vel: 0.3, exact: true });
  sustain(pad, n, 45.4, { vel: 0.3, exact: true });
  hits(piano, 34, 44.6, [0, 1.5, 3, 3.5], (t, pos, b) => {
    const c = chordAt(t + 1e-3).tones;
    if (pos === 3.5 && b % 2 === 0) return null;
    const m = pos === 0 ? c[0] : pos === 1.5 ? c[3] : pos === 3 ? c[2] : c[3] + 12;
    return { midi: m, vel: pos === 0 ? 0.34 : 0.29, dur: 1.5, o: V('felt') };
  });
  for (const t of [38, 42]) {
    add(piano, t, 3.6, chordAt(t).bass, 0.3);
    add(piano, t, 3.6, chordAt(t).bass + 12, 0.26);
  }
}

// 过场·清晨（46–52）：无脉冲，D 利底亚微光；48 第二幕标题处动机放宽一倍
{
  sustain(strings, 46, 52, { vel: 0.24, top: true });
  sustain(pad, 46, 52, { vel: 0.26 });
  add(strings, 48, 4.1, 38, 0.2);
  add(bells, 46.5, 2.0, 88, 0.18, V('handchimes'));
  add(bells, 47.0, 2.0, 83, 0.15, V('handchimes'));
  add(bells, 47.5, 2.0, 90, 0.15, V('handchimes'));
  const t = H.act2Title.q8; // 48.0
  motif(motifP, [t, t + 0.5, t + 1.0, t + 2.0], { oct: 12, vel: 0.4, durs: [1.2, 1.2, 1.6, 3.4] });
  motif(bells, [t, t + 0.5, t + 1.0, t + 2.0], { oct: 12, vel: 0.17, durs: [1, 1, 1.5, 3], o: V('handchimes', X) });
}

// 今日（52–60）：A–D 双音八分脉冲（半拍脉冲），像呼吸一样每小节起伏
hits(piano, 52, 60, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], (t, pos) => {
  const breath = 0.24 + 0.1 * Math.sin((Math.PI * pos) / 4);
  return { midi: 69, vel: breath * (pos === 0 ? 1.2 : 1), dur: 0.32 };
});
hits(piano, 52, 60, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], (t, pos) => ({ midi: 74, vel: (0.2 + 0.08 * Math.sin((Math.PI * pos) / 4)) * (pos === 0 ? 1.2 : 1), dur: 0.32 }));
for (const t of [52, 56]) add(piano, t, 3.8, 50, 0.28);
add(bass, 52, 3.95, 38, 0.38);
add(bass, 56, 3.95, 38, 0.38);
sustain(strings, 52, 60, { vel: 0.26 });
sustain(pad, 52, 60, { vel: 0.24 });
hits(spicc, 56, 60, [1.5, 3.5], (t, pos) => ({ midi: chordAt(t).tones[pos === 1.5 ? 2 : 3], vel: 0.32, dur: 0.15 }));
hits(kick, 56, 60, [0], () => ({ vel: 0.36, dur: 0.3 }));

// 检验（60–76）：十六分拨弦 + 干鼓；68.5 判错停拍，70.0 随 AI 解析恢复
{
  const stop = H.examSubmit.q8; // 68.5
  const back = TEMPO.q(H.examAI.t); // 70.0
  for (const [a, b] of [[60, stop], [back, 76]]) {
    arp(pluck, a, b, { vel: 0.28 });
    hits(kick, a, b, [0, 1.5, 2], (t, pos) => ({ vel: pos === 0 ? 0.6 : pos === 2 ? 0.52 : 0.42, dur: 0.3 }));
    hits(wood, a, b, [1, 3, 2.75], (t, pos) => ({ vel: pos === 2.75 ? 0.15 : 0.28, dur: 0.1 }));
    hits(bass, a, b, [0, 1.5, 2, 3.5], (t, pos) => {
      const r = chordAt(t + 1e-3).bass;
      return { midi: pos === 3.5 ? pop(r) : r, vel: pos === 0 ? 0.52 : 0.42, dur: pos === 0 || pos === 2 ? 0.6 : 0.3 };
    });
  }
  // 钢琴切分和弦：每小节 1、2&，隔小节再加第 4 拍
  for (const [a, b] of [[60, stop], [back, 76]]) {
    grid(a, b, 0.5, (t, bt, pos) => {
      const n = Math.floor(bt / 4);
      if (!(pos === 0 || pos === 1.5 || (pos === 3 && n % 2 === 1))) return;
      const c = chordAt(t + 1e-3);
      c.tones.forEach((m, i) => add(piano, t + i * 0.008, 0.36, m, (pos === 0 ? 0.36 : 0.3) * (i === c.tones.length - 1 ? 1 : 0.85)));
    });
  }
  add(piano, stop, 1.4, 35, 0.34, X);
  add(piano, stop, 1.4, 47, 0.28, X);
  sustain(strings, 60, 76, { vel: 0.28 });
  sustain(pad, 60, 76, { vel: 0.24 });
}

// 写作与精读（76–92）：收。钢琴高一个八度的三音循环、拨奏 2/4 拍、每小节一下底鼓
cycle(piano, 76, 90.5, { vel: 0.32, oct: 12, legato: 1.5 });
hits(spicc, 76, 90.5, [1, 3], (t, pos) => ({ midi: chordAt(t + 1e-3).tones[pos === 1 ? 0 : 1], vel: 0.3, dur: 0.15 }));
hits(kick, 76, 90, [0], () => ({ vel: 0.32, dur: 0.3 }));
hits(bass, 76, 90.5, [0, 2], (t) => ({ midi: chordAt(t + 1e-3).bass, vel: 0.4, dur: 0.95 }));
sustain(strings, 76, 92, { vel: 0.26 });
sustain(pad, 76, 92, { vel: 0.24 });

// 音视频（92–108）：半拍底鼓 + 八分低音 + 3+3+2 钢琴和弦，马林巴只点 1& / 3&
{
  const m0 = H.media.q8; // 92.0
  hits(kick, m0, 107, [0, 2], (t, pos) => ({ vel: pos === 0 ? 0.56 : 0.48, dur: 0.3 }));
  hits(bass, m0, 107.5, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], (t, pos) => ({ midi: chordAt(t + 1e-3).bass, vel: Number.isInteger(pos) ? 0.46 : 0.3, dur: 0.22 }));
  grid(m0, 107, 0.5, (t, bt, pos) => {
    if (![0, 1.5, 3].includes(pos)) return;
    const c = chordAt(t + 1e-3);
    c.tones.forEach((m, i) => add(piano, t + i * 0.006, 0.42, m, pos === 0 ? 0.34 : 0.28));
  });
  hits(mallet, 96, 107, [0.5, 2.5], (t, pos) => ({ midi: chordAt(t + 1e-3).tones[pos === 0.5 ? 3 : 2] + 12, vel: 0.24, dur: 0.5 }));
  sustain(strings, m0, 108, { vel: 0.28, exact: true });
  sustain(pad, m0, 108, { vel: 0.26 });
}

// 调研（108–124）：鼓回来，逐步加厚；114.25 完成重音；120 起 vi–♭VII 上扬，124 一刀切断
{
  const done = H.researchDone.q8; // 114.25
  hits(kick, 108, 120, [0, 1.5, 2], (t, pos) => ({ vel: ramp(108, 0.56, 120, 0.68)(t) * (pos === 1.5 ? 0.75 : 1), dur: 0.3 }));
  hits(clap, 112, 120, [1, 3], (t) => ({ vel: ramp(112, 0.24, 120, 0.32)(t), dur: 0.2 }));
  hits(shaker, 116, 120, [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 0], (t, pos) => ({ vel: Number.isInteger(pos) ? 0.1 : 0.17, dur: 0.12, o: V(Number.isInteger(pos) ? 'stroke' : 'up') }));
  hits(bass, 108, 120, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], (t, pos) => {
    const r = chordAt(t + 1e-3).bass;
    return { midi: pos === 3.5 ? pop(r) : r, vel: ramp(108, 0.42, 120, 0.52)(t) * (Number.isInteger(pos) ? 1 : 0.75), dur: 0.22 };
  });
  add(bass, 120, 1.95, 35, 0.54);
  add(bass, 122, 1.9, 36, 0.56);
  hits(spicc, 108, 120, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], (t, pos) => {
    const c = chordAt(t + 1e-3);
    return { midi: Number.isInteger(pos) ? c.bass + 24 : c.tones[1], vel: ramp(108, 0.24, 120, 0.38)(t), dur: 0.14, o: V('spic') };
  });
  arp(pluck, 112, 120, { vel: ramp(112, 0.22, 120, 0.32) });
  cycle(piano, 108, 120, { vel: ramp(108, 0.38, 120, 0.48), dbl: 0 });
  cycle(piano, 116, 120, { vel: ramp(116, 0.2, 120, 0.3), oct: 12, order: [0, 2, 1] });
  for (const t of [120, 122]) chordAt(t).tones.forEach((m, i) => add(piano, t + i * 0.03, 1.9, m, 0.4));
  add(piano, 120, 1.9, 47, 0.36);
  add(piano, 122, 1.9, 48, 0.38);
  // 114.25 完成重音：前面空一个八分音符，重音靠对比出来
  rest([kick, clap, shaker, bass, spicc, pluck, piano], done - 0.25, done);
  chordAt(done).tones.forEach((m) => add(spicc, done, 0.18, m + 12, 0.68, V('spic', X)));
  chordAt(done).tones.forEach((m, i) => add(piano, done + i * 0.006, 0.9, m + 12, 0.42, X));
  add(metal, done, 1.2, null, 0.42, X);
  add(kick, done, 0.3, null, 0.66, X);
  sustain(strings, 108, 120, { vel: 0.3 });
  sustain(strings, 120, ACT3 - 0.05, { vel: 0.42, cello: true, top: true, spread: 0.8 });
  sustain(pad, 108, ACT3 - 0.05, { vel: 0.26 });
  add(swell, ACT3 - 2, 2, null, 0.6, X);
}

// 第三幕（124–140.2，148 BPM）：124 抽空 → 125.2 动机起句 → 127.24 全编制
{
  const tTitle = tb(251); // 125.215，第 1 小节第 4 拍
  const tIn = bar(64); // 127.24
  const notes = [tTitle, bar(63), bar(63, 1), tIn];
  motif(motifP, notes, { vel: 0.5, durs: [0.42, 0.42, 1.25, 2.4] });
  motif(motifP, notes, { oct: 12, vel: 0.34, durs: [0.42, 0.42, 1.25, 2.4] });
  motif(lead, notes, { vel: 0.4, durs: [0.42, 0.42, 1.25, 2.6], velShape: [0.9, 0.9, 1.1, 1.0] });
  add(swell, bar(63, 1), tIn - bar(63, 1), null, 0.5, X);
  add(impact, tIn, 2.5, null, 0.8, X);
  add(bells, tIn, 2.5, 86, 0.22, X);

  const end = tb(287); // 139.795：最后一拍留空
  hits(kick, tIn, end, [0, 1, 2, 3], (t, pos) => ({ vel: pos === 0 ? 0.7 : pos === 2 ? 0.62 : 0.5, dur: 0.3 }));
  hits(clap, tIn, end, [1, 3], () => ({ vel: 0.32, dur: 0.2 }));
  hits(snare, tIn, end, [3.75], (t, pos, n) => (n % 2 === 1 ? { vel: 0.16, dur: 0.12 } : null));
  hits(hat, tIn, end, [0.5, 1.5, 2.5, 3.5], (t, pos) => ({ vel: pos === 1.5 || pos === 3.5 ? 0.2 : 0.13, dur: 0.08 }));
  hits(shaker, tIn, end, [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75], (t, pos) => ({ vel: 0.1, dur: 0.08, o: V(pos % 1 === 0.25 ? 'stroke' : 'up') }));
  hits(bass, tIn, end, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], (t, pos) => {
    const r = chordAt(t + 1e-3).bass;
    return { midi: pos === 1.5 || pos === 3.5 ? pop(r) : r, vel: Number.isInteger(pos) ? 0.52 : 0.4, dur: 0.18 };
  });
  arp(pluck, tIn, end, { vel: 0.26 });
  cycle(piano, tIn, end, { vel: 0.42, oct: 12, dbl: 0.5 });
  hits(spicc, tIn, end, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], (t, pos) => {
    const r = chordAt(t + 1e-3).bass;
    return { midi: Number.isInteger(pos) ? r + 24 : r + 31, vel: 0.32, dur: 0.12, o: V('spic') };
  });
  for (const c of CHORDS.filter((x) => x.t >= tIn - 1e-6 && x.t < FINALE - 1e-6)) add(piano, c.t, Math.min(c.t1, end) - c.t, c.bass + 12, 0.32);
  sustain(strings, tIn, FINALE, { vel: 0.4, cello: true, top: true, spread: 0.8, exact: true });
  sustain(pad, tIn, FINALE, { vel: 0.26 });
  // 动机钩子：落在 132.10（Em9 的七音）与 136.96（Asus4 的四音）
  for (const land of [bar(67), bar(70)]) {
    const b = TEMPO.beatAt(land);
    const ts = MOTIF.beats.map((d) => tb(b + d));
    motif(bells, ts, { oct: 24, vel: 0.24, durs: [0.3, 0.3, 0.5, 1.6] });
    motif(lead, ts, { oct: 12, vel: 0.3, durs: [0.3, 0.3, 0.5, 1.4] });
  }
}

// 收尾（140.2–156.46）：登顶。D 持续低音，钟琴微光，动机前三音悬而不决
{
  add(impact, FINALE, 3, null, 0.42, X);
  hits(kick, FINALE, bar(76), [0], (t, pos, n) => ({ vel: 0.36 - (n - 72) * 0.04, dur: 0.3, o: V('concert') }));
  const release = tb(317.5); // 154.95 ≈ FN.fade0
  sustain(strings, FINALE, release, { vel: 0.38, cello: true, top: true, spread: 0.9, exact: true });
  add(strings, FINALE, release - FINALE, 38, 0.26, X);
  sustain(pad, FINALE, release + 0.3, { vel: 0.26 });
  for (let n = 72; n < 80; n += 2) add(bass, bar(n), Math.min(bar(n + 2), release) - bar(n) - 0.02, 38, 0.42, n === 72 ? X : {});
  for (const c of CHORDS.filter((x) => x.t >= FINALE - 1e-6 && x.t < release)) {
    c.tones.forEach((m, i) => add(piano, c.t + i * 0.04, 3.8, m, 0.34));
    add(piano, c.t, 3.8, 50, 0.3);
  }
  hits(piano, FINALE, bar(77), [0, 2], (t) => {
    const c = chordAt(t + 1e-3).tones;
    return { midi: c[c.length - 1] + 12, vel: 0.2, dur: 1.4 };
  }, 0.5);
  // 动机前三音：F♯5 – A5 – E6，E 悬停到镜头主运动结束之后
  motif(lead, [bar(75), bar(75, 2), bar(76), null], { oct: 12, vel: 0.34, durs: [1.1, 1.1, 3.6] });
  // 微光：钟琴在五声音阶高音区随机点亮（避开 142–144 计曲线 ping 音效）
  const r = mulberry(7140);
  const pent = [81, 83, 86, 88, 90, 93, 95];
  let idx = 3;
  grid(bar(74), bar(78, 2), 0.5, (t) => {
    if (r() > 0.42) return;
    idx = clamp(idx + Math.round((r() - 0.5) * 3), 0, pent.length - 1);
    add(bells, t, 1.2, pent[idx], 0.12 + r() * 0.07);
  });
}

// 片尾（156.46–166）：Logo 展开前一拍静止；动机最简形态随 Logo 各层落下，眨眼时一点闪光
{
  const t0 = F(FN.reveal0);
  const ts = [t0, r3((t0 + F(FN.eye0)) / 2), F(FN.eye0), F(FN.word0)];
  motif(motifP, ts, { oct: 12, vel: 0.5, durs: [0.9, 0.9, 1.0, 6.5], velShape: [0.95, 0.9, 1.05, 1.1] });
  motif(bells, ts, { oct: 12, vel: 0.24, durs: [0.8, 0.8, 1.0, 5], o: V('handchimes', X) });
  add(motifP, t0, 7.5, 38, 0.4, X);
  add(motifP, t0, 7.5, 50, 0.34, X);
  sustain(strings, t0, 165, { vel: 0.26, exact: true });
  add(bass, t0, 6.5, 38, 0.34, X);
  add(bells, F(FN.blink), 3, 93, 0.34, X);
}

// ── 9. 人性化 + 种子 ─────────────────────────────────────────
for (const tr of Object.values(TR)) {
  tr.events = tr.events.filter((e) => e.vel > 0 && e.dur > 0 && e.midi !== null);
  const h = hashStr(tr.id);
  const r = mulberry(h);
  tr.events.sort((a, b) => a.t - b.t);
  tr.events.forEach((ev, i) => {
    ev.seed = (h + i) % 8;
    if (!ev.exact) {
      ev.t = r4(Math.max(0, ev.t + (r() * 2 - 1) * 0.005));
      ev.vel = r3(clamp(ev.vel * (1 + (r() * 2 - 1) * 0.07), 0.02, 1));
    }
  });
}

export const TRACKS = Object.values(TR);

/** 角色的常识音区（INSTRUMENT_INFO 没给 range 时用；与采样目录的默认音色一致）。 */
export const DEFAULT_RANGES = {
  piano: [21, 108],
  mallet: [41, 96],
  bells: [79, 108],
  pluck: [28, 103],
  strings_long: [36, 88],
  strings_short: [36, 88],
  pad: [36, 96],
  bass: [24, 60],
};

/**
 * 按 INSTRUMENT_INFO[role]（或其 variants[params.variant]）的 range 把越界的音按八度折回音区。
 * 同 group 的音（一句动机）整句移同一个八度，保持轮廓；返回被移动的音数。
 */
export const applyRanges = (tracks, info = {}) => {
  let moved = 0;
  for (const tr of tracks) {
    const rangeOf = (ev) => info[tr.role]?.variants?.[ev.params?.variant]?.range ?? info[tr.role]?.range ?? DEFAULT_RANGES[tr.role];
    const groups = new Map();
    tr.events.forEach((ev, i) => {
      if (ev.midi === undefined) return;
      const k = ev.group ?? `#${i}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ev);
    });
    for (const evs of groups.values()) {
      const range = rangeOf(evs[0]);
      if (!range || range[1] - range[0] < 12) continue;
      const [lo, hi] = range;
      const min = Math.min(...evs.map((e) => e.midi));
      const max = Math.max(...evs.map((e) => e.midi));
      let s = 0;
      while (min + s < lo) s += 12;
      while (max + s > hi && min + s - 12 >= lo) s -= 12;
      for (const ev of evs) {
        let m = ev.midi + s;
        while (m < lo) m += 12;
        while (m > hi) m -= 12;
        if (m !== ev.midi) {
          ev.midi = m;
          moved++;
        }
      }
    }
  }
  return moved;
};

// ── 10. 段落 ────────────────────────────────────────────────

export const SECTIONS = [
  { id: 'open', label: '开场·立题', t0: 0, t1: 6, density: 1, roles: '独奏钢琴（动机一问一答）；弦乐空五度 → Dmaj9 铺底' },
  { id: 'read', label: '读懂', t0: 6, t1: TEMPO.q(H.rvCut.t), density: 2, roles: '钢琴三音循环（A3–F♯4）+ 左手低八度；低音全音符；弦乐 / 垫音' },
  { id: 'see', label: '看清（3D）', t0: TEMPO.q(H.rvCut.t), t1: 17, density: 1, roles: '脉冲停；弦乐张开（大提琴 G2 + 高八度）；低音 G1（boom 之后）；钟琴两点' },
  { id: 'cite', label: '引用回溯', t0: 17, t1: 22, density: 2, roles: '钢琴循环回来；A6/9' },
  { id: 'organize', label: '整理', t0: 22, t1: 30, density: 3, roles: '+ 底鼓 1/3 拍、木块 2/4 拍、马林巴反拍（28.5 退出）、低音二分音符' },
  { id: 'practice', label: '练习', t0: 30, t1: H.night.q8, density: 3, roles: '同上去掉马林巴；Asus4 → A(add9)' },
  { id: 'night', label: '入夜·记住', t0: H.night.q8, t1: 46, density: 1, roles: '弦乐 + 低音 B1/A1/G1；钢琴附点四分摇篮曲（B 小调）；垫音低通关小' },
  { id: 'dawn', label: '过场·清晨', t0: 46, t1: 52, density: 1, roles: 'D 利底亚弦乐 + 手摇钟三点微光；48 动机放宽一倍（钢琴高音区 + 手摇钟）；无打击' },
  { id: 'today', label: '今日', t0: 52, t1: 60, density: 2, roles: '钢琴 A4+D5 八分双音脉冲；56 起拨奏反拍 + 每小节一下底鼓' },
  { id: 'exam', label: '检验', t0: 60, t1: 76, density: 4, roles: '十六分拨弦（六音一轮）、钢琴切分和弦、底鼓 1·2&·3、木块、切分低音；68.5–70 停拍' },
  { id: 'writing', label: '写作与精读', t0: 76, t1: 92, density: 2, roles: '钢琴高八度三音循环、拨奏 2/4、底鼓每小节一下、低音二分' },
  { id: 'media', label: '音视频', t0: 92, t1: 108, density: 3, roles: '半拍底鼓、八分低音、钢琴 3+3+2 和弦、马林巴 1&/3&（96 起）' },
  { id: 'research', label: '调研', t0: 108, t1: ACT3, density: 4, roles: '底鼓 1·2&·3 + 拍手 2/4（112）+ 沙锤（116）、跳弓八分、十六分拨弦、钢琴循环加八度；120 vi–♭VII 上扬（Bm11 → Cmaj9♯11，低音 G–B–C）' },
  { id: 'you', label: '第三幕·越用越懂你', t0: ACT3, t1: FINALE, density: 5, roles: '124 静止 → 125.2 动机（钢琴八度 + 弦乐）→ 127.24 全编制：四拍底鼓、拍手、踩镲反拍、沙锤、八分低音、十六分拨弦、钢琴八度循环、跳弓、钟琴钩子' },
  { id: 'summit', label: '收尾·登顶', t0: FINALE, t1: F(FN.reveal0), density: 2, roles: 'D 持续低音；宽弦乐 + 钢琴分解和弦；钟琴微光；动机前三音悬停；155.95 起静止一拍' },
  { id: 'logo', label: '片尾 Logo', t0: F(FN.reveal0), t1: DURATION, density: 1, roles: '动机最简形态（钢琴独奏 + 手摇钟同度）、低音 D、极弱 D6/9 弦乐；眨眼一点闪光' },
];

// ── 11. 自动化 ──────────────────────────────────────────────
// 曲线为 [[秒, 值], …]，段间 smoothstep 插值；增益为线性倍数，滤波为 Hz。

const cut = (a, b, fade = 0.03) => [[a - fade, 1], [a, 0], [b - fade, 0], [b, 1]];
const silence124 = cut(ACT3, tb(251) - 0.01);
const silenceLogo = cut(tb(319.5), F(FN.reveal0) - 0.01, 0.06);

export const AUTOMATION = {
  tracks: {
    strings: {
      gain: [[0, 0.8], [3, 1], [TEMPO.q(H.rvCut.t), 1], [16.4, 1.25], [17.2, 1], [H.night.q8 - 0.02, 1], [H.night.q8 + 0.05, 0.9], [45, 0.9], [46, 0.6], [48, 0.95], [119.9, 0.95], [ACT3 - 0.1, 1.45], [ACT3 + 0.05, 1.0], [FINALE, 1.0], [150.8, 1.05], [154.9, 0.8], [158, 0.9], [165, 0.0]],
      lp: [[0, 16000], [H.night.q8 - 0.02, 16000], [H.night.q8 + 0.5, 3600], [45.5, 3600], [46.5, 9000], [48.5, 16000]],
    },
    pad: {
      lp: [[0, 3200], [13, 3800], [17, 5000], [H.night.q8 - 0.02, 5000], [H.night.q8 + 0.55, 1100], [45, 1000], [46, 1500], [48.5, 5500], [60, 5000], [108, 4500], [123.9, 8000], [FINALE, 6000], [156, 4000]],
    },
    strings_lead: { gain: [[0, 1], [bar(63, 1), 0.75], [bar(64), 1.35], [bar(64) + 0.5, 1]] },
    piano: { send: [[0, 1], [H.night.q8, 1], [H.night.q8 + 0.3, 1.6], [45.5, 1.6], [52, 1], [FINALE, 1.3]] },
    piano_motif: { send: [[0, 1], [50, 1.2], [52, 1], [F(FN.reveal0), 1.5]] },
  },
  buses: {
    keys: { gain: [[0, 1], ...silence124, ...silenceLogo] },
    strings: { gain: [[0, 1], ...silence124, ...silenceLogo] },
    bass: { gain: [[0, 1], ...silence124, ...silenceLogo] },
    perc: { gain: [[0, 1], ...silenceLogo] },
    fx: { gain: [[0, 1], ...cut(ACT3 + 0.02, tb(251) - 0.01, 0.02), ...silenceLogo] },
  },
  reverb: {
    hall: [[0, 1], [ACT3 - 0.02, 1], [ACT3 + 0.12, 0.3], [tb(251) - 0.01, 0.3], [tb(251) + 0.1, 1], [tb(319.5) - 0.05, 1], [tb(319.5) + 0.2, 0.35], [F(FN.reveal0), 1]],
    room: [[0, 1]],
  },
  master: { gain: [[0, 1], [163.6, 1], [DURATION, 0]] },
};

// ── 12. 摘要 ────────────────────────────────────────────────
export const describe = () => ({
  tempo: TEMPO.segments,
  beatSources: BEAT_SOURCES,
  tracks: TRACKS.map((t) => ({ id: t.id, role: t.role, bus: t.bus, events: t.events.length })),
  chords: CHORDS.map((c) => ({ t: c.t, sym: c.sym })),
  hits: HITS.map(({ id, t, q8, q16 }) => ({ id, t, q8, q16 })),
});

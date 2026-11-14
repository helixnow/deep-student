import { CW } from '../../ui/classic';
import { CLASSIC_ASSISTANT_TOP, CLASSIC_USER_TOP, COMPOSER_W } from '../../ui/chat';
import { rand } from '../../lib/time';

/**
 * 检索段（02 看清）的节拍表，单位为脚本秒。
 * 气泡向量化（DOM）→ 资料纵深（3D）→ 命中纸片回到界面（DOM）。
 */
export const RV = {
  focus: 5.98, // 镜头推向用户气泡、其余内容压暗
  tokenize: 6.12, // 分词括线
  embed: 6.28, // 每个 token 升起向量列
  pool: 6.52, // 池化成一条查询向量
  cut: 6.9, // 匹配剪辑：DOM 向量条 → 3D 向量条
  probe: 7.1, // 向量条收拢成探针
  scan: 7.12, // 相似度波前开始扩散
  scanEnd: 7.82,
  select: 7.78, // top-k 连线
  extract: 7.92, // 命中纸片抽离到镜头前
  reveal: 8.42, // 3D 世界淡出、界面回到画面
  land1: 8.74, // 教材页落进右侧 PDF 面板（啪）
  land2: 8.8,
  land3: 8.86,
  done: 8.86, // 检索行切到完成态
} as const;

/** 回答流式及之后的所有镜头整体后移量（相对旧版 30s 剧本）。 */
export const POST = 1.0;

export const QUERY_TOKENS = ['讲透', '这一节', '：', '画', '导图', '、', '出', '卡片'];
export const QUERY_TEXT = QUERY_TOKENS.join('');
export const TOKEN_DIMS = 8;

/** 查询向量条（chat 列局部坐标）：64 维显示格，跟着助手块顶走（原版助手块顶 150 时 cy=250）。 */
export const STRIP = { cells: 64, cell: 8, pitch: 10, cx: 360, cy: 250 + (CLASSIC_ASSISTANT_TOP - 150) };
export const STRIP_W = (STRIP.cells - 1) * STRIP.pitch + STRIP.cell;

/** 用户气泡（chat 列局部坐标）：气泡在最上（附件方块排在气泡下方），padding 10.5/14、行高 26.4，右对齐到 32+COMPOSER_W。 */
export const BUBBLE = { right: 32 + COMPOSER_W, top: CLASSIC_USER_TOP, padX: 14, padY: 10.5, line: 26.4, font: 16 };

export const toWorld = (x: number, y: number) => ({ x: CW.chatX + x, y: CW.title + y });
export const STRIP_WORLD = toWorld(STRIP.cx, STRIP.cy);
export const BUBBLE_WORLD = toWorld(BUBBLE.right - 140, BUBBLE.top + 24);

/** 匹配剪辑时 DOM 相机的 zoom（向量条在屏幕上约 1660px 宽）。 */
export const CUT_ZOOM = 2.6;

/** 确定性的嵌入值 ∈ [-1, 1]。 */
export const cellValue = (i: number) => {
  const a = Math.sin(i * 0.37 + 1.3) * 0.6 + Math.sin(i * 1.71 + 0.2) * 0.4;
  return Math.max(-1, Math.min(1, a * 0.85 + (rand(i + 91) - 0.5) * 0.5));
};
export const tokenCell = (tok: number, d: number) => cellValue(tok * 13 + d * 5 + 7);

/** 查询向量的细竖条（DOM 像素）：宽 BAR.w，高 = barLen(v) × BAR.h；3D 里按 CUT_ZOOM 换算成同样的屏幕尺寸。 */
export const BAR = { w: 3, h: 22 };
export const barLen = (v: number) => 0.22 + 0.78 * Math.min(1, Math.abs(v));

/** 嵌入值 → 叠在白底上的实色（DOM 与 3D 共用，保证匹配剪辑无色差）。 */
export const cellRGB = (v: number): [number, number, number] => {
  const a = Math.min(1, Math.abs(v));
  const c = v >= 0 ? [0.13, 0.36, 0.72] : [0.55, 0.58, 0.64];
  const w = v >= 0 ? 0.15 + a * 0.85 : 0.1 + a * 0.55;
  return [1 + (c[0] - 1) * w, 1 + (c[1] - 1) * w, 1 + (c[2] - 1) * w];
};
export const cellCss = (v: number) => {
  const [r, g, b] = cellRGB(v);
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
};

export type HitKind = 'textbook' | 'note' | 'memory';
export const HITS: Array<{ kind: HitKind; tag: string; title: string; score: number }> = [
  { kind: 'note', tag: 'unified', title: '证明笔记 · 拉格朗日中值定理', score: 0.88 },
  { kind: 'textbook', tag: 'unified', title: '高等数学（第七版）上册 · 第134页', score: 0.93 },
  { kind: 'memory', tag: 'memory', title: '学习记忆 · ξ 的取值范围常写错', score: 0.85 },
];

import {
  ArrowCounterClockwise,
  CaretLeft,
  CaretRight,
  Copy,
  DotsThree,
  GitBranch,
  Lightning,
  LinkSimple,
  MagnifyingGlass,
  Package,
  Pencil,
  Plus,
  Square,
  Trash,
  Wrench,
} from '@phosphor-icons/react';
import { lobeIconData } from '@app/utils/lobeIconData';
import type { CSSProperties, ReactNode } from 'react';
import { clamp, PACE } from '../lib/time';
import { font } from '../theme';
import { AssistantFooter, ChatSidebar, DockComposer, FG, LINE_SOFT, MUTED, PRI, SourcesRow, T, ToolRow, UserBubble, type SidebarRow } from './research';
import { at } from './resource';

/**
 * 第三幕「越用，越懂你」的四块面板：智能记忆、技能管理、MCP 工具、多模型并排。
 * 文案来自 learningHub（记忆）、skills.json builtinNames（58 个内置技能）、chatV2 blocks.mcpTool。
 */

// ── 记忆（对话里的「记忆搜索」工具 + [忆N] 引用） ─────────────
/** 取证 probe-ymc-10：新会话里问概念，先跑记忆搜索，回答按画像里的偏好与易错点作答并带 [忆N] 角标，末尾「2 个结果」。 */
export const MEM_Q = '拉格朗日中值定理到底在说什么？';
export const MEM_TITLE = '拉格朗日中值定理';
type Seg = string | { cite: string } | { em: string };
const MEM_P1: Seg[][] = [['按你的习惯，先看几何直观', { cite: '[忆1]' }, '：连接 A、B 两点得到一条弦，曲线上一定有一点的'], ['切线和这条弦平行——那一点就是 ξ。']];
const MEM_P2: Seg[][] = [['再看严格表述：f 在 [a, b] 上连续、在 (a, b) 内可导，则存在 ξ ∈ (a, b)，使 f′(ξ) ='], ['(f(b) − f(a)) / (b − a)。注意 ξ 落在开区间里，这正是你之前容易写错的地方', { cite: '[忆2]' }, '。']];

/** 记忆这段的时间轴（脚本秒）：工具 718ms（÷PACE）→ 两段流式 → 来源行 / 页脚 → 首轮结束起名。 */
export const memoryTL = (a0: number) => {
  const tool = a0 + 0.1;
  const toolDone = tool + 0.718 / PACE;
  const p1 = toolDone + 0.04;
  const p2 = p1 + 0.5;
  const done = p2 + 0.56;
  return { tool, toolDone, p1, p2, done, title: done + 0.2 };
};

const Cite = ({ label }: { label: string }) => (
  <span style={{ display: 'inline-block', height: 17.5, margin: '0 4px', padding: '0 4.5px', borderRadius: 9, background: 'rgba(30, 94, 184, 0.1)', color: PRI, fontSize: 11, fontWeight: 500, lineHeight: '17.5px', verticalAlign: 'middle', position: 'relative', top: -1.5 }}>{label}</span>
);

/** 按字数流式展开一段（角标算一个单位，流到它才出现）；返回已开始的行。 */
const streamLines = (lines: Seg[][], k: number) => {
  const len = (g: Seg) => (typeof g === 'string' ? [...g].length : 'em' in g ? [...g.em].length : 1);
  const units = lines.map((l) => l.reduce((s, g) => s + len(g), 0));
  let left = Math.round(units.reduce((s, u) => s + u, 0) * k);
  const out: ReactNode[][] = [];
  for (const l of lines) {
    if (left <= 0) break;
    const row: ReactNode[] = [];
    for (const g of l) {
      if (left <= 0) break;
      if (typeof g === 'string') {
        row.push([...g].slice(0, left).join(''));
      } else if ('em' in g) {
        row.push(
          <em key={g.em} style={{ color: MUTED }}>
            {[...g.em].slice(0, left).join('')}
          </em>,
        );
      } else {
        row.push(<Cite key={g.cite} label={g.cite} />);
      }
      left -= len(g);
    }
    out.push(row);
  }
  return out;
};

export const MemoryChat = ({ t, at: a0 }: { t: number; at: number }) => {
  const tl = memoryTL(a0);
  const streaming = t >= tl.tool && t < tl.done;
  const l1 = streamLines(MEM_P1, clamp((t - tl.p1) / (tl.p2 - tl.p1 - 0.02)));
  const l2 = streamLines(MEM_P2, clamp((t - tl.p2) / (tl.done - tl.p2)));
  const yP1 = 208.9;
  const yP2 = yP1 + l1.length * LH + 18.9;
  const ySrc = (l2.length ? yP2 + l2.length * LH : yP1 + l1.length * LH) + 29.8;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', fontFamily: font.ui, color: FG }}>
      <ChatSidebar rows={youSidebar('memory', { title: t >= tl.title ? MEM_TITLE : '未命名会话', time: '刚刚', active: true, streaming })} t={t} />
      <UserBubble y={60} text={MEM_Q} time={YOU_CLOCK.memory} />
      {t >= tl.tool ? <ToolRow y={172.4} label="记忆搜索" w={64} icon={MagnifyingGlass} done={t >= tl.toolDone} ms="718ms" /> : null}
      {l1.map((row, j) => (
        <T key={`a${j}`} x={368} y={yP1 + j * LH} size={16} lh={LH}>
          {row}
        </T>
      ))}
      {l2.map((row, j) => (
        <T key={`b${j}`} x={368} y={yP2 + j * LH} size={16} lh={LH}>
          {row}
        </T>
      ))}
      {l1.length ? <SourcesRow y={ySrc} n={2} searching={false} /> : null}
      {t >= tl.done ? <AssistantFooter y={ySrc + 39.6} time={YOU_CLOCK.memory} /> : null}
      <DockComposer text="" caret={false} mode={streaming ? 'stop' : 'idle'} press={0} />
    </div>
  );
};

// ── 技能管理（system/skills 应用，SkillsManagementPage + SkillsList） ──────
/** 技能管理窗默认 980×680；几何取自 probe-ysk（窗口坐标），卡片文案为技能注册表的中文描述。 */
export const SKILL_W = 980;
export const SKILL_H = 680;
const SK_MUTED6 = 'rgba(101, 105, 114, 0.6)';
const SK_LINE = 'rgba(224, 224, 224, 0.55)';
const SK_CHIP_FG = 'rgb(59, 63, 69)';

/** 标题栏：「所有技能 / 56 个」…「＋ 新建技能」| ⋯（titlebar 内坐标 = 窗口坐标 − 1）。 */
export const SkillsToolbar = () => {
  const tb = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x - 1, top: y - 1 });
  return (
    <>
      <span style={{ ...tb(80, 13), fontSize: 13, fontWeight: 600, lineHeight: '13px', color: FG }}>所有技能</span>
      <span style={{ ...tb(139, 14), fontSize: 11, fontWeight: 500, lineHeight: '11px', color: 'rgba(101, 105, 114, 0.4)' }}>/</span>
      <span style={{ ...tb(149.5, 14), fontSize: 11, fontWeight: 500, lineHeight: '11px', color: MUTED }}>56 个</span>
      <Plus size={14} color={MUTED} style={tb(848.7, 12.5)} />
      <span style={{ ...tb(868.7, 14), fontSize: 11, fontWeight: 500, lineHeight: '11px', color: MUTED }}>新建技能</span>
      <span style={{ ...tb(934.3, 12.5), width: 1, height: 14, background: 'rgba(224, 224, 224, 0.4)' }} />
      <DotsThree size={22} weight="bold" color={MUTED} style={tb(947, 8.5)} />
    </>
  );
};

type SkillCard = { name: string; ver: string; desc: string; tools?: number; deps?: number };
const SKILL_ROWS: Array<{ y: number; h: number; cards: SkillCard[] }> = [
  {
    y: 108,
    h: 174.1,
    cards: [
      { name: '脚本化工具组合', ver: 'v1.0.0', desc: 'PTC 程序化工具组合能力：提交一段 Starlark 脚本，用 call(tool, args) 串行组合注册表白名单内工具，并可向 artifacts 写受控产物。适合多步检索/过滤/合并/生成场景，一次调用替代多轮工具往返。', tools: 1 },
      { name: '工具包', ver: 'v1.0.0', desc: 'ToolPack 并行工具包能力，允许在一次调用中并行执行多个内置工具并汇总结果。当需要同时查询多个数据源时使用。', tools: 1 },
      { name: '导师模式', ver: 'v2.3.0', desc: '苏格拉底式导师，通过提问与提示引导学习。' },
    ],
  },
  {
    y: 299.6,
    h: 189.6,
    cards: [
      { name: '调研模式', ver: 'v2.0.0', desc: '深度调研模式，用于探索、归纳与引用。' },
      { name: '技能安装器', ver: 'v1.3.1', desc: '从链接安装技能包：用户粘贴 GitHub 仓库/子目录链接、SKILL.md 原始链接、zip 直链或社区市场/skills.sh 页面链接时使用。社区市场使用 builtin-skill_market_search / builtin-skill_market_skill_detail 只读检索。', deps: 1, tools: 4 },
      { name: '模板设计', ver: 'v1.3.0', desc: '设计和管理可复用的文档模板。', tools: 9 },
    ],
  },
  {
    y: 506.8,
    h: 174.1,
    cards: [
      { name: '深度学者', ver: 'v3.1.0', desc: '默认学习策略：融合记忆生产/消费与轻量询问，确保个性化准确且记忆干净。', deps: 3 },
      { name: '试卷分析', ver: 'v1.1.0', desc: '智能试卷分析助手：识别已批改试卷上的对错标记、扣分批注和勾画，提取薄弱知识点并整理为结构化问题清单，引导用户确认后逐题攻破。', deps: 1 },
      { name: '文献综述助手', ver: 'v1.0.0', desc: '规划并撰写文献综述，整合论文与笔记。' },
    ],
  },
];
const SKILL_COL_X = [36, 344.5, 653];

const Chip = ({ x, y, icon, text }: { x: number; y: number; icon: ReactNode; text: string }) => (
  <span style={{ ...at(x, y), height: 20, padding: '0 8px', boxSizing: 'border-box', borderRadius: 999, background: 'rgb(253, 253, 253)', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 500, lineHeight: '11px', color: SK_CHIP_FG, whiteSpace: 'nowrap' }}>
    {icon}
    {text}
  </span>
);

const SkillCardView = ({ x, y, h, c }: { x: number; y: number; h: number; c: SkillCard }) => {
  const b = y + h;
  // 依赖 + 工具同时出现时页脚折成两行（技能安装器）
  const two = c.deps !== undefined && c.tools !== undefined;
  const lineY = two ? b - 74 : b - 54.5;
  const r1 = two ? b - 58.4 : b - 39;
  const mid = two ? b - 46.7 : b - 39;
  return (
    <>
      <span style={{ ...at(x, y), width: 291, height: h, boxSizing: 'border-box', borderRadius: 18, border: `1px solid ${SK_LINE}`, background: 'rgb(253, 253, 253)', boxShadow: '0 12px 24px rgba(0, 0, 0, 0.04)' }} />
      <T x={x + 15} y={y + 15.5} size={12} weight={500} lh={15}>
        {c.name}
      </T>
      <span style={{ ...at(x + 15, y + 33.3), display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, lineHeight: '16.5px', color: SK_MUTED6, whiteSpace: 'nowrap' }}>
        {c.ver}
        <span style={{ width: 1.8, height: 1.8, borderRadius: 9999, background: 'rgb(224, 224, 224)' }} />
        Deep Student
      </span>
      <span style={{ ...at(x + 15, y + 55.5), width: 261, fontSize: 11, lineHeight: '17.875px', color: 'rgba(101, 105, 114, 0.8)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.desc}</span>
      <span style={{ ...at(x + 15, lineY), width: 261, height: 1, background: SK_LINE }} />
      <Chip x={x + 15} y={r1} icon={<Package size={10} />} text="内置" />
      {c.deps !== undefined ? <Chip x={x + 72.5} y={r1} icon={<LinkSimple size={10} />} text={`${c.deps} 依赖`} /> : null}
      {c.tools !== undefined ? <Chip x={two ? x + 15 : x + 72.5} y={two ? b - 34.9 : r1} icon={<Wrench size={10} />} text={String(c.tools)} /> : null}
      <span style={{ ...at(x + 178.5, mid), width: 34.5, height: 20, fontSize: 11, fontWeight: 500, lineHeight: '20px', textAlign: 'center', color: SK_MUTED6 }}>停用</span>
      <Pencil size={14} color={SK_MUTED6} style={at(x + 223.5, mid + 3)} />
      <DotsThree size={14} color={SK_MUTED6} style={at(x + 255, mid + 3)} />
    </>
  );
};

/** 打开即是完整列表（卡片没有入场动画，framer-motion 只用于编辑器的 layoutId 过渡）。 */
export const SkillsWindow = () => (
  <div style={{ position: 'absolute', inset: 0, background: '#fff', fontFamily: font.ui, color: FG }}>
    <span style={{ ...at(36, 46.8), width: 280, height: 28, borderRadius: 12, background: 'rgb(240, 240, 240)' }} />
    <MagnifyingGlass size={14} color="rgba(101, 105, 114, 0.7)" style={at(46, 53.8)} />
    <T x={67} y={51.8} size={12} lh={18} color="rgba(101, 105, 114, 0.7)">
      搜索技能...
    </T>
    <span style={{ ...at(326.5, 46), width: 164.9, height: 29.5, borderRadius: 12, background: 'rgb(240, 240, 240)' }} />
    <span style={{ ...at(329.5, 49), width: 78.8, height: 23.5, borderRadius: 10, background: 'rgb(253, 253, 253)', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)' }} />
    <Lightning size={12} color={FG} style={at(339, 54.8)} />
    <T x={356.3} y={52.5} size={11} weight={500} lh={16.5}>
      全部
    </T>
    <T x={386} y={53.3} size={10} weight={700} lh={15}>
      56
    </T>
    <Package size={12} color={FG} style={at(419.5, 54.8)} />
    <T x={437} y={52.5} size={11} weight={500} lh={16.5}>
      内置
    </T>
    <T x={466.8} y={53.3} size={10} weight={500} lh={15}>
      56
    </T>
    <span style={{ ...at(1, 83.5), width: 978, height: 1, background: SK_LINE }} />
    {SKILL_ROWS.map((row) => row.cards.map((c, i) => <SkillCardView key={c.name} x={SKILL_COL_X[i]} y={row.y} h={row.h} c={c} />))}
  </div>
);

// ── MCP（对话里调用外部 MCP 服务器的工具） ──────────────────
/**
 * 取证 probe-ymq-3 / ymq-8：连接器里选了 zotero 服务器后提问，工具行显示「服务器 id · 可读工具名」
 * （toolDisplayName.getExternalToolDisplayName：_serverId + humanizeToolName('mcp_zotero_search_items')）。
 */
export const MCP_Q = '在我的 Zotero 文献库里找找讲中值定理的资料';
export const MCP_TITLE = 'Zotero 文献';
const MCP_P: Seg[][] = [['在你的 Zotero 文献库里找到 2 条和中值定理相关的条目：笔记《中值定理证明套路》'], ['和论文 ', { em: 'Rolle and Lagrange revisited' }, '。']];

export const mcpTL = (a0: number) => {
  const tool = a0 + 0.08;
  const toolDone = tool + 0.909 / PACE;
  const p = toolDone + 0.04;
  const done = p + 0.36;
  return { tool, toolDone, p, done, title: done + 0.12 };
};

export const McpChat = ({ t, at: a0 }: { t: number; at: number }) => {
  const tl = mcpTL(a0);
  const streaming = t >= tl.tool && t < tl.done;
  const lines = streamLines(MCP_P, clamp((t - tl.p) / (tl.done - tl.p)));
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', fontFamily: font.ui, color: FG }}>
      <ChatSidebar rows={youSidebar('mcp', { title: t >= tl.title ? MCP_TITLE : '未命名会话', time: '刚刚', active: true, streaming })} t={t} />
      <UserBubble y={60} text={MCP_Q} time={YOU_CLOCK.mcp} />
      {t >= tl.tool ? <ToolRow y={172.4} label="zotero · Zotero Search Items" w={228} icon={MagnifyingGlass} done={t >= tl.toolDone} ms="909ms" /> : null}
      {lines.map((row, j) => (
        <T key={j} x={368} y={208.9 + j * LH} size={16} lh={LH}>
          {row}
        </T>
      ))}
      {t >= tl.done ? <AssistantFooter y={208.9 + MCP_P.length * LH + 23.1} time={YOU_CLOCK.mcp} /> : null}
      <DockComposer text="" caret={false} mode={streaming ? 'stop' : 'idle'} press={0} />
    </div>
  );
};

// ── 多模型并排（对话窗口里的并行变体 ParallelVariantView） ──────────
/** 片中这段的会话时刻：接在 08（20:05）之后，记忆 → MCP → 多模型各隔两分钟。 */
export const YOU_CLOCK = { memory: '20:12', mcp: '20:14', models: '20:16' } as const;
export const MODELS_Q = '用一句话讲清拉格朗日中值定理的几何意义';
export const MODELS_TITLE = '中值定理的几何意义';

/** 侧栏「对话」：09 三场新会话依次顶到最上面，下面是 08 的调研与第一幕那场。 */
export const youSidebar = (scene: 'memory' | 'mcp' | 'models', head: SidebarRow): SidebarRow[] => {
  const older: SidebarRow[] =
    scene === 'memory'
      ? [{ title: '大模型辅助数学证明', time: '7分钟前' }]
      : scene === 'mcp'
        ? [{ title: '拉格朗日中值定理', time: '2分钟前' }, { title: '大模型辅助数学证明', time: '9分钟前' }]
        : [{ title: 'Zotero 文献', time: '2分钟前' }, { title: '拉格朗日中值定理', time: '4分钟前' }, { title: '大模型辅助数学证明', time: '11分钟前' }];
  return [head, ...older, { title: '讲透拉格朗日中值定理', time: '23小时前' }, { title: '线性代数：特征值的直觉', time: '2天前' }, { title: '英语作文批改 · Task 2', time: '3天前' }];
};

/** ProviderIcon 单色图标：deepseek / zhipu 走 lobeIconData，moonshot 走 Lobe KimiMono。 */
const KIMI_PATHS = [
  'M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z',
  'M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z',
];
type Brand = 'deepseek' | 'zhipu' | 'moonshot';
const ProviderGlyph = ({ brand, x, y, size }: { brand: Brand; x: number; y: number; size: number }) => {
  if (brand === 'moonshot') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={FG} fillRule="evenodd" style={at(x, y)}>
        {KIMI_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  }
  const data = lobeIconData[brand];
  return (
    <svg width={size} height={size} viewBox={data.v} style={at(x, y)}>
      {data.p.map((d, i) => (
        <path key={i} d={d} fill={data.f[i] || data.f[0] || FG} />
      ))}
    </svg>
  );
};

/** 三张变体卡（取证 probe-ymm-3：卡宽 240.7、间距 14，换行与真机一致）。 */
const VARIANTS: Array<{ id: string; brand: Brand; x: number; dur: number; lines: string[] }> = [
  { id: 'deepseek-v4', brand: 'deepseek', x: 301, dur: 0.6, lines: ['可以把它看成罗尔定理的「倾', '斜版」：把弦拉平就是罗尔定', '理。光滑曲线上总有一点的切', '线平行于连接两端点的弦，而', '且这一点只保证存在、落在开', '区间 (a, b) 内。'] },
  { id: 'glm-5', brand: 'zhipu', x: 555.7, dur: 0.68, lines: ['几何上看，拉格朗日中值定理', '说的是：光滑曲线上，总有一', '点的切线平行于连接两端点的', '弦。它把「平均变化率」和某', '一点的「瞬时变化率」联系了', '起来。'] },
  { id: 'kimi-k3', brand: 'moonshot', x: 810.3, dur: 0.52, lines: ['把 (f(b) − f(a)) / (b − a) 看成', '弦的斜率，定理断言存在 ξ ∈', '(a, b)，使 f′(ξ) 恰好等于这个', '斜率——平均速度总会在某一', '时刻被瞬时速度精确达到。'] },
];
const CARD_W = 240.7;
const CARD_Y = 207.4;
const LH = 27.52;
const variantAt = (at: number, i: number) => at + 0.02 + i * 0.03;
export const modelsDoneAt = (at: number) => Math.max(...VARIANTS.map((v, i) => variantAt(at, i) + v.dur));

const CardBtn = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <span style={{ ...at(x, y), width: 16, height: 16, display: 'inline-flex', color: MUTED }}>{children}</span>;

/** at = 发出后第一帧（脚本秒）：三张卡同时起流，各自写完后页脚从「复制 / 取消」换成「复制 / 删除 / ⋯」，卡片随最长的那张一起长高。 */
export const ModelsChat = ({ t, at: a0 }: { t: number; at: number }) => {
  const st = VARIANTS.map((v, i) => {
    const p = clamp((t - variantAt(a0, i)) / v.dur);
    const total = v.lines.reduce((s, l) => s + [...l].length, 0);
    let left = Math.round(total * p);
    const shown: string[] = [];
    for (const l of v.lines) {
      if (left <= 0) break;
      const cs = [...l];
      shown.push(cs.slice(0, left).join(''));
      left -= cs.length;
    }
    return { p, shown, done: p >= 1 };
  });
  const streaming = st.some((s) => !s.done);
  const area = Math.max(...st.map((s) => Math.max(100, 44.2 + s.shown.length * LH)));
  const cardH = 103.5 + area;
  const bottom = CARD_Y + cardH;
  const titled = t >= modelsDoneAt(a0) + 0.12;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', fontFamily: font.ui, color: FG }}>
      <ChatSidebar rows={youSidebar('models', { title: titled ? MODELS_TITLE : '未命名会话', time: '刚刚', active: true, streaming })} t={t} />
      <UserBubble y={60} text={MODELS_Q} time={YOU_CLOCK.models} />
      <CaretLeft size={16} color="rgba(101, 105, 114, 0.2)" style={at(613.5, 177.4)} />
      <span style={{ ...at(640, 180.4), width: 24, height: 10, borderRadius: 9999, background: PRI }} />
      <span style={{ ...at(678, 180.4), width: 10, height: 10, borderRadius: 9999, background: 'rgba(101, 105, 114, 0.3)' }} />
      <span style={{ ...at(702, 180.4), width: 10, height: 10, borderRadius: 9999, background: 'rgba(101, 105, 114, 0.3)' }} />
      <CaretRight size={16} color={MUTED} style={at(722.5, 177.4)} />
      {VARIANTS.map((v, i) => {
        const s = st[i];
        const border = !s.done ? 'rgba(30, 94, 184, 0.3)' : i === 0 ? 'rgba(30, 94, 184, 0.5)' : 'rgb(224, 224, 224)';
        const footY = bottom - 44;
        return (
          <div key={v.id}>
            <span style={{ ...at(v.x, CARD_Y), width: CARD_W, height: cardH, boxSizing: 'border-box', borderRadius: 10.5, border: `1px solid ${border}`, background: 'rgb(252, 252, 252)' }} />
            <ProviderGlyph brand={v.brand} x={v.x + 15} y={222.1} size={28} />
            <T x={v.x + 51.8} y={218.9} size={12} weight={500} lh={18}>
              {v.id}
            </T>
            <T x={v.x + 51.8} y={236.9} size={11} lh={16.5} color={MUTED}>
              10/03 {YOU_CLOCK.models}
            </T>
            <span style={{ ...at(v.x + 1, 265.9), width: CARD_W - 2, height: 1, background: LINE_SOFT }} />
            {s.shown.length === 0 ? (
              <>
                <span style={{ ...at(v.x + 17, 284), width: 8, height: 16, background: PRI, opacity: 0.5 + 0.5 * Math.cos(t * PACE * Math.PI) }} />
                <T x={v.x + 33} y={282} size={14} lh={20} color={MUTED}>
                  生成中...
                </T>
              </>
            ) : (
              s.shown.map((l, j) => (
                <T key={j} x={v.x + 15} y={288 + j * LH} size={16} lh={LH}>
                  {l}
                </T>
              ))
            )}
            <span style={{ ...at(v.x + 1, footY), width: CARD_W - 2, height: 43, boxSizing: 'border-box', borderTop: `1px solid ${LINE_SOFT}`, background: 'rgba(240, 240, 240, 0.2)' }} />
            <CardBtn x={v.x + 17.5} y={footY + 14}>
              <Copy size={16} />
            </CardBtn>
            {s.done ? (
              <>
                <CardBtn x={v.x + 47.3} y={footY + 14}>
                  <Trash size={16} />
                </CardBtn>
                <CardBtn x={v.x + 77} y={footY + 14}>
                  <DotsThree size={16} weight="bold" />
                </CardBtn>
              </>
            ) : (
              <CardBtn x={v.x + 47.3} y={footY + 14}>
                <Square size={16} />
              </CardBtn>
            )}
          </div>
        );
      })}
      <CardBtn x={374} y={bottom + 23.5}>
        <Copy size={16} />
      </CardBtn>
      <CardBtn x={405.5} y={bottom + 23.5}>
        <GitBranch size={16} />
      </CardBtn>
      <span style={{ opacity: streaming ? 0.5 : 1 }}>
        <CardBtn x={437} y={bottom + 23.5}>
          <ArrowCounterClockwise size={16} />
        </CardBtn>
        <CardBtn x={468.5} y={bottom + 23.5}>
          <Trash size={16} />
        </CardBtn>
      </span>
      <T x={497.5} y={bottom + 24.9} size={11} lh={13.2} color="rgba(101, 105, 114, 0.5)">
        {YOU_CLOCK.models}
      </T>
      <DockComposer text="" caret={false} mode={streaming ? 'stop' : 'idle'} press={0} />
    </div>
  );
};

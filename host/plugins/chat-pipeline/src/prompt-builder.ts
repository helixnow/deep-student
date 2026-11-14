import { rustTrim } from '../../../platform/util/index.ts';
import { rustSplitWhitespace } from './text-compat.ts';
/**
 * chat_v2/prompt_builder.rs — system prompt construction.
 *
 * P1-10 prompt-cache layout: the stable system prefix contains only blocks whose
 * bytes never change inside a session (LaTeX rules, instructions, AGENTS.md,
 * user preferences, the fixed citation guide). Everything that can change turn
 * to turn (format hints, profiles, todos, retrieved context, canvas notes) is
 * returned separately as the turn-volatile block and injected into the current
 * user message.
 */
import type {
  MessageSources, SharedContext, SourceInfo,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';

const TICK3 = '```';

export const DEFAULT_SYSTEM_PROMPT =
  '你是一个专业的AI学习助手，帮助学生理解知识、解答问题、分析错题。请用清晰、准确的语言回答问题，必要时提供示例和解释。';

export const RESPONSE_LANGUAGE_RULE = String.raw`<response_language>
Reply in the language of the user's latest message: Chinese in, Chinese out; English in, English out. This covers everything the user reads — narration before and after tool calls, plans, ask_user questions and options, summaries, and content you write into apps (notes, mind maps, flashcards, explanations) — unless the user asks for another language or you are quoting source text.
回复语言跟随用户最新一条消息：中文提问用中文，英文提问用英文。
</response_language>`;

export const CITATION_GUIDE = String.raw`<citation_rules>
<description>引用格式规范，回答时必须遵守</description>
<format>
当引用上下文中的信息时，请使用 [来源类型-编号] 格式标注引用来源。
</format>
<source_types>
- [知识库-N]: 引用知识库/RAG检索中的内容
- [记忆-N]: 引用智能记忆中的内容
- [搜索-N]: 引用网络搜索结果
- [图片-N]: 引用多模态检索中的图片内容（仅当引用了图片来源时使用）
- [灵感-N]: 引用灵感卡内容（insight_recall 工具返回）
</source_types>
<rules>
1. 每个引用标记必须紧跟在引用内容之后，不要单独成行
2. 同一句话引用多个来源时，可连续标注如 [知识库-1][知识库-2]
3. 编号 N 从 1 开始，对应上下文中同类型来源的顺序
4. 只引用确实使用的来源，不要虚构引用
5. 引用标记会被渲染为可点击的链接，用户可以快速查看原文
6. 禁止在回复末尾生成"参考文献"、"来源汇总"、"相关论文"等表格或列表，系统会自动展示来源面板
7. 如需在引用处显示图片缩略图，可使用 [知识库-N:图片] 或 [图片-N:图片] 格式
</rules>
<examples>
正确：根据牛顿第二定律 F=ma [知识库-1]，力与加速度成正比。
正确：这个概念在你之前的笔记中也提到过 [记忆-1]。
正确：如图所示 [图片-1]，函数在 x=0 处不连续。
正确：根据教材中的图示 [知识库-2:图片]，力的方向如下。
错误：[知识库-1] 根据牛顿第二定律...（标记不应在句首）
错误：根据资料显示...（缺少引用标记）
</examples>
</citation_rules>`;

/** Cross-link single source: dstu-core/src/prompt_contracts.rs::LATEX_RULES. */
export const LATEX_RULES = String.raw`<latex_rules version="1" priority="highest">
<description>数学公式输出规范，必须严格遵守</description>
<rules>
1. 任何数学表达式必须使用 $...$ (行内) 或 $$...$$ (块级) 包裹，分隔符必须成对闭合。
2. 禁止裸露 LaTeX：不得出现未被 $ 或 $$ 包裹的 \frac、\sqrt、\int、\sum、\lim、上下标 ^/_ 等。
3. 严禁用任何形式的 Markdown 代码块（三反引号）包裹数学内容，包括 ${TICK3}math、${TICK3}latex 等，全部改用 $/$$ 直接输出。
4. 禁止使用 \(...\) 与 \[...\] 作为分隔符。
5. 多行/展示型公式须使用 $$ 并独立成段，起止各占一行；行内使用单 $ 且不跨段落。
6. 仅使用 KaTeX 支持的命令；多字符上下标需加花括号；中文/非 ASCII 请置于 \text{...}；矩阵使用 bmatrix 环境。
7. \boxed{} 命令必须用 $...$ 包裹：正确格式为 $\boxed{C}$，禁止使用 [\boxed{C}] 等未包裹格式。
</rules>
<examples type="correct">
- 行内：$\lim_{x\to 0}\frac{\sin(ax)-\sin(bx)}{x}=a-b$
- 块级：
$$
\int_0^1 x^2\,\mathrm{d}x = \tfrac{1}{3}
$$
</examples>
<examples type="incorrect">
- \lim_{x\to 0} \frac{\sin x}{x} （未包裹）
- \( \int_a^b f(x)\,\mathrm{d}x \) （错误分隔符）
- ${TICK3}math ... ${TICK3} （代码块包裹，禁止！）
</examples>
<self_check>
发送前自检：若检测到数学符号未在 $ 或 $$ 内，请重写并补齐分隔符后再发送。
</self_check>
</latex_rules>`;

export const CHEMISTRY_RENDERING_RULES = String.raw`<chemistry_rendering_rules priority="high">
<description>化学内容的表达规范</description>
<rules>
1. 化学式、离子式、反应方程式使用 mhchem：行内写 $\ce{...}$，展示式写 $$\ce{...}$$。
2. 需要展示分子骨架、环系、键线式或立体结构时，使用 \smiles{标准 SMILES}；它会在正文中渲染为内联结构图。
3. \smiles{...} 不是 LaTeX：不得放进 $...$、$$...$$、反引号或代码块；把它直接嵌入自然语言句子。
4. 只在结构本身有助于理解时使用；不要向用户解释内部渲染语法，除非用户询问。
</rules>
<examples>
- 苯的分子式是 $\ce{C6H6}$，结构为 \smiles{c1ccccc1}。
- 乙醇可写作 $\ce{C2H5OH}$，其骨架为 \smiles{CCO}。
</examples>
</chemistry_rendering_rules>`;

/** Setting key persisted by the frontend capability toggles. */
export const RENDERER_CAPABILITIES_SETTING_KEY = 'chat.renderer_capabilities';

export interface RendererCapabilities {
  chemicalStructures: boolean;
  charts: boolean;
  graphviz: boolean;
  music: boolean;
  timing: boolean;
  chemicalFiles: boolean;
  molecular3d: boolean;
  geojson: boolean;
}

export const DEFAULT_RENDERER_CAPABILITIES: RendererCapabilities = Object.freeze({
  chemicalStructures: true,
  charts: false,
  graphviz: false,
  music: false,
  timing: false,
  chemicalFiles: false,
  molecular3d: false,
  geojson: false,
});

/**
 * Missing/legacy setting falls back to defaults. A malformed value must never
 * block a conversation: the setting only affects how output is expressed.
 */
export function parseRendererCapabilities(raw?: string | null): RendererCapabilities {
  if (raw === undefined || raw === null) return { ...DEFAULT_RENDERER_CAPABILITIES };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_RENDERER_CAPABILITIES };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_RENDERER_CAPABILITIES };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_RENDERER_CAPABILITIES) as Array<keyof RendererCapabilities>;
  // serde rejects the whole document when a present field has the wrong type.
  for (const key of keys) {
    if (key in record && typeof record[key] !== 'boolean') {
      return { ...DEFAULT_RENDERER_CAPABILITIES };
    }
  }
  const parsed = { ...DEFAULT_RENDERER_CAPABILITIES };
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'boolean') parsed[key] = candidate;
  }
  return parsed;
}

const CHART_RENDERING_RULES = String.raw`<chart_rendering_rules priority="high">
<rules>需要数据图表时，使用 ${TICK3}vega-lite 代码块输出自包含 Vega-Lite JSON。数据直接写在 data.values；不要使用 data.url、远程图片或外部脚本。只在图表能更清楚表达比较、趋势或分布时使用。</rules>
</chart_rendering_rules>`;

const GRAPHVIZ_RENDERING_RULES = String.raw`<graphviz_rendering_rules priority="high">
<rules>需要流程图、关系图或有向图时，使用 ${TICK3}dot 代码块输出 Graphviz DOT。图内文字直接写入，不要引用 image、href 或任何外部资源。</rules>
</graphviz_rendering_rules>`;

const MUSIC_RENDERING_RULES = String.raw`<music_rendering_rules priority="high">
<rules>需要五线谱或简短旋律时，使用 ${TICK3}abc 代码块输出标准 ABC notation；包含 X:、T:、M:、L:、K: 等必要头字段。不要为普通文本说明强行生成乐谱。</rules>
</music_rendering_rules>`;

const TIMING_RENDERING_RULES = String.raw`<timing_rendering_rules priority="high">
<rules>需要时序图、数字波形或协议时序时，使用 ${TICK3}wavedrom 代码块输出 WaveJSON 对象。内容必须自包含，不要使用外链或脚本。</rules>
</timing_rendering_rules>`;

const CHEMICAL_FILE_RENDERING_RULES = String.raw`<chemical_file_rendering_rules priority="high">
<rules>用户提供或要求展示 Molfile/SDF 分子文件时，使用 ${TICK3}mol 或 ${TICK3}sdf 代码块原样输出有效文件内容。它们用于二维分子结构，不要把它们塞进 LaTeX。</rules>
</chemical_file_rendering_rules>`;

const MOLECULAR_3D_RENDERING_RULES = String.raw`<molecular_3d_rendering_rules priority="high">
<rules>需要可旋转的三维蛋白质或分子结构时，使用 ${TICK3}pdb 代码块输出自包含 PDB 文本。不要使用下载链接、远程结构 ID 或外部脚本。</rules>
</molecular_3d_rendering_rules>`;

const GEOJSON_RENDERING_RULES = String.raw`<geojson_rendering_rules priority="high">
<rules>需要展示地理边界、路线或点位且数据已知时，使用 ${TICK3}geojson 代码块输出自包含 GeoJSON Feature 或 FeatureCollection。不要使用地图瓦片、URL 或外部资源。</rules>
</geojson_rendering_rules>`;

export function enabledRendererRules(capabilities: RendererCapabilities): string[] {
  const rules: string[] = [];
  if (capabilities.chemicalStructures) rules.push(CHEMISTRY_RENDERING_RULES);
  if (capabilities.charts) rules.push(CHART_RENDERING_RULES);
  if (capabilities.graphviz) rules.push(GRAPHVIZ_RENDERING_RULES);
  if (capabilities.music) rules.push(MUSIC_RENDERING_RULES);
  if (capabilities.timing) rules.push(TIMING_RENDERING_RULES);
  if (capabilities.chemicalFiles) rules.push(CHEMICAL_FILE_RENDERING_RULES);
  if (capabilities.molecular3d) rules.push(MOLECULAR_3D_RENDERING_RULES);
  if (capabilities.geojson) rules.push(GEOJSON_RENDERING_RULES);
  return rules;
}

const MAX_RAG_ITEMS = 5;
const MAX_MEMORY_ITEMS = 3;
const MAX_WEB_ITEMS = 5;

/** Per-item content cap (characters). */
const MAX_SINGLE_SOURCE_CHARS = 1_500;
const MAX_RAG_TOTAL_CHARS = 6_000;
const MAX_MEMORY_TOTAL_CHARS = 3_000;
const MAX_WEB_TOTAL_CHARS = 4_000;

const charCount = (text: string): number => [...text].length;
const takeChars = (text: string, count: number): string => [...text].slice(0, count).join('');

/** Escape XML text content: & < > become entities. */
export function escapeXmlContent(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export type SourceType = 'knowledge_base' | 'memory' | 'web_search';

export function sourceTypeLabel(sourceType: SourceType): string {
  switch (sourceType) {
    case 'knowledge_base': return '知识库';
    case 'memory': return '记忆';
    case 'web_search': return '搜索';
  }
}

export function sourceTypeXmlTag(sourceType: SourceType): string {
  switch (sourceType) {
    case 'knowledge_base': return 'knowledge_base';
    case 'memory': return 'memory';
    case 'web_search': return 'web_search';
  }
}

/** Keep `maxChars` characters and append the truncation marker. */
export function truncateContent(content: string, maxChars: number): string {
  return charCount(content) <= maxChars
    ? content
    : `${takeChars(content, maxChars)}…（已截断）`;
}

/** `[类型-编号] 内容` — external content is XML escaped. */
export function formatSourceItem(sourceType: SourceType, index: number, content: string): string {
  return `[${sourceTypeLabel(sourceType)}-${index + 1}] ${escapeXmlContent(content)}`;
}

/** Web search items carry a title and a snippet; both are external content. */
export function formatWebSearchItem(index: number, title?: string | null,
  snippet?: string | null): string | null {
  const label = sourceTypeLabel('web_search');
  if (title !== undefined && title !== null && snippet !== undefined && snippet !== null) {
    return `[${label}-${index + 1}] 标题: ${escapeXmlContent(title)}\n摘要: ${escapeXmlContent(snippet)}`;
  }
  if (title !== undefined && title !== null) {
    return `[${label}-${index + 1}] ${escapeXmlContent(title)}`;
  }
  if (snippet !== undefined && snippet !== null) {
    return `[${label}-${index + 1}] ${escapeXmlContent(snippet)}`;
  }
  return null;
}

/**
 * Formats sources as one XML block, bounded by both item count and total
 * characters (whichever trips first).
 */
export function formatSourcesAsXml(sources: readonly SourceInfo[], sourceType: SourceType,
  maxItems: number, maxTotalChars: number): string | null {
  const items: string[] = [];
  let totalChars = 0;

  for (const source of sources) {
    const content = source.snippet ?? source.title;
    if (content === undefined || content === null) continue;
    if (items.length >= maxItems) break;

    const truncated = truncateContent(content, MAX_SINGLE_SOURCE_CHARS);
    const item = formatSourceItem(sourceType, items.length, truncated);
    const itemChars = charCount(item);
    if (items.length > 0 && totalChars + itemChars > maxTotalChars) break;
    totalChars += itemChars;
    items.push(item);
  }

  if (items.length === 0) return null;
  const tag = sourceTypeXmlTag(sourceType);
  return `<${tag}>\n${items.join('\n')}\n</${tag}>`;
}

/** Web search block: items separated by blank lines. */
export function formatWebSearchAsXml(sources: readonly SourceInfo[], maxItems: number,
  maxTotalChars: number): string | null {
  const items: string[] = [];
  let totalChars = 0;

  const limit = Math.min(sources.length, maxItems);
  for (let index = 0; index < limit; index++) {
    const source = sources[index]!;
    const snippet = source.snippet === undefined || source.snippet === null
      ? null
      : truncateContent(source.snippet, MAX_SINGLE_SOURCE_CHARS);
    const item = formatWebSearchItem(index, source.title, snippet);
    if (item === null) continue;

    const itemChars = charCount(item);
    if (items.length > 0 && totalChars + itemChars > maxTotalChars) break;
    totalChars += itemChars;
    items.push(item);
  }

  if (items.length === 0) return null;
  const tag = sourceTypeXmlTag('web_search');
  return `<${tag}>\n${items.join('\n\n')}\n</${tag}>`;
}

/** Long notes only inject a summary; short notes are injected in full. */
const LONG_NOTE_THRESHOLD = 3_000;

export class CanvasNoteInfo {
  readonly noteId: string;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;

  constructor(noteId: string, title: string, content: string) {
    this.noteId = noteId;
    this.title = title;
    this.content = content;
    this.wordCount = charCount(content);
  }

  isLongNote(): boolean {
    return this.wordCount >= LONG_NOTE_THRESHOLD;
  }

  /** Markdown headings, in order, trimmed. */
  parseStructure(): string[] {
    return rustLines(this.content)
      .filter(line => line.startsWith('#'))
      .map(line => rustTrim(line));
  }

  /** Body without headings/code fences, whitespace collapsed, then clipped. */
  generateSummary(maxLength: number): string {
    const text = rustSplitWhitespace(rustLines(this.content)
      .filter(line => !line.startsWith('#'))
      .filter(line => !line.startsWith('```'))
      .join(' ')).join(' ');
    return charCount(text) <= maxLength ? text : `${takeChars(text, maxLength)}...`;
  }
}

/** `str::lines`: split on \n, drop a trailing empty segment, strip trailing \r. */
function rustLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export interface SystemPromptParts {
  /** Byte-stable system prefix across turns of one session. */
  stableSystem: string;
  /** Per-turn dynamic blocks; null when every dynamic input is absent. */
  turnVolatile: string | null;
}

export class PromptBuilder {
  private basePrompt: string;
  private contextBlocks: string[] = [];
  private userAppend: string | null = null;
  private canvasNote: CanvasNoteInfo | null = null;
  private contextTypeHints: string[] = [];
  private userProfile: string | null = null;
  private learnerProfile: string | null = null;
  private projectAgentsInstructions: string | null = null;
  private activeTodos: string | null = null;
  private activeGoal: string | null = null;
  private insightHints: string | null = null;
  private rendererCapabilities: RendererCapabilities = { ...DEFAULT_RENDERER_CAPABILITIES };
  private superAgentRouter: string | null = null;
  private superAgentRoster: string | null = null;

  constructor(systemPromptOverride?: string | null) {
    this.basePrompt = systemPromptOverride !== undefined && systemPromptOverride !== null
      && systemPromptOverride !== ''
      ? systemPromptOverride
      : DEFAULT_SYSTEM_PROMPT;
  }

  withActiveTodos(todos: string | null): this {
    this.activeTodos = todos;
    return this;
  }

  /** Callers pass plain text; the builder wraps and escapes `<active_goal>`. */
  withActiveGoal(goal: string | null): this {
    this.activeGoal = goal !== null && rustTrim(goal) !== '' ? goal : null;
    return this;
  }

  /** Callers pass one card title per line; the builder wraps and escapes. */
  withInsightHints(hints: string | null): this {
    this.insightHints = hints !== null && rustTrim(hints) !== '' ? hints : null;
    return this;
  }

  /**
   * Super-session sections arrive as complete, already-escaped XML blocks.
   * Router is session-stable (stable system); roster changes per turn.
   */
  withSuperAgentSections(router: string | null, roster: string | null): this {
    this.superAgentRouter = router !== null && rustTrim(router) !== '' ? router : null;
    this.superAgentRoster = roster !== null && rustTrim(roster) !== '' ? roster : null;
    return this;
  }

  withRendererCapabilities(capabilities: RendererCapabilities): this {
    this.rendererCapabilities = capabilities;
    return this;
  }

  withProjectAgentsInstructions(instructions: string | null): this {
    this.projectAgentsInstructions = instructions !== null && rustTrim(instructions) !== ''
      ? instructions
      : null;
    return this;
  }

  withCanvasNote(note: CanvasNoteInfo | null): this {
    this.canvasNote = note;
    return this;
  }

  withRagSources(sources?: readonly SourceInfo[] | null): this {
    if (sources !== undefined && sources !== null && sources.length > 0) {
      const block = formatSourcesAsXml(sources, 'knowledge_base', MAX_RAG_ITEMS, MAX_RAG_TOTAL_CHARS);
      if (block !== null) this.contextBlocks.push(block);
    }
    return this;
  }

  withMemorySources(sources?: readonly SourceInfo[] | null): this {
    if (sources !== undefined && sources !== null && sources.length > 0) {
      const block = formatSourcesAsXml(sources, 'memory', MAX_MEMORY_ITEMS, MAX_MEMORY_TOTAL_CHARS);
      if (block !== null) this.contextBlocks.push(block);
    }
    return this;
  }

  /** Injected on every turn; content is untrusted and XML escaped on render. */
  withUserProfile(profile: string | null): this {
    this.userProfile = profile;
    return this;
  }

  /** Curated long-term learner layer (already rendered as Markdown by the caller). */
  withLearnerProfile(profile: string | null): this {
    this.learnerProfile = profile;
    return this;
  }

  withWebSearchSources(sources?: readonly SourceInfo[] | null): this {
    if (sources !== undefined && sources !== null && sources.length > 0) {
      const block = formatWebSearchAsXml(sources, MAX_WEB_ITEMS, MAX_WEB_TOTAL_CHARS);
      if (block !== null) this.contextBlocks.push(block);
    }
    return this;
  }

  withUserAppend(append?: string | null): this {
    if (append !== undefined && append !== null && append !== '') {
      this.userAppend = append;
    }
    return this;
  }

  withMessageSources(sources: MessageSources): this {
    return this
      .withRagSources(sources.rag)
      .withMemorySources(sources.memory)
      .withWebSearchSources(sources.webSearch);
  }

  withSharedContext(context: SharedContext): this {
    return this
      .withRagSources(context.ragSources)
      .withMemorySources(context.memorySources)
      .withWebSearchSources(context.webSearchSources);
  }

  withOptions(options: SendOptions): this {
    return this
      .withUserAppend(options.systemPromptAppend)
      .withContextTypeHints(options.contextTypeHints);
  }

  withContextTypeHints(hints?: readonly string[] | null): this {
    if (hints !== undefined && hints !== null && hints.length > 0) {
      this.contextTypeHints = [...hints];
    }
    return this;
  }

  /**
   * Stable system prefix: LaTeX rules, enabled renderer contracts,
   * system_instructions, response-language rule, AGENTS.md, user preferences,
   * Super router, fixed citation guide. Ordered and byte-stable.
   */
  build(): string {
    const parts: string[] = [LATEX_RULES];
    parts.push(...enabledRendererRules(this.rendererCapabilities));
    parts.push(`<system_instructions>\n${this.basePrompt}\n</system_instructions>`);
    parts.push(RESPONSE_LANGUAGE_RULE);
    if (this.projectAgentsInstructions !== null) {
      parts.push('<project_agents_instructions>\n'
        + `${escapeXmlContent(this.projectAgentsInstructions)}\n</project_agents_instructions>`);
    }
    if (this.userAppend !== null) {
      parts.push(`<user_preferences>\n${this.userAppend}\n</user_preferences>`);
    }
    if (this.superAgentRouter !== null) parts.push(this.superAgentRouter);
    parts.push(CITATION_GUIDE);
    return parts.join('\n\n');
  }

  /** Per-turn blocks injected into the current user message. */
  buildTurnVolatileBlocks(): string | null {
    const parts: string[] = [];

    if (this.contextTypeHints.length > 0) {
      const hintsContent = this.contextTypeHints.join('\n');
      parts.push(`<user_message_format_guide>
用户消息的结构如下：
1. <user_query> - 用户的实际问题或请求（优先响应）
2. <injected_context> - 相关上下文信息，包含以下可能的子标签：
${hintsContent}

请优先理解并响应 <user_query> 中的内容，<injected_context> 中的信息仅供参考。
</user_message_format_guide>`);
    }

    if (this.userProfile !== null) {
      parts.push('<user_profile>\n以下是关于当前用户的已知信息，请在回答中自然地运用这些背景：\n'
        + `${escapeXmlContent(this.userProfile)}\n</user_profile>`);
    }

    if (this.learnerProfile !== null) {
      parts.push('<learner_profile>\n以下是该学习者的长期画像（薄弱知识点/学习偏好/学习目标/近期状态）。请据此调整讲解方式与难度，主动关照薄弱环节；画像可用 learner_profile_update 工具增量更新：\n'
        + `${escapeXmlContent(this.learnerProfile)}\n</learner_profile>`);
    }

    if (this.activeTodos !== null) {
      parts.push('<active_todos>\n以下是用户当前的待办事项，请在相关时自然提及或协助管理：\n'
        + `${escapeXmlContent(this.activeTodos)}\n</active_todos>`);
    }

    if (this.activeGoal !== null) {
      parts.push('<active_goal>\n当前会话有一个进行中的目标（用户设定，跨轮次持续存在）：\n'
        + `${escapeXmlContent(this.activeGoal)}\n`
        + '用户的插话与目标推进应服务于该目标。需要用户回答才能继续时，调用 goal_update(status="waiting_user")；确证目标完成后调用 goal_update(status="complete")。\n'
        + '</active_goal>');
    }

    if (this.superAgentRoster !== null) parts.push(this.superAgentRoster);

    if (this.insightHints !== null) {
      parts.push('<insight_hints>\n该用户曾在以下相似情境中卡住并总结过方法（只显示标题）。若与当前问题相关，可调用 insight_recall 工具逐步唤起用户自己的方法，而不是直接给答案：\n'
        + `${escapeXmlContent(this.insightHints)}\n</insight_hints>`);
    }

    if (this.contextBlocks.length > 0) {
      parts.push(`<context>\n${this.contextBlocks.join('\n\n')}\n</context>`);
    }

    if (this.canvasNote !== null) {
      parts.push(this.renderCanvasNote(this.canvasNote));
    }

    return parts.length === 0 ? null : parts.join('\n\n');
  }

  /** One-shot split build: stable system plus turn-volatile blocks. */
  buildSplit(): SystemPromptParts {
    return { stableSystem: this.build(), turnVolatile: this.buildTurnVolatileBlocks() };
  }

  private renderCanvasNote(note: CanvasNoteInfo): string {
    const structure = note.parseStructure();
    const structureStr = structure.length === 0 ? '（无标题结构）' : structure.join('\n');

    const contentSection = note.isLongNote()
      ? `<note_summary>
${escapeXmlContent(note.generateSummary(500))}
</note_summary>
<note_hint>笔记较长（${note.wordCount}字），请使用 note_read 工具查看具体章节</note_hint>`
      : `<note_content>\n${escapeXmlContent(note.content)}\n</note_content>`;

    return `<canvas_note>
<note_meta>
  <title>${escapeXmlContent(note.title)}</title>
  <note_id>${escapeXmlContent(note.noteId)}</note_id>
  <word_count>${note.wordCount}</word_count>
  <structure>
${escapeXmlContent(structureStr)}
  </structure>
</note_meta>
${contentSection}
<available_tools>
你可以使用以下工具来操作这个笔记：
- note_read: 读取笔记内容（可指定 section 参数）
- note_append: 追加内容（可指定 section 参数）
- note_replace: 替换内容（支持 search/replace/isRegex 参数）
- note_set: 设置完整内容（谨慎使用）
</available_tools>
<behavior_rules>
- 修改笔记时，使用工具调用而非直接输出内容
- 大段修改前，先用 note_read 确认当前内容
- 每次修改后，简要说明做了什么改动
</behavior_rules>
</canvas_note>`;
  }
}

export function buildSystemPrompt(options: SendOptions, sources: MessageSources,
  canvasNote: CanvasNoteInfo | null): SystemPromptParts {
  return new PromptBuilder(options.systemPromptOverride)
    .withMessageSources(sources)
    .withOptions(options)
    .withCanvasNote(canvasNote)
    .buildSplit();
}

export interface ProfilePromptInput {
  options: SendOptions;
  sources: MessageSources;
  canvasNote: CanvasNoteInfo | null;
  userProfile: string | null;
  /** Loaded by the caller (L17 memory service owns profile persistence). */
  learnerProfile?: string | null;
  projectAgentsInstructions?: string | null;
  activeGoal?: string | null;
  insightHints?: string | null;
  rendererCapabilities?: RendererCapabilities;
  superAgentRouter?: string | null;
  superAgentRoster?: string | null;
}

/** Full pipeline composition used by `build_system_prompt_with_profile_and_agents`. */
export function buildSystemPromptWithProfileAndAgents(input: ProfilePromptInput): SystemPromptParts {
  return new PromptBuilder(input.options.systemPromptOverride)
    .withMessageSources(input.sources)
    .withOptions(input.options)
    .withCanvasNote(input.canvasNote)
    .withUserProfile(input.userProfile)
    .withLearnerProfile(input.learnerProfile ?? null)
    .withProjectAgentsInstructions(input.projectAgentsInstructions ?? null)
    .withActiveGoal(input.activeGoal ?? null)
    .withInsightHints(input.insightHints ?? null)
    .withRendererCapabilities(input.rendererCapabilities ?? { ...DEFAULT_RENDERER_CAPABILITIES })
    .withSuperAgentSections(input.superAgentRouter ?? null, input.superAgentRoster ?? null)
    .buildSplit();
}

export function buildSystemPromptWithSharedContext(options: SendOptions,
  sharedContext: SharedContext, canvasNote: CanvasNoteInfo | null): SystemPromptParts {
  return new PromptBuilder(options.systemPromptOverride)
    .withSharedContext(sharedContext)
    .withOptions(options)
    .withCanvasNote(canvasNote)
    .buildSplit();
}

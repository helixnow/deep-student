/**
 * HPIAS research service/retrieval/synthesis pure layers — TS mirror of
 * `dstu-research/src/hpias/{service,retrieval_backend,synthesis}.rs`.
 *
 * Network, VFS and LLM calls stay outside this module; only the deterministic
 * pieces (backend selection, query resolution, summaries, prompt building) live
 * here so they can be verified without a model.
 */
import { extractPlanQueriesFromIntent, intentHasResearchBlocks } from './hpias-payloads.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';

export type HpiasBackendKind = 'disabled' | 'stub' | 'retrieval';

/** Rust `HpiasBackendKind::from_config`: unknown/blank values fail closed. */
export function backendKindFromConfig(configured: string | null | undefined,
  warn?: (message: string) => void): HpiasBackendKind {
  const normalized = rustTrim(configured ?? '').replace(/[A-Z]/g, char => char.toLowerCase());
  if (normalized === '' || normalized === 'disabled' || normalized === 'off') return 'disabled';
  if (normalized === 'stub') return 'stub';
  if (normalized === 'retrieval') return 'retrieval';
  warn?.(`[HpiasResearchService] Unknown DEEP_STUDENT_HPIAS_BACKEND=${JSON.stringify(normalized)}; pipeline disabled`);
  return 'disabled';
}

export interface HpiasResearchDeps {
  vfsDb?: unknown;
  vfsLanceStore?: unknown;
  llmManager?: unknown;
}

/** Rust `HpiasResearchDeps::can_run_retrieval` (lance store may be created on demand). */
export function canRunRetrieval(deps: HpiasResearchDeps): boolean {
  return deps.vfsDb !== undefined && deps.vfsDb !== null
    && deps.llmManager !== undefined && deps.llmManager !== null;
}

export interface HpiasResearchSessionRequest {
  sessionId: string;
  question: string | null;
  intent: unknown;
}

/** Rust `StubHpiasResearchService::start_research_session` gate. */
export function shouldStartResearchSession(intent: unknown): boolean {
  return intentHasResearchBlocks(intent);
}

/** Rust `RetrievalHpiasResearchService::resolve_queries`. */
export function resolveResearchQueries(question: string | null | undefined,
  intent: unknown): string[] {
  const fromIntent = extractPlanQueriesFromIntent(intent);
  if (fromIntent.length > 0) return fromIntent;
  const trimmed = question == null ? undefined : rustTrim(question);
  if (trimmed !== undefined && trimmed.length > 0) return [trimmed];
  return ['research query'];
}

export interface HpiasRetrievalHit {
  title?: string | null;
  text: string;
  sourceId?: string | null;
}
export interface HpiasFusedHit {
  hit: HpiasRetrievalHit;
}

function takeChars(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('');
}

/** Rust `summarize_hits_for_subagent`（top hit 标题 + 240 字片段）。 */
export function summarizeHitsForSubagent(hits: readonly HpiasFusedHit[]): string {
  const top = hits[0];
  if (top === undefined) return '未检索到相关内容。';
  const title = top.hit.title !== null && top.hit.title !== undefined && top.hit.title !== ''
    ? top.hit.title : '检索结果';
  const snippet = takeChars(top.hit.text, 240);
  return snippet.length === 0 ? `${title}（无文本片段）` : `${title}：${snippet}…`;
}

/** Rust `build_synthesis_markdown`（确定性拼接，不调用 LLM）。 */
export function buildSynthesisMarkdown(question: string | null | undefined,
  perQuery: readonly (readonly [string, readonly HpiasFusedHit[]])[]): string {
  const heading = question !== null && question !== undefined && question !== ''
    ? question : '研究主题';
  let markdown = `## 综合结论\n\n关于 **${heading}** 的检索摘要：\n\n`;
  for (const [query, hits] of perQuery) {
    markdown += `### ${query}\n\n`;
    if (hits.length === 0) {
      markdown += '_未找到相关内容_\n\n';
      continue;
    }
    for (const [index, fused] of hits.slice(0, 3).entries()) {
      const title = fused.hit.title ?? '来源';
      const snippet = takeChars(fused.hit.text, 320);
      markdown += `${index + 1}. **${title}** — ${snippet}…\n\n`;
    }
  }
  return markdown;
}

const MAX_CONTEXT_BYTES = 12_000;
const MAX_SNIPPET_CHARS = 480;

function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let cut = 0;
  for (const char of text) {
    const size = utf8ByteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    cut += char.length;
  }
  return text.slice(0, cut);
}

/** Rust `build_synthesis_llm_prompt`（证据上限 5 条/查询、480 字/片段）。 */
export function buildSynthesisLlmPrompt(question: string | null | undefined,
  perQuery: readonly (readonly [string, readonly HpiasFusedHit[]])[]): string {
  const topic = question !== null && question !== undefined && question !== ''
    ? question : '研究主题';
  let context = `研究问题：${topic}\n\n检索证据：\n`;
  for (const [query, hits] of perQuery) {
    context += `## 查询：${query}\n`;
    if (hits.length === 0) {
      context += '（无检索结果）\n\n';
      continue;
    }
    for (const [index, fused] of hits.slice(0, 5).entries()) {
      const title = fused.hit.title ?? '来源';
      const source = fused.hit.sourceId ?? 'unknown';
      const snippet = takeChars(fused.hit.text, MAX_SNIPPET_CHARS);
      context += `[${source}-${index + 1}] ${title} — ${snippet}\n`;
    }
    context += '\n';
  }
  if (utf8ByteLength(context) > MAX_CONTEXT_BYTES) {
    context = `${truncateUtf8(context, MAX_CONTEXT_BYTES)}\n…（上下文已截断）`;
  }
  return `你是一名研究助手。根据以下检索证据，撰写一份 Markdown 研究报告。

要求：
1. 使用与「研究问题」相同的语言（中文问题则中文回答）。
2. 以 \`## 综合结论\` 开头，随后按主题组织 \`###\` 小节。
3. 引用证据时使用 \`[来源-N]\` 格式（与上下文中的来源 id 对应）。
4. 只基于给定证据，不要编造未出现的事实。
5. 不要输出 JSON 或代码围栏，直接输出 Markdown 正文。

${context}

请输出研究报告 Markdown：`;
}

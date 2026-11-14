// Rust: chatanki_executor.rs:9125–9499 route planning and analyze projection.
import type { VfsContextRefData } from '../api.ts';
import {
  countEntryLikeLines, defaultMaxCardsForContent, glossaryGenerationKnobs,
  looksLikeGlossaryContent, suggestMaxCardsArg,
} from './generation-options.ts';
import { rustTrim } from '../../../platform/util/text.ts';

// ============================================================================
// Routing (chatanki_executor.rs:9125–9499)
// ============================================================================

export type ChatAnkiRoute = 'simple_text' | 'vlm_light' | 'vlm_full';

export const ROUTE_PLAN_MIN_CONFIDENCE = Math.fround(0.7);
export const ROUTE_PLAN_SAMPLE_TOTAL_CHARS = 1_200;
export const ROUTE_PLAN_SAMPLE_PER_REF_CHARS = 400;
export const ROUTE_PLAN_MAX_LISTED_REFS = 20;

export interface RoutePlan {
  route: ChatAnkiRoute;
  confidence: number;
  glossaryMode: boolean | null;
  reason: string | null;
}

export function routePlanIsConfident(plan: RoutePlan): boolean {
  return plan.confidence >= ROUTE_PLAN_MIN_CONFIDENCE;
}

export function routePlanToDebugJson(plan: RoutePlan): Record<string, unknown> {
  return {
    route: plan.route,
    confidence: plan.confidence,
    glossaryMode: plan.glossaryMode,
    reason: plan.reason,
    applied: routePlanIsConfident(plan),
  };
}

export type RouteSource = 'forced' | 'llm' | 'heuristic';

export interface RouteDecision {
  route: ChatAnkiRoute;
  source: RouteSource;
  confidence: number | null;
  glossaryModeHint: boolean | null;
  reason: string | null;
}

function countRouteRefs(refData: VfsContextRefData): { images: number; files: number } {
  let images = 0;
  let files = 0;
  for (const ref of refData.refs) {
    if (ref.type === 'image') images += 1;
    else if (ref.type === 'file') files += 1;
  }
  return { images, files };
}

export function decideRoute(refData: VfsContextRefData): ChatAnkiRoute {
  const { images, files } = countRouteRefs(refData);
  if (images === 0) return 'simple_text';
  if (files > 0 && images <= 3) return 'vlm_light';
  return 'vlm_full';
}

function heuristicRouteReason(refData: VfsContextRefData): string {
  const { images, files } = countRouteRefs(refData);
  return `启发式：引用共 ${refData.refs.length} 项（文件 ${files}，图片 ${images}）`;
}

export function resolveRouteDecision(
  forcedRoute: ChatAnkiRoute | null,
  llmPlan: RoutePlan | null,
  refData: VfsContextRefData,
): RouteDecision {
  if (forcedRoute !== null) {
    return {
      route: forcedRoute, source: 'forced', confidence: null, glossaryModeHint: null,
      reason: '调用方显式指定 route',
    };
  }
  if (llmPlan !== null && routePlanIsConfident(llmPlan)) {
    return {
      route: llmPlan.route, source: 'llm', confidence: llmPlan.confidence,
      glossaryModeHint: llmPlan.glossaryMode, reason: llmPlan.reason,
    };
  }
  return {
    route: decideRoute(refData), source: 'heuristic', confidence: null,
    glossaryModeHint: null, reason: heuristicRouteReason(refData),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRouteValue(cleaned: string): unknown {
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return undefined;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function stripLeading(value: string, needle: string): string {
  let out = value;
  while (out.startsWith(needle)) out = out.slice(needle.length);
  return out;
}

function stripTrailing(value: string, needle: string): string {
  let out = value;
  while (out.endsWith(needle)) out = out.slice(0, out.length - needle.length);
  return out;
}

function routeFromString(value: string): ChatAnkiRoute | null {
  return value === 'simple_text' || value === 'vlm_light' || value === 'vlm_full' ? value : null;
}

/** 解析 plan_route 响应；route/confidence 非法一律 null（回退启发式）。 */
export function parseRoutePlanResponse(response: string): RoutePlan | null {
  const cleaned = rustTrim(stripTrailing(stripLeading(stripLeading(rustTrim(response), '```json'), '```'), '```'));
  const value = parseRouteValue(cleaned);
  if (!isJsonObject(value)) return null;
  if (typeof value.route !== 'string') return null;
  const route = routeFromString(value.route);
  if (route === null) return null;
  const rawConfidence = value.confidence;
  if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence)) return null;
  const confidence = Math.fround(rawConfidence);
  if (confidence < 0 || confidence > 1) return null;
  const glossaryMode = typeof value.glossaryMode === 'boolean' ? value.glossaryMode : null;
  const reason = typeof value.reason === 'string' ? value.reason : null;
  return { route, confidence, glossaryMode, reason };
}

export function buildRoutePlanPrompt(
  goal: string, refData: VfsContextRefData, textSample: string,
): string {
  let imageCount = 0;
  let fileCount = 0;
  let otherCount = 0;
  let refLines = '';
  refData.refs.forEach((ref, index) => {
    if (ref.type === 'image') imageCount += 1;
    else if (ref.type === 'file') fileCount += 1;
    else otherCount += 1;
    if (index < ROUTE_PLAN_MAX_LISTED_REFS) refLines += `- ${ref.name} (${ref.type})\n`;
  });
  if (refData.refs.length > ROUTE_PLAN_MAX_LISTED_REFS) {
    refLines += `- ...（其余 ${refData.refs.length - ROUTE_PLAN_MAX_LISTED_REFS} 项省略）\n`;
  }
  const sampleBlock = rustTrim(textSample).length === 0
    ? '（无可用文本采样：提取文本缺失或为空）'
    : textSample;
  return `你是 ChatAnki 的「导入路由规划器」。根据学习目标、资源元数据和文本采样，为制卡管线选择最合适的导入路由。

可选路由：
- simple_text：材料以可靠文本为主（提取文本质量良好），直接用文本制卡。
- vlm_light：文本为主，但有少量图片/图表需要视觉补充识别。
- vlm_full：图片为主，或提取文本质量差（乱码/缺失/明显 OCR 噪声），需要视觉模型完整识别。

学习目标：${goal}

资源元数据（共 ${refData.refs.length} 项：文件 ${fileCount}，图片 ${imageCount}，其他 ${otherCount}）：
${refLines}
文本采样（每项截取开头片段，可能为空）：
"""
${sampleBlock}
"""

判断要点：
1) 无图片且文本采样可读连贯 → simple_text。
2) 有少量图片（≤3）且文本可读 → vlm_light。
3) 图片为主 / 无可靠文本 / 采样明显是乱码或 OCR 噪声 → vlm_full。
4) glossaryMode：材料是否是「术语 / 名词解释 / 词汇表」类条目清单。
5) confidence 表示你对本次选择的确定程度（0.0-1.0），不确定时请如实给低值。

只输出一行 JSON，不要解释、不要代码块：
{"route":"simple_text|vlm_light|vlm_full","confidence":0.0,"glossaryMode":false,"reason":"简短理由"}
`;
}

/** `build_analyze_output`：analyze 预估与管线共用同一 `resolveRouteDecision` 结果。 */
export function buildAnalyzeOutput(
  goal: string | null,
  content: string,
  refData: VfsContextRefData | null,
  decision: RouteDecision,
  warnings: readonly unknown[],
): Record<string, unknown> {
  const chars = [...content].length;
  const nonEmptyLines = content.split('\n').filter((line) => rustTrim(line).length > 0).length;
  const entryLike = countEntryLikeLines(content);
  const glossaryMode = (decision.glossaryModeHint ?? false) || looksLikeGlossaryContent(content);
  const knobs = glossaryGenerationKnobs(glossaryMode);

  const metrics: Record<string, number> = { chars, nonEmptyLines, entryLikeLines: entryLike };
  if (refData !== null) {
    let fileCount = 0;
    let imageCount = 0;
    let otherCount = 0;
    for (const ref of refData.refs) {
      if (ref.type === 'file') fileCount += 1;
      else if (ref.type === 'image') imageCount += 1;
      else otherCount += 1;
    }
    metrics.refTotal = refData.refs.length;
    metrics.refFiles = fileCount;
    metrics.refImages = imageCount;
    metrics.refOthers = otherCount;
  }

  const output: Record<string, unknown> = {
    status: 'ok',
    goal,
    metrics,
    routing: {
      route: decision.route,
      routeSource: decision.source,
      confidence: decision.confidence,
      glossaryMode,
      reason: decision.reason,
    },
    recommended: {
      route: decision.route,
      maxCards: suggestMaxCardsArg(glossaryMode, entryLike, chars),
      glossaryMode,
      segmentOverlapSize: knobs.segmentOverlapSize,
      maxOutputTokensOverride: knobs.maxOutputTokensOverride,
      temperature: knobs.temperature,
      pipelineDefaultMaxCards: defaultMaxCardsForContent(glossaryMode, chars),
    },
  };
  if (warnings.length > 0) output.warnings = warnings;
  return output;
}

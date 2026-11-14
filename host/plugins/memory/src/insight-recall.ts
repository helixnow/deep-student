/**
 * Rust `dstu-research/src/insight/recall.rs::InsightRecallService::recall`:
 * FTS (LIKE fallback) → relation expansion (budget 2) → one LLM query rewrite
 * when nothing matched → batch adversarial KEEP/REJECT filter. Without an LLM it
 * degrades to the pure FTS pipeline.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { expandViaRelations, recallFts, type RecallCandidate } from '../repository/insight-cards.ts';

export interface InsightRecallModel {
  callMemoryDecisionRawPrompt(prompt: string): Promise<{ assistant_message: string }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimQuotes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '"') start += 1;
  while (end > start && text[end - 1] === '"') end -= 1;
  return text.slice(start, end);
}

/** Rust `str::parse::<usize>()` after `trim_end_matches(['.', '、', ':'])`. */
function parseIndex(token: string): number | null {
  let end = token.length;
  while (end > 0 && ['.', '、', ':'].includes(token[end - 1]!)) end -= 1;
  const digits = token.slice(0, end);
  if (!/^\+?\d+$/.test(digits)) return null;
  const value = Number(digits.replace('+', ''));
  return Number.isSafeInteger(value) ? value : null;
}

async function rewriteQuery(llm: InsightRecallModel, query: string, warn: (message: string) => void): Promise<string | null> {
  const prompt = '你是检索查询改写器。用户在学相关对话中说了下面这段话。'
    + '请提取其中最适合在「个人方法卡片库」中做全文检索的关键词短语'
    + `（<=20 字，只输出短语本身，不要解释）。\n\n用户输入：${query}`;
  try {
    const out = await llm.callMemoryDecisionRawPrompt(prompt);
    const rewritten = trimQuotes(rustTrim(out.assistant_message));
    return Array.from(rewritten).length >= 3 && rewritten !== query ? rewritten : null;
  } catch (error) {
    warn(`[InsightRecall] LLM 改写失败，跳过重试: ${errorText(error)}`);
    return null;
  }
}

async function adversarialFilter(llm: InsightRecallModel, query: string, candidates: RecallCandidate[],
  warn: (message: string) => void): Promise<RecallCandidate[]> {
  let listing = '';
  candidates.forEach((candidate, index) => {
    const revision = candidate.card.currentRevision;
    listing += `${index + 1}. 标题：${candidate.card.title}；情境：${revision?.situation ?? ''}；规则：${revision?.rule ?? ''}\n`;
  });
  const prompt = `你是严格的审查员。用户当前输入：「${query}」。\n`
    + '下面是候选的「个人方法卡」。请逐条唱反调：找出它为什么不适用于当前输入。'
    + `只有当你确信明显不适用时才否决。\n\n${listing}\n`
    + '按行输出结论，格式：序号 KEEP 或 序号 REJECT。不要输出其他内容。';
  let answer: string;
  try {
    answer = (await llm.callMemoryDecisionRawPrompt(prompt)).assistant_message;
  } catch (error) {
    warn(`[InsightRecall] 唱反调核验失败，保留全部候选: ${errorText(error)}`);
    return candidates;
  }
  const reject = candidates.map(() => false);
  for (const line of answer.split('\n')) {
    const trimmed = rustTrim(line);
    const split = /\s/u.exec(trimmed);
    if (split === null) continue;
    const index = parseIndex(trimmed.slice(0, split.index));
    const verdict = trimmed.slice(split.index + split[0].length);
    if (index !== null && index >= 1 && index <= candidates.length && verdict.toUpperCase().includes('REJECT')) {
      reject[index - 1] = true;
    }
  }
  return candidates.filter((_, index) => !reject[index]);
}

export async function recallInsights(db: SqlExecutor, query: string, llm: InsightRecallModel | null,
  limit: number, warn: (message: string) => void): Promise<RecallCandidate[]> {
  let candidates = recallFts(db, query, limit);
  if (candidates.length > 0) candidates.push(...expandViaRelations(db, candidates, 2));

  if (candidates.length === 0 && Array.from(query).length >= 10 && llm !== null) {
    const rewritten = await rewriteQuery(llm, query, warn);
    if (rewritten !== null) {
      candidates = recallFts(db, rewritten, limit).map(candidate => ({
        ...candidate, matchedVia: 'fts_rewritten', confidence: candidate.confidence * 0.8,
      }));
    }
  }

  if (candidates.length > 0 && llm !== null) candidates = await adversarialFilter(llm, query, candidates, warn);
  return candidates;
}

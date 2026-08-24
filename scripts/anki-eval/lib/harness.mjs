/**
 * eval harness 核心：加载 fixture 清单、回放、lint、比对预期、汇总指标。
 * 被 vitest 测试（tests/vitest/anki/eval/）与 CLI（scripts/anki-eval/run-eval.mjs）共用。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { replayStream, replayDirect } from './replayParser.mjs';
import { lintCard } from './cardLint.mjs';

/** 仓库内 fixture 根目录（相对仓库根） */
export const FIXTURES_DIR = 'tests/fixtures/anki-eval';

export async function loadManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, FIXTURES_DIR, 'manifest.json');
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

/**
 * 回放单个 fixture 并附加 lint 结果。
 * @returns {{id: string, cards: Array<{outcome, lintCodes, stage, card?}>, droppedProse: number}}
 */
export async function runCase(caseDef, repoRoot) {
  const raw = await readFile(path.join(repoRoot, FIXTURES_DIR, caseDef.file), 'utf8');
  const replay =
    caseDef.entry === 'direct' ? replayDirect(raw) : replayStream(raw, caseDef.chunkSize ?? 0);

  const cards = replay.cards.map((entry) => ({
    outcome: entry.outcome,
    stage: entry.stage,
    card: entry.card,
    lintCodes: entry.card ? lintCard(entry.card) : [],
  }));

  return { id: caseDef.id, cards, droppedProse: replay.droppedProse };
}

/**
 * 比对实际结果与 manifest 预期，返回差异列表（空数组 = 通过）。
 */
export function diffExpectation(caseDef, actual) {
  const problems = [];
  const expected = caseDef.expected;

  if (actual.cards.length !== expected.cards.length) {
    problems.push(
      `卡片段数不符：期望 ${expected.cards.length}，实际 ${actual.cards.length}` +
        `（实际 outcome 序列：${actual.cards.map((c) => c.outcome).join(', ') || '空'}）`
    );
    return problems;
  }

  expected.cards.forEach((exp, i) => {
    const act = actual.cards[i];
    if (act.outcome !== exp.outcome) {
      problems.push(`第 ${i + 1} 段 outcome 不符：期望 ${exp.outcome}，实际 ${act.outcome}`);
    }
    const expLint = [...(exp.lintCodes ?? [])].sort();
    if (JSON.stringify(act.lintCodes) !== JSON.stringify(expLint)) {
      problems.push(
        `第 ${i + 1} 段 lintCodes 不符：期望 [${expLint.join(', ')}]，实际 [${act.lintCodes.join(', ')}]`
      );
    }
    if (exp.frontIncludes) {
      const front = act.card?.front ?? '';
      if (!front.includes(exp.frontIncludes)) {
        problems.push(`第 ${i + 1} 段 front 未包含预期文本：${exp.frontIncludes}`);
      }
    }
  });

  const expDropped = expected.droppedProse ?? 0;
  if (actual.droppedProse !== expDropped) {
    problems.push(`droppedProse 不符：期望 ${expDropped}，实际 ${actual.droppedProse}`);
  }

  return problems;
}

/**
 * 指标草表：parse_success_rate / error_card_rate / lint_flag_rate。
 * 口径：
 * - 分母 totalSegments = parse_ok + repair_ok + error_card（不含被丢弃的纯文本残留）；
 * - parse_success_rate = (parse_ok + repair_ok) / totalSegments；
 * - error_card_rate   = error_card / totalSegments；
 * - lint_flag_rate    = 命中 ≥1 个 lint 码的解析成功卡 / 解析成功卡总数。
 */
export function computeMetrics(results) {
  let parseOk = 0;
  let repairOk = 0;
  let errorCards = 0;
  let droppedProse = 0;
  let lintFlagged = 0;

  for (const result of results) {
    droppedProse += result.droppedProse;
    for (const card of result.cards) {
      if (card.outcome === 'parse_ok') parseOk++;
      else if (card.outcome === 'repair_ok') repairOk++;
      else if (card.outcome === 'error_card') errorCards++;
      if (card.outcome !== 'error_card' && card.lintCodes.length > 0) lintFlagged++;
    }
  }

  const totalSegments = parseOk + repairOk + errorCards;
  const parsedCards = parseOk + repairOk;
  const ratio = (num, den) => (den === 0 ? 0 : num / den);

  return {
    cases: results.length,
    totalSegments,
    parseOk,
    repairOk,
    errorCards,
    droppedProse,
    lintFlagged,
    parseSuccessRate: ratio(parsedCards, totalSegments),
    errorCardRate: ratio(errorCards, totalSegments),
    lintFlagRate: ratio(lintFlagged, parsedCards),
  };
}

/** 一次性跑完整个清单，返回 { results, failures, metricsBySet }。 */
export async function runAll(repoRoot) {
  const manifest = await loadManifest(repoRoot);
  const results = [];
  const failures = [];

  for (const caseDef of manifest.cases) {
    const actual = await runCase(caseDef, repoRoot);
    const problems = diffExpectation(caseDef, actual);
    results.push({ caseDef, actual, problems });
    if (problems.length > 0) failures.push({ id: caseDef.id, problems });
  }

  const bySet = (set) => results.filter((r) => r.caseDef.set === set).map((r) => r.actual);
  return {
    manifest,
    results,
    failures,
    metricsBySet: {
      bad: computeMetrics(bySet('bad')),
      good: computeMetrics(bySet('good')),
      all: computeMetrics(results.map((r) => r.actual)),
    },
  };
}

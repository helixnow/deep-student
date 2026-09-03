/**
 * 金标修正对回归（Round 4 #10，gold-set-plan §5.2 的 harness 落地）。
 *
 * tests/fixtures/anki-eval/gold/repair-pairs/*.json 中的每个对子必须满足
 * 「改前 = 劣化（lint 命中）、改后 = 金标（lint 零命中）」契约；
 * 两端都不命中的对子暴露 lint 盲区，是新规则的第一素材来源，
 * 本测试会把它作为失败暴露出来（而非静默通过）。
 *
 * 同一批 fixture 同时被 Rust 侧消费：anki_gold_set.rs 的
 * repo_repair_pair_fixtures_satisfy_lint_contract 用生产 lint 引擎
 * （anki_qa_lint::lint_card）跑同样的断言，双侧互为校验、防实现漂移。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';

// @ts-expect-error 共享 .mjs 模块无类型声明
import { loadGoldPairs, evaluateRepairPair, runGoldPairs } from '../../../../scripts/anki-eval/lib/harness.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

interface GoldPair {
  file: string;
  id: string;
  label: string;
  original: Record<string, string>;
  edited: Record<string, string>;
  expected?: { originalCodes?: string[]; editedCodes?: string[] };
}

describe('金标修正对回归（改前=劣化、改后=金标）', () => {
  it('修正对规模达标：≥3 对，且每对携带 original/edited/expected', async () => {
    const pairs = (await loadGoldPairs(REPO_ROOT)) as GoldPair[];
    expect(pairs.length).toBeGreaterThanOrEqual(3);
    for (const pair of pairs) {
      expect(pair.id, `${pair.file} 缺 id`).toBeTruthy();
      expect(pair.original, `${pair.id} 缺 original`).toBeTruthy();
      expect(pair.edited, `${pair.id} 缺 edited`).toBeTruthy();
      expect(pair.expected?.originalCodes, `${pair.id} 缺 expected.originalCodes`).toBeTruthy();
    }
  });

  it('每个修正对满足 lint 契约：original 命中、edited 零命中、码与预期一致', async () => {
    const { failures } = await runGoldPairs(REPO_ROOT);
    expect(
      failures,
      failures.map((f: { id: string; problems: string[] }) => `[${f.id}] ${f.problems.join('；')}`).join('\n')
    ).toEqual([]);
  });

  it('标签取值合法（对应 anki_gold_set::GoldLabel 的可导出桶）', async () => {
    const pairs = (await loadGoldPairs(REPO_ROOT)) as GoldPair[];
    const exportableLabels = new Set(['edited_minor', 'edited_major', 'error_card_repaired']);
    for (const pair of pairs) {
      expect(exportableLabels.has(pair.label), `${pair.id} 的 label="${pair.label}" 不是修正对合法标签`).toBe(
        true
      );
    }
  });

  it('evaluateRepairPair 把 lint 盲区暴露为失败（两端都干净 ≠ 通过）', () => {
    const blindSpot = evaluateRepairPair({
      id: 'synthetic-blind-spot',
      original: { front: '什么是惯性？', back: '物体保持运动状态的性质' },
      edited: { front: '什么是惯性？', back: '物体保持原有运动状态不变的固有属性' },
    });
    expect(blindSpot.problems.length).toBeGreaterThan(0);
    expect(blindSpot.problems[0]).toContain('lint 盲区');
  });

  it('evaluateRepairPair 拒绝仍被 lint 命中的 edited（改后必须是金标）', () => {
    const dirtyEdited = evaluateRepairPair({
      id: 'synthetic-dirty-edited',
      original: { front: 'Q？', back: 'TODO' },
      edited: { front: 'Q？', back: '待补充' },
    });
    expect(dirtyEdited.problems.some((p: string) => p.includes('edited 仍被 lint 命中'))).toBe(true);
  });
});

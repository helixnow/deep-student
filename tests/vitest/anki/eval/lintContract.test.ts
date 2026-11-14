/**
 * lint 码契约锁。
 *
 * eval harness 的 JS lint（scripts/anki-eval/lib/cardLint.mjs）复用 Host
 * 生产 lint（host/plugins/anki/src/anki-qa-*.ts）的 code 字符串。契约有三个
 * 互相锁定的事实来源：
 *
 * 1. `anki-qa-types.ts` 的 `codes` —— 具名常量导出；
 * 2. `anki-gold-set.ts` 的 `LINT_CONTRACT_CODES` —— 契约清单（挖掘/导出侧）；
 * 3. `anki-qa-*.ts` 规则实现实际产出的 code 字面量。
 *
 * 本文件复核 1==2==3，并锁定 JS 分区表的完备性：
 *
 *   RUST_ALIGNED_CODES ∪ RUST_ONLY_CODES == codes（键名与常量名、
 *   值与常量值逐字节一致；无交集、无遗漏）
 *   EVAL_ONLY_CODES ∩ codes == ∅
 *
 * 分区表的 RUST_ 前缀是历史命名，指“与生产 lint 对齐 / 仅生产 lint 有”。
 * 任何一侧新增/改名 lint 码而不同步其余各处，本文件即红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// @ts-expect-error 共享 .mjs 模块无类型声明
import {
  RUST_ALIGNED_CODES,
  RUST_ONLY_CODES,
  EVAL_ONLY_CODES,
  LINT_CODES,
} from '../../../../scripts/anki-eval/lib/cardLint.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ANKI_SRC = path.join(REPO_ROOT, 'host/plugins/anki/src');

/** 从 anki-gold-set.ts 解析契约清单 LINT_CONTRACT_CODES */
function loadContractCodes(): Set<string> {
  const source = readFileSync(path.join(ANKI_SRC, 'anki-gold-set.ts'), 'utf8');
  const block = source.match(/LINT_CONTRACT_CODES: readonly string\[\] = \[([\s\S]*?)\];/);
  expect(block, 'anki-gold-set.ts 必须声明 LINT_CONTRACT_CODES').not.toBeNull();
  const codes = new Set<string>();
  for (const m of block![1].matchAll(/'([a-z_]+)'/g)) codes.add(m[1]);
  return codes;
}

/** 从 anki-qa-types.ts 的 codes 对象解析全部具名常量（常量名 → code 值） */
function loadCodeConstants(): Map<string, string> {
  const source = readFileSync(path.join(ANKI_SRC, 'anki-qa-types.ts'), 'utf8');
  const block = source.match(/export const codes = \{([\s\S]*?)\} as const;/);
  expect(block, 'anki-qa-types.ts 必须导出 codes 常量').not.toBeNull();
  const consts = new Map<string, string>();
  for (const m of block![1].matchAll(/([A-Z][A-Z0-9_]*): '([a-z][a-z0-9_]*)'/g)) {
    consts.set(m[1], m[2]);
  }
  expect(consts.size).toBeGreaterThan(0);
  return consts;
}

/** 从 anki-qa-*.ts 源码提取规则实现实际产出的全部 code 字符串 */
function loadEmittedCodes(): Set<string> {
  const source = readdirSync(ANKI_SRC)
    .filter((name) => /^anki-qa-.*\.ts$/.test(name))
    .map((name) => readFileSync(path.join(ANKI_SRC, name), 'utf8'))
    .join('\n');
  const codes = new Set<string>();
  for (const m of source.matchAll(/LintIssue\.new\(\s*['"]([a-z_]+)['"]/g)) codes.add(m[1]);
  for (const m of source.matchAll(/"code":\s*['"]([a-z_]+)['"]/g)) codes.add(m[1]);
  return codes;
}

const sorted = (values: Iterable<string>) => [...values].sort();

describe('lint 码契约', () => {
  it('codes 常量、LINT_CONTRACT_CODES 与实际产出的 code 三方一致', () => {
    const constants = loadCodeConstants();
    const contract = loadContractCodes();
    const emitted = loadEmittedCodes();
    expect(sorted(constants.values())).toEqual(sorted(contract));
    expect(sorted(contract)).toEqual(sorted(emitted));
  });

  it('JS 分区表二分覆盖全部生产码：ALIGNED ∪ RUST_ONLY == codes 且无交集', () => {
    const constants = loadCodeConstants();
    const aligned = Object.values(RUST_ALIGNED_CODES as Record<string, string>);
    const rustOnly = Object.values(RUST_ONLY_CODES as Record<string, string>);
    const union = [...aligned, ...rustOnly];
    expect(new Set(union).size, 'ALIGNED 与 RUST_ONLY 存在交集或表内重复').toBe(union.length);
    expect(sorted(union)).toEqual(sorted(constants.values()));
  });

  it('JS 分区表键名与 codes 常量名逐字节一致（名字 + 值双重对齐）', () => {
    const constants = loadCodeConstants();
    for (const table of [RUST_ALIGNED_CODES, RUST_ONLY_CODES] as Record<string, string>[]) {
      for (const [name, code] of Object.entries(table)) {
        expect(constants.get(name), `JS 键 ${name} 在 codes 中无同名常量`).toBe(code);
      }
    }
  });

  it('eval-only 码不与生产契约冲突（避免同名异义）', () => {
    const contract = loadContractCodes();
    for (const [name, code] of Object.entries(EVAL_ONLY_CODES as Record<string, string>)) {
      expect(contract.has(code), `EVAL_ONLY_CODES.${name}="${code}" 与生产契约撞名`).toBe(false);
    }
  });

  it('全部 JS 码遵循 snake_case 命名且无重复', () => {
    const values = [
      ...Object.values(LINT_CODES as Record<string, string>),
      ...Object.values(RUST_ONLY_CODES as Record<string, string>),
    ];
    for (const code of values) expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(values).size).toBe(values.length);
  });

  it('eval README 对照表覆盖全部契约码与 eval-only 码（文档不漂移）', () => {
    const readme = readFileSync(
      path.join(REPO_ROOT, 'docs/research/anki-ai-native/eval/README.md'),
      'utf8'
    );
    for (const code of loadContractCodes()) {
      expect(readme.includes(`\`${code}\``), `README 对照表缺少契约码 ${code}`).toBe(true);
    }
    for (const code of Object.values(EVAL_ONLY_CODES as Record<string, string>)) {
      expect(readme.includes(`\`${code}\``), `README 对照表缺少 eval-only 码 ${code}`).toBe(true);
    }
  });
});

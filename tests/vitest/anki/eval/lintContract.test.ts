/**
 * 跨语言 lint 契约锁（Round 4 #10）。
 *
 * eval harness 的 JS lint（scripts/anki-eval/lib/cardLint.mjs）复用 Rust
 * 生产 lint（src-tauri/src/anki_qa_lint.rs）的 code 字符串。契约的唯一事实
 * 来源是 src-tauri/src/anki_gold_set.rs 的 LINT_CONTRACT_CODES 常量，
 * 三方一致性由本文件（JS 侧）与 anki_gold_set.rs 的
 * lint_contract_codes_match_anki_qa_lint_source 测试（Rust 侧）双向锁定：
 *
 *   anki_qa_lint.rs 源码产出的 code  ==  LINT_CONTRACT_CODES  ⊇  JS RUST_ALIGNED_CODES
 *   JS EVAL_ONLY_CODES ∩ LINT_CONTRACT_CODES == ∅
 *
 * 任何一侧新增/改名 lint 码而不同步另一侧，本文件即红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// @ts-expect-error 共享 .mjs 模块无类型声明
import { RUST_ALIGNED_CODES, EVAL_ONLY_CODES, LINT_CODES } from '../../../../scripts/anki-eval/lib/cardLint.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** 从 anki_gold_set.rs 解析契约清单 LINT_CONTRACT_CODES */
function loadContractCodes(): Set<string> {
  const source = readFileSync(path.join(REPO_ROOT, 'src-tauri/src/anki_gold_set.rs'), 'utf8');
  const block = source.match(/LINT_CONTRACT_CODES:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  expect(block, 'anki_gold_set.rs 必须声明 LINT_CONTRACT_CODES').not.toBeNull();
  const codes = new Set<string>();
  for (const m of block![1].matchAll(/"([a-z_]+)"/g)) codes.add(m[1]);
  return codes;
}

/** 从 anki_qa_lint.rs 源码提取实际产出的全部 code 字符串 */
function loadRustEmittedCodes(): Set<string> {
  const source = readFileSync(path.join(REPO_ROOT, 'src-tauri/src/anki_qa_lint.rs'), 'utf8');
  const codes = new Set<string>();
  for (const m of source.matchAll(/LintIssue::new\(\s*"([a-z_]+)"/g)) codes.add(m[1]);
  for (const m of source.matchAll(/"code":\s*"([a-z_]+)"/g)) codes.add(m[1]);
  return codes;
}

describe('lint 码跨语言契约', () => {
  it('LINT_CONTRACT_CODES 与 anki_qa_lint.rs 实际产出的 code 集合完全一致', () => {
    const contract = loadContractCodes();
    const emitted = loadRustEmittedCodes();
    expect([...contract].sort()).toEqual([...emitted].sort());
  });

  it('JS Rust-aligned 码全部落在契约清单内（逐字节一致）', () => {
    const contract = loadContractCodes();
    for (const [name, code] of Object.entries(RUST_ALIGNED_CODES as Record<string, string>)) {
      expect(contract.has(code), `RUST_ALIGNED_CODES.${name}="${code}" 不在 LINT_CONTRACT_CODES 中`).toBe(
        true
      );
    }
  });

  it('eval-only 码不与 Rust 契约冲突（避免同名异义）', () => {
    const contract = loadContractCodes();
    for (const [name, code] of Object.entries(EVAL_ONLY_CODES as Record<string, string>)) {
      expect(contract.has(code), `EVAL_ONLY_CODES.${name}="${code}" 与 Rust 契约撞名`).toBe(false);
    }
  });

  it('全部 JS 码遵循 snake_case 命名且无重复', () => {
    const values = Object.values(LINT_CODES as Record<string, string>);
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

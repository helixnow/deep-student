/**
 * Contract: interaction/limits.ts ↔ Rust genui_interaction.rs 的 GENUI_* 常量同值（方案 1.4 / 1.5）。
 * Rust 文件由 WP-A 编写；尚未落地时跳过源码比对，仅锁 TS 常量的契约值。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as limits from '@/features/generative-ui/interaction/limits';

const RUST_PATH = path.join(
  process.cwd(),
  'src-tauri/crates/dstu-agent/src/chat_v2/tools/genui_interaction.rs',
);
const rustExists = fs.existsSync(RUST_PATH);

/** 方案第 1.5 节列出的 Rust 常量（必须存在且同值） */
const REQUIRED_RUST_USIZE: Record<string, number> = {
  GENUI_MAX_INTERACTIVE_BLOCKS: limits.GENUI_MAX_INTERACTIVE_BLOCKS,
  GENUI_ANSWER_SUMMARY_MAX_CHARS: limits.GENUI_ANSWER_SUMMARY_MAX_CHARS,
  GENUI_ANSWER_DATA_MAX_CHARS: limits.GENUI_ANSWER_DATA_MAX_CHARS,
  GENUI_MAX_IMAGE_REFS: limits.GENUI_MAX_IMAGE_REFS,
  GENUI_MAX_FOLLOWUP_ACTIONS: limits.GENUI_MAX_FOLLOWUP_ACTIONS,
  GENUI_FOLLOWUP_PROMPT_MAX_CHARS: limits.GENUI_FOLLOWUP_PROMPT_MAX_CHARS,
};

/** Rust 可能定义的其余同名常量：若定义则必须同值 */
const OPTIONAL_RUST_NUMBERS: Record<string, number> = {
  GENUI_TEXT_FIELD_MAX_CHARS: limits.GENUI_TEXT_FIELD_MAX_CHARS,
  GENUI_TEXT_FIELD_DEFAULT_MAX_CHARS: limits.GENUI_TEXT_FIELD_DEFAULT_MAX_CHARS,
  GENUI_CHOICE_OTHER_MAX_CHARS: limits.GENUI_CHOICE_OTHER_MAX_CHARS,
  GENUI_SLIDER_MAX_STEPS: limits.GENUI_SLIDER_MAX_STEPS,
  GENUI_IMAGE_URL_MAX_CHARS: limits.GENUI_IMAGE_URL_MAX_CHARS,
  GENUI_IMAGE_PDF_PAGE_MAX: limits.GENUI_IMAGE_PDF_PAGE_MAX,
};

function readRustNumericConst(src: string, name: string): number | undefined {
  const re = new RegExp(`(?:pub(?:\\([^)]*\\))?\\s+)?const\\s+${name}\\s*:\\s*[A-Za-z0-9_]+\\s*=\\s*([0-9_]+)\\s*;`);
  const m = src.match(re);
  return m ? Number(m[1]!.replace(/_/g, '')) : undefined;
}

describe('genui limits contract', () => {
  it('TS limits match the plan table (1.4)', () => {
    expect(limits.GENUI_ANSWER_SUMMARY_MAX_CHARS).toBe(500);
    expect(limits.GENUI_ANSWER_DATA_MAX_CHARS).toBe(16_000);
    expect(limits.GENUI_MAX_INTERACTIVE_BLOCKS).toBe(4);
    expect(limits.GENUI_MAX_IMAGE_REFS).toBe(8);
    expect(limits.GENUI_MAX_FOLLOWUP_ACTIONS).toBe(4);
    expect(limits.GENUI_FOLLOWUP_PROMPT_MAX_CHARS).toBe(500);
    expect(limits.GENUI_TEXT_FIELD_MAX_CHARS).toBe(2000);
    expect([...limits.GENUI_NEW_BLOCK_TYPES]).toEqual(['choice', 'form', 'image']);
  });

  it('counts and truncates by code point', () => {
    expect(limits.countGenuiChars('a😀b')).toBe(3);
    expect(limits.truncateGenuiChars('abcdef', 4)).toBe('abc…');
    expect(limits.countGenuiChars(limits.truncateGenuiChars('😀'.repeat(600), 500))).toBe(500);
    expect(limits.truncateGenuiChars('abc', 4)).toBe('abc');
  });

  it.skipIf(!rustExists)('Rust GENUI_* constants equal TS limits', () => {
    const src = fs.readFileSync(RUST_PATH, 'utf8');
    for (const [name, value] of Object.entries(REQUIRED_RUST_USIZE)) {
      expect(readRustNumericConst(src, name), `Rust missing/different ${name}`).toBe(value);
    }
    for (const [name, value] of Object.entries(OPTIONAL_RUST_NUMBERS)) {
      const rust = readRustNumericConst(src, name);
      if (rust !== undefined) expect(rust, `Rust ${name}`).toBe(value);
    }
  });

  it.skipIf(!rustExists)('Rust GENUI_NEW_BLOCK_TYPES equals TS list', () => {
    const src = fs.readFileSync(RUST_PATH, 'utf8');
    const m = src.match(/GENUI_NEW_BLOCK_TYPES\s*:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/);
    expect(m, 'Rust GENUI_NEW_BLOCK_TYPES').toBeTruthy();
    const types = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(types).toEqual([...limits.GENUI_NEW_BLOCK_TYPES]);
  });
});

import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { regex as nativeRegex } from '../../../platform/native/regex/index.ts';
import {
  CodeNavigationExecutor, symbolOutline, textSearch,
} from '../src/tools/code-navigation.ts';
import { createWorkspaceHost } from './host-support.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-code-nav-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('text_search_is_bounded_and_filters_extensions', async () => {
  const temp = tmp();
  fs.writeFileSync(path.join(temp, 'main.rs'), 'fn alpha() {}\nalpha();\n');
  fs.writeFileSync(path.join(temp, 'notes.md'), 'alpha\n');
  const output = await textSearch(
    temp,
    temp,
    await nativeRegex.compile('alpha'),
    new Set(['rs']),
    1,
    nativeRegex,
  );
  expect(output.match_count).toBe(1);
  expect(output.matches[0]?.path).toBe('main.rs');
  expect(output.matches[0]?.line).toBe(1);
  expect(output.truncated).toBe(true);
});

it('search_skips_generated_and_hidden_directories', async () => {
  const temp = tmp();
  fs.mkdirSync(path.join(temp, 'target'));
  fs.mkdirSync(path.join(temp, '.git'));
  fs.mkdirSync(path.join(temp, 'secrets'));
  fs.writeFileSync(path.join(temp, 'target/generated.rs'), 'needle');
  fs.writeFileSync(path.join(temp, '.git/config'), 'needle');
  fs.writeFileSync(path.join(temp, 'secrets/token.txt'), 'needle');
  fs.writeFileSync(path.join(temp, 'visible.rs'), 'needle');
  const output = await textSearch(
    temp,
    temp,
    await nativeRegex.compile('needle'),
    new Set(),
    10,
    nativeRegex,
  );
  expect(output.match_count).toBe(1);
  expect(output.matches[0]?.path).toBe('visible.rs');
});

it('outlines_rust_and_typescript_declarations', () => {
  const temp = tmp();
  const rust = path.join(temp, 'lib.rs');
  fs.writeFileSync(rust, 'pub struct Item;\nimpl Item {}\nasync fn load() {}\n');
  const rustOutput = symbolOutline(temp, rust, 20);
  expect(rustOutput.symbol_count).toBe(2);
  expect(rustOutput.symbols[0]?.name).toBe('Item');
  expect(rustOutput.symbols[1]?.name).toBe('load');

  const ts = path.join(temp, 'view.ts');
  fs.writeFileSync(ts, 'export interface View {}\nexport const createView = () => {};\n');
  const tsOutput = symbolOutline(temp, ts, 20);
  expect(tsOutput.symbol_count).toBe(2);
  expect(tsOutput.symbols[1]?.kind).toBe('const');
});

it('outline_marks_truncated_only_when_an_extra_symbol_exists', () => {
  const temp = tmp();
  const source = path.join(temp, 'lib.rs');
  fs.writeFileSync(source, 'fn one() {}\n');
  const single = symbolOutline(temp, source, 1);
  expect(single.truncated).toBe(false);

  fs.writeFileSync(source, 'fn one() {}\nfn two() {}\n');
  const bounded = symbolOutline(temp, source, 1);
  expect(bounded.symbol_count).toBe(1);
  expect(bounded.truncated).toBe(true);
});

it('executor_contract_is_low_readonly', () => {
  const executor = new CodeNavigationExecutor();
  expect(executor.canHandle('builtin-workspace_text_search')).toBe(true);
  expect(executor.canHandle('workspace_symbol_outline')).toBe(true);
  expect(executor.canHandle('workspace_file_write')).toBe(false);
  expect(executor.sensitivityLevel('builtin-workspace_text_search')).toBe('low');
  expect(executor.concurrencyClass('builtin-workspace_symbol_outline')).toBe('read_only');
});

it('native regex preserves Rust Unicode classes, named captures and scalar columns', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'unicode.rs'), '😀 中文１２\n');
  const output = await textSearch(dir, dir, await nativeRegex.compile('(?P<word>\\w+)'), new Set(), 10, nativeRegex);
  expect(output.matches).toEqual([{ path: 'unicode.rs', line: 1, column: 3, text: '😀 中文１２' }]);
  await expect(nativeRegex.compile('(?=x)')).rejects.toThrow('look-around');
});

it('async textSearch handles multi-line chunked regex, anchors, literal pre-filter and signal cancellation', async () => {
  const dir = tmp();
  const sub = path.join(dir, 'nested');
  fs.mkdirSync(sub);
  const filler = Array.from({ length: 20 }, (_, i) => `line_${i}`).join('\n');
  fs.writeFileSync(path.join(dir, 'a.ts'), `${filler}\nexport const needle_42 = 1;\n`);
  fs.writeFileSync(path.join(sub, 'b.ts'), `${filler}\nconst other = 2;\n`);

  const regexHit = await textSearch(dir, dir, await nativeRegex.compile('needle_\\d+'), new Set(['ts']), 10, nativeRegex);
  expect(regexHit.matches).toEqual([{ path: 'a.ts', line: 21, column: 14, text: 'export const needle_42 = 1;' }]);

  const anchorHit = await textSearch(dir, dir, await nativeRegex.compile('^export\\s+const'), new Set(['ts']), 10, nativeRegex);
  expect(anchorHit.matches).toEqual([{ path: 'a.ts', line: 21, column: 1, text: 'export const needle_42 = 1;' }]);

  const controller = new AbortController();
  controller.abort();
  await expect(
    textSearch(dir, dir, await nativeRegex.compile('needle'), new Set(), 10, nativeRegex, undefined, controller.signal),
  ).rejects.toThrow('Code search cancelled');

  const { host, storage } = await createWorkspaceHost();
  try {
    const wsRoot = path.join(host.app.dataDir, 'ws');
    fs.mkdirSync(wsRoot);
    fs.writeFileSync(path.join(wsRoot, 'a.ts'), `${filler}\nexport const needle_42 = 1;\n`);
    await host.invoke('chat_v2_set_workspace_root', { path: wsRoot });
    const executor = new CodeNavigationExecutor(() => nativeRegex, () => host.ctx.nativeWindowsFiles);
    const outlineResult = await executor.execute(
      { id: 'c1', name: 'builtin-workspace_symbol_outline', arguments: { path: 'a.ts' } },
      { sessionId: 's', dataDir: host.app.dataDir, settings: host.ctx.settings },
    );
    expect(outlineResult.success).toBe(true);
    expect(outlineResult.output).toMatchObject({ symbol_count: 1, symbols: [{ name: 'needle_42', kind: 'const', line: 21 }] });
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

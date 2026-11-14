/**
 * `compactContracts()`（`mobile/vite.config.ts`）只去掉契约 JSON 的格式空白：每个文件解析结果不变，
 * Worker 用它构造的 `ContractSet` 与用原文构造的相同；迁移 SQL 和非 `?raw` 导入不经过它。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactContracts } from '../../vite.config.ts';
import { bundledContracts } from '../../src/worker/contracts.ts';
import { REPO } from './support/sqlite-node.ts';

const CONTRACTS = join(REPO, 'contracts/ipc');
const files = readdirSync(CONTRACTS).filter(name => name.endsWith('.json')).sort();

function load(id: string): string | null {
  const hook = compactContracts().load as (this: { addWatchFile(file: string): void }, id: string) => string | null;
  return hook.call({ addWatchFile: () => undefined }, id);
}

/** 插件产出的模块是 `export default "<文本>";`，取回文本。 */
function compacted(file: string): string {
  const module = load(`${join(CONTRACTS, file)}?raw`);
  const literal = /^export default (.*);\n$/s.exec(module ?? '');
  expect(literal, file).not.toBeNull();
  return JSON.parse(literal![1]!) as string;
}

describe('compactContracts', () => {
  it('every contract parses to the same value with less text', () => {
    let before = 0;
    let after = 0;
    for (const file of files) {
      const original = readFileSync(join(CONTRACTS, file), 'utf8');
      const text = compacted(file);
      expect(JSON.parse(text), file).toEqual(JSON.parse(original));
      expect(text.length, file).toBeLessThanOrEqual(original.length);
      before += original.length;
      after += text.length;
    }
    expect(files.length).toBeGreaterThan(0);
    expect(after).toBeLessThan(before * 0.7);
  });

  it('the Worker builds the same ContractSet from the compacted text', () => {
    const originals = Object.fromEntries(files.map(file => [`../../../contracts/ipc/${file}`, readFileSync(join(CONTRACTS, file), 'utf8')]));
    const compact = Object.fromEntries(files.map(file => [`../../../contracts/ipc/${file}`, compacted(file)]));
    const a = bundledContracts(originals);
    const b = bundledContracts(compact);
    expect([...b.commands.keys()]).toEqual([...a.commands.keys()]);
    expect([...b.commands.values()]).toEqual([...a.commands.values()]);
    expect([...b.events.entries()]).toEqual([...a.events.entries()]);
  });

  it('leaves migration SQL, other JSON and non-raw contract imports to Vite', () => {
    expect(load(`${join(REPO, 'resources/app/migrations/vfs/V20260130__init.sql')}?raw`)).toBeNull();
    expect(load(join(CONTRACTS, files[0]!))).toBeNull();
    expect(load(`${join(REPO, 'host/profiles/mobile.json')}?raw`)).toBeNull();
  });
});

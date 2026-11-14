import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractSet, parseContractSource } from '../../host/kernel/contract-set.ts';
import { generate } from './generate.ts';
import { renderTs } from './typescript.ts';
import type { LaneContract } from '../../host/kernel/contract.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync('/tmp/opencode/node-contracts-');
  roots.push(root);
  mkdirSync(join(root, 'contracts/ipc'), { recursive: true });
  write(root, '_shared', { lane: '_shared', generator: 'fixture', commands: [], events: [],
    $defs: { Receipt: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] } } });
  write(root, 'node', { lane: 'node', generator: 'fixture', commands: [{
    name: 'node_echo', lane: 'node', source: 'host/echo.ts', async: false,
    args: [{ key: 'text', schema: { type: 'string' }, optional: false }], injected: [],
    result: { $ref: '_shared.json#/$defs/Receipt' }, frontend: 'app',
  }], events: [], $defs: {} });
  return root;
}
function write(root: string, name: string, contract: unknown): void {
  writeFileSync(join(root, `contracts/ipc/${name}.json`), JSON.stringify(contract));
}

describe('Node-owned IPC generation', () => {
  it('generates usable commands from JSON alone, with no Rust tree or declaration', () => {
    const root = fixture();
    const result = generate(root);
    const types = result.files.get('contracts/ipc/generated/node.ts');
    expect(types).toContain('node_echo: {');
    expect(types).toContain('text: string;');
    expect(types).toContain('result: Shared.Receipt;');
    const source = parseContractSource('node.json', readFileSync(join(root, 'contracts/ipc/node.json'), 'utf8'));
    const shared = parseContractSource('_shared.json', readFileSync(join(root, 'contracts/ipc/_shared.json'), 'utf8'));
    const contracts = new ContractSet([shared, source]);
    expect(contracts.checkArgs(contracts.get('node_echo')!, { text: 'hello' })).toEqual({ ok: true, args: { text: 'hello' } });
    expect(contracts.checkResult(contracts.get('node_echo')!, { accepted: true })).toBeNull();

    // Worktree JSON edits take effect directly; there is no git HEAD extraction step.
    source.contract.commands[0]!.args[0]!.schema = { type: 'boolean' };
    write(root, 'node', source.contract);
    expect(generate(root).files.get('contracts/ipc/generated/node.ts')).toContain('text: boolean;');
  });

  it('rejects broken schema references before producing types', () => {
    const root = fixture();
    write(root, '_shared', { lane: '_shared', generator: 'fixture', commands: [], events: [], $defs: {} });
    expect(() => generate(root)).toThrow('Receipt');
  });

  it('rejects duplicate command names, including within one source file', () => {
    const root = fixture();
    const file = join(root, 'contracts/ipc/node.json');
    const contract = JSON.parse(readFileSync(file, 'utf8'));
    contract.commands.push(contract.commands[0]);
    write(root, 'node', contract);
    expect(() => generate(root)).toThrow('duplicate command node_echo');
  });

  it('preserves all existing exported type shapes while changing their generator', () => {
    const root = join(import.meta.dirname, '../..');
    const dir = join(root, 'contracts/ipc');
    const contracts = new Map(readdirSync(dir).filter(file => file.endsWith('.json'))
      .map(file => [file.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, file), 'utf8')) as LaneContract]));
    const shared = contracts.get('_shared')!;
    for (const [lane, contract] of contracts) {
      const file = `contracts/ipc/generated/${lane}.ts`;
      const text = renderTs(contract, lane === '_shared', 'test', shared, contracts);
      const previous = readFileSync(join(root, file), 'utf8');
      const typeBody = (value: string) => value.split('\n')
        .filter(line => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/**')).join('\n');
      expect(typeBody(text), file).toBe(typeBody(previous));
    }
  });
});

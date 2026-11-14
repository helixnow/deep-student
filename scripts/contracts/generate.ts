/** Node-owned IPC：JSON Schema 是输入，TS 类型和报告是输出。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ContractSet, parseContractSource } from '../../host/kernel/contract-set.ts';
import { renderTs } from './typescript.ts';

export const GENERATOR = 'deep-student/node-contracts@1.0.0';

function unresolved(node: unknown, pointer = ''): string[] {
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => key === 'x-unresolved'
    ? [`- \`${pointer || '/'}\` — ${String(value).replace(/\n/g, ' ')}`]
    : unresolved(value, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}

export function generate(root: string): { files: Map<string, string>; summary: string } {
  const dir = join(root, 'contracts/ipc');
  const sources = readdirSync(dir).filter(file => file.endsWith('.json')).sort()
    .map(file => parseContractSource(file, readFileSync(join(dir, file), 'utf8')));
  const shared = sources.find(s => s.file === '_shared.json')?.contract;
  if (!shared) throw new Error('contracts/ipc/_shared.json is required');
  const lanes = new Map(sources.filter(s => s.file !== '_shared.json').map(s => {
    if (s.file !== `${s.contract.lane}.json`) throw new Error(`contract lane does not match filename: ${s.file}`);
    return [s.contract.lane, s.contract] as const;
  }));
  const names = new Set<string>();
  for (const { file, contract } of sources) {
    for (const command of contract.commands) {
      if (names.has(command.name)) throw new Error(`duplicate command ${command.name} in ${file}`);
      names.add(command.name);
    }
  }
  const problems = new ContractSet(sources).compileAll();
  if (problems.length) throw new Error(problems.join('\n'));

  const files = new Map<string, string>();
  for (const { file, contract } of sources) {
    files.set(`contracts/ipc/generated/${file.replace(/\.json$/, '.ts')}`,
      renderTs(contract, file === '_shared.json', GENERATOR, shared, lanes));
  }
  const rows: string[] = [];
  const pending: string[] = [];
  let events = 0;
  let defs = 0;
  for (const { file, contract } of sources) {
    defs += Object.keys(contract.$defs).length;
    events += contract.events.length;
    rows.push(`| ${contract.lane} | ${contract.commands.length} | ${contract.events.length} | ${Object.keys(contract.$defs).length} |`);
    const entries = unresolved(contract);
    if (entries.length) pending.push(`## ${file}`, '', ...entries, '');
  }
  const summary = `commands ${names.size}; events ${events}; defs ${defs}`;
  files.set('contracts/ipc/SUMMARY.md', [
    '# IPC 契约汇总', '', `由 \`npm run contracts:generate\` 生成（${GENERATOR}），勿手改。`, '',
    '源文件：`contracts/ipc/*.json`。生成与校验不读取实现源码，不依赖 Rust 工具链。', '',
    `命令 ${names.size}；事件 ${events}（按所属契约计）；类型定义 ${defs}。`, '',
    '| 契约 | 命令 | 事件 | 类型 |', '|---|---:|---:|---:|', ...rows, '',
  ].join('\n'));
  files.set('contracts/ipc/UNRESOLVED.md', [
    '# IPC 契约未确定形状', '', `由 \`npm run contracts:generate\` 生成（${GENERATOR}），勿手改。`, '',
    '以下为 JSON 源中保留的 `x-unresolved` 注解；它们不是待执行的 Rust 构建任务。修改时核对当前 Host 实现。', '',
    ...pending,
  ].join('\n'));
  return { files, summary };
}

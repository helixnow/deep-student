import fs from 'node:fs';
import path from 'node:path';

interface ContractArg { key: string; optional: boolean }
interface ContractCommand { name: string; args: ContractArg[] }

const ROOT = path.resolve(__dirname, '../../..');
let index: Map<string, ContractCommand> | null = null;

function contracts(): Map<string, ContractCommand> {
  if (index) return index;
  index = new Map();
  const dir = path.join(ROOT, 'contracts/ipc');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { commands?: ContractCommand[] };
    for (const c of doc.commands ?? []) index.set(c.name, c);
  }
  return index;
}

/**
 * invoke 载荷与 contracts/ipc 的差异：契约外的键（kernel 与 Tauri 都会静默忽略）和缺失的必填键（调用被拒绝）。
 * 返回空数组表示载荷与契约一致。
 */
export function ipcContractViolations(command: string, payload: Record<string, unknown> | undefined): string[] {
  const contract = contracts().get(command);
  if (!contract) return [`command ${command} is not in contracts/ipc`];
  const keys = new Set(contract.args.map((a) => a.key));
  const out: string[] = [];
  for (const k of Object.keys(payload ?? {})) if (!keys.has(k)) out.push(`unknown key ${k}`);
  for (const a of contract.args) if (!a.optional && !(payload && a.key in payload)) out.push(`missing required key ${a.key}`);
  return out;
}

/** 所有对 `command` 的 invoke 调用都必须符合契约；至少要有一次调用。 */
export function expectInvokeCallsMatchContract(calls: readonly unknown[][], command: string): void {
  const matching = calls.filter((c) => c[0] === command);
  if (matching.length === 0) throw new Error(`expected at least one invoke(${command})`);
  const problems = matching.flatMap((c) => ipcContractViolations(command, c[1] as Record<string, unknown> | undefined));
  if (problems.length) throw new Error(`invoke(${command}) payload violates contract: ${problems.join('; ')}`);
}

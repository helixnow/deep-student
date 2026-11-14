/**
 * 命令覆盖检查（供 CI ledger 使用）：比较插件 `meta.commands`、契约与实际注册。
 */
import type { PluginMeta } from './api.ts';
import type { ContractSet } from './contract-set.ts';

export interface CoverageInput {
  /** 已加载插件的 meta。 */
  plugins: readonly PluginMeta[];
  contracts: ContractSet;
  /** 运行时实际注册的命令（可选；给出时报告"声明了但未注册"）。 */
  registered?: readonly { command: string; plugin?: string | undefined }[];
}

export interface CoverageReport {
  /** 契约中存在、但没有任何插件声明的命令（尚未迁移）。 */
  unregistered: string[];
  /** 插件声明了、但契约中不存在的命令（Rust 没有这个命令，或契约漏抽）。 */
  unknown: { plugin: string; command: string }[];
  /** 被多个插件同时声明的命令。 */
  duplicates: { command: string; plugins: string[] }[];
  /** 插件声明了、但运行时没有注册的命令（仅在提供 `registered` 时计算）。 */
  declaredNotRegistered: { plugin: string; command: string }[];
  /** 运行时注册了、但不在所属插件 `meta.commands` 中的命令（仅在提供 `registered` 时计算）。 */
  registeredNotDeclared: { plugin: string | null; command: string }[];
}

const byCommand = <T extends { command: string }>(a: T, b: T) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0);

export function checkCoverage(input: CoverageInput): CoverageReport {
  const declaredBy = new Map<string, string[]>();
  for (const meta of input.plugins) {
    for (const command of meta.commands ?? []) {
      const list = declaredBy.get(command) ?? [];
      if (!list.includes(meta.id)) list.push(meta.id);
      declaredBy.set(command, list);
    }
  }

  const unregistered = [...input.contracts.commands.keys()].filter((name) => !declaredBy.has(name)).sort();
  const unknown: CoverageReport['unknown'] = [];
  const duplicates: CoverageReport['duplicates'] = [];
  for (const [command, plugins] of declaredBy) {
    if (!input.contracts.get(command)) for (const plugin of plugins) unknown.push({ plugin, command });
    if (plugins.length > 1) duplicates.push({ command, plugins: [...plugins].sort() });
  }

  const declaredNotRegistered: CoverageReport['declaredNotRegistered'] = [];
  const registeredNotDeclared: CoverageReport['registeredNotDeclared'] = [];
  if (input.registered) {
    const registered = new Map(input.registered.map((r) => [r.command, r.plugin ?? null]));
    for (const meta of input.plugins) {
      for (const command of meta.commands ?? []) {
        if (registered.get(command) !== meta.id) declaredNotRegistered.push({ plugin: meta.id, command });
      }
    }
    for (const [command, plugin] of registered) {
      const owners = declaredBy.get(command) ?? [];
      if (plugin === null || !owners.includes(plugin)) registeredNotDeclared.push({ plugin, command });
    }
  }

  return {
    unregistered,
    unknown: unknown.sort(byCommand),
    duplicates: duplicates.sort(byCommand),
    declaredNotRegistered: declaredNotRegistered.sort(byCommand),
    registeredNotDeclared: registeredNotDeclared.sort(byCommand),
  };
}

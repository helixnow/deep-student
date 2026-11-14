/** Exact command selection for focused smoke runs; never silently drop names. */
export function selectCommands<T extends { name: string }>(registered: readonly T[], input?: string): T[] {
  if (!input) return [...registered];
  const names = input.split(',').map(name => name.trim());
  if (names.some(name => !name)) throw new Error('command selection contains an empty name');
  if (new Set(names).size !== names.length) throw new Error('command selection contains duplicate names');
  const byName = new Map(registered.map(command => [command.name, command]));
  const missing = names.filter(name => !byName.has(name));
  if (missing.length) throw new Error(`unknown or unregistered commands: ${missing.join(', ')}`);
  return names.map(name => byName.get(name)!);
}

/** Contiguous shard `i/n` (1-based) of an ordered selection, per C2 02:00Z: fixed
 * order, no overlap, and the n shards together cover the selection exactly. */
export function shardCommands<T>(selected: readonly T[], input?: string): { commands: T[]; shard: { index: number; count: number; from: number; to: number } | null } {
  if (!input) return { commands: [...selected], shard: null };
  const match = /^(\d+)\/(\d+)$/.exec(input.trim());
  if (!match) throw new Error(`DS_SMOKE_SHARD must be i/n, got ${JSON.stringify(input)}`);
  const index = Number(match[1]), count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`DS_SMOKE_SHARD ${input}: need 1 <= i <= n`);
  const from = Math.floor(selected.length * (index - 1) / count);
  const to = Math.floor(selected.length * index / count);
  return { commands: selected.slice(from, to), shard: { index, count, from, to } };
}

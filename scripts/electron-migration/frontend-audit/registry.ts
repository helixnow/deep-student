import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export interface PluginRecord { id: string; file: string; lane: string; commands: string[]; error?: string; basis?: 'kernel-registration' }
export interface Registry { mode: 'runtime-meta'; profile: string; plugins: PluginRecord[]; unprofiled?: PluginRecord[]; shellRoutes?: { command: string; file: string; line: number }[] }

/** Import the actual desktop profile modules, without apply(): no DB, network,
 * worker, shell or timer services are started. Import failures are audit failures.
 * The subprocess isolates module console output and guarantees no lingering handles.
 */
export function loadRegistry(root: string): Registry {
  const profileFile = 'host/profiles/desktop.json';
  const profile = JSON.parse(fs.readFileSync(path.join(root, profileFile), 'utf8'));
  const plugins: PluginRecord[] = [];
  for (const entry of profile.plugins) {
    const file = path.relative(root, path.resolve(root, path.dirname(profileFile), entry.module)).replaceAll('\\', '/');
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe', path.join(root, file)], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const marker = child.stdout?.split('\n').findLast(l => l.startsWith('FRONTEND_AUDIT_META='));
    const record: PluginRecord = marker ? { file, ...JSON.parse(marker.slice('FRONTEND_AUDIT_META='.length)) } : { id: entry.id, file, lane: 'HOST-LOAD', commands: [], error: child.error?.message ?? child.stderr?.trim().split('\n').slice(0, 5).join(' | ') ?? `exit ${child.status}` };
    if (record.error) {
      record.id = entry.id;
      // Ownership hint only: never recover command coverage from static text.
      record.lane = fs.readFileSync(path.join(root, file), 'utf8').match(/\blane:\s*['"]([^'"]+)['"]/)?.[1] ?? 'HOST-LOAD';
    }
    plugins.push(record);
  }
  const probe = (flag: string, file: string): PluginRecord => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), flag, path.join(root, file)], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const marker = child.stdout?.split('\n').findLast(l => l.startsWith('FRONTEND_AUDIT_META='));
    return marker ? { file, ...JSON.parse(marker.slice('FRONTEND_AUDIT_META='.length)) } : { file, id: file, lane: 'HOST-LOAD', commands: [], error: child.error?.message ?? child.stderr ?? `exit ${child.status}` };
  };
  plugins.push(probe('--probe-kernel', 'host/kernel/runtime.ts'));
  // The F2 implementation exists outside host/, but the official profile may
  // omit it. Keep its real imported metadata as off-profile evidence, not coverage.
  const unprofiled = fs.existsSync(path.join(root, 'electron/index.ts')) && !plugins.some(p => p.file === 'electron/index.ts') ? [probe('--probe', 'electron/index.ts')] : [];
  return { mode: 'runtime-meta', profile: profileFile, plugins, unprofiled };
}

if (process.argv[2] === '--probe') {
  const file = process.argv[3];
  if (!file) throw new Error('--probe requires a module path');
  try {
    const module = await import(pathToFileURL(file).href);
    const meta = module.default?.meta;
    if (!meta || !Array.isArray(meta.commands ?? [])) throw new Error('default export has no plugin meta');
    console.log('FRONTEND_AUDIT_META=' + JSON.stringify({ id: meta.id, lane: meta.lane ?? 'F1-kernel', commands: [...(meta.commands ?? [])].sort() }));
    process.exit(0);
  } catch (e) {
    console.log('FRONTEND_AUDIT_META=' + JSON.stringify({ id: path.basename(path.dirname(file)), lane: 'HOST-LOAD', commands: [], error: String(e).replaceAll(process.cwd() + '/', '') }));
    process.exit(1);
  }
}

if (process.argv[2] === '--probe-kernel') {
  const file = process.argv[3];
  if (!file) throw new Error('--probe-kernel requires a module path');
  try {
    const { HostRuntime } = await import(pathToFileURL(file).href);
    const { ContractSet } = await import(pathToFileURL(path.join(path.dirname(file), 'contracts.ts')).href);
    const runtime = new HostRuntime({ contracts: new ContractSet([]), app: { dataDir: process.cwd(), version: 'audit', platform: process.platform, debug: true } });
    console.log('FRONTEND_AUDIT_META=' + JSON.stringify({ id: 'kernel.builtins', lane: 'F1-kernel', commands: [...runtime.commands._registrations.keys()].sort(), basis: 'kernel-registration' }));
    process.exit(0);
  } catch (e) {
    console.log('FRONTEND_AUDIT_META=' + JSON.stringify({ id: 'kernel.builtins', lane: 'F1-kernel', commands: [], error: String(e) }));
    process.exit(1);
  }
}

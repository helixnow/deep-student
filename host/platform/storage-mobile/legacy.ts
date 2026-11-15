import type { Context } from '@deepseek-ai/cordis';
import { catalog } from '../../plugins/backup/src/asset-catalog.ts';
import type { DatabaseName } from '../storage/api.ts';
import type { MobileStorageService } from './service.ts';
import type { SqliteRuntime } from './sqlite-wasm.ts';

const DATABASE_NAMES = new Map<string, DatabaseName>([
  ['vfs.db', 'vfs'], ['chat_v2.db', 'chat_v2'], ['mistakes.db', 'mistakes'],
  ['llm_usage.db', 'llm_usage'], ['audit.db', 'audit'],
]);
const ACTIVE_FILES = new Set<string>([...catalog.map(([name]) => name), 'webview_settings.json', 'custom_grading_modes.json']);
const CHUNK = 512 * 1024;

interface LegacyFile {
  name: string;
  kind: 'database' | 'asset' | 'root';
  size: number;
}
interface LegacySnapshot {
  slot: string;
  token: string;
  files: LegacyFile[];
}

function destination(file: LegacyFile, storage: MobileStorageService): string {
  const segments = file.name.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[\\\0]/.test(segment))) {
    throw new Error(`Invalid legacy file path: ${file.name}`);
  }
  if (file.kind === 'asset' && ACTIVE_FILES.has(segments[0]!)) return `${storage.locations.activeDir}/${file.name}`;
  if (file.kind === 'root' && (file.name === '.master_key' || file.name === 'legacy/browser.db' || file.name.startsWith('.secure/'))) {
    return `${storage.locations.baseDir}/${file.name}`;
  }
  throw new Error(`Unknown legacy file: ${file.name}`);
}

/** Before schema migrations create empty pools. A crashed first copy is retried; the native files stay intact. */
export async function importLegacyNativeData(ctx: Context, storage: MobileStorageService, runtime: SqliteRuntime): Promise<void> {
  const importDb = runtime.importDb;
  if (!importDb) return;
  const marker = `${storage.locations.baseDir}/recovery/legacy-import-in-progress`;
  const interrupted = await ctx.files.exists(marker);
  if (!interrupted && [...DATABASE_NAMES.values()].some(name => runtime.exists(storage.pathOf(name)))) return;
  const snapshot = await ctx.shell.request<LegacySnapshot | null>('mobile:legacy-databases');
  if (snapshot === null) {
    if (interrupted) throw new Error('Cannot continue the previous Android data migration because its source is missing');
    return;
  }

  const read = async (file: LegacyFile, offset: number, length: number): Promise<Uint8Array> => {
    const bytes = await ctx.shell.request<Uint8Array>('mobile:legacy-file', {
      token: snapshot.token, name: file.name, kind: file.kind, offset, length,
    });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error(`Incomplete read of legacy ${file.name}`);
    return bytes;
  };

  try {
    const targets = new Set<string>();
    const mapped = snapshot.files.map(file => {
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`Invalid legacy file size: ${file.name}`);
      const database = file.kind === 'database' ? DATABASE_NAMES.get(file.name) : undefined;
      const path = database ? storage.pathOf(database) : destination(file, storage);
      if (targets.has(path)) throw new Error(`Duplicate legacy file: ${file.name}`);
      targets.add(path);
      return { file, database, path };
    });
    await ctx.files.writeAtomic(marker, snapshot.slot, { createParents: true });
    // Stage attachments and file-only secrets before creating the databases that reference them.
    for (const { file, database, path } of mapped) {
      if (database !== undefined) continue;
      const output = await ctx.files.openFile(path, { mode: 'truncate', createParents: true });
      try {
        for (let offset = 0; offset < file.size; offset += CHUNK) {
          await output.write(await read(file, offset, Math.min(CHUNK, file.size - offset)), offset);
        }
        await output.sync();
      } finally { await output.close(); }
    }
    for (const { file, database, path } of mapped) {
      if (database === undefined) continue;
      if (file.size < 512 || file.size % 512 !== 0 || file.size > 1024 ** 3) throw new Error(`Invalid legacy database: ${file.name}`);
      const bytes = new Uint8Array(file.size);
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        bytes.set(await read(file, offset, Math.min(CHUNK, file.size - offset)), offset);
      }
      if (new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') throw new Error(`Invalid SQLite header: ${file.name}`);
      if (await importDb.call(runtime, path, bytes) !== bytes.byteLength) throw new Error(`Incomplete import of legacy ${file.name}`);
    }
    await ctx.files.rm(marker, { force: true });
    ctx.logger('storage').info(`Imported ${mapped.length} legacy Android files from ${snapshot.slot}`);
  } finally {
    await ctx.shell.request('mobile:legacy-close', { token: snapshot.token }).catch(error => {
      ctx.logger('storage').warn(`Unable to release the legacy Android snapshot: ${String(error)}`);
    });
  }
}

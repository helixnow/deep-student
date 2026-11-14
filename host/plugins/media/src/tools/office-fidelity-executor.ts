/**
 * `src/chat_v2/tools/office_fidelity_executor.rs`: read-only `office_fidelity_inspect`.
 * The source is a `TaskObjectHandle` addressed either by a managed runtime-root
 * locator or by an authorized Deep Student VFS provider reference; a declared
 * `sha256` must still match the bytes read.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, sep } from '../../../../platform/util/path.ts';
import type { RuntimeRootsService } from '../../../agent-workspace/api.ts';
import { normalizeRuntimeRelativePath } from '../../../agent-workspace/api.ts';
import type { ToolCall, ToolConcurrency, ToolResultInfo } from '../../../chat/api.ts';
import { stripToolNamespace } from '../document-processing.ts';
import { MAX_SOURCE_BYTES, inspectBytes } from '../office-fidelity.ts';
import { taskObjectHandleFromWire, type TaskObjectHandle } from '../task-objects.ts';
import {
  argumentsOf, errorText, firstPresent, runToolCall, type MediaToolContext, type ToolLogger,
} from './runtime.ts';
import type { VfsFileRepos } from './vfs-source.ts';

const NAME = 'OfficeFidelityExecutor';

export interface OfficeFidelityDeps {
  repos(): VfsFileRepos;
  runtimeRoots(): RuntimeRootsService | null;
  log: ToolLogger;
}

function parseSource(args: Record<string, unknown>): TaskObjectHandle {
  const source = firstPresent(args.source, args);
  const sourceObject = argumentsOf(source);
  const wire = firstPresent(sourceObject.object_handle, sourceObject.objectHandle, source);
  let handle: TaskObjectHandle;
  try {
    handle = taskObjectHandleFromWire(wire);
    handle.validate();
  } catch (error) { throw new Error(`OFFICE_FIDELITY_INVALID_SOURCE: ${errorText(error)}`); }
  if (!handle.capabilities.readable) throw new Error('OFFICE_FIDELITY_UNAUTHORIZED: source is not readable');
  return handle;
}

async function readBounded(path: string): Promise<Buffer> {
  let size: number;
  try { size = (await stat(path)).size; }
  catch (error) { throw new Error(`OFFICE_FIDELITY_SOURCE_READ_FAILED: ${errorText(error)}`); }
  if (size > MAX_SOURCE_BYTES) {
    throw new Error(`OFFICE_FIDELITY_TOO_LARGE: ${size} bytes exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  try { return await readFile(path); }
  catch (error) { throw new Error(`OFFICE_FIDELITY_SOURCE_READ_FAILED: ${errorText(error)}`); }
}

export class OfficeFidelityExecutor {
  private readonly deps: OfficeFidelityDeps;

  constructor(deps: OfficeFidelityDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean { return stripToolNamespace(toolName) === 'office_fidelity_inspect'; }

  sensitivityLevel(_toolName: string): 'low' { return 'low'; }

  concurrencyClass(_toolName: string): ToolConcurrency { return 'read_only'; }

  async execute(call: ToolCall, context: MediaToolContext): Promise<ToolResultInfo> {
    return runToolCall(NAME, call, context, this.deps.log, async () => {
      const [handle, bytes] = await this.loadSource(argumentsOf(call.arguments), context);
      const output = inspectBytes(bytes);
      output.ok = true;
      output.sourceHandleId = handle.handleId;
      output.sourceDisplayName = handle.displayName;
      return output;
    });
  }

  private async loadSource(args: Record<string, unknown>, context: MediaToolContext): Promise<[TaskObjectHandle, Buffer]> {
    const handle = parseSource(args);
    let bytes: Buffer;
    if (handle.locator !== null) {
      const relative = normalizeRuntimeRelativePath(handle.locator.relativePath);
      const roots = this.deps.runtimeRoots();
      if (roots === null) throw new Error('OFFICE_FIDELITY_UNAVAILABLE: runtime root service is not registered');
      const root = roots.rootById(handle.locator.rootId, {
        session_id: context.session_id, skill_package_roots: context.skill_package_roots,
      });
      const rootCanon = roots.revalidate(root);
      let target: string;
      try { target = realpathSync.native(join(rootCanon, relative)); }
      catch (error) { throw new Error(`OFFICE_FIDELITY_SOURCE_NOT_FOUND: ${errorText(error)}`); }
      const inside = target === rootCanon || target.startsWith(rootCanon.endsWith(sep) ? rootCanon : rootCanon + sep);
      let isFile = false;
      try { isFile = statSync(target).isFile(); }
      catch { isFile = false; }
      if (!inside || !isFile) throw new Error('OFFICE_FIDELITY_UNAUTHORIZED: source escaped its runtime root');
      bytes = await readBounded(target);
    } else if (handle.providerRef !== null) {
      if (handle.providerRef.provider !== 'deep-student-vfs') {
        throw new Error('OFFICE_FIDELITY_UNSUPPORTED_SOURCE: provider reference is not an authorized Deep Student VFS file');
      }
      const database = context.vfs_db;
      if (database === null) throw new Error('OFFICE_FIDELITY_UNAVAILABLE: VFS database is not registered');
      const repos = this.deps.repos();
      let file;
      try { file = repos.files.getFile(database.getConnSafe(), handle.providerRef.externalId); }
      catch (error) { throw new Error(`OFFICE_FIDELITY_SOURCE_READ_FAILED: ${errorText(error)}`); }
      if (file === null) throw new Error('OFFICE_FIDELITY_SOURCE_NOT_FOUND: VFS file does not exist');
      if (file.blobHash === undefined) {
        throw new Error('OFFICE_FIDELITY_UNSUPPORTED_SOURCE: VFS file has no managed blob');
      }
      let blobPath: string | null;
      try { blobPath = repos.blobs.getBlobPath(database.getConnSafe(), database.blobsDir(), file.blobHash); }
      catch (error) { throw new Error(`OFFICE_FIDELITY_SOURCE_READ_FAILED: ${errorText(error)}`); }
      if (blobPath === null) throw new Error('OFFICE_FIDELITY_SOURCE_NOT_FOUND: VFS blob does not exist');
      bytes = await readBounded(blobPath);
    } else {
      throw new Error('OFFICE_FIDELITY_UNSUPPORTED_SOURCE: source needs a managed locator or authorized Deep Student VFS provider reference');
    }
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    if (handle.sha256 !== null && handle.sha256.toLowerCase() !== sourceHash) {
      throw new Error('OFFICE_FIDELITY_SOURCE_CHANGED: TaskObjectHandle SHA-256 mismatch');
    }
    return [handle, bytes];
  }
}

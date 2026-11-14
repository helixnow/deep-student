import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../kernel/agent-api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import {
  NotesImportExecutor, normalizeRuntimeRelativePath, resolveStagedFileInTempRoot,
  type NotesImportExecutorPorts,
} from '../src/notes-import-tool.ts';
import { setNotesLocalRuntime } from '../src/local-runtime.ts';
import { nodeNotesLocalRuntime } from '../src/local-runtime.node.ts';

// This suite drives the executor directly instead of installing the plugin.
beforeAll(() => { setNotesLocalRuntime(nodeNotesLocalRuntime); });
afterAll(() => { setNotesLocalRuntime(null); });

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'notes-import-executor-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executor(root: string): NotesImportExecutor {
  const ports: NotesImportExecutorPorts = {
    conn: () => ({} as SqlExecutor),
    settings: () => ({} as SettingsStore),
    baseDir: root,
  };
  return new NotesImportExecutor(ports);
}

function context(root: string): ExecutionContext {
  return {
    ids: { sessionId: 'session-1', messageId: 'message-1', blockId: 'block-1', toolCallId: 'call-1', round: 0 },
    runtimeRoots: { tempRoot: () => root },
    host: { hasFrontend: () => false, emit: () => undefined },
    isCancelled: () => false,
  } as unknown as ExecutionContext;
}

function call(args: Record<string, unknown>) {
  return { id: 'call-1', name: 'builtin-notes_import', arguments: args };
}

async function failure(args: Record<string, unknown>, root: string): Promise<string> {
  const result = await executor(root).execute(call(args), context(root));
  expect(result.success).toBe(false);
  expect(result.output).toBeNull();
  return result.error!;
}

describe('notes_import_executor execute', () => {
  it('rejects_non_temp_root_id', async () => {
    const root = tempRoot();
    await expect(failure({ root_id: 'workspace', relative_path: 'a.zip' }, root))
      .resolves.toBe("notes_import only accepts root_id=temp (staged attachments), got 'workspace'");
  });

  it('rejects_missing_relative_path', async () => {
    const root = tempRoot();
    await expect(failure({ root_id: 'temp' }, root))
      .resolves.toBe("Missing 'relative_path' parameter (use the path returned by attachment_stage)");
  });

  it('rejects_unknown_conflict_strategy_before_import', async () => {
    const root = tempRoot();
    await expect(failure({ relative_path: 'a.zip', conflict_strategy: 'bogus' }, root))
      .resolves.toBe("Invalid conflict_strategy 'bogus': expected skip, overwrite or merge_keep_newer");
  });

  it('rejects_parent_dir_traversal', async () => {
    const root = tempRoot();
    await expect(failure({ relative_path: '../evil.zip' }, root))
      .resolves.toBe('Parent directory traversal is not allowed');
  });

  it('rejects_absolute_path', async () => {
    const root = tempRoot();
    await expect(failure({ relative_path: '/tmp/evil.zip' }, root))
      .resolves.toBe('Path must be relative to the selected runtime root');
  });

  it('rejects_symlinked_staged_file', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const target = join(outside, 'outside.zip');
    writeFileSync(target, 'zip');
    symlinkSync(target, join(root, 'link.zip'));
    await expect(failure({ relative_path: 'link.zip' }, root))
      .resolves.toBe('Staged path must be a regular file');
  });

  it('reports_missing_staged_file', async () => {
    const root = tempRoot();
    await expect(failure({ relative_path: 'missing.zip' }, root))
      .resolves.toBe('Staged file not found: missing.zip');
  });

  it('normalizes_safe_nested_paths_and_accepts_regular_files', () => {
    expect(normalizeRuntimeRelativePath(' . ')).toBe('');
    expect(normalizeRuntimeRelativePath('a/./b.zip')).toBe('a/b.zip');
    const root = tempRoot();
    mkdirSync(join(root, 'nested'));
    const file = join(root, 'nested', 'ok.zip');
    writeFileSync(file, 'zip');
    expect(resolveStagedFileInTempRoot(root, 'nested/ok.zip')).toBe(realpathSync.native(file));
  });
});

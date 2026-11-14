import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { MissingExecutorError } from '../../../kernel/api.ts';
import { BackendEventsSink, ChatV2Emitter } from '../../chat/api.ts';
import type { ChatExecutionContext } from '../../chat/api.ts';
import { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs, tempRoot } from '../../agent-workspace/api.ts';
import { DstuToolExecutor, type DstuUploadPort } from '../src/tools/dstu-executor.ts';

interface UploadResult {
  sourceId: string; resourceHash: string; isNew: boolean;
  file: { id: string; resourceId?: string; fileName: string; mimeType?: string; size: number; blobHash?: string };
}
interface ToolUpload {
  success: true; action: 'upload_file'; source_id: string; resource_id: string | null; path: string; name: string;
  mime_type: string | null; size: number; folder_id: string | null; is_new: boolean; resource_hash: string;
  node: { id: string; path: string }; entity_ids: string[];
}
interface FileRow { id: string; sha256: string; file_name: string; size: number; mime_type: string; blob_hash: string | null; status: string }

it('official profile provides dstuUpload from the registered vfs_upload_file entry and DstuToolExecutor uploads through it', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l13-dstu-upload-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  try {
    new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
      store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
    const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
    expect(loaded.degraded).toEqual([]);
    expect(loaded.installed.map(entry => entry.id)).toContain('dstu.vfs');

    // dstu_executor.rs:363/685 consult VfsAttachmentRepo; the port reads the same L11 policy.
    const port = host.ctx.get('dstuUpload') as DstuUploadPort | undefined;
    if (port === undefined) throw new Error('dstuUpload is not provided by the official profile');
    const attachments = host.ctx.vfsRepo.attachments;
    for (const [name, mime] of [['a.mp3', 'audio/mpeg'], ['a.exe', 'application/x-msdownload'], ['a.ts', 'application/octet-stream'], ['a', '']] as const) {
      expect(port.isSupportedUploadType(name, mime), `${name} ${mime}`).toBe(attachments.isSupportedUploadType(name, mime));
    }
    for (const mime of ['image/png', ' IMAGE/JPEG ', 'application/pdf']) expect(port.maxUploadSizeBytes(mime)).toBe(attachments.maxUploadSizeBytes(mime));

    const executors = host.ctx.agentTools.toolExecutors().filter(executor => executor.name() === 'DstuToolExecutor');
    expect(executors).toHaveLength(1);
    const executor = executors[0];
    if (!(executor instanceof DstuToolExecutor)) throw new Error('expected the production DstuToolExecutor');
    const policy = { ignoresBroadApprovalBypassForArgs, neverRememberApprovalForArgs };
    try { host.ctx.chatSession.assembleExecutorRegistry([], policy, false); }
    catch (error) {
      if (!(error instanceof MissingExecutorError)) throw error;
      expect(error.names).not.toContain('DstuToolExecutor');
    }
    const chat = host.ctx.chatSession;
    const registry = chat.createExecutorRegistry([executor], policy);
    expect(registry.getExecutor('builtin-dstu_upload_file')).toBe(executor);

    const stamp = '2026-11-06T00:00:00Z';
    chat.createSession({ id: 'sess_d29', mode: 'chat', titleLocked: false, persistStatus: 'active', createdAt: stamp, updatedAt: stamp });
    const temp = tempRoot(host.app.dataDir, 'sess_d29', true).path;
    const emitter = ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_d29', false);
    let sequence = 0;
    const context = (): ChatExecutionContext => {
      const id = ++sequence;
      const value = chat.createExecutionContext({ sessionId: 'sess_d29', messageId: `msg_d29_${id}`, blockId: `blk_d29_${id}`,
        emitter, services: host.ctx, window: { window: 'main', webview: 'main' }, toolRegistry: host.ctx.mcp.registry });
      value.chat_v2_db = chat.database;
      return value;
    };
    host.window({ window: 'main', webview: 'main' }, 'created');
    const hooks = host.ctx.vfs.resourceCreatedHooks;
    if (hooks === undefined) throw new Error('vfs.resourceCreatedHooks is not provided');
    const created: string[] = [];
    const unregister = hooks.register(id => { created.push(id); });
    const conn = host.ctx.vfsDatabase.getConnSafe();
    const rows = (sha: string) => conn.all<FileRow>('SELECT id, sha256, file_name, size, mime_type, blob_hash, status FROM files WHERE sha256 = ?1', [sha]);
    const fileCount = () => conn.pluck<number>('SELECT COUNT(*) FROM files') ?? 0;
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const tool = (args: Record<string, unknown>, ctx = context()) => registry.execute({ id: `call_${sequence}`, name: 'builtin-dstu_upload_file', arguments: args }, ctx);
    const ipc = (params: Record<string, unknown>) => host.invoke<UploadResult>('vfs_upload_file', { params });
    const changes = () => host.eventsNamed('dstu:change') as Array<{ type: string; path: string; node: { id: string } }>;

    // 1. Tool creates the file; the row and media hook come from the same vfs_upload_file body.
    const audio = Buffer.from('ID3 d29 audio payload one');
    fs.writeFileSync(path.join(temp, 'clip.mp3'), audio);
    const first = await tool({ root_id: 'temp', relative_path: 'clip.mp3' });
    expect(first.success, first.error ?? '').toBe(true);
    const out = first.output as ToolUpload;
    expect(out).toMatchObject({ success: true, action: 'upload_file', name: 'clip.mp3', mime_type: 'audio/mpeg', size: audio.length,
      folder_id: null, is_new: true, resource_hash: sha(audio) });
    expect(out.entity_ids).toEqual([out.source_id]);
    expect(rows(sha(audio))).toEqual([{ id: out.source_id, sha256: sha(audio), file_name: 'clip.mp3', size: audio.length,
      mime_type: 'audio/mpeg', blob_hash: sha(audio), status: 'active' }]);
    expect(created).toEqual([out.source_id]);
    expect(changes().filter(event => event.node.id === out.source_id).map(event => event.type)).toEqual(['created']);
    expect(chat.getBlock(first.blockId ?? '')).toMatchObject({ status: 'success' });

    // 2. IPC with the same bytes takes the sha256 reuse branch of the same implementation.
    const reused = await ipc({ name: 'clip.mp3', mimeType: 'audio/mpeg', base64Content: audio.toString('base64') });
    expect(reused).toMatchObject({ sourceId: out.source_id, resourceHash: out.resource_hash, isNew: false });
    expect(reused.file).toMatchObject({ id: out.source_id, fileName: 'clip.mp3', size: audio.length });
    expect(out.resource_id).toBe(reused.file.resourceId ?? null);
    expect(rows(sha(audio))).toHaveLength(1);
    expect(created).toEqual([out.source_id]);

    // 3. IPC creates; the tool then reuses the IPC row and reports the updated event.
    const audio2 = Buffer.from('ID3 d29 audio payload two');
    const viaIpc = await ipc({ name: 'second.mp3', mimeType: 'audio/mpeg', base64Content: audio2.toString('base64') });
    expect(viaIpc.isNew).toBe(true);
    expect(created).toEqual([out.source_id, viaIpc.sourceId]);
    fs.writeFileSync(path.join(temp, 'second.mp3'), audio2);
    const again = await tool({ root_id: 'temp', relative_path: 'second.mp3' });
    expect(again.success, again.error ?? '').toBe(true);
    expect(again.output).toMatchObject({ source_id: viaIpc.sourceId, resource_hash: viaIpc.resourceHash, is_new: false,
      name: viaIpc.file.fileName, size: viaIpc.file.size, mime_type: viaIpc.file.mimeType ?? null, resource_id: viaIpc.file.resourceId ?? null });
    expect(changes().filter(event => event.node.id === viaIpc.sourceId).map(event => event.type)).toEqual(['updated']);
    expect(rows(sha(audio2))).toHaveLength(1);
    expect(created).toHaveLength(2);

    // 4. ≥1 MiB non-media file: blob written by the shared savepoint path, no media hook.
    const large = Buffer.alloc(1024 * 1024 + 7, 'a');
    fs.writeFileSync(path.join(temp, 'big.txt'), large);
    const big = await tool({ root_id: 'temp', relative_path: 'big.txt' });
    expect(big.success, big.error ?? '').toBe(true);
    const bigRows = rows(sha(large));
    expect(bigRows).toHaveLength(1);
    const bigRow = bigRows[0] as FileRow;
    if (bigRow.blob_hash === null) throw new Error('expected a blob for a >=1 MiB upload');
    const blob = conn.get<{ relative_path: string; size: number }>('SELECT relative_path, size FROM blobs WHERE hash = ?1', [bigRow.blob_hash]);
    if (blob === undefined || blob === null) throw new Error('blob row missing');
    expect(blob.size).toBe(large.length);
    expect(fs.statSync(path.join(host.ctx.vfsDatabase.blobsDir(), blob.relative_path)).size).toBe(large.length);
    const bigIpc = await ipc({ name: 'big.txt', mimeType: 'text/plain', base64Content: large.toString('base64') });
    expect(bigIpc).toMatchObject({ sourceId: bigRow.id, isNew: false });
    expect(created).toHaveLength(2);

    // 5. Errors: both paths reject before any write.
    const count = fileCount();
    fs.writeFileSync(path.join(temp, 'tool.exe'), 'MZ');
    const exe = await tool({ root_id: 'temp', relative_path: 'tool.exe' });
    expect(exe.success).toBe(false);
    expect(JSON.parse(exe.error ?? '')).toEqual({ code: 'UNSUPPORTED_FILE_TYPE', message: 'unsupported file type: tool.exe (application/octet-stream)',
      hint: 'Use a supported image, PDF, Office, text, ebook, audio, or video file.', retryable: false });
    await expect(ipc({ name: 'tool.exe', mimeType: 'application/octet-stream', base64Content: Buffer.from('MZ').toString('base64') }))
      .rejects.toBe("Invalid argument 'mime_type': UNSUPPORTED_FILE_TYPE: 不支持的文件类型 .exe (文件: tool.exe, MIME: application/octet-stream)");

    const max = port.maxUploadSizeBytes('image/png');
    expect(max).toBe(50 * 1024 * 1024);
    const oversized = path.join(temp, 'huge.png');
    fs.writeFileSync(oversized, '');
    fs.truncateSync(oversized, max + 1);
    const huge = await tool({ root_id: 'temp', relative_path: 'huge.png' });
    expect(huge.success).toBe(false);
    expect(JSON.parse(huge.error ?? '')).toEqual({ code: 'UPLOAD_TOO_LARGE', message: `file is ${max + 1} bytes; maximum for this type is ${max} bytes`,
      hint: 'Choose a smaller file.', retryable: false });
    await expect(ipc({ name: 'huge.png', mimeType: 'image/png', base64Content: fs.readFileSync(oversized).toString('base64') }))
      .rejects.toBe("Invalid argument 'base64_content': File too large: max 50MB, got 50.00MB");
    expect(fileCount()).toBe(count);

    // A business error raised inside vfs_upload_file reaches the tool as the same raw text, wrapped once.
    const orphan = Buffer.from('folder target missing');
    fs.writeFileSync(path.join(temp, 'orphan.txt'), orphan);
    let ipcError = '';
    await ipc({ name: 'orphan.txt', mimeType: 'text/plain', base64Content: orphan.toString('base64'), folderId: 'fld_missing0000' })
      .then(() => { throw new Error('expected vfs_upload_file to reject'); }, (error: unknown) => { ipcError = String(error); });
    expect(ipcError).toContain('fld_missing0000');
    const missing = await tool({ root_id: 'temp', relative_path: 'orphan.txt', folder_id: 'fld_missing0000' });
    expect(missing.success).toBe(false);
    expect(JSON.parse(missing.error ?? '')).toEqual({ code: 'DSTU_OPERATION_FAILED', message: `upload file failed: ${ipcError}`,
      hint: 'Refresh the target resource and verify that its path still exists before retrying.', retryable: false });
    expect(rows(sha(orphan))).toEqual([]);

    // Cancelled after reading the source: no VFS mutation (dstu_executor.rs:695-702).
    const cancelledAudio = Buffer.from('ID3 d29 cancelled payload');
    fs.writeFileSync(path.join(temp, 'cancel.mp3'), cancelledAudio);
    const cancelled = context();
    const abort = new AbortController(); abort.abort(); cancelled.cancellation_token = abort.signal;
    const stopped = await executor.execute({ id: 'cancel', name: 'builtin-dstu_upload_file', arguments: { root_id: 'temp', relative_path: 'cancel.mp3' } }, cancelled);
    expect(stopped.success).toBe(false);
    expect(JSON.parse(stopped.error ?? '')).toMatchObject({ code: 'CANCELLED', retryable: true });
    expect(rows(sha(cancelledAudio))).toEqual([]);
    expect(fileCount()).toBe(count);
    expect(created).toHaveLength(2);
    unregister();
  } finally {
    await host.dispose();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  }
}, 180_000);

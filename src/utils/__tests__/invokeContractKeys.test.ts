import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectInvokeCallsMatchContract } from '../../__tests__/helpers/ipcContract';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, convertFileSrc: (p: string) => `asset://localhost/${p}` }));
vi.mock('../shared', () => ({
  isTauriRuntime: true,
  invokeWithDebug: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  withGraphId: (id?: string) => (id ? { graphId: id } : {}),
}));

import { getImageAsBase64 } from '../configApi';
import { NotesAPI } from '../notesApi';
import { testApiConnection } from '../settingsApi';
import { setTestRunId, ocrExtractText } from '../testApi';
import { copyFile } from '../chatApi';
import { refreshRequiresGates, getRequiresGate } from '../../features/chat/skills/requiresGating';
import type { SkillDefinition } from '../../features/chat/skills/types';

// kernel 只按契约键取参数（host/kernel/contracts.ts checkArgs），Tauri v2 命令默认也只认 camelCase；
// 契约外的键会被静默丢弃，缺失必填键则整次调用被拒绝。
describe('front-end invoke payloads use contract keys', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('get_image_as_base64 sends only relativePath and surfaces the real backend error', async () => {
    invokeMock.mockRejectedValue(new Error('图片不存在: a.png'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('asset fetch failed')));
    await expect(getImageAsBase64('images/a.png')).rejects.toThrow('图片不存在: a.png');
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'get_image_as_base64');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('notes_list_deleted forwards pageSize (page_size was dropped)', async () => {
    invokeMock.mockResolvedValue({ items: [], total: 0 });
    await NotesAPI.listDeleted(2, 50);
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'notes_list_deleted');
    expect(invokeMock).toHaveBeenCalledWith('notes_list_deleted', expect.objectContaining({ page: 2, pageSize: 50 }));
  });

  it('skill_probe_requires sends pythonPackages', async () => {
    invokeMock.mockResolvedValue({ bins: [], env: [], python_packages: [{ name: 'numpy', found: false }], invalid: [], missing_count: 1 });
    const skill = { id: 'py-skill', requires: { pythonPackages: ['numpy'] } } as unknown as SkillDefinition;
    await refreshRequiresGates([skill]);
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'skill_probe_requires');
    expect(invokeMock).toHaveBeenCalledWith('skill_probe_requires', { bins: [], env: [], pythonPackages: ['numpy'] });
    expect(getRequiresGate('py-skill')).toMatchObject({ satisfied: false, missingPythonPackages: ['numpy'] });
  });

  it('test_api_connection helper sends required apiKey/apiBase', async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await testApiConnection('sk-x', 'https://api.example.com/v1', 'm', true, false);
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'test_api_connection');
    expect(invokeMock).toHaveBeenCalledWith('test_api_connection', expect.objectContaining({ apiKey: 'sk-x', apiBase: 'https://api.example.com/v1', isEmbedding: true, isReranker: false }));
  });

  it('set_test_run_id, ocr_extract_text and copy_file send contract keys only', async () => {
    invokeMock.mockResolvedValue({ success: true, test_run_id: 'r1' });
    await setTestRunId('r1');
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'set_test_run_id');

    invokeMock.mockReset();
    invokeMock.mockResolvedValue('text');
    await ocrExtractText({ imageBase64: 'data:image/png;base64,AA==' }, 0);
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'ocr_extract_text');

    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    await copyFile('/a/src.txt', '/b/dst.txt');
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'copy_file');
    expect(invokeMock).toHaveBeenCalledWith('copy_file', { sourcePath: '/a/src.txt', destPath: '/b/dst.txt' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import { inkApi } from './api';
import type { InkManifest, InkPage } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe('Ink API transport boundary', () => {
  beforeEach(() => invokeMock.mockReset());

  it('forwards the original page and expected revision in the nested request', async () => {
    const page: InkPage = { schema_version: 1, page_id: 'page-1', objects: [] };
    const request = {
      document_id: 'ink-document',
      expected_revision: 'revision-3',
      operation_id: 'save-1',
      page,
    };
    const manifest = { document_id: request.document_id, revision: 'revision-4' } as InkManifest;
    invokeMock.mockResolvedValueOnce(manifest);

    await inkApi.savePage(request);

    expect(invokeMock).toHaveBeenCalledWith('vfs_ink_save_page', { request });
    expect((invokeMock.mock.calls[0][1] as { request: typeof request }).request.page).toBe(page);
    expect((invokeMock.mock.calls[0][1] as { request: typeof request }).request.expected_revision).toBe('revision-3');
  });

  it('forwards prepare and export identities as explicit job command inputs', async () => {
    const prepared = { document_id: 'prepared-ink-doc', revision: 'r1' } as InkManifest;
    const exported = { file_id: 'file-export', resource_id: 'resource-export' };
    invokeMock.mockResolvedValueOnce(prepared).mockResolvedValueOnce(exported);
    const prepareRequest = { source_resource_id: 'source-resource', operation_id: 'prepare-op' };
    const exportRequest = {
      document_id: 'prepared-ink-doc', expected_revision: 'r1', page_ids: ['page-1'], format: 'png' as const, operation_id: 'export-op',
    };

    await expect(inkApi.prepareSource(prepareRequest)).resolves.toBe(prepared);
    await expect(inkApi.exportDocument(exportRequest, { session_id: 'session-1', tool_call_id: 'call-1' })).resolves.toBe(exported);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'vfs_ink_prepare', { request: prepareRequest, sessionId: undefined, toolCallId: undefined });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'vfs_ink_export', {
      request: exportRequest, sessionId: 'session-1', toolCallId: 'call-1',
    });
  });

  it('rejects with the structured code and current revision intact', async () => {
    const failure = {
      code: 'REVISION_CONFLICT',
      message: 'The document changed.',
      hint: 'Reload before retrying.',
      retryable: true,
      current_revision: 'revision-5',
    };
    invokeMock.mockRejectedValueOnce(failure);

    await expect(inkApi.getPage({ document_id: 'ink-document', page_id: 'page-1' })).rejects.toMatchObject({
      name: 'InkApiError',
      code: 'REVISION_CONFLICT',
      message: 'The document changed.',
      current_revision: 'revision-5',
    });
  });
});

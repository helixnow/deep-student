import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  getBatchPdfProcessingStatus,
  getPdfProcessingStatus,
} from '@/api/vfsPdfProcessingApi';

const invokeMock = vi.mocked(invoke);

describe('vfsPdfProcessingApi normalization', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('normalizes backend batch HashMap payload into { statuses } shape', async () => {
    invokeMock.mockResolvedValueOnce({
      att_1: {
        fileId: 'att_1',
        stage: 'ocr_processing',
        progress: {
          stage: 'ocr_processing',
          currentPage: 2,
          totalPages: 5,
          percent: 45,
          readyModes: ['text'],
          mediaType: 'pdf',
        },
      },
    });

    const result = await getBatchPdfProcessingStatus(['att_1']);

    expect(result.statuses.att_1).toEqual({
      stage: 'ocr_processing',
      currentPage: 2,
      totalPages: 5,
      percent: 45,
      readyModes: ['text'],
      mediaType: 'pdf',
    });
  });

  it('normalizes single status payload with nested progress', async () => {
    invokeMock.mockResolvedValueOnce({
      fileId: 'att_2',
      stage: 'vector_indexing',
      progress: {
        stage: 'vector_indexing',
        percent: 90,
        readyModes: ['text', 'image'],
      },
      error: null,
    });

    const result = await getPdfProcessingStatus('att_2');

    expect(result).toEqual({
      stage: 'vector_indexing',
      percent: 90,
      readyModes: ['text', 'image'],
    });
  });
});

import React, { useEffect, useState } from 'react';
import { ctListenerCount, dispatchCtEvent } from '../mocks/tauri-event-mock';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import { registerInkJobBridge, type InkJobRequest, type InkJobResponse } from '@/features/ink/jobBridge';
import type { InkPage, InkPageRef } from '@/features/ink/types';

const sourcePage: InkPage = {
  schema_version: 1,
  page_id: 'job-export-page',
  objects: [{
    id: 'job-export-red-rect', author: 'user', created_at: 1,
    content: { kind: 'rect', rect: { x: 12, y: 10, width: 20, height: 18 }, color: '#ff0000', width: 4 },
  }],
};

const sourceRef: InkPageRef = {
  page_id: sourcePage.page_id, width: 64, height: 48,
  background: { kind: 'image', blob_hash: 'job-frozen-background' },
  page_blob_hash: 'job-frozen-page',
};

function pngFixture(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  context.fillStyle = '#dddddd';
  context.fillRect(0, 0, 64, 48);
  context.fillStyle = '#1450cc';
  context.fillRect(4, 4, 10, 10);
  return canvas.toDataURL('image/png').split(',')[1];
}

async function profile(version: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version)));
  return `ink-image-pages-v1-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

declare global {
  interface Window {
    __INK_JOB_CT__?: {
      response?: InkJobResponse;
      failure?: string;
      dispatched?: number;
      listenerCount?: number;
      uploads: Record<string, number[]>;
      calls: Array<{ command: string; payload?: Record<string, unknown> }>;
      publish?: () => void;
    };
  }
}

export function InkJobsHarness({ mode }: { mode: 'prepare' | 'export' }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('ready');
  useEffect(() => {
    const pngBase64 = pngFixture();
    const state: NonNullable<Window['__INK_JOB_CT__']> = { uploads: {}, calls: [] };
    window.__INK_JOB_CT__ = state;
    state.publish = () => setStatus(state.failure ?? (state.response ? 'done' : 'ready'));
    let nextUpload = 0;
    let currentUploadId: string | undefined;
    setCtInvokeHandlers({
      vfs_get_blob_base64: () => ({ base64: pngBase64, mimeType: 'image/png', size: atob(pngBase64).length }),
      staged_upload_begin: (_command, payload) => {
        currentUploadId = `ink-job-upload-${++nextUpload}`;
        state.uploads[currentUploadId] = [];
        return currentUploadId;
      },
      staged_upload_append: (_command, payload) => {
        const bytes = payload as unknown as ArrayLike<number>;
        const uploadId = currentUploadId;
        if (!uploadId) throw new Error('Staged upload was not begun');
        state.uploads[uploadId]?.push(...Array.from(bytes));
        return bytes.length;
      },
      staged_upload_abort: () => undefined,
      vfs_ink_job_result: (_command, payload) => {
        const response = (payload as unknown as { response: InkJobResponse }).response;
        state.response = response;
        if (response.error) state.failure = `${response.error.code}: ${response.error.message}`;
        state.publish?.();
      },
    });
    let stop: (() => void) | undefined;
    let active = true;
    void registerInkJobBridge().then((unregister) => {
      stop = unregister;
      if (active) setReady(true);
      else unregister();
    });
    return () => { active = false; stop?.(); };
  }, []);

  const trigger = async () => {
    const state = window.__INK_JOB_CT__;
    if (!state) throw new Error('Ink job CT is not initialized');
    if (mode === 'prepare') {
      const expected = 'browser-imagebitmap-v1;png-pages-v1;max-edge-2048';
      const request: InkJobRequest = {
        request_id: 'job-prepare-ct-1', operation_id: 'prepare-job-ct-1', kind: 'prepare',
        payload: {
          kind: 'prepare', source_resource_id: 'source-resource-ct',
          source_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          file_name: 'source.png', mime_type: 'image/png', source_bytes_base64: pngFixture(),
          converter_profile: await profile(expected), expected_converter_version: expected,
        },
      };
      state.listenerCount = ctListenerCount('ink:job-request');
      try {
        await dispatchCtEvent('ink:job-request', request);
        state.dispatched = (state.dispatched ?? 0) + 1;
        state.publish?.();
      } catch (error) {
        state.failure = `dispatch: ${String(error)}`;
        state.publish?.();
      }
    } else {
      const request: InkJobRequest = {
        request_id: 'job-export-ct-1', operation_id: 'export-job-ct-1', kind: 'export',
        payload: { kind: 'export', document_id: 'ink-doc-ct', revision: 'r-ct-1', page_ids: [sourcePage.page_id], format: 'png',
          pages: [{ page_ref: sourceRef, page: sourcePage, highlights: [] }] },
      };
      state.listenerCount = ctListenerCount('ink:job-request');
      try {
        await dispatchCtEvent('ink:job-request', request);
        state.dispatched = (state.dispatched ?? 0) + 1;
        state.publish?.();
      } catch (error) {
        state.failure = `dispatch: ${String(error)}`;
        state.publish?.();
      }
    }
  };

  return <div>
    <button type="button" data-testid="ink-job-ready" disabled={!ready} onClick={() => void trigger()}>{mode}</button>
    <output data-testid="ink-job-status">{status}</output>
    <output data-testid="ink-job-listeners">{window.__INK_JOB_CT__?.listenerCount ?? ctListenerCount('ink:job-request')}</output>
    <output data-testid="ink-job-result">{JSON.stringify(window.__INK_JOB_CT__?.response ?? null)}</output>
    <output data-testid="ink-job-bytes">{JSON.stringify(window.__INK_JOB_CT__?.uploads ?? {})}</output>
  </div>;
}

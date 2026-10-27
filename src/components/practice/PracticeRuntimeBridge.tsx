import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { practiceApi } from '@/api/practiceApi';
import type { GeneratedPaper } from '@/stores/questionBankStore';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import i18n from '@/i18n';

interface ExportRequest {
  request_id: string;
  paper: GeneratedPaper;
  format: 'pdf' | 'word' | 'markdown';
  include_answers: boolean;
  include_explanations: boolean;
}

export default function PracticeRuntimeBridge() {
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void practiceApi.resumeGrading().catch(() => {});
    const subscription = listen<ExportRequest>('qbank-export-paper', async ({ payload }) => {
      try {
        const { buildPaperFile } = await import('./paperExport');
        const bytes = await buildPaperFile(payload.paper, {
          format: payload.format,
          includeAnswers: payload.include_answers,
          includeExplanations: payload.include_explanations,
        });
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await invoke('qbank_complete_paper_export', {
          requestId: payload.request_id,
          data: btoa(binary),
          error: null,
        });
      } catch (error) {
        await invoke('qbank_complete_paper_export', {
          requestId: payload.request_id,
          data: null,
          error: getErrorMessage(error),
        }).catch(() => {});
      }
    });
    const completion = listen<string>('qbank-practice-updated', async ({ payload }) => {
      try {
        const attempt = await practiceApi.getAttempt(payload);
        if (attempt.status !== 'grading')
          showGlobalNotification(
            attempt.status === 'completed' ? 'success' : 'warning',
            i18n.t('practice:batch.gradingComplete', { title: attempt.title }),
          );
      } catch {
        /* The record may have been removed. */
      }
    });
    return () => {
      void subscription.then((unlisten) => unlisten());
      void completion.then((unlisten) => unlisten());
    };
  }, []);
  return null;
}

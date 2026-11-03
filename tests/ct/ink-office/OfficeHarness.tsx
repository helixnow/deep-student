import React from 'react';
import { convertOfficePages } from '@/features/ink/prepare/office';
import { makeOfficeBudgetFixture, makeOfficeFixture, makeOfficeRefusalFixture, type OfficeBudgetFixtureKind, type OfficeFixtureOptions } from './fixtures';

type OfficeFixtureResult = Awaited<ReturnType<typeof convertOfficePages>>;

export function OfficeHarness({ format, options, maxPages, abortOnSelector, abortBeforeConvert = false, refusal, budgetFixture }: { format: 'docx' | 'pptx'; options?: OfficeFixtureOptions; maxPages?: number; abortOnSelector?: string; abortBeforeConvert?: boolean; refusal?: 'malformed' | 'legacy' | 'encrypted'; budgetFixture?: OfficeBudgetFixtureKind }) {
  const [status, setStatus] = React.useState('ready');
  return <div><button onClick={async () => {
    setStatus('running');
    const controller = new AbortController();
    const observer = new MutationObserver(() => {
      if (document.querySelector('.chart-node svg')) {
        (window as Window & { __INK_OFFICE_CT_CHART_READY__?: boolean }).__INK_OFFICE_CT_CHART_READY__ = true;
      }
      if (abortOnSelector && document.querySelector(abortOnSelector)) controller.abort();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    try {
      const bytes = budgetFixture
        ? await makeOfficeBudgetFixture(budgetFixture)
        : refusal ? makeOfficeRefusalFixture(refusal) : await makeOfficeFixture(format, options);
      (window as Window & { __INK_OFFICE_CT_FIXTURE_BYTES__?: number }).__INK_OFFICE_CT_FIXTURE_BYTES__ = bytes.byteLength;
      if (abortBeforeConvert) controller.abort();
      (window as Window & { __INK_OFFICE_CT_RESULT__?: OfficeFixtureResult }).__INK_OFFICE_CT_RESULT__ = await convertOfficePages(bytes, format, { signal: controller.signal, max_pages: maxPages });
      setStatus('done');
    } catch (error) {
      const diagnostic = error as Error & { code?: string; stage?: string; cause?: unknown };
      const cause = diagnostic.cause instanceof Error
        ? `${diagnostic.cause.message}\n${diagnostic.cause.stack ?? ''}`
        : String(diagnostic.cause ?? '');
      const details = { code: diagnostic.code, stage: diagnostic.stage, message: diagnostic.message, cause };
      (window as Window & { __INK_OFFICE_CT_ERROR__?: typeof details }).__INK_OFFICE_CT_ERROR__ = details;
      setStatus(`failed: ${JSON.stringify(details)}`);
    } finally {
      observer?.disconnect();
    }
  }}>{status}</button></div>;
}

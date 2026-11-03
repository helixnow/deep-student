import React from 'react';
import { prepareSourcePages, type SourceFormat, type SourcePreparationResult } from '@/features/ink/prepare/source';
import { makeInkPreparePdfFixture, makeInkPreparePngFixture } from './fixtures';

interface PrepareErrorDetails {
  code?: string;
  name?: string;
  message: string;
  stack?: string;
  cause?: PrepareErrorDetails | string;
}

function describeError(error: unknown, depth = 0): PrepareErrorDetails {
  if (!(error instanceof Error)) return { message: String(error) };
  const cause = (error as Error & { cause?: unknown }).cause;
  return {
    code: (error as Error & { code?: string }).code,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: cause === undefined
      ? undefined
      : depth < 4 ? describeError(cause, depth + 1) : String(cause),
  };
}

declare global {
  interface Window {
    __INK_PREPARE_CT_RESULT__?: SourcePreparationResult;
    __INK_PREPARE_CT_ERROR__?: PrepareErrorDetails;
  }
}

export function SourcePrepareHarness({ format }: { format: Extract<SourceFormat, 'pdf' | 'image'> }) {
  const [status, setStatus] = React.useState('ready');
  return <div><button type="button" onClick={async () => {
    setStatus('running');
    delete window.__INK_PREPARE_CT_RESULT__;
    delete window.__INK_PREPARE_CT_ERROR__;
    try {
      const bytes = format === 'pdf' ? makeInkPreparePdfFixture() : await makeInkPreparePngFixture();
      window.__INK_PREPARE_CT_RESULT__ = await prepareSourcePages(bytes, format);
      setStatus('done');
    } catch (error) {
      window.__INK_PREPARE_CT_ERROR__ = describeError(error);
      setStatus('failed');
    }
  }}>{status}</button></div>;
}

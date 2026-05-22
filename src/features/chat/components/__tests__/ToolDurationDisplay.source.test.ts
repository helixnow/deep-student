import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('tool duration display source', () => {
  const activityTimelineSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ActivityTimeline/ActivityTimeline.tsx'),
    'utf-8'
  );
  const noteToolPreviewSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ActivityTimeline/NoteToolPreview.tsx'),
    'utf-8'
  );
  const mcpToolSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/plugins/blocks/mcpTool.tsx'),
    'utf-8'
  );

  it('keeps tool status copy separate from duration in the activity timeline', () => {
    expect(activityTimelineSource).toContain("return t('timeline.tool.success', { ns: 'chatV2' });");
    expect(activityTimelineSource).not.toContain("t('timeline.tool.completed', { ms: durationMs, ns: 'chatV2' })");
    expect(activityTimelineSource).toContain('formatToolDurationShort(durationMs)');
  });

  it('keeps note tool status copy separate from duration', () => {
    expect(noteToolPreviewSource).toContain("text: t('timeline.noteTool.completed')");
    expect(noteToolPreviewSource).not.toContain("text: t('timeline.noteTool.completed', { ms })");
    expect(noteToolPreviewSource).toContain('formatToolDurationShort(durationMs)');
  });

  it('uses the shared duration formatter in the tool card header', () => {
    expect(mcpToolSource).toContain('formatToolDurationShort(duration)');
    expect(mcpToolSource).not.toContain("(duration / 1000).toFixed(2)}s");
  });
});

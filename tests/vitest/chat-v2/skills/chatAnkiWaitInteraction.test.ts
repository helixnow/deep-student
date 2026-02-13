import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/chat-v2/skills/builtin';

function getEmbeddedTool(name: string) {
  const tool = chatAnkiSkill.embeddedTools?.find((t) => t.name === name);
  expect(tool, `Expected embedded tool ${name} to exist`).toBeTruthy();
  return tool!;
}

describe('ChatAnki skill: wait interaction', () => {
  it('run/start schema should require explicit templateMode', () => {
    const runTool = getEmbeddedTool('builtin-chatanki_run');
    const startTool = getEmbeddedTool('builtin-chatanki_start');
    const runSchema = runTool.inputSchema as any;
    const startSchema = startTool.inputSchema as any;

    expect(runSchema?.properties?.templateMode?.enum).toEqual(['single', 'multiple', 'all']);
    expect(startSchema?.properties?.templateMode?.enum).toEqual(['single', 'multiple', 'all']);

    const runRequired: string[] = Array.isArray(runSchema?.required) ? runSchema.required : [];
    const startRequired: string[] = Array.isArray(startSchema?.required) ? startSchema.required : [];
    expect(runRequired).toContain('templateMode');
    expect(startRequired).toContain('templateMode');
  });

  it('builtin-chatanki_wait schema should allow documentId and not require ankiBlockId', () => {
    const waitTool = getEmbeddedTool('builtin-chatanki_wait');
    const schema = waitTool.inputSchema as any;

    expect(schema?.type).toBe('object');
    expect(schema?.properties?.ankiBlockId).toBeTruthy();
    expect(schema?.properties?.documentId).toBeTruthy();
    expect(schema?.properties?.timeoutMs).toBeTruthy();

    const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
    expect(required).not.toContain('ankiBlockId');
  });

  it('skill prompt should require calling wait immediately after run/start before export/sync', () => {
    const content = chatAnkiSkill.content ?? '';
    expect(content).toContain('builtin-chatanki_wait');
    expect(content).toContain('builtin-chatanki_run');
    expect(content).toContain('builtin-chatanki_start');

    // Guard the intended tool-call ordering (run/start -> wait -> export/sync).
    expect(content).toContain('`builtin-chatanki_run`/`builtin-chatanki_start` -> `builtin-chatanki_wait`');
    expect(content).toMatch(/`builtin-chatanki_wait`.*`builtin-chatanki_export`|`builtin-chatanki_wait`.*`builtin-chatanki_sync`/);

    // Guard the "continue / wait a sec" recovery path when IDs are missing.
    expect(content).toContain('找不到 `ankiBlockId`');
    expect(content).toContain('`anki_cards`');
  });
});

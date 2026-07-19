import { describe, expect, it } from 'vitest';

import { connectorToolsSkill } from '../builtin-tools/connector-tools';

const tool = (name: string) =>
  connectorToolsSkill.embeddedTools?.find((candidate) => candidate.name === name);

describe('Connector tool contracts', () => {
  it('CON-02 exposes the six first-class capability families', () => {
    const draft = tool('builtin-connector_operation_draft');
    expect(draft?.inputSchema?.properties?.capability?.enum).toEqual([
      'mail', 'calendar', 'meeting', 'drive', 'comments', 'share',
    ]);
  });

  it('CON-04 draft requires every risk preview field', () => {
    const required = tool('builtin-connector_operation_draft')?.inputSchema?.required ?? [];
    for (const field of [
      'recipients', 'timezone', 'conflicts', 'destination', 'acl', 'attachments', 'payload',
    ]) {
      expect(required).toContain(field);
    }
  });

  it('CON-06 confirm is bound to operation and preview hash', () => {
    expect(tool('builtin-connector_operation_confirm')?.inputSchema?.required).toEqual([
      'operation_id', 'preview_sha256',
    ]);
  });

  it('CON-07 commit requires an idempotency key', () => {
    expect(tool('builtin-connector_operation_commit')?.inputSchema?.required).toContain(
      'idempotency_key',
    );
  });

  it('COL-02 documents TaskObjectHandle-only attachments', () => {
    const description = tool('builtin-connector_operation_draft')
      ?.inputSchema?.properties?.attachments?.description;
    expect(description).toContain('TaskObjectHandle');
  });

  it('COL-04 forbids simulated success when capability is unavailable', () => {
    expect(connectorToolsSkill.content).toContain('capability_unavailable');
    expect(connectorToolsSkill.content).toContain('不得声称已发送、已创建或已分享');
  });
});

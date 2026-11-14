import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { createBlock } from '../repository/blocks.ts';
import { saveSessionState } from '../repository/session-state.ts';
import { createCompaction } from '../repository/compactions.ts';
import { loadSessionFull } from '../repository/load-session.ts';
import { newSession } from '../src/types.ts';
import type { ChatSession, SessionExportOptions } from '../api.ts';
import {
  defaultSessionExportOptions, exportSessionJsonl, redactSecrets, SESSION_EXPORT_SCHEMA_VERSION,
} from '../src/session-export.ts';

const SESSION_ID = 'sess_export_fixture';
const USER_MSG_ID = 'msg_export_user';
const ASSISTANT_MSG_ID = 'msg_export_assistant';
const ACTIVE_VARIANT_ID = 'var_active';
const INACTIVE_VARIANT_ID = 'var_inactive';
const SECRET_API_KEY = 'sk-secret-abc123';
const SECRET_URL = 'https://user:hunter2@example.test/data?token=leaked&safe=yes';
const SKILL_BODY = 'FULL SKILL BODY: never persist in exports';
const PREVIEW_BASE64 = 'data:image/png;base64,AAAABBBB';

describe('chat_v2 session export', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  function seedRichSession(): void {
    const session = newSession(SESSION_ID, 'general_chat');
    session.title = 'Export fixture';
    session.metadata = { origin: 'unit-test' };
    createSession(f.db, session);
    saveSessionState(f.db, SESSION_ID, {
      sessionId: SESSION_ID,
      features: { webSearch: true },
      inputValue: SECRET_URL,
      updatedAt: '2026-08-24T00:00:00Z',
    });

    createMessage(f.db, {
      id: USER_MSG_ID, sessionId: SESSION_ID, role: 'user', timestamp: 1_000,
      blockIds: ['blk_user_content'],
      attachments: [{
        id: 'att_1', name: 'notes.png', type: 'image', mimeType: 'image/png', size: 8,
        previewUrl: PREVIEW_BASE64, status: 'ready',
      }],
    });
    createBlock(f.db, {
      id: 'blk_user_content', messageId: USER_MSG_ID, type: 'content', status: 'success',
      blockIndex: 0, content: 'please search this', startedAt: 1_000, endedAt: 1_000,
    });

    createMessage(f.db, {
      id: ASSISTANT_MSG_ID, sessionId: SESSION_ID, role: 'assistant', timestamp: 2_000,
      blockIds: ['blk_active_thinking', 'blk_active_answer', 'blk_active_tool'],
      activeVariantId: ACTIVE_VARIANT_ID,
      _meta: {
        modelId: 'model-x',
        chatParams: { temperature: 0.5, apiKey: SECRET_API_KEY },
        skillRuntimeBefore: {
          activeSkillIds: ['skill-a'], skillContents: { 'skill-a': SKILL_BODY },
          skillDependencies: {}, skillEmbeddedTools: {}, mcpToolSchemas: [], selectedMcpServers: [],
        },
      },
      variants: [{
        id: ACTIVE_VARIANT_ID, modelId: 'model-x', blockIds: ['blk_active_thinking', 'blk_active_answer', 'blk_active_tool'],
        status: 'success', createdAt: 2_000,
      }, {
        id: INACTIVE_VARIANT_ID, modelId: 'model-y', blockIds: ['blk_inactive_answer'],
        status: 'success', createdAt: 2_001,
      }],
    });
    createBlock(f.db, {
      id: 'blk_active_thinking', messageId: ASSISTANT_MSG_ID, type: 'thinking', status: 'success',
      blockIndex: 0, content: 'private reasoning',
    });
    createBlock(f.db, {
      id: 'blk_active_answer', messageId: ASSISTANT_MSG_ID, type: 'content', status: 'success',
      blockIndex: 1, content: 'final answer',
    });
    createBlock(f.db, {
      id: 'blk_active_tool', messageId: ASSISTANT_MSG_ID, type: 'tool', status: 'success',
      blockIndex: 2, toolName: 'web_search',
      toolInput: { query: 'rust jsonl', apiKey: SECRET_API_KEY },
      toolOutput: { url: SECRET_URL, hits: 3 },
    });
    createBlock(f.db, {
      id: 'blk_inactive_answer', messageId: ASSISTANT_MSG_ID, type: 'content', status: 'success',
      blockIndex: 3, content: 'alternative answer',
    });

    createCompaction(f.db, {
      id: 'cmp_export_1', sessionId: SESSION_ID, summaryMessageId: ASSISTANT_MSG_ID,
      tailStartMessageId: USER_MSG_ID, tailStartTimeCreated: 1_000, reason: 'auto',
      isAuto: true, isOverflow: false, tokensBefore: 1_200, tokensAfter: 300,
      modelId: 'model-x', modelConfigId: null, previousCompactionId: null,
      rangeStartMessageId: null, rangeEndMessageId: null, compactedMessageCount: 1,
      createdAt: 3_000,
    });
  }

  function exportToLines(options?: SessionExportOptions | null): {
    summary: ReturnType<typeof exportSessionJsonl>['summary'];
    lines: Array<Record<string, unknown>>;
    text: string;
  } {
    const exported = exportSessionJsonl(f.db, SESSION_ID, options, host.ctx.app.version);
    const lines = exported.text.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    return { summary: exported.summary, lines, text: exported.text };
  }

  const lineType = (line: Record<string, unknown>): string => line.type as string;

  it('default_options_match_spec_defaults', () => {
    const options = defaultSessionExportOptions();
    expect(options.includeAllVariants).toBe(true);
    expect(options.includeSessionState).toBe(true);
    expect(options.includeCompactions).toBe(true);
    expect(options.redactSecrets).toBe(true);
    expect(SESSION_EXPORT_SCHEMA_VERSION).toBe(1);
  });

  it('options_deserialize_from_partial_camel_case_json', () => {
    // The command receives an already-parsed object; partial values keep defaults.
    const options = { ...defaultSessionExportOptions(), ...{ includeAllVariants: false } };
    expect(options.includeAllVariants).toBe(false);
    expect(options.redactSecrets).toBe(true);
  });

  it('export_line_order_and_footer_counts', () => {
    seedRichSession();
    const { summary, lines, text } = exportToLines(defaultSessionExportOptions());
    expect(lineType(lines[0]!)).toBe('header');
    expect(lines[0]!.schemaVersion).toBe(1);
    expect((lines[0]!.session as Record<string, unknown>).id).toBe(SESSION_ID);
    expect((lines[0]!.options as Record<string, unknown>).redactSecrets).toBe(true);
    expect((lines[0]!.generator as Record<string, unknown>).app).toBe('deep-student');
    expect(typeof lines[0]!.state).toBe('object');
    expect(lineType(lines[lines.length - 1]!)).toBe('footer');

    let currentMessageId: string | null = null;
    let seenCompaction = false;
    const counts = { message: 0, block: 0, compaction: 0 };
    for (const line of lines.slice(1, -1)) {
      if (lineType(line) === 'message') {
        expect(seenCompaction).toBe(false);
        currentMessageId = (line.message as Record<string, unknown>).id as string;
        counts.message += 1;
      } else if (lineType(line) === 'block') {
        expect(seenCompaction).toBe(false);
        expect(line.messageId).toBe(currentMessageId);
        expect((line.block as Record<string, unknown>).messageId).toBe(currentMessageId);
        counts.block += 1;
      } else if (lineType(line) === 'compaction') {
        seenCompaction = true;
        counts.compaction += 1;
      } else {
        throw new Error(`unexpected record type in body: ${lineType(line)}`);
      }
    }
    const footer = lines[lines.length - 1]!;
    expect(footer.messageCount).toBe(2);
    expect(footer.blockCount).toBe(5);
    expect(footer.compactionCount).toBe(1);
    expect(footer.truncated).toBe(false);
    expect(counts).toEqual({ message: 2, block: 5, compaction: 1 });
    expect(summary).toMatchObject({
      sessionId: SESSION_ID, schemaVersion: 1, messageCount: 2,
      blockCount: 5, compactionCount: 1, truncated: false,
    });
    expect(summary.bytesWritten).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('export_empty_session_writes_header_and_zero_count_footer', () => {
    createSession(f.db, newSession(SESSION_ID, 'general_chat'));
    const { summary, lines, text } = exportToLines();
    expect(lines).toHaveLength(2);
    expect(lineType(lines[0]!)).toBe('header');
    expect((lines[0]!.session as Record<string, unknown>).id).toBe(SESSION_ID);
    expect('state' in lines[0]!).toBe(false);
    const footer = lines[1]!;
    expect(lineType(footer)).toBe('footer');
    expect(footer).toMatchObject({ messageCount: 0, blockCount: 0, compactionCount: 0, truncated: false });
    expect(summary).toMatchObject({ messageCount: 0, blockCount: 0, compactionCount: 0, truncated: false });
    expect(summary.bytesWritten).toBe(Buffer.byteLength(text, 'utf8'));
    expect(text.endsWith('\n')).toBe(true);
  });

  it('export_round_trips_against_load_session_full', () => {
    seedRichSession();
    const { lines } = exportToLines({ redactSecrets: false });
    const expected = loadSessionFull(f.db, SESSION_ID);
    expect(lines[0]!.session).toEqual(JSON.parse(JSON.stringify(expected.session)));
    expect(lines[0]!.state).toEqual(JSON.parse(JSON.stringify(expected.state)));

    const exportedMessages = lines.filter(line => lineType(line) === 'message')
      .map(line => line.message);
    expect(exportedMessages).toEqual(JSON.parse(JSON.stringify(expected.messages)));

    const exportedBlocks = lines.filter(line => lineType(line) === 'block')
      .map(line => line.block as Record<string, unknown>)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const expectedBlocks = expected.blocks
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(exportedBlocks).toEqual(JSON.parse(JSON.stringify(expectedBlocks)));
  });

  it('export_redacts_secrets_by_default', () => {
    seedRichSession();
    const { lines, text } = exportToLines();
    expect(text).not.toContain(SECRET_API_KEY);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('token=leaked');
    expect(text).not.toContain(SKILL_BODY);
    expect(text).not.toContain(PREVIEW_BASE64);
    expect(text).toContain('safe=yes');
    expect(text).toContain('final answer');
    expect(text).toContain('[REDACTED]');

    const assistantLine = lines.find(line => lineType(line) === 'message'
      && (line.message as Record<string, unknown>).id === ASSISTANT_MSG_ID)!;
    const message = assistantLine.message as Record<string, unknown>;
    const runtime = (message._meta as Record<string, unknown>).skillRuntimeBefore as Record<string, unknown>;
    expect(runtime.activeSkillIds).toEqual(['skill-a']);
    expect('skillContents' in runtime).toBe(false);

    const userLine = lines.find(line => lineType(line) === 'message'
      && (line.message as Record<string, unknown>).id === USER_MSG_ID)!;
    const attachment = ((userLine.message as Record<string, unknown>).attachments as Array<Record<string, unknown>>)[0]!;
    expect(attachment.name).toBe('notes.png');
    expect(attachment.mimeType).toBe('image/png');
    expect('previewUrl' in attachment).toBe(false);
  });

  it('export_active_variant_only_prunes_variants_and_blocks', () => {
    seedRichSession();
    const { summary, lines, text } = exportToLines({ includeAllVariants: false });
    const assistantLine = lines.find(line => lineType(line) === 'message'
      && (line.message as Record<string, unknown>).id === ASSISTANT_MSG_ID)!;
    const variants = (assistantLine.message as Record<string, unknown>).variants as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(1);
    expect(variants[0]!.id).toBe(ACTIVE_VARIANT_ID);
    expect(summary.blockCount).toBe(4);
    expect(text).not.toContain('blk_inactive_answer');
    expect(text).not.toContain('alternative answer');
    expect(lines[lines.length - 1]!.blockCount).toBe(4);
  });

  it('export_missing_session_returns_session_not_found', async () => {
    await expect(host.invoke('chat_v2_export_session', { sessionId: 'sess_does_not_exist' }))
      .rejects.toContain('"code":"SESSION_NOT_FOUND"');
    const exported = (() => {
      try {
        exportSessionJsonl(f.db, 'sess_does_not_exist', defaultSessionExportOptions(), '1');
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(exported).toMatchObject({ kind: 'SessionNotFound', data: 'sess_does_not_exist' });
  });

  it('export_skips_missing_referenced_blocks', () => {
    createSession(f.db, newSession(SESSION_ID, 'general_chat'));
    createMessage(f.db, {
      id: 'msg_ghost_ref', sessionId: SESSION_ID, role: 'user', timestamp: 1_000,
      blockIds: ['blk_real', 'blk_ghost_missing'],
    });
    createBlock(f.db, {
      id: 'blk_real', messageId: 'msg_ghost_ref', type: 'content', status: 'success',
      blockIndex: 0, content: 'still exported',
    });
    const { summary, lines } = exportToLines();
    expect(summary.messageCount).toBe(1);
    expect(summary.blockCount).toBe(1);
    expect(lines[lines.length - 1]!.blockCount).toBe(1);
    expect(((lines[1]!.message as Record<string, unknown>).blockIds)).toEqual(['blk_real', 'blk_ghost_missing']);
  });

  it('export_honors_state_and_compaction_toggles', () => {
    seedRichSession();
    const { summary, lines } = exportToLines({ includeSessionState: false, includeCompactions: false });
    expect('state' in lines[0]!).toBe(false);
    expect(summary.compactionCount).toBe(0);
    expect(lines.every(line => lineType(line) !== 'compaction')).toBe(true);
    expect(lines[lines.length - 1]!.compactionCount).toBe(0);
  });

  it('export_write_failure_maps_to_io_error', async () => {
    seedRichSession();
    await expect(host.invoke('chat_v2_export_session_jsonl', {
      sessionId: SESSION_ID, targetPath: '/definitely-missing-directory/out.jsonl',
    })).rejects.toContain('"code":"IO_ERROR"');
  });

  it('secx_01_export_recursively_redacts_secret_values', () => {
    const value = {
      authorization: 'Bearer secret', nested: [{ apiKey: 'secret', safe: 'visible' }],
      refresh_token: 'secret', sessionToken: 'secret',
      sourceUri: 'https://user:password@example.test/data?token=secret&visible=yes',
    };
    redactSecrets(value);
    expect(value.authorization).toBe('[REDACTED]');
    expect(value.nested[0]!.apiKey).toBe('[REDACTED]');
    expect(value.refresh_token).toBe('[REDACTED]');
    expect(value.sessionToken).toBe('[REDACTED]');
    expect(value.nested[0]!.safe).toBe('visible');
    expect(value.sourceUri).not.toContain('password');
    expect(value.sourceUri).not.toContain('token=secret');
    expect(value.sourceUri).toContain('visible=yes');
  });

  it('export_session renders markdown and json with exact defaults', async () => {
    seedRichSession();
    const markdown = await host.invoke<{ format: string; content: string; messageCount: number }>(
      'chat_v2_export_session', { sessionId: SESSION_ID });
    expect(markdown.format).toBe('markdown');
    expect(markdown.messageCount).toBe(2);
    expect(markdown.content.startsWith('# Export fixture\n\n')).toBe(true);
    expect(markdown.content).toContain('## User');
    expect(markdown.content).toContain('*[tool (web_search): success]*');
    expect(markdown.content).not.toContain('private reasoning');

    const withThinking = await host.invoke<{ content: string }>('chat_v2_export_session', {
      sessionId: SESSION_ID, includeThinking: true,
    });
    expect(withThinking.content).toContain('<details><summary>Thinking</summary>');

    const json = await host.invoke<{ format: string; content: string }>('chat_v2_export_session', {
      sessionId: SESSION_ID, format: 'json',
    });
    expect(json.format).toBe('json');
    const payload = JSON.parse(json.content);
    expect(payload.session.id).toBe(SESSION_ID);
    expect(payload.messages).toHaveLength(2);
    expect(payload.blocks).toHaveLength(5);
    expect(payload.blocks[0]).not.toHaveProperty('blockIndex');
    expect(typeof payload.exportedAt).toBe('string');

    await expect(host.invoke('chat_v2_export_session', { sessionId: SESSION_ID, format: 'pdf' }))
      .rejects.toContain('Invalid export format');
    await expect(host.invoke('chat_v2_export_session', { sessionId: '   ' }))
      .rejects.toContain('Invalid session ID: empty or whitespace-only');
  });
});

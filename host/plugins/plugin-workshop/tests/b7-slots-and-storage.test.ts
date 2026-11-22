import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '../../../kernel/api.ts';
import type { ChatPipelineService } from '../../chat-pipeline/api.ts';
import type { ChatSessionService } from '../../chat/api.ts';
import type { WorkshopCard } from '../api.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { detectPlaces } from '../src/declared.ts';
import { PipelineWorkshopGeneration, isAppViewCandidate, validateVerificationResult } from '../src/generation.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';

function makeCard(overrides: Partial<WorkshopCard> = {}): WorkshopCard {
  return {
    kind: 'dstu-plugin-workshop',
    id: 'card-1',
    pluginId: 'workshop.test-plugin',
    sessionId: 'sess-1',
    version: '1.0.0',
    revision: 1,
    title: 'Test Work',
    description: 'Description',
    template: 'learning-tool',
    changes: ['initial'],
    capabilities: [],
    expectedPlaces: [],
    state: 'pending-confirmation',
    trust: 'full',
    source: 'workshop',
    risk: 'low',
    check: null,
    error: null,
    previousVersion: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('declared.ts B7 UI slot detection', () => {
  const manifest = { id: 'workshop.test-plugin', permissions: [] };

  it('detects all 8 new UI slots and literal slash command name', () => {
    const uiCode = [
      "ctx.ui.contribute('pdf.selectionToolbar', { id: 'p', value: {} });",
      "ctx.ui.contribute('chat.composer.commands', { id: 'cmd', value: { name: 'quizMe', label: 'Quiz Me' } });",
      "ctx.ui.contribute('chat.message.actions', { id: 'm', value: {} });",
      "ctx.ui.contribute('review.cardActions', { id: 'r', value: {} });",
      "ctx.ui.contribute('desktop.widgets', { id: 'dw', value: {} });",
      "ctx.ui.contribute('statusbar.items', { id: 'sb', value: {} });",
      "ctx.ui.contribute('theme.variants', { id: 'tv', value: {} });",
      "ctx.ui.contribute('dashboard.charts', { id: 'dc', value: {} });",
    ].join('\n');

    expect(detectPlaces(manifest, uiCode)).toEqual([
      { kind: 'pdfSelectionButton' },
      { kind: 'slashCommand', command: 'quizMe' },
      { kind: 'chatMessageAction' },
      { kind: 'reviewAction' },
      { kind: 'desktopWidget' },
      { kind: 'statusBarItem' },
      { kind: 'themeVariant' },
      { kind: 'dashboardWidget' },
    ]);
  });

  it('detects dynamic slash command name without literal field', () => {
    const uiCode = "ctx.ui.contribute('chat.composer.commands', { id: 'cmd', value: makeCmd() });";
    expect(detectPlaces(manifest, uiCode)).toEqual([{ kind: 'slashCommand' }]);
  });
});

describe('generation.ts verification improvements (BUG-06)', () => {
  it('distinguishes app view candidates from non-app slot and host candidates', () => {
    expect(isAppViewCandidate(makeCard({ template: 'learning-tool', places: [{ kind: 'app', title: 'App' }] }))).toBe(true);
    expect(isAppViewCandidate(makeCard({ template: 'learning-tool', places: [{ kind: 'pdfSelectionButton' }] }))).toBe(false);
    expect(isAppViewCandidate(makeCard({ template: 'host-tool', places: undefined, expectedPlaces: [] }))).toBe(false);
    expect(isAppViewCandidate(makeCard({ template: 'learning-tool', places: undefined, expectedPlaces: [] }))).toBe(true);
  });

  it('verifies non-app UI contribution via dstu_plugin_inventory when enabled and running', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-gen-nonapp-'));
    const ops = new WorkshopOperations({ version: '0.20.0', dataDir, debug: true } as AppInfo);
    const card = await ops.propose({
      sessionId: 'sess-1',
      title: 'PDF Button',
      description: 'Adds PDF selection toolbar button',
      template: 'learning-tool',
      changes: [],
      capabilities: [],
    });
    const source = join(ops.store.directory(card.id), 'source');
    await mkdir(source, { recursive: true });
    card.version = '1.0.0';
    card.places = [{ kind: 'pdfSelectionButton' }];
    card.validation = { version: card.version, revision: card.revision, status: 'pending' };

    const execute = vi.fn<ChatPipelineService['execute']>(async () => 'verify-msg-1');
    const chat = {
      createSession: vi.fn(),
      getMessageBlocks: () => [
        {
          type: 'content',
          content: JSON.stringify({
            status: 'passed',
            checks: [{ criterion: 0, observed: 'plugin enabled and running in inventory', toolCallIds: ['call-inv-1'] }],
          }),
        },
        {
          id: 'inv-block-1',
          messageId: 'verify-msg-1',
          type: 'workbench_ops',
          status: 'success',
          toolName: 'dstu_plugin_inventory',
          toolOutput: {
            plugins: [{ id: card.pluginId, version: card.version, enabled: true, state: 'running' }],
          },
        },
      ],
      getMessage: () => ({
        _meta: {
          toolResults: [{
            toolCallId: 'call-inv-1',
            blockId: 'inv-block-1',
            toolName: 'dstu_plugin_inventory',
            success: true,
            input: {},
            output: null,
          }],
        },
      }),
    } as unknown as ChatSessionService;

    const generation = new PipelineWorkshopGeneration(
      chat,
      { execute } as unknown as ChatPipelineService,
      new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])),
    );

    const result = await generation.verify(card, source, new AbortController().signal);
    expect(result.status, result.error ?? '').toBe('passed');
    expect(execute.mock.calls[0]?.[1]?.options?.schemaToolIds).toContain('dstu_plugin_inventory');
    expect(execute.mock.calls[0]?.[1]?.options?.executionAllowedTools).toContain('dstu_plugin_inventory');
  });

  it('blocks non-app verification when plugin inventory shows wrong state or disabled', () => {
    const card = makeCard({
      places: [{ kind: 'slashCommand', command: 'drill' }],
      validation: { version: '1.0.0', revision: 1, status: 'pending' },
    });
    const answer = JSON.stringify({
      status: 'passed',
      checks: [{ criterion: 0, observed: 'checked', toolCallIds: ['call-1'] }],
    });

    expect(
      validateVerificationResult(answer, card, [{
        toolCallId: 'call-1',
        toolName: 'dstu_plugin_inventory',
        input: {},
        success: true,
        output: { plugins: [{ id: card.pluginId, version: card.version, enabled: false, state: 'running' }] },
      }]).status,
    ).toBe('blocked');

    expect(
      validateVerificationResult(answer, card, [{
        toolCallId: 'call-1',
        toolName: 'dstu_plugin_inventory',
        input: {},
        success: true,
        output: { plugins: [{ id: card.pluginId, version: '0.0.1', enabled: true, state: 'running' }] },
      }]).status,
    ).toBe('blocked');
  });

  it('instructs app verifier not to self-block solely because it does not click interactive controls', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-gen-prompt-'));
    const ops = new WorkshopOperations({ version: '0.20.0', dataDir, debug: true } as AppInfo);
    const card = await ops.propose({
      sessionId: 'sess-1',
      title: 'Interactive App',
      description: 'App with form and export button',
      template: 'learning-tool',
      changes: [],
      capabilities: [],
    });
    const source = join(ops.store.directory(card.id), 'source');
    await mkdir(source, { recursive: true });
    card.places = [{ kind: 'app', title: 'Interactive App' }];
    card.validation = { version: card.version ?? '1.0.0', revision: card.revision, status: 'pending' };

    const execute = vi.fn<ChatPipelineService['execute']>(async () => 'msg-id');
    const chat = {
      createSession: vi.fn(),
      getMessageBlocks: () => [{ type: 'content', content: '{"status":"blocked","error":"none"}' }],
      getMessage: () => ({ _meta: { toolResults: [] } }),
    } as unknown as ChatSessionService;

    const generation = new PipelineWorkshopGeneration(
      chat,
      { execute } as unknown as ChatPipelineService,
      new WorkshopToolExecutor(ops, new WorkshopCatalog(() => [])),
    );

    await generation.verify(card, source, new AbortController().signal);
    const prompt = String(execute.mock.calls[0]?.[1]?.content ?? '');
    expect(prompt).toContain('controls');
    expect(prompt).toContain('passed');
  });
});

describe('operations.ts Host storage inspection & clearing (GAP-5)', () => {
  it('lists and clears managed plugin directory files and plugin settings safely', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-storage-ops-'));
    const ops = new WorkshopOperations({ version: '0.20.0', dataDir, debug: true } as AppInfo);

    const store = new Map<string, string>([
      ['workshop.alpha.streak', '7'],
      ['workshop.alpha.notes', '"saved"'],
      ['workshop.beta.theme', '"dark"'],
    ]);
    ops.bindSettings(() => ({
      listByPrefix: (prefix: string) =>
        [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00Z' })),
      deleteByPrefix: (prefix: string) => {
        let count = 0;
        for (const key of [...store.keys()]) {
          if (key.startsWith(prefix)) {
            store.delete(key);
            count++;
          }
        }
        return count;
      },
    }));

    const alphaDir = join(dataDir, 'plugins', 'workshop.alpha', 'nested');
    const betaDir = join(dataDir, 'plugins', 'workshop.beta');
    const outsideFile = join(dataDir, 'secret.txt');
    await mkdir(alphaDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });
    await writeFile(join(dataDir, 'plugins', 'workshop.alpha', 'prefs.json'), '{"ok":true}', 'utf8');
    await writeFile(join(alphaDir, 'history.txt'), '12345', 'utf8');
    await writeFile(join(betaDir, 'keep.txt'), 'stay', 'utf8');
    await writeFile(outsideFile, 'do-not-delete', 'utf8');
    await symlink(outsideFile, join(dataDir, 'plugins', 'workshop.alpha', 'link.txt'));

    const before = await ops.storedData('workshop.alpha');
    expect(before.keys).toEqual([
      'nested/history.txt',
      'prefs.json',
      'workshop.alpha.notes',
      'workshop.alpha.streak',
    ]);
    expect(before.bytes).toBeGreaterThan(10);

    const clearedCount = await ops.clearStoredData('workshop.alpha');
    expect(clearedCount).toBe(4);

    const after = await ops.storedData('workshop.alpha');
    expect(after).toEqual({ keys: [], bytes: 0 });

    // Other plugins and outside symlink targets remain untouched
    expect(await readFile(join(betaDir, 'keep.txt'), 'utf8')).toBe('stay');
    expect(await readFile(outsideFile, 'utf8')).toBe('do-not-delete');
    expect(store.get('workshop.beta.theme')).toBe('"dark"');
    expect(store.has('workshop.alpha.streak')).toBe(false);
  });

  it('rejects invalid plugin ids, traversal attempts, and releases directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-storage-sec-'));
    const ops = new WorkshopOperations({ version: '0.20.0', dataDir, debug: true } as AppInfo);

    await expect(ops.storedData('../escape')).rejects.toThrow('WORKSHOP_INVALID');
    await expect(ops.storedData('releases')).rejects.toThrow('WORKSHOP_INVALID');
    await expect(ops.clearStoredData('bad/id')).rejects.toThrow('WORKSHOP_INVALID');
    await expect(ops.clearStoredData('')).rejects.toThrow('WORKSHOP_INVALID');
  });
});

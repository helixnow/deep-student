import { describe, expect, it } from 'vitest';
import { BUILTIN_SERVER_ID, getBuiltinServer } from '@/mcp/builtinMcpServer';
import {
  assessShellCommandRuleRisk,
  buildManagedPermissionTools,
  filterShellCommandRules,
  filterManagedPermissionTools,
  legacyToolOverrideKey,
  makeToolIdentity,
  parseShellCommandPolicy,
  previewShellCommandPolicy,
  parseToolOverrideKey,
  resolveToolOverride,
  resolveToolOverrideEntry,
  runtimeToolName,
  scopedToolOverrideKey,
  selectedOverrideKeysForReset,
  selectedScopedOverrideKeys,
  serializeShellCommandPolicy,
  validateShellCommandPattern,
  type ToolSensitivityLevel,
} from '../toolPermissionModel';

describe('shell command permission policy', () => {
  it('round trips the versioned backend schema', () => {
    const serialized = serializeShellCommandPolicy('ask', [{
      id: 'git-status',
      action: 'allow',
      matchType: 'exact',
      pattern: 'git status --short',
      enabled: true,
      note: 'Read repository status',
    }]);
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      default_effect: 'ask',
      rules: [{ effect: 'allow', match: { kind: 'exact', value: 'git status --short' } }],
    });
    expect(parseShellCommandPolicy(serialized)).toEqual({
      defaultEffect: 'ask',
      rules: [{
        id: 'git-status',
        action: 'allow',
        matchType: 'exact',
        pattern: 'git status --short',
        enabled: true,
        note: 'Read repository status',
      }],
    });
  });

  it('falls back safely when stored policy is missing or malformed', () => {
    expect(parseShellCommandPolicy('')).toEqual({ defaultEffect: 'ask', rules: [] });
    expect(parseShellCommandPolicy('{bad json')).toEqual({ defaultEffect: 'ask', rules: [] });
  });

  it('rejects fuzzy, compound, and argument-bearing executable patterns', () => {
    expect(validateShellCommandPattern('git *', 'prefix')).toBe('wildcards_not_supported');
    expect(validateShellCommandPattern('git status | cat', 'exact')).toBe('compound_not_supported');
    expect(validateShellCommandPattern('git status', 'executable')).toBe('executable_only');
    expect(validateShellCommandPattern('/usr/bin/git', 'executable')).toBeNull();
  });

  it('flags broad allows and interpreters without overstating deny risk', () => {
    expect(assessShellCommandRuleRisk({ action: 'allow', matchType: 'prefix', pattern: 'git' })).toBe('broad');
    expect(assessShellCommandRuleRisk({ action: 'allow', matchType: 'exact', pattern: 'python report.py' })).toBe('critical');
    expect(assessShellCommandRuleRisk({ action: 'deny', matchType: 'executable', pattern: 'python' })).toBeNull();
  });

  it('filters rules by query, effect, and literal match type', () => {
    const rules = [
      { id: '1', action: 'allow' as const, matchType: 'exact' as const, pattern: 'git status', enabled: true },
      { id: '2', action: 'deny' as const, matchType: 'executable' as const, pattern: 'sudo', enabled: true, note: 'privilege' },
    ];
    expect(filterShellCommandRules(rules, { query: 'priv', action: 'deny', matchType: 'executable' }))
      .toEqual([rules[1]]);
  });

  it('previews deny-first matching with token-boundary prefixes', () => {
    const rules = [
      { id: 'allow-git', action: 'allow' as const, matchType: 'executable' as const, pattern: 'git', enabled: true },
      { id: 'deny-status', action: 'deny' as const, matchType: 'prefix' as const, pattern: 'git status', enabled: true },
    ];
    expect(previewShellCommandPolicy('git status --short', 'ask', rules)).toEqual({
      effect: 'deny',
      matchedRule: rules[1],
    });
    expect(previewShellCommandPolicy('git statistic', 'ask', [rules[1]])).toEqual({
      effect: 'ask',
      matchedRule: null,
    });
  });
});

describe('toolPermissionModel', () => {
  const snapshots = {
    'docs-prod': {
      items: [
        { name: 'search', description: 'Search production documents' },
        { name: 'mcp_file_read', description: 'Read a file by path' },
      ],
    },
    'docs-stage': {
      items: [
        { name: 'search', description: 'Search staging documents' },
        { name: 'note_append', description: 'Append knowledge notes' },
      ],
    },
  };

  it('keeps tools with the same name on different servers as distinct rows', () => {
    const tools = buildManagedPermissionTools(snapshots);
    const searchTools = tools.filter(tool => tool.name === 'mcp_search');

    expect(searchTools).toHaveLength(2);
    expect(searchTools.map(tool => tool.id)).toEqual([
      'docs-prod::mcp_search',
      'docs-stage::mcp_search',
    ]);
    expect(new Set(searchTools.map(tool => tool.source))).toEqual(
      new Set(['docs-prod', 'docs-stage'])
    );
  });

  it('normalizes the settings builtin snapshot to exact runtime identities', () => {
    const builtinServer = getBuiltinServer();
    const snapshotItems = builtinServer.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
    }));
    const tools = buildManagedPermissionTools({
      [BUILTIN_SERVER_ID]: { items: snapshotItems },
    });

    expect(BUILTIN_SERVER_ID).toBe('__builtin__tools');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(tool => tool.source === 'builtin')).toBe(true);
    expect(tools.every(tool => tool.name.startsWith('builtin-'))).toBe(true);
    expect(tools.every(tool => tool.id === `builtin::${tool.name}`)).toBe(true);
    expect(makeToolIdentity(BUILTIN_SERVER_ID, runtimeToolName(BUILTIN_SERVER_ID, 'web_search')))
      .toBe('builtin::builtin-web_search');
    expect(scopedToolOverrideKey(BUILTIN_SERVER_ID, runtimeToolName(BUILTIN_SERVER_ID, 'web_search')))
      .toBe('tool_approval.override.builtin::builtin-web_search');

    const sample = tools[0];
    expect(scopedToolOverrideKey(sample.source, sample.name))
      .toBe(`tool_approval.override.builtin::${sample.name}`);
  });

  it('restores a stripped builtin note tool and derives its runtime domain', () => {
    const [tool] = buildManagedPermissionTools({
      __builtin__tools: { items: [{ name: 'note_read', description: 'Read a note' }] },
    });

    expect(tool).toMatchObject({
      source: 'builtin',
      name: 'builtin-note_read',
      id: 'builtin::builtin-note_read',
      domain: 'note',
    });
  });

  it('deduplicates repeated cache entries only within the same server', () => {
    const tools = buildManagedPermissionTools({
      docs: { items: [{ name: 'search' }, { name: 'search', description: 'Search docs' }] },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: 'docs::mcp_search',
      description: 'Search docs',
    });
  });

  it('matches the external MCP bridge runtime identity', () => {
    const tools = buildManagedPermissionTools({
      docs: { items: [{ name: 'search' }, { name: 'mcp_file_read' }] },
    });

    expect(tools.map(tool => ({ id: tool.id, domain: tool.domain }))).toEqual([
      { id: 'docs::mcp_mcp_file_read', domain: 'mcp' },
      { id: 'docs::mcp_search', domain: 'search' },
    ]);
  });

  it('searches case-insensitively across tool name, description, and source', () => {
    const tools = buildManagedPermissionTools(snapshots);
    const overrides = new Map<string, ToolSensitivityLevel>();

    expect(filterManagedPermissionTools(tools, overrides, { query: 'PRODUCTION' }))
      .toHaveLength(1);
    expect(filterManagedPermissionTools(tools, overrides, { query: 'docs stage' }))
      .toHaveLength(2);
    expect(filterManagedPermissionTools(tools, overrides, { query: 'file_read' })[0]?.id)
      .toBe('docs-prod::mcp_mcp_file_read');
  });

  it('combines source, capability, level, and override filters', () => {
    const tools = buildManagedPermissionTools(snapshots);
    const overrides = new Map<string, ToolSensitivityLevel>([
      ['docs-prod::mcp_mcp_file_read', 'high'],
      ['docs-stage::mcp_search', 'low'],
    ]);

    expect(filterManagedPermissionTools(tools, overrides, {
      source: 'docs-prod',
      capability: 'files',
      level: 'high',
      override: 'overridden',
    }).map(tool => tool.id)).toEqual(['docs-prod::mcp_mcp_file_read']);

    expect(filterManagedPermissionTools(tools, overrides, {
      level: 'default',
      override: 'inherited',
    }).map(tool => tool.id)).toEqual(['docs-stage::mcp_note_append', 'docs-prod::mcp_search']);
  });

  it('keeps effective group levels separate from direct override status', () => {
    const tools = buildManagedPermissionTools(snapshots);
    const effectiveLevels = new Map<string, ToolSensitivityLevel>(
      tools.map(tool => [tool.id, 'low'])
    );
    const directOverrides = new Map<string, ToolSensitivityLevel>([
      ['docs-stage::mcp_search', 'low'],
    ]);

    expect(filterManagedPermissionTools(
      tools,
      effectiveLevels,
      { level: 'low', override: 'overridden' },
      directOverrides
    ).map(tool => tool.id)).toEqual(['docs-stage::mcp_search']);
    expect(filterManagedPermissionTools(
      tools,
      effectiveLevels,
      { level: 'low', override: 'inherited' },
      directOverrides
    )).toHaveLength(tools.length - 1);
  });

  it('creates source-scoped keys for bulk changes and reset-to-default deletes', () => {
    const tools = buildManagedPermissionTools(snapshots);
    const selected = new Set([
      makeToolIdentity('docs-prod', 'mcp_search'),
      makeToolIdentity('docs-stage', 'mcp_note_append'),
    ]);

    expect(selectedScopedOverrideKeys(tools, selected)).toEqual([
      'tool_approval.override.docs-stage::mcp_note_append',
      'tool_approval.override.docs-prod::mcp_search',
    ]);
    expect(scopedToolOverrideKey('docs-prod', 'search'))
      .toBe('tool_approval.override.docs-prod::search');
  });

  it('parses scoped overrides and legacy name-only overrides', () => {
    expect(parseToolOverrideKey('tool_approval.override.docs-prod::search')).toEqual({
      id: 'docs-prod::search',
      source: 'docs-prod',
      toolName: 'search',
      scoped: true,
    });
    expect(parseToolOverrideKey(legacyToolOverrideKey('search'))).toEqual({
      id: 'search',
      source: null,
      toolName: 'search',
      scoped: false,
    });
    expect(parseToolOverrideKey('tool_approval.source.docs-prod')).toBeNull();
  });

  it('prefers a source-scoped override while retaining legacy fallback behavior', () => {
    const [prodSearch, stageSearch] = buildManagedPermissionTools(snapshots)
      .filter(tool => tool.name === 'mcp_search');
    const overrides = new Map<string, ToolSensitivityLevel>([
      ['mcp_search', 'medium'],
      ['docs-prod::mcp_search', 'high'],
    ]);

    expect(resolveToolOverride(prodSearch, overrides)).toBe('high');
    expect(resolveToolOverride(stageSearch, overrides)).toBe('medium');
    expect(resolveToolOverrideEntry(prodSearch, overrides)).toEqual({
      id: 'docs-prod::mcp_search',
      level: 'high',
      scoped: true,
    });
    expect(resolveToolOverrideEntry(stageSearch, overrides)).toEqual({
      id: 'mcp_search',
      level: 'medium',
      scoped: false,
    });
  });

  it('resets the actual scoped or legacy setting affecting selected tools', () => {
    const tools = buildManagedPermissionTools(snapshots);
    const selected = new Set(['docs-prod::mcp_search', 'docs-stage::mcp_search']);
    const overrides = new Map<string, ToolSensitivityLevel>([
      ['mcp_search', 'medium'],
      ['docs-prod::mcp_search', 'high'],
    ]);

    expect(selectedOverrideKeysForReset(tools, selected, overrides)).toEqual([
      'tool_approval.override.docs-prod::mcp_search',
      'tool_approval.override.mcp_search',
    ]);
  });

  it('rejects malformed scoped override keys', () => {
    expect(parseToolOverrideKey('tool_approval.override.')).toBeNull();
    expect(parseToolOverrideKey('tool_approval.override.::search')).toBeNull();
    expect(parseToolOverrideKey('tool_approval.override.docs::')).toBeNull();
  });
});

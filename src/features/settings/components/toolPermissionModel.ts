export type ToolSensitivityLevel = 'low' | 'medium' | 'high';

export type ToolCapability =
  | 'files'
  | 'web'
  | 'knowledge'
  | 'learning'
  | 'automation'
  | 'data'
  | 'communication'
  | 'other';

export type ToolLevelFilter = 'all' | 'default' | ToolSensitivityLevel;
export type ToolOverrideFilter = 'all' | 'overridden' | 'inherited';

export type ShellCommandAction = 'allow' | 'ask' | 'deny';
export type ShellCommandMatchType = 'exact' | 'prefix' | 'executable';
export type ShellCommandRuleRisk = 'broad' | 'critical' | null;

export interface ShellCommandRule {
  id: string;
  action: ShellCommandAction;
  matchType: ShellCommandMatchType;
  pattern: string;
  enabled: boolean;
  note?: string;
}

export interface ShellCommandRuleFilters {
  query?: string;
  action?: ShellCommandAction | 'all';
  matchType?: ShellCommandMatchType | 'all';
}

export interface ShellCommandRulePreview {
  effect: ShellCommandAction;
  matchedRule: ShellCommandRule | null;
}

export type ShellCommandPatternError =
  | 'required'
  | 'wildcards_not_supported'
  | 'compound_not_supported'
  | 'executable_only';

/** Kept together so a backend schema migration does not leak through the UI. */
export const SHELL_COMMAND_POLICY_SETTING_KEYS = {
  policy: 'tool_approval.shell_command_rules',
} as const;

const SHELL_COMMAND_ACTIONS: ShellCommandAction[] = ['allow', 'ask', 'deny'];
const SHELL_COMMAND_MATCH_TYPES: ShellCommandMatchType[] = ['exact', 'prefix', 'executable'];
const WILDCARD_PATTERN = /[*?{}[\]]/;
const COMPOUND_COMMAND_PATTERN = /[;&|<>\r\n]/;
const HIGH_RISK_EXECUTABLES = new Set([
  'bash', 'cmd', 'env', 'fish', 'find', 'node', 'osascript', 'perl', 'powershell',
  'pwsh', 'python', 'python3', 'ruby', 'sh', 'sudo', 'xargs', 'zsh',
]);

export interface ToolSnapshotItem {
  name: string;
  description?: string;
}

export type ToolSnapshotsBySource = Record<
  string,
  { items: ToolSnapshotItem[]; at?: number }
>;

export interface ManagedPermissionTool {
  id: string;
  source: string;
  name: string;
  display: string;
  description: string;
  capability: ToolCapability;
  domain: string;
}

export interface ToolPermissionFilters {
  query?: string;
  source?: string;
  capability?: ToolCapability | 'all';
  level?: ToolLevelFilter;
  override?: ToolOverrideFilter;
}

export interface ParsedToolOverrideKey {
  id: string;
  source: string | null;
  toolName: string;
  scoped: boolean;
}

export interface ResolvedToolOverride {
  id: string;
  level: ToolSensitivityLevel;
  scoped: boolean;
}

function isShellCommandAction(value: unknown): value is ShellCommandAction {
  return typeof value === 'string' && SHELL_COMMAND_ACTIONS.includes(value as ShellCommandAction);
}

function isShellCommandMatchType(value: unknown): value is ShellCommandMatchType {
  return typeof value === 'string'
    && SHELL_COMMAND_MATCH_TYPES.includes(value as ShellCommandMatchType);
}

/** Parse both the current array payload and a future versioned `{ rules }` envelope. */
export function parseShellCommandPolicy(raw: string | null | undefined): {
  defaultEffect: ShellCommandAction;
  rules: ShellCommandRule[];
} {
  const fallback = { defaultEffect: 'ask' as const, rules: [] as ShellCommandRule[] };
  if (!raw?.trim()) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const record = parsed as Record<string, unknown>;
    const defaultEffect = isShellCommandAction(record.default_effect)
      ? record.default_effect
      : 'ask';
    const items = Array.isArray(record.rules) ? record.rules : [];

    const rules = items.flatMap((item, index) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const action = record.effect;
      const match = record.match && typeof record.match === 'object'
        ? record.match as Record<string, unknown>
        : {};
      const matchType = match.kind;
      const pattern = typeof match.value === 'string' ? match.value.trim() : '';
      if (!isShellCommandAction(action) || !isShellCommandMatchType(matchType) || !pattern) return [];
      return [{
        id: typeof record.id === 'string' && record.id.trim()
          ? record.id.trim()
          : `shell-rule-${index + 1}`,
        action,
        matchType,
        pattern,
        enabled: record.enabled !== false,
        ...(typeof record.note === 'string' && record.note.trim()
          ? { note: record.note.trim() }
          : {}),
      }];
    });
    return { defaultEffect, rules };
  } catch {
    return fallback;
  }
}

export function serializeShellCommandPolicy(
  defaultEffect: ShellCommandAction,
  rules: ShellCommandRule[]
): string {
  return JSON.stringify({
    version: 1,
    default_effect: defaultEffect,
    rules: rules.map(rule => ({
      id: rule.id,
      effect: rule.action,
      match: { kind: rule.matchType, value: rule.pattern.trim() },
      enabled: rule.enabled,
      ...(rule.note?.trim() ? { note: rule.note.trim() } : {}),
    })),
  });
}

/** Rules are literal argv identities/prefixes, never shell expressions or fuzzy patterns. */
export function validateShellCommandPattern(
  pattern: string,
  matchType: ShellCommandMatchType
): ShellCommandPatternError | null {
  const normalized = pattern.trim();
  if (!normalized) return 'required';
  if (WILDCARD_PATTERN.test(normalized)) return 'wildcards_not_supported';
  if (COMPOUND_COMMAND_PATTERN.test(normalized)) return 'compound_not_supported';
  if (matchType === 'executable' && /\s/.test(normalized)) return 'executable_only';
  return null;
}

function executableName(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/').split('/').pop()?.toLocaleLowerCase() ?? '';
}

/** Allow rules that expose an interpreter or a whole command family require extra confirmation. */
export function assessShellCommandRuleRisk(rule: Pick<ShellCommandRule, 'action' | 'matchType' | 'pattern'>): ShellCommandRuleRisk {
  if (rule.action !== 'allow') return null;
  const firstToken = rule.pattern.trim().split(/\s+/)[0] ?? '';
  if (HIGH_RISK_EXECUTABLES.has(executableName(firstToken))) return 'critical';
  if (rule.matchType === 'prefix' && !/\s/.test(rule.pattern.trim())) return 'broad';
  return null;
}

export function filterShellCommandRules(
  rules: ShellCommandRule[],
  filters: ShellCommandRuleFilters
): ShellCommandRule[] {
  const query = filters.query?.trim().toLocaleLowerCase() ?? '';
  const action = filters.action ?? 'all';
  const matchType = filters.matchType ?? 'all';
  return rules.filter(rule => {
    if (action !== 'all' && rule.action !== action) return false;
    if (matchType !== 'all' && rule.matchType !== matchType) return false;
    if (!query) return true;
    return [rule.pattern, rule.note ?? ''].some(value => value.toLocaleLowerCase().includes(query));
  });
}

function previewExecutable(command: string): string {
  const trimmed = command.trim();
  const quoted = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const token = quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? '';
  return executableName(token);
}

function shellRuleMatchesPreview(rule: ShellCommandRule, command: string): boolean {
  const normalizedCommand = command.trim();
  const pattern = rule.pattern.trim();
  if (rule.matchType === 'exact') return normalizedCommand === pattern;
  if (rule.matchType === 'executable') {
    return previewExecutable(normalizedCommand) === executableName(pattern);
  }
  return normalizedCommand === pattern
    || (normalizedCommand.startsWith(pattern)
      && /^\s/.test(normalizedCommand.slice(pattern.length)));
}

/** Mirrors backend rule precedence for a non-authoritative UI match preview. */
export function previewShellCommandPolicy(
  command: string,
  defaultEffect: ShellCommandAction,
  rules: ShellCommandRule[]
): ShellCommandRulePreview {
  for (const effect of ['deny', 'ask', 'allow'] as const) {
    const matchedRule = rules.find(rule => (
      rule.enabled && rule.action === effect && shellRuleMatchesPreview(rule, command)
    ));
    if (matchedRule) return { effect, matchedRule };
  }
  return { effect: defaultEffect, matchedRule: null };
}

export const TOOL_OVERRIDE_PREFIX = 'tool_approval.override.';

const CAPABILITY_KEYWORDS: Array<[ToolCapability, string[]]> = [
  ['automation', ['shell', 'terminal', 'command', 'process', 'script', 'automation', 'schedule', 'job', 'exec']],
  ['files', ['file', 'folder', 'directory', 'workspace', 'artifact', 'document', 'pdf', 'canvas', 'path']],
  ['web', ['web', 'search', 'browser', 'http', 'fetch', 'url', 'news', 'trending', 'media']],
  ['knowledge', ['note', 'memory', 'knowledge', 'rag', 'textbook', 'graph', 'semantic']],
  ['learning', ['anki', 'flashcard', 'question', 'qbank', 'exam', 'practice', 'review', 'essay', 'grading', 'study', 'todo']],
  ['data', ['database', 'sqlite', 'sql', 'table', 'import', 'export', 'backup', 'sync', 'dataset']],
  ['communication', ['chat', 'message', 'session', 'notification', 'wecom', 'email', 'conversation']],
];

export function stripToolPrefix(name?: string): string {
  if (!name) return '';
  return name
    .replace(/^mcp[._-]/i, '')
    .replace(/^builtin[._-]/i, '');
}

/** Build the stable identity from a name that has already crossed the runtime bridge. */
export function makeToolIdentity(source: string, toolName: string): string {
  const normalizedSource = normalizeToolSource(source);
  return `${normalizedSource}::${toolName.trim()}`;
}

export function normalizeToolSource(source: string): string {
  const normalized = source.trim();
  return normalized === '__builtin__tools' ? 'builtin' : (normalized || 'mcp');
}

export function runtimeToolName(source: string, toolName: string): string {
  const normalizedSource = normalizeToolSource(source);
  const normalizedName = toolName.trim();
  if (normalizedSource === 'builtin' && !normalizedName.startsWith('builtin-')) {
    return `builtin-${normalizedName}`;
  }
  // ChatV2's external MCP bridge always prefixes the cached bridge name before
  // execution, even when the server-provided name already begins with `mcp_`.
  // Permission keys must use that runtime identity or per-server overrides will
  // never match the tool call seen by the approval pipeline.
  if (normalizedSource !== 'builtin') {
    return `mcp_${normalizedName}`;
  }
  return normalizedName;
}

export function toolPermissionDomain(toolName: string): string {
  const shortName = toolName
    .replace(/^builtin-/, '')
    .replace(/^builtin:/, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^mcp_/, '');
  return shortName.split('_').find(Boolean)?.toLowerCase() || 'other';
}

export function scopedToolOverrideKey(source: string, toolName: string): string {
  return `${TOOL_OVERRIDE_PREFIX}${makeToolIdentity(source, toolName)}`;
}

export function legacyToolOverrideKey(toolName: string): string {
  return `${TOOL_OVERRIDE_PREFIX}${toolName.trim()}`;
}

export function parseToolOverrideKey(settingKey: string): ParsedToolOverrideKey | null {
  if (!settingKey.startsWith(TOOL_OVERRIDE_PREFIX)) return null;
  const id = settingKey.slice(TOOL_OVERRIDE_PREFIX.length);
  if (!id) return null;

  const separator = id.indexOf('::');
  if (separator < 0) {
    return { id, source: null, toolName: id, scoped: false };
  }

  const source = id.slice(0, separator);
  const toolName = id.slice(separator + 2);
  if (!source || !toolName) return null;
  return { id, source, toolName, scoped: true };
}

export function classifyToolCapability(name: string, description?: string): ToolCapability {
  const text = `${name} ${description ?? ''}`.toLowerCase();
  for (const [capability, keywords] of CAPABILITY_KEYWORDS) {
    if (keywords.some(keyword => text.includes(keyword))) return capability;
  }
  return 'other';
}

export function formatToolSource(source: string): string {
  return source
    .replace(/^mcp[_:-]?/i, '')
    .replace(/^server[_:-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .trim() || source;
}

/** Build one row per concrete source/tool pair. Names shared by servers stay isolated. */
export function buildManagedPermissionTools(
  toolsBySource: ToolSnapshotsBySource
): ManagedPermissionTool[] {
  const tools = new Map<string, ManagedPermissionTool>();

  for (const [rawSource, snapshot] of Object.entries(toolsBySource)) {
    const source = normalizeToolSource(rawSource);
    for (const item of snapshot.items ?? []) {
      const snapshotName = item.name?.trim();
      if (!snapshotName) continue;
      const name = runtimeToolName(source, snapshotName);
      const id = makeToolIdentity(source, name);
      const existing = tools.get(id);
      if (existing) {
        if (!existing.description && item.description) {
          existing.description = item.description;
          existing.capability = classifyToolCapability(name, item.description);
        }
        continue;
      }
      tools.set(id, {
        id,
        source,
        name,
        display: stripToolPrefix(name),
        description: item.description ?? '',
        capability: classifyToolCapability(name, item.description),
        domain: toolPermissionDomain(name),
      });
    }
  }

  return Array.from(tools.values()).sort((left, right) => (
    left.display.localeCompare(right.display)
      || left.source.localeCompare(right.source)
      || left.name.localeCompare(right.name)
  ));
}

/** Scoped rules win; legacy name-only rules remain visible until users migrate them. */
export function resolveToolOverride(
  tool: ManagedPermissionTool,
  overrides: ReadonlyMap<string, ToolSensitivityLevel>
): ToolSensitivityLevel | null {
  return resolveToolOverrideEntry(tool, overrides)?.level ?? null;
}

export function resolveToolOverrideEntry(
  tool: ManagedPermissionTool,
  overrides: ReadonlyMap<string, ToolSensitivityLevel>
): ResolvedToolOverride | null {
  const scopedLevel = overrides.get(tool.id);
  if (scopedLevel) return { id: tool.id, level: scopedLevel, scoped: true };
  const legacyLevel = overrides.get(tool.name);
  if (legacyLevel) return { id: tool.name, level: legacyLevel, scoped: false };
  return null;
}

export function filterManagedPermissionTools(
  tools: ManagedPermissionTool[],
  effectiveLevels: ReadonlyMap<string, ToolSensitivityLevel>,
  filters: ToolPermissionFilters,
  directOverrides: ReadonlyMap<string, ToolSensitivityLevel> = effectiveLevels
): ManagedPermissionTool[] {
  const query = filters.query?.trim().toLocaleLowerCase() ?? '';
  const source = filters.source ?? 'all';
  const capability = filters.capability ?? 'all';
  const level = filters.level ?? 'all';
  const override = filters.override ?? 'all';

  return tools.filter(tool => {
    const configuredLevel = resolveToolOverride(tool, effectiveLevels);
    const hasDirectOverride = resolveToolOverride(tool, directOverrides) !== null;
    if (source !== 'all' && tool.source !== source) return false;
    if (capability !== 'all' && tool.capability !== capability) return false;
    if (level === 'default' && configuredLevel !== null) return false;
    if (level !== 'all' && level !== 'default' && configuredLevel !== level) return false;
    if (override === 'overridden' && !hasDirectOverride) return false;
    if (override === 'inherited' && hasDirectOverride) return false;
    if (!query) return true;
    return [tool.name, tool.display, tool.description, tool.source, formatToolSource(tool.source)]
      .some(value => value.toLocaleLowerCase().includes(query));
  });
}

export function selectedScopedOverrideKeys(
  tools: ManagedPermissionTool[],
  selectedIds: ReadonlySet<string>
): string[] {
  return tools
    .filter(tool => selectedIds.has(tool.id))
    .map(tool => scopedToolOverrideKey(tool.source, tool.name));
}

/** Return the concrete settings keys that currently affect the selection. */
export function selectedOverrideKeysForReset(
  tools: ManagedPermissionTool[],
  selectedIds: ReadonlySet<string>,
  overrides: ReadonlyMap<string, ToolSensitivityLevel>
): string[] {
  const keys = new Set<string>();
  for (const tool of tools) {
    if (!selectedIds.has(tool.id)) continue;
    const entry = resolveToolOverrideEntry(tool, overrides);
    if (entry) keys.add(`${TOOL_OVERRIDE_PREFIX}${entry.id}`);
  }
  return Array.from(keys);
}

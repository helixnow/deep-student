export type TemplateDebugLevel = 'info' | 'warn' | 'error' | 'debug';

export type TemplateDebugPhase =
  | 'tool:list'
  | 'tool:get'
  | 'tool:validate'
  | 'tool:create'
  | 'tool:update'
  | 'tool:fork'
  | 'tool:preview'
  | 'tool:delete'
  | 'tool:unknown'
  | 'block:state'
  | 'render:template'
  | 'system';

export interface TemplateDesignerToolDebugEvent {
  type: string;
  phase?: string;
  toolName: string;
  blockId?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  result?: unknown;
  error?: string;
  payload?: unknown;
}

export interface TemplateDesignerLifecycleEvent {
  level: TemplateDebugLevel;
  phase: TemplateDebugPhase;
  summary: string;
  detail?: unknown;
  templateId?: string;
  blockId?: string;
}

export const TEMPLATE_DESIGNER_TOOL_EVENT = 'template-designer-debug-tool-block';
export const TEMPLATE_DESIGNER_LIFECYCLE_EVENT = 'template-designer-debug-lifecycle';

const TEMPLATE_TOOL_NAMES = new Set([
  'template_list',
  'template_get',
  'template_validate',
  'template_create',
  'template_update',
  'template_fork',
  'template_preview',
  'template_delete',
]);

export function normalizeToolName(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/^builtin-/, '')
    .replace(/^mcp_/, '')
    .replace(/^builtin\./, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^tools\./, '');
}

export function isTemplateDesignerToolName(raw: string): boolean {
  return TEMPLATE_TOOL_NAMES.has(normalizeToolName(raw));
}

export function toTemplateDebugPhase(rawToolName: string): TemplateDebugPhase {
  const name = normalizeToolName(rawToolName);
  const map: Record<string, TemplateDebugPhase> = {
    template_list: 'tool:list',
    template_get: 'tool:get',
    template_validate: 'tool:validate',
    template_create: 'tool:create',
    template_update: 'tool:update',
    template_fork: 'tool:fork',
    template_preview: 'tool:preview',
    template_delete: 'tool:delete',
  };
  return map[name] ?? 'tool:unknown';
}

function extractTemplateId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const id = rec.templateId ?? rec.template_id ?? rec.usedTemplateId ?? rec.sourceTemplateId;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

function extractExpectedVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const patch = rec.patch;

  if (patch && typeof patch === 'object') {
    const patchObj = patch as Record<string, unknown>;
    const patchVersion = patchObj.expectedVersion ?? patchObj.expected_version;
    if (typeof patchVersion === 'string' && patchVersion.trim()) return patchVersion;
  }

  const direct = rec.expectedVersion ?? rec.expected_version;
  return typeof direct === 'string' && direct.trim() ? direct : undefined;
}

export function buildTemplateToolSummary(
  rawToolName: string,
  phase: string,
  toolInput?: unknown,
  toolOutput?: unknown,
  error?: string,
): string {
  const toolName = normalizeToolName(rawToolName) || rawToolName || 'unknown';
  const templateId = extractTemplateId(toolInput) ?? extractTemplateId(toolOutput);
  const expectedVersion = extractExpectedVersion(toolInput);

  if (phase === 'error') {
    return `✗ ${toolName} FAILED: ${error || 'unknown error'}`;
  }

  if (phase === 'start') {
    const kind = toolInput || toolOutput ? 'call' : 'preparing';
    return `→ ${toolName} [${kind}]${templateId ? ` | templateId=${templateId}` : ''}${expectedVersion ? ` | expectedVersion=${expectedVersion}` : ''}`;
  }

  const status =
    toolOutput && typeof toolOutput === 'object' && 'status' in (toolOutput as Record<string, unknown>)
      ? String((toolOutput as Record<string, unknown>).status)
      : 'ok';
  return `← ${toolName} | status=${status}${templateId ? ` | templateId=${templateId}` : ''}`;
}

export function emitTemplateDesignerToolEvent(detail: TemplateDesignerToolDebugEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TEMPLATE_DESIGNER_TOOL_EVENT, { detail }));
}

export function emitTemplateDesignerLifecycle(detail: TemplateDesignerLifecycleEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TEMPLATE_DESIGNER_LIFECYCLE_EVENT, { detail }));
}

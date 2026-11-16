/**
 * Host workshop errors (`WORKSHOP_*`, `SAFE_MODE_ACTIVE`, compiler/lifecycle text) → one plain sentence and a next
 * step. The raw text stays available for the collapsed 「技术信息」; it is never the headline.
 */
/**
 * `retry`: run the same proposal again directly (继续做 after an interruption); `redo`: a new proposal of the same
 * description for this app version (按新版重做).
 */
export type WorkshopNextStep = 'repair' | 'continue' | 'retry' | 'redo' | 'refresh' | 'none';

export interface WorkshopErrorDescription {
  /** `plugin_manager:workshop.errors.<key>` */
  key: string;
  values?: Record<string, string>;
  next: WorkshopNextStep;
  raw: string;
}

const rules: readonly (readonly [RegExp, string, WorkshopNextStep])[] = [
  [/UI_ERROR_BUDGET/, 'crashed', 'repair'],
  [/generation interrupted by Host shutdown/i, 'interrupted', 'retry'],
  // Made for another app version: the code is not broken, it needs making again for this version.
  [/\b(?:ENGINE_INCOMPATIBLE|REQUIRES_INCOMPATIBLE|REQUIRES_MISSING|MANIFEST_VERSION_UNSUPPORTED)\b/, 'incompatible', 'redo'],
  [/candidate is not active; retained version is running/i, 'notActive', 'repair'],
  [/declares agentTools cannot (?:import modules|use the global|use dynamic import)/i, 'sealed', 'repair'],
  [/belongs to another conversation/i, 'otherConversation', 'none'],
  // The user fixes these on the card itself (the address field and 「改好了，再试一次」).
  [/^WORKSHOP_LINK\b/m, 'linkUnreadable', 'none'],
  [/^WORKSHOP_SETTING_MISSING\b/m, 'settingMissing', 'none'],
  [/^WORKSHOP_SETTING_INVALID\b/m, 'settingInvalid', 'none'],
  [/^WORKSHOP_OPEN_TIMEOUT\b/m, 'openTimeout', 'refresh'],
  [/^WORKSHOP_NOT_STARTED\b/m, 'notStarted', 'none'],
  [/^WORKSHOP_CONFLICT\b/m, 'conflict', 'refresh'],
  [/^WORKSHOP_STATE: no successful version retained|没有可回退的上一版/m, 'noPrevious', 'none'],
  [/^WORKSHOP_STATE\b/m, 'state', 'refresh'],
  [/^WORKSHOP_GENERATION_UNAVAILABLE\b/m, 'generationUnavailable', 'none'],
  [/SAFE_MODE_ACTIVE/, 'safeMode', 'none'],
  [/profile is read-only|^WORKSHOP_INSTALL_UNAVAILABLE\b/m, 'readOnly', 'none'],
  [/WORKSHOP_SELF_CHECK_UNAVAILABLE/, 'servicesUnavailable', 'none'],
  [/^WORKSHOP_NOT_FOUND\b/m, 'notFound', 'none'],
  [/^WORKSHOP_SKILL_MISSING\b/m, 'skillMissing', 'none'],
  [/^WORKSHOP_ONLY_MANAGED\b/m, 'onlyManaged', 'none'],
  // Module-level degraded reasons the kernel reports for an installed work that could not start.
  [/^(?:IMPORT_FAILED|APPLY_FAILED|SERVICE_MISSING|PERMISSION_UNDECLARED|KERNEL_API_FORBIDDEN|SERVICE_CONFLICT)\b|activation failed/im, 'activationFailed', 'repair'],
  [/^WORKSHOP_INVALID\b|Unsupported shared UI module|Transform failed|Build failed|ERROR:/m, 'invalid', 'repair'],
];

/** App services a self-check could not reach (`… application services unavailable: notes, chat`). */
export function unavailableServices(text: string): string[] {
  const match = /application services unavailable:\s*([^\n]+)/i.exec(text);
  return match ? match[1]!.split(',').map(name => name.trim()).filter(Boolean) : [];
}

export function describeWorkshopError(raw: string, name = ''): WorkshopErrorDescription {
  const text = raw.trim();
  for (const [pattern, key, next] of rules) {
    if (!pattern.test(text)) continue;
    // Which app feature to turn back on (names translated by the notice: permission.serviceNames.<name>).
    if (key === 'servicesUnavailable') {
      const services = unavailableServices(text);
      return services.length ? { key: 'servicesDisabled', next, raw: text, values: { services: services.join(',') } } : { key, next, raw: text };
    }
    return { key, next, raw: text, ...(key === 'crashed' || key === 'activationFailed' || key === 'incompatible' ? { values: { name } } : {}) };
  }
  return { key: 'unknown', next: 'repair', raw: text };
}

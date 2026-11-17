export interface WorkshopSessionTarget { pluginId: string; version: string; workshopId: string; revision: number }

/** Root/chat assembly supplies existing session APIs; no global Agent setters or send API are exposed. */
export interface WorkshopSessionPort {
  create(options: { mode: 'chat'; title: string; metadata: Record<string, unknown> }): Promise<{ id: string }>;
  activateSkill(sessionId: string, skillId: string): Promise<boolean>;
  bindSession(workshopId: string, revision: number, sessionId: string): Promise<void>;
  navigate(sessionId: string): void;
  /** Put a starter sentence in the session's input box. It is never sent on the user's behalf. */
  prefill?(sessionId: string, text: string): void | Promise<void>;
  /** Send text the user explicitly submitted in the workshop composer. */
  submit?(sessionId: string, text: string): Promise<void>;
  /** Move keyboard focus to that session's composer. */
  focus?(sessionId: string): void;
  /** Whether a conversation still exists (it may have been deleted). */
  exists?(sessionId: string): Promise<boolean>;
  /** Show (or clear with null) the 「正在修改：<名> v<版本>」 strip above that session's composer. */
  setEditing?(sessionId: string, label: string | null): void;
}

export async function openWorkshopSession(port: WorkshopSessionPort, target?: WorkshopSessionTarget, prompt?: string): Promise<string> {
  const session = await port.create({
    mode: 'chat', title: target ? '修改插件' : '插件工坊',
    metadata: { dstuWorkshop: { kind: target ? 'modify' : 'create', ...target } },
  });
  if (target) await port.bindSession(target.workshopId, target.revision, session.id);
  // Only this new session is touched. Existing session input/attachments and global defaults are preserved.
  const activated = await port.activateSkill(session.id, 'dstu-plugin-development');
  // RUST-FIX(RF-P6-manager-cards): conversation starters from the plugin manager arrive as an editable draft.
  if (prompt?.trim()) await port.prefill?.(session.id, prompt.trim());
  port.navigate(session.id);
  if (!activated) throw new Error('WORKSHOP_SKILL_MISSING: workshop skill is not ready; the new conversation was kept');
  return session.id;
}

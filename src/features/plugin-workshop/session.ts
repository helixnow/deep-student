export interface WorkshopSessionTarget { pluginId: string; version: string; workshopId: string; revision: number }

/** Root/chat assembly supplies existing session APIs; no global Agent setters or send API are exposed. */
export interface WorkshopSessionPort {
  create(options: { mode: 'chat'; title: string; metadata: Record<string, unknown> }): Promise<{ id: string }>;
  activateSkill(sessionId: string, skillId: string): Promise<boolean>;
  bindSession(workshopId: string, revision: number, sessionId: string): Promise<void>;
  navigate(sessionId: string): void;
}

export async function openWorkshopSession(port: WorkshopSessionPort, target?: WorkshopSessionTarget): Promise<string> {
  const session = await port.create({
    mode: 'chat', title: target ? '修改插件' : '插件工坊',
    metadata: { dstuWorkshop: { kind: target ? 'modify' : 'create', ...target } },
  });
  if (target) await port.bindSession(target.workshopId, target.revision, session.id);
  // Only this new session is touched. Existing session input/attachments and global defaults are preserved.
  const activated = await port.activateSkill(session.id, 'dstu-plugin-development');
  port.navigate(session.id);
  if (!activated) throw new Error('插件工坊技能未就绪，请稍后重试。新会话已保留。');
  return session.id;
}

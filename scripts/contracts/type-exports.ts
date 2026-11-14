// generated/<lane>.ts 的类型名是 Host / 前端的 import 面；即使类型被内联、改名或移到
// _shared，也必须在原文件保留同名导出。新增条目时写明来源，生成器会校验来源仍存在。
export type CompatExport =
  /** 从 _shared.ts re-export（def 默认为同名）。 */
  | { name: string; from: 'shared'; def?: string }
  /** 从另一个 lane 的 $defs 复制形状（避免 lane 之间产生运行时/循环依赖）。 */
  | { name: string; fromLane: string; def: string }
  /** 内联后没有独立 def 的类型：用当前契约里的等价 TS 表达式保留旧名。 */
  | { name: string; alias: string };

export const STABLE_TYPE_EXPORTS: Record<string, CompatExport[]> = {
  'F2-shell': [
    // PersistedJob 在 flatten 修复期间曾由 F2 直接导出；为兼容强制放回 _shared 后仍保留 F2 旧名。
    { name: 'PersistedJob', from: 'shared' },
  ],
  'L10-notes': [
    // NoteFormat 已 flatten 进 NoteFormatStatus；保留原独立类型名。
    { name: 'NoteFormat', alias: "Omit<NoteFormatStatus, 'required_capabilities' | 'updated_at'>" },
    // VfsError 无 serde Serialize，历史上是 unresolved 占位；保留旧名避免既有 import 断裂。
    { name: 'VfsError', alias: 'unknown /* x-unresolved: dstu_vfs::vfs::error::VfsError has no serde Serialize */' },
  ],
  'L19-mcp-browser': [
    // BrowserSessionState 已 flatten 进 BrowserStateResult。
    { name: 'BrowserSessionState', alias: "Omit<BrowserStateResult, 'history' | 'agentAutomationSupported'>" },
  ],
  'L21-backup-governance': [
    // 这些类型移到 _shared 后仍需从 L21 原位置可导入。
    { name: 'BackupJobKind', from: 'shared' },
    { name: 'BackupJobPhase', from: 'shared' },
    { name: 'BackupJobStatus', from: 'shared' },
    { name: 'JobCheckpoint', from: 'shared' },
    // ResumableJobResponse flatten 后 PersistedJob 只由 F2 事件引用；为兼容强制放回 _shared。
    { name: 'PersistedJob', from: 'shared' },
    // 同名类型跨 lane 冲突后生成了限定名，保留原短名。
    { name: 'ImportProgress', alias: 'dstu_storage__backup_common__ImportProgress' },
  ],
};

/** 为了兼容旧导出而强制保留在 _shared 的定义（按生成后的类型名）。 */
export const FORCED_SHARED_DEFS = ['PersistedJob'];

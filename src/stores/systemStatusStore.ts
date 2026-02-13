import { create } from 'zustand';

export type SystemStatusLevel = 'info' | 'warning' | 'error';

interface SystemStatusState {
  migrationVisible: boolean;
  migrationLevel: SystemStatusLevel;
  migrationMessage: string;
  migrationDetails?: string;
  showMigrationStatus: (payload: {
    level: SystemStatusLevel;
    message: string;
    details?: string;
  }) => void;
  clearMigrationStatus: () => void;

  /** 全局维护模式：备份/恢复期间阻止其他模块写入数据库 */
  maintenanceMode: boolean;
  /** 维护模式原因描述（用于 UI 提示） */
  maintenanceReason: string | null;
  /** 进入维护模式 */
  enterMaintenanceMode: (reason: string) => void;
  /** 退出维护模式 */
  exitMaintenanceMode: () => void;
}

export const useSystemStatusStore = create<SystemStatusState>((set) => ({
  migrationVisible: false,
  migrationLevel: 'info',
  migrationMessage: '',
  migrationDetails: undefined,
  showMigrationStatus: ({ level, message, details }) =>
    set({
      migrationVisible: true,
      migrationLevel: level,
      migrationMessage: message,
      migrationDetails: details,
    }),
  clearMigrationStatus: () =>
    set({
      migrationVisible: false,
      migrationLevel: 'info',
      migrationMessage: '',
      migrationDetails: undefined,
    }),

  maintenanceMode: false,
  maintenanceReason: null,
  enterMaintenanceMode: (reason: string) =>
    set({
      maintenanceMode: true,
      maintenanceReason: reason,
    }),
  exitMaintenanceMode: () =>
    set({
      maintenanceMode: false,
      maintenanceReason: null,
    }),
}));

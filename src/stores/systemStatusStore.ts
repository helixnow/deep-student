import { create } from 'zustand';
import type { StartupComponentIssue } from '@/types/dataGovernance';

export type SystemStatusLevel = 'info' | 'warning' | 'error';
export type { StartupComponentIssue, StartupComponentStatus } from '@/types/dataGovernance';

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
  /** 后台任务已终止但仍有子库保持 fail-close，需要重启恢复 */
  maintenanceRequiresRestart: boolean;
  /** 每次维护状态写入递增，用于拒绝异步重连的过期结果 */
  maintenanceGeneration: number;
  /** 进入维护模式 */
  enterMaintenanceMode: (reason: string) => void;
  /** 进入“需重启恢复”的维护终态 */
  requireMaintenanceRestart: (reason: string) => void;
  /** 退出维护模式 */
  exitMaintenanceMode: () => void;
  /** 启动期各数据组件可用性；与全局备份/恢复维护模式分开。 */
  componentHealth: StartupComponentIssue[];
  setComponentHealth: (components: StartupComponentIssue[]) => void;
  isComponentBlocked: (component: string) => boolean;
}

export const useSystemStatusStore = create<SystemStatusState>((set, get) => ({
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
  maintenanceRequiresRestart: false,
  maintenanceGeneration: 0,
  enterMaintenanceMode: (reason: string) =>
    set((state) => ({
      maintenanceMode: true,
      maintenanceReason: reason,
      maintenanceRequiresRestart: false,
      maintenanceGeneration: state.maintenanceGeneration + 1,
    })),
  requireMaintenanceRestart: (reason: string) =>
    set((state) => ({
      maintenanceMode: true,
      maintenanceReason: reason,
      maintenanceRequiresRestart: true,
      maintenanceGeneration: state.maintenanceGeneration + 1,
    })),
  exitMaintenanceMode: () =>
    set((state) => {
      // 恢复切槽已经登记后，当前进程绝不能因某个调用方的 finally 撤掉写屏障。
      // 该状态只会随进程重启重新初始化；新进程在槽激活、迁移和校验完成后
      // 才会由后端解除持久化维护租约。
      if (state.maintenanceRequiresRestart) {
        return state;
      }
      return {
        maintenanceMode: false,
        maintenanceReason: null,
        maintenanceRequiresRestart: false,
        maintenanceGeneration: state.maintenanceGeneration + 1,
      };
    }),
  componentHealth: [],
  setComponentHealth: (components) => set({ componentHealth: components }),
  isComponentBlocked: (component) =>
    get()
      .componentHealth
      .some((entry) => entry.component === component && entry.status === 'blocked'),
}));

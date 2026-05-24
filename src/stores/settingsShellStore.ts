import { create } from 'zustand';
import type { PendingSettingsRoute } from '@/utils/pendingSettingsTab';
import type { DashboardTab } from '@/types/dataGovernance';

export type DataGovernanceTabTarget = {
  tab: DashboardTab;
  requestId: number;
};

interface SettingsShellState {
  activeTab: string;
  dataGovernanceTabTarget: DataGovernanceTabTarget | null;
  setActiveTab: (tab: string) => void;
  requestDataGovernanceTab: (tab: unknown) => void;
  applySettingsRoute: (route: PendingSettingsRoute) => void;
}

const DATA_GOVERNANCE_TABS: ReadonlySet<string> = new Set([
  'overview',
  'archive',
  'backup',
  'sync',
  'audit',
  'cache',
  'debug',
]);

const DATA_GOVERNANCE_TAB_ALIASES: Record<string, DashboardTab> = {
  trash: 'archive',
};

const SETTINGS_TAB_MAPPING: Record<string, string> = {
  app: 'general',
  general: 'general',
  appearance: 'appearance',
  api: 'apis',
  apis: 'apis',
  search: 'search',
  models: 'models',
  mcp: 'mcp',
  statistics: 'statistics',
  data: 'data-governance',
  'data-governance': 'data-governance',
  params: 'params',
  shortcuts: 'shortcuts',
  about: 'about',
};

function normalizeDataGovernanceTab(value: unknown): DashboardTab | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed in DATA_GOVERNANCE_TAB_ALIASES) {
    return DATA_GOVERNANCE_TAB_ALIASES[trimmed];
  }
  return DATA_GOVERNANCE_TABS.has(trimmed) ? (trimmed as DashboardTab) : null;
}

function normalizeSettingsTab(value: string): string {
  const trimmed = value.trim();
  return SETTINGS_TAB_MAPPING[trimmed] ?? trimmed;
}

export const useSettingsShellStore = create<SettingsShellState>()((set, get) => ({
  activeTab: 'apis',
  dataGovernanceTabTarget: null,
  setActiveTab: (tab) => set({ activeTab: tab }),
  requestDataGovernanceTab: (tab) => {
    const normalized = normalizeDataGovernanceTab(tab);
    if (!normalized) return;

    set((state) => ({
      dataGovernanceTabTarget: {
        tab: normalized,
        requestId: (state.dataGovernanceTabTarget?.requestId ?? 0) + 1,
      },
    }));
  },
  applySettingsRoute: (route) => {
    const mappedTab = normalizeSettingsTab(route.tab);
    set({ activeTab: mappedTab });

    if (mappedTab === 'data-governance') {
      get().requestDataGovernanceTab(route.dataGovernanceTab);
    }
  },
}));

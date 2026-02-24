import type { Dispatch, SetStateAction } from 'react';
import type { TFunction } from 'i18next';
import type { SystemConfig } from './types';
import type { ApiConfig, ModelAssignments, VendorConfig, ModelProfile } from '../../types';
import type { ThemeMode, ThemePalette } from '../../hooks/useTheme';
import type { ZoomStatusState } from './constants';
import type { ScreenPosition } from '../layout';
import type { McpStatusInfo } from '../../mcp/mcpService';

export interface McpToolConfig {
  id: string;
  name: string;
  transportType?: 'stdio' | 'websocket' | 'sse' | 'streamable_http';
  connected?: boolean;
  url?: string;
  command?: string;
  args?: string | string[];
  env?: Record<string, string>;
  endpoint?: string;
  apiKey?: string;
  fetch?: { type: 'sse' | 'streamable_http'; url: string };
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SettingsExtra {
  chatSemanticFtsPrefilter?: boolean;
  rrf_k?: string;
  rrf_w_fts?: string;
  rrf_w_vec?: string;
  chatStreamTimeoutSeconds?: string;
  chatStreamAutoCancel?: boolean;
  _lastSavedTimeoutSeconds?: string;
  [key: string]: unknown;
}

export interface UseSettingsConfigDeps {
  setLoading: (v: boolean) => void;
  setExtra: Dispatch<SetStateAction<SettingsExtra>>;
  setActiveTab: (v: string) => void;
  activeTab: string;
  modelAssignments: ModelAssignments;
  vendors: VendorConfig[];
  modelProfiles: ModelProfile[];
  resolvedApiConfigs: ApiConfig[];
  refreshVendors: (() => Promise<void>) | undefined;
  refreshProfiles: (() => Promise<void>) | undefined;
  refreshApiConfigsFromBackend: () => Promise<void>;
  persistAssignments: (a: ModelAssignments) => Promise<void>;
  saving: boolean;
  setSaving: (v: boolean) => void;
  t: TFunction;
  config: SystemConfig;
  setConfig: Dispatch<SetStateAction<SystemConfig>>;
  loading: boolean;
  updateIndicatorRaf: (tabId: string) => void;
}

export interface UseSettingsZoomFontDeps {
  isTauriEnvironment: boolean;
  setZoomLoading: (v: boolean) => void;
  setUiZoom: (v: number) => void;
  setZoomSaving: (v: boolean) => void;
  setZoomStatus: (v: ZoomStatusState) => void;
  t: TFunction;
  setFontLoading: (v: boolean) => void;
  setUiFont: (v: string) => void;
  setFontSaving: (v: boolean) => void;
  setFontSizeLoading: (v: boolean) => void;
  setUiFontSize: (v: number) => void;
  setFontSizeSaving: (v: boolean) => void;
  config: SystemConfig;
}

export interface UseSettingsVendorStateDeps {
  resolvedApiConfigs: ApiConfig[];
  vendorLoading: boolean;
  vendorSaving: boolean;
  vendors: VendorConfig[];
  modelProfiles: ModelProfile[];
  modelAssignments: ModelAssignments;
  config: SystemConfig;
  t: TFunction;
  loading: boolean;
  upsertVendor: (v: VendorConfig) => Promise<VendorConfig>;
  upsertModelProfile: (p: ModelProfile) => Promise<ModelProfile>;
  deleteModelProfile: (id: string) => Promise<void>;
  persistAssignments: (a: ModelAssignments) => Promise<void>;
  persistModelProfiles: (profiles: ModelProfile[]) => Promise<void>;
  persistVendors?: (vendors: VendorConfig[]) => Promise<void>;
  closeRightPanel: () => void;
  refreshVendors: (() => Promise<void>) | undefined;
  refreshProfiles: (() => Promise<void>) | undefined;
  refreshApiConfigsFromBackend: () => Promise<void>;
  isSmallScreen: boolean;
  setScreenPosition: (v: ScreenPosition) => void;
  setRightPanelType: (v: 'none' | 'modelEditor' | 'mcpTool' | 'mcpPolicy' | 'vendorConfig') => void;
  activeTab: string;
  deleteVendorById: (id: string) => Promise<void>;
}

export interface UseMcpEditorSectionDeps {
  config: SystemConfig;
  setConfig: Dispatch<SetStateAction<SystemConfig>>;
  isSmallScreen: boolean;
  activeTab: string;
  setActiveTab: (v: string) => void;
  setScreenPosition: (v: ScreenPosition) => void;
  setRightPanelType: (v: 'none' | 'modelEditor' | 'mcpTool' | 'mcpPolicy' | 'vendorConfig') => void;
  t: TFunction;
  extra: SettingsExtra;
  setExtra: Dispatch<SetStateAction<SettingsExtra>>;
  handleSave: (silent?: boolean) => Promise<void>;
  normalizedMcpServers: McpToolConfig[];
  setMcpStatusInfo: (v: McpStatusInfo | null) => void;
}

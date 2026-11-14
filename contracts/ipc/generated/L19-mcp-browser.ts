// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L19-mcp-browser.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_browser::browser::events::BrowserClosedPayload */
export type BrowserClosedPayload = {
  sessionId: string;
  label: string;
  reason: string;
  at: string;
};
/** dstu_browser::browser::events::BrowserContentUserInputPayload */
export type BrowserContentUserInputPayload = {
  sessionId: string;
  label: string;
  kind: string;
  at: string;
};
/** dstu_browser::browser::events::BrowserControlModeChangedPayload */
export type BrowserControlModeChangedPayload = {
  sessionId: string;
  label: string;
  controlMode: string;
  reason: string;
  at: string;
};
/** dstu_browser::browser::service::BrowserDownloadObservation */
export type BrowserDownloadObservation = {
  id: string;
  browserSessionId: string;
  chatSessionId: string;
  url: string;
  filename: string;
  state: BrowserDownloadState;
  rootId: string;
  relativePath: string;
  locator: string;
  sha256: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  objectHandle: Shared.TaskObjectHandle | null;
};
/** dstu_browser::browser::service::BrowserDownloadState */
export type BrowserDownloadState = "started" | "processing" | "completed" | "failed";
/** dstu_browser::browser::events::BrowserNavigatedPayload */
export type BrowserNavigatedPayload = {
  sessionId: string;
  label: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  at: string;
};
/** dstu_browser::browser::events::BrowserNavigationBlockedPayload */
export type BrowserNavigationBlockedPayload = {
  sessionId: string;
  label: string;
  url: string;
  reason: string;
  currentUrl: string | null;
  title: string | null;
  canGoBack: boolean | null;
  canGoForward: boolean | null;
  historyIndex: number | null;
  at: string;
};
/** dstu_browser::cmd::browser::BrowserSnapshotResult */
export type BrowserSnapshotResult = {
  sessionId: string;
  url: string;
  title: string;
  snapshot: string;
};
/** dstu_browser::cmd::browser::BrowserStateResult */
export type BrowserStateResult = {
  id: string;
  label: string;
  title: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  alive: boolean;
  controlMode: ControlMode;
  historyIndex: number;
  historyLen: number;
  chatSessionId: string | null;
  profilePath: string;
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
  agentAutomationSupported: boolean;
};
/** dstu_browser::browser::events::BrowserTitleChangedPayload */
export type BrowserTitleChangedPayload = {
  sessionId: string;
  label: string;
  title: string;
  url: string;
  at: string;
};
/** dstu_mcp::tools::ConflictResolution */
export type ConflictResolution = "UseLocal" | "UseMcp" | "UseNamespace";
/** dstu_browser::browser::session::ControlMode */
export type ControlMode = "user" | "agent";
/** dstu_browser::browser::session::HistoryEntry */
export type HistoryEntry = {
  url: string;
  title: string;
  visitedAt: string;
};
/** dstu_mcp::mcp::config::McpConfig */
export type McpConfig = {
  enabled: boolean;
  protocol_version: string;
  transport: McpTransportConfig;
  tools: McpToolsConfig;
  performance: McpPerformanceConfig;
};
/** dstu_mcp::mcp::config::McpConfig */
export type McpConfig__De = {
  enabled: boolean;
  protocol_version?: string;
  transport: McpTransportConfig__De;
  tools: McpToolsConfig__De;
  performance: McpPerformanceConfig__De;
};
/** dstu_mcp::mcp::config::McpFraming */
export type McpFraming = "jsonl" | "content_length";
/** dstu_mcp::mcp::config::McpFraming */
export type McpFraming__De = ("jsonl" | "content_length") | {
  jsonl: null;
} | {
  content_length: null;
};
/** dstu_mcp::mcp::commands::McpOAuthStatus */
export type McpOAuthStatus = {
  server_id: string;
  authorized: boolean;
};
/** dstu_mcp::mcp::config::McpPerformanceConfig */
export type McpPerformanceConfig = {
  timeout_ms: number;
  rate_limit_per_second: number;
  cache_max_size: number;
  cache_ttl_ms: number;
};
/** dstu_mcp::mcp::config::McpPerformanceConfig */
export type McpPerformanceConfig__De = {
  timeout_ms: number;
  rate_limit_per_second: number;
  cache_max_size: number;
  cache_ttl_ms: number;
};
/** dstu_mcp::mcp::config::McpToolsConfig */
export type McpToolsConfig = {
  cache_ttl_ms: number;
  advertise_all_tools: boolean;
  whitelist: string[];
  blacklist: string[];
};
/** dstu_mcp::mcp::config::McpToolsConfig */
export type McpToolsConfig__De = {
  cache_ttl_ms: number;
  advertise_all_tools: boolean;
  whitelist: string[];
  blacklist: string[];
};
/** dstu_mcp::mcp::config::McpTransportConfig */
export type McpTransportConfig = {
  type: "stdio";
  command: string;
  args: string[];
  port?: number | null;
  working_dir?: string | null;
  framing: McpFraming;
  env: { [key: string]: string };
} | {
  type: "websocket";
  url: string;
  env: { [key: string]: string };
} | {
  type: "sse";
  endpoint: string;
  api_key?: string | null;
  oauth?: OAuthConfig | null;
  headers: { [key: string]: string };
} | {
  type: "http";
  url: string;
  api_key?: string | null;
  oauth?: OAuthConfig | null;
  headers: { [key: string]: string };
} | {
  type: "streamable_http";
  url: string;
  api_key?: string | null;
  oauth?: OAuthConfig | null;
  headers: { [key: string]: string };
};
/** dstu_mcp::mcp::config::McpTransportConfig */
export type McpTransportConfig__De = {
  type: "stdio";
  command: string;
  args: string[];
  port?: number | null;
  working_dir?: string | null;
  framing: McpFraming__De;
  env?: { [key: string]: string };
} | {
  type: "websocket";
  url: string;
  env?: { [key: string]: string };
} | {
  type: "sse";
  endpoint: string;
  api_key?: string | null;
  oauth?: OAuthConfig__De | null;
  headers?: { [key: string]: string };
} | {
  type: "http";
  url: string;
  api_key?: string | null;
  oauth?: OAuthConfig__De | null;
  headers?: { [key: string]: string };
} | {
  type: "streamable_http";
  url: string;
  api_key?: string | null;
  oauth?: OAuthConfig__De | null;
  headers?: { [key: string]: string };
};
/** deep_student_lib::cmd::network::NetworkProbeResult */
export type NetworkProbeResult = {
  ok: boolean;
  statusCode: number | null;
  rttMs: number;
  error: string | null;
};
/** dstu_mcp::mcp::config::OAuthConfig */
export type OAuthConfig = {
  client_id: string;
  auth_url: string;
  token_url: string;
  redirect_uri: string;
  scopes: string[];
  client_secret?: string | null;
};
/** dstu_mcp::mcp::config::OAuthConfig */
export type OAuthConfig__De = {
  client_id?: string;
  auth_url?: string;
  token_url?: string;
  redirect_uri?: string;
  scopes?: string[];
  client_secret?: string | null;
};
/** dstu_mcp::tools::web_search::ProviderStrategies */
export type ProviderStrategies = {
  default: ProviderStrategy;
  bing_rss?: ProviderStrategy | null;
  google_cse?: ProviderStrategy | null;
  serpapi?: ProviderStrategy | null;
  tavily?: ProviderStrategy | null;
  brave?: ProviderStrategy | null;
  searxng?: ProviderStrategy | null;
  zhipu?: ProviderStrategy | null;
  bocha?: ProviderStrategy | null;
  deepseek?: ProviderStrategy | null;
};
/** dstu_mcp::tools::web_search::ProviderStrategy */
export type ProviderStrategy = {
  timeout_ms?: number | null;
  max_retries?: number | null;
  initial_retry_delay_ms?: number | null;
  max_retry_delay_ms?: number | null;
  backoff_multiplier?: number | null;
  max_concurrent_requests?: number | null;
  rate_limit_per_minute?: number | null;
  cache_enabled?: boolean | null;
  cache_ttl_seconds?: number | null;
  cache_max_entries?: number | null;
  special_handling?: SpecialHandling | null;
};
/** dstu_mcp::tools::web_search::SpecialHandling */
export type SpecialHandling = {
  handle_429_retry_after: boolean;
  exponential_backoff_on_5xx: boolean;
};
/** dstu_mcp::mcp::auth::StartOAuthOutcome */
export type StartOAuthOutcome = {
  server_id: string;
  token_type: string;
  expires_at: string | null;
  authorization_url: string;
  redirect_uri: string;
};
/** dstu_browser::browser::service::SurfaceCssOcclusion */
export type SurfaceCssOcclusion = {
  x: number;
  y: number;
  width: number;
  height: number;
};
/** dstu_mcp::tools::ToolConflict */
export type ToolConflict = {
  name: string;
  local_available: boolean;
  mcp_available: boolean;
  suggested_mcp_name: string;
  resolution: ConflictResolution;
};

/* ---------- 历史导出名（兼容既有 import，勿删） ---------- */
/** 兼容导出：保留旧名 BrowserSessionState */
export type BrowserSessionState = Omit<BrowserStateResult, 'history' | 'agentAutomationSupported'>;

export interface Commands {
  /** crates/dstu-browser/src/cmd/browser.rs:158 `browser_back` */
  browser_back: {
    args: {
      sessionId: string;
    };
    result: BrowserStateResult;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:390 `browser_click` */
  browser_click: {
    args: {
      sessionId: string;
      ref: string;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:210 `browser_close` */
  browser_close: {
    args: {
      sessionId?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:317 `browser_content_user_input` */
  browser_content_user_input: {
    args: {
      sessionId: string;
      nonce: string;
      kind: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:232 `browser_focus` */
  browser_focus: {
    args: {
      sessionId?: string | null;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:168 `browser_forward` */
  browser_forward: {
    args: {
      sessionId: string;
    };
    result: BrowserStateResult;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:191 `browser_get_state` */
  browser_get_state: {
    args: {
      sessionId?: string | null;
    };
    result: BrowserStateResult | null;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:310 `browser_get_surface_host_mode` */
  browser_get_surface_host_mode: {
    args: Record<string, never>;
    result: string;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:443 `browser_list_downloads` */
  browser_list_downloads: {
    args: {
      sessionId: string;
    };
    result: BrowserDownloadObservation[];
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:454 `browser_list_task_downloads` */
  browser_list_task_downloads: {
    args: {
      chatSessionId: string;
    };
    result: BrowserDownloadObservation[];
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:134 `browser_navigate` */
  browser_navigate: {
    args: {
      sessionId: string;
      url: string;
      replace?: boolean | null;
      fromAgent?: boolean | null;
    };
    result: BrowserStateResult;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:109 `browser_open_session` */
  browser_open_session: {
    args: {
      url: string;
      displayName?: string | null;
      chatSessionId?: string | null;
      reuseExisting?: boolean | null;
      fromAgent?: boolean | null;
    };
    result: BrowserStateResult;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:250 `browser_release_surface_focus` */
  browser_release_surface_focus: {
    args: {
      sessionId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:178 `browser_reload` */
  browser_reload: {
    args: {
      sessionId: string;
      hard?: boolean | null;
    };
    result: BrowserStateResult;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:464 `browser_scroll` */
  browser_scroll: {
    args: {
      sessionId: string;
      direction?: string | null;
      amount?: number | null;
      ref?: string | null;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:426 `browser_set_input_files` */
  browser_set_input_files: {
    args: {
      sessionId: string;
      ref: string;
      files: unknown;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:262 `browser_set_surface_bounds` */
  browser_set_surface_bounds: {
    args: {
      sessionId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
      occlusions?: SurfaceCssOcclusion[] | null;
      inputOcclusions?: SurfaceCssOcclusion[] | null;
      sequence: number;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:295 `browser_set_surface_visibility` */
  browser_set_surface_visibility: {
    args: {
      sessionId: string;
      visible: boolean;
      focus?: boolean | null;
    };
    result: string;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:357 `browser_snapshot` */
  browser_snapshot: {
    args: {
      sessionId: string;
      maxChars?: number | null;
    };
    result: BrowserSnapshotResult;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:335 `browser_take_over` */
  browser_take_over: {
    args: Record<string, never>;
    result: BrowserStateResult;
    error: string;
  };
  /** crates/dstu-browser/src/cmd/browser.rs:406 `browser_type` */
  browser_type: {
    args: {
      sessionId: string;
      ref: string;
      text: string;
      submit?: boolean | null;
    };
    result: unknown;
    error: string;
  };
  /** crates/dstu-mcp/src/mcp/commands.rs:43 `cancel_mcp_oauth` */
  cancel_mcp_oauth: {
    args: {
      serverId: string;
    };
    result: null;
    error: string;
  };
  /** src/cmd/web_search.rs:572 `delete_setting` */
  delete_setting: {
    args: {
      key: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:593 `delete_settings_by_prefix` */
  delete_settings_by_prefix: {
    args: {
      prefix: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:284 `detect_tool_conflicts` */
  detect_tool_conflicts: {
    args: Record<string, never>;
    result: ToolConflict[];
    error: Shared.AppError;
  };
  /** src/commands.rs:7025 `export_mcp_config` */
  export_mcp_config: {
    args: {
      config: McpConfig__De;
      format: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:235 `get_cn_whitelist_config` */
  get_cn_whitelist_config: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:363 `get_feature_flags` */
  get_feature_flags: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:7003 `get_mcp_config` */
  get_mcp_config: {
    args: Record<string, never>;
    result: McpConfig;
    error: Shared.AppError;
  };
  /** crates/dstu-mcp/src/mcp/commands.rs:81 `get_mcp_oauth_access_token` */
  get_mcp_oauth_access_token: {
    args: {
      serverId: string;
      resourceUrl: string;
    };
    result: string | null;
    error: string;
  };
  /** crates/dstu-mcp/src/mcp/commands.rs:61 `get_mcp_oauth_status` */
  get_mcp_oauth_status: {
    args: {
      serverId: string;
      resourceUrl: string;
    };
    result: McpOAuthStatus;
    error: string;
  };
  /** src/cmd/mcp.rs:25 `get_mcp_status` */
  get_mcp_status: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:792 `get_mcp_stdio_allow_unapproved` */
  get_mcp_stdio_allow_unapproved: {
    args: Record<string, never>;
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:58 `get_mcp_tools` */
  get_mcp_tools: {
    args: Record<string, never>;
    result: unknown[];
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:318 `get_provider_strategies_config` */
  get_provider_strategies_config: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:210 `get_security_status` */
  get_security_status: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:562 `get_setting` */
  get_setting: {
    args: {
      key: string;
    };
    result: string | null;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:581 `get_settings_by_prefix` */
  get_settings_by_prefix: {
    args: {
      prefix: string;
    };
    result: [string, string, string][];
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:291 `get_tools_namespace_config` */
  get_tools_namespace_config: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/commands.rs:7016 `import_mcp_config` */
  import_mcp_config: {
    args: {
      path: string;
    };
    result: McpConfig;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:454 `is_feature_enabled` */
  is_feature_enabled: {
    args: {
      featureName: string;
      userId?: string | null;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:654 `mcp_stdio_close` */
  mcp_stdio_close: {
    args: {
      sessionId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:639 `mcp_stdio_send` */
  mcp_stdio_send: {
    args: {
      sessionId: string;
      payload: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:553 `mcp_stdio_start` */
  mcp_stdio_start: {
    args: {
      command: string;
      args: string[];
      env?: { [key: string]: string } | null;
      framing?: string | null;
      cwd?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/network.rs:38 `network_probe` */
  network_probe: {
    args: {
      url: string;
      method?: string | null;
      timeoutMs?: number | null;
    };
    result: NetworkProbeResult;
    error: string;
  };
  /** src/cmd/mcp.rs:822 `preheat_mcp_tools` */
  preheat_mcp_tools: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:784 `reload_mcp_client` */
  reload_mcp_client: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** crates/dstu-mcp/src/mcp/commands.rs:49 `revoke_mcp_oauth` */
  revoke_mcp_oauth: {
    args: {
      serverId: string;
    };
    result: null;
    error: string;
  };
  /** src/cmd/mcp.rs:688 `save_mcp_config` */
  save_mcp_config: {
    args: {
      config: unknown;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:344 `save_provider_strategies_config` */
  save_provider_strategies_config: {
    args: {
      strategies: ProviderStrategies;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:541 `save_setting` */
  save_setting: {
    args: {
      key: string;
      value: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:801 `set_mcp_stdio_allow_unapproved` */
  set_mcp_stdio_allow_unapproved: {
    args: {
      enabled: boolean;
    };
    result: null;
    error: Shared.AppError;
  };
  /** crates/dstu-mcp/src/mcp/commands.rs:15 `start_mcp_oauth` */
  start_mcp_oauth: {
    args: {
      serverId: string;
      resourceUrl: string;
      clientId?: string | null;
      clientSecret?: string | null;
      scopes?: string[] | null;
    };
    result: StartOAuthOutcome;
    error: string;
  };
  /** src/cmd/web_search.rs:87 `test_all_search_engines` */
  test_all_search_engines: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:65 `test_mcp_connection` */
  test_mcp_connection: {
    args: {
      command: string;
      args: string[];
      env?: { [key: string]: string } | null;
      cwd?: string | null;
      framing?: string | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:172 `test_mcp_http` */
  test_mcp_http: {
    args: {
      endpoint: string;
      apiKey: string;
      env?: { [key: string]: string } | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:142 `test_mcp_sse` */
  test_mcp_sse: {
    args: {
      endpoint: string;
      apiKey: string;
      env?: { [key: string]: string } | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:119 `test_mcp_websocket` */
  test_mcp_websocket: {
    args: {
      url: string;
      env?: { [key: string]: string } | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/mcp.rs:671 `test_rmcp_streamable_http` */
  test_rmcp_streamable_http: {
    args: {
      url: string;
      apiKey?: string | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:478 `test_search_engine` */
  test_search_engine: {
    args: {
      engine: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:43 `test_web_search_connectivity` */
  test_web_search_connectivity: {
    args: {
      engine?: string | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/web_search.rs:397 `update_feature_flag` */
  update_feature_flag: {
    args: {
      featureName: string;
      action: string;
      value?: unknown | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
}

export interface Events {
  "browser:closed": BrowserClosedPayload;
  "browser:content-user-input": BrowserContentUserInputPayload;
  "browser:control-mode-changed": BrowserControlModeChangedPayload;
  "browser:navigated": BrowserNavigatedPayload;
  "browser:navigation-blocked": BrowserNavigationBlockedPayload;
  "browser:title-changed": BrowserTitleChangedPayload;
  "mcp-bridge-request": {
    correlationId: string;
    tool: string;
    serverId: string | null;
    args: unknown;
    timeoutMs: number;
  };
  "mcp-test-progress": {
    step: string;
  };
  "vfs-index-progress": {
    type: string;
    resourceId: string;
    blockId: string;
    chunks: number;
    embeddingDim: number;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
    current: unknown /* x-unresolved: json! value `done` type not determinable statically */;
    total: unknown /* x-unresolved: json! value `total` type not determinable statically */;
    progress: number;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
    error: string;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
  } | {
    type: string;
    resourceId: string;
    chunkCount: number;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    chunkCount: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    chunksProcessed: number;
    chunksTotal: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    current: number;
    total: number;
    chunksProcessed: number;
    chunksTotal: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    error: string;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    error: string;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    currentPage: number;
    totalPages: number;
    successCount: number;
    percent: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    success: boolean;
    successCount: number;
    failCount: number;
    totalPages: number;
    textLength: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    success: boolean;
    successCount: number;
    failCount: number;
    totalPages: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    totalPages: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    message: string;
  } | {
    type: string;
    successCount: number;
    failCount: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    total: number;
    message: string;
  };
  [name: `${string}-closed`]: Record<string, never>;
  [name: `${string}-error`]: {
    error: string;
  };
  [name: `${string}-message`]: {
    message: unknown /* x-unresolved: json! value `payload` type not determinable statically */;
  };
  [name: `${string}_web_search`]: {
    sources: unknown[];
    stage: string;
    tool_name: string;
  } | {
    sources: unknown[];
    tool_name: string;
    timestamp: string;
  } | {
    sources: unknown;
    stage: string;
    tool_name: string;
  };
}

export type CommandName = keyof Commands;
export type BrowserBackCommandArgs = Commands['browser_back']['args'];
export type BrowserBackCommandResult = Commands['browser_back']['result'];
export type BrowserClickCommandArgs = Commands['browser_click']['args'];
export type BrowserClickCommandResult = Commands['browser_click']['result'];
export type BrowserCloseCommandArgs = Commands['browser_close']['args'];
export type BrowserCloseCommandResult = Commands['browser_close']['result'];
export type BrowserContentUserInputCommandArgs = Commands['browser_content_user_input']['args'];
export type BrowserContentUserInputCommandResult = Commands['browser_content_user_input']['result'];
export type BrowserFocusCommandArgs = Commands['browser_focus']['args'];
export type BrowserFocusCommandResult = Commands['browser_focus']['result'];
export type BrowserForwardCommandArgs = Commands['browser_forward']['args'];
export type BrowserForwardCommandResult = Commands['browser_forward']['result'];
export type BrowserGetStateCommandArgs = Commands['browser_get_state']['args'];
export type BrowserGetStateCommandResult = Commands['browser_get_state']['result'];
export type BrowserGetSurfaceHostModeCommandArgs = Commands['browser_get_surface_host_mode']['args'];
export type BrowserGetSurfaceHostModeCommandResult = Commands['browser_get_surface_host_mode']['result'];
export type BrowserListDownloadsCommandArgs = Commands['browser_list_downloads']['args'];
export type BrowserListDownloadsCommandResult = Commands['browser_list_downloads']['result'];
export type BrowserListTaskDownloadsCommandArgs = Commands['browser_list_task_downloads']['args'];
export type BrowserListTaskDownloadsCommandResult = Commands['browser_list_task_downloads']['result'];
export type BrowserNavigateCommandArgs = Commands['browser_navigate']['args'];
export type BrowserNavigateCommandResult = Commands['browser_navigate']['result'];
export type BrowserOpenSessionCommandArgs = Commands['browser_open_session']['args'];
export type BrowserOpenSessionCommandResult = Commands['browser_open_session']['result'];
export type BrowserReleaseSurfaceFocusCommandArgs = Commands['browser_release_surface_focus']['args'];
export type BrowserReleaseSurfaceFocusCommandResult = Commands['browser_release_surface_focus']['result'];
export type BrowserReloadCommandArgs = Commands['browser_reload']['args'];
export type BrowserReloadCommandResult = Commands['browser_reload']['result'];
export type BrowserScrollCommandArgs = Commands['browser_scroll']['args'];
export type BrowserScrollCommandResult = Commands['browser_scroll']['result'];
export type BrowserSetInputFilesCommandArgs = Commands['browser_set_input_files']['args'];
export type BrowserSetInputFilesCommandResult = Commands['browser_set_input_files']['result'];
export type BrowserSetSurfaceBoundsCommandArgs = Commands['browser_set_surface_bounds']['args'];
export type BrowserSetSurfaceBoundsCommandResult = Commands['browser_set_surface_bounds']['result'];
export type BrowserSetSurfaceVisibilityCommandArgs = Commands['browser_set_surface_visibility']['args'];
export type BrowserSetSurfaceVisibilityCommandResult = Commands['browser_set_surface_visibility']['result'];
export type BrowserSnapshotCommandArgs = Commands['browser_snapshot']['args'];
export type BrowserSnapshotCommandResult = Commands['browser_snapshot']['result'];
export type BrowserTakeOverCommandArgs = Commands['browser_take_over']['args'];
export type BrowserTakeOverCommandResult = Commands['browser_take_over']['result'];
export type BrowserTypeCommandArgs = Commands['browser_type']['args'];
export type BrowserTypeCommandResult = Commands['browser_type']['result'];
export type CancelMcpOauthCommandArgs = Commands['cancel_mcp_oauth']['args'];
export type CancelMcpOauthCommandResult = Commands['cancel_mcp_oauth']['result'];
export type DeleteSettingCommandArgs = Commands['delete_setting']['args'];
export type DeleteSettingCommandResult = Commands['delete_setting']['result'];
export type DeleteSettingsByPrefixCommandArgs = Commands['delete_settings_by_prefix']['args'];
export type DeleteSettingsByPrefixCommandResult = Commands['delete_settings_by_prefix']['result'];
export type DetectToolConflictsCommandArgs = Commands['detect_tool_conflicts']['args'];
export type DetectToolConflictsCommandResult = Commands['detect_tool_conflicts']['result'];
export type ExportMcpConfigCommandArgs = Commands['export_mcp_config']['args'];
export type ExportMcpConfigCommandResult = Commands['export_mcp_config']['result'];
export type GetCnWhitelistConfigCommandArgs = Commands['get_cn_whitelist_config']['args'];
export type GetCnWhitelistConfigCommandResult = Commands['get_cn_whitelist_config']['result'];
export type GetFeatureFlagsCommandArgs = Commands['get_feature_flags']['args'];
export type GetFeatureFlagsCommandResult = Commands['get_feature_flags']['result'];
export type GetMcpConfigCommandArgs = Commands['get_mcp_config']['args'];
export type GetMcpConfigCommandResult = Commands['get_mcp_config']['result'];
export type GetMcpOauthAccessTokenCommandArgs = Commands['get_mcp_oauth_access_token']['args'];
export type GetMcpOauthAccessTokenCommandResult = Commands['get_mcp_oauth_access_token']['result'];
export type GetMcpOauthStatusCommandArgs = Commands['get_mcp_oauth_status']['args'];
export type GetMcpOauthStatusCommandResult = Commands['get_mcp_oauth_status']['result'];
export type GetMcpStatusCommandArgs = Commands['get_mcp_status']['args'];
export type GetMcpStatusCommandResult = Commands['get_mcp_status']['result'];
export type GetMcpStdioAllowUnapprovedCommandArgs = Commands['get_mcp_stdio_allow_unapproved']['args'];
export type GetMcpStdioAllowUnapprovedCommandResult = Commands['get_mcp_stdio_allow_unapproved']['result'];
export type GetMcpToolsCommandArgs = Commands['get_mcp_tools']['args'];
export type GetMcpToolsCommandResult = Commands['get_mcp_tools']['result'];
export type GetProviderStrategiesConfigCommandArgs = Commands['get_provider_strategies_config']['args'];
export type GetProviderStrategiesConfigCommandResult = Commands['get_provider_strategies_config']['result'];
export type GetSecurityStatusCommandArgs = Commands['get_security_status']['args'];
export type GetSecurityStatusCommandResult = Commands['get_security_status']['result'];
export type GetSettingCommandArgs = Commands['get_setting']['args'];
export type GetSettingCommandResult = Commands['get_setting']['result'];
export type GetSettingsByPrefixCommandArgs = Commands['get_settings_by_prefix']['args'];
export type GetSettingsByPrefixCommandResult = Commands['get_settings_by_prefix']['result'];
export type GetToolsNamespaceConfigCommandArgs = Commands['get_tools_namespace_config']['args'];
export type GetToolsNamespaceConfigCommandResult = Commands['get_tools_namespace_config']['result'];
export type ImportMcpConfigCommandArgs = Commands['import_mcp_config']['args'];
export type ImportMcpConfigCommandResult = Commands['import_mcp_config']['result'];
export type IsFeatureEnabledCommandArgs = Commands['is_feature_enabled']['args'];
export type IsFeatureEnabledCommandResult = Commands['is_feature_enabled']['result'];
export type McpStdioCloseCommandArgs = Commands['mcp_stdio_close']['args'];
export type McpStdioCloseCommandResult = Commands['mcp_stdio_close']['result'];
export type McpStdioSendCommandArgs = Commands['mcp_stdio_send']['args'];
export type McpStdioSendCommandResult = Commands['mcp_stdio_send']['result'];
export type McpStdioStartCommandArgs = Commands['mcp_stdio_start']['args'];
export type McpStdioStartCommandResult = Commands['mcp_stdio_start']['result'];
export type NetworkProbeCommandArgs = Commands['network_probe']['args'];
export type NetworkProbeCommandResult = Commands['network_probe']['result'];
export type PreheatMcpToolsCommandArgs = Commands['preheat_mcp_tools']['args'];
export type PreheatMcpToolsCommandResult = Commands['preheat_mcp_tools']['result'];
export type ReloadMcpClientCommandArgs = Commands['reload_mcp_client']['args'];
export type ReloadMcpClientCommandResult = Commands['reload_mcp_client']['result'];
export type RevokeMcpOauthCommandArgs = Commands['revoke_mcp_oauth']['args'];
export type RevokeMcpOauthCommandResult = Commands['revoke_mcp_oauth']['result'];
export type SaveMcpConfigCommandArgs = Commands['save_mcp_config']['args'];
export type SaveMcpConfigCommandResult = Commands['save_mcp_config']['result'];
export type SaveProviderStrategiesConfigCommandArgs = Commands['save_provider_strategies_config']['args'];
export type SaveProviderStrategiesConfigCommandResult = Commands['save_provider_strategies_config']['result'];
export type SaveSettingCommandArgs = Commands['save_setting']['args'];
export type SaveSettingCommandResult = Commands['save_setting']['result'];
export type SetMcpStdioAllowUnapprovedCommandArgs = Commands['set_mcp_stdio_allow_unapproved']['args'];
export type SetMcpStdioAllowUnapprovedCommandResult = Commands['set_mcp_stdio_allow_unapproved']['result'];
export type StartMcpOauthCommandArgs = Commands['start_mcp_oauth']['args'];
export type StartMcpOauthCommandResult = Commands['start_mcp_oauth']['result'];
export type TestAllSearchEnginesCommandArgs = Commands['test_all_search_engines']['args'];
export type TestAllSearchEnginesCommandResult = Commands['test_all_search_engines']['result'];
export type TestMcpConnectionCommandArgs = Commands['test_mcp_connection']['args'];
export type TestMcpConnectionCommandResult = Commands['test_mcp_connection']['result'];
export type TestMcpHttpCommandArgs = Commands['test_mcp_http']['args'];
export type TestMcpHttpCommandResult = Commands['test_mcp_http']['result'];
export type TestMcpSseCommandArgs = Commands['test_mcp_sse']['args'];
export type TestMcpSseCommandResult = Commands['test_mcp_sse']['result'];
export type TestMcpWebsocketCommandArgs = Commands['test_mcp_websocket']['args'];
export type TestMcpWebsocketCommandResult = Commands['test_mcp_websocket']['result'];
export type TestRmcpStreamableHttpCommandArgs = Commands['test_rmcp_streamable_http']['args'];
export type TestRmcpStreamableHttpCommandResult = Commands['test_rmcp_streamable_http']['result'];
export type TestSearchEngineCommandArgs = Commands['test_search_engine']['args'];
export type TestSearchEngineCommandResult = Commands['test_search_engine']['result'];
export type TestWebSearchConnectivityCommandArgs = Commands['test_web_search_connectivity']['args'];
export type TestWebSearchConnectivityCommandResult = Commands['test_web_search_connectivity']['result'];
export type UpdateFeatureFlagCommandArgs = Commands['update_feature_flag']['args'];
export type UpdateFeatureFlagCommandResult = Commands['update_feature_flag']['result'];

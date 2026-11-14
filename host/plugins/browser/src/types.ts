// Port of dstu-browser/src/browser/types.rs: persistence DTOs.
// Runtime-only state (control mode, loading, CDP handles) stays out of the database layer.

export interface BrowserSessionRow {
  id: string;
  profileId: string;
  title: string | null;
  currentUrl: string | null;
  faviconUrl: string | null;
  userAgentOverride: string | null;
  /** Current position in the navigation stack (`history.seq`); -1 means empty. */
  historyIndex: number;
  isActive: boolean;
  lastFocusedAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface BrowserSessionUpsert {
  id: string;
  profileId?: string | null;
  title?: string | null;
  currentUrl?: string | null;
  faviconUrl?: string | null;
  userAgentOverride?: string | null;
  historyIndex?: number | null;
  /** Defaults to true: the upserted session becomes the single active session. */
  isActive?: boolean | null;
  lastFocusedAt?: string | null;
}

export interface BrowserHistoryRow {
  id: string;
  sessionId: string | null;
  url: string;
  title: string | null;
  seq: number | null;
  visitCount: number;
  typedCount: number;
  lastVisitAt: string;
  firstVisitAt: string;
  transition: string | null;
  hidden: boolean;
}

export interface BrowserHistoryPush {
  url: string;
  title?: string | null;
  transition?: string | null;
  /** Counts the entry as an address-bar visit (increments `typed_count`). */
  typed: boolean;
}

export interface SitePermissionRow {
  id: string;
  origin: string;
  permission: string;
  decision: string;
  scope: string;
  source: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SitePermissionUpsert {
  origin: string;
  permission: string;
  decision: string;
  scope?: string | null;
  source?: string | null;
  expiresAt?: string | null;
}

export interface BrowserSettingRow {
  key: string;
  value: string;
  updatedAt: string;
}

export interface BrowserDownloadRow {
  id: string;
  sessionId: string | null;
  url: string;
  referrer: string | null;
  filename: string;
  mimeType: string | null;
  totalBytes: number | null;
  receivedBytes: number | null;
  localPath: string | null;
  state: string;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  deletedAt: string | null;
}

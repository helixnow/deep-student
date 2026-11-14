// Port of dstu-browser/src/browser/session.rs: in-memory single browser session.
// Window creation itself belongs to the native shell and is not ported here.

import { formatTimestamp } from './time.ts';

export const MAX_HISTORY = 50;
export const USER_TAKEOVER_BLOCK_SECS = 15;
export const BROWSER_CONTENT_LABEL = 'browser-content';

export type ControlMode = 'user' | 'agent';

export interface OpenSessionOptions {
  url: string;
  displayName: string | null;
  chatSessionId: string | null;
  width: number | null;
  height: number | null;
  focused: boolean | null;
  reuseExisting: boolean | null;
  fromAgent: boolean | null;
}
export function defaultOpenSessionOptions(): OpenSessionOptions {
  return {
    url: '', displayName: null, chatSessionId: null, width: null, height: null,
    focused: true, reuseExisting: true, fromAgent: false,
  };
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: Date;
}

export interface BrowserSessionState {
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
}

export class BrowserSession {
  id: string;
  label = BROWSER_CONTENT_LABEL;
  title = '';
  url: string;
  history: HistoryEntry[];
  historyIndex = 0;
  profilePath: string;
  chatSessionId: string | null;
  displayName: string | null;
  controlMode: ControlMode = 'user';
  loading = true;
  alive = true;
  userTakeoverAt: Date | null = null;
  takeoverNoticePending = false;
  createdAt: Date;
  updatedAt: Date;

  constructor(
    id: string, url: string, profilePath: string,
    chatSessionId: string | null = null, displayName: string | null = null,
    now: Date = new Date(),
  ) {
    this.id = id;
    this.url = url;
    this.history = [{ url, title: '', visitedAt: now }];
    this.profilePath = profilePath;
    this.chatSessionId = chatSessionId;
    this.displayName = displayName;
    this.createdAt = now;
    this.updatedAt = now;
  }

  /** Rust `#[derive(Clone)]`. */
  clone(): BrowserSession {
    const copy = new BrowserSession(
      this.id, this.url, this.profilePath, this.chatSessionId, this.displayName, new Date(this.createdAt),
    );
    copy.label = this.label;
    copy.title = this.title;
    copy.history = this.history.map(entry => ({
      url: entry.url, title: entry.title, visitedAt: new Date(entry.visitedAt),
    }));
    copy.historyIndex = this.historyIndex;
    copy.controlMode = this.controlMode;
    copy.loading = this.loading;
    copy.alive = this.alive;
    copy.userTakeoverAt = this.userTakeoverAt === null ? null : new Date(this.userTakeoverAt);
    copy.takeoverNoticePending = this.takeoverNoticePending;
    copy.updatedAt = new Date(this.updatedAt);
    return copy;
  }

  /** In-place replacement matching Rust `*session = other.clone()`. */
  restoreFrom(other: BrowserSession): void {
    const copy = other.clone();
    this.id = copy.id;
    this.label = copy.label;
    this.title = copy.title;
    this.url = copy.url;
    this.history = copy.history;
    this.historyIndex = copy.historyIndex;
    this.profilePath = copy.profilePath;
    this.chatSessionId = copy.chatSessionId;
    this.displayName = copy.displayName;
    this.controlMode = copy.controlMode;
    this.loading = copy.loading;
    this.alive = copy.alive;
    this.userTakeoverAt = copy.userTakeoverAt;
    this.takeoverNoticePending = copy.takeoverNoticePending;
    this.createdAt = copy.createdAt;
    this.updatedAt = copy.updatedAt;
  }

  canGoBack(): boolean {
    return this.historyIndex > 0;
  }
  canGoForward(): boolean {
    return this.historyIndex + 1 < this.history.length;
  }

  snapshot(): BrowserSessionState {
    return {
      id: this.id,
      label: this.label,
      title: this.title,
      url: this.url,
      canGoBack: this.canGoBack(),
      canGoForward: this.canGoForward(),
      loading: this.loading,
      alive: this.alive,
      controlMode: this.controlMode,
      historyIndex: this.historyIndex,
      historyLen: this.history.length,
      chatSessionId: this.chatSessionId,
      profilePath: this.profilePath,
      createdAt: formatTimestamp(this.createdAt),
      updatedAt: formatTimestamp(this.updatedAt),
    };
  }

  /** Push a new URL, truncating the forward stack. */
  pushUrl(url: string, title: string | null = null, now: Date = new Date()): void {
    if (this.historyIndex + 1 < this.history.length) {
      this.history.length = this.historyIndex + 1;
    }
    this.history.push({ url, title: title ?? '', visitedAt: now });
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    this.historyIndex = Math.max(this.history.length - 1, 0);
    this.url = url;
    this.loading = true;
    this.updatedAt = now;
  }

  /** Replace the current entry (reuse open / replace navigate). */
  replaceUrl(url: string, title: string | null = null, now: Date = new Date()): void {
    const entry = this.history[this.historyIndex];
    if (entry !== undefined) {
      entry.url = url;
      if (title !== null) entry.title = title;
      entry.visitedAt = now;
    } else {
      this.history.push({ url, title: title ?? '', visitedAt: now });
      this.historyIndex = 0;
    }
    this.url = url;
    this.loading = true;
    this.updatedAt = now;
  }

  goBack(now: Date = new Date()): string | null {
    if (!this.canGoBack()) return null;
    this.historyIndex -= 1;
    const entry = this.history[this.historyIndex]!;
    this.url = entry.url;
    this.title = entry.title;
    this.loading = true;
    this.updatedAt = now;
    return entry.url;
  }

  goForward(now: Date = new Date()): string | null {
    if (!this.canGoForward()) return null;
    this.historyIndex += 1;
    const entry = this.history[this.historyIndex]!;
    this.url = entry.url;
    this.title = entry.title;
    this.loading = true;
    this.updatedAt = now;
    return entry.url;
  }

  setTitle(title: string, now: Date = new Date()): void {
    this.title = title;
    const entry = this.history[this.historyIndex];
    if (entry !== undefined) entry.title = title;
    this.updatedAt = now;
  }

  markLoaded(url: string | null = null, now: Date = new Date()): void {
    if (url !== null) {
      this.url = url;
      const entry = this.history[this.historyIndex];
      if (entry !== undefined) entry.url = url;
    }
    this.loading = false;
    this.updatedAt = now;
  }

  markClosed(now: Date = new Date()): void {
    this.alive = false;
    this.loading = false;
    this.updatedAt = now;
  }

  setControlMode(mode: ControlMode, now: Date = new Date()): void {
    this.controlMode = mode;
    // Agent regaining control clears the takeover cooldown marker.
    if (mode === 'agent') this.userTakeoverAt = null;
    this.updatedAt = now;
  }

  /** User takeover: force User control and record the block timestamp. */
  takeOver(now: Date = new Date()): void {
    this.controlMode = 'user';
    this.userTakeoverAt = now;
    this.takeoverNoticePending = true;
    this.updatedAt = now;
  }

  /** ACR 4.0 (A7): consume the "first claim after user takeover" notice latch. */
  consumeTakeoverNotice(): boolean {
    const pending = this.takeoverNoticePending;
    this.takeoverNoticePending = false;
    return pending;
  }

  /** Whether the user-takeover cooldown still blocks agent operations. */
  isBlockedByUserTakeover(now: Date = new Date()): boolean {
    if (this.userTakeoverAt === null) return false;
    const elapsedSeconds = Math.floor((now.getTime() - this.userTakeoverAt.getTime()) / 1000);
    if (elapsedSeconds < USER_TAKEOVER_BLOCK_SECS) return true;
    this.userTakeoverAt = null;
    return false;
  }
}

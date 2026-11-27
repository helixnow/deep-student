/**
 * Host-verified browser session facts tracker.
 * Records trusted host-side observations (visited origins, blocked navigations,
 * latest screenshot metadata, user takeovers, action counts) independently of
 * untrusted page/model claims.
 *
 * 100% Web-API portable (no Node builtins or globals).
 */

const MAX_BLOCKED_NAVIGATIONS = 50;

export type BrowserFactsMode = 'interactive' | 'headless' | 'remote';

export interface BrowserBlockedNavigationFact {
  url: string;
  reason: string;
  at: string;
}

export interface BrowserLatestScreenshotFact {
  path: string | null;
  locator: string | null;
  width: number;
  height: number;
  capturedAt: string;
}

export interface BrowserHostFacts {
  sessionId: string;
  mode: BrowserFactsMode;
  visitedOrigins: string[];
  blockedNavigations: Array<{ url: string; reason: string; at: string }>;
  latestScreenshot: {
    path: string | null;
    locator: string | null;
    width: number;
    height: number;
    capturedAt: string;
  } | null;
  downloadsCount: number;
  userTakeoverCount: number;
  actionCount: number;
  finalUrl: string | null;
}

function extractOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.origin || parsed.origin === 'null') return null;
    return parsed.origin;
  } catch {
    // boundary-allow empty-catch: malformed URLs simply do not contribute an origin
    return null;
  }
}

export class BrowserHostFactsTracker {
  private readonly now: () => Date;
  private readonly visitedOriginSet = new Set<string>();
  private readonly visitedOrigins: string[] = [];
  private readonly blockedNavigations: BrowserBlockedNavigationFact[] = [];
  private latestScreenshot: BrowserLatestScreenshotFact | null = null;
  private userTakeoverCount = 0;
  private actionCount = 0;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  recordNavigation(url: string): void {
    const origin = extractOrigin(url);
    if (origin === null || this.visitedOriginSet.has(origin)) return;
    this.visitedOriginSet.add(origin);
    this.visitedOrigins.push(origin);
  }

  recordBlocked(url: string, reason: string, at?: string): void {
    if (this.blockedNavigations.length >= MAX_BLOCKED_NAVIGATIONS) {
      this.blockedNavigations.shift();
    }
    this.blockedNavigations.push({
      url,
      reason,
      at: at ?? this.now().toISOString(),
    });
  }

  recordScreenshot(info: BrowserLatestScreenshotFact): void {
    this.latestScreenshot = {
      path: info.path,
      locator: info.locator,
      width: info.width,
      height: info.height,
      capturedAt: info.capturedAt,
    };
  }

  recordTakeover(): void {
    this.userTakeoverCount += 1;
  }

  recordAction(): void {
    this.actionCount += 1;
  }

  reset(): void {
    this.visitedOriginSet.clear();
    this.visitedOrigins.length = 0;
    this.blockedNavigations.length = 0;
    this.latestScreenshot = null;
    this.userTakeoverCount = 0;
    this.actionCount = 0;
  }

  snapshot(
    sessionId: string,
    mode: BrowserFactsMode,
    downloadsCount: number,
    finalUrl: string | null,
  ): BrowserHostFacts {
    return {
      sessionId,
      mode,
      visitedOrigins: [...this.visitedOrigins],
      blockedNavigations: this.blockedNavigations.map(entry => ({ ...entry })),
      latestScreenshot: this.latestScreenshot === null ? null : { ...this.latestScreenshot },
      downloadsCount,
      userTakeoverCount: this.userTakeoverCount,
      actionCount: this.actionCount,
      finalUrl,
    };
  }
}

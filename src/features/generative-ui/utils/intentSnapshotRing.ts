/**
 * Generative UI intent snapshot ring — last-N history for debug / Style Lab compare.
 * Clones intent on push so later mutation of the source does not change the snapshot.
 */

import type { GenerativeUIIntent } from '../types';
import { fingerprintGenerativeUIIntent } from './fingerprintGenerativeUIIntent';

export const GENERATIVE_UI_INTENT_SNAPSHOT_LIMIT = 20;

export interface GenerativeUIIntentSnapshot {
  fingerprint: string;
  intent: GenerativeUIIntent;
  recordedAt: number;
}

function cloneIntent(intent: GenerativeUIIntent): GenerativeUIIntent {
  return JSON.parse(JSON.stringify(intent)) as GenerativeUIIntent;
}

export class GenerativeUIIntentSnapshotRing {
  private readonly snapshots: GenerativeUIIntentSnapshot[] = [];
  private readonly limit: number;

  constructor(limit?: number) {
    this.limit = limit ?? GENERATIVE_UI_INTENT_SNAPSHOT_LIMIT;
  }

  get size(): number {
    return this.snapshots.length;
  }

  push(intent: GenerativeUIIntent, fingerprint?: string): GenerativeUIIntentSnapshot {
    const snapshot: GenerativeUIIntentSnapshot = {
      fingerprint: fingerprint ?? fingerprintGenerativeUIIntent(intent),
      intent: cloneIntent(intent),
      recordedAt: Date.now(),
    };
    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.limit) {
      this.snapshots.shift();
    }
    return snapshot;
  }

  /** Oldest → newest. Shallow copy — mutating the return must not change the store. */
  list(): GenerativeUIIntentSnapshot[] {
    return this.snapshots.slice();
  }

  latest(): GenerativeUIIntentSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  clear(): void {
    this.snapshots.length = 0;
  }
}

let defaultRing: GenerativeUIIntentSnapshotRing | null = null;

export function getDefaultGenerativeUIIntentSnapshotRing(): GenerativeUIIntentSnapshotRing {
  if (!defaultRing) {
    defaultRing = new GenerativeUIIntentSnapshotRing();
  }
  return defaultRing;
}

export function resetDefaultGenerativeUIIntentSnapshotRing(): void {
  defaultRing = new GenerativeUIIntentSnapshotRing();
}

export function pushDefaultGenerativeUIIntentSnapshot(
  intent: GenerativeUIIntent,
): GenerativeUIIntentSnapshot {
  return getDefaultGenerativeUIIntentSnapshotRing().push(intent);
}

/**
 * Daily-log → learner-profile promotion pass — TS port of `MemoryEvolution::run_promotion_throttled`
 * and `run_promotion_pass` (`dstu-memory/src/memory/evolution.rs:956-1087`).
 */
import type { MemoryDecisionCompletion } from '../api.ts';
import type { EvolutionLogger } from './evolution-cycle.ts';
import {
  buildPromotionPrompt, parsePromotionResponse, promotionFingerprint, PROMOTION_LAST_FINGERPRINT_KEY,
  PROMOTION_SCAN_DAYS, type DailyLogRecord,
} from './evolution.ts';
import {
  emptyProfile, emptyProfileUpdate, isProfileUpdateEmpty, type LearnerProfile, type LearnerProfileUpdate,
} from './learner-profile.ts';
import { errorText } from './memory-utils.ts';
import type { LearnerProfileApplyOutcome, ProfileUpdateOptions } from './profile-store.ts';

export interface PromotionReport {
  logs_scanned: number;
  applied: boolean;
  new_version: number | null;
}

export interface PromotionPassHost {
  listRecentDailyLogs(days: number): DailyLogRecord[];
  getConfig(key: string): string | null;
  setConfig(key: string, value: string): void;
  loadProfile(): LearnerProfile | null;
  applyProfilePromotionUpdate(update: LearnerProfileUpdate, fingerprint: string,
    options: ProfileUpdateOptions): LearnerProfileApplyOutcome;
  /** Throws when no memory-decision model is available; Rust fails the same way at call time. */
  completion(): MemoryDecisionCompletion;
  log: EvolutionLogger;
  nowMs(): number;
}

/** Rust keeps `LAST_PROMOTION_MS` separate from the evolution-cycle timer. */
export class PromotionThrottle {
  lastPromotionMs = 0;
}

/** Rust `run_promotion_throttled`: a failed pass rolls the timer back so the next write retries. */
export async function runPromotionThrottled(host: PromotionPassHost, intervalMs: number,
  throttle: PromotionThrottle): Promise<PromotionReport | null> {
  const nowMs = host.nowMs();
  const last = throttle.lastPromotionMs;
  if (nowMs - last < intervalMs) return null;
  throttle.lastPromotionMs = nowMs;

  try {
    const report = await runPromotionPass(host);
    if (report.applied) {
      host.log.info(`[Evolution] Promotion pass applied: logs=${report.logs_scanned}, `
        + `new_version=${report.new_version === null ? 'None' : `Some(${report.new_version})`}`);
    }
    return report;
  } catch (error) {
    throttle.lastPromotionMs = last;
    host.log.warn(`[Evolution] Promotion pass failed (non-fatal): ${errorText(error)}`);
    return null;
  }
}

function promotionOptions(reason: string): ProfileUpdateOptions {
  return { source: 'evolution', sessionId: null, reason, limitPolicy: 'enforce', isCancelled: () => false };
}

/** Rust `run_promotion_pass`. */
export async function runPromotionPass(host: PromotionPassHost): Promise<PromotionReport> {
  const report: PromotionReport = { logs_scanned: 0, applied: false, new_version: null };
  const logs = host.listRecentDailyLogs(PROMOTION_SCAN_DAYS);
  report.logs_scanned = logs.length;
  if (logs.length === 0) {
    host.log.debug('[Evolution] Promotion: no recent daily logs; skip');
    return report;
  }

  const fingerprint = promotionFingerprint(logs);
  const cachedFingerprint = host.getConfig(PROMOTION_LAST_FINGERPRINT_KEY);
  const currentProfile = host.loadProfile() ?? emptyProfile();
  if (currentProfile.last_promotion_fingerprint === fingerprint || cachedFingerprint === fingerprint) {
    // The profile marker commits with the profile CAS; replaying it upgrades a config-only marker
    // and repairs history interrupted after the profile commit.
    host.applyProfilePromotionUpdate(emptyProfileUpdate(), fingerprint, promotionOptions('日志→画像晋升指纹恢复'));
    if (cachedFingerprint !== fingerprint) {
      try { host.setConfig(PROMOTION_LAST_FINGERPRINT_KEY, fingerprint); }
      catch (error) { host.log.warn(`[Evolution] Failed to repair promotion fingerprint cache: ${errorText(error)}`); }
    }
    host.log.debug('[Evolution] Promotion: logs unchanged since last pass; skip');
    return report;
  }

  const prompt = buildPromotionPrompt(logs, currentProfile);
  let assistantMessage: string;
  try {
    assistantMessage = (await host.completion().callMemoryDecisionRawPrompt(prompt)).assistant_message;
  } catch (error) {
    throw new Error(`Promotion LLM call failed: ${errorText(error)}`, { cause: error });
  }
  const update = parsePromotionResponse(assistantMessage);
  if (isProfileUpdateEmpty(update)) host.log.debug('[Evolution] Promotion: LLM proposed no profile update');

  // Merged into the latest profile (CAS replay), not the snapshot used for the prompt.
  const outcome = host.applyProfilePromotionUpdate(update, fingerprint,
    promotionOptions(`日志→画像晋升：扫描近 ${PROMOTION_SCAN_DAYS} 天共 ${report.logs_scanned} 条日志`));
  // Persisted only after the profile commit so a failed write leaves the logs eligible for retry.
  try { host.setConfig(PROMOTION_LAST_FINGERPRINT_KEY, fingerprint); }
  catch (error) { host.log.warn(`[Evolution] Failed to persist promotion fingerprint: ${errorText(error)}`); }

  report.applied = outcome.changed;
  report.new_version = outcome.changed ? outcome.profile.version : null;
  return report;
}

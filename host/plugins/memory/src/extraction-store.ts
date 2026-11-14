/**
 * Model-driven extraction — TS mirror of `compaction_flush.rs` and `auto_extractor.rs`.
 * The service keeps the public facade; this store owns the prompt → parse → store pipelines.
 */
import type {
  ExtractionResult, FlushApplyOptions, FlushApplyResult, FlushExtraction, FlushFactOutcome,
  FlushReport, MemoryDecisionCompletion, MemoryPurpose, MemoryType, SmartWriteOutput,
} from '../api.ts';
import type { AuditEntryInput } from '../repository/audit.ts';
import { flushFactReceiptKey } from '../repository/idempotency.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import {
  buildFlushPrompt, flushExtractionIsEmpty, flushSegmentTooShort, parseFlushResponse,
  truncateFlushSegment,
} from './compaction-flush.ts';
import {
  buildExtractionPrompt, parseExtractionResponseFull, shouldSkipExtraction,
  truncateExtractionInput,
} from './auto-extractor.ts';
import type { DailyLogAppendOutcome } from './daily-log-store.ts';
import { localDate } from './daily-log.ts';
import { errorText } from './memory-utils.ts';

export interface ExtractionStoreHost {
  memoryDecisionCompletion(): MemoryDecisionCompletion;
  writeSmart(folderPath: string | null | undefined, title: string, content: string,
    memoryType: MemoryType, purpose: MemoryPurpose | null, idempotencyKey: string | null | undefined,
    source?: 'handler' | 'tool_call' | 'auto_extract', sessionId?: string | null): Promise<SmartWriteOutput>;
  appendDailyLog(date: string, entry: string): DailyLogAppendOutcome;
  getProfileSummary(): string | null;
  refreshProfileSummary(): void;
  audit(entry: Partial<AuditEntryInput> & Pick<AuditEntryInput, 'operation' | 'success'>): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export class MemoryExtractionStore {
  private readonly host: ExtractionStoreHost;
  constructor(host: ExtractionStoreHost) { this.host = host; }

  /** Rust `CompactionMemoryFlush::extract` (`compaction_flush.rs:95`). */
  async extractCompactionSegment(segmentText: string,
    signal?: AbortSignal | null): Promise<FlushExtraction> {
    const trimmed = rustTrim(segmentText);
    if (flushSegmentTooShort(trimmed)) return { facts: [], activities: [] };
    const prompt = buildFlushPrompt(truncateFlushSegment(trimmed));
    try {
      const output = await this.host.memoryDecisionCompletion()
        .callMemoryDecisionRawPrompt(prompt, signal ?? undefined);
      return parseFlushResponse(output.assistant_message);
    } catch (error) {
      throw new Error(`Memory flush LLM call failed: ${errorText(error)}`);
    }
  }

  /**
   * Rust `process_claimed_memory_flush` persistence half (`memory_flush.rs:780-870`):
   * each fact commits the note and its `compaction_flush:<segment>:fact:<i>`
   * receipt in one transaction; activities use the daily-log CAS/dedupe loop.
   */
  async applyFlushExtraction(extraction: FlushExtraction,
    options: FlushApplyOptions): Promise<FlushApplyResult> {
    const factsCompleted = options.factsCompleted ?? 0;
    const activitiesCompleted = options.activitiesCompleted ?? 0;
    if (!Number.isInteger(factsCompleted) || factsCompleted < 0
      || factsCompleted > extraction.facts.length
      || !Number.isInteger(activitiesCompleted) || activitiesCompleted < 0
      || activitiesCompleted > extraction.activities.length) {
      throw new Error('memory flush ledger progress exceeds extraction length');
    }

    const report: FlushReport = {
      facts_extracted: extraction.facts.length, facts_stored: 0,
      activities_extracted: extraction.activities.length, activities_stored: 0,
    };
    const facts: FlushFactOutcome[] = [];
    const activities: Array<{ index: number; noteId: string; appended: boolean; reason: string }> = [];
    let factsDone = factsCompleted;
    let activitiesDone = activitiesCompleted;

    for (let index = factsCompleted; index < extraction.facts.length; index += 1) {
      const fact = extraction.facts[index]!;
      const key = options.segmentId === null || options.segmentId === ''
        ? null : flushFactReceiptKey(options.segmentId, index);
      const output = await this.host.writeSmart(fact.folder, fact.title, fact.content,
        'fact', null, key, 'auto_extract', options.sessionId);
      const stored = output.event === 'ADD' || output.event === 'UPDATE'
        || output.event === 'APPEND';
      if (stored) report.facts_stored += 1;
      facts.push({ index, idempotencyKey: key, output, stored });
      factsDone = index + 1;
      options.onProgress?.(factsDone, activitiesDone);
    }

    for (let index = activitiesCompleted; index < extraction.activities.length; index += 1) {
      const activity = extraction.activities[index]!;
      const outcome = this.host.appendDailyLog(localDate(), activity);
      if (outcome.appended) report.activities_stored += 1;
      activities.push({ index, noteId: outcome.noteId, appended: outcome.appended,
        reason: outcome.reason });
      activitiesDone = index + 1;
      options.onProgress?.(factsDone, activitiesDone);
    }

    return {
      report, factsCompleted: factsDone, activitiesCompleted: activitiesDone,
      facts, activities,
    };
  }

  /**
   * Rust `CompactionMemoryFlush::store_extraction` (`compaction_flush.rs:115-167`):
   * the best-effort path used by ordinary compaction. A failed fact or activity is
   * logged and skipped; the remaining items still run. Ledger-driven workers use
   * `applyFlushExtraction` instead so their progress/retry semantics stay separate.
   */
  private async storeFlushExtraction(extraction: FlushExtraction, sessionId: string | null): Promise<FlushReport> {
    const report: FlushReport = {
      facts_extracted: extraction.facts.length, facts_stored: 0,
      activities_extracted: extraction.activities.length, activities_stored: 0,
    };
    for (const fact of extraction.facts) {
      try {
        const output = await this.host.writeSmart(fact.folder, fact.title, fact.content,
          'fact', null, null, 'auto_extract', sessionId);
        if (output.event === 'ADD' || output.event === 'UPDATE' || output.event === 'APPEND') {
          report.facts_stored += 1;
        } else {
          this.host.debug(`[MemoryFlush] Fact skipped (event=${output.event}): '${fact.title}'`);
        }
      } catch (error) {
        this.host.warn(`[MemoryFlush] Failed to store fact '${fact.title}': ${errorText(error)}`);
      }
    }
    for (const activity of extraction.activities) {
      try {
        if (this.host.appendDailyLog(localDate(), activity).appended) report.activities_stored += 1;
      } catch (error) {
        this.host.warn(`[DailyLog] Failed to append entry: ${errorText(error)}`);
      }
    }
    if (report.facts_stored > 0 || report.activities_stored > 0) {
      this.host.info(`[MemoryFlush] Flushed before compaction: facts ${report.facts_stored}`
        + `/${report.facts_extracted}, activities ${report.activities_stored}`
        + `/${report.activities_extracted}`);
    }
    return report;
  }

  /** Rust `CompactionMemoryFlush::flush_segment` (`compaction_flush.rs:78`). */
  async flushSegment(segmentText: string, sessionId: string | null,
    signal?: AbortSignal | null): Promise<FlushReport> {
    const extraction = await this.extractCompactionSegment(segmentText, signal);
    if (flushExtractionIsEmpty(extraction)) {
      return {
        facts_extracted: 0, facts_stored: 0,
        activities_extracted: 0, activities_stored: 0,
      };
    }
    return this.storeFlushExtraction(extraction, sessionId);
  }

  /** Rust `MemoryAutoExtractor::extract_candidates_and_activities` (`auto_extractor.rs:62`). */
  async extractMemoryCandidates(userContent: string, assistantContent: string,
    existingProfile: string | null, signal?: AbortSignal | null): Promise<ExtractionResult> {
    if (shouldSkipExtraction(userContent, assistantContent)) {
      return { candidates: [], activities: [] };
    }
    const prompt = buildExtractionPrompt(
      truncateExtractionInput(userContent), truncateExtractionInput(assistantContent),
      existingProfile);
    let output: { assistant_message: string };
    try {
      output = await this.host.memoryDecisionCompletion()
        .callMemoryDecisionRawPrompt(prompt, signal ?? undefined);
    } catch (error) {
      throw new Error(`LLM extraction call failed: ${errorText(error)}`);
    }
    const result = parseExtractionResponseFull(output.assistant_message);
    this.host.debug(`[MemoryAutoExtractor] Extracted ${result.candidates.length} candidate memories, `
      + `${result.activities.length} activities from conversation`);
    return result;
  }

  /** Rust `MemoryAutoExtractor::extract_and_store` (`auto_extractor.rs:100`). */
  async extractAndStoreMemory(userContent: string, assistantContent: string,
    signal?: AbortSignal | null): Promise<number> {
    // Rust `OpTimer` wraps `Instant` (audit_log.rs:270-284): monotonic, truncated to ms.
    const startedAt = performance.now();
    let existingProfile: string | null;
    try {
      existingProfile = this.host.getProfileSummary();
    } catch {
      // Rust `get_profile_summary().ok().flatten()` (auto_extractor.rs:108) drops the error
      // without logging and extracts with no profile context.
      existingProfile = null;
    }
    const { candidates, activities } = await this.extractMemoryCandidates(
      userContent, assistantContent, existingProfile, signal);

    if (activities.length > 0) {
      let appended = 0;
      for (const activity of activities) {
        try {
          if (this.host.appendDailyLog(localDate(), activity).appended) appended += 1;
        } catch (error) {
          this.host.warn(`[DailyLog] Failed to append entry: ${errorText(error)}`);
        }
      }
      if (appended > 0) {
        this.host.info(`[MemoryAutoExtractor] Appended ${appended}/${activities.length} `
          + 'activities to daily log');
      }
    }

    if (candidates.length === 0) {
      this.host.debug('[MemoryAutoExtractor] No candidate memories extracted, skipping');
      return 0;
    }

    const seen = new Set<string>();
    let stored = 0;
    for (const candidate of candidates) {
      const dedupeKey = [
        (candidate.folder ?? '').trim().toLowerCase(),
        candidate.title.trim().toLowerCase(),
        candidate.content.trim().toLowerCase(),
      ].join('|');
      if (!seen.has(dedupeKey)) seen.add(dedupeKey);
      else {
        this.host.debug(`[MemoryAutoExtractor] Skip duplicated candidate in same batch: '${candidate.title}'`);
        continue;
      }
      try {
        const output = await this.host.writeSmart(candidate.folder, candidate.title, candidate.content,
          'fact', null, null, 'auto_extract');
        if (output.event === 'ADD' || output.event === 'UPDATE' || output.event === 'APPEND'
          || output.event === 'DELETE') {
          stored += 1;
          this.host.info(`[MemoryAutoExtractor] Auto-stored memory: event=${output.event}, `
            + `note_id=${output.noteId}, title='${candidate.title}'`);
        } else {
          this.host.debug(`[MemoryAutoExtractor] Skipped (event=${output.event}): `
            + `'${candidate.title}' — ${output.reason}`);
        }
      } catch (error) {
        this.host.warn(`[MemoryAutoExtractor] Failed to store '${candidate.title}': ${errorText(error)}`);
      }
    }

    this.host.audit({
      source: 'auto_extract', operation: 'extract', success: true,
      reason: `提取 ${candidates.length} 条候选，写入 ${stored} 条`,
      durationMs: Math.trunc(performance.now() - startedAt),
      extraJson: JSON.stringify({ candidates: candidates.length, stored }),
    });
    if (stored > 0) {
      try { this.host.refreshProfileSummary(); }
      catch (error) {
        this.host.warn(`[MemoryAutoExtractor] Profile refresh after batch store failed: ${errorText(error)}`);
      }
    }
    this.host.info(`[MemoryAutoExtractor] Pipeline complete: ${stored}/${candidates.length} `
      + 'candidates stored');
    return stored;
  }
}

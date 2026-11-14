import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import {
  addLocalDays, collectLearningActivities, localDateString, pomodoroDailyStats,
} from '../repository/learning.ts';
import { addStudyTimeSeconds } from '../../review/api.ts';
import {
  insertAnswerSubmission, insertChatMessage, insertChatSession, insertExamSheet,
  insertPomodoroRecord, insertQuestion,
} from './fixtures/learning-rows.ts';
import { aggregatePomodoro } from '../src/learning-overview.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('learning overview database aggregation', () => {
  it('learning_activity_and_pomodoro_aggregate_real_migrated_rows', async () => {
    current = await setupMemoryHost();
    const { storage, db } = current;
    const chatDb = storage.database('chat_v2');

    const sessionId = 'sess_learning_repo';
    insertChatSession(chatDb, sessionId);
    insertChatMessage(chatDb, 'msg_learning_repo', sessionId);
    const activityDate = new Date().toISOString().slice(0, 10);
    const relatedRecordTime = `${addLocalDays(activityDate, -1)}T12:00:00Z`;

    insertExamSheet(db, 'exam_learning_repo', relatedRecordTime);
    insertQuestion(db, 'question_learning_repo', 'exam_learning_repo', relatedRecordTime);
    insertAnswerSubmission(db, 'submission_learning_repo', 'question_learning_repo',
      `${activityDate}T12:00:00Z`);
    // L15 owns study_time_daily; seed through its published writer (Rust study_time::add_seconds).
    addStudyTimeSeconds(db, activityDate, 125, 0);

    const { activities, sourceErrors } = collectLearningActivities(
      activityDate, activityDate, chatDb, db, null);
    expect(sourceErrors).toHaveLength(1);
    expect(sourceErrors[0]!.source).toBe('learning_activity.anki');
    expect(activities).toHaveLength(1);
    expect(activities[0]!.details.chatSessions).toBe(1);
    expect(activities[0]!.details.chatMessages).toBe(1);
    expect(activities[0]!.details.questionsAnswered).toBe(1);
    expect(activities[0]!.count).toBe(3);
    // Study time is tracked separately and never folded into activity count.
    expect(activities[0]!.studySeconds).toBe(125);

    const now = new Date();
    insertPomodoroRecord(db, {
      id: 'pomodoro_completed',
      startTime: new Date(now.getTime() - 25 * 60_000).toISOString(),
      endTime: now.toISOString(),
      duration: 1500,
      actualDuration: 1420,
      type: 'work',
      status: 'completed',
      createdAt: now.toISOString(),
    });
    insertPomodoroRecord(db, {
      id: 'pomodoro_interrupted',
      startTime: now.toISOString(),
      endTime: null,
      duration: 1500,
      actualDuration: 90,
      type: 'work',
      status: 'interrupted',
      createdAt: now.toISOString(),
    });

    const daily = pomodoroDailyStats(db, 1, now);
    const focus = aggregatePomodoro(daily);
    expect(focus.completedCount).toBe(1);
    expect(focus.interruptedCount).toBe(1);
    expect(focus.focusSeconds).toBe(1510);
  });

  it('learning_activity_sql_failures_are_reported_as_partial_sources', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'learning-unmigrated-'));
    const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      const chatDb = storage.openFile(path.join(dir, 'chat_v2_unmigrated.db'),
        { profile: 'plain' });
      const today = localDateString(new Date());
      const { activities, sourceErrors } = collectLearningActivities(
        today, today, chatDb, null, null);

      expect(activities).toHaveLength(1);
      for (const source of ['learning_activity.chat_sessions',
        'learning_activity.vfs', 'learning_activity.anki']) {
        expect(sourceErrors.some(error => error.source === source)).toBe(true);
      }
      expect(sourceErrors.every(error => error.code === 'SOURCE_UNAVAILABLE')).toBe(true);
    } finally {
      storage.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as api from '../api.ts';
import * as mediaSource from '../src/media-source.ts';
import * as reviewPlan from '../src/review-plan.ts';
import * as studyTime from '../repository/study-time.ts';
import { storageFixture } from './storage.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REVIEW = 'host/plugins/review';

/** Value names other plugins import from `review/api.ts` (type-only imports and `type` specifiers excluded). */
function crossPluginValueImports(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && rel !== REVIEW) walk(rel);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
          if (match[1] !== undefined) continue;
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[3]!));
          if (target !== `${REVIEW}/api.ts`) continue;
          for (const raw of match[2]!.split(',')) {
            const spec = raw.trim();
            if (spec === '' || spec.startsWith('type ')) continue;
            const name = spec.split(/\s+as\s+/)[0]!.trim();
            found.set(name, [...(found.get(name) ?? []), rel]);
          }
        }
      }
    }
  };
  walk('host/plugins');
  return found;
}

const fixtures: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });

describe('review api.ts exports', () => {
  it('every value another plugin imports from review/api.ts is published', () => {
    const imports = crossPluginValueImports();
    expect(imports.size).toBeGreaterThan(0);
    const missing = [...imports].filter(([name]) => (api as Record<string, unknown>)[name] === undefined)
      .map(([name, files]) => `${name} <- ${files.join(', ')}`);
    expect(missing).toEqual([]);
  });

  it('media-source helpers are re-exported with the same identity, mediaFileName included (W22 chatanki injection)', () => {
    for (const name of [
      'prepareMediaTextForGeneration', 'containsMediaAnchor', 'mediaCitationSecondsFor', 'mediaFileName',
      'MEDIA_QUESTION_REQUIREMENTS', 'MEDIA_CARD_REQUIREMENTS',
    ] as const) {
      expect(api[name], name).toBe(mediaSource[name]);
    }
    expect(api.addStudyTimeSeconds).toBe(studyTime.addSeconds);
    expect(api.calculateNextReview).toBe(reviewPlan.calculateNextReview);
  });

  it('api.mediaFileName returns the file name only for audio/video files', () => {
    const f = storageFixture(); fixtures.push(f);
    f.db.exec(`CREATE TABLE files (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'document', mime_type TEXT, file_name TEXT NOT NULL);
      INSERT INTO files VALUES ('file_a', 'audio', NULL, '第1讲.mp3');
      INSERT INTO files VALUES ('file_v', 'document', 'Video/MP4', '第2讲.mp4');
      INSERT INTO files VALUES ('file_d', 'document', 'application/pdf', '讲义.pdf');`);
    expect(api.mediaFileName(f.db, 'file_a')).toBe('第1讲.mp3');
    expect(api.mediaFileName(f.db, 'file_v')).toBe('第2讲.mp4');
    expect(api.mediaFileName(f.db, 'file_d')).toBeNull();
    expect(api.mediaFileName(f.db, 'file_missing')).toBeNull();
  });
});

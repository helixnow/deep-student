/**
 * 制卡表面接线契约（源码契约）：
 *
 * 0824 回归清单第 1 条——划词 / 笔记 / 作文批改都必须落在同一条 CardForge
 * 管线上（cardAgent.startGeneration → 后端 start_enhanced_document_processing），
 * 不允许任何表面复活已退役的 ChatV2AnkiAdapter 阻塞式链路。
 *
 * 行为层已有单测覆盖：
 * - 划词  src/features/chat/services/__tests__/selectionCardGeneration.test.ts
 * - 共享入口 src/features/anki/__tests__/generateCardsFromText.test.ts
 * - 笔记  src/features/notes/__tests__/generateCardsFromNote.test.ts
 * 本文件补齐两块只能在源码层钉住的缺口：
 * 1. 作文批改（EssayGradingWorkbench）确实走共享入口，而非平行新链路；
 * 2. src/ 下不存在 ChatV2AnkiAdapter 模块文件（防止改名/复制回潜）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('all card-generation surfaces share the CardForge pipeline', () => {
  it('selection (chat) starts the backend pipeline via cardAgent.startGeneration', () => {
    const source = read('src/features/chat/services/selectionCardGeneration.ts');
    expect(source).toContain('cardAgent.startGeneration(');
    expect(source).not.toMatch(/import[^;]*ChatV2AnkiAdapter/);
  });

  it('shared text entry (notes / review-questions / essay) uses cardAgent.startGeneration', () => {
    const source = read('src/features/anki/generateCardsFromText.ts');
    expect(source).toContain('cardAgent.startGeneration(');
    expect(source).not.toMatch(/import[^;]*ChatV2AnkiAdapter/);
  });

  it('notes route through the shared entry rather than a parallel pipeline', () => {
    const source = read('src/features/notes/generateCardsFromNote.ts');
    expect(source).toContain("from '@/features/anki/generateCardsFromText'");
  });

  it('essay grading routes make-cards through the shared entry', () => {
    const source = read('src/components/EssayGradingWorkbench.tsx');
    expect(source).toContain("import('@/features/anki/generateCardsFromText')");
    expect(source).not.toContain('ChatV2AnkiAdapter');
  });
});

describe('ChatV2AnkiAdapter stays retired', () => {
  it('no module file named ChatV2AnkiAdapter exists anywhere under src/', () => {
    const root = resolve(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(join(dir, entry.name));
        } else if (entry.name.includes('ChatV2AnkiAdapter')) {
          offenders.push(join(dir, entry.name));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('card-generation surfaces never import a ChatV2AnkiAdapter module', () => {
    const surfaces = [
      'src/features/chat/services/selectionCardGeneration.ts',
      'src/features/anki/generateCardsFromText.ts',
      'src/features/notes/generateCardsFromNote.ts',
      'src/components/EssayGradingWorkbench.tsx',
      'src/components/ReviewQuestionsView.tsx',
      'src/components/anki/cardforge/index.ts',
    ];
    for (const surface of surfaces) {
      const source = read(surface);
      expect(source, surface).not.toMatch(/(?:from ['"]|import\(['"])[^'"]*ChatV2AnkiAdapter/);
    }
  });
});

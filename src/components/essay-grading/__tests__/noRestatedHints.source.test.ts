/**
 * 去冗余守卫（2026-10）：只复述标题 / 标签名的常驻说明不再出现。
 * - 作文「润色提升」「参考范文」标签页的首行说明 + 装饰图标
 * - 音视频「问答」页底部再说一遍「时间引用可点击」（顶部 intro 已说）
 * - 闪卡复习完成页「干得漂亮，本轮小结如下」
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

describe('no restated always-on hints', () => {
  it('essay polish / model essay tabs drop the restating description line', () => {
    expect(read('src/components/essay-grading/PolishSectionView.tsx')).not.toContain("sections.polish_desc'");
    expect(read('src/components/essay-grading/ModelEssayView.tsx')).not.toContain("sections.model_essay_desc'");
  });

  it('media ask tab states the citation hint once', () => {
    expect(read('src/features/media-studio/components/MediaStudyTabs.tsx')).not.toContain('ask.citationHint');
  });

  it('flashcard session summary keeps only the empty-state guidance', () => {
    const src = read('src/features/flashcards/review/SessionSummary.tsx');
    expect(src).not.toContain("review.doneHint");
    expect(src).toContain("review.emptyHint");
  });
});

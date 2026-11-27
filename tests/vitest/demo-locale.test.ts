import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CJK_RE = /[\u4e00-\u9fff]/;

describe('demo content localization (?lang=en)', () => {
  const originalUrl = window.location.href;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    window.history.replaceState({}, '', originalUrl);
  });

  it('serves English scripts, cards, mind map, desktop history, and flashcards under ?lang=en', async () => {
    window.history.replaceState({}, '', '/demo.html?lang=en');

    const { demoLang, isDemoEn } = await import('@/demo/lang');
    const {
      ANKI_CARDS,
      DEFAULT_FOLLOW_UP,
      DEMO_MINDMAP_CONTENT,
      DEMO_MINDMAP_META,
      DEMO_QUESTIONS,
      DEMO_SESSIONS,
    } = await import('@/demo/fixtures');
    const { DEMO_ANKI_TEMPLATES } = await import('@/demo/ankiTemplates');
    const { DEMO_IMAGE_ASSETS, DEMO_PDF_NAME, DEMO_PDF_PARSED_TEXT } = await import('@/demo/attachmentAssets');
    const { DESKTOP_SCENE_HISTORY } = await import('@/demo/desktopHistory');
    const { handleDemoFlashcards } = await import('@/demo/flashcards');

    expect(demoLang).toBe('en-US');
    expect(isDemoEn).toBe(true);

    expect(DEMO_PDF_NAME).not.toMatch(CJK_RE);
    expect(DEMO_PDF_PARSED_TEXT).not.toMatch(CJK_RE);
    for (const img of DEMO_IMAGE_ASSETS) {
      expect(img.name).not.toMatch(CJK_RE);
      expect(img.svg).not.toMatch(CJK_RE);
    }

    for (const tpl of DEMO_ANKI_TEMPLATES) {
      expect(tpl.name).not.toMatch(CJK_RE);
      expect(tpl.description).not.toMatch(CJK_RE);
    }

    expect(DEMO_MINDMAP_META.title).not.toMatch(CJK_RE);
    expect(DEMO_MINDMAP_META.description).not.toMatch(CJK_RE);
    expect(DEMO_MINDMAP_CONTENT).not.toMatch(CJK_RE);
    expect(JSON.stringify(DEFAULT_FOLLOW_UP)).not.toMatch(CJK_RE);
    expect(JSON.stringify(ANKI_CARDS)).not.toMatch(CJK_RE);
    expect(JSON.stringify(DEMO_QUESTIONS)).not.toMatch(CJK_RE);
    expect(JSON.stringify(DESKTOP_SCENE_HISTORY)).not.toMatch(CJK_RE);

    for (const session of DEMO_SESSIONS) {
      expect(session.meta.title).not.toMatch(CJK_RE);
      if (session.meta.id !== 'demo-bilingual') {
        expect(session.autoPrompt).not.toMatch(CJK_RE);
        expect(JSON.stringify(session.followUp)).not.toMatch(CJK_RE);
        expect(JSON.stringify(session.continuations ?? [])).not.toMatch(CJK_RE);
      }
    }

    const due = handleDemoFlashcards('fsrs_get_due', { limit: 20 }) as Array<{ front: string; back: string; tags: string[] }>;
    expect(due.length).toBeGreaterThan(0);
    expect(JSON.stringify(due)).not.toMatch(CJK_RE);
  });

  it('keeps Chinese content by default when ?lang is omitted', async () => {
    window.history.replaceState({}, '', '/demo.html');

    const { demoLang } = await import('@/demo/lang');
    const { DEMO_SESSIONS } = await import('@/demo/fixtures');
    const { DESKTOP_SCENE_HISTORY } = await import('@/demo/desktopHistory');

    expect(demoLang).toBe('zh-CN');
    expect(DEMO_SESSIONS[0].meta.title).toContain('高数错题');
    expect(DESKTOP_SCENE_HISTORY.blocks[0].content).toContain('高数错题');
  });
});

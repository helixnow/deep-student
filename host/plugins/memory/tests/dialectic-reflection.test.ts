import { describe, expect, it } from 'vitest';
import {
  detectTextContradiction, filterProfileForActiveHardRules,
  reconcileProfilePreferencesWithRule, runDialecticReflection,
} from '../src/dialectic-reflection.ts';
import { emptyProfile } from '../src/learner-profile.ts';

describe('Memory v2 Dialectic Reflection Engine', () => {
  it('flags recurring weak points, stale retirement candidates, rule promotions, and budget pressure', () => {
    const nowMs = Date.parse('2026-11-23T12:00:00Z');
    const report = runDialecticReflection({
      nowMs,
      rulesChars: 1320,
      rulesMaxChars: 1500,
      profileChars: 800,
      profileMaxChars: 2500,
      hardRules: {
        version: 3,
        updated_at: '2026-11-23T00:00:00Z',
        rules: [
          {
            id: 'r1',
            instruction: '每次结尾留一道思考题',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 4,
        updated_at: '2026-11-23T00:00:00Z',
        weak_points: [
          {
            subject: '线性代数',
            knowledge_point: '特征值几何意义',
            error_pattern: '变换矩阵列空间理解错误',
            evidence_count: 4,
            last_seen: '2026-11-22T00:00:00Z',
          },
          {
            subject: '高等数学',
            knowledge_point: '洛必达法则条件',
            error_pattern: '未验证0/0型',
            evidence_count: 1,
            last_seen: '2026-09-01T00:00:00Z',
          },
        ],
        preferences: {
          others: ['每次结尾留一道思考题', '请优先用生活中的工程类比解释抽象概念'],
        },
        goals: [],
      },
    });

    expect(report.activeWeakPointCount).toBe(2);
    expect(report.proposals.some(p => p.kind === 'relapse_focus' && p.title.includes('特征值几何意义'))).toBe(true);
    expect(report.proposals.some(p => p.kind === 'retire_stale_weak_point' && p.title.includes('洛必达法则条件'))).toBe(true);
    expect(report.proposals.some(p => p.kind === 'compress_hard_rules')).toBe(true);
    // Budget >= 85% suppresses automatic promotion suggestions
    expect(report.proposals.some(p => p.kind === 'promote_preference_to_rule')).toBe(false);
  });

  it('suggests promoting uncovered soft preferences when L1 budget has headroom', () => {
    const report = runDialecticReflection({
      rulesChars: 200,
      rulesMaxChars: 1500,
      profileChars: 400,
      profileMaxChars: 2500,
      hardRules: { version: 1, updated_at: '2026-11-23T00:00:00Z', rules: [] },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-23T00:00:00Z',
        weak_points: [],
        preferences: { others: ['回答中所有数学符号都用中文标注含义'] },
        goals: [],
      },
    });

    expect(report.proposals.some(p => p.kind === 'promote_preference_to_rule')).toBe(true);
    expect(report.proposals.some(p => p.kind === 'compress_hard_rules')).toBe(false);
  });

  it('detects directly contradictory HardRules (length and language conflicts)', () => {
    const report = runDialecticReflection({
      rulesChars: 140,
      rulesMaxChars: 1500,
      profileChars: 0,
      profileMaxChars: 2500,
      hardRules: {
        version: 4,
        updated_at: '2026-11-24T00:00:00Z',
        rules: [
          {
            id: 'r_long',
            instruction: '回答必须极其详尽，不得少于 800 字，绝不允许省略任何中间推导步骤',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-24T00:00:00Z',
            updatedAt: '2026-11-24T00:00:00Z',
          },
          {
            id: 'r_brief',
            instruction: '所有回答严格控制在 120 字以内，禁止长篇大论',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-24T00:00:00Z',
            updatedAt: '2026-11-24T00:00:00Z',
          },
          {
            id: 'r_en',
            instruction: '全文必须使用全英文作答，严禁夹杂中文',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-24T00:00:00Z',
            updatedAt: '2026-11-24T00:00:00Z',
          },
          {
            id: 'r_zh',
            instruction: '必须用东北大白话中文讲，禁止英文单词',
            scope: 'global',
            origin: 'user_explicit',
            pinned: true,
            createdAt: '2026-11-24T00:00:00Z',
            updatedAt: '2026-11-24T00:00:00Z',
          },
        ],
      },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-24T00:00:00Z',
        weak_points: [],
        preferences: { others: [] },
        goals: [],
      },
    });

    const conflicts = report.proposals.filter(p => p.kind === 'resolve_rule_conflict');
    expect(conflicts).toHaveLength(2);
    expect(conflicts.some(c => c.title.includes('篇幅冲突'))).toBe(true);
    expect(conflicts.some(c => c.title.includes('语言冲突'))).toBe(true);
  });

  it('detects generalizable multilingual format, style, pace, pedagogy, language, and OOD negation contradictions without false positives', () => {
    // Multilingual format contradictions (English, Chinese, cross-lingual, French, Japanese, German, Spanish)
    expect(detectTextContradiction('Never use tables; use bullet points instead.', 'Prefer markdown tables for comparisons')?.dimension).toBe('format');
    expect(detectTextContradiction('以后不要用表格，改用要点列表', '偏好表格形式总结')?.dimension).toBe('format');
    expect(detectTextContradiction('No tables, use concise bullets', '偏好表格形式总结')?.dimension).toBe('format');
    expect(detectTextContradiction('Pas de tableaux, utilisez des listes à puces', 'Utiliser des tableaux comparatifs')?.dimension).toBe('format');
    expect(detectTextContradiction('表を使わないで箇条書きにしてください', '表形式でまとめてほしい')?.dimension).toBe('format');
    expect(detectTextContradiction('Keine Tabellen, lieber Stichpunkte', 'Nutze Tabellen für Vergleiche')?.dimension).toBe('format');
    expect(detectTextContradiction('Sin tablas, usa viñetas', 'Usa tablas comparativas')?.dimension).toBe('format');

    // Exclusive primary structure switches (prose vs bullets, mindmap vs lists)
    expect(detectTextContradiction('Switch to flowing prose paragraphs only', 'Always use bullet lists')?.dimension).toBe('format');
    expect(detectTextContradiction('No bullet points; write narrative paragraphs', 'Prefer bulleted summaries')?.dimension).toBe('format');

    // Pace, pedagogy, language, emoji, closing quiz
    expect(detectTextContradiction('Fast pace, skip basics', 'Slow', { olderIsPaceField: true })?.dimension).toBe('pace');
    expect(detectTextContradiction('Always give the direct answer first', 'Socratic hints first, never reveal the answer directly')?.dimension).toBe('pedagogy');
    expect(detectTextContradiction('Reply exclusively in Japanese', 'English', { olderIsLanguageField: true })?.dimension).toBe('language');
    expect(detectTextContradiction('Stop adding self-check questions', 'Always end with a self-check question')?.dimension).toBe('closing');
    expect(detectTextContradiction('No emojis in answers', 'Use friendly emojis')?.dimension).toBe('style');

    // Generic unseen OOD topic negation
    expect(detectTextContradiction('Never include mnemonics in explanations', 'Include mnemonics to help memorize terms')?.dimension).toBe('negation');
    expect(detectTextContradiction('不要再写打油诗了', '喜欢用打油诗总结知识点')?.dimension).toBe('negation');

    // Aligned negatives and unrelated preferences must NOT false-positive!
    expect(detectTextContradiction('Never use tables; use bullet points', 'Never use tables in answers')).toBeNull();
    expect(detectTextContradiction('Never use tables; use bullet points', 'Use real-world engineering analogies')).toBeNull();
    expect(detectTextContradiction('Focus on English grammar exceptions', '用中文讲解核心概念')).toBeNull();
    expect(detectTextContradiction('Always reply in concise English', 'English', { olderIsLanguageField: true })).toBeNull();
  });

  it('reconciles L2 preferences cleanly (including compound clauses) and surfaces L1-vs-L2 conflicts instead of promoting them', () => {
    const profile = emptyProfile();
    profile.preferences.explanation_style = 'Use visual analogies; prefer markdown tables for summaries';
    profile.preferences.language = 'Chinese';
    profile.preferences.pace = 'Slow';
    profile.preferences.others = [
      'Always include comparison tables',
      'Include mnemonics for terminology',
      'Highlight exam traps',
    ];

    const res1 = reconcileProfilePreferencesWithRule(profile, {
      id: 'r1',
      instruction: 'Never use tables and never include mnemonics; reply exclusively in English.',
      scope: 'global',
    });
    expect(res1.changed).toBe(true);
    expect(profile.preferences.explanation_style).toBe('Use visual analogies');
    expect(profile.preferences.language).toBeNull();
    expect(profile.preferences.pace).toBe('Slow');
    expect(profile.preferences.others).toEqual(['Highlight exam traps']);

    // Non-mutating filter helper leaves input profile intact while stripping contradicted fields
    const untouched = emptyProfile();
    untouched.preferences.explanation_style = 'Always use comparison tables';
    untouched.preferences.others = ['Use tables', 'Use real-world examples'];
    const filtered = filterProfileForActiveHardRules(untouched, [
      { id: 'r_no_tab', instruction: 'No tables; use bullet points', scope: 'subject:bio' },
    ]);
    expect(filtered.preferences.explanation_style).toBeNull();
    expect(filtered.preferences.others).toEqual(['Use real-world examples']);
    expect(untouched.preferences.explanation_style).toBe('Always use comparison tables');

    // Dialectic reflection flags an L1-vs-L2 contradiction instead of suggesting promotion
    const report = runDialecticReflection({
      rulesChars: 80,
      rulesMaxChars: 1500,
      profileChars: 120,
      profileMaxChars: 2500,
      hardRules: {
        version: 1,
        updated_at: '2026-11-25T00:00:00Z',
        rules: [{
          id: 'r_bullets',
          instruction: 'Never use tables; use bullet points instead.',
          scope: 'global',
          origin: 'user_explicit',
          pinned: true,
          createdAt: '2026-11-25T00:00:00Z',
          updatedAt: '2026-11-25T00:00:00Z',
        }],
      },
      learnerProfile: {
        version: 1,
        updated_at: '2026-11-25T00:00:00Z',
        weak_points: [],
        preferences: { others: ['Always summarize using markdown tables'] },
        goals: [],
      },
    });
    expect(report.proposals.some(p => p.kind === 'promote_preference_to_rule')).toBe(false);
    expect(report.proposals.some(p => p.kind === 'resolve_rule_conflict' && p.id.startsWith('conflict:l1_l2:'))).toBe(true);
  });
});

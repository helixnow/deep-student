import { describe, expect, it } from 'vitest';
import {
  buildPromotionPrompt, daysSinceBestSignal, extractHits, extractLastHitMs,
  extractLastInjectedMs, parsePromotionResponse, promotionFingerprint, signalWithinDays,
  type DailyLogRecord,
} from '../src/evolution.ts';
import {
  dedupeProfileVersionsKeepLast, emptyPreferencesPatch, emptyProfile, emptyProfileUpdate,
  enforceProfileCharLimit,
  isProfileUpdateEmpty, learnerProfileFromJson, learnerProfileToJson,
  mergeLearnerProfileUpdate, mergeProfileJsonForSync, mergeProfilesForSync,
  renderLearnerProfile, renderedCharCount, LEARNER_PROFILE_MAX_CHARS,
  type LearningGoal, type WeakPoint,
} from '../src/learner-profile.ts';
import {
  buildDedupPrompt, extractTagCount, parseDedupResponse, validateMergeDecision,
  TAG_HITS_PREFIX, TAG_USED_PREFIX,
} from '../src/semantic-dedup.ts';

function wp(subject: string, point: string, pattern: string, count: number): WeakPoint {
  return {
    subject, knowledge_point: point, error_pattern: pattern, evidence_count: count,
    last_seen: null,
  };
}

function sampleLogs(): DailyLogRecord[] {
  return [
    {
      date: '2026-07-07', noteId: 'n1',
      content: '- [10:00] 做了 5 道二次函数题，错 2 道，均为符号错误',
    },
    {
      date: '2026-07-08', noteId: 'n2',
      content: '- [21:30] 又做 3 道二次函数题，错 1 道，仍是符号错误',
    },
  ];
}

describe('memory evolution', () => {
  it('test_extract_hits', () => {
    const tags = ['_hits:5', '_last_hit:1234567890'];
    expect(extractHits(tags)).toBe(5);
    expect(extractLastHitMs(tags)).toBe(1234567890);
  });

  it('test_extract_hits_missing', () => {
    expect(extractHits([])).toBe(0);
    expect(extractLastHitMs([])).toBeNull();
    expect(extractLastInjectedMs([])).toBeNull();
  });

  it('test_extract_last_injected', () => {
    const tags = ['_hits:1', '_last_injected:9876543210'];
    expect(extractLastInjectedMs(tags)).toBe(9876543210);
  });

  it('test_signal_within_days_dual_threshold', () => {
    const now = Date.now();
    const daysAgo = (days: number) => now - days * 86_400_000;
    expect(signalWithinDays(now, daysAgo(100), 90)).toBe(false);
    expect(signalWithinDays(now, daysAgo(100), 180)).toBe(true);
    expect(signalWithinDays(now, daysAgo(200), 180)).toBe(false);
    expect(signalWithinDays(now, null, 90)).toBe(false);
    expect(signalWithinDays(now, Number.MAX_SAFE_INTEGER, 90)).toBe(false);
  });

  it('test_days_since_best_signal_prefers_latest_and_falls_back', () => {
    const now = Date.now();
    const daysAgo = (days: number) => now - days * 86_400_000;

    const days = daysSinceBestSignal(now, daysAgo(120), daysAgo(30), 'invalid');
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);

    const updatedAt = new Date(now - 10 * 86_400_000).toISOString();
    const fallback = daysSinceBestSignal(now, null, null, updatedAt);
    expect(fallback).toBeGreaterThanOrEqual(9);
    expect(fallback).toBeLessThanOrEqual(11);

    expect(daysSinceBestSignal(now, null, null, 'not-a-date')).toBe(Number.POSITIVE_INFINITY);
  });

  it('test_build_promotion_prompt_includes_logs_and_profile', () => {
    const profile = emptyProfile();
    profile.weak_points.push(wp('英语', '虚拟语气', '时态搭配错误', 2));
    const prompt = buildPromotionPrompt(sampleLogs(), profile);
    expect(prompt).toContain('### 2026-07-07');
    expect(prompt).toContain('符号错误');
    expect(prompt).toContain('虚拟语气');
    expect(prompt).toContain('weak_points_add');
  });

  it('test_build_promotion_prompt_empty_profile_placeholder', () => {
    const prompt = buildPromotionPrompt(sampleLogs(), emptyProfile());
    expect(prompt).toContain('（当前画像为空）');
  });

  it('test_parse_promotion_response_full_proposal', () => {
    const raw = `分析完成：
\`\`\`json
{
  "weak_points_add": [
    {"subject": "数学", "knowledge_point": "二次函数", "error_pattern": "配方时符号处理错误", "evidence_count": 3, "last_seen": "2026-07-08"}
  ],
  "weak_points_remove": [],
  "goals_add": [],
  "goals_remove": [],
  "recent_status": "近两天集中练习二次函数"
}
\`\`\``;
    const update = parsePromotionResponse(raw);
    expect(isProfileUpdateEmpty(update)).toBe(false);
    expect(update.weak_points_add).toHaveLength(1);
    expect(update.weak_points_add[0]!.evidence_count).toBe(3);
    expect(update.recent_status).toBe('近两天集中练习二次函数');

    const profile = emptyProfile();
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(true);
    expect(profile.weak_points).toHaveLength(1);
    expect(profile.weak_points[0]!.knowledge_point).toBe('二次函数');
  });

  it('test_parse_promotion_response_empty_and_garbage', () => {
    expect(isProfileUpdateEmpty(parsePromotionResponse('{}'))).toBe(true);
    expect(isProfileUpdateEmpty(parsePromotionResponse('模型拒绝回答'))).toBe(true);
    expect(isProfileUpdateEmpty(parsePromotionResponse(''))).toBe(true);
  });

  it('test_promotion_fingerprint_stable_and_sensitive', () => {
    const logs = sampleLogs();
    const first = promotionFingerprint(logs);
    const second = promotionFingerprint(logs);
    expect(first).toBe(second);
    const changed = sampleLogs();
    changed[1]!.content += '\n- [22:00] 新增一条';
    expect(promotionFingerprint(changed)).not.toBe(first);
  });
});

describe('learner profile merge/render/limits', () => {
  it('test_merge_upsert_weak_point_accumulates_evidence', () => {
    const profile = emptyProfile();
    profile.weak_points.push(wp('数学', '二次函数', '符号错误', 2));
    const update = emptyProfileUpdate();
    update.weak_points_add.push(wp('数学', '二次函数', '配方时符号处理错误', 3));
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(true);
    expect(profile.weak_points).toHaveLength(1);
    expect(profile.weak_points[0]!.evidence_count).toBe(5);
    expect(profile.weak_points[0]!.error_pattern).toBe('配方时符号处理错误');
  });

  it('test_merge_adds_new_weak_point_with_min_evidence', () => {
    const profile = emptyProfile();
    const update = emptyProfileUpdate();
    update.weak_points_add.push(wp('英语', '虚拟语气', '时态搭配错误', 0));
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(true);
    expect(profile.weak_points).toHaveLength(1);
    expect(profile.weak_points[0]!.evidence_count).toBe(1);
  });

  it('test_merge_remove_weak_point', () => {
    const profile = emptyProfile();
    profile.weak_points.push(wp('数学', '二次函数', '符号错误', 2));
    const update = emptyProfileUpdate();
    update.weak_points_remove.push({ subject: '数学', knowledge_point: '二次函数' });
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(true);
    expect(profile.weak_points).toHaveLength(0);
  });

  it('test_merge_skips_blank_weak_point', () => {
    const profile = emptyProfile();
    const update = emptyProfileUpdate();
    update.weak_points_add.push(wp('', '', '无效', 1));
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(false);
    expect(profile.weak_points).toHaveLength(0);
  });

  it('test_merge_preferences_patch_is_field_level', () => {
    const profile = emptyProfile();
    profile.preferences.language = '中文';
    profile.preferences.pace = '较慢';
    const update = emptyProfileUpdate();
    update.preferences = {
      ...emptyPreferencesPatch(),
      pace: '较快',
      others_add: ['喜欢表格总结', '喜欢表格总结'],
    };
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(true);
    expect(profile.preferences.language).toBe('中文');
    expect(profile.preferences.pace).toBe('较快');
    expect(profile.preferences.others).toHaveLength(1);
  });

  it('test_merge_goals_dedup_and_remove', () => {
    const profile = emptyProfile();
    const goal: LearningGoal = { goal: '高考数学 130+', deadline: '2026-06-07' };
    const update = emptyProfileUpdate();
    update.goals_add.push({ ...goal }, { ...goal });
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(true);
    expect(profile.goals).toHaveLength(1);

    const remove = emptyProfileUpdate();
    remove.goals_remove.push('高考数学 130+');
    expect(mergeLearnerProfileUpdate(profile, remove)).toBe(true);
    expect(profile.goals).toHaveLength(0);
  });

  it('test_merge_empty_update_no_change', () => {
    const profile = emptyProfile();
    const update = emptyProfileUpdate();
    expect(isProfileUpdateEmpty(update)).toBe(true);
    expect(mergeLearnerProfileUpdate(profile, update)).toBe(false);
  });

  it('test_render_markdown_contains_all_sections', () => {
    const profile = emptyProfile();
    profile.version = 3;
    profile.updated_at = '2026-07-08';
    profile.recent_status = '连续三天练习二次函数';
    profile.weak_points.push({
      subject: '数学', knowledge_point: '二次函数', error_pattern: '符号错误',
      evidence_count: 4, last_seen: '2026-07-08',
    });
    profile.preferences.explanation_style = '先结论后推导';
    profile.goals.push({ goal: '高考数学 130+', deadline: '2026-06-07' });

    const markdown = renderLearnerProfile(profile);
    expect(markdown).toContain('学习者画像（v3');
    expect(markdown).toContain('薄弱知识点');
    expect(markdown).toContain('[数学/二次函数] 符号错误（证据×4，最近 2026-07-08）');
    expect(markdown).toContain('讲解风格：先结论后推导');
    expect(markdown).toContain('高考数学 130+（期限 2026-06-07）');
    expect(markdown).toContain('近期状态');
  });

  it('test_enforce_char_limit_drops_low_evidence_first', () => {
    const profile = emptyProfile();
    for (let index = 0; index < 50; index += 1) {
      profile.weak_points.push(wp('数学', `知识点${index}`,
        '很长的错误模式描述'.repeat(10), index));
    }
    expect(renderedCharCount(profile)).toBeGreaterThan(LEARNER_PROFILE_MAX_CHARS);
    expect(enforceProfileCharLimit(profile)).toBe(true);
    expect(renderedCharCount(profile)).toBeLessThanOrEqual(LEARNER_PROFILE_MAX_CHARS);
    expect(profile.weak_points[0]!.evidence_count)
      .toBeGreaterThanOrEqual(profile.weak_points.at(-1)!.evidence_count);
  });

  it('test_enforce_char_limit_noop_when_small', () => {
    const profile = emptyProfile();
    profile.weak_points.push(wp('数学', '函数', '符号错误', 1));
    expect(enforceProfileCharLimit(profile)).toBe(false);
    expect(profile.weak_points).toHaveLength(1);
  });

  it('test_json_roundtrip', () => {
    const profile = emptyProfile();
    profile.version = 7;
    profile.weak_points.push(wp('物理', '受力分析', '漏画摩擦力', 3));
    const parsed = learnerProfileFromJson(learnerProfileToJson(profile));
    expect(parsed).toEqual(profile);
  });

  it('test_from_json_tolerates_missing_fields', () => {
    const parsed = learnerProfileFromJson('{"weak_points":[{"subject":"数学"}]}');
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(0);
    expect(parsed!.weak_points).toHaveLength(1);
    expect(parsed!.weak_points[0]!.evidence_count).toBe(0);
  });

  it('profile_history_dedup_keeps_last_entry_for_each_version', () => {
    const v1Old = emptyProfile();
    v1Old.version = 1;
    v1Old.updated_at = 'old';
    v1Old.recent_status = 'old';
    const v2 = emptyProfile();
    v2.version = 2;
    v2.updated_at = 'v2';
    v2.recent_status = 'v2';
    const v1New = emptyProfile();
    v1New.version = 1;
    v1New.recent_status = 'new';

    const deduped = dedupeProfileVersionsKeepLast([v1Old, v2, v1New]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]!.version).toBe(1);
    expect(deduped[0]!.recent_status).toBe('new');
    expect(deduped[1]!.version).toBe(2);
  });

  it('sync_merge_is_symmetric_and_keeps_both_sides_increments', () => {
    const deviceA = emptyProfile();
    deviceA.version = 5;
    deviceA.updated_at = '2026-07-19T10:00:00+00:00';
    deviceA.recent_status = 'A 侧状态';
    deviceA.weak_points.push(wp('数学', '二次函数', '符号错误', 4));
    deviceA.weak_points.push(wp('英语', '虚拟语气', '时态', 2));
    deviceA.goals.push({ goal: '共同目标', deadline: '2026-08-01' });
    deviceA.goals.push({ goal: 'A 侧目标', deadline: null });

    const deviceB = emptyProfile();
    deviceB.version = 6;
    deviceB.updated_at = '2026-07-19T11:00:00+00:00';
    deviceB.recent_status = 'B 侧状态';
    deviceB.weak_points.push(wp('数学', '二次函数', '配方符号错误', 7));
    deviceB.weak_points.push(wp('物理', '受力分析', '漏力', 1));
    deviceB.goals.push({ goal: '共同目标', deadline: '2026-09-01' });

    const mergedAb = mergeProfilesForSync(deviceA, deviceB);
    const mergedBa = mergeProfilesForSync(deviceB, deviceA);
    expect(learnerProfileToJson(mergedAb)).toBe(learnerProfileToJson(mergedBa));

    expect(mergedAb.version).toBe(7);
    expect(mergedAb.updated_at).toBe('2026-07-19T11:00:00+00:00');
    expect(mergedAb.weak_points).toHaveLength(3);
    const math = mergedAb.weak_points.find(item => item.knowledge_point === '二次函数')!;
    expect(math.evidence_count).toBe(7);
    expect(math.error_pattern).toBe('配方符号错误');
    expect(mergedAb.weak_points.some(item => item.knowledge_point === '虚拟语气')).toBe(true);
    expect(mergedAb.weak_points.some(item => item.knowledge_point === '受力分析')).toBe(true);
    expect(mergedAb.goals).toHaveLength(2);
    expect(mergedAb.goals.find(item => item.goal === '共同目标')!.deadline).toBe('2026-09-01');
    expect(mergedAb.recent_status).toBe('B 侧状态');
  });

  it('sync_merge_json_entry_rejects_non_profile_content', () => {
    expect(mergeProfileJsonForSync('普通笔记文本', '{}')).toBeNull();
    expect(mergeProfileJsonForSync('{"foo":1}', '{"bar":2}')).toBeNull();
    const profileJson = learnerProfileToJson(emptyProfile());
    expect(mergeProfileJsonForSync(profileJson, '{"foo":1}')).toBeNull();
    expect(mergeProfileJsonForSync(profileJson, profileJson)).not.toBeNull();
  });
});

describe('semantic dedup', () => {
  it('test_parse_dedup_response_merge', () => {
    const raw = `\`\`\`json
{"action": "merge", "keep_note_id": "n1", "merged_content": "数学二次函数配方法掌握不牢，符号处理常出错"}
\`\`\``;
    const decision = parseDedupResponse(raw);
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe('merge');
    expect(decision!.keep_note_id).toBe('n1');
  });

  it('test_parse_dedup_response_keep_with_noise', () => {
    const decision = parseDedupResponse('分析：两条各有价值。\n{"action": "keep"}');
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe('keep');
    expect(decision!.keep_note_id ?? null).toBeNull();
  });

  it('test_parse_dedup_response_invalid_action', () => {
    expect(parseDedupResponse('{"action": "delete"}')).toBeNull();
    expect(parseDedupResponse('没有 JSON')).toBeNull();
  });

  it('test_validate_merge_decision_guards', () => {
    const a = { id: 'n1', title: 'A' };
    const b = { id: 'n2', title: 'B' };
    expect(validateMergeDecision({
      action: 'merge', keep_note_id: 'n1', merged_content: '合并后内容',
    }, a, b, 200)).toEqual(['n1', '合并后内容']);
    expect(validateMergeDecision({
      action: 'merge', keep_note_id: 'n999', merged_content: '内容',
    }, a, b, 200)).toBeNull();
    expect(validateMergeDecision({
      action: 'merge', keep_note_id: 'n2', merged_content: '长'.repeat(201),
    }, a, b, 200)).toBeNull();
    expect(validateMergeDecision({
      action: 'merge', keep_note_id: 'n1', merged_content: '   ',
    }, a, b, 200)).toBeNull();
    expect(validateMergeDecision({
      action: 'keep', keep_note_id: null, merged_content: null,
    }, a, b, 200)).toBeNull();
  });

  it('test_extract_tag_count_max_merge', () => {
    const aTags = ['_hits:3', '_used:2', '_type:fact'];
    const bTags = ['_hits:7'];
    expect(Math.max(extractTagCount(aTags, TAG_HITS_PREFIX),
      extractTagCount(bTags, TAG_HITS_PREFIX))).toBe(7);
    expect(Math.max(extractTagCount(aTags, TAG_USED_PREFIX),
      extractTagCount(bTags, TAG_USED_PREFIX))).toBe(2);
    expect(extractTagCount([], TAG_HITS_PREFIX)).toBe(0);
  });

  it('test_build_dedup_prompt_contains_both_notes', () => {
    const prompt = buildDedupPrompt(
      { id: 'n1', title: '数学二次函数薄弱' }, '内容A',
      { id: 'n2', title: '配方法掌握不牢' }, '内容B', 200);
    expect(prompt).toContain('[ID: n1]');
    expect(prompt).toContain('[ID: n2]');
    expect(prompt).toContain('内容A');
    expect(prompt).toContain('内容B');
    expect(prompt).toContain('不超过 200 字');
    expect(prompt).toContain('"action": "merge" | "keep"');
  });
});

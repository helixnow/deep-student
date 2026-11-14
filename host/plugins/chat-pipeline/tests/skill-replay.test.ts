import { describe, expect, it } from 'vitest';
import {
  insertTransientSkillMessages, rebuildAnchoredSkillMessages,
  rebuildAnchoredSkillMessagesGated, skillBodyDigest, type SkillInjectionAnchors,
} from '../src/skill-injection.ts';
import {
  parseSkillInjectionAnchors, serializeSkillInjectionAnchors,
} from '../src/skill-injection.ts';
import {
  isTransientSkillMessage, makeEmptyMessage, makeTransientSkillMessage,
  type LegacyChatMessage,
} from '../src/microcompact.ts';

/** LLM-visible bytes; the Rust timestamp never reaches the provider payload. */
function llmVisibleBytes(message: LegacyChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    metadata: message.metadata,
  });
}

function contentsMap(entries: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  return new Map(entries.map(([id, content]) => [id, content]));
}

function anchorsForTurn(entries: ReadonlyArray<readonly [string, string]>): SkillInjectionAnchors {
  return {
    turnSkillIds: entries.map(([id]) => id),
    beforeTurnUser: true,
    toolAnchored: [],
    skillContentDigests: new Map(entries.map(([id, body]) => [id, skillBodyDigest(id, body)])),
  };
}

// --- contract copy from the Rust test module (r3 digest contract) -----------

interface AnchoredSkillDigest {
  skillId: string;
  contentDigest: string;
}

type ReplaySkipReason = { kind: 'missingContent' }
  | { kind: 'digestMismatch'; anchoredDigest: string; currentDigest: string };

interface ReplaySkip {
  skillId: string;
  reason: ReplaySkipReason;
}

/** FNV-1a 64 with algorithm prefix; the contract locks determinism + byte sensitivity. */
function contractSkillContentDigest(content: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(content, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x00000100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function anchorSkill(skillId: string, liveContent: string): AnchoredSkillDigest {
  return { skillId, contentDigest: contractSkillContentDigest(liveContent) };
}

function contractRebuildAnchoredSkillMessages(anchors: readonly AnchoredSkillDigest[],
  skillContents: ReadonlyMap<string, string> | null | undefined):
  { restored: LegacyChatMessage[]; skipped: ReplaySkip[] } {
  const restored: LegacyChatMessage[] = [];
  const skipped: ReplaySkip[] = [];
  for (const anchor of anchors) {
    const content = skillContents?.get(anchor.skillId);
    if (content === undefined) {
      skipped.push({ skillId: anchor.skillId, reason: { kind: 'missingContent' } });
      continue;
    }
    const currentDigest = contractSkillContentDigest(content);
    if (currentDigest !== anchor.contentDigest) {
      skipped.push({
        skillId: anchor.skillId,
        reason: {
          kind: 'digestMismatch',
          anchoredDigest: anchor.contentDigest,
          currentDigest,
        },
      });
      continue;
    }
    restored.push(makeTransientSkillMessage(anchor.skillId, content));
  }
  return { restored, skipped };
}

function productionAnchors(entries: ReadonlyArray<readonly [string, string]>): SkillInjectionAnchors {
  return anchorsForTurn(entries);
}

describe('chat_v2/pipeline/skill_replay_digest_tests.rs', () => {
  it('modified_skill_digest_mismatch_skips_instead_of_forging_history', () => {
    const v1 = '步骤一：先审题。\n步骤二：列方程。\n';
    const v2 = '步骤一：先审题。\n步骤二：列方程并验根。\n';

    const liveTurn1 = makeTransientSkillMessage('solve-equation', v1);
    const anchor = anchorSkill('solve-equation', v1);
    const replayContents = contentsMap([['solve-equation', v2]]);
    const { restored, skipped } =
      contractRebuildAnchoredSkillMessages([anchor], replayContents);

    expect(restored).toEqual([]);
    expect(skipped).toEqual([{
      skillId: 'solve-equation',
      reason: {
        kind: 'digestMismatch',
        anchoredDigest: contractSkillContentDigest(v1),
        currentDigest: contractSkillContentDigest(v2),
      },
    }]);

    const forgedWithV2 = makeTransientSkillMessage('solve-equation', v2);
    expect(llmVisibleBytes(forgedWithV2)).not.toBe(llmVisibleBytes(liveTurn1));

    // The ungated entry point is the documented compatibility path.
    const ungated = rebuildAnchoredSkillMessages(['solve-equation'], replayContents);
    expect(ungated).toHaveLength(1);
    expect(llmVisibleBytes(ungated[0]!)).toBe(llmVisibleBytes(forgedWithV2));
    expect(llmVisibleBytes(ungated[0]!)).not.toBe(llmVisibleBytes(liveTurn1));
  });

  it('multi_anchor_mismatch_skips_only_the_drifted_skill_keeping_order', () => {
    const intactA = '技能 A 正文（未改）';
    const driftedBv1 = '技能 B 正文 v1';
    const driftedBv2 = '技能 B 正文 v2（被改）';
    const intactC = '技能 C 正文（未改）';

    const anchors = [
      anchorSkill('skill-a', intactA),
      anchorSkill('skill-b', driftedBv1),
      anchorSkill('skill-c', intactC),
    ];
    const replayContents = contentsMap([
      ['skill-a', intactA],
      ['skill-b', driftedBv2],
      ['skill-c', intactC],
    ]);

    const { restored, skipped } =
      contractRebuildAnchoredSkillMessages(anchors, replayContents);

    expect(restored).toHaveLength(2);
    expect(llmVisibleBytes(restored[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('skill-a', intactA)));
    expect(llmVisibleBytes(restored[1]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('skill-c', intactC)));
    expect(skipped).toEqual([{
      skillId: 'skill-b',
      reason: {
        kind: 'digestMismatch',
        anchoredDigest: contractSkillContentDigest(driftedBv1),
        currentDigest: contractSkillContentDigest(driftedBv2),
      },
    }]);
  });

  it('deleted_skill_missing_content_warns_and_skips_without_blocking', () => {
    const alive = '存活技能正文';
    const anchors = [
      anchorSkill('alive-skill', alive),
      anchorSkill('ghost-skill', '已被删除的正文'),
    ];
    const replayContents = contentsMap([['alive-skill', alive]]);

    const { restored, skipped } =
      contractRebuildAnchoredSkillMessages(anchors, replayContents);

    expect(restored).toHaveLength(1);
    expect(llmVisibleBytes(restored[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('alive-skill', alive)));
    expect(skipped).toEqual([
      { skillId: 'ghost-skill', reason: { kind: 'missingContent' } },
    ]);

    const none = contractRebuildAnchoredSkillMessages(anchors, null);
    expect(none.restored).toEqual([]);
    expect(none.skipped).toHaveLength(2);
    expect(none.skipped.every(skip => skip.reason.kind === 'missingContent')).toBe(true);

    const production = rebuildAnchoredSkillMessages(
      ['alive-skill', 'ghost-skill'], replayContents);
    expect(production).toHaveLength(1);
    expect(llmVisibleBytes(production[0]!)).toBe(llmVisibleBytes(restored[0]!));
    expect(rebuildAnchoredSkillMessages(['ghost-skill'], null)).toEqual([]);
  });

  it('matching_digest_replays_byte_identical_to_live', () => {
    const skillId = 'skill "quoted" & <angled>';
    const content = '第一行 line1\r\ncrlf 保留\n尾行带换行\n';

    const live = makeTransientSkillMessage(skillId, content);
    expect(isTransientSkillMessage(live)).toBe(true);
    expect(live.content).toBe(
      '<skill_instructions id="skill &quot;quoted&quot; &amp; &lt;angled&gt;">\n'
      + `${content}\n</skill_instructions>`);
    expect(live.role).toBe('user');
    expect(live.metadata).toEqual({
      kind: 'skill_instruction', hidden: true, skillId,
    });

    const anchors = [anchorSkill(skillId, content)];
    const replayContents = contentsMap([[skillId, content]]);
    const { restored, skipped } =
      contractRebuildAnchoredSkillMessages(anchors, replayContents);

    expect(skipped).toEqual([]);
    expect(restored).toHaveLength(1);
    expect(llmVisibleBytes(restored[0]!)).toBe(llmVisibleBytes(live));

    const production = rebuildAnchoredSkillMessages([skillId], replayContents);
    expect(production).toHaveLength(1);
    expect(llmVisibleBytes(production[0]!)).toBe(llmVisibleBytes(live));
  });

  it('digest_is_deterministic_and_sensitive_to_any_byte_change', () => {
    const base = '步骤一：先审题。\n步骤二：列方程。';
    expect(contractSkillContentDigest(base))
      .toBe(contractSkillContentDigest(String(base)));

    const variants = [
      '步骤一：先审题。\n步骤二：列方程！',
      '步骤一：先审题。\n步骤二：列方程。\n',
      '步骤一：先审题。\r\n步骤二：列方程。',
      '',
      ' ',
    ];
    const digests = [contractSkillContentDigest(base),
      ...variants.map(variant => contractSkillContentDigest(variant))];
    for (let left = 0; left < digests.length; left++) {
      for (let right = left + 1; right < digests.length; right++) {
        expect(digests[left], `inputs ${left} and ${right} collided`)
          .not.toBe(digests[right]);
      }
    }
  });

  it('finale_modified_skill_gate_skips_signals_and_recovers_on_revert', () => {
    const v1 = '步骤一：先审题。\n步骤二：列方程。\n';
    const v2 = '步骤一：先审题。\n步骤二：列方程并验根。\n';
    const skillId = 'solve-equation';
    const ids = [skillId];

    const liveTurn1 = makeTransientSkillMessage(skillId, v1);
    const anchors = productionAnchors([[skillId, v1]]);
    expect(anchors.skillContentDigests.get(skillId)).toBe(skillBodyDigest(skillId, v1));

    const v2Contents = contentsMap([[skillId, v2]]);
    const signal: string[] = [];
    const restored = rebuildAnchoredSkillMessagesGated(ids, v2Contents, anchors, signal);
    expect(restored).toEqual([]);
    expect(signal).toEqual([skillId]);

    const restoredToolAnchor =
      rebuildAnchoredSkillMessagesGated(ids, v2Contents, anchors, signal);
    expect(restoredToolAnchor).toEqual([]);
    expect(signal).toEqual([skillId]);

    for (let laterTurn = 0; laterTurn < 3; laterTurn++) {
      const steadySignal: string[] = [];
      const steady = rebuildAnchoredSkillMessagesGated(ids, v2Contents, anchors, steadySignal);
      expect(steady).toEqual([]);
      expect(steadySignal).toEqual([skillId]);
    }

    expect(rebuildAnchoredSkillMessagesGated(ids, v2Contents, anchors)).toEqual([]);

    const contract = contractRebuildAnchoredSkillMessages(
      [anchorSkill(skillId, v1)], v2Contents);
    expect(contract.restored).toEqual([]);
    expect(contract.skipped).toHaveLength(1);

    const v1Contents = contentsMap([[skillId, v1]]);
    const revertSignal: string[] = [];
    const recovered = rebuildAnchoredSkillMessagesGated(ids, v1Contents, anchors, revertSignal);
    expect(recovered).toHaveLength(1);
    expect(revertSignal).toEqual([]);
    expect(llmVisibleBytes(recovered[0]!)).toBe(llmVisibleBytes(liveTurn1));

    const legacyAnchors: SkillInjectionAnchors = {
      turnSkillIds: ids,
      beforeTurnUser: true,
      toolAnchored: [],
      skillContentDigests: new Map(),
    };
    const legacySignal: string[] = [];
    const legacy = rebuildAnchoredSkillMessagesGated(ids, v2Contents, legacyAnchors, legacySignal);
    expect(legacy).toHaveLength(1);
    expect(legacySignal).toEqual([]);
    expect(llmVisibleBytes(legacy[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage(skillId, v2)));
  });

  it('finale_deleted_skill_gate_skips_without_signal_and_recovery_needs_exact_bytes', () => {
    const alive = '存活技能正文';
    const ghostBody = '已被删除的正文';
    const driftedV1 = '第三技能正文 v1';
    const driftedV2 = '第三技能正文 v2（被改）';

    const anchors = productionAnchors([
      ['alive-skill', alive],
      ['ghost-skill', ghostBody],
      ['drifted-skill', driftedV1],
    ]);
    const ids = [...anchors.turnSkillIds];

    const mixedContents = contentsMap([
      ['alive-skill', alive],
      ['drifted-skill', driftedV2],
    ]);
    const signal: string[] = [];
    const restored = rebuildAnchoredSkillMessagesGated(ids, mixedContents, anchors, signal);
    expect(restored).toHaveLength(1);
    expect(llmVisibleBytes(restored[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('alive-skill', alive)));
    expect(signal).toEqual(['drifted-skill']);

    const noneSignal: string[] = [];
    expect(rebuildAnchoredSkillMessagesGated(ids, null, anchors, noneSignal)).toEqual([]);
    expect(noneSignal).toEqual([]);

    const contract = contractRebuildAnchoredSkillMessages([
      anchorSkill('alive-skill', alive),
      anchorSkill('ghost-skill', ghostBody),
      anchorSkill('drifted-skill', driftedV1),
    ], mixedContents);
    expect(contract.restored).toHaveLength(1);
    expect(contract.skipped.map(skip => [skip.skillId, skip.reason.kind === 'missingContent']))
      .toEqual([['ghost-skill', true], ['drifted-skill', false]]);

    const recreatedExact = contentsMap([
      ['alive-skill', alive],
      ['ghost-skill', ghostBody],
      ['drifted-skill', driftedV1],
    ]);
    const exactSignal: string[] = [];
    const full = rebuildAnchoredSkillMessagesGated(ids, recreatedExact, anchors, exactSignal);
    expect(full).toHaveLength(3);
    expect(exactSignal).toEqual([]);
    expect(llmVisibleBytes(full[1]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('ghost-skill', ghostBody)));

    const recreatedDiff = contentsMap([
      ['alive-skill', alive],
      ['ghost-skill', '重建后的新正文'],
      ['drifted-skill', driftedV1],
    ]);
    const diffSignal: string[] = [];
    const partial = rebuildAnchoredSkillMessagesGated(ids, recreatedDiff, anchors, diffSignal);
    expect(partial).toHaveLength(2);
    expect(diffSignal).toEqual(['ghost-skill']);
    expect(llmVisibleBytes(partial[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('alive-skill', alive)));
    expect(llmVisibleBytes(partial[1]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('drifted-skill', driftedV1)));
  });
});

describe('chat_v2/pipeline/skill_replay_edit_delete_tests.rs', () => {
  it('edit_lifecycle_anchor_persist_reload_gate_skips_edited_body_and_signals', () => {
    const v1 = '步骤一：审题。\n步骤二：列方程。\n';
    const v2 = '步骤一：审题。\n步骤二：列方程并验根。\n';

    const liveTurn1 = makeTransientSkillMessage('solve-equation', v1);
    expect(isTransientSkillMessage(liveTurn1)).toBe(true);
    const anchorsLive = anchorsForTurn([['solve-equation', v1]]);

    const persisted = serializeSkillInjectionAnchors(anchorsLive);
    expect(persisted).not.toContain('列方程');
    expect(persisted).toContain('skillContentDigests');

    const anchors = parseSkillInjectionAnchors(persisted)!;
    expect(anchors).toEqual(anchorsLive);
    const contentsAfterEdit = contentsMap([['solve-equation', v2]]);

    const signal: string[] = [];
    const restored = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, contentsAfterEdit, anchors, signal);
    expect(restored).toEqual([]);
    expect(signal).toEqual(['solve-equation']);

    const forgedWithV2 = makeTransientSkillMessage('solve-equation', v2);
    expect(llmVisibleBytes(forgedWithV2)).not.toBe(llmVisibleBytes(liveTurn1));
    expect(rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, contentsAfterEdit, anchors)).toEqual([]);
  });

  it('edit_then_revert_heals_replay_byte_identical_without_new_signal', () => {
    const v1 = '校对规则：先查错别字，再查标点。';
    const v2 = '校对规则：只查错别字。';
    const anchors = anchorsForTurn([['proofread', v1]]);
    const liveTurn1 = makeTransientSkillMessage('proofread', v1);

    const signal: string[] = [];
    const whileEdited = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, contentsMap([['proofread', v2]]), anchors, signal);
    expect(whileEdited).toEqual([]);
    expect(signal).toEqual(['proofread']);

    const afterRevert = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, contentsMap([['proofread', v1]]), anchors, signal);
    expect(afterRevert).toHaveLength(1);
    expect(llmVisibleBytes(afterRevert[0]!)).toBe(llmVisibleBytes(liveTurn1));
    expect(signal).toEqual(['proofread']);
  });

  it('deleted_skill_skips_without_signal_documenting_residual_gap', () => {
    const alive = '存活技能正文';
    const anchors = anchorsForTurn([
      ['alive-skill', alive],
      ['deleted-skill', '锚定时存在、之后被删除的正文'],
    ]);
    const contents = contentsMap([['alive-skill', alive]]);

    const signal: string[] = [];
    const restored = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, contents, anchors, signal);
    expect(restored).toHaveLength(1);
    expect(llmVisibleBytes(restored[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('alive-skill', alive)));
    // Current semantics: a missing body is skipped but never signals a generation change.
    expect(signal).toEqual([]);

    const noneSignal: string[] = [];
    expect(rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, null, anchors, noneSignal)).toEqual([]);
    expect(noneSignal).toEqual([]);
  });

  it('deleted_live_skill_with_replay_snapshot_still_replays_old_bytes', () => {
    const frozenBody = '冻结在会话快照里的正文（live 目录已删）';
    const anchors = anchorsForTurn([['archived-skill', frozenBody]]);
    const liveTurn1 = makeTransientSkillMessage('archived-skill', frozenBody);
    const merged = contentsMap([['archived-skill', frozenBody]]);

    const signal: string[] = [];
    const restored = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, merged, anchors, signal);
    expect(restored).toHaveLength(1);
    expect(llmVisibleBytes(restored[0]!)).toBe(llmVisibleBytes(liveTurn1));
    expect(signal).toEqual([]);
  });

  it('mixed_edit_delete_intact_judged_per_anchor_with_deduped_signal', () => {
    const intact = '技能 A 正文（未动）';
    const editedV1 = '技能 B 正文 v1';
    const editedV2 = '技能 B 正文 v2（被改）';

    const anchors = anchorsForTurn([
      ['skill-a', intact],
      ['skill-b', editedV1],
      ['skill-c', '锚定后被删除的正文'],
    ]);
    anchors.toolAnchored = [{
      toolCallId: 'call_load_skills_1',
      skillIds: ['skill-b'],
      roundLastToolCallId: null,
    }];

    const contents = contentsMap([['skill-a', intact], ['skill-b', editedV2]]);
    const signal: string[] = ['earlier-skill'];

    const restoredTurn = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds, contents, anchors, signal);
    expect(restoredTurn).toHaveLength(1);
    expect(llmVisibleBytes(restoredTurn[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('skill-a', intact)));
    expect(signal).toEqual(['earlier-skill', 'skill-b']);

    const restoredTool = rebuildAnchoredSkillMessagesGated(
      anchors.toolAnchored[0]!.skillIds, contents, anchors, signal);
    expect(restoredTool).toEqual([]);
    expect(signal).toEqual(['earlier-skill', 'skill-b']);
  });

  it('legacy_anchor_without_digest_blindly_replays_edited_body', () => {
    const v1 = '旧会话锚定时的正文';
    const v2 = '之后被编辑的新正文';
    const liveTurn1 = makeTransientSkillMessage('legacy-skill', v1);
    const contentsAfterEdit = contentsMap([['legacy-skill', v2]]);

    const legacy = parseSkillInjectionAnchors(
      '{"turnSkillIds": ["legacy-skill"], "beforeTurnUser": true}')!;
    expect(legacy.skillContentDigests.size).toBe(0);
    expect(legacy.skillContentDigests.get('legacy-skill')).toBeUndefined();

    const signal: string[] = [];
    const restored = rebuildAnchoredSkillMessagesGated(
      legacy.turnSkillIds, contentsAfterEdit, legacy, signal);
    expect(restored).toHaveLength(1);
    expect(llmVisibleBytes(restored[0]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('legacy-skill', v2)));
    expect(llmVisibleBytes(restored[0]!)).not.toBe(llmVisibleBytes(liveTurn1));
    expect(signal).toEqual([]);

    const ungated = rebuildAnchoredSkillMessages(legacy.turnSkillIds, contentsAfterEdit);
    expect(ungated).toHaveLength(1);
    expect(llmVisibleBytes(ungated[0]!)).toBe(llmVisibleBytes(restored[0]!));

    const gatedAnchors = anchorsForTurn([['legacy-skill', v1]]);
    const gatedSignal: string[] = [];
    expect(rebuildAnchoredSkillMessagesGated(
      gatedAnchors.turnSkillIds, contentsAfterEdit, gatedAnchors, gatedSignal)).toEqual([]);
    expect(gatedSignal).toEqual(['legacy-skill']);
  });

  it('all_anchors_skipped_leaves_history_untouched_including_request_anchor', () => {
    const anchors = anchorsForTurn([['edited-skill', '锚定正文 v1']]);
    const restored = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds,
      contentsMap([['edited-skill', '编辑后的正文 v2']]),
      anchors);
    expect(restored).toEqual([]);

    const history = [
      makeEmptyMessage('user', '第一轮 user'),
      makeEmptyMessage('assistant', '第一轮回复'),
    ];
    const before = history.map(llmVisibleBytes);

    insertTransientSkillMessages(history, 0, restored);
    expect(history).toHaveLength(2);
    expect(history.map(llmVisibleBytes)).toEqual(before);

    const hit = rebuildAnchoredSkillMessagesGated(
      anchors.turnSkillIds,
      contentsMap([['edited-skill', '锚定正文 v1']]),
      anchors);
    expect(hit).toHaveLength(1);
    insertTransientSkillMessages(history, 0, hit);
    expect(history).toHaveLength(4);
    expect(isTransientSkillMessage(history[0]!)).toBe(false);
    expect(isTransientSkillMessage(history[1]!)).toBe(true);
    expect(llmVisibleBytes(history[1]!))
      .toBe(llmVisibleBytes(makeTransientSkillMessage('edited-skill', '锚定正文 v1')));
  });
});

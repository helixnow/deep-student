import { describe, expect, it } from 'vitest';
import { chatAnkiSkill } from '@/features/chat/skills/builtin';

/**
 * ChatAnki Round 5 契约：run/start 生成调优参数的 TS schema ↔ Rust args 同源锁定。
 *
 * Rust 侧真源：`src-tauri/src/chat_v2/tools/chatanki_executor.rs`
 * - `ChatAnkiRunArgs`：outputProtocol / visualHint / contentFormat / enableQaPass /
 *   enableCriticPass / enableFsrsFeedback / maxImages / enablePreferenceMemory
 *   （serde camelCase + snake_case alias）；
 * - `ChatAnkiStartArgs`：同上但**没有** route / resourceId(s) / visualHint / maxImages
 *   （start 固定纯文本路径，永不触发 VLM）；
 * - `normalize_output_protocol_arg`：仅接受 auto|delimiter|json_object|json_schema，
 *   非法值在启动前直接报错（不静默回退成 delimiter）——schema enum 必须与之一致；
 * - `ChatAnkiContentFormat`：auto|glossary|prose（default Auto）；
 * - `MAX_VLM_IMAGES = 12`，`effective_max_images` clamp 到 1..=12。
 */
describe('ChatAnki Round 5 skill params contract', () => {
  const embedded = chatAnkiSkill.embeddedTools ?? [];
  const findTool = (name: string) => embedded.find((tool) => tool.name === name);
  const schemaOf = (name: string) => findTool(name)?.inputSchema as any;

  // --------------------------------------------------------------------
  // 工具清单：显式清单 diff（增删工具必须显式改这份清单，不看数字）
  // --------------------------------------------------------------------

  const TOOL_MANIFEST = [
    'builtin-chatanki_add_cards',
    'builtin-chatanki_analyze',
    'builtin-chatanki_batch_update_cards',
    'builtin-chatanki_check_anki_connect',
    'builtin-chatanki_control',
    'builtin-chatanki_delete_card',
    'builtin-chatanki_delete_cards',
    'builtin-chatanki_delete_library_card',
    'builtin-chatanki_enqueue_library_review',
    'builtin-chatanki_enqueue_review',
    'builtin-chatanki_export',
    'builtin-chatanki_get_cards',
    'builtin-chatanki_import_apkg',
    'builtin-chatanki_list_library_cards',
    'builtin-chatanki_list_templates',
    'builtin-chatanki_retemplate',
    'builtin-chatanki_review_stats',
    'builtin-chatanki_run',
    'builtin-chatanki_set_library_suspended',
    'builtin-chatanki_set_suspended',
    'builtin-chatanki_start',
    'builtin-chatanki_status',
    'builtin-chatanki_sync',
    'builtin-chatanki_transform',
    'builtin-chatanki_undo_last_review',
    'builtin-chatanki_undo_library_last_review',
    'builtin-chatanki_update_card',
    'builtin-chatanki_update_library_card',
    'builtin-chatanki_wait',
  ] as const;

  it('matches the explicit embedded tool manifest (list diff, no count drift)', () => {
    const embeddedNames = embedded.map((tool) => tool.name).sort();
    const manifest = [...TOOL_MANIFEST].sort();
    const missing = manifest.filter((name) => !embeddedNames.includes(name));
    const unexpected = embeddedNames.filter((name) => !manifest.includes(name as any));
    expect(missing, 'tools missing from embeddedTools').toEqual([]);
    expect(unexpected, 'tools not declared in the manifest').toEqual([]);
    expect(embeddedNames).toEqual(manifest);
  });

  // --------------------------------------------------------------------
  // run：全部调优参数（类型 / enum / 边界）与 Rust ChatAnkiRunArgs 同源
  // --------------------------------------------------------------------

  it('exposes every ChatAnkiRunArgs field on the run schema with exact camelCase names', () => {
    const props = schemaOf('builtin-chatanki_run').properties;
    // Rust ChatAnkiRunArgs 的完整字段集（serde camelCase）
    expect(Object.keys(props).sort()).toEqual(
      [
        'goal',
        'content',
        'route',
        'resourceId',
        'resourceIds',
        'templateId',
        'templateIds',
        'templateMode',
        'deckName',
        'noteType',
        'maxCards',
        'extraRequirements',
        'outputProtocol',
        'visualHint',
        'contentFormat',
        'enableQaPass',
        'enableCriticPass',
        'enableFsrsFeedback',
        'maxImages',
        'enablePreferenceMemory',
        'debug',
      ].sort(),
    );
  });

  it('locks outputProtocol enum to the backend acceptance set on run and start', () => {
    // normalize_output_protocol_arg：auto|空 → None；delimiter/json_object/json_schema 透传；
    // 其余启动前报错。schema enum 与后端接受集一字不差。
    const backendAccepted = ['auto', 'delimiter', 'json_object', 'json_schema'];
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const prop = schemaOf(name).properties.outputProtocol;
      expect(prop.type, name).toBe('string');
      expect(prop.enum, name).toEqual(backendAccepted);
      // 非法值由后端拒绝（不静默回退）——纪律必须写进模型可见的描述
      expect(prop.description, name).toContain('拒绝');
      expect(prop.description, name).not.toContain('回退成 delimiter。');
    }
  });

  it('rejects non-canonical outputProtocol values in both public schemas', () => {
    const invalidValues = ['json', 'object', 'json-schema', 'yaml', 'DELIMITER'];
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const accepted = schemaOf(name).properties.outputProtocol.enum as string[];
      for (const invalid of invalidValues) {
        expect(accepted, `${name} must reject outputProtocol=${invalid}`).not.toContain(invalid);
      }
    }
  });

  it('locks contentFormat enum and default to ChatAnkiContentFormat', () => {
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const prop = schemaOf(name).properties.contentFormat;
      expect(prop.type, name).toBe('string');
      expect(prop.enum, name).toEqual(['auto', 'glossary', 'prose']);
      expect(prop.default, name).toBe('auto');
      expect(prop.enum, `${name} must reject unknown content formats`).not.toContain('markdown');
    }
  });

  it('types the default-on boolean switches on run and start', () => {
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const props = schemaOf(name).properties;
      for (const key of ['enableQaPass', 'enablePreferenceMemory']) {
        expect(props[key]?.type, `${name}.${key}`).toBe('boolean');
        // 默认开启的语义必须写进描述，防止 Agent 无理由关闭
        expect(props[key]?.description, `${name}.${key}`).toContain('默认 true');
      }
    }
  });

  it('exposes enableFsrsFeedback as a default-off switch requiring explicit user authorization', () => {
    // 0824 隐私收口：复习画像会随生成请求发送到所配置的模型端点，
    // 缺省必须关闭；描述必须让 Agent 知道只有用户明确授权才可传 true。
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const prop = schemaOf(name).properties.enableFsrsFeedback;
      expect(prop?.type, `${name}.enableFsrsFeedback`).toBe('boolean');
      expect(prop?.description, `${name}.enableFsrsFeedback`).toContain('默认 false');
      expect(prop?.description, `${name}.enableFsrsFeedback`).toContain('授权');
      expect(prop?.description, `${name}.enableFsrsFeedback`).not.toContain('默认 true');
    }
  });

  it('exposes enableCriticPass as a default-off boolean on run and start', () => {
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const prop = schemaOf(name).properties.enableCriticPass;
      expect(prop?.type, `${name}.enableCriticPass`).toBe('boolean');
      expect(prop?.default, `${name}.enableCriticPass`).toBe(false);
      expect(prop?.description, `${name}.enableCriticPass`).toContain('默认 false');
      expect(prop?.description, `${name}.enableCriticPass`).toContain('质检/复审/critic');
    }
  });

  it('rejects non-boolean enableCriticPass values in both public schemas', () => {
    const invalidValues = ['true', 'false', 1, 0, null, {}, []];
    for (const name of ['builtin-chatanki_run', 'builtin-chatanki_start']) {
      const prop = schemaOf(name).properties.enableCriticPass;
      for (const invalid of invalidValues) {
        const accepted = prop.type === 'boolean' && typeof invalid === 'boolean';
        expect(accepted, `${name} must reject enableCriticPass=${JSON.stringify(invalid)}`).toBe(
          false,
        );
      }
    }
  });

  it('keeps the critic switch limited to allowlisted run/start entry points', () => {
    const allowed = chatAnkiSkill.allowedTools ?? [];
    const criticTools = embedded
      .filter((tool) => (tool.inputSchema as any)?.properties?.enableCriticPass)
      .map((tool) => tool.name)
      .sort();

    expect(criticTools).toEqual(['builtin-chatanki_run', 'builtin-chatanki_start']);
    for (const name of criticTools) {
      expect(allowed, `${name} must remain in the ChatAnki allowlist`).toContain(name);
    }
  });

  it('bounds maxImages to the Rust MAX_VLM_IMAGES clamp window (run only)', () => {
    const prop = schemaOf('builtin-chatanki_run').properties.maxImages;
    expect(prop.type).toBe('integer');
    expect(prop.minimum).toBe(1);
    expect(prop.maximum).toBe(12);
    // 路由默认（light 6 / full 12）写进描述
    expect(prop.description).toContain('vlm_light 6');
    expect(prop.description).toContain('vlm_full 12');
  });

  it('scopes visualHint to run + VLM routes and keeps it a plain string', () => {
    const prop = schemaOf('builtin-chatanki_run').properties.visualHint;
    expect(prop.type).toBe('string');
    // 数据注入（非指令）与 simple_text 不生效的边界必须可见
    expect(prop.description).toContain('VLM');
    expect(prop.description).toContain('不是指令');
    expect(prop.description).toContain('simple_text');
  });

  // --------------------------------------------------------------------
  // start：纯文本路径不得虚构 VLM/路由/资源参数
  // --------------------------------------------------------------------

  it('keeps start free of route/resource/VLM-only params, mirroring ChatAnkiStartArgs', () => {
    const props = schemaOf('builtin-chatanki_start').properties;
    for (const key of ['route', 'resourceId', 'resourceIds', 'visualHint', 'maxImages']) {
      expect(props[key], `start must not expose ${key}`).toBeUndefined();
    }
    // Rust ChatAnkiStartArgs 的完整字段集（serde camelCase）
    expect(Object.keys(props).sort()).toEqual(
      [
        'goal',
        'content',
        'templateId',
        'templateIds',
        'templateMode',
        'deckName',
        'noteType',
        'maxCards',
        'extraRequirements',
        'outputProtocol',
        'contentFormat',
        'enableQaPass',
        'enableCriticPass',
        'enableFsrsFeedback',
        'enablePreferenceMemory',
        'debug',
      ].sort(),
    );
  });

  it('mirrors every ChatAnkiAnalyzeArgs wire field and effective source requirement', () => {
    const schema = schemaOf('builtin-chatanki_analyze');
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['content', 'goal', 'route', 'resourceId', 'resourceIds'].sort(),
    );
    expect(schema.anyOf).toEqual([
      { required: ['content'] },
      { required: ['resourceIds'] },
      { required: ['resourceId'] },
    ]);
    expect(schema.properties.content).toMatchObject({ minLength: 1, pattern: '\\S' });
    expect(schema.properties.resourceId).toMatchObject({ minLength: 1, pattern: '\\S' });
    expect(schema.properties.resourceIds).toMatchObject({ minItems: 1 });
    expect(schema.properties.resourceIds.items).toMatchObject({ minLength: 1, pattern: '\\S' });
    expect(schema.additionalProperties).toBe(false);
  });

  it('mirrors every ChatAnkiTransformArgs and ChatAnkiRetemplateArgs wire field', () => {
    expect(Object.keys(schemaOf('builtin-chatanki_transform').properties).sort()).toEqual(
      ['documentId', 'selection', 'mode', 'transform', 'expectedVersions', 'purpose'].sort(),
    );
    expect(Object.keys(schemaOf('builtin-chatanki_retemplate').properties).sort()).toEqual(
      ['documentId', 'cardIds', 'targetTemplateId', 'strategy', 'expectedVersions'].sort(),
    );
  });

  // --------------------------------------------------------------------
  // additionalProperties / required：调优参数全部可选，未知旋钮直接拦下
  // --------------------------------------------------------------------

  it('closes run and start schemas so invented knobs (e.g. temperature) are rejected', () => {
    const run = schemaOf('builtin-chatanki_run');
    const start = schemaOf('builtin-chatanki_start');
    expect(run.additionalProperties).toBe(false);
    expect(start.additionalProperties).toBe(false);
    // analyze 的管线内自算参数不得混进 run/start
    for (const knob of [
      'temperature',
      'segmentOverlapSize',
      'maxOutputTokensOverride',
      'pipelineDefaultMaxCards',
    ]) {
      expect(run.properties[knob], `run.${knob}`).toBeUndefined();
      expect(start.properties[knob], `start.${knob}`).toBeUndefined();
    }
  });

  it('keeps required sets unchanged: tuning knobs are all optional', () => {
    const runRequired = schemaOf('builtin-chatanki_run').required;
    const startRequired = schemaOf('builtin-chatanki_start').required;
    expect(runRequired).toEqual(['goal', 'maxCards', 'templateMode']);
    expect(startRequired).toEqual([
      'goal',
      'content',
      'maxCards',
      'templateMode',
    ]);
    expect(runRequired).not.toContain('enableCriticPass');
    expect(startRequired).not.toContain('enableCriticPass');
  });

  // --------------------------------------------------------------------
  // skill content：参数选用指南（extraRequirements vs visualHint vs
  // contentFormat vs outputProtocol）必须写进提示词
  // --------------------------------------------------------------------

  it('teaches the knob-selection guide in the skill content', () => {
    const content = chatAnkiSkill.content ?? '';
    expect(content).toContain('生成调优参数');
    // 四个易混参数的判别都必须出现在指南里
    for (const knob of ['extraRequirements', 'visualHint', 'contentFormat', 'outputProtocol']) {
      expect(content, knob).toContain(knob);
    }
    // 分工口径：风格/语言 → extraRequirements；看图重点 → visualHint；
    // 体裁 → contentFormat；协议排障 → outputProtocol
    expect(content).toContain('卡片长什么样');
    expect(content).toContain('看图看哪里');
    expect(content).toContain('材料是什么体裁');
    expect(content).toContain('非法值会被后端在启动前直接拒绝');
    // 默认开启的开关不得由 Agent 自行关闭
    expect(content).toContain('禁止自行关闭');
    // critic 是唯一默认关闭的生成后 LLM 复审；不得由 Agent 自行开启
    expect(content).toContain('enableCriticPass');
    expect(content).toContain('仅当用户明确要求“质检/复审/critic”时才传 true');
    // start 没有 VLM 专属参数的边界也要可见（仅 run + VLM 路由）
    expect(content).toContain('仅 run + VLM 路由');
  });

  it('advertises the tuning knobs in the run/start tool descriptions', () => {
    const runDesc = findTool('builtin-chatanki_run')?.description ?? '';
    const startDesc = findTool('builtin-chatanki_start')?.description ?? '';
    for (const knob of ['outputProtocol', 'contentFormat', 'enableQaPass', 'enableCriticPass']) {
      expect(runDesc, `run description mentions ${knob}`).toContain(knob);
      expect(startDesc, `start description mentions ${knob}`).toContain(knob);
    }
    expect(runDesc).toContain('默认关闭');
    expect(startDesc).toContain('默认关闭');
    expect(runDesc).toContain('visualHint');
    expect(runDesc).toContain('maxImages');
    // start 明确声明不接受 VLM/路由参数
    expect(startDesc).toContain('不接受 route');
  });
});

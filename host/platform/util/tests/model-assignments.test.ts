/**
 * `crates/dstu-core/src/models.rs::tests` 的 L02 生产入口测试。
 *
 * `ModelAssignments` 的 legacy serde 缺省由 L02 `ctx.llm.getModelAssignments()` 读取
 * `model_assignments` 设置时经 `modelAssignmentsFromDe` 补全；F4 不复制 L02 实现。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { tokenizer } from '../../native/tokenizer/index.ts';
import { image } from '../../native/image/index.ts';
import llmPlugin from '../../../plugins/llm/index.ts';

let host: TestHost | null = null;

afterEach(async () => {
  await host?.dispose();
  host = null;
});

describe('dstu-core models.rs::tests', () => {
  it('image_generation_model_assignment_defaults_for_legacy_payload', async () => {
    const legacy = '{"model2_config_id":null,"review_analysis_model_config_id":null}';
    const created = await createTestHost({
      plugins: [llmPlugin],
      provide: {
        settings: {
          get: (key: string) => (key === 'model_assignments' ? legacy : null),
          save: () => undefined,
        },
        secrets: {
          isEncryptedFormat: () => false,
          openCrypto: async () => { throw new Error('crypto unused in this test'); },
        },
        vfsDatabase: {},
        vfsRepo: { essays: {} },
        llmAdapters: {},
        nativeTokenizer: tokenizer,
        nativeImage: image,
        // L02 index.ts:78 inject 后新增；getModelAssignments 只读 settings，不触达这两个服务。
        injectionBudget: {},
        llmCodexAuth: {},
      },
    });
    host = created;

    const assignments = await created.ctx.llm.getModelAssignments();
    // Rust: serde 缺省让 legacy payload 的 image_generation_model_config_id 为 None。
    expect(assignments.image_generation_model_config_id).toBeNull();
    expect(assignments.model2_config_id).toBeNull();
    expect(assignments.review_analysis_model_config_id).toBeNull();
  });
});

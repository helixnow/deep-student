/**
 * buildResolvedConfigs 的多模态嵌入能力推断必须与后端运行期一致。
 *
 * 后端 `get_api_configs()` 对「嵌入模型 + 非重排 + 名称含 VL/vision/clip 等信号」的
 * 配置会强制 `is_multimodal = true`（`llm_manager::looks_like_multimodal_embedding`）。
 * `resolvedApiConfigs` 若只回显落库值，同一个模型就会在「模型服务」页显示未勾选多模态、
 * 在「模型分配」页按多模态处理——用户只能靠手动补勾（而写入其实由导入/编辑路径决定）。
 */
import { describe, expect, it } from 'vitest';

import type { ModelProfile, VendorConfig } from '@/types';
import { buildResolvedConfigs } from '../useVendorModels';

const vendor: VendorConfig = {
  id: 'vendor-relay',
  name: '自定义中转站',
  providerType: 'custom',
  baseUrl: 'https://api.example.invalid/v1',
  apiKey: 'sk-test',
};

const profile = (over: Partial<ModelProfile>): ModelProfile => ({
  id: 'profile-1',
  vendorId: vendor.id,
  label: 'model',
  model: 'model',
  modelAdapter: 'openai',
  status: 'enabled',
  enabled: true,
  isMultimodal: false,
  isReasoning: false,
  isEmbedding: false,
  isReranker: false,
  supportsTools: false,
  ...over,
});

const resolveOne = (over: Partial<ModelProfile>) =>
  buildResolvedConfigs([vendor], [profile(over)])[0];

describe('buildResolvedConfigs · 多模态嵌入推断', () => {
  it('VL 嵌入模型即使落库未勾多模态，也按多模态嵌入暴露', () => {
    const config = resolveOne({
      model: 'Qwen/Qwen3-VL-Embedding-8B',
      label: 'Qwen3-VL-Embedding-8B',
      isEmbedding: true,
    });
    expect(config.isMultimodal).toBe(true);
    expect(config.isEmbedding).toBe(true);
  });

  it('纯文本嵌入模型不受影响', () => {
    const config = resolveOne({ model: 'BAAI/bge-m3', label: 'bge-m3', isEmbedding: true });
    expect(config.isMultimodal).toBe(false);
    expect(config.isEmbedding).toBe(true);
  });

  it('重排模型不会被推断成多模态嵌入', () => {
    const config = resolveOne({
      model: 'Qwen/Qwen3-VL-Reranker-8B',
      label: 'Qwen3-VL-Reranker-8B',
      isReranker: true,
    });
    expect(config.isMultimodal).toBe(false);
    expect(config.isReranker).toBe(true);
  });

  it('非嵌入模型不受推断影响（不因名称含 vl 就被改标）', () => {
    const config = resolveOne({ model: 'Qwen/Qwen3-VL-8B-Instruct', label: 'Qwen3-VL-8B-Instruct' });
    expect(config.isMultimodal).toBe(false);
  });

  it('落库已勾多模态的配置保持为真', () => {
    const config = resolveOne({
      model: 'custom-vision-embed',
      label: 'custom-vision-embed',
      isEmbedding: true,
      isMultimodal: true,
    });
    expect(config.isMultimodal).toBe(true);
  });
});

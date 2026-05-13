import { describe, expect, it } from 'vitest';
import { shouldLockDeepSeekV4SamplingControls } from '../deepseekSamplingControls';

describe('DeepSeek V4 sampling-control UI guard', () => {
  it('locks official DeepSeek V4 sampling controls while thinking is active', () => {
    expect(
      shouldLockDeepSeekV4SamplingControls({
        model: 'deepseek-v4-pro',
        providerType: 'deepseek',
        providerScope: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        enableThinking: true,
      })
    ).toBe(true);
  });

  it('does not lock official V4 sampling controls when thinking is disabled', () => {
    expect(
      shouldLockDeepSeekV4SamplingControls({
        model: 'deepseek-v4-pro',
        providerType: 'deepseek',
        providerScope: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        enableThinking: false,
      })
    ).toBe(false);
  });

  it('locks future SiliconFlow DeepSeek V4 sampling controls while thinking is active', () => {
    expect(
      shouldLockDeepSeekV4SamplingControls({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        providerType: 'siliconflow',
        providerScope: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        enableThinking: true,
      })
    ).toBe(true);
  });

  it('does not lock SiliconFlow V3.2 sampling controls', () => {
    expect(
      shouldLockDeepSeekV4SamplingControls({
        model: 'deepseek-ai/DeepSeek-V3.2',
        providerType: 'siliconflow',
        providerScope: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        enableThinking: true,
      })
    ).toBe(false);
  });
});

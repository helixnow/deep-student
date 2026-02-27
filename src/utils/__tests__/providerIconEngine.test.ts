/**
 * 供应商图标引擎测试
 * Provider Icon Engine Tests
 */

import { describe, it, expect } from 'vitest';
import { detectProviderBrand, getProviderInfo, getProviderIcon } from '../providerIconEngine';

describe('ProviderIconEngine', () => {
  describe('detectProviderBrand - 国际供应商', () => {
    it('应该正确识别 OpenAI 模型', () => {
      expect(detectProviderBrand('gpt-4o')).toBe('openai');
      expect(detectProviderBrand('gpt-4')).toBe('openai');
      expect(detectProviderBrand('gpt-3.5-turbo')).toBe('openai');
      expect(detectProviderBrand('o1-preview')).toBe('openai');
      expect(detectProviderBrand('dall-e-3')).toBe('openai');
      expect(detectProviderBrand('text-embedding-ada-002')).toBe('openai');
    });

    it('应该正确识别 Anthropic 模型', () => {
      expect(detectProviderBrand('claude-3-opus')).toBe('anthropic');
      expect(detectProviderBrand('claude-sonnet-4')).toBe('anthropic');
      expect(detectProviderBrand('claude-haiku-4')).toBe('anthropic');
    });

    it('应该正确识别 Google 模型', () => {
      expect(detectProviderBrand('gemini-2.0-flash')).toBe('google');
      expect(detectProviderBrand('gemini-pro')).toBe('google');
      expect(detectProviderBrand('gemma-3')).toBe('google');
    });

    it('应该正确识别 Meta 模型', () => {
      expect(detectProviderBrand('llama-3.1-70b')).toBe('meta');
      expect(detectProviderBrand('meta-llama/Llama-3.2')).toBe('meta');
    });

    it('应该正确识别 Mistral 模型', () => {
      expect(detectProviderBrand('mistral-large')).toBe('mistral');
      expect(detectProviderBrand('mixtral-8x7b')).toBe('mistral');
      expect(detectProviderBrand('pixtral-12b')).toBe('mistral');
    });

    it('应该正确识别 xAI (Grok) 模型', () => {
      expect(detectProviderBrand('grok-2')).toBe('xai');
      expect(detectProviderBrand('grok-vision-beta')).toBe('xai');
    });
  });

  describe('detectProviderBrand - 中国供应商', () => {
    it('应该正确识别 DeepSeek 模型', () => {
      expect(detectProviderBrand('deepseek-v3.1')).toBe('deepseek');
      expect(detectProviderBrand('deepseek-ai/DeepSeek-V3.1')).toBe('deepseek');
      expect(detectProviderBrand('deepseek-r1')).toBe('deepseek');
    });

    it('应该正确识别 Qwen 模型', () => {
      expect(detectProviderBrand('qwen3-8b')).toBe('qwen');
      expect(detectProviderBrand('Qwen/Qwen2.5-VL-32B-Instruct')).toBe('qwen');
      expect(detectProviderBrand('qwq-32b')).toBe('qwen');
      expect(detectProviderBrand('qvq-72b')).toBe('qwen');
      expect(detectProviderBrand('codeqwen1.5-7b-chat')).toBe('qwen');
      expect(detectProviderBrand('deepseek-r1-distill-qwen-14b')).toBe('qwen');
      expect(detectProviderBrand('deepseek-r1-distill-qwen-1.5b')).toBe('qwen');
      expect(detectProviderBrand('deepseek-r1-distill-qwen-32b')).toBe('qwen');
    });

    it('应该正确识别智谱 (GLM) 模型', () => {
      expect(detectProviderBrand('glm-4.5')).toBe('zhipu');
      expect(detectProviderBrand('THUDM/GLM-4.1V-9B-Thinking')).toBe('zhipu');
      expect(detectProviderBrand('zai-org/GLM-4.6V')).toBe('zhipu');
      expect(detectProviderBrand('chatglm3')).toBe('zhipu');
    });

    it('应该正确识别豆包 (Doubao) 模型', () => {
      expect(detectProviderBrand('doubao-1.5-pro')).toBe('bytedance');
      expect(detectProviderBrand('seed-oss')).toBe('bytedance');
    });

    it('应该正确识别腾讯混元模型', () => {
      expect(detectProviderBrand('hunyuan-pro')).toBe('tencent');
      expect(detectProviderBrand('hunyuan-t1')).toBe('tencent');
    });

    it('应该正确识别月之暗面 (Moonshot/Kimi) 模型', () => {
      expect(detectProviderBrand('moonshot-v1')).toBe('moonshot');
      expect(detectProviderBrand('kimi-k2')).toBe('moonshot');
    });

    it('应该正确识别百度文心模型', () => {
      expect(detectProviderBrand('ernie-4.0')).toBe('baidu');
      expect(detectProviderBrand('wenxin')).toBe('baidu');
    });

    it('应该正确识别讯飞星火模型', () => {
      expect(detectProviderBrand('spark-v3.5')).toBe('xfyun');
    });

    it('应该正确识别MiniMax模型', () => {
      expect(detectProviderBrand('minimax-text-01')).toBe('minimax');
    });

    it('应该正确识别零一万物模型', () => {
      expect(detectProviderBrand('yi-34b-chat')).toBe('01ai');
      expect(detectProviderBrand('01ai/Yi-1.5')).toBe('01ai');
    });
  });

  describe('detectProviderBrand - 图像/视频生成', () => {
    it('应该正确识别 Midjourney 模型', () => {
      expect(detectProviderBrand('midjourney-v6')).toBe('midjourney');
    });

    it('应该正确识别 Flux 模型', () => {
      expect(detectProviderBrand('flux-1-pro')).toBe('flux');
      expect(detectProviderBrand('flux-schnell')).toBe('flux');
    });

    it('应该正确识别 Stability AI 模型', () => {
      expect(detectProviderBrand('stable-diffusion-xl')).toBe('stability');
      expect(detectProviderBrand('sd-3.0')).toBe('stability');
    });

    it('应该正确识别可灵 (Kling) 模型', () => {
      expect(detectProviderBrand('kling-v1')).toBe('kuaishou');
    });
  });

  describe('detectProviderBrand - 带平台前缀的模型名', () => {
    it('应该正确处理 SiliconFlow 格式的模型名', () => {
      expect(detectProviderBrand('SiliconFlow - Qwen/Qwen3-8B')).toBe('qwen');
      expect(detectProviderBrand('SiliconFlow - deepseek-ai/DeepSeek-V3.1')).toBe('deepseek');
      expect(detectProviderBrand('SiliconFlow - zai-org/GLM-4.6V')).toBe('zhipu');
    });

    it('应该正确处理带组织名的模型ID', () => {
      expect(detectProviderBrand('Pro/deepseek-ai/DeepSeek-V3.1-Terminus')).toBe('deepseek');
      expect(detectProviderBrand('Qwen/Qwen2.5-VL-32B-Instruct')).toBe('qwen');
    });
  });

  describe('getProviderInfo', () => {
    it('应该返回完整的供应商信息', () => {
      const info = getProviderInfo('deepseek-v3.1');
      expect(info.brand).toBe('deepseek');
      expect(info.displayName).toBe('DeepSeek');
      expect(info.iconPath).toBe('/icons/providers/deepseek.svg');
      expect(info.category).toBe('chat');
    });

    it('应该正确推断嵌入模型类别', () => {
      const info = getProviderInfo('text-embedding-3-large');
      expect(info.category).toBe('embedding');
    });

    it('应该正确推断图像模型类别', () => {
      const info = getProviderInfo('flux-1-pro');
      expect(info.category).toBe('image');
    });
  });

  describe('getProviderIcon', () => {
    it('应该返回正确的图标路径', () => {
      expect(getProviderIcon('gpt-4o')).toBe('/icons/providers/openai.svg');
      expect(getProviderIcon('claude-3-opus')).toBe('/icons/providers/anthropic.svg');
      expect(getProviderIcon('gemini-2.0')).toBe('/icons/providers/gemini.svg');
      expect(getProviderIcon('deepseek-v3.1')).toBe('/icons/providers/deepseek.svg');
    });

    it('未识别的模型应该返回 generic 图标路径', () => {
      expect(getProviderIcon('unknown-model-xyz')).toBe('/icons/providers/generic.svg');
    });
  });

  describe('特殊映射', () => {
    it('零一万物应该映射到yi图标', () => {
      expect(getProviderIcon('yi-34b-chat')).toBe('/icons/providers/yi.svg');
    });

    it('xAI应该映射到grok图标', () => {
      expect(getProviderIcon('grok-2')).toBe('/icons/providers/grok.svg');
    });

    it('字节跳动应该映射到doubao图标', () => {
      expect(getProviderIcon('doubao-pro')).toBe('/icons/providers/doubao.svg');
    });

    it('阿里云应该映射到bailian图标', () => {
      expect(getProviderIcon('tongyi-xiaomi-analysis-flash')).toBe('/icons/providers/bailian.svg');
    });

    it('智谱AI应该使用zhipu图标', () => {
      expect(getProviderIcon('glm-4.5')).toBe('/icons/providers/zhipu.svg');
    });
  });
});






/**
 * 供应商图标匹配引擎
 * Provider Icon Engine
 * 
 * 基于模型ID/名称识别AI模型供应商，返回对应的品牌图标
 * 注意：这里识别的是模型的真实供应商（如OpenAI、DeepSeek、Qwen），
 * 而不是API平台提供商（如SiliconFlow、Together等）
 */

export type ProviderBrand =
  // 国际供应商
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'meta'
  | 'mistral'
  | 'xai'
  | 'microsoft'
  // 中国供应商
  | 'deepseek'
  | 'qwen'       // 阿里通义千问
  | 'alibaba'    // 阿里云百炼
  | 'bytedance'  // 字节豆包
  | 'zhipu'      // 智谱AI
  | 'tencent'    // 腾讯混元
  | 'moonshot'   // 月之暗面(Kimi)
  | 'kuaishou'   // 快手(可灵)
  | 'baidu'      // 百度文心
  | 'xfyun'      // 讯飞星火
  | 'senseTime'  // 商汤
  | 'minimax'    // MiniMax
  | '01ai'       // 零一万物
  | 'baichuan'   // 百川智能
  | 'stepfun'    // 阶跃星辰
  | 'baai'       // 北京智源
  | 'internlm'   // 书生·浦语
  | 'youdao'     // 网易有道
  | 'antling'    // 蚂蚁百灵
  | 'teleai'     // 电信TeleAI
  | 'kwaipilot'  // Kwaipilot
  // 图像/视频生成
  | 'midjourney'
  | 'stability'  // Stable Diffusion
  | 'runway'
  | 'luma'
  | 'pika'
  | 'flux'
  | 'ideogram'
  | 'fal'
  | 'replicate'
  // 音频生成
  | 'suno'
  | 'udio'
  // 其他
  | 'ollama'
  | 'siliconflow' // 硅基流动（作为中转平台，显示其logo）
  | 'huggingface'
  | 'together'
  | 'perplexity'
  | 'generic';  // 通用/未识别

export interface ProviderInfo {
  brand: ProviderBrand;
  iconPath: string;
  displayName: string;
  category: 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'reranker' | 'other';
}

const toLower = (s: string | undefined | null): string => (s ?? '').toLowerCase();

/**
 * 供应商识别规则
 * 按优先级排序：精确匹配 > 组织名匹配 > 模型名特征匹配
 */
const PROVIDER_PATTERNS: Record<ProviderBrand, (string | RegExp)[]> = {
  // === 国际供应商 ===
  openai: [
    /^openai\//i,
    /^gpt-/i,
    /^o1-/i, /^o3-/i, /^o4-/i,
    /\bgpt-[345]/i,
    /\bgpt-4o/i,
    /\bgpt-5/i,
    /\bgpt-oss/i,
    /\bcodex-mini/i,
    /dall-e/i,
    /text-embedding-/i,
    'chatgpt',
  ],
  
  anthropic: [
    /^anthropic\//i,
    /claude/i,
    'haiku', 'sonnet', 'opus',
  ],
  
  google: [
    /^google\//i,
    /gemini/i,
    /\bgemma/i,
    'learnlm',
    'palm',
  ],
  
  meta: [
    /^meta\//i,
    /^meta-llama\//i,
    /llama-[23]/i,
    /llama-guard/i,
  ],
  
  mistral: [
    /^mistral/i,
    /pixtral/i,
    'mixtral',
  ],
  
  xai: [
    /^xai\//i,
    /grok/i,
  ],
  
  microsoft: [
    /^microsoft\//i,
    /phi-[234]/i,
    'azure',
  ],
  
  // === 中国供应商 ===
  // qwen 必须在 deepseek 之前，以便 deepseek-r1-distill-qwen-* 优先匹配为 qwen
  qwen: [
    /^qwen\//i,
    /qwen\d/i,    // qwen1/qwen2/qwen3/codeqwen1.5 等所有版本
    /qwen-/i,
    /qwenlong/i,  // QwenLong 系列
    /qwq/i,
    /qvq/i,
    /^wan-?ai\//i,  // Wan视频模型（通义系列）
    /wan2\./i,      // Wan2.x 系列
  ],
  
  deepseek: [
    /deepseek/i,
    /^deepseek-ai\//i,
  ],
  
  alibaba: [
    /^alibaba\//i,
    'bailian',
    'tongyi',
  ],
  
  bytedance: [
    /^bytedance\//i,
    /doubao/i,
    /豆包/,
    /seed-/i,
  ],
  
  zhipu: [
    /^zhipu/i,
    /^thudm\//i,
    /glm-/i,
    /chatglm/i,
    /cogvideo/i,
    /cogview/i,
  ],
  
  tencent: [
    /^tencent\//i,
    /hunyuan/i,
    /混元/,
  ],
  
  baai: [
    /^baai\//i,
    /bge-/i,
    /智源/,
  ],
  
  moonshot: [
    /moonshot/i,
    /kimi/i,
    /月之暗面/,
  ],
  
  kuaishou: [
    /^kuaishou\//i,
    /kling/i,
    /可灵/,
  ],
  
  baidu: [
    /^baidu\//i,
    /^paddlepaddle\//i, // PaddlePaddle 为百度旗下开源平台
    /ernie/i,
    /wenxin/i,
    /文心/,
  ],
  
  xfyun: [
    /^xfyun\//i,
    /^iflytek\//i,
    /spark/i,
    /星火/,
  ],
  
  senseTime: [
    /^sensetime\//i,
    /sensenova/i,
    /商汤/,
  ],
  
  minimax: [
    /minimax/i,
  ],
  
  '01ai': [
    /^01ai\//i,
    /^01-ai\//i,
    /^zero-?one/i,
    /yi-/i,
  ],
  
  baichuan: [
    /baichuan/i,
    /百川/,
  ],
  
  stepfun: [
    /^stepfun\//i,
    /step-/i,
    /阶跃星辰/,
  ],
  
  internlm: [
    /internlm/i,
    /^internlm\//i,
    /书生/,
    /浦语/,
  ],
  
  youdao: [
    /^youdao\//i,
    /youdao/i,
    /^netease\//i,
    /有道/,
    /网易有道/,
  ],
  
  antling: [
    /^antgroup\//i,
    /^inclusionai\//i, // inclusionAI 即蚂蚁百灵
    /百灵/,
    /ling\//i,
    /ant-?ling/i,
  ],
  
  teleai: [
    /^teleai\//i,
    /teleai/i,
    /电信/,
    /chinatele/i,
  ],
  
  kwaipilot: [
    /kwaipilot/i,
    /快手pilot/,
  ],
  
  // === 图像/视频生成 ===
  midjourney: [
    /midjourney/i,
    /mj-/i,
  ],
  
  stability: [
    /stability/i,
    /stable-?diffusion/i,
    /sd-/i,
    /sdxl/i,
  ],
  
  runway: [
    /runway/i,
    /gen-[123]/i,
  ],
  
  luma: [
    /luma/i,
    /dream-?machine/i,
  ],
  
  pika: [
    /pika/i,
  ],
  
  flux: [
    /flux/i,
    /black-?forest/i,
  ],
  
  ideogram: [
    /ideogram/i,
  ],
  
  fal: [
    /^fal\//i,
    /fal-ai/i,
  ],
  
  replicate: [
    /replicate/i,
  ],
  
  // === 音频生成 ===
  suno: [
    /suno/i,
  ],
  
  udio: [
    /udio/i,
  ],
  
  // === 其他 ===
  ollama: [
    /ollama/i,
  ],
  
  siliconflow: [
    /siliconflow/i,
    /硅基流动/,
  ],
  
  huggingface: [
    /^huggingface\//i,
    /^hf\//i,
  ],
  
  together: [
    /together/i,
  ],
  
  perplexity: [
    /perplexity/i,
    /sonar/i,
  ],
  
  generic: [],
};

/**
 * 供应商显示名称映射
 */
const PROVIDER_DISPLAY_NAMES: Record<ProviderBrand, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  meta: 'Meta',
  mistral: 'Mistral AI',
  xai: 'xAI',
  microsoft: 'Microsoft',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  alibaba: '阿里云',
  bytedance: '字节跳动',
  zhipu: '智谱AI',
  tencent: '腾讯',
  moonshot: '月之暗面',
  kuaishou: '快手',
  baidu: '百度',
  xfyun: '讯飞',
  senseTime: '商汤',
  minimax: 'MiniMax',
  '01ai': '零一万物',
  baichuan: '百川智能',
  stepfun: '阶跃星辰',
  baai: '智源研究院',
  internlm: '书生·浦语',
  youdao: '网易有道',
  antling: '蚂蚁百灵',
  teleai: '电信TeleAI',
  kwaipilot: 'Kwaipilot',
  midjourney: 'Midjourney',
  stability: 'Stability AI',
  runway: 'Runway',
  luma: 'Luma AI',
  pika: 'Pika',
  flux: 'Flux',
  ideogram: 'Ideogram',
  fal: 'Fal.ai',
  replicate: 'Replicate',
  suno: 'Suno',
  udio: 'Udio',
  ollama: 'Ollama',
  siliconflow: 'SiliconFlow',
  huggingface: 'Hugging Face',
  together: 'Together AI',
  perplexity: 'Perplexity',
  generic: 'Unknown',
};

/**
 * 图标路径映射
 */
function getIconPath(brand: ProviderBrand): string {
  // 特殊映射
  const iconMap: Record<string, string> = {
    '01ai': 'yi',           // 零一万物使用yi图标
    xai: 'grok',            // xAI使用grok图标
    google: 'gemini',       // Google使用gemini图标
    bytedance: 'doubao',    // 字节跳动使用豆包图标
    kuaishou: 'kling',      // 快手使用可灵图标
    baidu: 'wenxin',        // 百度使用文心图标
    tencent: 'hunyuan',     // 腾讯使用混元图标
    xfyun: 'spark',         // 讯飞使用星火图标
    senseTime: 'sensenova', // 商汤使用sensenova图标
    microsoft: 'azure',     // Microsoft使用azure图标
    antling: 'ling',        // 蚂蚁百灵使用ling图标
    siliconflow: 'siliconcloud', // 硅基流动使用siliconcloud图标
    alibaba: 'bailian',     // 阿里云使用百炼图标
  };
  
  const iconName = iconMap[brand] || brand;
  
  // PNG 图标的特殊映射（大部分为 SVG）
  const pngIcons = new Set(['ling']);
  const ext = pngIcons.has(iconName) ? 'png' : 'svg';
  
  return `/icons/providers/${iconName}.${ext}`;
}

/**
 * 根据模型ID/名称识别供应商
 * 
 * @param modelIdOrName - 模型ID或名称，如 "deepseek-ai/DeepSeek-V3.1" 或 "SiliconFlow - Qwen/Qwen3-8B"
 * @returns 供应商品牌标识
 */
export function detectProviderBrand(modelIdOrName: string): ProviderBrand {
  if (!modelIdOrName) return 'generic';
  
  const input = toLower(modelIdOrName);
  
  // 先移除可能的API平台前缀（如 "SiliconFlow - "），只保留模型ID部分
  const cleanedInput = input.replace(/^[^-]+-\s*/, '');
  
  // 按优先级遍历所有供应商规则
  for (const [brand, patterns] of Object.entries(PROVIDER_PATTERNS) as [ProviderBrand, (string | RegExp)[]][]) {
    for (const pattern of patterns) {
      if (typeof pattern === 'string') {
        if (cleanedInput.includes(pattern) || input.includes(pattern)) {
          return brand;
        }
      } else {
        // RegExp
        if (pattern.test(cleanedInput) || pattern.test(input)) {
          return brand;
        }
      }
    }
  }
  
  return 'generic';
}

/**
 * 获取完整的供应商信息
 * 
 * @param modelIdOrName - 模型ID或名称
 * @param category - 可选的模型类别，如果不提供会尝试自动推断
 * @returns 供应商完整信息
 */
export function getProviderInfo(
  modelIdOrName: string,
  category?: 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'reranker' | 'other'
): ProviderInfo {
  const brand = detectProviderBrand(modelIdOrName);
  const iconPath = getIconPath(brand);
  const displayName = PROVIDER_DISPLAY_NAMES[brand] || 'Unknown';
  
  // 如果没有提供category，尝试自动推断
  let inferredCategory: ProviderInfo['category'] = category || 'other';
  if (!category) {
    const lower = toLower(modelIdOrName);
    if (lower.includes('embedding') || lower.includes('embed') || lower.includes('bge')) {
      inferredCategory = 'embedding';
    } else if (lower.includes('rerank')) {
      inferredCategory = 'reranker';
    } else if (lower.includes('image') || lower.includes('dalle') || lower.includes('flux') || lower.includes('sd-')) {
      inferredCategory = 'image';
    } else if (lower.includes('video') || lower.includes('kling') || lower.includes('runway')) {
      inferredCategory = 'video';
    } else if (lower.includes('audio') || lower.includes('suno') || lower.includes('udio')) {
      inferredCategory = 'audio';
    } else {
      inferredCategory = 'chat';
    }
  }
  
  return {
    brand,
    iconPath,
    displayName,
    category: inferredCategory,
  };
}

/**
 * 仅获取图标路径（快捷方法）
 */
export function getProviderIcon(modelIdOrName: string): string {
  const brand = detectProviderBrand(modelIdOrName);
  return getIconPath(brand);
}

/**
 * 仅获取供应商显示名称（快捷方法）
 */
export function getProviderDisplayName(modelIdOrName: string): string {
  const brand = detectProviderBrand(modelIdOrName);
  return PROVIDER_DISPLAY_NAMES[brand] || 'Unknown';
}

/**
 * 批量获取供应商信息（用于模型列表）
 */
export function getBatchProviderInfo(modelIds: string[]): Map<string, ProviderInfo> {
  const result = new Map<string, ProviderInfo>();
  for (const modelId of modelIds) {
    result.set(modelId, getProviderInfo(modelId));
  }
  return result;
}






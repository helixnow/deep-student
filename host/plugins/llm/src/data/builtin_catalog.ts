// 自动生成，勿手改：scripts 静态目录的 Rust 目录镜像（生成于迁移，数据源见文件头）。

/** src-tauri/crates/dstu-llm/src/llm_manager/builtin_vendors.rs BUILTIN_VENDORS / BUILTIN_MODELS */
export interface BuiltinVendorDef {
  id: string; name: string; providerType: string; authMode: string | null;
  baseUrl: string; notes: string; maxTokensLimit: number | null; websiteUrl: string;
}
export interface BuiltinModelDef {
  id: string; vendorId: string; label: string; model: string;
  isMultimodal: boolean; isReasoning: boolean; supportsTools: boolean;
  maxOutputTokens: number; temperature: number;
}
export const BUILTIN_VENDORS: readonly BuiltinVendorDef[] = [
  {
    "id": "builtin-siliconflow",
    "name": "SiliconFlow",
    "providerType": "siliconflow",
    "authMode": null,
    "baseUrl": "https://api.siliconflow.cn/v1",
    "notes": "Built-in template for SiliconFlow. Please enter your API Key.",
    "maxTokensLimit": null,
    "websiteUrl": "https://cloud.siliconflow.cn/i/deadXN1B"
  },
  {
    "id": "builtin-deepseek",
    "name": "DeepSeek",
    "providerType": "deepseek",
    "authMode": null,
    "baseUrl": "https://api.deepseek.com/v1",
    "notes": "",
    "maxTokensLimit": 393216,
    "websiteUrl": "https://deepseek.com"
  },
  {
    "id": "builtin-qwen",
    "name": "通义千问",
    "providerType": "qwen",
    "authMode": null,
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "notes": "阿里云百炼 API（兼容 OpenAI Chat；平台亦支持 Responses / DashScope 原生）。推荐模型: qwen3.7-max(旗舰), qwen3.7-plus(官方默认推荐/多模态), qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen3.5-397b-a17b, qwen3.5-122b-a10b",
    "maxTokensLimit": null,
    "websiteUrl": "https://bailian.console.aliyun.com"
  },
  {
    "id": "builtin-zhipu",
    "name": "智谱AI",
    "providerType": "zhipu",
    "authMode": null,
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "notes": "智谱AI 开放平台。可用模型: glm-5.2(当前旗舰, 1M 上下文, 支持 reasoning_effort), glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.7-flash(免费)",
    "maxTokensLimit": null,
    "websiteUrl": "https://open.bigmodel.cn"
  },
  {
    "id": "builtin-doubao",
    "name": "字节豆包",
    "providerType": "doubao",
    "authMode": null,
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "notes": "火山方舟大模型平台。推荐模型: doubao-seed-2-1-pro-260628 / doubao-seed-2-1-turbo-260628 (2.1 旗舰, 256K 上下文), doubao-seed-evolving (滚动更新 ID), Seed 2.0 全系, Seed 1.8 (doubao-seed-1-8-251228)。可直接用模型名或 ep-* 接入点调用。",
    "maxTokensLimit": null,
    "websiteUrl": "https://www.volcengine.com/product/doubao"
  },
  {
    "id": "builtin-minimax",
    "name": "MiniMax",
    "providerType": "minimax",
    "authMode": null,
    "baseUrl": "https://api.minimax.io/v1",
    "notes": "MiniMax API。可用模型: MiniMax-M3(最新旗舰, 1M 上下文/多模态), MiniMax-M2.7, MiniMax-M2.5, M2.5-highspeed, M2.1",
    "maxTokensLimit": null,
    "websiteUrl": "https://platform.minimaxi.com"
  },
  {
    "id": "builtin-moonshot",
    "name": "月之暗面",
    "providerType": "moonshot",
    "authMode": null,
    "baseUrl": "https://api.moonshot.cn/v1",
    "notes": "Kimi API。可用模型: kimi-k3(1M/多模态/强制最高推理), kimi-k2.6(多模态), kimi-k2.7-code(编程/强制思考), kimi-k2.5(多模态), moonshot-v1 系列。kimi-k2 全系与 kimi-k2-thinking 已于 2026-05-25 停服、kimi-latest 已于 2026-01-28 停服。注意: K3 不接受 K2.x thinking 对象；K2.5/K2.6 采样参数锁定。",
    "maxTokensLimit": null,
    "websiteUrl": "https://platform.moonshot.cn"
  },
  {
    "id": "builtin-openai",
    "name": "OpenAI",
    "providerType": "openai",
    "authMode": null,
    "baseUrl": "https://api.openai.com/v1",
    "notes": "OpenAI 官方 API。当前主线包括 gpt-5.6、gpt-5.5/pro、gpt-5.4/pro/mini/nano；全部模型页仍列出 gpt-5.2/pro、gpt-5.1、gpt-5/pro/mini/nano，以及 o3-pro/o3/o4-mini。o 系列已进入退役期: o1/o3-mini/o4-mini 于 2026-10-23 关停，o3/o3-pro 于 2026-12-11 关停。默认协议建议使用 Responses。",
    "maxTokensLimit": null,
    "websiteUrl": "https://platform.openai.com"
  },
  {
    "id": "builtin-openai-codex",
    "name": "Codex",
    "providerType": "openai_codex",
    "authMode": "openai_codex_oauth",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "notes": "OpenAI Codex subscription access via ChatGPT OAuth. Sign in with ChatGPT instead of entering an API key.",
    "maxTokensLimit": null,
    "websiteUrl": "https://chatgpt.com/codex"
  },
  {
    "id": "builtin-anthropic",
    "name": "Anthropic",
    "providerType": "anthropic",
    "authMode": null,
    "baseUrl": "https://api.anthropic.com/v1",
    "notes": "Anthropic 官方 Claude API（Messages 协议）。可用模型: claude-opus-5(旗舰), claude-sonnet-5(均衡), claude-fable-5(思考 always-on), claude-haiku-4-5(轻量, 官方最新 Haiku 仍为 4.5)。注意: 5 系/4.6+ 新代际思考仅接受 thinking:{type:\"adaptive\"}+output_config.effort，非默认采样参数会 400；Haiku 4.5 走 manual extended thinking(budget_tokens)。",
    "maxTokensLimit": null,
    "websiteUrl": "https://platform.claude.com"
  },
  {
    "id": "builtin-nvidia",
    "name": "NVIDIA",
    "providerType": "nvidia",
    "authMode": null,
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "notes": "NVIDIA NIM hosted API。OpenAI-compatible Chat Completions；模型可通过 /models 拉取。默认不注入 thinking/reasoning 专用参数，避免不同 NIM 模型参数格式不一致。",
    "maxTokensLimit": null,
    "websiteUrl": "https://build.nvidia.com/nim"
  },
  {
    "id": "builtin-mimo",
    "name": "Xiaomi MiMo",
    "providerType": "mimo",
    "authMode": null,
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "notes": "Xiaomi MiMo API。优先内置 MiMo V2.5-Pro 与 MiMo V2.5（1M context，OpenAI-compatible Chat Completions）；Token Plan 可将 Base URL 改为 token-plan-*.xiaomimimo.com/v1。支持 thinking: { type } 与 reasoning_content 回传。V2.5 TTS/ASR 属语音专项能力，当前不放入聊天模型默认列表。",
    "maxTokensLimit": null,
    "websiteUrl": "https://platform.xiaomimimo.com"
  },
  {
    "id": "builtin-opencode-go",
    "name": "OpenCode Go",
    "providerType": "opencode_go",
    "authMode": null,
    "baseUrl": "https://opencode.ai/inference/go/openai/v1",
    "notes": "",
    "maxTokensLimit": null,
    "websiteUrl": "https://opencode.ai/go"
  }
];
export const BUILTIN_MODELS: readonly BuiltinModelDef[] = [
  {
    "id": "builtin-deepseek-flash",
    "vendorId": "builtin-deepseek",
    "label": "DeepSeek V4.1 Flash",
    "model": "deepseek-flash",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.6
  },
  {
    "id": "builtin-deepseek-v4-flash",
    "vendorId": "builtin-deepseek",
    "label": "DeepSeek V4 Flash",
    "model": "deepseek-v4-flash",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.6
  },
  {
    "id": "builtin-deepseek-v4-pro",
    "vendorId": "builtin-deepseek",
    "label": "DeepSeek V4 Pro",
    "model": "deepseek-v4-pro",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.6
  },
  {
    "id": "builtin-deepseek-ocr",
    "vendorId": "builtin-deepseek",
    "label": "DeepSeek OCR (Official)",
    "model": "deepseek-ocr",
    "isMultimodal": true,
    "isReasoning": false,
    "supportsTools": false,
    "maxOutputTokens": 0,
    "temperature": 0
  },
  {
    "id": "builtin-deepseek-asr",
    "vendorId": "builtin-deepseek",
    "label": "DeepSeek ASR",
    "model": "deepseek-asr",
    "isMultimodal": false,
    "isReasoning": false,
    "supportsTools": false,
    "maxOutputTokens": 0,
    "temperature": 0
  },
  {
    "id": "builtin-qwen3.7-max",
    "vendorId": "builtin-qwen",
    "label": "Qwen3.7 Max (旗舰/混合思考)",
    "model": "qwen3.7-max",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen3.7-plus",
    "vendorId": "builtin-qwen",
    "label": "Qwen3.7 Plus (官方默认推荐/多模态)",
    "model": "qwen3.7-plus",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen3.6-flash",
    "vendorId": "builtin-qwen",
    "label": "Qwen3.6 Flash (轻量高并发/多模态)",
    "model": "qwen3.6-flash",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 16384,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen3-max",
    "vendorId": "builtin-qwen",
    "label": "Qwen3 Max (上一代旗舰)",
    "model": "qwen3-max",
    "isMultimodal": false,
    "isReasoning": false,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen3.5-plus",
    "vendorId": "builtin-qwen",
    "label": "Qwen3.5 Plus (多模态/混合思考)",
    "model": "qwen3.5-plus",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen3.5-flash",
    "vendorId": "builtin-qwen",
    "label": "Qwen3.5 Flash (快速/混合思考)",
    "model": "qwen3.5-flash",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen-plus",
    "vendorId": "builtin-qwen",
    "label": "Qwen Plus (支持思考)",
    "model": "qwen-plus",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 32768,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwq-plus",
    "vendorId": "builtin-qwen",
    "label": "QwQ Plus (遗留推理模型)",
    "model": "qwq-plus",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 8192,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen3.5-397b-a17b",
    "vendorId": "builtin-qwen",
    "label": "Qwen3.5 397B A17B (开源旗舰)",
    "model": "qwen3.5-397b-a17b",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-qwen3.5-122b-a10b",
    "vendorId": "builtin-qwen",
    "label": "Qwen3.5 122B A10B (开源旗舰)",
    "model": "qwen3.5-122b-a10b",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-glm-5.2",
    "vendorId": "builtin-zhipu",
    "label": "GLM-5.2 (当前旗舰)",
    "model": "glm-5.2",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-glm-5.1",
    "vendorId": "builtin-zhipu",
    "label": "GLM-5.1 (Coding/长程任务)",
    "model": "glm-5.1",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65536,
    "temperature": 0.7
  },
  {
    "id": "builtin-glm-5",
    "vendorId": "builtin-zhipu",
    "label": "GLM-5 (上一代旗舰)",
    "model": "glm-5",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 16384,
    "temperature": 0.7
  },
  {
    "id": "builtin-glm-4.7",
    "vendorId": "builtin-zhipu",
    "label": "GLM-4.7 (高性价比)",
    "model": "glm-4.7",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 16384,
    "temperature": 0.7
  },
  {
    "id": "builtin-glm-4.6",
    "vendorId": "builtin-zhipu",
    "label": "GLM-4.6 (上一代)",
    "model": "glm-4.6",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 16384,
    "temperature": 0.7
  },
  {
    "id": "builtin-glm-4.7-flash",
    "vendorId": "builtin-zhipu",
    "label": "GLM-4.7 Flash (免费)",
    "model": "glm-4.7-flash",
    "isMultimodal": false,
    "isReasoning": false,
    "supportsTools": true,
    "maxOutputTokens": 8192,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-seed-2.1-pro",
    "vendorId": "builtin-doubao",
    "label": "Seed 2.1 Pro (当前旗舰)",
    "model": "doubao-seed-2-1-pro-260628",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 131072,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-seed-2.1-turbo",
    "vendorId": "builtin-doubao",
    "label": "Seed 2.1 Turbo (低成本低时延)",
    "model": "doubao-seed-2-1-turbo-260628",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65535,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-seed-evolving",
    "vendorId": "builtin-doubao",
    "label": "Seed Evolving (滚动更新)",
    "model": "doubao-seed-evolving",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65535,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-seed-2.0-pro",
    "vendorId": "builtin-doubao",
    "label": "Seed 2.0 Pro (旗舰全能)",
    "model": "doubao-seed-2-0-pro-260215",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65535,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-seed-2.0-lite",
    "vendorId": "builtin-doubao",
    "label": "Seed 2.0 Lite (均衡)",
    "model": "doubao-seed-2-0-lite-260215",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65535,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-seed-2.0-mini",
    "vendorId": "builtin-doubao",
    "label": "Seed 2.0 Mini (快速)",
    "model": "doubao-seed-2-0-mini-260215",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65535,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-seed-2.0-code",
    "vendorId": "builtin-doubao",
    "label": "Seed 2.0 Code (编程)",
    "model": "doubao-seed-2-0-code-preview-260215",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65535,
    "temperature": 0.7
  },
  {
    "id": "builtin-doubao-1.8-pro",
    "vendorId": "builtin-doubao",
    "label": "Seed 1.8 (上一代)",
    "model": "doubao-seed-1-8-251228",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 65535,
    "temperature": 0.7
  },
  {
    "id": "builtin-minimax-m3",
    "vendorId": "builtin-minimax",
    "label": "MiniMax M3 (最新旗舰/多模态)",
    "model": "MiniMax-M3",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 16384,
    "temperature": 1
  },
  {
    "id": "builtin-minimax-m2.7",
    "vendorId": "builtin-minimax",
    "label": "MiniMax M2.7 (高性价比推理)",
    "model": "MiniMax-M2.7",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 32768,
    "temperature": 1
  },
  {
    "id": "builtin-minimax-m2.5",
    "vendorId": "builtin-minimax",
    "label": "MiniMax M2.5 (性价比主力)",
    "model": "MiniMax-M2.5",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 16384,
    "temperature": 1
  },
  {
    "id": "builtin-minimax-m2.5-highspeed",
    "vendorId": "builtin-minimax",
    "label": "MiniMax M2.5 Highspeed (极速)",
    "model": "MiniMax-M2.5-highspeed",
    "isMultimodal": false,
    "isReasoning": false,
    "supportsTools": true,
    "maxOutputTokens": 8192,
    "temperature": 1
  },
  {
    "id": "builtin-minimax-m2.1",
    "vendorId": "builtin-minimax",
    "label": "MiniMax M2.1 (上一代)",
    "model": "MiniMax-M2.1",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 16384,
    "temperature": 1
  },
  {
    "id": "builtin-kimi-k3",
    "vendorId": "builtin-moonshot",
    "label": "Kimi K3 (旗舰/1M/多模态)",
    "model": "kimi-k3",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 131072,
    "temperature": 1
  },
  {
    "id": "builtin-kimi-k2.6",
    "vendorId": "builtin-moonshot",
    "label": "Kimi K2.6 (旗舰/多模态)",
    "model": "kimi-k2.6",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 32768,
    "temperature": 1
  },
  {
    "id": "builtin-kimi-k2.7-code",
    "vendorId": "builtin-moonshot",
    "label": "Kimi K2.7 Code (编程/强制思考)",
    "model": "kimi-k2.7-code",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 32768,
    "temperature": 1
  },
  {
    "id": "builtin-kimi-k2.5",
    "vendorId": "builtin-moonshot",
    "label": "Kimi K2.5 (上一代多模态旗舰)",
    "model": "kimi-k2.5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 32768,
    "temperature": 1
  },
  {
    "id": "builtin-moonshot-v1-128k",
    "vendorId": "builtin-moonshot",
    "label": "Moonshot V1 (旧版)",
    "model": "moonshot-v1-128k",
    "isMultimodal": false,
    "isReasoning": false,
    "supportsTools": true,
    "maxOutputTokens": 8192,
    "temperature": 0.7
  },
  {
    "id": "builtin-gpt-5.6",
    "vendorId": "builtin-openai",
    "label": "GPT-5.6 (当前旗舰)",
    "model": "gpt-5.6",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.5",
    "vendorId": "builtin-openai",
    "label": "GPT-5.5 (上一代旗舰)",
    "model": "gpt-5.5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.5-pro",
    "vendorId": "builtin-openai",
    "label": "GPT-5.5 Pro (高精度)",
    "model": "gpt-5.5-pro",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.4",
    "vendorId": "builtin-openai",
    "label": "GPT-5.4 (均衡主力)",
    "model": "gpt-5.4",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.4-pro",
    "vendorId": "builtin-openai",
    "label": "GPT-5.4 Pro (高计算)",
    "model": "gpt-5.4-pro",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.4-mini",
    "vendorId": "builtin-openai",
    "label": "GPT-5.4 Mini (高性价比)",
    "model": "gpt-5.4-mini",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.4-nano",
    "vendorId": "builtin-openai",
    "label": "GPT-5.4 Nano (超低成本)",
    "model": "gpt-5.4-nano",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.2",
    "vendorId": "builtin-openai",
    "label": "GPT-5.2 (上一代旗舰)",
    "model": "gpt-5.2",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.2-pro",
    "vendorId": "builtin-openai",
    "label": "GPT-5.2 Pro (上一代高精度)",
    "model": "gpt-5.2-pro",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5.1",
    "vendorId": "builtin-openai",
    "label": "GPT-5.1 (上一代 Coding/Agent)",
    "model": "gpt-5.1",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5",
    "vendorId": "builtin-openai",
    "label": "GPT-5 (基础代)",
    "model": "gpt-5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5-pro",
    "vendorId": "builtin-openai",
    "label": "GPT-5 Pro (高精度)",
    "model": "gpt-5-pro",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5-mini",
    "vendorId": "builtin-openai",
    "label": "GPT-5 Mini (轻量)",
    "model": "gpt-5-mini",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-gpt-5-nano",
    "vendorId": "builtin-openai",
    "label": "GPT-5 Nano (经济)",
    "model": "gpt-5-nano",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-o3-pro",
    "vendorId": "builtin-openai",
    "label": "o3-pro (深度推理, 2026-12 退役)",
    "model": "o3-pro",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 100000,
    "temperature": 1
  },
  {
    "id": "builtin-o3",
    "vendorId": "builtin-openai",
    "label": "o3 (推理, 2026-12 退役)",
    "model": "o3",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 100000,
    "temperature": 1
  },
  {
    "id": "builtin-o3-mini",
    "vendorId": "builtin-openai",
    "label": "o3-mini (推理轻量, 2026-10 退役)",
    "model": "o3-mini",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 100000,
    "temperature": 1
  },
  {
    "id": "builtin-o4-mini",
    "vendorId": "builtin-openai",
    "label": "o4-mini (推理, 2026-10 退役)",
    "model": "o4-mini",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 100000,
    "temperature": 1
  },
  {
    "id": "builtin-codex-gpt-5.6-sol",
    "vendorId": "builtin-openai-codex",
    "label": "GPT-5.6 Sol",
    "model": "gpt-5.6-sol",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-codex-gpt-5.6-terra",
    "vendorId": "builtin-openai-codex",
    "label": "GPT-5.6 Terra",
    "model": "gpt-5.6-terra",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-codex-gpt-5.6-luna",
    "vendorId": "builtin-openai-codex",
    "label": "GPT-5.6 Luna",
    "model": "gpt-5.6-luna",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-codex-gpt-5.5",
    "vendorId": "builtin-openai-codex",
    "label": "GPT-5.5",
    "model": "gpt-5.5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-codex-gpt-5.4",
    "vendorId": "builtin-openai-codex",
    "label": "GPT-5.4",
    "model": "gpt-5.4",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-codex-gpt-5.4-mini",
    "vendorId": "builtin-openai-codex",
    "label": "GPT-5.4 Mini",
    "model": "gpt-5.4-mini",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-claude-opus-5",
    "vendorId": "builtin-anthropic",
    "label": "Claude Opus 5 (旗舰)",
    "model": "claude-opus-5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-claude-sonnet-5",
    "vendorId": "builtin-anthropic",
    "label": "Claude Sonnet 5 (均衡)",
    "model": "claude-sonnet-5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-claude-fable-5",
    "vendorId": "builtin-anthropic",
    "label": "Claude Fable 5 (思考 always-on)",
    "model": "claude-fable-5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 128000,
    "temperature": 1
  },
  {
    "id": "builtin-claude-haiku-4-5",
    "vendorId": "builtin-anthropic",
    "label": "Claude Haiku 4.5 (轻量/官方最新 Haiku)",
    "model": "claude-haiku-4-5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 64000,
    "temperature": 1
  },
  {
    "id": "builtin-nvidia-nemotron-3-nano",
    "vendorId": "builtin-nvidia",
    "label": "NVIDIA Nemotron 3 Nano",
    "model": "nvidia/nemotron-3-nano-30b-a3b",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 8192,
    "temperature": 0.7
  },
  {
    "id": "builtin-nvidia-llama-3.1-405b",
    "vendorId": "builtin-nvidia",
    "label": "Llama 3.1 405B Instruct",
    "model": "meta/llama-3.1-405b-instruct",
    "isMultimodal": false,
    "isReasoning": false,
    "supportsTools": false,
    "maxOutputTokens": 8192,
    "temperature": 0.7
  },
  {
    "id": "builtin-mimo-v2.5-pro",
    "vendorId": "builtin-mimo",
    "label": "MiMo V2.5 Pro",
    "model": "mimo-v2.5-pro",
    "isMultimodal": false,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 131072,
    "temperature": 1
  },
  {
    "id": "builtin-mimo-v2.5",
    "vendorId": "builtin-mimo",
    "label": "MiMo V2.5 (多模态)",
    "model": "mimo-v2.5",
    "isMultimodal": true,
    "isReasoning": true,
    "supportsTools": true,
    "maxOutputTokens": 131072,
    "temperature": 1
  }
];
/** src-tauri/crates/dstu-llm/src/llm_manager/opencode_go.rs */
export interface GoBuiltinModelDef {
  id: string; label: string; model: string; protocol: string;
  isMultimodal: boolean; isReasoning: boolean; maxOutputTokens: number;
}
export const OPENCODE_GO_VENDOR_ID = "builtin-opencode-go";
export const OPENCODE_GO_PROVIDER_TYPE = "opencode_go";
export const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
export const OPENCODE_GO_BUILTIN_MODELS: readonly GoBuiltinModelDef[] = [
  {
    "id": "builtin-opencode-go-deepseek-v4.1-flash",
    "label": "DeepSeek V4.1 Flash (Go)",
    "model": "deepseek-v4.1-flash",
    "protocol": "openai_chat_completions",
    "isMultimodal": true,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-deepseek-v4-pro",
    "label": "DeepSeek V4 Pro (Go)",
    "model": "deepseek-v4-pro",
    "protocol": "openai_chat_completions",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-glm-5.3",
    "label": "GLM-5.3 (Go)",
    "model": "glm-5.3",
    "protocol": "openai_chat_completions",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-glm-5.3-flash",
    "label": "GLM-5.3-Flash (Go)",
    "model": "glm-5.3-flash",
    "protocol": "openai_chat_completions",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-kimi-k3",
    "label": "Kimi K3 (Go)",
    "model": "kimi-k3",
    "protocol": "openai_chat_completions",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-kimi-k3.1-pro",
    "label": "Kimi K3.1 Pro (Go)",
    "model": "kimi-k3.1-pro",
    "protocol": "openai_chat_completions",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-mimo-v2.6-pro",
    "label": "MiMo-V2.6-Pro (Go)",
    "model": "mimo-v2.6-pro",
    "protocol": "openai_chat_completions",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-qwen3.8-max",
    "label": "Qwen3.8 Max (Go)",
    "model": "qwen3.8-max",
    "protocol": "anthropic_messages",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-qwen3.8-flash",
    "label": "Qwen3.8 Flash (Go)",
    "model": "qwen3.8-flash",
    "protocol": "anthropic_messages",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-minimax-m3",
    "label": "MiniMax M3 (Go)",
    "model": "minimax-m3",
    "protocol": "anthropic_messages",
    "isMultimodal": false,
    "isReasoning": false,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-claude-haiku-5-5",
    "label": "Claude Haiku 5.5 (Go)",
    "model": "claude-haiku-5-5",
    "protocol": "anthropic_messages",
    "isMultimodal": true,
    "isReasoning": true,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-gpt-6-luna",
    "label": "GPT 6 Luna (Go)",
    "model": "gpt-6-luna",
    "protocol": "openai_responses",
    "isMultimodal": true,
    "isReasoning": true,
    "maxOutputTokens": 32768
  },
  {
    "id": "builtin-opencode-go-gemini-4-argon",
    "label": "Gemini 4 Argon (Go)",
    "model": "gemini-4-argon",
    "protocol": "google_generate_content",
    "isMultimodal": true,
    "isReasoning": false,
    "maxOutputTokens": 32768
  }
];

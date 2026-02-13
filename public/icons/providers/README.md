# AI供应商图标

本目录包含各大AI模型供应商的SVG图标文件。

## 图标列表

### 国际供应商
- **openai.svg** - OpenAI
- **anthropic.svg** - Anthropic (Claude)
- **gemini.svg** - Google Gemini
- **meta.svg** - Meta
- **mistral.svg** - Mistral AI
- **grok.svg** - xAI (Grok)
- **azure.svg** - Microsoft Azure AI
- **github-copilot.svg** - GitHub Copilot

### 中国供应商
- **deepseek.svg** - DeepSeek
- **qwen.svg** - 阿里巴巴通义千问
- **bailian.svg** - 阿里云百炼
- **doubao.svg** - 字节跳动豆包
- **zhipu.svg** - 智谱AI
- **chatglm.svg** - 智谱ChatGLM
- **hunyuan.svg** - 腾讯混元
- **moonshot.svg** - 月之暗面 (Kimi)
- **kling.svg** - 快手可灵
- **jimeng.svg** - 即梦AI
- **spark.svg** - 讯飞星火
- **vidu.svg** - Vidu
- **yi.svg** - 零一万物
- **minimax.svg** - MiniMax
- **wenxin.svg** - 百度文心
- **siliconcloud.svg** - 硅基流动
- **baichuan.svg** - 百川智能
- **sensenova.svg** - 商汤日日新

### 图像/视频生成
- **midjourney.svg** - Midjourney
- **flux.svg** - Flux
- **stability.svg** - Stability AI (Stable Diffusion)
- **runway.svg** - Runway
- **ideogram.svg** - Ideogram
- **luma.svg** - Luma AI
- **fal.svg** - Fal.ai
- **replicate.svg** - Replicate
- **pika.svg** - Pika

### 音频生成
- **suno.svg** - Suno
- **udio.svg** - Udio

### 其他工具
- **ollama.svg** - Ollama
- **langchain.svg** - LangChain
- **bing.svg** - Bing

## 使用说明

所有图标均为SVG格式，可以直接在React组件中引入使用：

```tsx
import OpenAIIcon from '@/public/icons/providers/openai.svg';

// 使用示例
<img src={OpenAIIcon} alt="OpenAI" width={24} height={24} />
```

或者在代码中动态引用：

```tsx
const iconPath = `/icons/providers/${providerName}.svg`;
```

## 图标尺寸

默认尺寸为 24x24 像素，但可以根据需要调整。

## 许可说明

这些图标仅用于显示对应AI服务供应商的品牌标识，版权归各自公司所有。


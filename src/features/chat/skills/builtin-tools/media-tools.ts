import type { SkillDefinition } from '../types';

export const mediaToolsSkill: SkillDefinition = {
  id: 'media-tools',
  name: 'media-tools',
  description: '使用应用已有的受管 ASR 模型把附件音频转写为可追溯的任务 artifact，并查询音视频运行时能力。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://media-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 媒体处理

- 先用 \`builtin-media_capabilities\` 查询受管运行时能力。
- 用 \`builtin-attachment_stage\` 获得附件的 TaskObjectHandle 后，将该 handle 传给 \`builtin-media_transcribe\`。
- 转写会把音频发送到 capability 指明的外部 ASR 提供商，并把结果写入任务 artifact；复用设置中的语音输入 ASR，不安装依赖、不修改系统环境。
- 仅接受经文件签名确认的 MP3、WAV、OGG、FLAC；不信任 TaskObjectHandle 声明的 mediaType 来判定容器内容。
- 视频音轨提取只有在 capability 明确 available=true 时可用；否则工具返回结构化 unsupported，禁止假装已提取或调用系统 ffmpeg。
`,
  embeddedTools: [
    {
      name: 'builtin-media_capabilities',
      description: '查询受管音频转写与视频音轨提取能力、支持格式和配置要求；不修改任何环境。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'builtin-media_transcribe',
      description:
        '把 attachment_stage 或其他授权 runtime 文件发送到 capability 指明的外部 ASR 提供商，并写入 Markdown transcript artifact。仅接受签名确认的 MP3/WAV/OGG/FLAC；缺少 ASR 配置或收到 MP4/WebM 容器时明确 unavailable/unsupported。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: {
          source: {
            type: 'object',
            description: 'TaskObjectHandle，或包含 objectHandle/object_handle 的 attachment_stage 结果。',
          },
          language: { type: 'string', description: '可选语言提示。' },
          prompt: { type: 'string', description: '可选 ASR 上下文提示。' },
        },
      },
    },
  ],
};

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
- 两种寻址方式二选一传给 \`builtin-media_transcribe\`：
  1. \`source: { "resourceId": "file_xxx" }\` —— 直接转写会话附件 / 资源库音频文件（VFS 附件 ID，注入占位文本中会给出）；
  2. 用 \`builtin-attachment_stage\` 获得附件的 TaskObjectHandle 后，把该 handle 作为 \`source\` 传入。
- 转写会把音频发送到 capability 指明的外部 ASR 提供商，并把结果写入任务 artifact；复用设置中的语音输入 ASR，不安装依赖、不修改系统环境。
- 仅接受经文件签名确认的 MP3、WAV、OGG、FLAC、M4A（MP4 audio 品牌容器）、ADTS AAC；不信任 TaskObjectHandle 声明的 mediaType 来判定容器内容。
- WMA（ASF 容器）明确不支持，工具会返回具体原因；请提示用户转换为 MP3/WAV/M4A。
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
        '把 VFS 附件或 stage/授权文件送外部 ASR 转写，写入 Markdown transcript artifact。仅接受签名确认的 MP3/WAV/OGG/FLAC/M4A/AAC；缺 ASR 配置、视频容器或 WMA 返回明确 unavailable/unsupported 原因。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: {
          source: {
            type: 'object',
            description:
              '三选一：{ "resourceId": "file_xxx" }、TaskObjectHandle、或含 objectHandle 的 attachment_stage 结果。',
          },
          language: { type: 'string', description: '语言提示。' },
          prompt: { type: 'string', description: 'ASR 上下文提示。' },
        },
      },
    },
  ],
};

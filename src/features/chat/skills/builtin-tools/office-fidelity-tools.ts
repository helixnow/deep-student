import type { SkillDefinition } from '../types';

export const officeFidelityToolsSkill: SkillDefinition = {
  id: 'office-fidelity-tools',
  name: 'office-fidelity-tools',
  description:
    '只读检查授权 DOCX/XLSX/PPTX/PDF 的高保真特性，输出可审计证据哈希与完成门；不执行宏、不解密、不声称编辑器会保留未支持特性。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 9,
  location: 'builtin',
  sourcePath: 'builtin://office-fidelity-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# Office Fidelity Preflight

- 编辑已有 DOCX/XLSX/PPTX 或交付 PDF 前，先调用 builtin-office_fidelity_inspect。
- 输入必须是带 managed locator 或 Deep Student VFS provider ref 的授权 TaskObjectHandle；禁止裸主机路径。
- 检查结果区分 detector supported、只读检查保持的 preserved，以及当前编辑链不能保证的 unsupported。
- 宏、数字签名、修订、批注、域、脚注、公式、命名范围、数据验证、图表、透视、外链、母版、备注、动画、PDF 表单/签名/附件/加密均进入完成门。
- 绝不执行宏。检测到宏或签名时默认拒绝自动编辑；未来只有实际源编辑链接入检查结果并显式使用 macro_policy=strip 时才可剥离宏，且必须标注签名失效。
- SecretPrompt 口令句柄不属于聊天工具参数。当前没有 Office/PDF 解密器消费该句柄，因此加密文件返回 DECRYPTOR_INTEGRATION_UNAVAILABLE，不得伪称已解密。
`,
  embeddedTools: [
    {
      name: 'builtin-office_fidelity_inspect',
      description:
        'Low/ReadOnly：检查授权 TaskObjectHandle 指向的 DOCX/XLSX/PPTX/PDF，返回 office-fidelity-inspection/v1 清单、supported/preserved/unsupported、risk、requiresHumanReview、每项证据 hash 和默认拒绝的完成门。不会执行宏、写文件或处理口令。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['source'],
        properties: {
          source: {
            type: 'object',
            description:
              '完整 TaskObjectHandle，或 attachment_stage 结果中的 objectHandle/object_handle；必须含可读 managed locator 或 Deep Student VFS provider ref。',
          },
        },
      },
    },
  ],
};

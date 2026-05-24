type AboutRow = Readonly<{
  label: string;
  value: string;
  description?: string;
}>;

type AboutPartner = Readonly<{
  title: string;
  name: string;
  description: string;
}>;

export const aboutContent = {
  name: "DeepStudent",
  release: "0.9.34 (13419)",
  primaryActionLabel: "检查更新",
  developmentTitle: "开发信息",
  developmentRows: [
    {
      label: "开发者",
      value: "DeepStudent Team",
    },
    {
      label: "版本",
      value: "0.9.34 (13419)e6d0421b",
    },
    {
      label: "更新渠道",
      value: "稳定版",
      description: "仅接收经过验证的稳定版更新",
    },
    {
      label: "自动检查更新",
      value: "每次启动时自动检查",
    },
  ] as const satisfies readonly AboutRow[],
  details: [
    {
      label: "许可证",
      value: "AGPL-3.0-or-later",
    },
    {
      label: "平台支持",
      value: "Windows / macOS / iPadOS / Android",
    },
  ] as const satisfies readonly AboutRow[],
  linksTitle: "官方链接",
  linkLabels: ["访问官网", "GitHub", "反馈 Issue", "查看隐私政策"] as const,
  partner: {
    title: "技术合作伙伴致谢",
    name: "SiliconFlow",
    description:
      "提供多模态与推理模型服务，保障 DeepStudent 在国产算力生态中的高效稳定运行。",
  } as const satisfies AboutPartner,
} as const;

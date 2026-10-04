/**
 * 技术字段（模型 ID / API Key / Base URL / 端点 / MCP 命令 / 用户名 / 路径…）的软键盘提示。
 *
 * 移动端软键盘默认首字母大写、自动纠错与联想：`gpt-4o` 会变成 `Gpt-4o`，
 * URL 里的片段会被"纠正"，密钥会被学进输入法词库。Android WebView 下
 * `autocomplete="off"` 还会让 Chromium 给 IME 加 NO_SUGGESTIONS 标志。
 *
 * 只铺到技术字段上，不改 Input 的全局默认值（普通文本仍需要纠错/联想）。
 * 以展开写在其它 props 之前，调用方可按需覆盖（例如 autoComplete）。
 */
export const TECHNICAL_INPUT_PROPS = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  autoComplete: 'off',
  spellCheck: false,
} as const;

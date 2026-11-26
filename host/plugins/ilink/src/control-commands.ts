/**
 * Remote Headless / WeChat iLink Slash Command Protocol
 *
 * Shares consistent control command semantics with the desktop/mobile chat composer
 * for channels without GUI toolbars (`/stop`, `/status`, `/help`, `/new`, `/compact`,
 * `/goal`, `/mode`, `/approve`, `/reject`, `/pair`).
 */

export type RemoteSlashCommandKind =
  | 'stop'
  | 'status'
  | 'help'
  | 'new'
  | 'compact'
  | 'goal'
  | 'mode'
  | 'approve'
  | 'reject'
  | 'pair';

export interface ParsedRemoteSlashCommand {
  kind: RemoteSlashCommandKind;
  matchedToken: string;
  args: string;
}

const REMOTE_COMMAND_MAP: Readonly<Record<string, RemoteSlashCommandKind>> = {
  stop: 'stop',
  cancel: 'stop',
  status: 'status',
  context: 'status',
  usage: 'status',
  help: 'help',
  commands: 'help',
  new: 'new',
  clear: 'new',
  reset: 'new',
  compact: 'compact',
  summarize: 'compact',
  goal: 'goal',
  mode: 'mode',
  perm: 'mode',
  approve: 'approve',
  reject: 'reject',
  pair: 'pair',
};

const REMOTE_SLASH_RE = /^\s*\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/;

export function parseRemoteSlashCommand(rawText: string): ParsedRemoteSlashCommand | null {
  const match = REMOTE_SLASH_RE.exec(rawText);
  if (!match) return null;
  const token = (match[1] ?? '').toLowerCase();
  const kind = REMOTE_COMMAND_MAP[token];
  if (!kind) return null;
  return {
    kind,
    matchedToken: token,
    args: (match[2] ?? '').trim(),
  };
}

export function isRemoteControlSlashCommand(rawText: string): boolean {
  return parseRemoteSlashCommand(rawText) !== null;
}

export function isRemoteStopSlashCommand(rawText: string): boolean {
  return parseRemoteSlashCommand(rawText)?.kind === 'stop';
}

export function formatRemoteSlashHelp(): string {
  return [
    'DeepStudent 远程指令一览：',
    '• /status — 查看当前会话模型、目标与状态',
    '• /stop — 立即停止当前正在生成的回复',
    '• /new [问题] — 开启新对话（可选直接附带首问）',
    '• /compact [保留重点] — 压缩当前会话上下文',
    '• /goal <目标 | pause | resume | clear> — 创建或管理长程学习目标',
    '• /approve <id> / /reject <id> — 远程审批或拒绝待确认操作',
    '• /help — 查看本帮助说明',
  ].join('\n');
}

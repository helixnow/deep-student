/**
 * 移动端能力清单（汇总）：各 Host 服务的移动端清单 + 外壳层面的已知限制。
 *
 * - `unsupported`：调用会以 `UNSUPPORTED_ON_PLATFORM: <id> …` 错误 reject（存储层为
 *   `StorageError.code === 'UNSUPPORTED_ON_PLATFORM'`，`capability` = id）；前端据消息前缀识别，
 *   并据本清单隐藏 / 置灰对应入口；
 * - `partial`：可用，但与桌面有已知差异（`note` 说明）。
 *
 * 运行中的 Host 经 `mobileDiagnostics.capabilities()` 返回同一份数据。
 */
import { MOBILE_STORAGE_CAPABILITIES, type PlatformCapability } from '../../host/platform/storage-mobile/capabilities.ts';

export type { CapabilityStatus, PlatformCapability } from '../../host/platform/storage-mobile/capabilities.ts';
export { UNSUPPORTED_ON_PLATFORM_PREFIX } from '../../host/platform/errors/unsupported-on-platform.ts';

const SHELL_CAPABILITIES: readonly PlatformCapability[] = [
  { id: 'profile.plugins', status: 'partial', note: '只装配 host/profiles/mobile.json 中运行时闭包不含 Node 依赖的插件（scripts/portability/scan.mjs --profile 守护）；其余命令在移动端未注册' },
  { id: 'http.streaming', status: 'partial', note: 'Worker 直连和 Android 原生回退均支持流式；其他外壳的 Capacitor HTTP 回退仍缓冲响应' },
  { id: 'native.plugins.inWorker', status: 'partial', note: 'Capacitor 插件只能在主线程调用，Host 在 Worker 中，需经主线程外壳转发' },
  { id: 'net.publicPolicy', status: 'partial', note: 'Android 原生解析并检查全部 DNS 地址；没有原生解析能力的外壳拒绝 public 请求' },
  { id: 'http.destination.publicPinned', status: 'partial', note: 'Android 直连已校验 IP，证书和 SNI 仍使用原域名；iOS 和浏览器外壳拒绝该请求' },
  { id: 'files', status: 'partial', note: 'ctx.files 在 OPFS 上实现（host/platform/files/opfs.ts），允许根都在 /deep-student 下；没有符号链接与权限位，目录 stat 的 size / modifiedMs 为 0；同一文件同时只能有一个写入者' },
  { id: 'files.grant', status: 'unsupported', note: '用户选择的文件经外壳以内容传入 Worker，不是 OPFS 路径；ctx.files.grant 以 UNSUPPORTED_ON_PLATFORM 拒绝' },
  { id: 'files.rename', status: 'partial', note: '目录改名需要 FileSystemDirectoryHandle.move()（Chromium 没有），缺少时以 UNSUPPORTED_ON_PLATFORM 拒绝；文件改名与原子写入用 FileSystemFileHandle.move()' },
  // 桌面独占的业务命令：`dstu.mobile.compat` 会注册占位处理函数，调用返回
  // `UNSUPPORTED_ON_PLATFORM: <id> is not available on mobile: …`，而不是 kernel 的 ACL 错误。
  { id: 'media', status: 'partial', note: '媒体库、进度、章节、台账、字幕导入与导出可用；Android 使用系统文件选择器保存' },
  { id: 'media.bilibili', status: 'partial', note: 'Android 支持链接解析、扫码与字幕导入；播放走 B 站嵌入播放器，无原生画质选择、桌面浏览器中继或截帧' },
  { id: 'media.transcribe', status: 'partial', note: 'Android WebView 解码支持的音视频并提交给 ASR，限 32 MiB 与 20 分钟；也支持直接导入已有字幕' },
  { id: 'media.pdf', status: 'partial', note: 'Android 使用 PDF.js 解析和渲染；支持 PDF OCR、讲义和笔记 DOCX 导出' },
  { id: 'media.ocr', status: 'partial', note: '可测试已配置的 OCR 模型并处理 PDF；无系统 OCR，单页跳过未接通' },
  { id: 'media.tts', status: 'partial', note: '支持配置后的 DeepSeek TTS；未移植系统 TTS' },
  { id: 'browser.window', status: 'unsupported', note: '内嵌浏览器窗口与下载管理属于 Electron 外壳；外部搜索设置与连通性测试走 ctx.http' },
  { id: 'mcp', status: 'partial', note: 'Android 支持远程 HTTP、SSE、WebSocket 与 Host 工具注册；无桌面 stdio 与 Host OAuth 授权' },
  { id: 'data.governance', status: 'partial', note: '支持系统文件选取、加密备份、校验、资产扫描、恢复及启动时中断重放；没有桌面式手动切槽、后台自动备份和任务手动续传' },
  { id: 'automation', status: 'partial', note: '运行中的应用会执行调度；Android 可选后台番茄钟完成提醒，系统可能延迟投递' },
  { id: 'agent.skills', status: 'partial', note: '通过 OPFS 支持技能包管理；桌面运行时能力仍有限制' },
  { id: 'agent.workspace', status: 'unsupported', note: '运行时工作区根目录、文件写入与回滚基于桌面文件系统与批准范围' },
  { id: 'plugin.manager', status: 'unsupported', note: '插件管理器的安装 / 配置 / 登录要求 Node 模块加载与包校验；移动端只装内置 profile' },
  { id: 'secrets', status: 'partial', note: '设置里的密钥可用；云存储凭据与 keystore 保护依赖原生密钥库' },
  { id: 'cloud.config', status: 'unsupported', note: '云端 SSOT 配置发布依赖桌面外壳与凭据存储' },
  { id: 'log.debug', status: 'partial', note: 'Host 日志经 Worker console 输出；调试日志文件、导出包与打开日志目录需要桌面文件系统' },
  { id: 'desktop.command', status: 'unsupported', note: '未在移动端实现的桌面命令（窗口 / 更新器 / 测试槽位等），统一以 UNSUPPORTED_ON_PLATFORM 拒绝' },
];

export const MOBILE_CAPABILITIES: readonly PlatformCapability[] = [...MOBILE_STORAGE_CAPABILITIES, ...SHELL_CAPABILITIES];

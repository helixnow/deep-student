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
  { id: 'http.streaming', status: 'unsupported', note: 'Capacitor 原生 HTTP 不支持 SSE 流式；LLM 流式需在 WebView fetch 或自建原生插件上实现' },
  { id: 'native.plugins.inWorker', status: 'partial', note: 'Capacitor 插件只能在主线程调用，Host 在 Worker 中，需经主线程外壳转发' },
  { id: 'net.publicPolicy', status: 'partial', note: 'WebView 没有 DNS 接口，public 网络策略只能对 IP 字面量判断；allowLoopback: false 也只能拒绝回环字面量与 localhost 名' },
  { id: 'http.destination.publicPinned', status: 'unsupported', note: '需要“连已校验 IP、证书仍按主机名校验”的原生传输：Android 可用 OkHttp 的 Dns 接口实现；iOS URLSession 不能指定连接地址，没有对应能力。ctx.http 的 public-pinned 请求与 checkPublicPinned 都以 UNSUPPORTED_ON_PLATFORM 拒绝' },
  { id: 'files', status: 'partial', note: 'ctx.files 在 OPFS 上实现（host/platform/files/opfs.ts），允许根都在 /deep-student 下；没有符号链接与权限位，目录 stat 的 size / modifiedMs 为 0；同一文件同时只能有一个写入者' },
  { id: 'files.grant', status: 'unsupported', note: '用户选择的文件经外壳以内容传入 Worker，不是 OPFS 路径；ctx.files.grant 以 UNSUPPORTED_ON_PLATFORM 拒绝' },
  { id: 'files.rename', status: 'partial', note: '目录改名需要 FileSystemDirectoryHandle.move()（Chromium 没有），缺少时以 UNSUPPORTED_ON_PLATFORM 拒绝；文件改名与原子写入用 FileSystemFileHandle.move()' },
  // 桌面独占的业务命令：`dstu.mobile.compat` 会注册占位处理函数，调用返回
  // `UNSUPPORTED_ON_PLATFORM: <id> is not available on mobile: …`，而不是 kernel 的 ACL 错误。
  { id: 'media', status: 'partial', note: '媒体库 / 播放进度 / 字幕视图 / 章节 / 台账走 ctx.storage；其余媒体命令按能力降级' },
  { id: 'media.bilibili', status: 'unsupported', note: 'B 站原生取流（gRPC / node:zlib / node:dns 固定解析）与浏览器桥接需要 Node 与原生网络；链接条目的数据面（media_library_list）可用' },
  { id: 'media.transcribe', status: 'partial', note: '语音输入（voice_input_transcribe）可用（音频 base64 + ctx.http ASR）；音视频转写需要 nativeAudio 解码与 mediaTranscriber，字幕导入（media_transcript_import）需要本地文件路径' },
  { id: 'media.pdf', status: 'unsupported', note: 'PDF OCR / PDFium 页面栅格化 / 讲义 docx 导出需要 PDFium 与 Office 原生进程' },
  { id: 'media.ocr', status: 'partial', note: 'OCR 引擎与模型的设置、校验可用；引擎探测（test_ocr_engine）需要 PDFium / 原生图片解码' },
  { id: 'media.tts', status: 'unsupported', note: '系统 TTS 走 node:child_process 调用平台命令' },
  { id: 'browser.window', status: 'unsupported', note: '内嵌浏览器窗口与下载管理属于 Electron 外壳；外部搜索设置与连通性测试走 ctx.http' },
  { id: 'mcp', status: 'partial', note: 'MCP 配置读写可用；stdio 服务器、OAuth 与本机探测依赖 node:child_process / 本机回环' },
  { id: 'data.governance', status: 'partial', note: '迁移状态与健康检查来自移动端存储层；备份 zip / 恢复 / 资产扫描需要桌面文件系统' },
  { id: 'agent.skills', status: 'partial', note: '通过 OPFS 支持技能包管理；桌面运行时能力仍有限制' },
  { id: 'agent.workspace', status: 'unsupported', note: '运行时工作区根目录、文件写入与回滚基于桌面文件系统与批准范围' },
  { id: 'plugin.manager', status: 'unsupported', note: '插件管理器的安装 / 配置 / 登录要求 Node 模块加载与包校验；移动端只装内置 profile' },
  { id: 'secrets', status: 'partial', note: '设置里的密钥可用；云存储凭据与 keystore 保护依赖原生密钥库' },
  { id: 'cloud.config', status: 'unsupported', note: '云端 SSOT 配置发布依赖桌面外壳与凭据存储' },
  { id: 'log.debug', status: 'partial', note: 'Host 日志经 Worker console 输出；调试日志文件、导出包与打开日志目录需要桌面文件系统' },
  { id: 'desktop.command', status: 'unsupported', note: '未在移动端实现的桌面命令（窗口 / 更新器 / 测试槽位等），统一以 UNSUPPORTED_ON_PLATFORM 拒绝' },
];

export const MOBILE_CAPABILITIES: readonly PlatformCapability[] = [...MOBILE_STORAGE_CAPABILITIES, ...SHELL_CAPABILITIES];

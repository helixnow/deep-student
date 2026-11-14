# 业务插件可移植性报告

生成：`node scripts/portability/scan.mjs --report`，提交 `a18a1ec7`。只统计生产代码（不含测试、夹具）。

## 总览

- 插件 27 个，生产源文件 1513 个。
- 不 import 任何 Node 专有模块 / 原生模块 / Node 专用包的文件：1118（73.89%）。
- 运行时可移植的文件（另外也不在值位置使用 `Buffer`、`process` 等 Node 全局量；`import type` 不计）：1040（68.74%）。
- 有 Node 依赖的文件里的同步调用（`*Sync(`）：1146 处。
- 估算总工作量：1665.88 单位 ≈ 69.41 人日（1 单位 ≈ 15 分钟，含测试；1 人日 = 24 单位）。

估算口径：每个文件对每种依赖计一次权重（如 `node:fs` 3、`node:crypto` 1、`node:path` 0.5、`child_process` 5），类型依赖乘 0.25，有运行时依赖的文件每个 `*Sync(` 调用另加 0.25（同步改异步会沿调用链扩散）。权重见 `scripts/portability/lib/portability.mjs`，只用于排序与粗估。

## 依赖分布（按文件数）

| 依赖 | 文件数 | 类别 | 替代方案 |
|---|---:|---|---|
| 全局 Buffer | 218 | web-standard | Uint8Array + ctx.crypto 编码 |
| node:fs | 210 | service | ctx.files（异步；同步调用的迁移方案见 SYNC-FS-PLAN.md） |
| node:crypto | 191 | service | ctx.crypto；无 ctx 的同步小输入用 host/platform/crypto/sync.ts |
| node:path | 186 | web-standard | host/platform/util/path.ts（同名函数，语义同 node:path）；限定根目录用 files/path.ts |
| 全局 process | 66 | service | ctx.app / 插件配置 |
| type 全局 NodeJS | 48 | web-standard | 可移植类型（ReturnType<typeof setTimeout> 等） |
| node:os | 24 | service | ctx.paths / ctx.app.platform |
| type 全局 Buffer | 23 | web-standard | Uint8Array + ctx.crypto 编码 |
| node:perf_hooks | 13 | web-standard | 全局 performance |
| node:http | 12 | service | ctx.http（服务端监听属仅桌面） |
| node:timers | 10 | web-standard | 全局 setTimeout / AbortSignal.timeout |
| node:child_process | 9 | desktop-only | 仅桌面（声明 platforms: ['desktop']） |
| node:util | 8 | web-standard | TextDecoder / 手写 promisify |
| node:zlib | 7 | service | CompressionStream / native compression 服务 |
| node:worker_threads | 6 | desktop-only | 仅桌面，或改 Web Worker 平台服务 |
| type node:stream | 5 | web-standard | Web Streams |
| node:assert | 5 | web-standard | 显式检查 |
| node:url | 5 | web-standard | 全局 URL |
| node:dns | 4 | service | ctx.http（destination / isPublicUrl） |
| node:buffer | 3 | web-standard | Uint8Array + ctx.crypto 编码 |
| node:https | 3 | service | ctx.http |
| node:net | 3 | desktop-only | 仅桌面（套接字 / 本地服务） |
| 全局 setImmediate | 3 | web-standard | queueMicrotask / setTimeout(0) |
| type node:net | 2 | desktop-only | 仅桌面（套接字 / 本地服务） |
| 包 undici | 2 | service | ctx.http / 仅桌面 |
| type node:http | 1 | service | ctx.http（服务端监听属仅桌面） |
| type node:fs | 1 | service | ctx.files（异步；同步调用的迁移方案见 SYNC-FS-PLAN.md） |
| 全局 clearImmediate | 1 | web-standard | clearTimeout |
| node:events | 1 | web-standard | EventTarget / 轻量 emitter |
| node:tls | 1 | desktop-only | 仅桌面 |
| node:stream | 1 | web-standard | Web Streams |
| 包 @smithy/node-http-handler | 1 | service | ctx.http / 仅桌面 |

类别：`service` = 改走平台服务；`desktop-only` = 移动端无等价物（声明仅桌面或下沉到桌面平台服务）；`web-standard` = 用标准 Web API 或纯函数替代。

## 按插件排序的迁移工作量

| # | 插件 | 学习伴侣 | 声明平台 | 文件 | 无 Node import | 运行时可移植 | 主要依赖（文件数） | 同步调用 | 工作量（单位 / 人日） | 建议 |
|---:|---|:---:|---|---:|---:|---:|---|---:|---:|---|
| 1 | agent-workspace |  | （缺省 desktop） | 85 | 62% | 54% | node:path 29、node:fs 26、全局 Buffer 23、全局 process 20 | 257 | 237.06 / 9.88 | 拆出桌面部分或声明仅桌面 |
| 2 | sync | ✓ | （缺省 desktop） | 102 | 49% | 45% | 全局 Buffer 26、node:crypto 25、node:fs 24、node:path 21 | 82 | 157.5 / 6.56 | 迁到平台服务 |
| 3 | agent-skills |  | （缺省 desktop） | 54 | 46% | 43% | 全局 Buffer 20、node:crypto 19、node:path 14、node:fs 12 | 155 | 155.06 / 6.46 | 拆出桌面部分或声明仅桌面 |
| 4 | media |  | （缺省 desktop） | 113 | 71% | 65% | 全局 Buffer 21、node:fs 20、node:path 18、node:crypto 15 | 39 | 147.31 / 6.14 | 拆出桌面部分或声明仅桌面 |
| 5 | backup |  | desktop | 31 | 42% | 42% | node:path 16、node:fs 15、node:crypto 10、全局 Buffer 6 | 197 | 122.13 / 5.09 | 已声明仅桌面 |
| 6 | vfs | ✓ | （缺省 desktop） | 81 | 77% | 64% | 全局 Buffer 19、node:fs 14、node:path 10、全局 process 6 | 60 | 96.31 / 4.01 | 迁到平台服务 |
| 7 | anki | ✓ | （缺省 desktop） | 93 | 72% | 67% | node:fs 14、node:crypto 13、全局 Buffer 10、node:path 9 | 48 | 94.5 / 3.94 | 拆出桌面部分或声明仅桌面 |
| 8 | sync-providers | ✓ | （缺省 desktop） | 40 | 65% | 65% | node:fs 14、全局 Buffer 11、node:path 10、node:os 3 | 0 | 80.19 / 3.34 | 拆出桌面部分或声明仅桌面 |
| 9 | qbank | ✓ | （缺省 desktop） | 102 | 79% | 73% | 全局 Buffer 13、node:fs 11、node:crypto 10、node:path 8 | 28 | 70.5 / 2.94 | 迁到平台服务 |
| 10 | notes | ✓ | （缺省 desktop） | 52 | 77% | 71% | node:fs 10、node:path 8、node:crypto 7、全局 Buffer 5 | 39 | 56.25 / 2.34 | 迁到平台服务 |
| 11 | mcp |  | （缺省 desktop） | 27 | 70% | 41% | 全局 Buffer 8、全局 process 8、node:crypto 4、node:fs 4 | 20 | 54.38 / 2.27 | 拆出桌面部分或声明仅桌面 |
| 12 | vfs-repos | ✓ | （缺省 desktop） | 56 | 77% | 70% | node:crypto 6、node:fs 6、node:path 6、全局 Buffer 6 | 44 | 53.5 / 2.23 | 拆出桌面部分或声明仅桌面 |
| 13 | chat | ✓ | （缺省 desktop） | 85 | 80% | 75% | node:crypto 12、全局 Buffer 7、node:fs 5、node:path 4 | 49 | 53.25 / 2.22 | 迁到平台服务 |
| 14 | chat-pipeline | ✓ | （缺省 desktop） | 74 | 74% | 65% | node:crypto 15、全局 Buffer 12、node:fs 5、node:path 3 | 8 | 47.5 / 1.98 | 迁到平台服务 |
| 15 | agent-orchestration |  | （缺省 desktop） | 61 | 79% | 75% | node:crypto 11、全局 Buffer 7、node:fs 3、node:path 2 | 38 | 40 / 1.67 | 迁到平台服务 |
| 16 | vfs-index |  | （缺省 desktop） | 45 | 76% | 76% | node:fs 8、node:path 7、全局 Buffer 5、node:crypto 2 | 8 | 38.5 / 1.6 | 迁到平台服务 |
| 17 | browser |  | （缺省 desktop） | 28 | 68% | 68% | node:crypto 6、全局 Buffer 5、node:fs 4、node:path 2 | 8 | 36 / 1.5 | 拆出桌面部分或声明仅桌面 |
| 18 | llm | ✓ | （缺省 desktop） | 116 | 86% | 83% | node:crypto 8、node:path 5、全局 Buffer 5、node:fs 3 | 12 | 35.75 / 1.49 | 迁到平台服务 |
| 19 | vfs-handlers |  | （缺省 desktop） | 34 | 76% | 76% | node:fs 7、node:path 5、node:crypto 1、全局 Buffer 1 | 24 | 32.25 / 1.34 | 迁到平台服务 |
| 20 | chatanki |  | （缺省 desktop） | 51 | 69% | 65% | node:perf_hooks 11、node:path 3、全局 Buffer 3、node:crypto 2 | 13 | 19.13 / 0.8 | 迁到平台服务 |
| 21 | llm-providers | ✓ | （缺省 desktop） | 39 | 95% | 95% | node:crypto 2、全局 Buffer 2、node:http 1、node:https 1 | 0 | 10.81 / 0.45 | 迁到平台服务 |
| 22 | translation |  | （缺省 desktop） | 12 | 83% | 75% | node:crypto 2、全局 process 2、node:fs 1、node:os 1 | 7 | 9.25 / 0.39 | 迁到平台服务 |
| 23 | ilink |  | （缺省 desktop） | 4 | 75% | 50% | 全局 Buffer 2、node:crypto 1、node:http 1 | 0 | 6 / 0.25 | 迁到平台服务 |
| 24 | review | ✓ | （缺省 desktop） | 37 | 97% | 97% | node:assert 1、node:fs 1、node:path 1、node:url 1 | 5 | 5.75 / 0.24 | 迁到平台服务 |
| 25 | sync-support | ✓ | （缺省 desktop） | 24 | 96% | 96% | node:fs 1、node:path 1 | 5 | 4.75 / 0.2 | 迁到平台服务 |
| 26 | memory | ✓ | （缺省 desktop） | 62 | 97% | 95% | node:crypto 1、node:timers 1、全局 Buffer 1 | 0 | 2.25 / 0.09 | 迁到平台服务 |
| 27 | integration |  | desktop, mobile | 5 | 100% | 100% | — | 0 | 0 / 0 | 迁到平台服务 |

学习伴侣范围（chat、chat-pipeline、llm、llm-providers、notes、vfs、vfs-repos、qbank、review、anki、memory、sync、sync-providers、sync-support）合计约 768.81 单位 ≈ 32.03 人日。

## 仅桌面候选（含移动端无等价物的依赖）

- **agent-workspace**：node:child_process
- **agent-skills**：node:net、node:child_process、node:worker_threads
- **media**：node:child_process
- **anki**：node:net
- **sync-providers**：node:net、node:tls
- **mcp**：node:child_process
- **vfs-repos**：node:worker_threads
- **browser**：node:worker_threads

## 传递依赖：插件外的哪些模块把 Node 带进来

插件以值导入（非 `import type`）引用的插件外文件，其运行时闭包里含 Node 专有依赖。即使插件本身干净，经由这些入口仍会在移动端加载失败。

| 插件外模块 | 引用它的插件数 | 闭包内的 Node 依赖 |
|---|---:|---|
| `host/platform/storage/api.ts` | 16 | 原生 better-sqlite3、node:crypto、node:fs、node:os、node:path、node:url、node:worker_threads、全局 Buffer、全局 process |
| `host/plugins/agent-workspace/api.ts` | 8 | 原生 better-sqlite3、node:buffer、node:child_process、node:crypto、node:dns、node:fs、node:http、node:https、node:net、node:os、node:path、node:perf_hooks、node:stream、node:timers、node:url、node:util、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/platform/paths/compat.ts` | 7 | node:crypto、node:fs、node:path、全局 process |
| `host/plugins/llm-providers/api.ts` | 7 | 原生 better-sqlite3、node:crypto、node:dns、node:fs、node:os、node:path、node:stream、node:timers、node:url、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/plugins/llm/api.ts` | 7 | 原生 better-sqlite3、node:crypto、node:dns、node:fs、node:os、node:path、node:stream、node:timers、node:url、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/plugins/vfs/api.ts` | 7 | 原生 better-sqlite3、node:crypto、node:fs、node:os、node:path、node:url、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/platform/net-policy/index.ts` | 6 | node:dns |
| `host/platform/util/node.ts` | 6 | node:zlib、全局 Buffer、全局 process |
| `host/plugins/agent-skills/api.ts` | 6 | 原生 better-sqlite3、node:buffer、node:child_process、node:crypto、node:dns、node:fs、node:http、node:https、node:net、node:os、node:path、node:perf_hooks、node:stream、node:timers、node:url、node:util、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/plugins/chat/api.ts` | 4 | 原生 better-sqlite3、node:buffer、node:child_process、node:crypto、node:dns、node:fs、node:http、node:https、node:net、node:os、node:path、node:perf_hooks、node:stream、node:timers、node:url、node:util、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/platform/storage/node.ts` | 4 | 原生 better-sqlite3、node:crypto、node:fs、node:os、node:path、node:url、node:worker_threads、全局 Buffer、全局 process |
| `host/platform/storage/unified-file-manager.ts` | 4 | node:crypto、node:fs、node:path、全局 Buffer、全局 process |
| `host/plugins/sync/api.ts` | 4 | 原生 better-sqlite3、node:crypto、node:dns、node:fs、node:os、node:path、node:stream、node:timers、node:url、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/plugins/agent-orchestration/api.ts` | 3 | 原生 better-sqlite3、node:buffer、node:child_process、node:crypto、node:dns、node:fs、node:http、node:https、node:net、node:os、node:path、node:perf_hooks、node:stream、node:timers、node:url、node:util、node:worker_threads、node:zlib、全局 Buffer、全局 process |
| `host/platform/paths/index.ts` | 3 | node:crypto、node:fs、node:os、node:path、全局 Buffer、全局 process |
| `host/platform/secrets/crypto-service.ts` | 3 | node:child_process、node:crypto、node:fs、node:path、全局 Buffer、全局 process |
| `host/platform/storage/file-deletion-queue.ts` | 2 | 原生 better-sqlite3、node:crypto、node:fs、node:os、node:path、node:url、node:worker_threads、全局 Buffer、全局 process |
| `host/platform/secrets/backup-crypto.ts` | 2 | node:crypto、node:fs、node:path、全局 Buffer、全局 process |
| `host/plugins/backup/api.ts` | 2 | node:crypto、node:dns、node:fs、node:os、node:path、node:stream、node:timers、node:zlib、全局 Buffer、全局 process |
| `host/plugins/sync-providers/api.ts` | 2 | node:crypto、node:dns、node:fs、node:os、node:path、node:stream、node:timers、node:zlib、全局 Buffer、全局 process |
| `host/plugins/mcp/api.ts` | 2 | node:child_process、node:crypto、node:dns、node:fs、node:path、全局 Buffer、全局 process |
| `host/platform/util/qr.ts` | 2 | node:zlib、全局 Buffer |
| `host/platform/zip/index.ts` | 2 | node:fs、node:stream、node:zlib、全局 Buffer |
| `scripts/electron-migration/record/scenario-v0.mjs` | 2 | 原生 better-sqlite3、node:child_process、node:crypto、node:fs、node:path、node:url、node:zlib、全局 Buffer、全局 process |
| `host/plugins/vfs-handlers/api.ts` | 1 | 原生 better-sqlite3、node:crypto、node:fs、node:os、node:path、node:url、node:worker_threads、node:zlib、全局 Buffer、全局 process |


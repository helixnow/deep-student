import { bootstrapWebClient } from './bootstrap.ts';

// 外壳与入口并行：`bootstrapWebClient()` 在同一 tick 内同步装好
// `window.__TAURI_INTERNALS__` / `__DS_PLATFORM__` 与 Tauri 桥，随后才开始
// 异步鉴权 + WebSocket 握手；动态 import 的模块求值一定发生在之后的任务里，
// 因此桥的安装顺序不变，连接前发出的 invoke 由 bootstrap 的 outboundQueue
// 排队、socket open 后立即冲刷。公网（RTT 150–250ms）下应用入口 chunk 的
// 下载与握手就此重叠，首屏少等一整段 chunk 下载时间。
//
// 这里刻意**不用** top-level await：入口是 HTML 的同步模块脚本，TLA 会让它
// 长期停在「正在评估」；而 Rollup 的 `output.experimentalMinChunkSize` 可能
// 把应用 chunk 共享的小模块并进入口 chunk，使应用 chunk 反向静态 import 本
// chunk——此时 `import()` 形成异步环，双方互等直至永久白屏（实测）。
bootstrapWebClient();
void import('virtual:dstu-web-app-entry');

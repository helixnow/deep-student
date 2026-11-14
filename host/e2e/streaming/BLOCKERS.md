# X5 当前阻塞

- **D38 / WP-089，open**：`fixed-https/` 已有逐实例 CONNECT/TLS 服务、B Node 真实 IlinkClient 三次请求原件。A 无可运行录件；当前 reqwest 0.11.27 只有 webpki roots，不能凭 `SSL_CERT_FILE` 信任本地 CA。需要 X7/构建维护提供同一 A 构建的 `rustls-tls-native-roots` 与相应锁依赖，证实 Linux 每进程 PEM 信任；精确源码与命令见 `fixed-https/README.md`。不改 Rust 业务、不导入全局证书、不禁 TLS。Electron utilityProcess preload 转发亦待 X1/F2 实测。未宣称 A/B 或登录成功。
- **X5-01/03，L03 外层取消 Drop**：已关闭。基线 `ae4efdf9e` 上 `cancel-after-partial.test.ts:137` 已是九条（tool-loop 的 sink 在取消后不再转发，等价 Rust 丢弃 future 后发不出 `{stream}_cancelled`），原断言未改；旧红记录见 job `20261105173500-9bb479`。W05 把同一语义抽成 `chat-pipeline/src/stream-watchdog.ts` 的 `runStreamWithWatchdog` / `sinkUntilAbandoned`，补到变体与 prepared 文本路径（`chat-pipeline/tests/variant-stream-cancel.test.ts`、`unified-text-stream.test.ts`）。
- 工具第二轮仍缺测试宿主实际 `chatToolRuntime` owner 接线；retry/变体/Electron 全链完整 parity 未签。旧细节见 LANE/TESTMAP 与 audit 历史。

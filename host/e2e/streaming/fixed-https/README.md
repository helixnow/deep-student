# WP-089：固定 HTTPS iLink 的独立模拟接缝

**已实测：B 的生产 IlinkClient（Node），非 Electron IPC/登录成功；A 尚 blocked，D38 open。**
这里是外部服务模拟，返回值绝不充当 Rust 答案或登录 golden。

## 复跑 B

在 X5 工作树根执行；需要现成 Node（本次 v26.5.0）、OpenSSL（本次 3.0.20）和仓库已有 undici。不安装依赖、不构建 Rust。

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/streaming/fixed-https/run.ts -- node --import ./host/e2e/streaming/fixed-https/node-proxy.mjs host/e2e/streaming/fixed-https/probe-b.ts
```

每次 launcher 创建一个 `127.0.0.1:随机端口` 的 CONNECT 代理、一个独立 TLS 服务和一个权限 0700 的 `/tmp/opencode/x5-ilink-*` 目录。A1/A2/B1/B2 **各起一次 launcher**；它们执行同一固定服务程序、互不共享证书/端口/日志/游标。stdout 首行 `ready/dir/proxy`，末行 `dir/ok/code/signal`。

`probe-b.ts` 通过 F1 `kernel/api.ts` 调用真实 `new IlinkClient()`，没有传 `fetch` 或改 URL：

1. `getBotQrcode()` → `GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3`
2. `getQrcodeStatus(qr.qrcode)` → 相同固定域，保留 RFC3986 编码（含 `!'()* /+中文`）
3. `getUpdates(credentials,35000)` → `POST /ilink/bot/getupdates`，凭证 baseUrl 为空，走生产默认固定域。只有显式的离线测试 token。

Node preload 只给该子进程设置现成 undici `ProxyAgent`，`requestTls.ca` 指向该实例 CA，`rejectUnauthorized:true`，仍由运行时真实 fetch 发请求、生产代码解码。它不是被测客户端的替身；不得将 preload 加进正式 Host 启动配置。Electron utilityProcess 需 X1/F2 将同等 preload/CA 配置送到实际 Host 进程；本包没有验证 Electron 的参数传递，不能以 Node 结果声称 GUI 已通。

## 隔离、原件与释放

- 子环境覆盖大/小写 HTTP(S)/ALL_PROXY，NO_PROXY 清空；不继承父进程的 NODE_OPTIONS、额外 CA、TLS 绕过开关。HOME/XDG_CONFIG/DATA/CACHE/RUNTIME/TMPDIR 都是实例私有目录。父环境不变；cwd 仍为本工作树，生产源码只读。
- 代理仅接受 `CONNECT ilinkai.weixin.qq.com:443`，只连接自身 loopback TLS 端口，不解析公网 DNS、不转发其他域。TLS 叶证书 SAN 仅为这个域，逐实例 CA 签名；不写 hosts、系统 DNS、系统/用户全局证书库。不关闭 TLS 校验。
- `requests.jsonl` 顺序记录实际 method、未解码 path/query、Host、SNI、HTTP 版本、rawHeaders（保留顺序/大小写/重复）和 `bodyBase64`（HTTP entity 原字节，不经 JSON.parse/UTF-8 转换）；同时记录响应状态/原文。HTTP chunk framing 由 Node parser 处理，不将该日志声称为 TCP 抓包。生产随机 `x-wechat-uin` 保留，没有 normalize。
- `transport.jsonl` 保留 CONNECT authority/rawHeaders、TLS/连接/解析/非脚本请求错误和 stopped。`config.json` 保留端点配置；`child.stdout`/`child.stderr` 有输出时创建；`result.json` 显式记录退出码/信号/故障/请求数。子进程失败、零流量、服务故障均不会报 ok。
- 子进程正常/异常退出后停止实例端口、销毁连接、删除本实例 `tls/`（含 CA/私钥）。SIGTERM/SIGINT 转发到本次子进程组后执行同样清理；launcher 自身被 SIGKILL 时无法执行 finally，现场目录需操作方按其准确路径清理。应用 HOME 和日志保留供差分审计，不自动删除证据。
- 这是代理配置隔离，不是 OS 网络沙箱。只有遵守代理配置的 HTTP 客户端受此接缝控制；本包只运行已验证的 F1 客户端，不启动未知联网插件。零流量失败能暴露未接线，但不应据此宣称任意应用所有网络已隔离。

程序接口：`startIlinkService(parent?) → {dir,caFile,proxyUrl,targetPort,env,requests,faults,stop()}`。
调用方用返回的 `env` 启动独立后端进程，`finally await stop()`；不要 `Object.assign(process.env, env)`。`runIsolated(command,args,parent?)` 封装了同一生命周期，Linux 子进程组释放语义已测。

## 确定性脚本边界

| 请求 | 固定响应 |
|---|---|
| GET `get_bot_qrcode?bot_type=3` | 明显的离线测试字符串 QR，图像字段为 `x5-offline-not-a-login` |
| GET `get_qrcode_status?qrcode=<返回值的精确编码>` | `{"status":"wait"}`，无确认、真实 token 或自动启用 |
| POST `getupdates` | 固定空 msgs / `x5-fixed` cursor，立即响应；仅检验 POST 传输，不是 long-poll 时序模拟 |
| 其他路径/方法/Host | 501/421，记失败；不回退到公网 |
| GitHub/codeload/clawhub 等其他 CONNECT | 403，记失败；响应协议留后包 |

相同请求落到同版本固定服务，返回同字节；无基于次数的全局状态。此最小脚本没有覆盖 QR 刷新/确认/登录超时/消息业务/skill ZIP/market。

## A 阻塞：需要维护提供的精确接口

源码 `src-tauri/src/plugins/ilink_bot/client.rs:137–141` 使用默认 `reqwest::Client::builder()`，154–196 固定 HTTPS；已有 reqwest 系统代理支持可消费 `HTTPS_PROXY`，无 URL 改动需求。但：

- `src-tauri/Cargo.toml:157` 的 reqwest 0.11 开 `rustls-tls`（webpki roots）。
- 锁文件 `Cargo.lock:10371–10412` 的 0.11.27 依赖里没有 `rustls-native-certs`。另一个 object_store 使用 **reqwest 0.12** 的 native-roots，不能给 0.11 合并 feature。
- 本机只读 reqwest 0.11.27 `src/async_impl/client.rs:459–507`：只有 `rustls-tls-native-roots` 分支调用 `rustls_native_certs::load_native_certs()`；当前 builder 没有注入额外 `Certificate`。因此不能声称 `SSL_CERT_FILE` 已作用于现有 A。

请 X7/构建维护在其已授权范围提供 **同一 A 构建的 reqwest 0.11.27 `rustls-tls-native-roots` feature 和对应锁文件依赖**，确认 Linux native-certs 从该次子环境 `SSL_CERT_FILE=<实例CA>` 读取 PEM，仍执行签名链+域名验证。接口契约是已有进程环境 `HTTPS_PROXY/NO_PROXY/SSL_CERT_FILE`，不新增 Rust 业务 feature、不改 hard-coded URL、不加 danger_accept_invalid_certs；本 lane 不改 Cargo 文件。若维护不授权此构建配置，则 A 继续 blocked，不以系统证书导入替代。

A 可运行且维护证实 CA 接缝后，X7 可 `run.ts -- <A录制入口> <参数>` 启动：沿真实前端 invoke 录制 F1 命令及事件/终态，消费同一个 fixed-https 服务，再核原始请求；launcher 已准备好该环境，但本包没有运行 A、没有 Rust 动态 CA 证据。A 的实际 dataLocalDir 等仍须 X7 的隔离入口确认。

## 本次原件

`evidence/B1.requests.jsonl`、`B1.stdout.jsonl` 是 job `20261105173827-caa449` exit0 原件的逐字副本（cmp 一致）；`B1.result.json` 内容同原件，末尾加换行。原目录 `/tmp/opencode/x5-ilink-7WFOYV`；当时 HEAD 为 `d43e72fc3`，本包新增源随后由 `a1bbdcc94` 自动检查点保存。此正常退出原件先于后续 ready/SIGTERM 修复，不用于声称旧版信号释放通过。B 生产客户端三次请求，非 A 答案。测试另覆盖两个同时运行的独立实例、TLS 负向、字节保真、拒绝未支持域、退出与信号释放。

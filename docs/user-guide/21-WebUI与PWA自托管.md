# WebUI 与 PWA 自托管

> 在自己的电脑或服务器上运行 Deep Student Host，用任意现代浏览器或手机主屏幕 PWA 随时访问完整学习工作台，数据依然完全掌握在你自己手里。

## 功能概览

除了安装桌面客户端和 Android APK，Deep Student 还支持以 **WebUI + PWA** 形态自托管运行：后端在 Node.js 中运行与桌面端一致的完整 Host，前端零删减地运行在浏览器里，通过加密会话与 WebSocket 与后端通信。

典型使用场景：

- **跨设备无感访问**：在家里的电脑、NAS 或私有云服务器上运行一份 Deep Student，出门用平板、公司电脑或 iPhone / Android 浏览器直接打开自己的全部资料、闪卡与工坊插件；
- **主屏幕 PWA 体验**：在桌面浏览器或手机主屏幕安装为独立应用窗口，带快捷方式、系统文件关联与无感更新提示；
- **零重型编译依赖**：纯 Node.js 运行，无需安装 Rust 或 Tauri 工具链。

## 运行前提与单实例互斥

- **运行环境**：需要 **Node.js 24+**（无需 Rust / Tauri）。
- **单实例互斥锁（`.host-instance.lock`）**：同一份应用数据目录会由 `.host-instance.lock` 文件做排他互斥保护。**不能**在 Electron 桌面版打开同一数据目录的同时启动 WebUI，否则后启动的一方会因锁冲突被拒绝，避免损坏本地数据库。
- **如何与桌面版并行运行**：如果你希望桌面版与 WebUI 同时跑在各自独立的空间里，启动 WebUI 时通过 `DS_APP_DATA_DIR` 环境变量指定一个独立的数据目录即可。

## 启动与自托管命令

在项目根目录执行以下命令即可启动：

### 开发模式

```bash
npm run web
```

同进程挂载 Vite 热更新，默认监听 `http://127.0.0.1:1428`。

### 生产构建与启动（推荐自托管）

```bash
npm run build:web && npm run web:prod
```

`npm run build:web` 会先将构建产物写入临时目录 `dist-web.next`，构建完成后再原子切换为 `dist-web/`，升级构建期间线上实例仍可平稳服务上一版静态资源。

### 自定义启动参数

也可以直接调用服务入口并传入命令行参数：

```bash
node web/server/main.ts --prod --host 0.0.0.0 --port 8080
```

支持的参数包括 `--host`、`--port`、`--prod` 与 `--no-auth`（关闭令牌校验，**仅限完全可信的本机或受控内网环境**）。

### 核心环境变量

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DS_WEB_HOST` | `127.0.0.1` | 监听地址；局域网或公网反代部署时可设为 `0.0.0.0` 或 `::` |
| `DS_WEB_PORT` | `1428` | 监听端口 |
| `DS_WEB_TOKEN` | 随机 48 位十六进制 | 固定访问令牌；长期自托管强烈建议显式设置强随机值 |
| `DS_WEB_NO_AUTH` | 未设置 | 设为 `1` 关闭令牌鉴权（等价 `--no-auth`），仅限可信本机环境 |
| `DS_APP_DATA_DIR` | 系统默认应用数据目录 | 自定义数据目录（暂存与导出目录也建在其下），用于与桌面端并行隔离 |
| `DS_WEB_TRUST_PROXY` | 未设置 | 设为 `1` 时采信反向代理写入的 `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Forwarded-For`；未设置时仅对回环来源采信 |

## 访问鉴权与安全机制

- **访问令牌**：未指定 `DS_WEB_TOKEN` 时，每次启动都会随机生成一段 **48 位**十六进制令牌，并在终端输出带令牌的一次性访问链接：`http://<host>:<port>/?token=<token>`。
- **一次性登录与 30 天安全 Cookie**：
  - 首次通过 `/?token=...` 打开（或在内联登录页手动输入令牌）后，服务端会下发有效期 **30 天**的 `HttpOnly + SameSite=Strict` 会话 Cookie（HTTPS 或受信代理的 HTTPS 下自动附加 `Secure` 属性）；
  - 登录完成后前端会**自动擦除地址栏中的 `token` 参数**，防止误截屏泄露或留在浏览器历史记录中。
- **爆破限流保护**：同一客户端在 **60 秒内认证失败 15 次**，服务端会立即返回 **HTTP 429** 并临时封禁，直至最早一次失败记录滑出时间窗口，保护自托管实例免受暴力探测。

## 反向代理配置要点（Nginx / Caddy / Traefik）

如果你通过域名对外暴露自托管 WebUI，反向代理必须满足以下 **4 条必备要求**：

1. **透传真实 `Host`（或开启 `DS_WEB_TRUST_PROXY=1`）**：登录、文件暂存与 WebSocket 升级均会执行严格同源检查；如果反代改写了 `Host` 头，必须设置 `DS_WEB_TRUST_PROXY=1` 并透传 `X-Forwarded-Host`、`X-Forwarded-Proto` 与 `X-Forwarded-For`，否则请求会被同源检查拒绝（HTTP 403）。
2. **透传 `/api/ws` WebSocket 升级头**：确保 `/api/ws` 正确转发 `Upgrade` 与 `Connection: upgrade`，并调大长连接读写超时（例如 3600 秒），避免正常保活连接被代理提前掐断。
3. **透传 `Range` 且关闭响应缓冲**：让 PDF 阅读器与音视频播放器的 **HTTP 206** 分片流式读取直通浏览器，避免大文件被代理缓冲或退化为整包下载。
4. **启用 HTTPS**：现代浏览器仅在 `https://`（或本机 `http://localhost`）安全上下文下允许注册 Service Worker 和安装 PWA，同时保证会话 Cookie 自动启用 `Secure` 保护。

以下为 Nginx 参考片段（请按实际域名和端口调整）：

```nginx
server {
    listen 443 ssl http2;
    server_name study.example.com;

    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 210m;

    location /api/ws {
        proxy_pass http://127.0.0.1:1428;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:1428;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Range $http_range;
        proxy_buffering off;
    }
}
```

## PWA 安装与使用

生产构建在 HTTPS（或 `http://localhost`）下会自动注册 Service Worker，支持以 PWA 形态使用：

- **安装入口**：
  - **桌面浏览器（Chrome / Edge 等）**：满足安装条件时，页面右下角会弹出「安装到桌面」胶囊（也可点击地址栏右侧安装图标）；
  - **手机浏览器（iOS Safari / Android Chrome）**：通过浏览器分享/菜单栏选择 **「添加到主屏幕」**，即可作为独立全屏应用启动。
- **3 个快捷方式**：安装后长按应用图标，可直达 **「新建对话」**（`/?shortcut=chat`）、**「资源库」**（`/?shortcut=library`）或 **「复习」**（`/?shortcut=review`）。
- **系统文件关联**：在支持的桌面浏览器上安装为 PWA 后，可关联 `.pdf`、`.md`、`.apkg` 文件；在系统文件管理器中双击即可直接导入到你的 Deep Student 资源库。
- **无感更新提示**：你重新构建并重启生产服务后，浏览器会在后台静默拉取新版应用壳，不会打断当前阅读或编辑，而是在界面温和提示「刷新启用」，由你决定何时切换。
- **桌面壳 / 移动壳手动切换**：手机浏览器访问时默认启用移动端抽屉/分屏壳，电脑浏览器默认启用桌面布局；你随时可以在网址末尾追加 `?shell=mobile` 或 `?shell=desktop` 手动指定壳形态。

## 功能支持与边界清单

### 支持的核心能力

- **多标签页共享同一 Host**：同一浏览器里打开多个标签页会复用后端同一个 Host 状态，会话与数据实时一致。
- **200 MiB HTML5 拖放上传**：直接把教材、音视频或资料拖进网页窗口即可上传入库（单文件上限 **200 MiB**）。
- **30 分钟安全导出链接**：导出备份、笔记 DOCX、字幕或资源文件时，服务端生成 **30 分钟**有效的受鉴权下载链接。
- **HTTP 206 流式 PDF / 音视频**：无论桌面浏览器还是手机 Safari / Chrome，打开大 PDF 与音视频均走 HTTP 206 分片流式读取，不退化为整文件传输。
- **完整学习与扩展能力**：AI 对话、资源库、阅读翻译、笔记、思维导图、音视频、题目集、FSRS-6 闪卡、技能、远程 MCP、**AI 插件工坊与插件管理**、微信 iLink Bot 渠道配置等均完整可用。

### 当前明确不支持 / 平台差异

- **不支持纯离线读写**：当前已落地形态为 **Remote-Host App-Shell PWA**——浏览器仅缓存应用界面壳，断开与后端 Host 的网络连接后无法读写资料库、对话或文件流。
- **不支持桌面原生外壳与学习桌面**：WebUI 采用经典侧栏布局（不使用窗口化学习桌面），也不支持内嵌原生浏览器 / 浏览器自动化、桌面原生多窗口、系统全局快捷键（快速学习小窗）、应用内自动更新与系统原生通知。
- **隐藏 A/B 数据空间切槽**：数据治理「恢复」页签中不显示 A/B 槽位切换（请使用本地备份列表与加密 ZIP 导出/导入）。
- **手机浏览器访问时隐藏 FTP 同步**：桌面浏览器访问自托管 WebUI 支持 WebDAV / S3 / 实验性 FTP，手机浏览器访问时界面隐藏 FTP（仍支持 WebDAV 与 S3）。

## 常见问题

**Q：同时开着桌面版 Deep Student 再跑 `npm run web` 为什么报错？**
A：桌面版与 WebUI 默认读写同一个应用数据目录，`.host-instance.lock` 互斥锁会阻止双进程同时打开以免损坏数据库。请先关闭桌面版，或为 WebUI 设置独立的 `DS_APP_DATA_DIR`。

**Q：我通过内网 IP（例如 `http://192.168.1.10:1428`）打开网页，为什么看不到「安装到桌面」或无法安装 PWA？**
A：浏览器的安全规范限制 Service Worker 与 PWA 安装只能在 `https://` 或本机 `http://localhost` 生效。请为内网或公网服务套一层 HTTPS 反向代理（如 Caddy / Nginx）。

**Q：忘了启动时随机生成的访问令牌怎么办？**
A：查看启动进程的终端输出即可找回本次随机令牌；如果是长期后台运行，建议通过 `DS_WEB_TOKEN` 环境变量配置固定强令牌后重启服务。

**Q：WebUI 里能打开多个独立窗口吗？**
A：受浏览器模型限制，WebUI 内部采用经典单页布局而非窗口化学习桌面，但你可以在浏览器里同时打开多个标签页共享同一个后端 Host，例如一页看资料、一页做笔记或对话。

## 延伸阅读

需要深入了解 WebUI 的架构分层、安全校验细节、Service Worker 缓存策略与公网延迟优化，请参阅开发者文档：

- [WebUI 与 PWA 架构与技术规格（WEBUI-AND-PWA.md）](../WEBUI-AND-PWA.md)

<!-- 基于 v0.20.7 代码核对，2026-11-21：新建第21章 WebUI 与 PWA 自托管；涵盖 Node 24+ 与 .host-instance.lock 互斥、开发/生产命令与核心环境变量、48 位令牌与 30 天 Cookie / 429 限流、反代四要点、PWA 安装/快捷方式/文件关联/?shell=mobile|desktop 与完整支持/边界清单 -->

# DeepStudent 微信 iLink 接入调研

本调研针对仓库中的 `ilinkbot` 插件（用户所称的 ibotlink）完成于 2026-09-27。目标是把微信作为 DeepStudent 的远程学习入口，而不是替换 DeepStudent 现有的 ChatV2 任务执行系统。

## 开源项目与协议证据

- [OpenClaw 微信渠道文档](https://github.com/openclaw/openclaw/blob/main/docs/channels/wechat.md) 将微信实现放在外部 `@tencent-weixin/openclaw-weixin` 插件中。插件负责 Tencent iLink API、媒体上传/下载、`context_token` 和账号监控；OpenClaw 核心只负责统一渠道契约、Agent 路由和出站回复。文档还说明插件需要独立安装、扫码登录，并记录过 2.4.8 修复已废弃 `openclaw/plugin-sdk/channel-runtime` 导入的问题。文档没有把该包源码放入 OpenClaw 核心仓库，因此 DeepStudent 不应嵌入整套 OpenClaw runtime。
- [epiral/weixin-bot](https://github.com/epiral/weixin-bot) 的 [`PROTOCOL.md`](https://github.com/epiral/weixin-bot/blob/main/PROTOCOL.md) 提供了可复核的 iLink 协议参考。2026-09-27 通过 GitHub API 查询到仓库未声明 SPDX 许可证，不能把它当作可直接复制的依赖。协议确认：二维码状态为 `wait`、`scaned`、`confirmed`、`expired`；POST 需要 `AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>` 和 `X-WECHAT-UIN`；`getupdates` 是约 35 秒长轮询；回复必须回显入站消息的 `context_token`；用户消息 `message_type=1`，机器人消息 `message_type=2`。媒体接口和 AES-128-ECB CDN 加解密属于后续扩展范围。
- [Wechaty](https://github.com/wechaty/wechaty) 适合做通用机器人抽象，但依赖 Puppet（例如 Puppeteer、wechat4u、Padchat 或 iOS 实现）来连接微信。GitHub API 查询到其许可证为 Apache-2.0。它与 iLink API 不是同一传输协议，引入会增加 Node/Puppet 运行时和账号兼容性成本。
- [WeChatFerry](https://github.com/lich0821/WeChatFerry) 是 PC Hook/TCP 方向的替代方案，GitHub API 查询到其许可证为 MIT。它依赖特定桌面微信客户端和 Hook 运行环境，不适合作为当前跨平台 Tauri 主链路的第一选择。

## 适合 DeepStudent 的分层

```text
WeChat iLink
  -> Rust 通道适配器（二维码、认证、长轮询、重试、context_token）
  -> RemoteBinding / TaskCommand（账号、设备、会话、任务代次）
  -> ChatV2 headless（现有只读知识库和学习任务能力）
  -> 文本分片回复
```

DeepStudent 已经具备 `TaskCommand -> ChatV2 headless` 路径，普通文本可以使用记忆、RAG 和只读搜索能力。因此本分支修复现有通道的生命周期和错误处理即可形成较好的入口，不需要另起一个微信专用 Agent 后端。写文件、执行命令和远程审批继续要求回到桌面端确认。

## 本分支处理的故障

1. `reqwest::Error::is_request()` 不能当作长轮询超时。DNS、连接和 TLS 错误现在会进入重试/错误路径，不再伪装成 `ret=0` 的空消息。
2. 扫码取消或重复登录没有保存凭证时不会自动开启轮询；运行代次保护避免旧连接退出时删除或覆盖新连接。
3. 远程任务的会话附着和完成回写校验 generation，迟到的旧 turn 不会覆盖新 turn。
4. `/stop`、`/status`、`/help` 和审批提示绕过普通消息限流；停止先取消会话流，再发送微信回执。
5. 插件停用、退出和扫码取消会传播同一个取消令牌，运行中的 headless turn 不会在入口关闭后继续发送迟到回复。
6. 设置页区分状态刷新和配置刷新，二维码事件不再伪造扫码状态；错误状态提供重新连接入口，并显示桌面在线、扫码验证和文本命令说明。

## 暂不接入

图片、语音、视频和文件需要完整实现 `getuploadurl`、CDN 加解密、下载和消息项解析；本分支保持文本入口清晰可用，后续应以协议参考逐项增加并配套端到端测试。

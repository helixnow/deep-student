# Deep Student UI Drive（移动 UI 审查工具）

Playwright MCP / browser MCP 风格的本地 UI 驱动，专门给 **Electron 开发版 + 手机比例窗口** 用。

## 一键启动

```bash
npm run ui:lab
# 可选机型预设
npm run ui:lab -- android-compact
npm run ui:lab -- iphone-15-pro
```

会做两件事：

1. 启动 `ui-bridge-server`（`127.0.0.1:17423`；并行多实例时用 `DS_UI_BRIDGE_PORT` 换端口，应用侧对应 `VITE_DS_UI_BRIDGE_PORT`，驱动侧 `DS_UI_BRIDGE_URL`）
2. 以 `config/dev-phone-window.json` 里的手机比例启动 `VITE_DS_UI_BRIDGE=1 npm run dev:electron`

停止：

```bash
npm run ui:lab:stop
```

## Cursor MCP（推荐）

在 **Settings → MCP** 添加：

```json
{
  "mcpServers": {
    "dstu-ui-drive": {
      "command": "node",
      "args": ["scripts/dev/mcp-ui-drive.mjs"],
      "cwd": "/Volumes/cipan/deep-student"
    }
  }
}
```

启用后 AI 可直接调用工具，无需每次写 shell 脚本：

| 工具 | 作用 |
|------|------|
| `ui_status` | 桥是否连上、窗口 ID |
| `ui_snapshot` | 可交互元素快照（稳定 ref：`e1`…） |
| `ui_click` | 点 ref / 文本 / `css=` 选择器 |
| `ui_type` | 输入框填字 |
| `ui_scroll` / `ui_swipe` | 滚动 / 滑动手势 |
| `ui_back` | 安卓返回键语义 |
| `ui_screenshot` | **窗口级截图（无视遮挡）** |
| `ui_errors` | 控制台 error/warn |
| `ui_resize` | 改窗口逻辑尺寸（切移动/桌面断点） |
| `ui_devices` | 预设机型尺寸 |
| `ui_wait` | 等待动画/导航 |
| `ui_eval` | 高级：任意 async JS |

典型流程（给 AI 的提示词）：

> 先 `ui_status`，再 `ui_snapshot`，用 ref 做 `ui_click`，每步后 `ui_screenshot` + `ui_errors`。

## CLI（无 MCP 时）

```bash
npm run ui:drive -- status
npm run ui:drive -- snapshot --text
npm run ui:drive -- click "我已阅读并同意"
npm run ui:drive -- click e12
npm run ui:drive -- type css=textarea 你好 --enter
npm run ui:drive -- shot home
npm run ui:drive -- resize 400 880
npm run ui:drive -- devices
```

截图目录：`DS_SHOT_DIR`（默认 `/tmp/ds-mobile-audit/shots`）。

## 架构

```
Cursor / CLI (ui-drive / MCP)
        │ HTTP POST /eval
        ▼
ui-bridge-server.mjs  ←──WebSocket──→  uiAutomationBridge.ts
                                              │
                                         window.__DS_BRIDGE__
                                              │
                                         React App (dev)
```

- **WebView 内**：`src/dev/uiAutomationBridge.ts` 暴露快照/点击/输入/滚动等
- **macOS 截图**：`screencapture -l <windowId>` 只截 Deep Student 窗口，不受其他窗口遮挡
- **CSP**：审查会话用 `config/dev-phone-window.json` 临时放开 `'unsafe-eval'`；仓库默认 CSP 不变

## 与 tauri-plugin-mcp 的区别

| | dstu-ui-drive | tauri-plugin-mcp |
|--|---------------|------------------|
| 启用 | `VITE_DS_UI_BRIDGE=1` + dev | Rust feature `mcp-debug` |
| 依赖 | 纯 Node + WebSocket | tauri-plugin-mcp-bridge |
| 截图 | 窗口级 screencapture | 无 |
| 移动手势 | swipe / tap / back | 部分 |

日常移动 UI 审查用 **dstu-ui-drive** 即可。

## 机型预设

| 名称 | 尺寸 | 说明 |
|------|------|------|
| android-compact | 360×800 | 窄屏 |
| android-default | 400×880 | 默认 |
| android-large | 432×960 | 大屏 |
| iphone-se | 375×667 | 小屏 |
| iphone-15-pro | 393×852 | |
| breakpoint-edge | 767×1024 | 移动断点上沿 |
| tablet-portrait | 768×1024 | 平板竖屏 |

## ds-test：真机测试通用驱动（推荐）

`scripts/dev/ds-test.mjs` 在桥之上提供「不会把测试卡住」的命令：每条命令有超时（`--timeout` 秒，默认 20），
失败以非零码退出并输出一行 JSON 原因；点击默认精确匹配、歧义时列出候选；等待一律是「等到条件成立」
（长等待每 5 秒打进度）；输入走受控组件可识别的原生 setter 并回读校验。

```bash
scripts/dev/ds-test.mjs status                      # 桥 / 窗口 / 页面是否可用
scripts/dev/ds-test.mjs snap '翻译'                  # 按名称过滤的可交互元素
scripts/dev/ds-test.mjs open 语法笔记_虚拟语气        # 学习资源里打开并确认标签激活
scripts/dev/ds-test.mjs menu 考研英语核心词汇 用这份资料制卡
scripts/dev/ds-test.mjs send                         # 发送输入框现有内容（空则拒发），确认气泡出现
scripts/dev/ds-test.mjs answer 每词一张 --timeout 30  # 回答提问卡片，确认后端已收到
scripts/dev/ds-test.mjs select 'The letter arrived'  # 页面或同源 iframe 中划词
off=$(scripts/dev/ds-test.mjs mark | jq .offset)
scripts/dev/ds-test.mjs wait-log '生成的卡已加入复习' --since $off --timeout 300
scripts/dev/ds-test.mjs shot epub --crop 684,40,515,60   # 裁剪坐标为 CSS 像素
```

日志位置默认 `~/Library/Logs/com.deepstudent.app/deep-student.log`（`DS_APP_LOG` 覆盖），按字节偏移读取，
不受时区与行号影响。

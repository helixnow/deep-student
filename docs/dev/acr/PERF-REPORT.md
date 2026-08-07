# ACR PERF-REPORT — R3-02 性能压测与调优

日期：2026-07-10  
对照：`DESIGN.md` §7 · `SCENARIOS.md` S-PERF-01..04 · `progress/R2-07.md`（Channel 暂不实施）  
方法：**代码审计 + 既有 perfMonitor / DevPanel 钩子走查**；运行时 DevPanel 数值标「待协调者采样」。

---

## 1. 预算对照总表（DESIGN §7）

| 预算项 | 预算 | 审计结论 | 运行时 | 判定 |
|---|---|---|---|---|
| 演出期间用户交互 | p75 INP ≤200ms；无 >100ms 输入阻塞长任务 | 词级批 + rAF 合帧 + 仲裁 pause；无每字符 dispatch | **待协调者采样** | 审计 PASS；INP 待测 |
| presence/flash 动画 | 60fps，掉帧率 <5%；只用 transform/opacity | R3-02：flash 改 `::before`+opacity；批量仅末项 scroll | **待协调者采样** | 审计 PASS（调优后） |
| 打字机 | 词级批 8–40；rAF；禁每字符 dispatch；`addToHistory:false` | `splitTextIntoBatches` + `typeIntervalMs` tick；流式 meta 已关 history | **待协调者采样** | PASS |
| 导图 | 禁每 op fitView；setCenter 节流；edges 禁 animated | `VIEWPORT_FOLLOW_EVERY=5`；收尾一次 fit；`onlyRenderVisibleElements`；edge 无 animated | **待协调者采样** | PASS（调优后） |
| IPC | 桥低频；progress ≤5Hz；单消息 <8KB | `emitAcrProgress` 200ms 尾随；Channel **仍不实施**（见 §5） | **待协调者采样**（载荷体积） | 审计 PASS |
| 多窗 | 同时演出 ≤2；background 直落；visible 非焦点降频 | `MAX_STAGED_WINDOWS=2` → 第 3 路 `forcePacerInstant`；`shouldInstantDrop` | **待协调者采样** | PASS |
| 工具反馈 | >300ms 工具 100ms 内 progress/presence；无假死 >1s | 首条 progress 立即发；presence 入场 | **待协调者采样** | 审计 PASS |
| 慢帧降级 | 连续帧 >33ms → fast | `advanceSlowFrameStreak` ×3 → `degradeAllActivePacers` | **待协调者采样** | PASS |

---

## 2. 压测路径走查

### P1 — 双窗并发演出 + 焦点窗拖拽（S-PERF-01）

| 项 | 内容 |
|---|---|
| **构造** | 两笔记/导图窗 visible；pacing=normal；对 A/B 同时长 `apply_ops`；再对 C 发起第三路；拖拽焦点窗标题栏 |
| **代码路径** | `stageManager.applyStagingGates`：非 instant 占槽；`countStagingRuns()≥2` → 第三路 instant + presence「演出槽满，直落」；心跳 `HEARTBEAT_MS=3000` `requestWakePrefetch` + `reportSchedulerActivity('stream')` |
| **期望指标** | 活跃 staging ≤2；fps≈60；拖拽时无 >1s 假死；第三路 completed（直落） |
| **审计** | PASS |
| **运行时** | **待协调者采样** |

**协调者步骤**

1. 设置开 `desktop.workbenchDevPanel` + `desktop.workbenchAgentControl=follow` + feature `tools.workbench_agent`。
2. 开两笔记窗，chat 同时对两窗追加长文；再对第三窗追加。
3. 演出中拖拽焦点窗；读 DevPanel：fps / 掉帧 / 长任务 / ACR 活跃 run / presence。
4. 判定：staging 呼吸光环 ≤2；第三路无卡死；掉帧率 <5%（采样窗内 dropped/sampledFrames）。

### P2 — 200 节点导图逐 op 生长

| 项 | 内容 |
|---|---|
| **构造** | 空/小图；`apply_ops` 连续 `add_node` ×200；pacing=normal |
| **代码路径** | `mindmapDriver`：每 op `markEntering` + `expandToNode`；视口每 **5** op `setFocusedNodeId`→`ensureNodeVisible`（非 fitView）；结束一次 `requestAgentFitView`；canvas `onlyRenderVisibleElements`；`defaultEdgeOptions` 无 `animated` |
| **期望指标** | 生长中 fps≥45（允许短时掉到 30 后触发降 fast）；掉帧率 <5%（降级后应回升）；无每 op fitView |
| **审计** | PASS（R3-02 将跟随从 4→5） |
| **运行时** | **待协调者采样** |

**协调者步骤**

1. 开导图窗聚焦；DevPanel 开。
2. chat：`在导图上从根节点连续添加约 200 个子节点（或等价批量 add_node）`。
3. 记录生长中段（约 50–150 节点）与收尾的 fps / dropped / longTasks；确认控制台无密集 fitView。
4. 若连续慢帧，确认 pacer 降为 instant（日志 `[acr:pacing] force instant (perfMonitor-slow-frames)`）。

### P3 — 5k 字笔记打字机 + 用户同时输入（S-PERF-02）

| 项 | 内容 |
|---|---|
| **构造** | 焦点笔记窗打字机插入 ≥5000 字；用户在**同窗或非目标窗**输入 |
| **代码路径** | `noteDriver.splitTextIntoBatches(8–40)`；`agentInsert` 按批；`addToHistory:false`；`run.checkPaused` + inputProbe 仲裁；progress ≤5Hz |
| **期望指标** | p75 INP ≤200ms；无 >100ms 输入阻塞长任务；词级批可见；掉帧率 <5% |
| **审计** | PASS（批处理与仲裁已就位） |
| **运行时** | **待协调者采样**（INP 需 PerformanceEventTiming / 手测） |

**协调者步骤**

1. 对笔记发起 ≥5k 字 append（normal pacing）。
2. 演出中在非目标窗快速点击/输入；同窗输入应触发 pause（S-ARB）。
3. DevPanel 记 fps/dropped/longTasks；Chrome Performance：Interaction to Next Paint 或手测「点击→高亮」体感。
4. 判定：无假死 >1s；progress 事件间隔 ≥200ms（可在工具卡/网络事件侧观察）。

### P4 — 50 条 todo 批量创建 flash

| 项 | 内容 |
|---|---|
| **构造** | 后端一次创建 50 todo → `todo://changed` entityIds×50 → 列表 reload + flash |
| **代码路径** | `todoDriver` 域监听 → `agentFlashMany`（R3-02：仅末项 `scrollIntoView({behavior:'auto'})`）；CSS `::before`+opacity 600ms |
| **期望指标** | flash 期间 fps≈60；掉帧率 <5%；无 50 次 smooth 滚动 |
| **审计** | PASS（调优后；调优前判定为超预算风险） |
| **运行时** | **待协调者采样** |

**协调者步骤**

1. 开 todo 窗；chat/工具一次创建 50 条（或脚本灌库后由 agent 源域事件触发）。
2. 观察列表高亮：应几乎同时闪，滚动最多一次。
3. 读 DevPanel fps/dropped；目视无列表「抽搐」式 smooth 连滚。

---

## 3. 指标读数模板（协调者填）

| 场景 | fps | droppedFrames | longTasks | 掉帧率估算 | INP p75 | 备注 |
|---|---|---|---|---|---|---|
| P1 双窗+拖拽 | 待采样 | 待采样 | 待采样 | dropped/sampled | n/a | staging≤2 |
| P2 200 节点 | 待采样 | 待采样 | 待采样 | | n/a | 是否触发降 fast |
| P3 5k 打字机 | 待采样 | 待采样 | 待采样 | | 待采样 | |
| P4 50 todo flash | 待采样 | 待采样 | 待采样 | | n/a | |

掉帧率：`droppedFrames / sampledFrames`（perfMonitor 单窗样本）或 DevPanel 累计掉帧 / 曲线点数（粗估）。

---

## 4. R3-02 调优记录（问题 → 根因 → 修法）

### T1 — 50 flash 掉帧风险

- **问题**：批量 `entityIds` 逐条 `agentFlash` → 每条 `scrollIntoView({behavior:'smooth'})` + `background-color` 动画，易打穿掉帧预算。
- **根因**：N 次平滑滚动争抢主线程；background 动画触发布局/绘制，违反 §7「只用 transform/opacity」。
- **修法**：`agentFlashMany` 仅末项 scroll 且 `behavior:'auto'`；flash 改为 `::before` + opacity（保留 R3-03 `--acr-flash-ms` token）。接线 todo/files/fsrs/qbank 批量路径。

### T2 — 200 节点 setCenter 过密

- **问题**：每 4 op 视口跟随，200 op ≈ 50 次 `ensureNodeVisible`/`setCenter`。
- **根因**：节流取 DESIGN 中值偏密，大图生长时 RF 重算叠加。
- **修法**：`VIEWPORT_FOLLOW_EVERY` 4→**5**（仍在 3–5 合法区间）；禁每 op fitView 逻辑不变。

### T3 — DevPanel 未真正消费 perfMonitor 嵌套样本

- **问题**：订阅成功后停掉本地 rAF，但 `onSample` 只读扁平 `frameAvgMs`/`droppedFrames`，而真实 `PerfSample` 在 `sample.frame.*` → HUD 曲线/掉帧可能空白。
- **根因**：O10 落地后契约未对齐；动态 import 拼接路径脆弱。
- **修法**：解包 `sample.frame`；静态 `import('../core/perfMonitor')`；面板挂载时 `startPerfMonitor()`。

### 未改（审计已达标）

- 打字机批 8–40、progress 200ms、演出槽≤2、慢帧→fast、导图 `onlyRenderVisibleElements`、edges 无 animated。

---

## 5. Channel 再评估（承接 R2-07）

| 触发条件（R2-07） | 本轮审计 |
|---|---|
| 单次 `apply_ops` 载荷持续 >8KB 且桥等待占主导 | 未观测运行时；代码路径仍为「整批 IPC + 前端本地 pacing」 |
| 5k 节点批序列化 p95 >50ms | 压测主成本在 RF/DOM，非 IPC |

**结论：Channel 仍暂不实施。** 若协调者采样显示桥等待 / 序列化成为主导，再开独立卡。

---

## 6. 自验

- `npm run typecheck`：见 `progress/R3-02.md`
- vitest：`agentFlash` / `mindmapDriver` / `perfMonitor` / `pacing` / `bridge` / `stageManager` 等相关路径

---

## 7. 遗留

| 项 | 级别 | 说明 |
|---|---|---|
| DevPanel 四场景实测填表 §3 | P0（协调者） | 本代理禁 tauri dev |
| INP 仪器化（Event Timing） | P1 | 当前靠手测 + longTasks 代理 |
| 笔记全文虚拟化 | P2 | R2-07 已记；靠批+直落控压 |

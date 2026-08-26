# F：Finder / Learning Hub / 笔记静态审计

审计范围：主题仓 F（#176）及与 #160/#161、Finder 分桶、Learning Hub、笔记、
host buckets、Finder/Workbench 持久化有关的当前树状态。方法为只读静态核对；
未运行测试、未操作 Git/GitHub、未回放或合并任何提交。

## 结论

**PASS**

- #176 的 F 能力已经进入 0824：合入记录明确以含 #160/#161 的 F tip 为输入，并
  选择 F 的每宿主独立桶、偏好继承和活跃宿主机制
  （`docs/0824-MERGE-PLAN.md:349-368`）。
- 当前树中 Finder 桶注册、各真实宿主接线、Learning Hub 与笔记工作区均完整；
  Step 18 的 Finder/Workbench 旧持久化值防护也已在消费路径生效。未发现需要本轮
  产品修复的缺口。
- #160 的已知产品项不应重复搬运：既有审计把六项判为 F 已吸收
  （`docs/dev/0824-leftover-audit.md:55-66`），后续收口也只补两组测试并跳过其余
  12 个已吸收提交（`docs/0824-MERGE-PLAN.md:587-594`）。
- #303 本轮仅作为历史文档证据；不整支合入。当前基线已经记录其产品尾款的既有
  落点（`docs/0824-MERGE-PLAN.md:647-656`），本轮不从 #303 再取代码。
- Step 18 已把源提交 `9176740b`、`0a6344e1` 分别落为 `e24b828d`、
  `67a7fdf8`（`docs/0824-MERGE-PLAN.md:837-846`）；后续记录也明确不得重放
  （`docs/0824-MERGE-PLAN.md:853-859`）。
- **本轮不改代码**；只新增本审计文档。

## 静态证据

### 1. Finder host buckets

- 宿主 ID 覆盖 Workbench Files、Learning Hub 桌面/移动端、Chat canvas
  桌面/移动端和 group picker；仅 Files 映射到兼容旧单例的 default 桶，其他宿主
  使用独立桶与命名空间持久化键
  （`src/features/learning-hub/stores/finderStore.ts:370-425`）。
- 每桶只持久化 `viewMode`、`sortBy`、`sortOrder`、`quickAccessCollapsed`；
  恢复入口逐字段白名单校验，坏 JSON、坏类型和越界枚举不会进入状态
  （`src/features/learning-hub/stores/finderStore.ts:427-495`、
  `src/features/learning-hub/stores/finderStore.ts:1235-1249`）。
- 新宿主桶无自有值时继承旧 `learning-hub-finder` 偏好；有自有值时以本桶为准
  （`src/features/learning-hub/stores/finderStore.ts:498-514`）。
- registry 保证同宿主复用实例、不同宿主隔离；活跃宿主订阅让全局前进/后退壳层
  跟随当前可见 Finder（`src/features/learning-hub/stores/finderStore.ts:1255-1332`）。
- Sidebar 实际从 `hostId` 取桶，并只让活跃的非 canvas 宿主注册全局导航
  （`src/features/learning-hub/LearningHubSidebar.tsx:176-246`、
  `src/features/learning-hub/LearningHubSidebar.tsx:566-577`）。
- Learning Hub 桌面与移动端分别接 `page`、`page-mobile`
  （`src/features/learning-hub/LearningHubPage.tsx:495-509`、
  `src/features/learning-hub/LearningHubPage.tsx:1274-1288`、
  `src/features/learning-hub/LearningHubPage.tsx:1313-1330`）；Workbench Files 保持
  `files`/default 桶（`src/features/workbench/apps/files/FilesAppWindow.tsx:155-174`）；
  Chat 两种画布分别接 `canvas`、`canvas-mobile`
  （`src/features/chat/pages/ChatV2Page.tsx:214-220`、
  `src/features/chat/pages/ChatV2Page.tsx:878-900`、
  `src/features/chat/pages/ChatV2Page.tsx:1287-1294`）。
- 现行契约覆盖宿主间路径、搜索、选择、视图隔离，Files/default 兼容和活跃宿主
  切换（`tests/vitest/learning-hub/finder-host-buckets.test.ts:44-183`），并覆盖旧键
  继承、坏值白名单、二次 hydration 防注入和分桶写键
  （`tests/vitest/learning-hub/finder-host-buckets.test.ts:185-281`）。冲突时期的
  旧共桶测试已不存在，预演也明确应由现行测试替代
  （`docs/dev/0824-rehearse-step3-subapp.md:40-60`）。

### 2. Finder 与 Learning Hub 能力

- Finder 的资源类型映射、乐观进入目录、撤销、Quick Look 和窄窗工具栏在 F 收口
  清单中有明确落点（`docs/dev/sota-subapp-polish/ROUND-01.md:35-42`）。
- Quick Look 当前实现支持图片原图/PDF 首页、空格或 Escape 关闭、遮罩关闭及宿主
  打开回调（`src/features/learning-hub/components/finder/FinderQuickLook.tsx:1-12`、
  `src/features/learning-hub/components/finder/FinderQuickLook.tsx:69-138`）。
- Finder 的移动/重命名撤销是有界 20 项 LIFO；软删除继续走通知内撤销，不与操作栈
  混用（`src/features/learning-hub/utils/finderUndoStack.ts:1-6`、
  `src/features/learning-hub/utils/finderUndoStack.ts:40-72`）。
- Learning Hub 标签页从 localStorage 容错恢复，过滤无基本资源标识的记录，并在恢复
  后关闭已删除/移动的失效标签
  （`src/features/learning-hub/LearningHubPage.tsx:111-158`、
  `src/features/learning-hub/LearningHubPage.tsx:178-229`）。
- Finder 可在当前目录直接新建并打开笔记，也支持多文件 Markdown 导入、并发限流、
  部分失败汇总与打开导入结果
  （`src/features/learning-hub/LearningHubSidebar.tsx:877-931`、
  `src/features/learning-hub/LearningHubSidebar.tsx:933-1012`）。
- Unified App Panel 始终以稳定的 `resourceId` 读取资源，带过期请求防护，并将 note
  路由到真实 `NoteContentView`
  （`src/features/learning-hub/apps/UnifiedAppPanel.tsx:204-245`、
  `src/features/learning-hub/apps/UnifiedAppPanel.tsx:262-320`）。

### 3. 笔记工作区

- Workbench 注册的是单实例 Notes 工作区；脏内容关闭失败时 fail-closed，并声明内部
  Ctrl/Command+Tab 循环由应用接管
  （`src/features/workbench/apps/notes/register.ts:11-43`）。
- 资源树按每页 1000 拉取、总量上限 20000；首页失败与后续页失败分开处理，后者保留
  已取数据并标记截断，避免旧实现静默丢失第 1001 篇之后的笔记
  （`src/features/workbench/apps/notes/NotesWorkspaceApp.tsx:185-228`）。
- 笔记重命名后按旧标题回写 wikilink，使用 OCC/脏来源保护，并分别通知成功与未完整
  同步（`src/features/workbench/apps/notes/NotesWorkspaceApp.tsx:2100-2155`）。
- 工作区同时挂载背链、属性、局部图谱和快速/全文搜索入口
  （`src/features/workbench/apps/notes/NotesWorkspaceApp.tsx:2833-2900`）；图谱优先读取
  后端关系，失败时降级客户端构建，并监听笔记更新刷新
  （`src/features/workbench/apps/notes/graph/NotesGraphTab.tsx:158-233`）。
- Learning Hub 内的笔记保存不会绕过维护模式，携带乐观锁基线；真实内容冲突时保留
  用户版本恢复动作，避免静默覆盖
  （`src/features/learning-hub/apps/views/NoteContentView.tsx:457-488`、
  `src/features/learning-hub/apps/views/NoteContentView.tsx:550-660`）。
- 正式合入记录的定向门禁为 Finder/sidebar 40/40、notes/mindmap/workbench/Finder
  286/286（`docs/0824-MERGE-PLAN.md:399-409`）。这是既有合入证据，不冒充本轮执行。

### 4. Step 18 Finder/Workbench persist

- Finder 恢复链已在持久化边界做字段白名单，并在 Zustand `merge` 阶段再次清洗，
  对应 Step 18 的 Finder 升级防护
  （`src/features/learning-hub/stores/finderStore.ts:452-495`、
  `src/features/learning-hub/stores/finderStore.ts:1235-1249`）。
- Workbench 壁纸解析同时接受后端/localStorage JSON 字符串与事件对象；非法形状回落
  默认值，图片模糊度限于 0–40、暗度限于 0–0.6；平铺边距逐字段恢复并限于 0–32
  （`src/features/workbench/core/persistedSettings.ts:8-75`）。
- Workbench 桌面首次读取和 settings-changed 事件都经过同一解析器
  （`src/features/workbench/components/WorkbenchDesktop.tsx:295-344`），设置页读取也复用
  它（`src/features/settings/components/WorkbenchSettingsSection.tsx:225-249`）。
- 现行契约覆盖 v0.9.44 有效 JSON、壁纸坏形状、图片字段独立清洗和边距回落/限幅
  （`tests/vitest/workbench/workbench-persisted-settings.test.ts:10-60`）。

## 边界说明

- Finder 的“persist”在当前契约中指四项视图偏好，不包含 `currentPath`、搜索词或选择；
  后三者是运行期按宿主隔离状态。`partialize` 的明确字段范围见
  `src/features/learning-hub/stores/finderStore.ts:1235-1242`，本审计不把未承诺的
  跨重启导航恢复误报为缺陷。
- 本轮为静态审计，未做 Tauri 真机、私人资源库或浏览器持久化实测；结论基于当前源码、
  现行测试契约及已记录的正式合入门禁。
- 不回放 `9176740b`/`0a6344e1`，不从 #160/#161 重搬 F 已有产品项，不整支合
  #303；后续如需追加验证，应在唯一产品写入流程中运行现行定向测试，而不是改变本轮
  的只读结论。

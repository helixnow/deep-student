# Finder / Learning Hub / 笔记 / 工作台持久化质量评审

## 结论

**总体：WARN。**

对照 `v0.9.44` 与 `origin/cursor/0824-cde6@2d41ea8b` 的真实 diff，本轮在 Finder 宿主隔离、旧 key 兼容、持久化值清洗、工作台旧快照迁移和打开笔记事件去重上均有实质加固；未发现会删除笔记正文、资源或整份工作台快照的升级路径，也未发现已知合法的 v0.9.44 Finder/壁纸/磁贴边距值因新解析器而无法恢复。

但不能判定为 PASS，原因有三项：

1. 旧工作台的多个独立 note/mindmap 窗口会被迁移为一个 Notes Workspace，内容本身不丢，但旧会话的多窗口拓扑、几何和同时打开关系无法等价保留。
2. Learning Hub 恢复标签时把“资源已移动”与“资源已失效”一起删除，属于偏激进的会话清理。
3. “存为笔记”只在聊天选区和 PDF 选区收敛到共享流程，教材、文件阅读、作文批改和 Quick Assistant 仍走不同的直存根目录路径，最终产品仍存在入口分裂。

## 1. Finder 宿主分桶：PASS（有连续性提醒）

### 做得好的部分

- `finderStore.ts` 不再依赖一个全局 Finder 实例，而是通过 `createFinderStore`、registry 和 `useFinderStoreFor(hostId)` 为宿主提供稳定实例。Learning Hub 页面、移动页面、聊天 Canvas、移动 Canvas、群组资源选择器等调用点传入了明确宿主；Files/未指定宿主继续映射到 default bucket。
- default bucket 保留 v0.9.44 使用的旧持久化 key；新增宿主使用命名空间 key。宿主专属数据不存在时，初始化逻辑会读取旧 singleton 偏好，已有宿主数据则优先。这是兼容迁移，不是直接换 key 后把旧状态遗忘。
- 持久化数据在预读和 Zustand hydration merge 两处都经过 `sanitizeFinderViewPreferences`，避免初始化阶段清洗后又被 middleware 的原始对象重新注入。
- diff 中新增的 `finder-host-buckets.test.ts` 覆盖了实例稳定性、宿主隔离、default 映射、key 兼容、旧数据继承、损坏存储回退以及 hydration 不回灌非法值。这里是“有针对性的边界测试”，不是仅靠类型声明推断正确性。

### 风险边界

- `LearningHubPage` 在 desktop 与 mobile breakpoint 下切换 `page` / `page-mobile` 两个 bucket。两份状态都还在，因此不是数据删除；但用户跨断点时会看到路径和视图偏好跳到另一套历史状态。该行为由测试明确固定为隔离语义，若产品期望同一页面响应式切换后连续，则需要重新确认需求。
- 新宿主首次启动会从旧 singleton 偏好播种，随后才各自隔离。这避免升级丢偏好，但升级后的第一次进入不同宿主可能显示相同旧路径；这是一次性迁移效果，不是运行期串桶。

## 2. persist 加固与过度清洗：主体 PASS，Learning Hub 标签为 WARN

### Finder 偏好

Finder 采用白名单恢复，只接收当前支持的偏好结构，不把请求态、列表结果等运行期对象带回新 store。对 v0.9.44 合法结构有显式兼容测试；storage 不可用、JSON 损坏或字段非法时回退默认值。就本次升级而言，没有证据表明合法旧偏好会被误删。

清洗策略对结构损坏的快照是整组回退，而不是尽量保留其中仍合法的字段，策略略保守；但影响范围仅是 Finder 视图偏好，且能阻断半损坏状态重新注入，不构成本轮阻断项。

### 工作台设置

`persistedSettings.ts` 对 wallpaper 和 tile margins 改为按字段解析：

- 已知枚举值才接收；
- blur、dim、margin 数值限制在 UI 支持范围；
- boolean 严格校验；
- 未知注入字段丢弃；
- 损坏 JSON 使用 fallback。

对应测试包含合法 v0.9.44 JSON、非法 kind/value、越界数值、错误类型和未知字段。与原先把解析对象直接 spread 到 fallback 的方式相比，新实现能防止非法字段重新覆盖默认值；范围裁剪也与设置 UI 的有效域一致，未见过度清洗已知旧值。

### Learning Hub 标签恢复

`LearningHubPage` 新增 open tabs / active tab 持久化、损坏数据回退、LRU 管理及恢复后的资源校验。这提升了重启连续性，但校验逻辑会把“资源不存在”和“资源已移动”都视为应删除的恢复标签。

资源移动后 ID 指向的实体仍然有效，仅路径元数据陈旧；直接关闭标签会丢失用户的会话上下文。更稳妥的恢复方式应是按稳定资源 ID 重新绑定当前路径/标题，只有实体确实不存在时才删除。因此该处属于真实的过度清理，但损失的是标签会话，不是资源内容。

## 3. 工作台快照升级：WARN（有界的会话状态损失）

`snapshot.ts` 的改动方向正确：

- 新 display mode 被加入允许列表，避免合法布局在恢复时被误判；
- `migrateLegacyNotesSnapshotWindows` 在 prune 前执行，防止旧 note/mindmap 窗口先被当作不支持应用删除；
- 自动恢复关闭时增加手动恢复入口；
- background 打开窗口时保留前台窗口的焦点和层级，减少恢复/后台启动造成的焦点抖动。

但旧模型允许多个 note/mindmap 独立窗口，新模型迁移为单一 Notes Workspace。该迁移能保住一个可进入新工作区的入口，并不等价于恢复原来的多窗口集合：多个窗口各自的位置、大小、层级及“同时打开哪些资源”的关系无法完整映射到一个窗口。这里应明确区分：

- **笔记/脑图资源正文：未见删除。**
- **旧工作台会话拓扑：存在有意的有损迁移。**

若发布标准要求升级后逐窗还原，则此项不合格；若产品已经决定统一 Notes Workspace，则当前迁移至少比直接 prune 安全，但应在升级说明或迁移测试中明确“多窗口折叠”的预期。

## 4. Notes Workspace 自身持久化：PASS（容量上限需知情）

`NotesWorkspaceApp` 持久化 tabs、active tab、split layout 等工作区状态，并修正了从资源 ID 前缀推断初始资源类型的逻辑；旧快照迁入后可进入统一工作区。资源列表从一次最多 1000 条改为分页读取，并设置总量上限和截断检测，避免静默把首批结果误当完整集合。

上限意味着超大资源库仍可能无法完整出现在工作区列表中，但 diff 已显式识别 truncation；这属于容量约束，不是持久化数据删除。

## 5. “存为笔记”入口：WARN

### 已收敛的路径

`useSaveAsNoteFlow` 与 `saveTextAsNote` 把聊天选区和 PDF 选区统一到同一流程：

- 统一标题派生；
- 可选择目标文件夹；
- 先创建笔记，再移动到目标文件夹；
- 移动失败时优先保住已创建的笔记；
- 统一通知及“打开笔记”动作。

这是合理的容错顺序，不会因文件夹移动失败回滚并丢掉刚创建的正文。

### 仍分裂的路径

最终代码仍有以下不同体验：

- `TextbookContentView.tsx`、`FileContentView.tsx`：直接向根目录创建 note；
- `EssayGradingWorkbench.tsx`：直接调用 `notesDstuAdapter.createNote`；
- `quick-assistant/service.ts`：继续直接向根目录创建 note。

这些入口没有共享流程提供的文件夹选择和统一打开动作。提交历史也显示归因不同：教材/文件阅读和作文批改路径是在本区间内、共享流程出现前接入；Quick Assistant 路径在 v0.9.44 已存在且本轮未改。也就是说，本轮没有把所有分裂都新造出来，但在 `2d41ea8b` 的最终产品状态中，入口确实尚未收敛，用户会得到不同的保存位置和后续动作。

## 6. 打开笔记事件归属：PASS

`openNoteEvent.ts` 把 `DSTU_OPEN_NOTE` 的处理权显式分开；Chat 的 `useChatPageEvents` 和 Workbench 的 `WorkbenchEventBridge` 都先调用各自的 ownership 判断，再决定是否打开。对应测试覆盖 Notes 自有来源、明确的非 Notes 来源和无 source 情况。

这解决了同一全局事件被 Chat 与 Workbench 同时消费、重复打开的问题。共享“存为笔记”流程带有明确 source，也能进入该路由规则。未发现本轮新增的双开路径。

## 发布判断

可以合入的前提是接受以下产品语义：

1. desktop/mobile Finder 是两份独立历史，跨断点不保证连续；
2. 旧 note/mindmap 多窗口升级后折叠为一个 Notes Workspace；
3. “存为笔记”暂时仍有根目录直存和共享选目录两套体验。

若目标声明是“升级完全不丢工作区会话状态”或“所有笔记入口已统一”，当前实现不满足；若目标是保证资源正文安全并完成基础隔离/防损坏，本轮核心加固有效，但应以 WARN 发布，而不是宣称全量收口。

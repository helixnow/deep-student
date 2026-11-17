**Deep Student 插件工坊与 DeepSeek Harness 对齐调研**

**整改状态（2026-11-17）：第 1–10 节记录修改前基线；收到“开多个子代理直接开始修”后，已完成本地实现及真实 Electron 验证，见第 11 节。尚未提交、推送或发布。**

调研日期：2026-11-16 至 2026-11-17。代码基线：公开仓库 `helixnow/deep-student`，`main`，`81c7b46d31ebb99beccfc71170934dc0cfd64b17`，应用版本 `0.20.4`。

**结论：目前具备“受管理的插件制作、热安装和有限回退”基础，但尚未实现“用户只描述需求，Agent 自动交付、验收、修复并恢复”的产品目标。现有正式插件接口也不支持任意替换应用自身实现。主要差距在授权流程、运行验收、恢复衔接和扩展契约，而不只是模型写代码的水平。**

调研阶段没有修改产品代码。随后本地整改见第 11 节；两个阶段均没有改动原有自动提醒功能。实验使用独立数据目录、本地确定性模型和真实 Electron 应用，未使用个人资料库或真实模型密钥。

**1. 我们应当对齐什么**

用户目标可以落实为：打开工坊 → 描述希望改变的体验 → 系统理解现有能力、实施、验证并使其生效 → 出错时维持可用状态、继续修复 → 用户回来直接使用。

DeepSeek 官方架构把产品组件组织为插件，通过能力接口连接提供者与消费者，包含模型、工具、会话和 Agent 循环等。这说明需要对齐的是“实现可通过明确接口被组合、选择和替换”，而不仅仅是能够安装一个独立的小应用。[官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

官方持久化插件教程给出一个很具体的验收标准：Agent 安装配置后，既检查管理结果为 `application: applied`，也实际调用新增 MCP 的 `ping`。仅保存成功或 `restart-required` 不代表已经生效。Deep Student 最值得直接借鉴的是这种“变更结果 + 真实调用”的双重确认。[官方教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/dynamic-cordis)

官方管理接口还明确区分磁盘变更与运行生效，并说明部分模块变化需要重启。不能由“一切皆插件”推导出“任何代码都能无条件热替换”或“所有数据副作用都能自动撤销”；本报告也不把这些能力当作 DeepSeek 已经普遍实现的事实。[官方启动与管理契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/boot.md)

**2. 调研方法和可信边界**

结合三类证据：当前源码、DeepSeek 官方资料、真实运行。真实运行环境是本机 macOS 的 Electron 开发实例，使用仓库已有依赖和 `npm run dev:electron`，单独设置 `DS_APP_DATA_DIR` 与 `DS_ELECTRON_USER_DATA`。

本地 HTTP/SSE 模型只确定性地产出提案和几个受控插件版本，应用自己的对话管线、工具派发、源码生成落盘、编译器、Host、安装器、UI 加载器和工作台都是真实实现。这样可以区分产品流程缺陷与模型随机生成错误；这些实验不能用来估算真实 DeepSeek 模型的任务成功率、速度或费用。

实验输入包括：一个显示版本号的简单应用、在渲染时明确抛错的升级版、生成尚未返回时重启。对于首个发现的生产装配遗漏，先记录未经修改的失败，再仅在隔离页面中临时调用现有注册函数，继续验证后续链路。后续出现正常页面和回退页面，均以这个临时补接为前提，不能当作原版入口已修复的证据。

未验证：Windows/Android 真机、打包发行物、真实外部服务凭据、长期运行、恶意插件防护、插件数据迁移回滚。涉及这些部分的判断标为源码结论或后续验收要求。没有使用自写单元测试替代实际页面验证。

**3. 用户现在实际要经过什么**

本次走通的入口是“设置 → 工具与扩展 → 插件管理 → 自己描述一个…”。这里顶部是搜索已装插件，不是需求输入框；创作入口位于“我的插件”和创作记录之后。随后打开一个通用聊天窗口，用户再输入并发送需求。

发送后的流程如下：

| 环节 | 当前行为 | 与目标的差距 |
|---|---|---|
| 描述需求 | 创建带工坊技能的新会话 | 页面跳转，创作与管理分离 |
| Agent 理解任务 | 调用 `propose_install`，生成提案卡 | 即使用户已经明确要求完成，也停下来 |
| 开始制作 | 用户必须点击“开始做” | 第一次额外确认 |
| 生成与检查 | Host 调用模型，编译并测试 Host 装卸，自动尝试修复编译等错误 | 自动化只覆盖这段 |
| 安装 | 完成后进入 `pending-confirmation`，用户再点“安装” | 第二次额外确认 |
| 使用与验证 | 用户再点“打开”，或去目标页面找按钮、发试用指令 | 用户承担最终验收 |
| 功能出错 | 部分故障可隔离并退回旧版；修改通常要重新提案 | 不会自动继续完成原目标 |
| 中途重启 | 生成状态变成失败 | 不会自动续做 |

实验输入明确写了“请做好后直接安装、验证并帮我打开”，仍然停在提案。**这不是模型不够积极：Agent 工具没有直接生成/安装的权限，技能文本也明确要求停止并等待点击。**后台生成由 UI 的专属授权回执触发。只改系统提示词不足以打通流程，需要同时修改产品授权语义和 Host 执行入口。

源码：[工具和确认要求](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/tools.ts#L19-L68)、[UI 专属授权](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/kernel/workshop-ui-authority.ts)、[创建会话](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/features/plugin-workshop/session.ts)、[卡片执行路径](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/features/plugin-workshop/host-adapter.ts#L332-L345)。

**4. 真正复现的缺陷与恢复边界**

**4.1 优先修复：社区视图已经加载，工作台却没有登记它。**

正常样例 1.0.0 的清单、编译、生命周期检查均通过，Host 正常运行，UI 内核也有 `recall` 视图。工坊显示“装好了，现在就能用；重启应用后也会自动加载”。但“全部应用”找不到它，点卡片“打开”没有打开页面。

直接读取实际状态得到：

```text
Workshop: state=installed, usableVersion=1.0.0
UI kernel: community plugin 已安装，views 中有 recall
Workbench appRegistry: plugin-view.* 为空
```

`registerPluginViewApps()` 已实现，却没有被 `registerAllWorkbenchApps()` 调用。仅在隔离实例临时调用该现有函数后，同一个插件、同一份代码立即能打开，页面显示“调研样例 1.0.0 已在真实应用中运行”。因此根因置信度高，不是生成代码没有实现页面。

建议：补上生产装配调用，沿用已有订阅与卸载逻辑。回归验证必须从真实启动入口安装插件、打开“全部应用”及卡片入口；当前直接调用 `mirrorPluginViewApps` 的测试不能证明生产入口已装配。

源码：[遗漏调用的入口](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/features/workbench/apps/registerAll.ts#L21-L44)、[已有注册函数](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/features/workbench/apps/plugin-views/register.tsx#L98-L144)。

**4.2 优先修复：“可用版本”的判定早于真实功能验收。**

升级样例 2.0.0 的组件一渲染就抛出 `research-render-failure-v2`。现有检查仍返回：

```json
{"ok":true,"manifest":"passed","compile":"passed","lifecycle":"passed","visual":"not-verified","errors":[]}
```

安装后 `state=installed`、`usableVersion=2.0.0`。打开页面实际报错，工坊起初仍保留上述成功状态、`lastFault=null`。

原因是编译器测试的是 Host 的安装/卸载；UI 包只被读出用于分析，没有真实导入、打开页面或执行交互。声明的 Agent 工具也只检查处理器是否存在，不实际调用。安装成功更新依赖 Host 运行状态。故“编译通过”“Host 可加载”“UI 能加载”“目标功能可用”目前没有完整串起来。

建议：保留编译和装卸检查，增加对应目标的真实验收后再更新 `usableVersion`。页面类至少验证入口存在、渲染成功和一项核心操作；Agent 工具类至少完成一次实际调用；编辑器按钮至少在已打开的文档中触发并看到结果。未做这些时，文案应明确“已安装，尚未验证功能”，不能直接承诺能用。

源码：[检查范围](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/compiler.ts#L220-L277)、[安装状态更新](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/operations.ts#L504-L540)。

**4.3 自动回退确实存在，但触发和后续修复不完整。**

首个渲染错误没有立即回退。关闭并重新打开坏页面，触发现有 UI 错误停用条件后，系统自动隔离 2.0.0 并恢复 1.0.0；页面再次显示正常内容，记录出现 `rollback=restored` 和 `lastFault=UI_ERROR_BUDGET...`。这是实际运行的正向证据，不能说项目完全没有自动恢复。

然而，首次失败时用户只能看到失败页；恢复后也没有自动继续修复 2.0.0。已有错误预算默认以累计次数触发，且不等于任务验收。应依据明确的加载/验收失败及其影响采取恢复动作，不能把“再多报几次错误”当成功能自愈的设计。

另一个源码确认的缺口：`UiPluginLoader` 的导入或 `apply` 失败主要保留在 loader 错误表和日志；工坊订阅的是 `onPluginDisabled`。这些加载错误没有与上述渲染错误停用事件共用完整的工坊恢复路径。本次未另行运行导入失败样例，修复前应补上独立复现。

回退恢复的是代码版本，不是已经写入的业务数据。`restore()` 实际从旧源码重新编译、检查、安装，并应用当前设置；它没有对插件此前的文件、网络或业务数据库副作用做事务回滚。数据新旧格式兼容目前主要写在生成提示词里，不能视作已验证保证。

源码：[故障隔离及回退](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/operations.ts#L459-L480)、[回退实现](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/operations.ts#L565-L602)、[UI 加载失败](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/ui-kernel/loader.ts#L77-L113)、[错误转发](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/app/pluginWorkshop.ts#L94-L100)。

**4.4 重启保存了旧版本，却没有恢复未完成任务。**

在旧版 1.0.0 已安装时，发起一次修改，暂时挂起本地模型响应，让任务持久化为 `generating`，随后重启隔离应用并恢复模型。结果：

```text
重启前：state=generating，installation.version=1.0.0
重启后：state=failed，installation.version=1.0.0
error=WORKSHOP_STATE: background generation interrupted by Host shutdown
```

旧版 Host/UI 仍能加载；补接同一个工作台注册入口后仍能显示旧内容。未完成的修改则不会自动续跑。`recoverInterrupted()` 正是把生成中的记录转为失败，没有重新启动任务。

建议复用现有持久化作品记录：启动时先核对实际安装版本和候选状态，再从尚未完成的阶段继续已授权目标。不要再次执行已经完成的数据修改。取消任务应保持取消；确实缺少凭据或新权限的才进入等待用户状态。

源码：[启动恢复](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/store.ts#L229-L233)、[任务运行](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/operations.ts#L307-L373)。

**4.5 失败页露出内部键，且没有直接的恢复操作。**

实际页面显示 `pluginViewApp.failed`，不是中文解释。对应组件调用了翻译键，但当前语言资源没有这个键。页面也没有直接提供“已恢复旧版 / 正在修复 / 查看原因”的任务进展，只能退回其他入口处理。

建议补齐文案，并让功能所在页面直接显示工坊任务的恢复状态和可执行操作。用户不应该知道如何找 Host 错误、回到原会话、再描述同一个故障。

源码：[失败页面](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/features/workbench/apps/plugin-views/PluginViewAppWindow.tsx#L24-L51)。

**5. Agent 到底拿到了哪些能力**

| 能力 | 项目已经有 | 工坊当前可用性与缺口 |
|---|---|---|
| 查询现有 API、服务和插槽 | 有动态服务目录、API 文档、配方 | 能看契约；缺少与当前页面实际挂载结果联动的验收 |
| 查询插件与配置 | 有 inventory、status、config_get | 可以发现已装作品和配置 |
| 写代码、编译、修正错误 | 有托管源码与编译/生命周期反馈 | 需用户开始后才能执行；后台本质是生成 JSON 文件列表 |
| 安装、热启停、配置 | Host 有安装和激活；配置/启停可经受确认工具调用 | 直接安装不开放给 Agent，通路停在卡片 |
| 看应用、操作应用 | 项目另有 workbench observe/act/wait/get_capabilities 等工具 | 后台制作者没有拿到这些工具，不能完成自身功能验收 |
| 查看运行故障 | diagnose 能看源码、检查结果、Host 库存 | Renderer 错误、目标页面状态和业务调用结果没有完整汇合 |
| 恢复旧版 | 已有隔离、保留版本、restore | 部分故障能自动回退；不自动修复，不恢复业务数据副作用 |
| 重启继续任务 | 有作品持久化 | 没有自动续跑；重新开始通常再次等用户 |

后台生成请求实际只包含 `dstu_plugin_api_list`、`dstu_plugin_api_read`，另有对话框架附加的完成工具 `attempt_completion`。生成器明确写着没有 filesystem、shell、installation、profile 工具。它可以产出完整源码并接受编译错误反馈，但不能在这一执行上下文中打开自己做出的界面、操作它或调用业务功能验证结果。

**建议复用现有 workbench 能力，并扩充真正缺失的运行验收信息，不要重新建设一套平行浏览器或 Agent 编排框架。**目前不能因为全项目有 UI 操控工具，就认为工坊已打通这些工具。

还有两个源码层面的摩擦值得一起处理：

- 生成会话只记录父会话 ID，没有传入父会话明确选择的 `modelId`；执行管线会自行选择默认模型。若用户在对话中切了更强的模型，实际制作者可能使用另一个模型。建议明确继承或显式展示所用模型；本次只有一个模型，未做双模型行为复现。
- 技能文档仍写“Agent 不能 enable/disable/restore”，但后文和当前工具已有受确认的启停及失败作品回退能力。契约互相矛盾，会使模型在故障时过早停下。应按真实工具能力统一指令，而不是增加关键词规则或重试次数。

源码：[生成器与工具白名单](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/generation.ts#L40-L86)、[现有工作台工具](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/agent-skills/src/tools/workbench-executor.ts#L16-L29)、[生成模型选择](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/chat-pipeline/src/freeze-execution.ts#L21-L44)、[技能中的冲突表述](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/resources/dstu-workshop/skills/dstu-plugin-development/SKILL.md#L30-L40)。

**6. “任意改进项目本身”目前为什么做不到**

需要区分“调用现有功能”“往开放位置增加功能”“替换原有功能的实现”。现在前两项有明显基础，第三项受到正式契约限制。

| 用户需求示例 | 当前正式路径判断 |
|---|---|
| 新增公式速查小应用 | 有 Host + UI 模板和视图契约；本次发现桌面入口装配遗漏 |
| 选中文字后增加口诀按钮 | 有编辑器插槽和模型服务，属于支持范围 |
| 给 AI 增加查课表工具 | 有 agentTools 和网络/设置配方；仍需真实工具调用验收 |
| 在桌面显示学习统计、调用已有笔记/复习服务 | 有服务和部分显示插槽；具体方法和平台需逐项确认 |
| 改一个自己先前做的工坊插件 | 支持托管作品更新和保留旧版 |
| 修改任意外部导入插件或内置插件源码 | 工坊修改入口只接受已托管作品，不能直接接管任意包 |
| 替换任意内置聊天组件或页面布局 | 只能使用已声明插槽；不能直接抢占已有 keyed/single 贡献 |
| 换掉 FSRS 内部算法、同步合并逻辑或聊天主循环 | 当前通用社区插件路径没有任意替换这些内置服务的能力；已有服务调用不等于替换实现 |
| 改 Electron 原生启动、依赖或数据库结构并立即生效 | 超出当前工坊制作和热加载契约，应走专门应用升级/迁移流程 |

关键限制是明确写在实现里的：社区 Host 服务只能在自己的命名空间内提供，不能冒充 `dstu.*` 官方插件；不能声明应用级 `meta.commands`，不能注入内核专属服务。UI 的 keyed 槽位不允许同 key 覆盖，single 槽位已有提供者时拒绝第二个贡献。工坊源码不能随意安装 npm 依赖，UI 只支持共享依赖白名单。

这些限制不意味着底层绝对无法被任意代码修改。当前 full-trust 插件与应用同进程，原始 Node/DOM 能力可能绕过正式抽象；但那不构成可以保证版本兼容、卸载清理和自动恢复的产品能力，不能作为“任意改进”的实现方案。

建议按实际需求逐步开放可替换点，例如某个复习策略、某类消息渲染器、某个搜索提供者。每个点都要有现存消费者实际使用的接口、选择规则、生命周期和回退行为。**先接通一个真实消费者，再承诺该实现可替换。**内核启动和数据格式升级仍应明确为不同执行路径。

源码：[Host 契约限制](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/kernel/manifest.ts#L361-L386)、[插槽冲突规则](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/src/ui-kernel/slots.ts#L93-L106)、[工坊仅修改托管作品](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/host/plugins/plugin-workshop/src/store.ts#L179-L193)、[当前进程边界](https://github.com/helixnow/deep-student/blob/81c7b46d31ebb99beccfc71170934dc0cfd64b17/docs/plugins/SECURITY.md)。

**7. UI/UX 结论与建议**

现有界面有值得保留的部分：用学习任务举例、告诉用户安装后在哪里找到功能、明确展示能力和限制、区分候选与已装旧版、将技术详情折叠、保留版本恢复入口。卡片已经能承载整个任务，不需要重新发明页面体系。

但按照本次目标，当前信息层级仍围绕“管理插件”和“批准软件包”，用户需要理解提案、开始做、安装、打开、原会话等多个状态。主输入是搜索名称/作者，创作按钮靠后；创作跳到普通聊天页后，还会显示通用的问答或学习引导。错误发生在新应用窗口，恢复入口却散在聊天和插件管理页。对“不想了解插件技术、只想改进学习流程”的用户不够直观。

建议将工坊作为一级可搜索应用入口，进入即见“你想让 Deep Student 增加或改变什么？”输入框。已有插件的搜索、启停和导入仍保留在管理区域。

用户发出实施请求后，同一任务卡显示“正在制作 → 正在试用 → 已可用”；后台执行已授权范围内的安装、验证和可逆恢复。卡片提供停止、查看过程和恢复旧版，不再要求每次跨阶段点击。完成时打开或预览成果，并显示实际验收过什么；发生错误时显示“已恢复旧版，正在修复这次修改”，而不是泛泛的“出了问题”。

如果用户只是探讨想法而未要求实施，继续讨论即可。对于必须由用户提供的外部账号、凭据或超出原目标的不可逆业务动作，清楚说明缺的具体信息或权限。用户不应为系统本来能自行推断的字段、修复步骤和重复授权负责。

安装卡当前“能做到应用本身能做的事”容易被理解成任意功能可替换。应改为与具体作品一致的能力说明，并区分同进程信任边界与产品扩展范围。

**8. 建议的实施顺序**

下表的 P0 指阻塞本次产品目标，非线上事故等级。

| 优先级 | 改进项 | 尽量复用的现有位置 | 完成判断 |
|---|---|---|---|
| P0-1 | 接通社区视图到工作台的注册，补失败文案 | `registerAll.ts`、`plugin-views/register.tsx`、语言资源 | 从真实启动安装，全部应用和卡片都能打开；重启后仍成立 |
| P0-2 | 将“可用”绑定真实运行验收，UI 故障回到工坊任务 | `compiler.ts`、`operations.ts`、`UiPluginLoader`、`pluginWorkshop.ts` | 坏 UI、坏工具不能成为已验证版本；旧版保持可用 |
| P0-3 | 让一次明确实施请求覆盖制作、安装、验证、范围内恢复 | 现有作品/会话身份、UI 授权入口、工具 executor、工坊技能 | 普通可逆任务发送后无人继续点击也能交付 |
| P1-1 | 给制作者接入现有运行观察和操作能力 | `generation.ts`、现有 workbench 工具、诊断服务 | Agent 能根据具体运行结果修正，而非仅依据编译结果 |
| P1-2 | 自动诊断修复与重启续做 | `WorkshopOperations`、`WorkshopStore`、现有 jobs | 退出恢复后继续未完成阶段，取消状态不被自动恢复 |
| P1-3 | 验证候选时隔离业务数据；明确代码回退的数据兼容性 | 现有数据访问接口、临时数据环境、插件存储 | 老版本能读取新版本留下的数据；验收不污染用户资料 |
| P1-4 | 统一提示词、工具契约和模型选择 | 两份工坊技能、`tools.ts`、`generation.ts` | 模型知道真实能力；明确所用模型、验收和恢复状态 |
| P2 | 开放经过消费者验证的内置功能替换接口 | 具体业务模块的 provider/strategy/slot | 新实现被真实业务路径使用，停用后可靠回到原实现 |

P0-3 不能只删除两个按钮或把所有工具设为无条件允许。应把当前每次点击产生的执行许可，调整为用户针对本次目标的明确委托，由现有 Host 安装器执行受管理变更；不把安装器开放给生成插件。提示词按状态和事实决定继续、修复、恢复或请求必要信息。

不要用关键词命中、累计次数或固定修复轮数替代任务判断。当前最多三轮只是实现事实；改进应让 Agent 根据新诊断决定下一步，有进展就继续，缺用户信息或环境不可用才说明具体阻塞，用户可随时停止。费用或执行期限若作为产品选项，应是用户理解的预算，不是“功能已正确”的判据。

为支持无人看守的恢复，候选验证不应与救援控制面共享无法中断的执行点。先评估复用现有临时 Host/Renderer 和进程管理能力，让候选卡死时仍能撤下候选、恢复旧版。无需为了本轮目标重写整个插件内核，但也不能用现有同进程测试加载声称能恢复任何故障。

**9. 后续应该用什么证明目标已经实现**

建议以真实应用、真实业务路径验收以下任务，不以孤立的 helper 单测代替：

1. 从干净启动进入工坊，描述新增小应用。发送后不再点击，最终页面出现并完成一次实际操作；重启仍有入口和内容。
2. 在已有笔记页面增加选区按钮，安装后不用重开文档，选中文字后真实调用模型并显示结果。
3. 增加一个 Agent 工具，安装后当前会话即可发现并实际调用；确认返回内容，不只确认 schema 存在。
4. 候选出现编译失败、Host 加载失败、UI 导入失败、UI 渲染失败或业务结果不符时，分别验证可诊断、旧版可用、任务能修复或明确解释阻塞。
5. 更新写入插件数据后再恢复旧版，确认记录不丢且可读；对不兼容迁移必须有明确处理，不能只换回代码。
6. 生成、候选验证、安装切换分别被应用退出打断后，重启核对真实状态再续做；已完成的业务写入不重复执行。
7. 用户切换模型后，提案与后台制作的模型符合明确选择；缺凭据时只询问确实缺失的信息，不重复确认已授权步骤。
8. 用户要求改变某个内置实现时，验证消费者确实使用插件实现；若没有替换点，明确说明边界，不交付一个旁路小应用来声称完成。

先在桌面开发实例跑通，再覆盖 macOS/Windows 打包版；移动端不在当前工坊的平台声明内，不能直接承诺与桌面同等能力。

**10. 证据与后续维护**

原始实验文件保留于 `/private/tmp/deep-student-workshop-research.dlga6s0a/`。包含本地模型、驱动脚本、隔离数据与日志；这些是调研材料，未加入产品运行配置。测试应用和模型进程已停止。

关键证据文件位于其中的 `evidence/`：

| 文件 | 证明什么 |
|---|---|
| `05-plugin-manager.json` / `.png` | 当前入口、信息层级、没有直接需求输入框 |
| `08-proposal-after-request.json` / `.png` | 明确实施请求仍停在“开始做” |
| `v1-installed-state.json` | 检查通过并标为可用，但 visual 未验证 |
| `ui-kernel-observation.json`、`plugin-mirror-state.json` | UI 已注册、桌面应用未登记 |
| `18-v1-after-registration-hook.json` / `.png` | 只补调用现有注册函数后，原样例可运行 |
| `v2-pending-state.json`、`v2-render-failure-state.json` | 渲染必错的候选仍通过检查并成为可用版本 |
| `v2-reopened-state.json`、`v2-errors-final.json` | 错误实际发生，首次并不立即进入恢复 |
| `v2-auto-rollback-state.json`、`22-auto-rollback.json` / `.png` | 触发停用后自动回到 1.0.0，页面恢复 |
| `before-interrupted-restart.json`、`after-interrupted-restart.json` | 生成中重启变失败，没有续做 |
| `23-restart-old-version.json` / `.png` | 旧版持久化仍有效，桌面入口仍需补接 |

最终建议是先完成 **入口真正可达、功能真正验收、一次委托持续执行、失败和重启后继续履约** 这四项，再逐步拓展内置实现替换能力。当前基础可以沿用；现阶段不宜对用户承诺“任意改进应用并自动保证生效”。

**11. 本地整改与实际验证**

本轮由三个子代理分别负责 Agent 执行契约、Host 生命周期、桌面与 UI 内核，主代理负责工坊入口、集成和真实运行验证。改动统一保留在本地 main；本轮不推送。

已实现的行为：

- 学习桌面“全部应用”提供独立插件工坊，直接输入需求并发送。明确实施意图通过 `execute:true` 交给 Host 持续执行；保留只讨论方案的兼容路径。后台制作和验收继承父对话实际模型。
- 实际启动入口注册社区插件视图；安装候选会等待准确插件版本、桌面宿主及应用登记就绪，再取得真实窗口 ID。独立工坊保留已完成作品、打开/修改入口和验收结果。
- 区分候选安装与功能验收。只有覆盖全部需求且引用本轮真实候选页面观察的验收结果，才能提升 `usableVersion`。验收读取既有消息块中的真实工具结果，兼容压缩后元数据的 `output:null`。
- UI 导入/应用/渲染错误能触发恢复；报告携带错误发起版本，旧版本晚到的回调不误伤新版本。失败候选不覆盖旧版本包，回退后继续原委托修复任务。
- 生成、安装、验收、回退中断后的任务在依赖就绪后恢复；取消不被恢复。阻塞原因直接展示，已有候选可点击“继续验收”，沿用原候选和验收身份。
- 冷会话“让 AI 改”先等待聊天 adapter 完成加载，再写入预填草稿，避免被空的持久化草稿覆盖。

最终运行环境：本机 macOS，仓库真实 Electron 开发实例，独立 `DS_APP_DATA_DIR`/`DS_ELECTRON_USER_DATA`，受控本地 HTTP/SSE 模型。模型只提供可重复的提案、源码、工具请求和验收结论；对话、工具派发、编译、安装、Host、页面、回退及重启均走产品真实路径。

| 实际输入与故障 | 观察结果 | 证据文件 |
|---|---|---|
| 新数据目录，工坊提交一个只展示内容的小应用；之后不点“开始做”或“安装” | 自动生成、安装、打开真实页面；实际观察后验收通过，`usableVersion=1.0.0` | `initial-passed.json`、`after-submit.json`、模型请求记录 |
| 升级版 1.0.1 在 React 渲染中抛错 | 自动回到 1.0.0，保留原任务，生成 1.0.2 并重新验收通过 | `upgrade-states.json`、`upgrade-result.json` |
| 下一次生成时暂停模型响应并关闭应用，随后恢复模型并重启 | 同一任务 ID 自动续做至 1.0.3，候选自动开窗、验收通过；无需手工恢复桌面 | `before-restart.json`、`restart-result.json`、`after-restart.json` |
| 重启后从作品点击“让 AI 改” | 冷会话输入框保留“把『自动交付样例』改成：” | `cold-prefill.json` |
| 验收器明确报告缺少交互验证条件 | 候选 1.0.4 保持未验收，`usableVersion` 留在 1.0.3；界面显示原因和“继续验收” | `blocked-result.json`、`blocked-action-ready.json` |
| 恢复验收条件后从真实页面点击“继续验收” | 同一个 1.0.4、相同 `validation.revision=31` 完成验收；没有重新生成安装 | `retried-result.json` |

证据目录：`/private/tmp/deep-student-workshop-acceptance.sv4jf_tw/evidence/`。调试阶段证据另保留于 `/private/tmp/deep-student-workshop-fix.ab94r7zs/`。这些临时目录不在产品工作区内。

自动化检查：工坊 Host 全目录 33 文件、113 测试通过；后续委托停止判定的调整又通过其相关 9 项回归。原生 Node Host 探针包含 8 个真实加载、调用、回退和重启场景。前端分别覆盖卡片/适配器、冷会话、社区装配、错误版本归因及候选打开；最终卡片相关 47 项通过。Host 与前端类型检查、`check:plugins`、`check:frontend-layers` 和 `git diff --check` 通过。

仍需明确的边界：本轮自动验收只开放五个只读工作台工具。必须点击、修改业务数据或调用新插件工具才能证明的目标，验收器必须说明阻塞，不能把按钮出现或源码看起来正确当作通过。本轮没有实现任意内置功能替换、通用数据迁移回退或同进程无限循环/进程崩溃的可靠救援。没有验证 Windows/macOS 发布包，也没有评估真实大模型的生成成功率、成本和时延。后续应围绕具体业务消费者开放替换点，并为真实交互验收确定清晰范围。

**12. 回退指针与继续验收复查后的修复**

复查实际复现了两处问题：手动从已验收的 1.0.1 回退到 1.0.0 后，运行服务已是旧版，但 `usableVersion` 与恢复包仍指向新版，下一次修改继承了新版源码；关闭候选窗口后重试同一条验收，前端因为记得该验收曾开过窗口而跳过再次打开。

修正后，修改从当前安装运行的版本取源码；卡片保留每个版本实际通过的验收结果，运行故障会撤销对应记录，恢复时同步运行版本、可用版本、恢复包与验收状态。旧记录已有的当前验收结果在下次提案时补入保留记录；缺少历史验收的旧版不会因为恢复成功而自动被认证。每次 Host 发起验收时，前端重新打开或聚焦准确候选，即使版本与验收 revision 没变。

本机真实 Host 探针通过 10 个场景，其中新增：两版不同服务输出 → 重启 → 回退 → 再次重启及卸载恢复 → 再修改；确认运行结果、恢复指针和新修改源码全部落在 1.0.0，下一版为 1.0.2。另验证恢复未验收旧版时清除新版可用指针，不伪造验收成功；运行故障后旧的已验收版本仍可恢复。

独立 Electron 实例使用本地受控 HTTP/SSE 模型，从工坊真实提交需求。首次验收阻塞后，真实关闭候选窗口，再点击“继续验收”：窗口从 `hHbax1i4TA` 自动重开为 `eiJmJLJYOd`，页面显示“回忆练习”“本地自动交付样例已运行”，只读工具观察后验收完成。版本仍为 1.0.0，`validation.revision` 仍为 4，没有重新制作或安装。证据：`/private/tmp/deep-student-workshop-final.g6apbdkl/evidence/closed-candidate-fixed.json` 及同名截图；测试进程已关闭，数据保留。

本轮相关 Host 回归 6 文件 16 项、候选窗口回归 5 项及 Host/前端类型检查通过；另补旧记录验收保留回归。自动提醒未改动。

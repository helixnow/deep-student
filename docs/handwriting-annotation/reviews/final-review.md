# 主 agent 最终审查记录

日期：2026-11-03。分支：`feat/handwriting-annotation-chat`。本文为 `7fef25ec`／`bc48e6eb` 的冻结主审记录，文档基线 `d48bec38`，不代表后续问题已解决。基线结果见 [closure-results](../verification/closure-results.md)；后续真机预览失败见 [当前问题](../issues/android-import-preview.md)，扩展设计见 [总体计划](../roadmap.md)。旧过程清单和 ledger 已移入本地归档，查询方式见 [治理说明](../governance.md)。

## 审查范围与裁决

- 不只看git diff：新增Ink域、repos、commands、render/jobs/undo、frontend editor/prepare/export、typed compiler/history helpers、sync与迁移均按实际新文件阅读。`tracked-source-files.txt`及`untracked-source-files.txt`是阶段清单，最终git状态另核对。
- Canonical manifest为唯一内容事实源；page/background依赖由服务持有，resources.hash为派生镜像；CAS旧指针与引用变更同事务。guard维持blob mutex→SQLite顺序，通用upload API不额外禁止既有transaction。
- prepare冻结PNG不是rawPDF；源/高亮版本与render身份闭包。主审复现实际源hash drift和publication TOCTOU后，使用相同connection-level loader及artifact writer-locked savepoint callback关闭窗口；拒绝后无artifact和PNG pin泄漏。
- immutable artifact使用真实PNG内容hash，多provenance独立pin；可见file purge不破坏历史bytes。同步完整tuple/缺blob隔离、recount、备份恢复用真实DB/blob测试证明。
- 编辑器共享renderer与离屏/导出，active stroke独立透明层；IndexedDB先journal后CAS。草稿冲突、IDB失败、own-save event竞态、远端更新undo历史保护均有真实浏览器回归。
- 六工具接生产roster/descriptor，strict schema与backend deny_unknown_fields；get不返回点数组。update/remove经真实精确审批hook，global/group/plan bypass与never-remember路径有回归；资料与tool JSON不构成授权。
- apply的backend-only PREPARED/COMMITTED receipt在VFS提交前/后分别落库；Chat/VFS跨库不伪称单事务。实际parent/tool/call/input严格验证；terminal持久化失败不得宣称图已送达，VFS已提交仍返回committed真相。
- 可信undo只接受opaque Chat IDs/current revision/new opid，加载受信任receipt，object-level校验，保护后来human对象；没有UI supplied changes。跨provider-call精确retry不复制undo authority，新卡禁用假undo并链接原block/message。
- 真图传输使用typed immutable refs，本地compiler读取校验bytes后构造ImageUrl；任意MCP URL不fetch。完整工具轮后插图，single/variant共享失败处理；缺anchor/DB写失败必须显式失败，失败renderer历史不再次物质化、不阻断后续对话。
- request总图budget最多4、单4MiB/2048、总16MiB；整轮验证失败不部分消费。历史选择考虑已有user图/count/bytes并提供省略标签，先前helper绿不代替实际caller门禁。
- Provider验证走真实LLMManager/adapter/localHTTPcapture：ChatCompletions/Responses/Anthropic均验证图像part位于完整工具轮后、精确PNG字节。不使用收费模型，不访问用户凭据。
- 双壳用public Ink entry与已有DSTU file registry；module startup同步注册、path-only wrapper查真实节点；generic platform viewer不反向import feature。旧文件fallback保留；新增分层违规清零。
- Office本地逐完整页/slide固化、外部关系拒绝、ZIP/source/inflation/output预算；PNG与扁平PDF不覆盖原件。worker使用共享单权威wrapper，CT复用真实匹配版本静态资产而非第二setter。
- 新schema去重后2,851估算tokens。旧组51,500护栏保留，新增Ink独立3,000，合并54,500；新增成本透明记录，不牺牲strict validation。
- 交付打包检查发现manifest fixture被既有MANIFEST-*规则忽略，已复制为非忽略`ink-manifest-v1.json`并改Rust include；未改gitignore、未force-add、旧ignored文件保留。

## 审查发现与门禁

每一实际bug、编译阻断、错误夹具及精确修复见progress。原始日志不删除；无法证明的RED不追认。最终全分支结果应以最新四分片、Agent/app/ACL、fmt、Clippy和build退出码为准。

## 本轮最终收尾追加审查

- 主源码本地提交 `7fef25ec` 包含187文件，新增源码／fixtures没有因untracked被漏掉；源码清单与cached diff按实际Git审阅，依赖锁与ignore未改。
- Phase-5旧作者断言、GTK进程隔离、生产ChatV2State与run_now异步状态均精确闭合，两个真实case通过；不弱化structured_error或生产行为。
- 迁移锁仅追加三条，不修改旧SQL/hash；static135与base-ref不可变性门禁通过。
- 真实模型／Android发现并修复UI图片file_按实际type分类、来源canonicalres_ID、compact导出按钮、跨页remote undo与菜单焦点竞态；每项主agent回归证据见收尾ledger，无法证明的RED不追认。
- Android实际来源背景保存后重绘异常：主agent重启／新增笔迹在PDF和图片两路径重复复现，笔迹已写入但drawImage使用已close的ImageBitmap。不能以保存成功或旧52CT通过判断成品已完成。
- 最小生命周期修复主审：state持有已发布lease，prop替换／解绑后的cleanup释放；异步取消结果显式dispose，保留revision源高亮刷新和PNG／像素预算，没有吞异常、延时器、缓存或新依赖。未React提交且不可达的短命lease依赖浏览器GC，不引入持久缓存；取消与已提交路径仍显式释放。
- 主agent三项真实CT先3failed后3passed，完整55项通过，修复后四片12670pass／4skip／5todo；typecheck／lint棘轮／分层通过。Android新包PDF3→undo2→redo3，图片2→eraser1→undo2，强停重启后canonical和真实UI均保留，无此前DOMException；本地修复提交 `bc48e6eb`。
- 因上述实际缺陷，首轮ARM64虽构建成功且预检通过也不作为最终交付；最终包从bc48e6eb按官方profile重建并独立测试签名，不冒充生产证书。

## 明确未验证边界

Android真实压感、手掌误触、延迟与内存仍没有设备。真实视觉模型后来已获明确授权，在当前视觉配置下以自建夹具实际请求11/20次，工具与问AI附件识别、AI批注／可信撤销和历史恢复已验证，没有个人资料外发；这不是任意手写识别准确率或Android内模型质量结论。离线HTTPcapture不代替实际模型识别；Office为本地预览固化而非原生高保真，PDF为扁平栅格输出。

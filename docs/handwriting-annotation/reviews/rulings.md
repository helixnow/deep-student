# 本轮技术裁决完整清单

本清单保留原实施阶段的重要裁决。实现基线为 `7fef25ec`／`bc48e6eb`，基线文档为 `d48bec38`；裁决不等于用户新增批准，也不授权在新任务中自动提交或调用模型。旧 progress／closure-progress 已按用户本轮要求移入本地归档，见 [治理说明](../governance.md)。当前事实以 [README](../README.md)、[真机问题](../issues/android-import-preview.md) 和 [总体计划](../roadmap.md) 为准。

| 顺序 | 裁决 | 原因 | 判断错误的成本/验证 |
| --- | --- | --- | --- |
| 1 | 在既有功能分支原地继续，不另建worktree | 用户指定分支并要求恢复，避免分裂现场/缓存 | 可能需迁移未提交差异；保留所有现场 |
| 2 | 用户分工/集中记录优先于技能默认提交、隐藏ledger、子agent自测审查 | 主agent亲自测试与审查、子agent只实施 | 增加主agent工作量，不降低门禁 |
| 3 | 正向解析与负向验证分批红绿，恒Err不算负向正确证据 | 拒绝类测试须先真实暴露宽松路径缺陷 | 可能漏边界，完整validator/fixture测试补足 |
| 4 | 保持Chat/Office/导出完整首期范围 | 用户要求不做半套 | 更多实施成本，不牺牲完整性 |
| 5 | 保留files canonical manifest指针组，不新增第二权威文档表 | 现有sync只合并tags/favorite；document_id参与hash隔离身份 | tuple校验遗漏会混版/GC丢失；完整同步冲突pin测试 |
| 6 | resources.hash作为派生镜像，保存与同步批末协调 | 独立LWW资源行不能是第二事实源 | 镜像漂移；真实批同步与DB测试 |
| 7 | 格式校验期间独立准备纯renderer/geometry测试 | 无共享写路径，types只消费 | 契约变化需改测试；不提前依赖未验收格式 |
| 8 | 无共享写路径的测试/scaffold可独立并行 | 缩短等待并固定所有权 | 主agent统一门禁，避免把worker报告当验收 |
| 9 | region与highlighter保持multiply，纠正灰底像素期望 | 同renderer确定性叠色 | 不透明形状语义若不同需产品变更；实际像素测试 |
| 10 | 增最小现有VFS immutable render artifact表，PNG仍用真实contenthash | 防去重覆盖历史provenance与伪hash | 增migration/classification/refcount/backup测试，不新建存储系统 |
| 11 | 恢复继续既有分支/集中docs/主agent职责，不重做批准或删历史 | 保护未提交成果 | 必须审查tracked+untracked与跨任务接口 |
| 12 | appjobs先真实DB提交器正向门禁，再用具体typed pending bus | 不把render私有bus泛化成框架造成停工 | jobs需独立身份/超时/取消测试，不能借render通过冒称 |
| 13 | AI undo变化放backend-only Chat块ink_undo_json，不进入ToolResultInfo/模型点数组 | 保持可信来源与共享类型边界 | 增Chat迁移；跨库PREPARED/COMMITTED仅可证明时恢复，否则unknown |
| 14 | checked-store callback在artifact writer-locked savepoint内复核同frozen inputs | 关闭source/annotation/revision先读后存窗口 | 锁序/引用补偿若错会失败或泄漏；真实DB拒绝无pin测试。每页不重读原source物理字节，渲染使用ownedPNG与canonical元数据 |
| 15 | 旧组schema上限51500保留，新增Ink独立3000、all54500；旧total76600保留，Ink总3200、all79800 | 旧组实测51299只余201，六个strict工具压缩后2851，不可靠删校验塞入 | 激活新增技能有最多3000schema-token成本；实测54150/79688，旧组与新增组分别受测试约束 |

## 其他实施细化

- PDF worker权威从EnhancedPdfViewer移动到小型共享initializer，原wrapper与匹配pdfjs资产不变，两个消费者调用；测试仍扫描禁止第二setter。
- 可交付manifest fixture改用非忽略`ink-manifest-v1.json`，保留旧文件、不改ignore、不force-add。
- 跨调用精确apply retry不复制撤销authority，新卡如实禁用未绑定撤销并链接原message/block。
- 失败render历史保留错误文本，不把未送达图再次物质化或永久阻断新对话；成功typed refs继续strict provenance校验。

这些细化的错误代价与红绿门禁详见progress及final-review；外部/费用/不可逆动作未擅自扩展授权。

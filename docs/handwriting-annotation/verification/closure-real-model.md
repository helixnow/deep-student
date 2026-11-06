# 真实视觉模型验收报告

> 冻结历史验收，仍为11次实际请求。本轮文档治理／真机定位／计划未调用模型，也不将旧额度重置。原始计数日志已移入本地归档，查询见 [治理说明](../governance.md)。

日期：2026-11-03。主agent实际使用真实Tauri应用、生产Chat发送路径。批准范围为应用当前视觉模型、最多20次实际上游请求（包括续轮、失败、重试），仅自建夹具。

## 配置与外发边界

- 视觉配置：`vm_1793630193769_bmj7f9`，模型 `[特价]DeepSeek-V4.1-Flash`；原供应商未变。默认Chat槽是另一文本模型，没有拿文本配置冒充视觉能力。
- 全新隔离本地profile，正常用户profile只读；不读取无关聊天或个人文件，不打印密钥／完整配置／HTTP正文。
- 本机开发代理在实际上游发送前同步计数，锁定model与origin，不重定向／重试；本地伪上游先证明第21次不会外发，内部重试与工具续轮共享额度。
- 只发送自建页面；Android附件验证未点击发送，没有额外模型请求。代理最终已停止，不能重新开启另一轮20次。

## 逐项场景

| 场景 | 实际上游次数 | 观察／判定 |
| --- | ---: | --- |
| 无批注control，工具render＋回答 | 2 | 读出PLANET STUDY／Sample47，回答无手写和彩色标记；负对照通过 |
| 首轮默认memory调用 | 1 | 计入总额度；后续明确关闭memoryEnabled／autoMemoryExtraction，不隐去这次调用 |
| 有批注positive，工具render＋回答 | 2 | 真实编辑器保存红色手写24／红椭圆／蓝横线，提示词没有写答案；模型正确识别新增可见内容 |
| AI render→apply→回答 | 3 | 真实模型围绕红色数字新增绿色矩形，author=ai、committed、undo_available；没有更新或删除人类对象 |
| 重载对话后的历史只读比较 | 1 | 用已持久化不可变图片恢复，正确比较control与marked，无重新render冒充历史 |
| UI问AI图片附件首次尝试 | 1 | **失败**：file_图片误分File，模型如实说无效附件；HTTP200不算内容识别通过，原回答保留 |
| 引用类型修复后UI图片重试 | 1 | 新ContextRef经真实image compiler／native staging，模型从附件识别24、红圈、两条蓝线，正确指出绿色矩形不在当前图中；没有工具fallback |
| **合计** | **11/20** | 同模型／供应商，11条usage、11次HTTP200；包含上面的1次业务失败，不能说11次全场景成功 |

### 可信撤销与导出（不新增上游请求）

AI批注后再添加一条人类蓝色短线，然后仅以opaque session/message/block/current revision/new operation ID执行后端可信对象撤销。最后AI对象0、人类stroke6保留。PNG和PDF均形成真实VFS文件并打开。识别只读场景未修改canonical revision。

## 身份与证据

- 自建测试会话：`sess_a0ffd1c2-525c-4e60-8354-498a477ab550`。
- Control文档：`file_ink_667d500cb54ea6a55bce1e748d5aa2cd20e510e8b7e72e94ba5ee456508e03d8`，页面 `p_6nMuvUZ3J_hc`，revision `r_bjDmdw7BPw59cW7p`。
- Positive文档：`file_ink_copy_61fcf27b48ee1b0aa3d1dabf6c888e76f30c7a75cf7417aecfcc4e689f5378d4`，页面 `p_ktn5YmKnRYUr`，识别revision `r_fq4dPo9dBUE3gLGQ`。
- Control artifact/render `c9e5cf156d9fa2a2e48768468e673c69cdeda368fd29ff14c9dc08f266bf9d1c`，PNG content SHA `82ba7f70321f46fe420414afa0d49626a7115304da2d61f85159c660b5d31618`。
- Positive artifact/render `e856bfd7261feaa9f3a0d43039f0f91d9c7a602768d3a95548d1bbd4dc4adcf4`，PNG content SHA `2df066d3f71aa76192b3db1efdcddb20dab782f8beb516d87095b324065da3db`，1820×2048。
- AI apply消息 `msg_99302e94-180b-44a4-8278-b96cce21fc10`／块 `blk_a6a583d8-d219-4f88-a642-40e6f4497336`，写后revision `r_rbZ73dZrCWeQSVTl`。
- UI附件修复后成功消息 `msg_ef597c00-6a42-496a-9883-920ece4b44e9`。
- `closure-real-model-evidence.json`：仅自建会话16blocks，包含实际提示词／回答／工具回执与typed refs；主agent审阅，没有密钥／原始图像base64／个人聊天。
- `closure-live-usage.json`：11条白名单usage，主agent复核合计 **97,449 input tokens／3,191 output tokens**。价格未核实，不编造费用。
- 原metadata-only计数日志 `closure-live-provider-events.log` 本地保留，不force-add。

## 结论和限制

所测负对照、工具视觉输入、UI附件、受控AI新增／可信撤销、历史恢复与独立导出均已完成；真实失败被保留并修复后再验证。样本仅自建页面，不能推断通用识别准确率、任意字体／语言／照片噪声质量，也不能替代Android内真实模型调用或真机手写体验。剩余9次不是自动授权重跑的理由；当前验收不需要继续调用。

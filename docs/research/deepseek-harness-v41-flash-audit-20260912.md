# DeepSeek Harness / V4.1 Flash 适配审阅

日期：2026-09-12。对象：deep-student 当前工作区。本文区分官方源码事实、本地代码状态和未完成的运行验证；不代表已上线或已完成模型效果验收。

## 结论

项目已经具备接入 V4.1 Flash 的主要协议基础，本轮补充了推理参数、输出预算、跨协议推理历史回放和图片 token 计量的适配。但目前不足以宣称充分吸收 Harness 的优化：最大的实现缺口是图片规范化、请求累计传输预算和 Files API 传输复用；最大的证据缺口是真实模型的多轮、多图和长推理运行验证。

适配应继续沿用项目的 VFS、消息历史、provider adapter 和请求管线。Files API 适合作为 VFS 后面的供应商传输缓存，无需成为第二套附件管理系统。官方 Harness 的应用默认值和裁剪策略也不能直接替代学习工作台的产品决策。

## 官方基线与证据边界

- 仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。本次检出的远端 HEAD 为 `c291e7961a515f6d7af9304e7fd1d257929aef26`，收尾时通过 `git ls-remote` 再次确认一致。
- 根 `package.json` 为 `0.1.5-rc.2`，提交标题为 `Merge pull request #3977 from deepseek-harness/worktree/release-0.1.5-sync-master`。
- GitHub `/releases/latest` 返回 404，指定的 `v0.1.5` / `0.1.5` tag 查询没有结果。因此本文使用“本次最新 HEAD 源码”，不将其表述为已确认的最新稳定发布。
- Harness 的 DeepSeek provider 主体采用 Chat Completions。本文涉及 Responses 的修改属于本项目另一协议路径的兼容工作，不能称为直接照搬 Harness 的实现。
- 下文源码链接固定到该 commit。运行时 API 的最终接受范围、usage 和模型别名行为仍需真实请求验证。

## 能力对照

| 能力 | 官方 Harness 行为 | deep-student 状态与判断 |
| --- | --- | --- |
| 模型身份与能力 | `deepseek-flash` 显示为 DeepSeek-V41-Flash，支持文本、图片和历史中的 system 消息；旧 `deepseek-v4-flash` 在目录中仍为 text-only | 需要按 endpoint、实际模型 ID 和协议共同判定；不能由 Flash 字样推断所有第三方路由都支持相同能力。旧别名的视觉能力应单独验收 |
| 思考强度 | 默认 high，支持 off / low / high / max | 本地适配归一化 minimal/low→low、medium/high/xhigh→high、max/ultra→max；关闭思考独立处理。本轮聚焦测试覆盖请求转换 |
| 采样与输出预算 | 供应商参数有专用语义；Harness 自身默认 context 为 1,000,000、max output 为 256,000 | 本地按实际 thinking 模式设置采样，保留显式输出预算。Harness 默认值不等于 API 默认值，也不是强制最小输出量 |
| 历史与推理回放 | 保留推理内容及消息顺序，允许历史位置上的 system 更新 | 本轮补充 Chat 推理文本转 Responses reasoning item，避免与原生 item 重复；保留后续 system 的位置。仅有序列化测试，未验证跨协议真实续聊 |
| 工具结果中的图片 | 工具结果保持字符串，图片放在后续独立 user 消息 | 项目已有多模态管线，但该具体顺序、工具调用配对及第二轮模型可见性尚未完成真实验证 |
| 图片 token 计量 | 14px patch、每轴 3:1 下采样、544² 像素下限、单图最多 1024 tokens，迭代到稳定结果 | 本轮将尺寸投影接入流式和非流式最终输入预算，替换该官方模型路径原先每图 8192 的统一预留；损坏/未知 inline 数据仍保守预留 |
| 图片规范化 | 默认目标 640000 像素，low 为 512²；每图编码目标 1MiB；计量与实际发送变体相协调 | 尚无与官方相当的 provider 专用闭环。仅降低 token 估算不会缩小实际请求，仍可能出现 token 未超限但字节超限 |
| 请求图片预算 | 默认文件引用请求预算 128MiB、最多 600 图；inline 累计 20MiB；实际编码后再次检查 | 项目有 VFS、水合、MIME 检测、图片数量限制及 base64 发送基础，但未实现对应的累计字节预算和可恢复卸载闭环 |
| Files API | 上传、复用、过期刷新、精确失效后重传、配额恢复、上传失败退回 inline | 当前缺失，是多轮多图传输效率的重要差距；应接在 VFS 之后，远端 file_id 不应成为附件身份 |
| SSE 结束与 usage | 等待 `[DONE]`，保留尾随 usage；空推理不打开块，空工具 ID/name 不覆盖已知值 | 本地已有相关解析逻辑；本轮补了异常 finish 分类测试。仍需真实工具流和尾随 usage 验证 |
| 截断语义 | `length` 单独归类为 max-tokens，其余异常 finish 为 error | 本地目前经 `SafetyBlocked` 事件携带 `provider_error`，包括 length。能阻止部分输出被当成正常结束，但与 Harness 的原因分类并不等价，且位于共享 OpenAI adapter，影响面需专门验证 |
| 缓存计量 | DeepSeek prompt_tokens 包含 cache hit；Harness 内部把非缓存 input 与 cache 分开计算 | 不应只检查字段能解析，还应验证 UI、费用和上下文统计是否重复累加缓存 token。当前缺少真实 usage 对账 |
| 超时与重试 | idle timeout 300s、Files resolution 60s；读取 Retry-After / request ID；模型目录默认 normal 重试五次 | 尚未证明本地长推理、取消、退避和 Files 超时语义等价。应复用既有请求层，避免叠加多层重试 |

官方实现证据：

- [模型目录与默认强度：index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/index.ts)
- [请求执行、默认预算、超时与回退：adapter.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/adapter.ts)
- [图片计量：image-tokens.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/image-tokens.ts)
- [图片规范化与请求计量：request-pricing.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/request-pricing.ts)
- [工具结果及实际编码后预算：serialize.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/serialize.ts)
- [Files 协议：files-api.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/files-api.ts)
- [文件复用与生命周期：file-store.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/file-store.ts)
- [流式结束、工具 delta 与缓存 usage：translate.ts](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/translate.ts)

## 本轮代码修正

1. `src-tauri/src/llm_manager/adapters/deepseek.rs`：官方路由识别、effort 映射和专用生成参数。thinking 开启时移除 temperature、约束 top_p 至 0.95–1；关闭时移除 top_p、保留 temperature；移除两类 penalty。不再因 max 档而把显式的小输出预算抬至 128K。本地当前回退输出预算为 8K/64K/128K，硬上限 393216，这些值应与 Harness 的应用默认值分开理解。
2. `src-tauri/src/llm_manager/model2_pipeline.rs`：接入图片尺寸投影和官方生成参数路径，同时覆盖流式/非流式请求。本地测试输入 544×544 得到 184 tokens、1000×1000 得到 602 tokens。当前读取 inline 图片时会解码图片，长历史下的成本尚未测量；宜复用水合阶段已有尺寸，避免多次全图解码。
3. `src-tauri/src/providers/mod.rs`：Responses 的 reasoning.effort、关闭值 none、推理历史转换、system 顺序、top_p 透传以及异常 finish 处理。
4. `src-tauri/src/providers/deepseek_harness_tests.rs`：新增最终请求形态和流事件回归覆盖。

这是一组工作区改动，尚未提交。工作区还有模型注册表、前端和笔记等并行修改，不能将所有 DeepSeek 周边 diff 都认领为本轮产出。

图片算法还存在边界差异：官方在十轮内不收敛时抛错，本地返回不超过 1024 的结果。因此目前只能称为正常几何示例对齐，不能称为全部输入逐项等价。官方 V4 家族入口与 V4.1 特有视觉算法的适用范围也应结合实际模型能力验证。

## 在项目设计下发挥效果

### 优先完成图片请求闭环

在现有附件水合与 provider 请求构建之间，完成“读取 VFS 原件 → 生成发送变体 → 计算该变体的 token 和字节 → 选择 inline/file_id → 校验最终请求”。预算必须以真实发送内容为准，不能让上下文压缩用一套图片估值、最终请求再用另一套。

学习场景包含试卷、公式、图表和 PDF 页面，机械套用 640000 像素或 1MiB 可能损失小字。应以这些真实材料比较识别质量、首 token 延迟、请求体积和 usage，再选默认变体；这不是越小越好。原图保留在 VFS，卸载历史图片时保留模型能重新读取的引用。

官方按字节/图片数量执行的传输预算有实际供应商边界依据；它与按轮数、关键词或相似度拦截模型行为不同。本项目不应引入后者。

### 将 Files 作为传输缓存

官方上传上限为 128MiB，但聊天单图仍受 32MiB 约束，改用 file_id 不会绕过后者。Files 配额为每 key 10000 文件、25GiB；Harness 默认保留七天，提前一小时刷新，并只清理自己拥有的 `dsh-` 文件。上传支持的过期区间为 3600–2592000 秒。

本地接入时复用 VFS 稳定资源 ID/版本及明确的图片变体参数，并按 endpoint、凭证作用域隔离远端引用。复用既有持久化能力；不要对含 HashMap 的序列化对象做哈希。并发上传应合并，取消单个请求不应误取消其他等待者。缺失或过期 file_id 精确失效后重新上传；上传失败回退 inline 时必须重新核对累计字节预算。

不直接照搬 Harness 的原始字节步长、inline 步长和数量步长：这些是其卸载策略，具体保留哪些学习材料应服从项目已有上下文和可重读引用设计。

### 保持历史前缀与预算一致

保留 CoT 字段只解决了回放格式的一部分。动态 system、工具声明顺序、图片变体和压缩后消息顺序仍会影响前缀缓存。应用压缩和请求尾部裁剪应共享有效上下文/输出预留的决策，保留工具调用与结果的配对，并明确哪些旧图片可通过 VFS 重读。

不建议为追求表面的一致把全局 context/max output 直接换成 Harness 默认值。应先确认选中模型、实际路由与用户输出预算，再沿项目既有预算路径传递。

## 验证与后续顺序

本轮已在本地 Rust 环境执行并通过 `cargo check --lib`、adapter 21 项测试、图片计量 2 项测试、provider 4 项测试，共 27 项聚焦测试；格式检查和 `git diff --check` 通过。测试观察到的是请求 JSON、算法返回值及模拟 SSE 事件行为，不是 DeepSeek 服务端接受或真实模型效果。

尚未启动真实桌面应用进行本轮验收，也未进行真实 DeepSeek API 请求。下一步应按以下顺序完成：

1. 先验证已改路径：官方 `deepseek-flash` 的 thinking off/low/high/max、显式小输出预算、多轮工具调用和推理历史回放；分别检查 Chat 与 Responses 的服务端接受情况及续聊结果。
2. 验证共享流式行为：真实或已有独立服务端样本覆盖正常结束、输出截断、工具参数截断、尾随 usage 与取消；将 length 的产品表现与供应商故障区分，确认其他 OpenAI 兼容供应商没有回归。
3. 补齐图片规范化与累计字节预算，再用真实试卷/PDF 页面走附件与工具结果图片两条路径；同时观察识别质量、请求体积、延迟、内存和输入计量。
4. 接入 Files 复用与回退，验证相同附件跨轮免重传、过期重传、配额错误、取消及 inline 回退后的预算。
5. 对真实缓存 usage 和长推理 idle 行为做一次端到端核对。桌面验证必须使用 `npm run tauri dev` 的真实应用。

以上未完成项是进一步实现和验收清单，不应被计入“已兼容”或“已最大化发挥效用”。

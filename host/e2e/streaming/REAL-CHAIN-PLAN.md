# 真实主链复验：普通回答与 thinking 已执行，其余场景待验收

## 当前：cancel-after-partial 定向保红，待 owner 核定

`eaab4d13a` / main `f2d5b6c46`，`20261105015318-089cba` exit1/1failed。真实HTTP保持open，消费生产partial后公开cancel，实际Abort/非EOF关闭、终态时部分DB/唯一session取消与gen1前置证据已过。但Rust外层Drop预期九条 vs实际十条（多scoped_cancelled），session/handler取消后JS loser还继续LLM日志。已投L03/C1请求核分支，不改生产/过滤事件或改预期迁就。原值 `/tmp/opencode/x5-cancel-CmPIhY/trace.json`；cancel未通过，不扩retry/工具/变体，完整parity未通过。

## 当前：error-after-partial EOF 分支定向通过，待 §5/复核

`error-after-partial.test.ts`（main `a9683a43b`）经 **`20261105004415-2455a3` exit0/1passed**。真实 HTTP/SSE 正常 EOF、不发 Done，触发 Rust missing-terminal LLM 失败；fake 只有部分正文实际消费，无坏解析帧。精确块 error 与 ChatV2Error::Llm 终态 Display、唯一失败终态前真实部分落库（collected text 按Rust保存为success）、全十条事件、generation与session/task/pending-cancel清理均已定向核对。未测 socket read-error、取消或其他场景，不计完整 parity；细节见 TESTMAP/审计。

## 已复核：thinking 限定场景

`thinking.test.ts`（main `e9df01a3c`）只走真实 send/HTTP/sink/DB，作业 **`20261105001757-5863a6` exit 0，1 passed**：四帧实际消费、reasoning/content 两块终态前持久化、全部15条序列、seq/generation 与 reasoning-token usage 均验证。首跑 `20261105000718-50a066` exit1 暴露预期遗漏 Rust 末尾 reasoning 汇总，第二次 `20261105001033-ff97b2` exit1 暴露 raw undefined own-key 与 JSON 键省略的比较层级错误；现保留 raw精确断言并序列化全数组核对，不过滤事件。历史与 Rust 依据见 TESTMAP。工具/部分保存/retry/变体断言不变，完整 parity 不通过。

## 当前：首条普通回答门槛已通过

基线 main `0d8591e00`（merge `a4639ff0d`）：`normal-answer.test.ts` 单条经作业 `20261104234958-48890f` **exit 0 / 1 passed**。真实 diagnostics 提供 backgroundTasks，send 注册后实际走 L04→L03→L02，假 adapter 只注入公共 llmAdapters；本地 SSE 提供四个固定帧并消费 answer 脚本（含 usage）。fake.created=1、requests=1、parsed=4；终态 listener 同步读取真实仓储，用户/助手/正文均已保存；全量 11 条 Host 事件（含 request/skill/request-body audit 及 scoped start/id/usage）精确比对，content:end 在唯一 stream_complete 前。没有手动 bindSink/save/emit，也未替换任何 owner 方法。

原默认小宿主仍无 diagnostics，保留严格 command-not-found 与 retry guard 负证据；它不再作为主宿主的永久阻塞。首条真实模型请求的 endpoint 由测试传入本地服务，默认 `127.0.0.1:9` 仍用于小宿主拒绝意外联网。

该通过是 Host 普通回答基线，不是 L01 真实供应商解析器或 Electron 窗口验证，也不关闭完整 parity。下面工具第二轮/错误取消部分保存/retry generation/变体断言仍待执行；`chatToolRuntime` 缺口继续阻塞真实工具轮。

## 历史基线与预备断言

最新 main `f821b3733`：L04 已有四个 send/retry 注册及真实事务仓储面，L03 多变体运行时也已提供。当前 X5 小宿主未安装提供 backgroundTasks 的真实 diagnostics 插件，send 绑定尚未触发；三个 retry 已注册。后续首条普通回答需要补真实依赖、公开模型设置与离线 provider 字节输入；不再把历史缺注册/仓储当成 main 现状。本次 main-red 仅修复 retry_variants 合法参数和精确业务 guard 证据，不签任何成功主链场景。

最新 main `7f4fb688b`（正常 merge `a9413c1c5`）：L03 单变体 execute/tool-loop/工具轮/压缩及三个公开 execute 入口已实际实现。仍缺 L04 四个 send/retry 注册及 execute 所需完整事务 owner 面（`execution-runtime.ts:39–52`）。下方旧“execute 缺失”文字仅反映历史；首条验收不变，不得测试补 owner 方法绕过阻塞。

更新至 main `1e893eb61`（正常 merge `61c8b64cb`）：L02 unified stream 已提供，L03 `e3e715e00` 也已有真实 `createUnifiedTextStream` 消费及无工具预备文本轮的最终/部分保存与终态编排。尚缺四个 send/retry 注册、公开运行时 execute 与 tool-loop；目标 `ChatPipelineExecution` 接口不等于已安装实现。以下旧基线缺口描述仅为历史，待验收断言保持，不以测试自行拼装预备阶段代替 send。

当前基线 `3380b7849`（main `3b2758d7a`）缺 send/retries、统一 chat stream 调用和 execute/tool-loop。**本文件是待接线验收断言，不是通过的测试，也不是用 mock pipeline 造轨迹。** X5-05、X5-04 binder、X5-03 发射子项按已签收结果，不再重复运行。

## 先只运行一个普通回答

入口到位并 merge 后，新建单次宿主/会话，仅以公开 `llmAdapters` 注入假 LLM，走真实 `host.invoke('chat_v2_send_message', {request})`。实现者必须提供这个注册点→公开 execute→统一 stream→真实 provider adapter→生产 sink→最终持久化的可达调用链，不能由测试自行调用 adapter、save 或 emit 完成拼接。先确定真实 transport 的离线输入方式；当前假 adapter 的 `127.0.0.1:9` 是**拒绝意外联网**的占位地址，不代表已有可用传输。若 adapter 替换仍不足以提供离线 provider 字节，记录公开注入点缺口，不能拦截/伪造 chat execute。

配置固定模型、关闭非本场景的自动摘要/额外模型调用（仅使用公开设置）；保留本次 **全部** Host events，不先筛掉 audit、request-body 或非文本事件再宣称完整序列匹配。相关场景必须使用独立宿主，禁止沿用一个 fake 的请求游标跨场景。

待加入真实测试的最低断言（变量来自一次实际 invoke，不得手工填充）：

```ts
expect(fake.created.length).toBeGreaterThan(0);
expect(fake.requests.length).toBeGreaterThan(0);
expect(fake.parsed.length).toBeGreaterThan(0); // 创建 adapter 不等于消费固定输出
expect(replyId).toBe(assistantMessageId);
const sessions = host.eventsNamed(`chat_v2_session_${sessionId}`);
const terminals = sessions.filter((e: any) =>
  ['stream_complete', 'stream_error', 'stream_cancelled'].includes(e.eventType));
expect(terminals).toHaveLength(1);
expect(terminals[0]).toMatchObject({ eventType: 'stream_complete', messageId: replyId });
expect(host.ctx.chatSession.getMessage(userMessageId)).not.toBeNull();
expect(host.ctx.chatSession.getMessage(replyId)).not.toBeNull();
expect(host.ctx.chatSession.getMessageBlocks(replyId)
  .filter(b => b.type === 'content').map(b => b.content).join('')).toBe('固定回答');
```

执行前按真实 wire 类型核对块类型键；现有 MessageBlock 是 `type`（不是内部 `blockType`）。再精确核对 blockId、messageId、metadata、usage、各通道序号与 session terminal 之前的 flush。读取是公共 chatSession 的真实持久化查询，不是当前 adapter 的累积字符串。终态回调时再立即读取 SQLite/公共仓储，证明本轮保存已发生；不能测试结束后调用 save 补齐。

普通回答这一个用例成功后，才经 jobs 扩展以下场景；没有成功不批量重跑七场景。

## 工具第二轮（仍未覆盖）

1. 当前 `scripts.tool` 中 `builtin-web_search` 会触发外网依赖，**不能直接当确定性真实工具往返验收**。接通后改用提供方真实注册、可公开授权根内读取本次临时文件的工具（例如真实 `workspace_file_read`，以当时公开 schema 为准），文件内容固定 `X5_TOOL_RESULT`。不写测试 executor，不用假成功取代权限准入。
2. 固定 toolCallId，确认 provider 的 ToolCall 形状与统一 stream 公开协议一致。测试只驱动 fake provider 输出，实际 registry 执行真实工具，先有 tool_call:start，再有包含标记的 end；仅 preparing/收集不能算执行。
3. `fake.requests` 记录的输入来自真实 `ProviderAdapter.buildRequest`。对采用 OpenAI messages 的固定测试模型，准备如下**严格第二轮断言**，不得对内容做宽松 substring 取代 call-id 绑定：

   ```ts
   expect(fake.created).toHaveLength(2);
   expect(fake.requests).toHaveLength(2);
   const messages = (fake.requests[1].body as { messages: any[] }).messages;
   expect(messages).toEqual(expect.arrayContaining([
     expect.objectContaining({ role: 'assistant', tool_calls: expect.arrayContaining([
       expect.objectContaining({ id: toolCallId }),
     ]) }),
     expect.objectContaining({ role: 'tool', tool_call_id: toolCallId,
       content: expect.stringContaining('X5_TOOL_RESULT') }),
   ]));
   ```

   其他 API 协议必须按各自真实结构核对，不把失败的 messages 断言改成“任意 JSON 含标记”。严格的两次请求数以关闭摘要/额外模型后的独立场景为前提。
4. 第一轮工具调用→真实工具终态→第二轮请求构建→第二轮 token→唯一 stream_complete 的偏序用同一观测时间线记录；`fake.requests` 只证明 body，不单独证明跨层时序。用只读 listener + adapter 请求观测记录顺序，不主动 emit 工具结果。
5. terminal 时读取真实持久化的 tool output、toolCallId/replay sidecar 与第二轮正文，退出/重开本次测试数据库再读不丢失；不以 `VariantStreamContext.events` 或 test sink 数组代替数据库。

## 出错 / 取消的部分保存（仍未覆盖）

- error 脚本实际发出 `部分回答` 后 provider 抛 `X5 deterministic LLM error`。捕获实际 invoke rejection，避免未处理 Promise；同时独立断言唯一 stream_error，无 stream_complete。已经有输出时不得再创建一个 provider 适配器拼接生成。
- cancel 必须用 provider 读流的可控屏障：先等待第一条真实 content chunk 被 Host 捕获，再调用公开 `chat_v2_cancel_stream`，让真实 stream 的 AbortSignal 唤醒退出。不能靠固定 sleep 猜时序，也不能手调 `emitStreamCancelled`。
- error/cancel **各自**在唯一 terminal 到达时，用真实公共仓储读取 user 和 assistant 部分正文，断言分别等于固定已消费前缀，不是仅 expect nonempty。记录实际 start 的 generation，终态必须同代。取消不要求每个 open block 都有 end，也不应出现把连接异常映射为 stream_error 的替代终态。
- 取消前 provider 若已生成完整工具调用但尚未进入真实 registry，应有受控检查点验证待执行调用被丢弃；真实 registry 未执行，不能凭 fake 中“已生成工具”推断执行次数。
- `createPersistence/saveIntermediateResults` 存在不代表最终/取消保存接入了 execute。本轮不得手工调用该 helper 补出部分数据，也不以 writer spy 自述为落盘证据。若公开只读 replay 查询尚无入口，登记 L04 子缺口，不自己写生产表。

## 用户取消后立即重试 / generation（仍未覆盖主链）

1. 第一轮在已输出前缀处暂停，调用真实 cancel。用真实 retry_message/retry_variant 之一对同 messageId 重试；第二轮 start 必须有严格增大的 generation，而不是测试 `withStreamGeneration(12)`。
2. 准备断言：

   ```ts
   expect(typeof oldStart.streamGeneration).toBe('number');
   expect(newStart.messageId).toBe(oldStart.messageId);
   expect(newStart.streamGeneration).toBeGreaterThan(oldStart.streamGeneration);
   expect(newTerminal.streamGeneration).toBe(newStart.streamGeneration);
   expect(newTerminal.eventType).toBe('stream_complete');
   ```

3. 通过旧 provider 的可控取消/收尾屏障产生真实晚到旧终态，若该路径能产生事件，generation 必须仍为旧值；前端不能结束新流。若生产 guard 抑制旧终态，则核对确实未发，不能手工伪造一个“真实旧终态”。已有 bridge 测试的手发 generation 样本不算此主链证据。
4. 每 generation 恰好一个 terminal（被 guard 抑制的旧事件依 Rust 路径单独说明）；重试最终保存不能把第一轮前缀与第二轮答复错误拼接。检查真实 hook owner 清理不注销新流、无 pending cancel 残留。
5. 自动网络重连另测：未输出的可重试错误→stream_reconnect→同冻结模型重试，输出后错误禁止自动重连。当前 `scripts.retry` 仅是成功固定答复，**还不是**自动错误→重连脚本，不能通过改测试名宣称已覆盖。

## 最后扩展思维链和变体

分别核对真实持久化中的 thinking/content 分段和变体归属；多个变体真实调度、各自 provider 消费、variant_end 状态/usage、聚合 session usage 与最终保存。已签收的生产 binder/context 发射只说明发射入口可用，不代替此场景。每次新增闭环结果记录具体 owner 修复 commit、调用链、job ID、`job.mjs result` 的真实退出码；跨平台未跑就保留未验证。

# r3 #10：SkillInjectionAnchors.skill_content_digests 生产写入侧落地

轮次：Wave2-A 第 3 轮补丁（#10，digest 生产者）。审阅（`r3-review-replay.md` 缺口 B、
`r3-review-branch-copy.md` 非阻塞事项 1）确认 `skill_content_digests` 此前只有
types 定义（#2）、history 门禁消费（#3）与测试构造，live 写入侧两处锚点均未填，
门禁对真实数据空转。本补丁只补生产写入，不动门禁、不动 hooks、不 bump prefix
generation。

## 改动文件

仅 `src-tauri/src/chat_v2/pipeline/tool_loop.rs`，两处锚点写入点各加一段
「先算 digest、写锚点后立刻插 map」的代码。

## 两处补丁位置（补丁后行号）

| 锚点 | 补丁行号 | digest 覆盖的 id 集合 |
| --- | --- | --- |
| turn 级（首轮冻结注入） | tool_loop.rs:708-734（digest 计算 713-725，插入 732-734） | `built.audit.injected_skill_ids`（即写进 `anchors.turn_skill_ids` 的同一份） |
| tool 级（环内 load_skills 追加） | tool_loop.rs:1975-2009（digest 计算 1982-1996，插入 2007-2009） | `batch.audit.injected_skill_ids`（即推进 `anchors.tool_anchored` 的同一份） |

补丁前对应原始位置：turn 级 `anchors.turn_skill_ids` 赋值在 :712 附近，tool 级
`anchors.tool_anchored.push` 在 :1958 附近，与任务卡描述一致。

## skill_contents 来源（与发出字节严格同源）

两处都不新取正文，直接复用**渲染注入消息的那份 map**：

- turn 级：局部变量 `skill_contents`（tool_loop.rs:690-695），即
  `ctx.options.replay_skill_contents` 优先、退回 `ctx.options.skill_contents`、
  再退回空 map——与传给 `build_transient_skill_messages_with_audit_excluding`
  的引用是同一个。
- tool 级：局部变量 `batch_contents`（tool_loop.rs:1947-1953），同样的
  replay 优先 → options 退回链——与传给 `build_in_loop_skill_messages` 的
  引用是同一个。

因此 `skill_body_digest(id, body)` 的 body 就是本轮实际发给 provider 的锚定
正文字节，不存在「digest 取自 A 来源、消息渲染自 B 来源」的错配。

## 纪律执行情况

- **正文不可得不写假 digest**：`filter_map` 只对 `map.get(id)` 命中的 id 生成
  条目；缺正文的 id 在锚点里没有 digest 键，重放侧（history.rs 门禁）按
  「旧锚点无 digest → 有正文就重建」兼容分支处理，行为与 r3 前一致。
- **正文不进 anchors**：只插 `skill_body_digest` 的 64 字符 hex 输出，
  `without_skill_contents` 隐私纪律不变。
- **不 bump prefix generation**：本补丁只让门禁有数据可校验；mismatch 时的
  「开新 prefix generation」信号仍留给后续轮。
- **digest 计算在取 `anchors` 可变借用之前完成**（先 collect 成
  `Vec<(String, String)>` 再插入），避免 `skill_contents`/`batch_contents`
  （借自 `ctx.options` 的只读字段）与 `ctx.options.skill_injection_anchors`
  可变借用交叠，借用形态与改动前既有代码同构。

## 语义要点

- turn 级与 tool 级共用消息级 `skill_content_digests` map（按 skill_id 键），
  与 #2/#3 落地形态一致；同轮两级注入取自同一 map，同 id 必同体，insert
  覆盖无害。
- turn 级注入整轮只冻结一次（`frozen_turn_skill_injection` 守卫），digest
  随首轮冻结一次写入；tool 级每个 load_skills 批次在 push `ToolAnchoredSkills`
  的同一分支内写入，两者都满足「锚点写入之后立刻填充」。
- 锚点经 `ChatV2Options.skill_injection_anchors`（`#[serde(skip)]` 运行时字段）
  由 save_results 持久化到助手消息 `meta.skill_injection_anchors`
  （persistence.rs 既有链路），本补丁不改持久化路径。

## 未跑验证

按铁律未运行 cargo/npm/测试，未 git commit。代码为纯追加式小改（两段
局部块），借用/类型形态对照既有编译通过代码手工核对。

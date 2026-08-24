# Wrap-up #4：Round 3–5 安全复审

## 结论

本轮按“不扩功能、只修真实漏洞”复审 transform（ops/script）、APKG 导入、
LLM critic 与 VLM prompt 拼接。确认并修复 1 个高危和 3 个中危问题；VLM
`goal` / `visualHint` 已有正确的数据边界，本轮补回归测试而不改变行为。

## 已修问题

| 等级 | 位置 | 问题 | 修复 |
|---|---|---|---|
| 高 | `chatanki_transform_script.rs` / `shell_sandbox.rs` | Linux bwrap 原来把宿主 `/` 整体只读挂入沙箱；“只有 job 目录可写”并不等于“只有 job 目录可读”，脚本可读取用户文件并经卡片字段外带 | 为 untrusted script policy 增加严格读模式：空 tmpfs 根起步，只重挂系统运行时、解释器运行目录和 job；交互式 local shell 保持原兼容模式 |
| 中 | `chatanki_transform.rs` | regex 输出上限在 `replace_all` 之后检查；攻击者可让程序先尝试分配数 GiB/更大的结果，检查尚未执行就 OOM | 按 regex crate 的 `$name` / `$1` / `${...}` / `$$` 语义先精确计算展开字节数，超限时不分配结果；存量超长字段的原样保留/收缩语义不变 |
| 中 | `apkg_importer_service.rs` | `Path::exists` 会跟随符号链接；悬空链接会被判断为“不存在”，随后 `File::create` 可跟随链接在媒体目录外创建或截断文件 | 用 `symlink_metadata` 拒绝链接/非普通文件，并用 `create_new`（Unix 为 `O_CREAT|O_EXCL`）原子关闭检查—创建竞态 |
| 中 | `anki_critic.rs` | 源材料、卡片和同源金标直接拼入 critic prompt，可伪造段落/输出格式并注入裁决指令 | 所有不可信字段置于显式 BEGIN/END 数据块，替换输入中的结构分隔符，并在固定指令区声明数据区内容不是指令 |

另确认 critic 写回已使用送审快照 `updated_at` 的 library CAS；模型调用期间发生的
用户编辑不会被覆盖。脚本输出仍只允许白名单 card id，脚本回传 version 不参与 CAS。

## VLM `goal` / `visualHint`

`build_import_prompt` 与 `build_vlm_light_prompt` 不再把两个字段当作裸指令拼接：

- `goal` 放在 `<<<GOAL_BEGIN>>>` / `<<<GOAL_END>>>`；
- `visualHint` 放在 `<<<HINT_BEGIN>>>` / `<<<HINT_END>>>`；
- 两者都先替换输入自带的 `<<<` / `>>>`，不能提前闭合数据块；
- 固定提示明确声明块内是用户数据而非指令。

本轮新增测试同时覆盖 full/light 两条 VLM prompt 路径，确保恶意 goal/hint 不能生成
第二个合法 END marker。未新增参数或改变路由行为。

## 已确认的既有边界

- transform ops 使用 Rust `regex`（线性时间、无回溯型 ReDoS），且已有 op/pattern/
  replacement/tag/卡数上限和逐卡 CAS。
- transform script 继续 fail-closed：无平台硬沙箱或解释器即拒绝；网络禁用、环境变量
  白名单、进程组超时清理、日志/输出有界，job 快照为 owner-only。
- APKG 已限制压缩包大小、条目数、单条目及总解压量、zstd window、SQLite 查询时间、
  卡数/字段/标签/物化总量；媒体名不能携带路径组件。
- critic 响应只接受送审 card id 白名单；非法/未知 id 拒绝，解析失败降级 keep，
  revise 无有效载荷降级 flag。

## 回归测试

- `security_regex_growth_is_rejected_before_result_allocation`
- `bounded_replace_preserves_regex_capture_expansion_semantics`
- `bwrap_args_strict_read_mode_uses_empty_root_and_rebinds_only_allowed_path`
- `e2e_host_files_outside_job_are_unreadable`
- `media_import_refuses_dangling_symlink_targets`
- `prompt_injection_cannot_close_untrusted_data_blocks`
- `test_vlm_goal_and_visual_hint_cannot_close_data_blocks`

## 残留风险

- Prompt 分隔和固定指令只能降低语义注入成功率，不能把概率降为零；真正的写入边界仍是
  响应 schema、card-id 白名单和 CAS。不要把 LLM 输出直接视为可信。
- 脚本沙箱仍需挂载解释器所需的系统运行时目录；这些目录不应存放应用密钥。用户目录和
  job 外业务数据在严格模式下不可见。
- 脚本执行有 CPU/进程/文件/输出/超时边界，但当前跨平台沙箱没有统一的进程树内存配额。
  script 本身属于显式高风险操作；后续若平台提供可靠的 cgroup/Job aggregate memory
  配额，可作为纵深防御补充，本轮不引入不一致的单平台行为。

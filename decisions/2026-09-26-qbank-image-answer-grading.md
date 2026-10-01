# 题库图片作答 — 主观题/填空题手写拍照上传与多模态 AI 判分方案

日期：2026-09-26
状态：已实施（分支 feat/qbank-image-answer-grading，5 commit：523f8456 方案文档 / 891fdaaf 信封契约 / 0c16da13 后端多模态评判 / 0cdad201 前端上传 UI / dcd4daa3 structured_data 补缺）
决策点确认：D1 Analyze 同批支持=是；D2 上限对齐作文口径（6 张/50MB/100MB）；D3 上传前压缩保清晰（长边 2000px jpeg 0.9）；D4 填空题开放图片作答=是；D5 structured_data 补缺=做。
测试结果：后端 qbank_grading 21/21、question_bank_service 26/26、question_repo 5/5、essay_grading 51/51；前端 tsc 绿、vitest 新增 16 例全绿（全套 25 个失败经干净 main 基线对照确认全部为既有失败，crepe/mindmap 等无关模块）。
前置探索：本会话对答题/判分全链路的代码实证（file:line 均为当时 main 0.9.70 口径）。

## 〇、需求与结论

**需求**：主观题（short_answer/essay/calculation/proof）与填空题（fill_blank）支持用户上传手写答案图片（拍照/相册），AI 评判时多模态模型直接读图判定正误。

**结论：可行，且为中等偏小特性**。三条关键事实：

1. **后端权威判分早已统一**：`check_answer_correctness`（question_bank_service.rs:1122,1124-1127）中 `FillBlank` 与四个主观题类型一律返回 `(false, true)`（needs_manual_grading）——填空题在后端不走字符串比对，全部交 `qbank_ai_grade` 管线（前端 `gradeAnswerLocally` 的结构化判分只是即时反馈，权威以 submit 返回为准）。**想加图片作答的所有题型，判分收敛在同一条管线，只需改这一条**。
2. **完整先例已在库内**：作文批改（essay_grading）已实现"前端 FileReader 上传 → `image_base64_list` 请求字段 → 数量/体积校验（每类 6 张 / 单张 50MB / 合计 100MB，essay_grading/pipeline.rs:42-46）→ `stream_grade` 在 `config.is_multimodal` 时构造 OpenAI 图文 content parts（pipeline.rs:1101-1180，`guess_image_mime` + data URL）"。qbank_grading 的流式骨架本就复用自 essay_grading，多模态分支照搬即可。
3. **同步风险已排除**：VFS 附件内容（blobs）走内容寻址清单同步（data_governance/sync/mod.rs:10684 起），`resources`(10)/`blobs`(20) 依赖排序先于 `answer_submissions`(60)（mod.rs:6055-6080）——答案信封引用的图片会**先于**作答记录到达另一台设备，跨设备不出现"有引用无图"（注：blob 清单同步属全量扫描模式，答案图片入 blobs 后会被自动带上，无需额外接线）。

## 一、现状链路（实证）

### 作答侧
- `QuestionBankEditor.tsx:1816` `renderAnswerInput`：short_answer 单行 `Input`(:1891)，essay/calculation/proof 走 `Textarea`(:1902)，fill_blank 逐空输入（`FillBlankAnswer.tsx`）。全部纯文本。
- `handleSubmit`(:1084)：按契约序列化 user_answer（fill_blank 多空 JSON 数组 / 其余裸文本）→ `onSubmitAnswer` → `useQuestionBankSession` → 后端 `qbank_submit_answer` → `submit_answer_with_conn` 存 `answer_submissions.user_answer`（TEXT 列）+ `questions.user_answer`。
- 主观题/填空提交返回 `needsManualGrading=true` 时**前端自动触发** AI 评判（:1117-1158），verdict 落库后 `onGradingResolved` 回写练习进度与模拟考成绩。

### 判分侧
- `qbank_grading/pipeline.rs:60` `run_qbank_grading`：取题 + 校验 submission 归属 + `build_prompts`(:516)（题干/题型/选项/参考答案/解析/`submission.user_answer`/历次 5 条作答，全拼纯文本）→ `resolve_grading_config`(:462)（显式指定 > 模型分配表 `qbank_ai_grading_model_config_id` > Model2 默认）→ `stream_grade`(:683) 发 `json!({"role":"user","content": user_prompt})`，**无图片支持**。
- Grade 模式从流式全文解析 `<verdict>`/`<score>` 标签（取最后一个匹配），落库统一走 `apply_submission_verdict_in_tx`（判分原语：submission 判定 + grading_method='ai' + 计数差值 + mastery 事件 + 统计刷新）。

### 既有积木（全部复用，不新造）
| 积木 | 位置 | 用途 |
|---|---|---|
| VFS 附件上传 | `vfs_upload_attachment`（QuestionInlineEditor.tsx:345 已有前端调用样板；图片上限 MAX_IMAGE_BYTES=50MB，attachment_repo.rs:143） | 答案图片落盘，返回 `{sourceId, resourceHash}` |
| VFS 附件读取 | `vfs_get_attachment_content`（前端样板 QuestionBankEditor.tsx:991）/ `get_content_bounded`（repo :1745，带大小上限防超大 IPC） | 评判时按 ID 取 base64 |
| 题目图片信封 | `QuestionImage{id,name,mime,hash}` 存 `images_json` | 答案信封同构：**只存引用不存 base64** |
| 题目图片渲染 | QuestionBankEditor.tsx:977-1020（ID→base64→缩略图，50 张 LRU） | 作答图片回显直接套用 |
| 多模态 content parts | essay_grading/pipeline.rs:1119-1180（is_multimodal 门控 + `guess_image_mime` + data URL） | qbank 评判管线照搬 |
| 多模态能力标志 | `ApiConfig.is_multimodal`（模型能力注册表维护，llm_manager/mod.rs:162） | 判分模型校验 |
| 评判模型槽位 | 模型分配表 `qbank_ai_grading_model_config_id`（pipeline.rs:491） | 用户指定视觉模型给题库判分 |
| 前端图片压缩 | `attachmentModeHelpers.ts`（聊天附件上传压缩） | 拍照上传前压缩（可选，见决策点 D3） |

## 二、方案

### 2.1 user_answer 图片信封格式（核心契约）

新增一种 user_answer 形态（信封 JSON，与既有 fill_blank JSON 数组、matching/ordering JSON 并列）：

```json
{"type":"image_answer","images":[{"id":"…","name":"…","mime":"image/jpeg","hash":"…"}],"text":"可选文字补充"}
```

- **只存附件 ID 引用，绝不放 base64**：user_answer 会进 content hash 云同步（questions 表 RowSync/FieldMerge，classification.rs:155-164）与历史渲染，塞 base64 会撑爆 TEXT 列与同步流量。信封 ~200 字节/张。
- 结构与 `QuestionImage` 同构（id/name/mime/hash 四字段），渲染/上传代码可互指。
- `text` 允许"图 + 少量文字说明"混合作答；纯图作答 text 为空串。
- 约束：1-6 张（与作文批改 MAX_IMAGES_PER_KIND=6 对齐）；mime 限 image/png|jpeg|webp|gif（与前端 ALLOWED_IMAGE_TYPES 一致）。

### 2.2 前端改造（3 处）

**F1 上传控件**（QuestionBankEditor.tsx `renderAnswerInput`）：
- short_answer/essay/calculation/proof/fill_blank 五个题型在输入框旁加"拍照/选图"按钮（`<input type="file" accept="image/*">`，移动端 accept 自带相机入口）。
- 选择后调 `vfs_upload_attachment`（复用 QuestionInlineEditor.tsx:345 样板：FileReader→base64→上传→拿 sourceId/resourceHash），本地 state 维护 `answerImages: QuestionImage[]` + 缩略图条（可删除、可预览；渲染复用题目图片的 `vfs_get_attachment_content` 路径）。
- 提交时构造信封：有图 → `{"type":"image_answer",...}`（`encodeImageAnswerUserAnswer`）；纯文本 → 走既有路径不变。

**F2 编解码契约**（questionBankApi.ts）：
- `UserAnswerValue` 加变体 `{type:'image_answer'; images: QuestionImage[]; text: string}`；`encodeUserAnswer`/`decodeUserAnswer` 对应分支。
- `gradeAnswerLocally` 遇 image_answer 信封**直接返回 MANUAL**（旁路 fill_blank 本地结构化判分——反正后端权威口径已是 AI 评判，前端即时判分对图片无意义）。
- 兼容守卫：非新题型（选择题/判断/数值/匹配/排序）收到信封按不可解析处理回退 text 展示（防御旧数据错位）。

**F3 展示兼容**（凡读 user_answer 的地方）：
- 提交结果卡（QuestionBankEditor）、重进题目回显（useQuestionBankSession `q.user_answer`）、`markCorrect` 自评（useQuestionBankSession.ts:572 原文回传——信封字符串与后端 `latest.user_answer == user_answer` 改判去重天然兼容，无需改）、历史回看（QuestionHistoryView，信封显示为"[图片作答] + 缩略图"而非原文 JSON）。
- 统一抽 `UserAnswerDisplay` 小组件：信封解码 → 缩略图行 + 文本；非信封原样。

### 2.3 后端改造（qbank_grading，3 处）

**B1 信封解析与图片取回**（pipeline.rs）：
- 新增 `parse_image_answer_envelope(&str) -> Option<(Vec<QuestionImage>, String)>`：严格校验 `type=="image_answer"` + images 非空 + mime 白名单，非法返回 None 走原文本路径。
- 评判时对每个 image.id 调 `AttachmentRepo::get_content_bounded`（上限与作文单张 50MB 对齐）；取不到（已删除/同步未到）→ 整体报错**不静默降级**，错误信息指明哪张图缺失。
- 校验复用作文口径：≤6 张、单张 ≤50MB、合计 ≤100MB（validate_image_payloads 同款）。

**B2 多模态 prompt 与消息构造**（build_prompts + stream_grade）：
- `build_prompts`：当前 submission 是信封时，"学生答案"段替换为占位文本"【学生手写答案图片】共 N 张，见后附图片"+ text 补充；历次作答记录里的信封显示 `[图片作答 N 张]`（不回放历史图片，控制 token）。
- `stream_grade` 增加 `is_multimodal: bool` 与 `images: &[&str]` 参数（对齐 essay 签名）：is_multimodal 且有图 → user content 改为 parts 数组（"学生手写答案原图"标签文本 + 逐张 image_url data URL + 完整文本 prompt 收尾）；否则维持纯文本（此时信封会被 B3 拦住，不会走到这里）。
- **顺手补一个既有缺口**：`build_prompts` 目前不传 `structured_data`（pipeline.rs:1000 附近测试可见 structured_data 未入 prompt）——填空题评判时模型看不到"有几个空、每空可接受答案列表"。本次一并补上"填空题空位定义"段（对文本作答的填空判分也是提升，改动 +10 行）。GRADE_SYSTEM_PROMPT 增加"若学生答案为图片，请先逐条誊写识别内容再对比评判"的指令（防幻觉，便于用户核对）。
- verdict/score 标签协议、落库原语、超时/取消/不完整流处理全部不变。

**B3 模型校验**（resolve_grading_config，pipeline.rs:462）：
- 有图片时校验 `config.is_multimodal`，不满足 → 显式 AppError："图片作答需要视觉模型，请在设置 → 模型分配中为'题库 AI 评判'配置多模态模型"。**必须 fail fast**——作文批改对非多模态是静默降级纯文本，对作文尚可；图片作答判分静默丢图等于判空白卷，不可接受。
- `qbank_cancel_grading`、事件流（emitter）无需改动。

### 2.4 不改的部分（明确）

- `submit_answer` / `answer_submissions` 表 / `submit_answer_with_conn`：信封就是字符串，零 schema 改动。
- 判分下游：`apply_submission_verdict_in_tx`（判定+计数+mastery+统计）、SM-2 复习计划、learner_profile 回流——全不看答案内容。
- 云同步：questions.user_answer（FieldMerge+content hash）、answer_submissions（LWW）、blobs（内容寻址清单）现有机制完全覆盖信封方案（见〇-3）。
- `AnswerSubmission.user_answer` 在 `get_submission_by_id_with_conn` 等处保持 String 直读，信封解析收敛在评判管线的单一入口。

## 三、测试计划

- **后端单测**（qbank_grading 模块，仿 essay 多模态测试）：
  - 信封解析：合法/缺 type/空 images/非法 mime/非 JSON 原文本不误判。
  - build_prompts：信封占位文本、历史作答 `[图片作答 N 张]`、structured_data 填空空位段出现。
  - stream_grade 消息构造：is_multimodal+图 → parts 数组含 image_url data URL；无图 → 原纯文本。
  - resolve_grading_config：有图 + 非多模态 → 报错文案。
  - 图片缺失（附件 ID 不存在）→ 报错不静默。
- **前端**：encodeUserAnswer/decodeUserAnswer 往返、gradeAnswerLocally 信封→MANUAL、UserAnswerDisplay 快照测试；`npx tsc --noEmit`。
- **回归**：`cargo test --lib qbank_grading question_bank_service`；vitest chat/practice 相关套件；新命令若涉及（本方案无新命令，vfs_upload_attachment 已注册并已进 application-commands.toml，无 build.rs 坑）。
- **实机**（用户执行）：手机拍照上传→AI 判分→verdict 落库→历史回看缩略图；纯文本作答回归不受影响；非多模态模型配置下的报错引导。

## 四、决策点（请确认）

- **D1 Analyze 模式是否同批支持图片**：建议**是**——"解析我做错的题"同样受益于看手写过程；实现上 Analyze 与 Grade 共用 stream_grade，多模态分支天然共享，仅 prompt 不同，边际成本≈0。
- **D2 上限对齐**：答案图片 6 张 / 单张 50MB / 合计 100MB，全按作文批改口径。若嫌宽可收紧到 3 张（手写答案通常 1-3 页）。
- **D3 上传前压缩**：聊天侧已有 canvas 压缩工具（attachmentModeHelpers.ts）。建议**做**——手机原图普遍 3-8MB，判分模型输入 1-2MB 足够；但作文批改现状是原图直传，若求一致可后续统一。
- **D4 填空题图片作答的 UI 形态**：逐空输入框与"整页拍照"并存（每空仍可打字，图片作为整题作答）——还是填空题暂不开放图片（只做主观题）？建议前者：后端口径已统一，前端一个入口的事。
- **D5 structured_data 传参补缺**（2.3-B2 顺手项）：建议**一并做**，独立小 commit，即使图片作答不做它也有独立价值。

## 五、估时

后端 ~200 行 + 单测（多模态分支照抄 essay、信封解析、is_multimodal 校验）；前端 ~300 行（上传控件、缩略图、编解码、展示兼容）。分 4 个 commit：① 信封契约+前端编解码 ② 后端多模态评判 ③ 前端上传 UI+回显 ④ structured_data 补缺（可选独立）。每 commit 测试绿后进下一个。

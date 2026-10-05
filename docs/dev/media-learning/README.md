# 音视频学习（媒体转写 → 检索 → 时间戳引用 → 学习闭环）

> 2026-10 设计契约。思路与功能借鉴贡献者项目 [BA7MLV/wangke-agent](https://github.com/BA7MLV/wangke-agent)
> （MIT, Copyright (c) 2026 BA7MLV）。**只吸收思路和功能，全部在 DeepStudent 现有架构上原生实现**；
> 直接移植的纯逻辑模块须在文件头保留原版权与许可声明。

## 0. 原则

- **不新增资源类型**：音视频仍是 VFS `File` 资源（`FileType::Audio/Video`），复用资源库、预览、备份、同步。
- **不新增工具族**：问答复用 `unified_search(resource_ids)` 与 `resource_read`；制卡/出题复用 chatanki / qbank。
- **不新增存储/预览实现**：「音视频」子应用是资源库的专用视角（见 §0.5），学习视图仍是同一个 `MediaStudyView`——
  资源库（`FileContentView` 的媒体视图）、聊天右侧面板与子应用学习页共用它，转写/字幕/讲义能力只实现一份。
- **不引入浏览器端重依赖**：解码在 Rust 后端（symphonia，纯 Rust，可交叉编译到 Android）；VAD 用自研能量 VAD；
  不用 onnxruntime / wasm（发布版 CSP 禁止 wasm 编译）。
- **不做**：B 站等平台下载/Cookie/私有接口（法律与凭据风险）；飘屏弹幕与 AI 讨论区；PWA/浏览器存储层。
  平台字幕只支持用户自行获得的字幕文件导入（`.srt/.vtt`，B 站 BCC JSON 解析）。

## 0.5 定位与入口

「音视频」（en "Media"）子应用：**把网课、讲座、录音变成可检索、可提问、可复习的学习材料**。
实现位于 `src/features/media-studio/`。

- **定位**：资源库的专用视角，不是独立存储。媒体仍是 VFS `File` 资源（`FileType::Audio/Video`），备份/同步/搜索不变；
  资源库照旧就地打开媒体（同一个 `MediaStudyView`）。子应用只负责把"看一门课"的闭环串起来：
  导入 → 转写 → 边看边查 → 提问 → 讲义 → 制卡/出题 → 复习；产出落在 对话 / 笔记 / 闪卡 / 题目集，不另存。
- **为什么不做独立资源类型**：避免第二条存储/备份/同步/搜索路径；同一文件可与其他课程资料放在同一文件夹；
  聊天引用与 RAG 继续用同一个 resource id。
- **入口**：

  | 位置 | 入口 |
  |---|---|
  | 桌面侧栏 | 「音视频」（紧跟「资源库」） |
  | 移动端抽屉应用启动器 | 「音视频」磁贴 |
  | 命令面板 | 「前往音视频」 |
  | 学习桌面（workbench） | 「音视频」应用 |
  | 资源库 / 聊天右侧面板的媒体学习视图工具栏 | 「在音视频中学习」→ 子应用学习页 |

- **`[媒体@…]` 引用的路由**：在聊天页点击 → 仍在聊天右侧面板打开并跳转；在聊天页**以外**（笔记、闪卡来源等）点击 →
  App 的 `media-ref:open` 处理器调 `openMediaStudio(id)` 打开「音视频」学习页，`media-ref:focus` 带
  `targetScopeId: 'media-studio'`（只投给学习页的播放器，资源库保活标签里同一媒体不会抢 seek），冷启动由
  `takePendingMediaFocus` 兜底。学习桌面启用时 `openMediaStudio` 开「音视频」窗口（launchPayload `{resourceId}`）。
- **实现要点**：学习页直接渲染 `FileContentView`（媒体源解析、流式回退全复用），经
  `MediaStudyCompanionContext`（`media/mediaStudyCompanion.ts`）把讲义 / 问答 / 练习分区注入 `MediaStudyView`：
  字幕面板变为分段面板（宽 ≥ 720 在右侧，窄屏在播放器下方且不可收起），各分区常驻挂载只切可见（讲义生成不被
  切换中止）；无 context 的宿主（资源库、聊天面板）保持原布局，并多一个「在音视频中学习」按钮。当前打开的媒体在
  `useMediaStudioNavStore`（经典壳视图与学习桌面窗口共用）。
- **库页（首页）**：导入（桌面：系统对话框 + 拖放 → `staged_upload_from_path`；手机：`<input type=file>`，accept 由
  `buildFileAccept(['audio/*','video/*'], 扩展名)` 组装 → `stageBlobUpload` 带字节进度。手机不走对话框路径：Android
  媒体提供方的 content:// 只给不透明 ID（如 `video:1234`），文件名与扩展名会丢失），
  按名称搜索，筛选 全部 / 在看 / 未转写 / 已转写，按最近活动排序；行显示类型图标、名称、时长、转写状态
  （未转写 / 排队中 / 转写中 n/m / 已转写 / 已导入字幕 / 部分完成 / 转写失败）、观看进度、上次观看；行菜单：导入字幕 /
  导出字幕 / 重命名 / 在资源库中显示 / 删除（进资源库回收站）。导入落在资源库根目录。
- **学习页**：播放器 + 侧栏分段标签 字幕 / 讲义 / 问答 / 练习。问答、出题是"新开对话 + 引用该媒体 +
  预启用「课程学习」(`course-study`) 技能"（出题预填指令，用户确认后发送）；制卡直接走 CardForge、练习分区带本课台账
  与课中检查点（见 §3.1）；讲义列表按笔记的来源媒体（origin）查询。转写在后台进行，跨页面持续，库页状态在应用回到前台时刷新。
- **移动端**：播放器顶部固定（16:9，≤ 42svh），下方分段标签（默认字幕）；导入按钮固定在库页底部；行菜单为长按或 ⋯
  （复用 AppMenu，本仓暂无底部动作表基元）；抽屉上半为「最近在看」；Android 返回键先关菜单 / 弹窗（overlay 档），
  再从学习页回库页（`BACK_PRIORITY.view`）。

## 1. 核心数据：带秒数的字幕段

一切围绕"每段自带起止时间"的字幕段：转写可续做、检索命中带时间、引用可跳播放器、讲义/卡片/题目基于字幕。

### 1.1 表（VFS 库，迁移 `V20261005__media_transcripts.sql`）

```sql
CREATE TABLE media_transcript_segments (
  resource_id   TEXT    NOT NULL,       -- VFS File 资源 ID（file_*）
  idx           INTEGER NOT NULL,       -- 段序号（0 起，按 start_ms 升序）
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  text          TEXT    NOT NULL DEFAULT '',
  status        INTEGER NOT NULL DEFAULT 0,  -- 0 待转写 / 1 完成 / 2 失败
  source        TEXT    NOT NULL DEFAULT 'asr', -- 'asr' | 'import'（字幕文件导入）
  plan_version  INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (resource_id, idx)
);
CREATE INDEX idx_media_segments_status ON media_transcript_segments(resource_id, status);

CREATE TABLE media_progress (
  resource_id      TEXT PRIMARY KEY,
  last_position_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  watched_ms       INTEGER NOT NULL DEFAULT 0,
  finished         INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
```

学习时长另用 `V20261006__study_time.sql`（`study_time_daily(date TEXT PRIMARY KEY, seconds INTEGER, updated_at INTEGER)`）。

### 1.2 转写流水线（Rust，`src-tauri/src/media/`）

1. **解码**：symphonia（仅开必要 codec：AAC/MP3/FLAC/PCM/Vorbis/Opus 按可用性，容器 MP4/MKV/WebM/OGG/WAV）→ 单声道 16 kHz s16。
   流式解码，不整文件进内存；重采样按**媒体时间轴全局网格**对齐（防长课时间戳漂移）；坏包跳过并按包时长补静音。
   不支持的容器/编码给出明确提示（"请转为 MP4/M4A"）。
2. **VAD**：能量 + 过零率的轻量 VAD；段合并参数：间隔 < 0.4 s 合并、单段 ≤ 15 s、< 0.5 s 并入前段。
3. **ASR**：每段编码为 WAV，走 `voice_input` 同一套 ASR 配置与模型槽位（`voice_input_asr_model_config_id`）；
   AIMD 自适应并发（连续成功 +1，429 减半并按 Retry-After 冷却；400/401/403 不重试）；每次调用记入 llm_usage。
4. **续做**：`status=1` 的段跳过；新 VAD 计划段数偏差 > 20% 时重建（`plan_version+1`）。
5. **任务承载**：扩展 `vfs/pdf_processing_service.rs` 的 `MediaType` 增加 `Audio`/`Video`，阶段 `decode → vad → asr → indexing`，
   复用 `media-processing-*` 事件与启动恢复。全局串行一个媒体转写任务。
6. **触发**：转写会产生费用 → 由用户触发（预览页"转写"按钮/聊天工具调用）；开始前展示时长与预计段数。
   原导入时 ≤ 25 MB 音频整段自动转写的路径**移除**，统一到本流水线（短音频 < 10 分钟导入后自动开始，保持原有体验）。

### 1.3 命令（Tauri）

| 命令 | 说明 |
|---|---|
| `media_transcribe_estimate(resource_id)` | `{durationMs, plannedSegments, asrModel}`（只解码+VAD 时长估算，可走快速探测） |
| `media_transcribe_start(resource_id)` | 入队；已在队/已完成返回现状 |
| `media_transcribe_cancel(resource_id)` | 取消；已完成段保留 |
| `media_transcript_get(resource_id)` | `{status, segments:[{idx,startMs,endMs,text,status}], progress}` |
| `media_transcript_import(resource_id, path)` | 导入 `.srt/.vtt/BCC .json`，写 `source='import'` 段并触发索引 |
| `media_transcript_export(resource_id, format, dest)` | 导出 `srt`/`vtt`/`txt`（含 content:// 目标） |
| `media_progress_get/set(resource_id, …)` | 断点续播与观看时长 |
| `study_time_add(seconds)` / `study_time_range(from,to)` | 学习时长 |
| `media_library_list()` / `media_related_notes(resource_id)` | 子应用库页：列出音视频 File 资源（时长、转写状态、观看进度）；按来源媒体列讲义笔记 |
| `media_study_ledger(resource_ids, include_card_ids?)` | 本课台账（批量）：闪卡（制卡任务 `source_ref.id`）数 / 到期 / 新卡，题目（`source_ref.resourceIds` 或解析出处）数 / 作答 / 正确率 / 错题 / 所在题目集 |
| `media_checkpoints(resource_id)` | 课中检查点：解析里锚定到本课某一刻的题目，按时刻排序 |

事件：沿用 `media-processing-progress` / `-completed` / `-error`，payload 带 `mediaType: 'audio'|'video'`、`stage`、`completedSegments`、`totalSegments`。

### 1.4 检索

- 媒体资源的 index unit 按 **~90 s 时间窗**（或 ~800 字）聚合字幕段；segment `metadata_json` 写 `{"startMs":…,"endMs":…}`。
  内容哈希只对确定性结构（数组/BTreeMap）取（AGENTS.md 禁令）。
- 检索命中带 `timeRange`；`resource_read` 支持 `time_start`/`time_end`（秒），返回逐段 `[mm:ss] 文本`，单次 ≤ 10 分钟。
- 词法路由增加 BM25 重排（中文单字 + 二字组、非负 idf、全覆盖加成），惠及所有资源，移动端（无向量）收益最大。

## 2. 引用与跳转

- 格式：**`[媒体@{resource_id}:{mm:ss}]`**（≥ 1 小时用 `h:mm:ss`）。与 `[PDF@tb_xxx:页码]` 同族，remark 插件并列解析。
- 渲染为徽章"▶ mm:ss · 文件名"；点击派发 `media-ref:focus {resourceId, seconds}`（ack 重试模式同 `chatPdfFocus`），
  打开资源并跳到该时间。
- 播放器：WebVTT 字幕轨（由段生成 blob URL；增量更新不重建轨道）、字幕面板（搜索、点击跳转、跟随高亮）、断点续播、
  "截取当前帧 → 引用到聊天"（走现有 `addContextRef` 图片链路）。

## 3. 学习闭环

- **课程问答**：一个精简的内置技能说明（检索纪律：传关键词、不中换说法；按时间读；回答带 `[媒体@…]`），不新增工具。
- **制卡/出题**：`resource_read` 带时间戳的转写即可作为 chatanki / qbank 输入；来源记录 `resource_id + 秒`，复习时可跳转。
- **讲义**：前端 `<video>` + canvas 抽帧（每 ~25 s、灰度差去重、≤ 60 帧）→ VLM 帧说明筛选 → 大纲 → 分节结构化 IR（校验 + 兜底）
  → **落为笔记**（图片为 VFS 资源，小节带 `[媒体@…]` 锚点）；笔记可导出 DOCX（新增图片块与"讲义/公文"版式）。
- **学习时长**：可见且在场才计时（播放中不判空闲），心跳 15 s、单次 ≤ 30 s、跨零点拆分；现有学习热力图增加"时长"口径。

### 3.1 闭环后半段（2026-10，`feat/media-study-loop`）

目标闭环：看 →（检查点）→ 问这一刻 → 讲义 → 制卡 / 出题 → 复习 → 错了回看原片段 → 学习总览。全部复用现有设施，不新增资源类型 / 存储。

- **复习回链**：复习卡面渲染前去掉 `[媒体@…]` 原文，翻面后左下角「▶ 回看 mm:ss」；评「重来」后撤销提示条里也给回看。
  做题追问栏的「出处」在解析带媒体锚点时带秒跳转。
- **问这一刻**：问答分区「问刚才这段」带播放位置前 60 s 的字幕 + 锚点；字幕面板选择模式（Shift 连选）→ 引用到对话 /
  直接制卡；截帧引用附前后 30 s 字幕（图片上下文注入 `<media_frame_context>`）。
- **本课台账**（练习分区）：闪卡数 / 到期 / 新卡 →「复习本课卡片」（`startReview` batch）；题目数 / 正确率 / 错题 →「去做题」。
  库页行显示「卡 N · 题 M」。
- **直接制卡**：练习分区「制作闪卡」不开对话，字幕按 600 s 切片 + 锚点 + 上文回顾（与 `study_loop/media_source.rs` 同口径）
  走 CardForge，来源记为该媒体；对话里制卡保留为次要入口。出题仍走对话（题库非对话管线需要题目集 + 草稿审核）。
- **课中检查点**（弹幕思考题的原生替代）：检查点 = 解析里锚定到本课时刻的已有题目；练习分区「生成课中检查点」约每 5 分钟
  一道（启发式为主、回忆式为辅）。进度条按作答状态标点、答错的标出回看区间；连续播放越过检查点时伴随面板顶部出题（默认
  不暂停，可切「到点暂停」），判分走 `qbank_submit_answer`，答错「回看这一段」，回看后再播到会再问。
- **学习总览**：`learning_overview` 输出 `media.recentCourses`（看到哪、观看分钟、最近答错的检查点时刻，均带 `[媒体@…]`）。
- **播放器**：触屏双击左 / 右侧 ±10 s、视频播放中屏幕常亮（Wake Lock）、倍速到 3×、字幕面板字号三档。
- **未做 / 后续**：今日学习的「音视频」线（等 `learning-today` 的在途改动合并）、讲义小节 → 进度条章节与分章进度、
  掌握度对无标签媒体题按「课名 · 章节」聚合、影院模式。

## 4. 平台

- symphonia 进 `mobile-slim`，只开必要 codec；Android 转写在前台进行，可续做（切后台被冻结后恢复继续）。
- 大文件：媒体导入流式写入 blob（边拷边算 hash，不整文件进内存），上限 4 GB。
- CSP 不变：`media-src` 已允许 `blob:`/`filestream:`；抽帧时 `<video crossOrigin="anonymous">` 读 `filestream`（其 CORS 白名单含应用源），canvas 不被污染。

/**
 * 第二幕「第二天」：白天的学习桌面（亮色工作台）。单位为脚本秒（成片 0:46–2:04；1:32–1:48 是音视频段：v6 加入 10 秒，v7 扩到 16 秒）。
 * 起点 23.0 = 夜里复习那段的 WK.out1，两边在这一帧的桌面完全一致。
 * 打开应用的路径都是产品里真实存在的：日程小组件的「待办 →」、桌面快捷方式双击、Dock 图标、
 * 双击桌面空白处「显示桌面」（showDesktop.ts：可见窗口一起最小化）。
 */
export const DAY = {
  start: 23.0,
  // 过场：夜 → 晨
  dawn0: 23.05,
  dawn1: 24.7,
  theme0: 23.75, // 暗色 → 亮色界面
  theme1: 24.3,
  clock: 23.95, // 菜单栏时钟翻到第二天
  // 今日
  todayOpen: 26.0, // 点日程小组件「待办 →」：待办从 Dock 图标长出，直接进「今日」视图
  todayFocus: 27.45, // 第 2 行「▷ 开始专注」
  showDesk: 29.0, // 双击桌面空白处：待办与番茄钟窗口一起 genie 进 Dock
  examLaunch: 29.86, // 双击桌面「题目集」
  // 06 检验（题目集窗口级联落在 2 号槽，打开是「选择一个项目」空态）
  examOpen: 30.0,
  examNew: 30.42, // 点「＋ 新建题目集」→ 启动台
  examGrab: 30.66, // 试卷从屏幕右侧拖进来
  examDrop: 31.2, // 落进启动台 → 识别导入第 1 步（文件已选好，不自动开始）
  examParse: 31.55, // 点「解析文档」
  examParsed: 32.9, // 导入完成
  examView: 33.25, // 点「查看题目」→ 题库
  examQ7: 33.6, // 点第 7 题卡片 → 做题（顺序 7/18）
  examPick: 33.95, // 选 A
  examSubmit: 34.28, // 提交答案 → 判错
  examAI: 34.98, // 滚到结果面板底部，点「AI 解析」
  examOut: 37.8,
  // 07 写作与精读（作文批改级联落在 1 号槽、翻译落在 3 号槽，打开都是「选择一个项目」空态）
  essayLaunch: 37.86, // 双击桌面「作文批改」
  essayOpen: 38.0,
  essayNew: 38.3, // 点「＋ 新建作文批改」→ 新作文
  essayPaste: 38.56, // 点进输入框，⌘V 粘贴作文
  essayGrade: 38.85, // 点「开始批改」→ 准备中
  essayStream: 39.0, // 首个 chunk：批注逐字流出 → 润色段 → 评分段
  essayDone: 40.15, // 流完：分数卡插在视口上方，视口停在正文开头
  essayScoreUp: 40.24, // 往上滚到分数卡
  essayRadar: 40.78, // 往下滚露出分项雷达
  essayPolish: 41.25, // 点「润色提升」
  translateLaunch: 42.71, // 双击桌面「翻译」
  translateOpen: 42.85,
  translateNew: 43.13, // 点「＋ 新建翻译」→ 引导条滑入
  translatePaste: 43.38, // 点进原文框，⌘V 粘贴
  translateRun: 43.62, // 点「翻译」
  translateStream: 43.72, // 首个 chunk：译文流出
  translateDone: 44.95, // 流完自动保存：引导条消失、「已保存」
  showDesk2: 45.45, // 再次「显示桌面」，收起 07 的窗口
  writingOut: 45.85,
  // 08a 音视频（0.10.2 新应用；v6 插入 5 脚本秒，v7 再加 3 秒放学习页的问答 / 讲义 / 练习，之后各节拍再整体后移 3）：
  // Dock「全部应用」→ 搜「音视频」→ 打开 →「B 站链接」导入多 P 课程 → 打开 P4 播放 → 问答 → 讲义 → 练习 → 黄灯收进 Dock
  mediaApps: 46.0, // 点 Dock「全部应用」：面板（网格）浮现
  mediaType: 46.2, // 输入「音视频」：进入分区搜索，只剩一个应用结果
  mediaEnter: 46.4, // Enter：面板退场
  mediaOpen: 46.42, // 音视频窗口开（级联 4 号槽），库页
  mediaBili: 46.62, // 点标题行「B 站链接」→ 弹窗
  mediaPaste: 46.78, // 点进链接框 ⌘V
  mediaParse: 46.9, // 点「解析」
  mediaProbe: 47.04, // 解析完成：封面 / 标题 / 5 个分 P / 字幕轨
  mediaImport: 47.3, // 点「导入 5 个分 P」→ 逐 P 导入
  mediaImported: 47.68, // 导入完成：弹窗关、5 行落进列表
  mediaRow: 48.02, // 点 P4 → 学习页（右侧伴随分区停在「字幕」）
  mediaPlay: 48.16, // 点播放：字幕随播放逐句前进
  // 问答（MediaAskTab →「就这门课提问」；分区里就地对话，同网页演示 companion.ts）
  askTab: 48.5, // 点分区「问答」
  askStart: 48.66, // 点「就这门课提问」→ 对话层：附上这节课 + 启用「课程学习」
  askType: 48.74, // 打字「为什么特征值互不相同就能对角化？」
  askSend: 49.1, // 发送：用户气泡 →「正在阅读本课字幕…」
  askAnswer: 49.26, // 回答逐字流出（带两处时间引用）
  askSeek: 50.14, // 点回答里的「▶ 05:20」→ 播放器跳到那一刻（推论 5.7 那页、字幕换成那一句）
  // 讲义（MediaHandoutTab →「生成讲义」→ 保存为笔记 → 打开笔记）
  handoutTab: 50.52, // 点分区「讲义」
  handoutGen: 50.66, // 点「生成讲义」：读取字幕 → 抽取画面 → 生成大纲 → 撰写章节 → 保存笔记
  handoutDone: 51.06, // 完成：「本课讲义」列表出现新笔记（全局通知「已保存为笔记」）
  handoutOpen: 51.22, // 点列表里的讲义 → 笔记窗（级联 5 号槽）弹开
  handoutScroll: 51.62, // 往下滚到配图（定理页截帧 + 图注）
  handoutClose: 52.34, // 点笔记窗红灯关掉，音视频窗口回到最前
  // 练习（MediaPracticeTab →「制作闪卡」→ 按讲到的时刻出卡，来源可跳回视频）
  practiceTab: 52.48, // 点分区「练习」
  practiceCards: 52.62, // 点「制作闪卡」→ 4 张卡片逐张出现
  mediaMin: 53.56, // 点黄灯：音视频窗口 genie 进 Dock（运行区）
  // 08 调研（对话窗口停在「新对话」空态）
  researchOpen: 54.0, // 点 Dock「对话」：最小化着的对话窗口还原
  researchType: 54.3, // 点进输入框打「/res」→ 弹出技能命令补全
  researchTab: 54.46, // Tab 补全成「/research-mode 」，接着打问题
  researchSend: 54.95, // 发出（令牌被剥掉、激活调研模式；侧栏顶部出现「未命名会话」）
  researchAsk: 55.28, // ask_user 卡顶替输入框：这次调研希望做到多深？
  researchPick: 55.52, // 点「中等深度」
  researchSubmit: 55.7, // 点「提交」
  researchSteps: 55.84, // 任务面板出现，6 步逐条打勾
  researchDone: 57.12, // 6/6：产物 / 变更 / 任务完成（面板不会自动收起）
  researchCollapse: 57.32, // 点 ^ 收起面板，露出回答
  researchTitle: 57.46, // 首轮结束自动起名：侧栏与窗口标题一起变
  noteType: 57.56, // 点进输入框打「打开这篇笔记，把主要发现改精炼些」
  noteSend: 57.88, // 发出 → 加载技能组（canvas-note + workbench-tools）→ 打开 / 观察 / 读取 / 替换笔记
  noteOpen: 58.1, // workbench_open_app：笔记窗从中心弹入（笔记不在 Dock 固定区），级联 1 号槽
  noteEdit: 58.4, // note_replace：笔记窗 clean → 前端直写；AgentStrip、改动段落蓝色渐隐、「AI 刚修改了这篇笔记」撤销条
  chatBack: 59.26, // 点对话窗露出来的那截输入框：对话窗回到最前、输入框聚焦
  paperType: 59.32, // 打追问
  paperSend: 59.66, // 发出追问 → arXiv 结果
  paperSave: 60.12, // 论文下载卡：解析地址 → 下载中 → 去重 / 存储 / 文本提取 / 建立索引
  paperSaved: 60.54, // 已保存 1/1 篇完成
  hubIndex: 60.94, // 点 Dock「资源库」：打开「全部文件」
  hubKb: 61.4, // 点侧栏「知识库索引」
  end: 62.0,
} as const;

/** 08 任务面板每步时长：第 6 步在 researchDone 前 0.06 打勾（一步 = 开始 0.02 后执行、0.88 处完成）。 */
export const RESEARCH_STEP = (DAY.researchDone - 0.08 - DAY.researchSteps) / 5.88;
export const researchStepDone = (i: number) => DAY.researchSteps + 0.02 + (i + 0.88) * RESEARCH_STEP;

/** 双击两下的间隔（真实约 140ms）。 */
export const DBL = 0.07;

/** 壁纸从夜里复习开始到第二幕结束一直缓慢平移，两段共用同一条曲线才能无缝交接。 */
export const WALL_DRIFT = { t0: 16.36, t1: DAY.end } as const;
export const wallDrift = (t: number) => Math.min(1, Math.max(0, (t - WALL_DRIFT.t0) / (WALL_DRIFT.t1 - WALL_DRIFT.t0)));

# Changelog | 更新日志

All notable changes to this project will be documented in this file.

本项目的所有重要变更都将记录在此文件中。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.10.4](https://github.com/helixnow/deep-student/compare/v0.10.3...v0.10.4) (2026-10-07)


### Features

* **demo:** Anki 制卡演示——六个制卡任务（进行中逐张出卡、暂停、失败分段重试）与可编辑的模板库 ([3b3d783](https://github.com/helixnow/deep-student/commit/3b3d783f4c202a13e6d3eb0b054e1a32a475c561))
* **demo:** 作文批改演示：错误点入错题本写入内存题目集，生成卡片/新批改提示去桌面版 ([9882fd4](https://github.com/helixnow/deep-student/commit/9882fd4a6b86cf20a77585dfe4c4d4bfbb2d5105))
* **demo:** 作文批改演示：高考议论文（45/60）与雅思大作文（6.5）两篇已批改会话，批注/评分/润色/范文齐全，新批改提示去桌面版 ([e3b8b69](https://github.com/helixnow/deep-student/commit/e3b8b6935bdb603b954bf0e7c0617acf8a0b943f))
* **demo:** 单应用演示入口 demo-app.html?app=&lt;章节&gt;，官网用户指南每章嵌一个只含该功能的演示 ([7f4e906](https://github.com/helixnow/deep-student/commit/7f4e9068d5da157b5a475e359e98338060a36508))
* **demo:** 单应用演示目录列齐官网 16 章，未写剧本的章先占位 ([6db5d9c](https://github.com/helixnow/deep-student/commit/6db5d9c56ba51c102af162165f0aa40951df738c))
* **demo:** 单应用演示第 02 章对话——PDF 精读会话首答完成态，引用徽章、导图、挖空卡与追问续答 ([f600b3a](https://github.com/helixnow/deep-student/commit/f600b3ae424391e96eb9c9a6df09617aea7ff973))
* **demo:** 单应用演示第 03 章深度调研与智能记忆——调研模式完成态：用户记忆、任务清单、三路检索、报告写入笔记，追问可演示写入记忆 ([16222ca](https://github.com/helixnow/deep-student/commit/16222cae9ac42c3721de1b191863b04bac2feb97))
* **demo:** 单应用演示第 06 章论文搜索——arXiv + OpenAlex 两路检索完成态与论文来源卡片，追问可下载入库、按 GB/T 7714 / BibTeX / APA 排引用 ([5621bc0](https://github.com/helixnow/deep-student/commit/5621bc0771e559dc888e253157920a32c2c2f600))
* **demo:** 学习桌面、移动端两章也进演示目录：烟测、海报与 manifest 覆盖整壳演示 ([7705717](https://github.com/helixnow/deep-student/commit/77057176cf2bf5ade89fd896e170e6daada5c5f6))
* **demo:** 对话演示点 PDF 页码徽章与附件在右侧打开原文并跳页，模型选择器补两家可切换 ([cf4d91e](https://github.com/helixnow/deep-student/commit/cf4d91e81ade42b42f5de7df360f57790468edbe))
* **demo:** 思维导图章演示——线性代数第 5 章导图（平衡布局、公式、预置挖空），导图内存后端含版本与背诵制卡 ([5acb274](https://github.com/helixnow/deep-student/commit/5acb274bcc157c344d8c6a28549d2f3db37c5283))
* **demo:** 技能与 MCP 扩展演示——全局技能（已信任/未信任）、社区技能市场搜索与安装、新建与信任技能的内存后端；补 26 个内置技能的中英文描述 ([f0ff8a3](https://github.com/helixnow/deep-student/commit/f0ff8a3f9f9d50ace7e0e60f9cb174b9b5c82f52))
* **demo:** 效率工具演示：待办内存后端 + 考研/期末一周剧本，番茄钟统计与定时任务 ([29dcfbb](https://github.com/helixnow/deep-student/commit/29dcfbb095a74036af1688953c04fb11e9ab3c85))
* **demo:** 效率工具演示手机宽度改用移动端待办页（与 App 壳同一套移动布局） ([43a956e](https://github.com/helixnow/deep-student/commit/43a956e61b1f40e0d3b111d0e94b7bf0f100a20f))
* **demo:** 效率工具演示补 settings 借用文案、今日视图就绪判断 ([fc81aae](https://github.com/helixnow/deep-student/commit/fc81aae9303bcc86cee6e90bbfa5233bbe8341b9))
* **demo:** 数据管理与云同步演示——本地备份列表、自动备份策略、WebDAV 已配置的同步页、健康检查与审计日志；设置类演示挂上全局通知宿主 ([fc92286](https://github.com/helixnow/deep-student/commit/fc922863ec426083ef862592707d1442b42549bd))
* **demo:** 文档阅读章节演示——教材阅读器打开 60 页 PDF，预置四色高亮与书签，划词翻译/解释给出预置结果 ([10341c5](https://github.com/helixnow/deep-student/commit/10341c588d1e41b1fc5d64a61680a19d4eb3859c))
* **demo:** 模型与供应商配置演示——13 家预置供应商、掩码密钥、模型分配、嵌入维度与 OCR 引擎内存后端；补 memory_decision_saved 缺失文案 ([bdc82d1](https://github.com/helixnow/deep-student/commit/bdc82d1cb1f58fd8eea7e18df50b64c919818283))
* **demo:** 演示文案按语言整包打进构建，英文界面用 ?lang=en；未发布的两处在演示里不露出 ([59a51d8](https://github.com/helixnow/deep-student/commit/59a51d8c68297c739143ceb2a63ff31f12c4fe1c))
* **demo:** 笔记 / 导图章只下用到的文案命名空间（零星单条文案就地补），导图窗口加通知宿主，手机宽度下导图先开大纲、笔记不展开链接面板 ([1e38c27](https://github.com/helixnow/deep-student/commit/1e38c27caee01fafa3619b7a6085f9a4088cedb8))
* **demo:** 笔记章演示——两门课的笔记库（公式、双链、标签、学习属性、历史版本），工作区标签页、链接面板、图谱、由笔记生成导图都在内存里可用 ([5fab67c](https://github.com/helixnow/deep-student/commit/5fab67cf3e6decabdb007a7a2e81eaa4a4a478fb))
* **demo:** 设置类演示改走生产的直达分区入口（手机宽度直接进内容页），数据管理开场滚到备份列表 ([5233cc4](https://github.com/helixnow/deep-student/commit/5233cc4883f3186c92901ebf4b8b7e092315c054))
* **demo:** 调研演示的报告笔记、记忆条目与知识库来源可在右侧只读打开；「记住：……」按原话写入记忆；检索块补工具名与检索词 ([4734585](https://github.com/helixnow/deep-student/commit/4734585044b3ce45a3f7b4fbf3b7d8d6d1d81099))
* **demo:** 资源库/阅读演示只下用到的文案命名空间，零散键就地补齐；阅读演示接住引用会话查询 ([e43d31f](https://github.com/helixnow/deep-student/commit/e43d31fdc3fe6a3979882a793d8b4fd95a5d7d0d))
* **demo:** 资源库/阅读演示补通知宿主、划词添加到聊天/存笔记/制卡/框选提问的 mock ([1e78688](https://github.com/helixnow/deep-student/commit/1e78688c43c76df948429054608813aabd5c1093))
* **demo:** 资源库演示的零散文案补丁 ([5af1f46](https://github.com/helixnow/deep-student/commit/5af1f4654da2631fc42c44ebaa8edad582ad0baf))
* **demo:** 资源库演示补删除前的引用计数查询 ([7ba11db](https://github.com/helixnow/deep-student/commit/7ba11dbbf4a79469001ba174e043c1ac4545355c))
* **demo:** 资源库章节演示——按课程分文件夹的一学期资料与内存资源库后端（列表/文件夹/回收站/知识库索引） ([9eca744](https://github.com/helixnow/deep-student/commit/9eca74404febb17073a38256ca0ec9899bf2d3bf))
* **demo:** 音视频章节演示——线性代数分 P 课 + 本地录音/实验视频，内存后端支撑转写、字幕跳转、B 站导入、讲义与问答 ([ec056c7](https://github.com/helixnow/deep-student/commit/ec056c7487bdd1d2908538a52f126f57d2f29f6f))
* **demo:** 题目集演示——三个题目集的内存后端（判分、复习计划、练习模式、AI 解析流式） ([e6cba84](https://github.com/helixnow/deep-student/commit/e6cba8411ecd27cd83408edbe3bd8548aad9eef2))
* **demo:** 题目集演示——错题本、到期错题复习、新建题目与历史记录，桌面专属功能给出提示 ([22da0c7](https://github.com/helixnow/deep-student/commit/22da0c783f5fd3ba3509e8478c8f9a96b264b588))
* **demo:** 题目集演示只下需要的文案命名空间，补几条跨命名空间文案 ([45e9bd1](https://github.com/helixnow/deep-student/commit/45e9bd175e49b50a1f8364a58cfa56f1ecbb2a4d))


### Bug Fixes

* **anki-tasks:** 导出时在保存对话框点取消不再提示「导出失败」 ([309f759](https://github.com/helixnow/deep-student/commit/309f759e12c7951e82ed240071308fa13dea708b))
* **chat:** 活动时间线里 OpenAlex 学术搜索块不再一律显示成「arXiv 搜索」，按块上的实际工具名显示 ([a9fe41d](https://github.com/helixnow/deep-student/commit/a9fe41dba062208f2ec85c21923a3803fd7869a4))
* **demo:** Anki 演示的额外模板按 unknown 转型，tsc 不再报类型不重叠 ([5eeafc4](https://github.com/helixnow/deep-student/commit/5eeafc42198829027da9f5175a58ea4ea1962839))
* **demo:** manifest 只取剧本包顶层的 title（笔记包里示例笔记的 title 被当成了章节名） ([f51491a](https://github.com/helixnow/deep-student/commit/f51491a930f3fe746c6be530c818e804efa9ef4e))
* **demo:** 今日待复习、知识库检索范围已随 v0.10.x 发布，演示里不再藏 ([c81f725](https://github.com/helixnow/deep-student/commit/c81f72568e9b91c493e34a1c1d35adb88e725074))
* **demo:** 作文批改演示就绪判断改为条形视图 + 等总分动画走完，海报不再拍到中间值 ([53124c1](https://github.com/helixnow/deep-student/commit/53124c1716055089a9e5f0b2c51161d1768d2688))
* **demo:** 单应用演示的通用 mock 补 chat_v2_list_runtime_roots（生产构建里笔记、技能页会查） ([c839615](https://github.com/helixnow/deep-student/commit/c83961541679f66abd11081ce6924e2b5be8b2ff))
* **demo:** 输入框「＋」→ 知识库里的「检索范围」也还没进正式版，演示里一并藏掉 ([8df5770](https://github.com/helixnow/deep-student/commit/8df5770f782c39d70e4b9c26ef48289164e12ade))
* **demo:** 音视频演示——时间引用改派发到 document、讲义配图对齐幻灯片、片头帧不入讲义 ([7d5d707](https://github.com/helixnow/deep-student/commit/7d5d70756c124eb2b59838aaec71319c1ce18eee))
* **i18n:** 来源面板「学术论文」分组补文案（原先显示原始键 academic_search） ([35f4239](https://github.com/helixnow/deep-student/commit/35f4239a42c771fbd4903e74e3c1f57bc267a6dc))
* **settings:** 供应商侧栏给 gemini 类型显示「Google Gemini」，不再露出原始键名 ([36cda8f](https://github.com/helixnow/deep-student/commit/36cda8fd55e68fcb0ffd5d8445fe87baa4016e0b))
* **todo:** 窄屏下待办统计行（待完成·预计番茄）截断，不再压住右侧工具按钮 ([ccd998a](https://github.com/helixnow/deep-student/commit/ccd998a7640710eab4fc0683b8bd0ca6190de5aa))
* **workbench:** give AI 仪表盘 its own icon instead of a copy of 对话's ([839b65a](https://github.com/helixnow/deep-student/commit/839b65ad2ee2bee2cebcdfcf763ba67ee4cf4ae9))


### Performance Improvements

* **build:** tslib 归入 vendor-micro——之前被 Rollup 放进 vendor-pptx，带下拉框的页面都会顺带下载 1.3MB 的 PPTX 预览与 echarts ([c003045](https://github.com/helixnow/deep-student/commit/c0030455b552f90817d8ce76e4659373a854d611))

## [0.10.3](https://github.com/helixnow/deep-student/compare/v0.10.2...v0.10.3) (2026-10-06)


### Features

* **media-studio:** grouping and selection helpers for the library ([497b99c](https://github.com/helixnow/deep-student/commit/497b99ca9147389504a4db4054efffd0c64719ed))
* **media-studio:** select, select all and group the media library ([b0d6d0d](https://github.com/helixnow/deep-student/commit/b0d6d0d4a415865f648fa70f5533b15110656eb8))
* **media:** play Bilibili links in the app and sign in to Bilibili by QR ([24ddb80](https://github.com/helixnow/deep-student/commit/24ddb8082e6090dff66edef81395a8def54d20d7))


### Bug Fixes

* **chat:** library-referenced PDFs carry their real processing status ([#449](https://github.com/helixnow/deep-student/issues/449)) ([952d0b2](https://github.com/helixnow/deep-student/commit/952d0b27c865ffa7418eff96725d0b99e72e51a6))
* **kb:** binding a multimodal dimension enables multimodal indexing ([f920307](https://github.com/helixnow/deep-student/commit/f920307c3617c789904c33ddabfe79b46afd2787))
* **media-studio:** don't repeat the folder name on rows in the grouped view ([b992173](https://github.com/helixnow/deep-student/commit/b9921736d4d4c8566279fde287669dcdd9e3b975))
* **settings:** probe ASR models on /audio/transcriptions in the connection test ([#444](https://github.com/helixnow/deep-student/issues/444)) ([819e997](https://github.com/helixnow/deep-student/commit/819e99704164dd8636d6ed7490a2e7588558e998))
* **sync-lease:** say so when the held lease belongs to this device ([#447](https://github.com/helixnow/deep-student/issues/447)) ([f64eae2](https://github.com/helixnow/deep-student/commit/f64eae27bf93694ebb35a6965805733eecb1339e))
* **sync-ui:** explain a sync lease left behind by this device ([#447](https://github.com/helixnow/deep-student/issues/447)) ([f57c0cb](https://github.com/helixnow/deep-student/commit/f57c0cb35dfe0524cfe6a439193c3686f093930e))
* **sync-ui:** keep cloud sync progress and cancel visible across settings tab switches ([#447](https://github.com/helixnow/deep-student/issues/447)) ([6e86cc3](https://github.com/helixnow/deep-student/commit/6e86cc39a1b92c0b7834d998b963983722c7a1b5))
* **sync:** read trigger events from the SQL header so the pin trigger counts as update ([db82e88](https://github.com/helixnow/deep-student/commit/db82e88f3c987cecd7254a01ab476c21613f3090))

## [0.10.2](https://github.com/helixnow/deep-student/compare/v0.10.1...v0.10.2) (2026-10-05)


### Features

* **apkg:** carry FSRS progress through .apkg export and import ([9cbf315](https://github.com/helixnow/deep-student/commit/9cbf315ec86ee57e21c9476d9f7cba1b4421ebd0))
* **asr:** transcribe with the assigned model's own provider; default to Qwen3-ASR-1.7B ([70e7bac](https://github.com/helixnow/deep-student/commit/70e7bac39b512ad1cf89f2943749f85f6ce260c8))
* **capability:** ASR kind in the model registry; suffix-style and relay ASR ids now match ([4a8fb8d](https://github.com/helixnow/deep-student/commit/4a8fb8d8c9b81dd3ad8eeb7420c24accdc5fd13b))
* **chat:** 今日待复习 on the mobile empty chat too ([340b26b](https://github.com/helixnow/deep-student/commit/340b26bdc03359105895dc203b8f6d8cb5e8deea))
* **flashcards:** bury cards, hide buried siblings and play card media while reviewing ([89294bd](https://github.com/helixnow/deep-student/commit/89294bded586f20e3cc6445b293eff2c734eaa89))
* **flashcards:** review by deck from Today and filter the library by deck ([3e1130f](https://github.com/helixnow/deep-student/commit/3e1130f883d27ce68e4fd5b204357366c1a8b7fc))
* **flashcards:** true retention by period, memory distributions and study time on statistics ([aabed2d](https://github.com/helixnow/deep-student/commit/aabed2d6a0be8fae2725f40eece3260a531a00bd))
* **flashcards:** view source and ask AI while reviewing; learn a batch of new cards today ([f41466c](https://github.com/helixnow/deep-student/commit/f41466cd682ac137cce6becbb709fa786ddbc996))
* **fsrs:** schedule with FSRS-6 via fsrs-rs, Anki learning steps and a parameter optimizer ([6d4209e](https://github.com/helixnow/deep-student/commit/6d4209e29d20606cb77853a01785d79e7d42b578))
* **media-studio:** cover thumbnails and steadier rows in the library ([4f86640](https://github.com/helixnow/deep-student/commit/4f86640611caae5911bbebcb1a829a779c2024a2))
* **media-studio:** import from a Bilibili link and watch link items in an embedded player ([7f6c694](https://github.com/helixnow/deep-student/commit/7f6c69465825d63263f665a843a1d9c62f5ec3a1))
* **media-studio:** import several parts of a Bilibili collection at once ([20a7392](https://github.com/helixnow/deep-student/commit/20a7392f851dc1126f9f105c5172066c0d31526a))
* **media:** hand playback off when jumping from the library view to the Media study page ([4918717](https://github.com/helixnow/deep-student/commit/4918717b2c9ea3e5a6ff149c7e797ec6e7c1471d))
* **media:** media_library_list and media_related_notes commands for the media sub-app ([8998887](https://github.com/helixnow/deep-student/commit/8998887fd90e7a57f49f0cc7c36744bf71b07ea9))
* **media:** subtitles from a Bilibili link without downloading; link items stay VFS files ([bcfa286](https://github.com/helixnow/deep-student/commit/bcfa2862770d34218834f7455c07631f78c72b8e))
* **media:** 音视频 sub-app — library, study page and entry points ([d180308](https://github.com/helixnow/deep-student/commit/d180308fad7215c2fee8e9e7647204916b3cc2a1))
* **mindmap:** turn the blanks you could not recall into flashcards ([3296b3c](https://github.com/helixnow/deep-student/commit/3296b3c6b92dfbdad5fd6d1b2be138422b7bd671))
* **notes:** mark a due note reviewed and pick the next date from 近期复习 ([32f4580](https://github.com/helixnow/deep-student/commit/32f45800f113a9edc202884f4079f23a042a96a2))
* **notes:** open a knowledge-base citation at the passage it quotes ([2f716ab](https://github.com/helixnow/deep-student/commit/2f716ab516808e1b57cead7de349000d9de7dba5))
* **pdf:** ask about a region of a page by dragging a box around it ([ea94c75](https://github.com/helixnow/deep-student/commit/ea94c757411c0c1b75ba2a02c05ff5ed26e68928))
* **practice:** one mistake book across all question sets ([16b8782](https://github.com/helixnow/deep-student/commit/16b8782dad8daf48cb6c8350c6c95142aa441001))
* **practice:** redo a batch of mistakes as one set from the mistake book ([cd39199](https://github.com/helixnow/deep-student/commit/cd391992ded885d4b0a190e48b8d547cca29e990))
* **practice:** render formulas in each question set's mistake view ([d5a284b](https://github.com/helixnow/deep-student/commit/d5a284b0db865866b5fbc33f48030b19f5f1cc70))
* **practice:** render formulas in the mistake book ([d88c16a](https://github.com/helixnow/deep-student/commit/d88c16a9cbb473ee25f93bc14136534389bd1e74))
* **practice:** 问 AI 讲解 and 生成同类题 open a fresh conversation ([67b8104](https://github.com/helixnow/deep-student/commit/67b810415f9fd931842c342f138c42dfe8d1f83a))
* **qbank:** show due review counts on 复习计划 and the 更多 tab ([34447bd](https://github.com/helixnow/deep-student/commit/34447bd9719ad5f1d56bd79a69661ec1e224562b))
* **review:** answer before revealing in the mistake review ([0abb078](https://github.com/helixnow/deep-student/commit/0abb07892c1648bf1e0d5671c0c49f0fec7d5319))
* **today:** a dismissible three-step starter on the chat home for brand-new learners ([c7c290a](https://github.com/helixnow/deep-student/commit/c7c290a5494881fface99dad920ec4ab3d4cad11))
* **today:** open due reviews on the study desktop and review all due mistakes in one go ([900b1a5](https://github.com/helixnow/deep-student/commit/900b1a5f51779c0389acbe4333286add85bcaa80))
* **today:** tapping the learning reminder opens the review it is about ([3e244b7](https://github.com/helixnow/deep-student/commit/3e244b7fcb43f16a25f510dd4b7a4f3e86acf6eb))
* **today:** weak spots and the weekly report on the chat home; weak-spot practice lands in the question bank ([d68050d](https://github.com/helixnow/deep-student/commit/d68050de6e706f982cc717d35b832621277276f1))
* **today:** weekly report counts presence-based study time, not only pomodoro focus ([1ad9ef5](https://github.com/helixnow/deep-student/commit/1ad9ef5fa5b0f0b421bc0239b8a408672efe7446))
* **todo:** link notes, textbooks and question sets to a todo ([b5032ac](https://github.com/helixnow/deep-student/commit/b5032ac64c1b0e9a489d02e30f3afc18ff7ffa63))
* **todo:** tapping a todo reminder opens that todo ([50e8a15](https://github.com/helixnow/deep-student/commit/50e8a1582d2a3c81af1996bffcbb0e2ccba590a6))
* **translation:** selectable bilingual text with the shared selection toolbar ([f595f39](https://github.com/helixnow/deep-student/commit/f595f393776eb08c1d436be06c4609a0f03b76d8))
* **workbench:** a compact learning briefing on the desktop ([ef5779a](https://github.com/helixnow/deep-student/commit/ef5779acde23f6af79f078a3d56ed0587b31ed83))
* **workbench:** quieter empty desktop; collapse and hide each desktop widget ([06b2d78](https://github.com/helixnow/deep-student/commit/06b2d7800458a83d96874b310b624c1c7299da86))
* **workbench:** status bar rhythm and desktop briefing count due mistakes and notes ([99468e1](https://github.com/helixnow/deep-student/commit/99468e124b7bfcb885a53de92299e4e87307a9f2))


### Bug Fixes

* **command-palette:** 跳转资源库的命令改用应用名「资源库 / Files」，搜索仍认「学习中心 / hub」 ([c6fec16](https://github.com/helixnow/deep-student/commit/c6fec166d24462c4b12b096d63cad0137790d88c))
* **i18n:** mirror plural keys in the zh-CN mediaStudio namespace ([7a9047e](https://github.com/helixnow/deep-student/commit/7a9047e3ad5158875eac2b0c58c9cc84c84afb74))
* **learning-hub:** let 导入资料… pick audio, video and images ([fe3a919](https://github.com/helixnow/deep-student/commit/fe3a91942d8d8ab08083a4c3b2ede5516a24f335))
* **learning-hub:** 待复习笔记 and 查看全部错题 land on the right category in the classic shell ([1cf453f](https://github.com/helixnow/deep-student/commit/1cf453f7c50b4dd253030eed33a540e92b64d5e2))
* **llm:** keep reasoning passback intact around in-loop skill anchors ([#437](https://github.com/helixnow/deep-student/issues/437)) ([505a26b](https://github.com/helixnow/deep-student/commit/505a26b9b7f9d33a74dff51ef8e53776d49240cf))
* **media-studio:** load the Bilibili cover on first parse ([654600c](https://github.com/helixnow/deep-student/commit/654600c726103ce24a85387772969c365b778022))
* **media:** attach the lecture without delay when chat is already a blank draft ([81909b8](https://github.com/helixnow/deep-student/commit/81909b8cafe026d760f6f36a2c0ddfe971d7c5b1))
* **media:** serve large audio/video ranges in 16 MB chunks so multi-GB lectures play in-app ([425ea2b](https://github.com/helixnow/deep-student/commit/425ea2b189af79a5ccfdc5077faa95b5d67fe80f))
* **media:** show a library row's status chip once ([f906b21](https://github.com/helixnow/deep-student/commit/f906b214967b5dc811ed4f3167e72a0b46db3bc4))
* **mobile:** Android back closes the mistakes review; notes 复习完成 fits narrow lists ([d9b7f6d](https://github.com/helixnow/deep-student/commit/d9b7f6d3a748518a2f6964e67e55e4037dd53b62))
* **pdf:** scope .ds-search-input rules to the PDF search bar ([6c206f8](https://github.com/helixnow/deep-student/commit/6c206f890f8dbc3048c066eb4bef755b2ab34aa3))
* **qbank:** refresh an open question set after importing questions from chat ([c2adcbc](https://github.com/helixnow/deep-student/commit/c2adcbcefec3f683b2a6b6cb337ee0f3faf6c48d))
* **review:** background practice and flashcard shortcuts yield to modal review layers ([ddcdb83](https://github.com/helixnow/deep-student/commit/ddcdb83da256ae822187ace933c0ee8206bc958a))
* **review:** make the picked option in the mistake review visible in dark mode ([a2fce64](https://github.com/helixnow/deep-student/commit/a2fce64e54da224db2b28327b5f8c7bdb4440928))
* **review:** show choice options in the SM-2 mistake review ([0576471](https://github.com/helixnow/deep-student/commit/057647117a9a6314f07532dc49dd9b658905a250))
* **today:** keep 本周周报 on the chat home for learners with history ([9dd7897](https://github.com/helixnow/deep-student/commit/9dd789778315d2a324d593237128b83a383deff7))
* **today:** stop counting overdue mistakes twice in 今日学习 ([214cbaf](https://github.com/helixnow/deep-student/commit/214cbaf10351148847127152cb210a7f10cb9a16))
* **today:** 到期卡片 lands on the flashcards Today screen in both shells ([ac373f5](https://github.com/helixnow/deep-student/commit/ac373f5a84f3eaaeb06d5bda4d2f37bffa5373f0))
* **ui:** mistake rows and todo links actually left-align and size to content ([c27423f](https://github.com/helixnow/deep-student/commit/c27423fc805f9823bc14f8fa25c9b60b5bc262c5))
* **workbench:** give 音视频 and AI 仪表盘 their illustrated icons in the launcher and Dock ([2336800](https://github.com/helixnow/deep-student/commit/233680061416f437813514204c96e7607c28d303))


### Performance Improvements

* **flashcards:** resolve each task's deck once instead of once per card ([b5e6069](https://github.com/helixnow/deep-student/commit/b5e6069daa3f1c3e236a2f108717dcffb87b9808))

## [0.10.1](https://github.com/helixnow/deep-student/compare/v0.10.0...v0.10.1) (2026-10-05)


### Features

* **android:** native HEIC to JPEG conversion via ImageDecoder ([d832a9f](https://github.com/helixnow/deep-student/commit/d832a9f607e08f2c1783cbb49b860818f8a281b8))
* **android:** open and share local files with other apps via FileProvider ([47ad2a5](https://github.com/helixnow/deep-student/commit/47ad2a552d58729f9efdfc899f8159a7fa654b36))
* **anki-templates:** add content-suitability guidance and per-field limits to built-in templates ([272c066](https://github.com/helixnow/deep-student/commit/272c066e86788fdf43bffc5e569f76bac3c4e858))
* **chat:** add double-buffered script-free HTML preview for code blocks ([7713418](https://github.com/helixnow/deep-student/commit/771341857d10bb6cb5cd4f34c7917162a7197be8))
* **chat:** add progressive SVG prefix repair for streaming code blocks ([ee380ec](https://github.com/helixnow/deep-student/commit/ee380ec34965dd6e72862d26f4c3723c5f166735))
* **chatanki:** content-first template selection rule for the study agent ([7bd436a](https://github.com/helixnow/deep-student/commit/7bd436a0aeebc55f467f57bb29a6acf726dbe637))
* **chatanki:** expose template field guide and flag over-long template fields ([cefb9d3](https://github.com/helixnow/deep-student/commit/cefb9d3df57a52d315768b60393d172b6eeabb9a))
* **chat:** auto-height and real links for the HTML code block preview ([54553e2](https://github.com/helixnow/deep-student/commit/54553e25d5a9a9b736d2a114a63e1cab63bb9981))
* **chat:** carry media timeRange/mediaCitation through sources and resource_read schema ([202631b](https://github.com/helixnow/deep-student/commit/202631bdc18df6a5c857e344b33eb0d49fcdf117))
* **chat:** live SVG/HTML code block previews with a more menu ([0d01e84](https://github.com/helixnow/deep-student/commit/0d01e84f71e3c92f105f2ce3bdbc509007d0b2eb))
* **chat:** render [媒体[@id](https://github.com/id):mm:ss] citations as clickable timestamp badges ([b992a9a](https://github.com/helixnow/deep-student/commit/b992a9afd148741aa0de788a8134733d3f6b76c8))
* **chat:** teach the [媒体[@id](https://github.com/id):mm:ss] citation for audio/video attachments ([26d05bc](https://github.com/helixnow/deep-student/commit/26d05bcb804a29e8d01257c6ac63f58439c7a299))
* **command-palette:** add Flashcards review command and place card commands under the hub ([bac974b](https://github.com/helixnow/deep-student/commit/bac974bcccb9bac9c6d76648a2d4d9cbf3189d5f))
* **docx:** image block, handout/official layout, and handout LLM commands ([a99db8c](https://github.com/helixnow/deep-student/commit/a99db8ca9696f34a139f2f800ab0fcf319662c9c))
* **llm:** streamed transport helper for single-shot structured requests ([90bbb84](https://github.com/helixnow/deep-student/commit/90bbb84e579fa8d7d0ddb1d81e78a17582f74c06))
* **media-learning:** generate illustrated handouts from media transcripts into notes ([b8aeee1](https://github.com/helixnow/deep-student/commit/b8aeee1a0125a360552328eb229b2c38f1ea3563))
* **media-learning:** route media-ref:open to the media view in both shells ([89423ac](https://github.com/helixnow/deep-student/commit/89423ac4e847686bb098d9c38a4c298fd38f8464))
* **media-learning:** transcript panel, WebVTT track, resume and frame capture in media preview ([c37bc62](https://github.com/helixnow/deep-student/commit/c37bc62f6fd38d678a423b1e7070cd61f578490a))
* **media:** add media transcript segments and playback progress tables ([2c42589](https://github.com/helixnow/deep-student/commit/2c4258900c323b578e5bc2197663e939bdac39b9))
* **media:** resumable transcription pipeline, commands and subtitles ([ad73572](https://github.com/helixnow/deep-student/commit/ad7357299305173c1e3a564e4c799fd2e78143be))
* **media:** stream media imports to blobs and route audio through pipeline ([5af70ab](https://github.com/helixnow/deep-student/commit/5af70abf239b59c6d8fd040a4c94ad99a24a986c))
* **media:** stream-decode audio/video to 16 kHz mono with energy VAD ([dba966b](https://github.com/helixnow/deep-student/commit/dba966bf2ffbbd50b0fe44547f52e417957b7e6f))
* **navigation:** add flashcards hub model, tab switcher and mobile header accessory row ([683f4a4](https://github.com/helixnow/deep-student/commit/683f4a467e345f0dbc601b382a9c2095057c6633))
* **notes:** export notes to Word with images and a handout layout ([7b0a365](https://github.com/helixnow/deep-student/commit/7b0a36592723551090e0c22e3a3c386d306b2691))
* **notes:** make [媒体[@id](https://github.com/id):mm:ss] anchors in notes clickable ([940b64b](https://github.com/helixnow/deep-student/commit/940b64b2875ba06562d4746eac943404c3026f5d))
* **qbank:** import_document 工具 schema 支持 resource_id，引导直接导入资源库文件 ([17378ae](https://github.com/helixnow/deep-student/commit/17378ae2d010487964e30fac1c70307b2c1c0bc5))
* **qbank:** qbank_import_document 直接接受资源库 resource_id ([87887b8](https://github.com/helixnow/deep-student/commit/87887b8752686e65be4344f4f8199f6c2c9ae6fc))
* **shell:** merge Anki card tasks, flashcards and templates into one Flashcards page ([51e8d72](https://github.com/helixnow/deep-student/commit/51e8d726093db8857d8ff1486b2c8e9ca7c80105))
* **skills:** add on-demand course-study skill for media lessons ([ef79f7a](https://github.com/helixnow/deep-student/commit/ef79f7abd120b9ada78148b83924ea20749bcf27))
* **study-loop:** study time table/commands and media-sourced cards & questions ([f8346a7](https://github.com/helixnow/deep-student/commit/f8346a7c0fb84e5be4c739eeb818f5105f18ff2b))
* **study-time:** presence-based study tracker, heatmap time metric, card media jump ([6c6939c](https://github.com/helixnow/deep-student/commit/6c6939c8d51b9f13eda6d5523363ffb6e84720be))
* **ui-drive:** UI 桥端口可配置，支持并行跑多个 dev 实例 ([238ab2c](https://github.com/helixnow/deep-student/commit/238ab2c2923af9f99f654d0f06fc5ec3018c6846))
* **upload:** stream large files to Rust in bounded chunks instead of base64 JSON IPC ([5677015](https://github.com/helixnow/deep-student/commit/56770150b2c4f8dc5b0dde1f4afe61c243108dae))
* **vfs:** BM25 rerank on the lexical (FTS) retrieval route ([555795d](https://github.com/helixnow/deep-student/commit/555795d2cab24df42f364ff4f4535f1eeb9a6174))
* **vfs:** index media transcripts as time windows and cite hits by timestamp ([9338197](https://github.com/helixnow/deep-student/commit/9338197b5ce888e6cbb7da3e83e6f630b2ba2c89))


### Bug Fixes

* **agent:** 回复语言规则改为语言中立，英文提问得到英文回复 ([be10377](https://github.com/helixnow/deep-student/commit/be10377ff0dbfd27bcaaef83df95bbdcda7597c4))
* **android:** keep file pickers from crashing on extension-only accept ([f86fa5f](https://github.com/helixnow/deep-student/commit/f86fa5f4935f1f554670f7a6bbdecbaee40e30fa))
* **android:** keep the API 28 guard visible to lint inside the HEIC worker ([9c5a5ca](https://github.com/helixnow/deep-student/commit/9c5a5ca684c7a2a296db28969514f106fe02ae89))
* **anki-tasks:** empty-state "go to chat" no longer switches to session '__new__' ([393825f](https://github.com/helixnow/deep-student/commit/393825fc6570dea3e4280d997222f5e76d54a955))
* **anki:** make design-* built-in template cards grow with their content ([8443a8d](https://github.com/helixnow/deep-student/commit/8443a8dd7dfa92a24956ac8112a934eef01708e4))
* **anki:** render plain inline $…$ math on template card faces ([87902f3](https://github.com/helixnow/deep-student/commit/87902f3425b64c9c7f6fe8ef63a5ceb54dad5be1))
* **automation:** stop promising background runs on mobile ([9c86317](https://github.com/helixnow/deep-student/commit/9c86317d9639393418a16f93637a95239d775cac))
* **capability:** type-first registry matching + gateway-prefix stripping + embedding/rerank records ([#434](https://github.com/helixnow/deep-student/issues/434)) ([f048715](https://github.com/helixnow/deep-student/commit/f04871593987120880b6cddfadb2f35187c930cc))
* **cards-hub:** stop repeating Anki Cards / template manager titles inside the Flashcards page ([b790143](https://github.com/helixnow/deep-student/commit/b79014317d33aaf9a74b9eba51e75b16a05bb3aa))
* **chat_v2:** tool_call_preparing 按 tool_call_id 严格只发射一次 ([bcd03fd](https://github.com/helixnow/deep-student/commit/bcd03fdc547290c2452ca46c03c55c9f41a683ef))
* **chat:** back arrow on a chat-opened mobile preview returns to the conversation ([1a38128](https://github.com/helixnow/deep-student/commit/1a38128dc1612a0af94a13ce82db047b768f5759))
* **chat:** don't abort a stream as idle right after the app resumes from a freeze ([e80489d](https://github.com/helixnow/deep-student/commit/e80489de25391c40941a8f6da9582de35b1c204d))
* **chat:** don't switch to a missing session on navigate-to-session ([b591e33](https://github.com/helixnow/deep-student/commit/b591e33b244dd774a85e71a24d9ee09f458870e4))
* **chat:** hide the document viewer's open-in-new-window button on mobile ([c0309a9](https://github.com/helixnow/deep-student/commit/c0309a9de02e5682e664239f45d76fbb53e68964))
* **chat:** keep the composer shell fully rounded after sending ([f340e92](https://github.com/helixnow/deep-student/commit/f340e92349b5ce3335817213fba28cee71465058))
* **chat:** keep the composer's safe-area padding stable during drawer swipes ([05697bb](https://github.com/helixnow/deep-student/commit/05697bb64f108443ce52b2838a042816e6968df4))
* **chat:** let vertical page scroll pass through mermaid previews on touch ([f2ee58c](https://github.com/helixnow/deep-student/commit/f2ee58cb5e0b8137423fe04fd2db0176fc0fc27d))
* **chat:** re-pin to bottom when the message viewport shrinks ([d6025fc](https://github.com/helixnow/deep-student/commit/d6025fcd8fe7699244517e3b42f8e577175ee60d))
* **chat:** render vega-lite code blocks without eval under the release CSP ([c73f665](https://github.com/helixnow/deep-student/commit/c73f665578597c4f795d8fc18f2f24f922345299))
* **chat:** 工具时间线同一 tool_call_id 不再出现「准备中/执行中」+「已完成」双行 ([752aae8](https://github.com/helixnow/deep-student/commit/752aae8ae64c26f3459963d00e0dcfb256c4ea9f))
* **chat:** 提问 / 审批卡占据输入壳体时四角圆角 ([65a8ac8](https://github.com/helixnow/deep-student/commit/65a8ac844a351a06a98b3636e84478aac970438c))
* **csp:** allow asset-protocol fetches, Sentry ingest and blob fonts in release ([04a6ec5](https://github.com/helixnow/deep-student/commit/04a6ec554a23a404d9029a34f3368b0397799504))
* **csp:** keep inline style attributes working when Tauri hashes style-src ([dc38a73](https://github.com/helixnow/deep-student/commit/dc38a73f41c90d28044cc3d9e8e934c52746a4c8))
* **desktop:** preset shortcut labels follow the UI language ([a789e29](https://github.com/helixnow/deep-student/commit/a789e297f1ff7acfa50c69b3cc2a0e2b3d7c38f4))
* **dev:** serve KaTeX fonts when node_modules is symlinked outside the checkout ([69b0a6b](https://github.com/helixnow/deep-student/commit/69b0a6b2c1e3588c9d645333f4ad17b501c99e19))
* **ds-test:** 发送 / 提交 / 学习资源 按钮匹配兼容英文界面 ([66ad4cd](https://github.com/helixnow/deep-student/commit/66ad4cd55a23ffbcf9f506dbadf85bdc46a37b54))
* **editor:** depth selects in Moonshot/MiniMax panels; registry record for deepseek-v4.1-flash ([#436](https://github.com/helixnow/deep-student/issues/436)) ([027e3d0](https://github.com/helixnow/deep-student/commit/027e3d0d91ed592bd3503ad6bf12690b07744eb8))
* **editor:** skip the IME zero-width placeholder on Android, strip leftovers on save ([1d9ee48](https://github.com/helixnow/deep-student/commit/1d9ee48ff3795190fa8e21e785df0907bc94b9c8))
* **essay-grading:** feedback language follows the UI language ([f4548a4](https://github.com/helixnow/deep-student/commit/f4548a4cbf385dd25cbe4c1775fab9b171aa6768))
* **essay-grading:** localize built-in mode name in auto-generated session titles ([db56169](https://github.com/helixnow/deep-student/commit/db561699f2176df39294a0c496c5915586740531))
* **essay-skill:** 用户点名考试标准时必须先查模式并传 mode_id ([4930c7d](https://github.com/helixnow/deep-student/commit/4930c7d09cb9fbb78729e461d7c9eb2e3065b314))
* **essay:** 作文应用侧栏列表的旧标题也按界面语言显示预置模式名 ([821f379](https://github.com/helixnow/deep-student/commit/821f379b86fa4b96808273be47a5ce70a1e8d10a))
* **essay:** 解码评分标记属性里的 XML 实体，雷达图不再显示「&amp;」 ([041450c](https://github.com/helixnow/deep-student/commit/041450c745ef5350e17fedc27aa5e9134e59f41d))
* **essay:** 预置批阅模式名称/描述/维度名按界面语言显示 ([8b44f2b](https://github.com/helixnow/deep-student/commit/8b44f2b89b82edd61f7bcd0c22b767811f502e86))
* **filestream:** allow the dev server origin like the PDF protocol does ([e076fe4](https://github.com/helixnow/deep-student/commit/e076fe474ee1e5abc76d97ced5753116249cc95a))
* **flashcards:** accept opaque Android content:// picks for APKG import ([5719356](https://github.com/helixnow/deep-student/commit/5719356852ec7b1ac31679bcded995f609c6efe3))
* **flashcards:** render math in card library and up-next previews ([6ffe9c2](https://github.com/helixnow/deep-student/commit/6ffe9c2a487dcabfe7605e648eb25506a2386a3a))
* **flashcards:** render review template cards at natural width — keep stage body block-level ([e90fe18](https://github.com/helixnow/deep-student/commit/e90fe1882b7cefa0eed4119abf34476f15e9e942))
* **generative-ui:** resolve fallback action and export labels by UI language ([b53f437](https://github.com/helixnow/deep-student/commit/b53f43758185738e6bdc6fd9e5bb92c845db5b66))
* **i18n:** add chatV2 keys referenced by chat UI but missing from both locales ([150f0f0](https://github.com/helixnow/deep-student/commit/150f0f0669f2902540e9bd2992842721c3067977))
* **i18n:** add en-US base keys mirroring zh-CN mind-map plural strings ([18efbbb](https://github.com/helixnow/deep-student/commit/18efbbbfa3bdcdf17c28464042659de314991c19))
* **i18n:** add missing locale keys for crepe, mindmap, flashcards, anki tasks and pdf ([daf461a](https://github.com/helixnow/deep-student/commit/daf461a6ac09a04fd0805b54337b2b40c95d5f68))
* **i18n:** externalize remaining hardcoded Chinese in chat UI ([bd8bc26](https://github.com/helixnow/deep-student/commit/bd8bc26bc8df03131f01e606f113fe58a2919d71))
* **i18n:** externalize user-visible Chinese in shared hooks, utils, dstu and template engine ([23ef81e](https://github.com/helixnow/deep-student/commit/23ef81ed5bc90ab77eb2889c7d5f7717962f487a))
* **i18n:** localize built-in browser gate and error messages ([8644c9c](https://github.com/helixnow/deep-student/commit/8644c9c98c7456abcf73a957d4ed8331d99cab53))
* **i18n:** localize CardAgent errors, mind map generation failure and wikilink cap warning ([329bdca](https://github.com/helixnow/deep-student/commit/329bdcae680e7f34c124894c92fbe496a789a7a9))
* **i18n:** localize Files default names, error contexts and missing index-status keys ([9839a5b](https://github.com/helixnow/deep-student/commit/9839a5b2fbfaf9042e159848e88c552b35d57c13))
* **i18n:** localize insight confirm dialog ([1818719](https://github.com/helixnow/deep-student/commit/1818719284eb196541ab8c610f766920f562aa7e))
* **i18n:** localize session goal status chip, menu and edit dialog ([a880360](https://github.com/helixnow/deep-student/commit/a880360b825cea6d9fe8518ab64d8ebedfc48ea4))
* **i18n:** localize sync conflict badge, built-in MCP server name and misc fallbacks ([6bdf887](https://github.com/helixnow/deep-student/commit/6bdf8879d4a249e2f691a3bfe67160ca9360369e))
* **i18n:** localize system memory folder names in file trees and breadcrumbs ([eea88f0](https://github.com/helixnow/deep-student/commit/eea88f0259f48565f6d43a0b9122163e42a1927b))
* **i18n:** point ASR setup hints to Settings › Model Assignment ([37268b9](https://github.com/helixnow/deep-student/commit/37268b902bd9c7d2ae801a9f9adce940e63baf75))
* **i18n:** restore zh-CN base keys for mind-map plural strings ([0495ed4](https://github.com/helixnow/deep-student/commit/0495ed40ab007d4c616c6d35b6a85aaae01e6db7))
* **i18n:** 学习简报与生成式 UI 里的「题库」统一为「题目集」 ([eb143d9](https://github.com/helixnow/deep-student/commit/eb143d92b2931b8c4e88c40d8f011925f2239fd6))
* **i18n:** 界面里的「知识导图」统一为「思维导图」，Agent 控制中心「题库」统一为「题目集」 ([ea02573](https://github.com/helixnow/deep-student/commit/ea02573b2e4dbdbe7ab4f747667d0704a640c56a))
* **import:** stream VLM page analysis and question-parsing LLM calls ([7a1482f](https://github.com/helixnow/deep-student/commit/7a1482facc89dd12f42449a57d122116ec070170))
* **input:** don't submit on the Enter that confirms an IME composition ([25b15c8](https://github.com/helixnow/deep-student/commit/25b15c833b1429b05909e1d475a3b3034897c12c))
* **learning-hub:** cap textbook previews at 30MB on mobile to avoid renderer OOM ([d2ec682](https://github.com/helixnow/deep-student/commit/d2ec682440166cd1ec63ba6049d822709475f8c4))
* **learning-hub:** enable resource export on Android via the SAF save pipeline ([6be2f9c](https://github.com/helixnow/deep-student/commit/6be2f9c481b7994d0d7ee2cda96ec5b60d7d3d19))
* **learning-hub:** open notes and cross-page targets reliably in the classic shell ([a5ca2be](https://github.com/helixnow/deep-student/commit/a5ca2be42316edc11841b9c31bcf98c0c70e7b6a))
* **llm:** never derive a zero input budget from the output reservation ([a68fed5](https://github.com/helixnow/deep-student/commit/a68fed505c53e784c515a9f1377953c9ef24b2d6))
* **mcp:** validate tool output schemas without eval so listTools works in release ([849fdac](https://github.com/helixnow/deep-student/commit/849fdac98eb7f301e5ff30f18e73f6162f163b8d))
* **media-learning:** align transcript client with the media command contract ([62739a2](https://github.com/helixnow/deep-student/commit/62739a2641986be0d8413a00807ae77bb8e929b7))
* **media-learning:** reset cue sync when the video remounts its subtitle track ([c47be30](https://github.com/helixnow/deep-student/commit/c47be307a666bb9b8a8b2075fabb91f8cff0c212))
* **media-learning:** treat the backend queued stage as queued in transcript progress ([77e7862](https://github.com/helixnow/deep-student/commit/77e78625ef36536fa70aed351ebf1b5da0f54c3e))
* **media:** fit the video controls on phones and keep subtitles above them ([12bca7c](https://github.com/helixnow/deep-student/commit/12bca7c1d06f91c1ddf3f03dd9d13250c56ac541))
* **media:** hand a citation's seek to the player once it is ready ([c0de8a8](https://github.com/helixnow/deep-student/commit/c0de8a8880376cffd7469f97eaf344915b174066))
* **media:** keep on-video subtitles above the player controls ([4afb503](https://github.com/helixnow/deep-student/commit/4afb503bc704f7710f8114b8f430ee2e9f6ef9d0))
* **media:** open media citations visibly from any classic-shell view ([9753c1b](https://github.com/helixnow/deep-student/commit/9753c1baa6fe082fede31b8f3590c5d5ea57864c))
* **memory:** export memories through the save dialog, toast only on real save ([2590dd4](https://github.com/helixnow/deep-student/commit/2590dd4a188f61a310d2e3a96f237fce941f0cd8))
* **memory:** normalize folder paths so root-prefixed paths reuse existing folders ([70da62d](https://github.com/helixnow/deep-student/commit/70da62d55743a8fa82d6bc1ccebd4384bd59ae75))
* **mindmap:** keep the canvas viewport following container resizes ([5dbc24e](https://github.com/helixnow/deep-student/commit/5dbc24e969c166d7c5f78c6a7b3ae3b72d967e20))
* **mindmap:** make outline structure edits and multi-select reachable on touch ([1ce12cf](https://github.com/helixnow/deep-student/commit/1ce12cfc180b2733da3236a14b70cb5485bf62e4))
* **mobile:** route file open/reveal through one helper; hide desktop-only folder actions ([7166a83](https://github.com/helixnow/deep-student/commit/7166a8334a230320d84bcc7254d597f69d3d753e))
* **notes:** localize review/host errors, Cornell headings and export label ([c82848e](https://github.com/helixnow/deep-student/commit/c82848e4e1f3a48de3b8bda5dffbb695056921e7))
* **notes:** read picked/dropped images via read_file_bytes so Android content:// works ([ba59140](https://github.com/helixnow/deep-student/commit/ba5914084e61385c01f9398307a090ce57552e4e))
* **notes:** 学习视图分段按钮在英文下不再重叠 ([a6628f5](https://github.com/helixnow/deep-student/commit/a6628f5774da297e6fcd3fe990606bacdbd9e262))
* **ocr:** stream call_ocr_model_raw_prompt ([bea25ec](https://github.com/helixnow/deep-student/commit/bea25ec800351a50a05048c4bd9dbfcd1e94fda4))
* **ocr:** stream page and hedged free-text OCR, cancel losing engines ([904f3ce](https://github.com/helixnow/deep-student/commit/904f3ce2a89302f53ca4e3f6f415e39157799ef3))
* **practice:** localize image-answer errors and strip labels; add notes export.unsaved_blocked ([836a4a0](https://github.com/helixnow/deep-student/commit/836a4a022fbee95e75fdebf32da20f5bf6b72461))
* **qbank:** AI 批改 / 解析的讲解语言跟随题目语言 ([58e37d7](https://github.com/helixnow/deep-student/commit/58e37d745b8717774fc7465d128683ae82a314e7))
* **quick-assistant:** skip global-shortcut registration on mobile ([7903ce2](https://github.com/helixnow/deep-student/commit/7903ce244736e2b1894a5066b7bf0e79101a6010))
* **reasoning:** 输入框思考强度芯片改用短标签，不再显示「high（高）」 ([f085307](https://github.com/helixnow/deep-student/commit/f08530787f08d8a5171cc4d40ac62bab75bf698e))
* **recovery:** export startup recovery incident/report to Android content:// targets ([4622f99](https://github.com/helixnow/deep-student/commit/4622f999864e5c6f129cb46bb2748bad65283eed))
* **recovery:** hide 'open incident folder' on mobile, keep export as the way out ([ac345b8](https://github.com/helixnow/deep-student/commit/ac345b80a037229db93e20d066fa635f7e286e59))
* **settings:** deep links land on the requested section when Settings is kept alive ([186d1eb](https://github.com/helixnow/deep-student/commit/186d1ebf84cbc5471593e4d74ff0d5d5d30664b7))
* **settings:** name the ASR slot for both voice input and media transcription ([e8f69ed](https://github.com/helixnow/deep-student/commit/e8f69edc5c2da38a1a399ae4b904cd141fa9c111))
* **settings:** open search-engine signup links in the system browser ([8fc0f21](https://github.com/helixnow/deep-student/commit/8fc0f21e7f87a1177d52ba59acd884089d42ed19))
* **settings:** stop soft keyboards from mangling model IDs, keys and URLs ([3a0f995](https://github.com/helixnow/deep-student/commit/3a0f995a6f02a8fbd222a58938776dc4c9672ed7))
* **skills:** bring builtin skill token budget back under its ceiling ([5786e76](https://github.com/helixnow/deep-student/commit/5786e76fc2d12bb1fc9be14f0864f4978eff158e))
* **skills:** import and export skill ZIPs through Android content:// URIs ([bf3adec](https://github.com/helixnow/deep-student/commit/bf3adec8687f0bd120dc697a98bdf16f065cdb2c))
* **tags:** commit comma-separated tags typed on Android soft keyboards ([36c3cdb](https://github.com/helixnow/deep-student/commit/36c3cdb7e114b0d3d4650e6d58bf1a2355e900de))
* **ui-drive:** 支持 DS_WINDOW_PID 按进程锁定截图窗口 ([72f1aa2](https://github.com/helixnow/deep-student/commit/72f1aa246b53b1e25918cd463727fdf430b4c277))
* **ui:** keep the error stack inside narrow screens and below the status bar ([71857a7](https://github.com/helixnow/deep-student/commit/71857a7a84a14772fee9e2d269f436dfdd48b251))
* **upload:** convert HEIC photos with native decoders instead of eval-based heic2any ([f34dd35](https://github.com/helixnow/deep-student/commit/f34dd3584c0969f50fdb0eecc9b87939df954dfb))
* **upload:** stop base64-encoding large attachments and imports inside the WebView ([ffecb03](https://github.com/helixnow/deep-student/commit/ffecb03ce4298028558e40d651137175ba4b6431))
* **vfs:** stop presenting vector indexing on builds without Lance ([f2dc746](https://github.com/helixnow/deep-student/commit/f2dc7469ad049cca8413c287c410bff619d141ce))

## [0.10.0](https://github.com/helixnow/deep-student/compare/v0.9.73...v0.10.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* **reasoning:** unify thinking levels across all channels with backend-side mapping

### Features

* **anki:** AI-made cards are grouped by deck (学科::主题) instead of piling into Default ([b12293f](https://github.com/helixnow/deep-student/commit/b12293fe640339aa80b7c2cc51bd4bf5189e1dc8))
* **anki:** 快速制卡遵循默认模板；未设置时模型从全部模板自由挑选 ([e339747](https://github.com/helixnow/deep-student/commit/e33974752bf88f6750b5e2588d5c584fc7458ab6))
* **anki:** 生成完的卡自动加入复习计划 ([1015738](https://github.com/helixnow/deep-student/commit/1015738db629576b201e3ae9e958afd3f40d6efc))
* **backlinks:** 资料侧反查——讨论过此资料的对话 / 引用此资料的笔记 ([bfb3e9e](https://github.com/helixnow/deep-student/commit/bfb3e9ecdd62f25a4f65dfb665c70de6204ed33d))
* **cards:** PDF 划词制卡记录来源资料与页码 ([1fdd7b6](https://github.com/helixnow/deep-student/commit/1fdd7b661d9d28ccd8b67e10269165402b51b8b3))
* **cards:** 卡片记住来源——卡片库「查看来源」回到来源笔记/资料页或生成它的对话 ([81decf8](https://github.com/helixnow/deep-student/commit/81decf88488aa0fe60d99d03ca4d5bab7ff56046))
* **chat:** 「＋」菜单新增知识库「检索范围」——只在所选课程/文件夹里检索 ([f549408](https://github.com/helixnow/deep-student/commit/f549408d9d11f226f0b3eca70cb559efb4006187))
* **chat:** 对话首页输入框下显示「今日待复习」，一键进入复习 ([84d79ff](https://github.com/helixnow/deep-student/commit/84d79ffb5ab772d1059df4243139e30f1f300fc5))
* **chat:** 点引用徽章或引用页面图直接打开原文并跳到该页 / 导图节点 ([71fb378](https://github.com/helixnow/deep-student/commit/71fb3782d4e9dc7381f39acd9ce8129f4787fc21))
* **citations:** 引用定位到句子——跳页后在文本层高亮被引用的原文 ([f945c81](https://github.com/helixnow/deep-student/commit/f945c812900541205b45b8903612a73def41a4d3))
* **demo:** 演示可以开学习桌面（demo.html?desktop=1），对话和闪卡两扇窗能直接操作 ([4d29f3a](https://github.com/helixnow/deep-student/commit/4d29f3aebc5f2cd45c16822f8f9a6938e12af9af))
* **dev:** UI 自动化时窗口在后台也保持渲染，重启不抢焦点 ([a6a0d1c](https://github.com/helixnow/deep-student/commit/a6a0d1c376ae9eea1fc2a91f68f1d9faf159964b))
* **epub:** 电子书划词——解释 / 翻译 / 存为笔记 / 制卡 / 添加到聊天；修复阅读器 iframe 里所有事件监听失效 ([8ec5e12](https://github.com/helixnow/deep-student/commit/8ec5e1266abb6368db5f2eb0f9f854b2e93a7f80))
* **essay:** 批改结果优先——批改前原文占满、开始批改后原文收成一行摘要（编辑原文 / 重新批改 / 取消），结果区标题并入分段 Tab 行；阶段按后端顺序判定（评分中不再丢失）；去掉结果区悬浮字符数；宽窗口正文限宽 ([2a05315](https://github.com/helixnow/deep-student/commit/2a0531564d9baab76dd403cbda1fbd4755e501fe))
* **essay:** 批改错误点一键入错题本（作文错题题目集，按错误类型计入掌握度） ([359a165](https://github.com/helixnow/deep-student/commit/359a1651206545b8a001ff33315b49c78a45e164))
* **flashcards:** APKG 导入即入队 FSRS，沿用 Anki 复习进度 ([d402a05](https://github.com/helixnow/deep-student/commit/d402a058fca1454eac3a0dd23eeb11a7a27a5f5b))
* **flashcards:** APKG 导入按 Anki 难易度系数初始化 FSRS 难度（替代一律 5.0） ([40fa629](https://github.com/helixnow/deep-student/commit/40fa629c23b2b47a5e94b4752eea6ace513b769b))
* **flashcards:** APKG 导入提示显示加入复习的卡数 ([ba7c2a4](https://github.com/helixnow/deep-student/commit/ba7c2a4cc9ade5e9c97fc9bc58b5d53fb4555a34))
* **flashcards:** 卡片库可导出 .apkg（选中导出选中，未选导出全库） ([c74a7c8](https://github.com/helixnow/deep-student/commit/c74a7c81018bd65b2233d4def0761bbff5345b5e))
* **flashcards:** 卡片模板沙箱放开模板脚本、onclick 与 data-* 属性 ([b1c9c67](https://github.com/helixnow/deep-student/commit/b1c9c67253a5ea9ffd10ef133e19f45242e0675a))
* **flashcards:** 复习界面去掉层层套框——模板就是卡片 ([3d070cb](https://github.com/helixnow/deep-student/commit/3d070cbdcef349f8eb2b25e3c2cbe801bdc23932))
* **flashcards:** 统计页新增记忆曲线——FSRS 遗忘曲线 + 单卡复习历史 ([9cd7758](https://github.com/helixnow/deep-student/commit/9cd7758778f8fb61fad8e58889e7f2a87451af0a))
* **kb:** 会话检索范围——学习者选定的课程/文件夹成为知识库检索硬过滤 ([07e72ec](https://github.com/helixnow/deep-student/commit/07e72ecdc354ffd5cd7511425a9ad628f8d618a9))
* **learning-hub:** '用这份资料制卡' one-step entry; fix stray attachment panel and PPTX refs treated as PDF ([374cd0a](https://github.com/helixnow/deep-student/commit/374cd0adad1f3eccf2bdff9cfe70c98a5da3b010))
* **learning-hub:** add descriptions to quick access items ([cbc7562](https://github.com/helixnow/deep-student/commit/cbc75625ad3cb0fc4d84795385b2a3f5590355e6))
* **learning-hub:** Markdown 用笔记应用打开——导入即为笔记，已导入的可一键「转为笔记」 ([d2a4f71](https://github.com/helixnow/deep-student/commit/d2a4f71654b237a4c2758e41297d41ef96c09fa8))
* **learning-hub:** visible + New menu in the desktop toolbar; '导入教材' renamed to '导入资料…' ([5b9bf48](https://github.com/helixnow/deep-student/commit/5b9bf4838a00994e06251b9e41a77b12033ee12c))
* **learning-hub:** 去掉「学习资源 / 笔记学习」双顶栏，学习视图并入 Finder「笔记」文件夹 ([c3333dd](https://github.com/helixnow/deep-student/commit/c3333dd1144f950b5f003a9e3a75c2c7cd0719be))
* **mastery:** 掌握度对学习者可见——首页「薄弱知识点」，一键在对话里讲解并练习 ([5518239](https://github.com/helixnow/deep-student/commit/55182399fcbab80e9fc37a23d7329093152d6fcb))
* **mastery:** 无标签卡片的复习也计入掌握度（退回所属文档名作为知识点） ([14aa851](https://github.com/helixnow/deep-student/commit/14aa851a13ed3112beaf9c5aa7fbc22f6e89ee05))
* **mindmap:** 导图引用定位到具体节点（#节点提示 / 知识库命中片段 / 选区 node 回链） ([b8813c8](https://github.com/helixnow/deep-student/commit/b8813c80f0767bda68b2f0a41964c1e7b6973c9e))
* **mindmap:** 背诵模式「一键遮住要点」；背诵时公式照常渲染；挖空遮罩可键盘揭示 ([cd86420](https://github.com/helixnow/deep-student/commit/cd864206518c924b890f17b60468e593c059b498))
* **notes:** Agent 创建的笔记记录来源对话/消息（props._origin） ([0964724](https://github.com/helixnow/deep-student/commit/0964724f35a8289fbde25f4e7a9a99212e4b59ad))
* **notes:** 存为笔记新增「追加到已有笔记」模式 ([625af8a](https://github.com/helixnow/deep-student/commit/625af8a63135767392304678ca92c35493401739))
* **notes:** 学习中心单顶栏——笔记页面级操作并入标签栏右端 ([f593ad8](https://github.com/helixnow/deep-student/commit/f593ad886444fe336b24fa7865fdb6c2672c506c))
* **notes:** 学习桌面属性页补上学习关联，关联列表对空返回不再崩溃 ([a9b0d74](https://github.com/helixnow/deep-student/commit/a9b0d748c0bad2a8e125ff018d99b3b7df556ac5))
* **notes:** 学习桌面目录树右键可新建学习笔记（落到右键所在文件夹） ([50c90c5](https://github.com/helixnow/deep-student/commit/50c90c5160e8d3d11cab4d2e528dcebe8fb95913))
* **notes:** 学习桌面笔记侧栏以页面树为主体 ([bb3887c](https://github.com/helixnow/deep-student/commit/bb3887c2ad771862de839de8c056707e48a74e52))
* **notes:** 工作台笔记同样单顶栏——页面级操作并入标题栏标签带右端 ([3f99529](https://github.com/helixnow/deep-student/commit/3f99529ff3e8b7ca7d19b84bc42ed2adfd59f3a5))
* **notes:** 模板改为 Notion 式模板库对话框，模板用真实编辑器编辑 ([52f0db0](https://github.com/helixnow/deep-student/commit/52f0db0f3a8d8d51ed14a5468dcd125b8ed03196))
* **notes:** 笔记「生成思维导图」——大纲本地秒转导图；修复切回笔记标签后生成卡片等工具永久禁用 ([d682734](https://github.com/helixnow/deep-student/commit/d682734a69df3f32ba6d53714e0a8ef6c698c018))
* **notes:** 笔记来源回链——从对话/资料保存的笔记可一键回到那条消息或那一页 ([79a7bed](https://github.com/helixnow/deep-student/commit/79a7bed2ff88ab2fddaf3c1973f1d2f0164a9ee8))
* **notes:** 笔记选区引用带「所在小节」，聊天里点回去滚到该标题 ([1fd63ba](https://github.com/helixnow/deep-student/commit/1fd63ba09513dd2f7c4b5699d5750a57e58dd14a))
* **notes:** 聊天右侧面板里的笔记同样单顶栏——页面级操作并入面板工具栏 ([2bbc34b](https://github.com/helixnow/deep-student/commit/2bbc34b3d56191472464a0382967ec22babb55f3))
* **notes:** 追加到已有笔记时写入段标题（正文未自带标题时） ([9efe72f](https://github.com/helixnow/deep-student/commit/9efe72f9628ae90e0d1b60ca28a39492f95634d1))
* **notes:** 页面 emoji 图标贯穿标签与侧栏树（Notion 同款） ([6f2770c](https://github.com/helixnow/deep-student/commit/6f2770c9abf6b99bd9403d51065ce3f7fc18652d))
* **notes:** 页面图标置于操作行之上并可点击更换；尺寸对齐 Notion（72px） ([8e8b7d7](https://github.com/helixnow/deep-student/commit/8e8b7d700e6333a2069a82806b28f92c5abef362))
* **notes:** 页面菜单 Notion 式排版——字体三卡 + 小字号/全宽独立开关；表格对齐 Notion 规格 ([737be9c](https://github.com/helixnow/deep-student/commit/737be9cb7df660e983f4bec7976d99f1a23f82eb))
* **pdf:** 阅读器新增「关联」侧栏——引用此资料的笔记与讨论过它的对话 ([9741ee4](https://github.com/helixnow/deep-student/commit/9741ee4e88e4f146349e9cadfdcb4692642fd5f9))
* **practice:** 番茄钟专注时长计入练习打卡日历（替代写死的 0） ([17a35ca](https://github.com/helixnow/deep-student/commit/17a35caa73bb58b766e271530e487b904c95c981))
* **preview:** Word / 课件 / 表格预览能选中文字，DOCX / PPTX 支持划词（解释 / 翻译 / 存笔记 / 制卡 / 引用到聊天） ([645230a](https://github.com/helixnow/deep-student/commit/645230acf303b3351f52675cb9ccde9176796252))
* **qbank:** render formulas in question previews; analyze exam pages 3 at a time ([18491c2](https://github.com/helixnow/deep-student/commit/18491c2763a4d77b879bf33ce9a915b26c82d137))
* **qbank:** 错题进对话——做题后「问 AI 讲解 / 生成同类题 / 出处」；AI 出题记录参考资料出处 ([8da8d5c](https://github.com/helixnow/deep-student/commit/8da8d5cf677f932ac47f7c0643c30cde7eff96f9))
* **reasoning:** channel-parallel thinking-intensity architecture (Plan D) ([743c1ba](https://github.com/helixnow/deep-student/commit/743c1ba5ade1527dda7b079bae6991093924c9a9))
* **reasoning:** contains-based family matching + highest-tier defaults + registry-driven max output (Plan E) ([e95e9f1](https://github.com/helixnow/deep-student/commit/e95e9f1ab750cf6a44bad9919c7ee7b816d65797))
* **review:** 复习结果回写掌握度；练习答对到期题推进复习计划 ([eb8cdf0](https://github.com/helixnow/deep-student/commit/eb8cdf097bfd732ce74969647a342b4bcbeff427))
* **today:** 「本周周报」先打开预览，不再一点就弹「选择保存目录」 ([db80908](https://github.com/helixnow/deep-student/commit/db80908d9018143063e5db99915c50a79e9b74a2))
* **today:** 每日早间「今日待复习」汇总通知（卡片 / 错题 / 笔记） ([a80a8c3](https://github.com/helixnow/deep-student/commit/a80a8c3f14c4889c8ecd7057909c216bd417eea1))
* **today:** 确定性学习周报——首页「本周周报」存为笔记 /「与 AI 复盘」 ([2facd35](https://github.com/helixnow/deep-student/commit/2facd35d7f900972cba5c9a88499742d21e34c22))
* **today:** 统一「今日学习」——卡片 / 错题 / 笔记三条复习线同一口径 ([9676fd4](https://github.com/helixnow/deep-student/commit/9676fd424625ce0cf750b003b1b810e0ec17ad5c))
* **video:** 02「找出处」整段浅色重做 + 定位到句子按产品真实效果 ([33b9349](https://github.com/helixnow/deep-student/commit/33b93497a4e5d98e128f98b551e738a82e7210fb))
* **video:** 05 记住改成真实的统计页记忆曲线 ([a5a2761](https://github.com/helixnow/deep-student/commit/a5a2761949de02a47f3ec6ef4c5e4f709a10d992))
* **video:** 06 题目集按产品真实实现重做：级联落位 + 资源工作区左栏；新建题目集 → 启动台 → 拖入试卷 → 识别导入三步（逐页状态、实时题目流）→ 题库 → 第 7 题判错 → AI 解析流式；导入后改名与「已加入今日复习」画修正版 ([d510570](https://github.com/helixnow/deep-student/commit/d510570a957f96140e36914ca391f47d0c4aed16))
* **video:** 07 作文批改与翻译按产品真实实现重做：880×620 默认窗口按级联落位（作文 1 号槽、翻译 3 号槽），左栏资源列表 + 选择一个项目空态 → 新建 → 粘贴；作文流式批注（准备中 → 批注中 → 润色中，未闭合批注灰字脉动、闭合后淡入、筛选计数随流增长）→ 完成后分数卡在视口上方，滚上去看分数、再往下露出雷达 → 润色提升；翻译引导条滑入 → 流式译文 → 自动保存（引导条消失、已保存）；两个视图改用产品实际字体栈（西文走系统字体，与真机逐行换行一致） ([53d76d1](https://github.com/helixnow/deep-student/commit/53d76d1c9bfa3e0d0f45663c63e954f3503094ab))
* **video:** 08 补上笔记——AI 当面改「主要发现」 ([5e90bcb](https://github.com/helixnow/deep-student/commit/5e90bcb4b94186d3956ba494ffe3227180d863fb))
* **video:** 08 调研按产品真实实现重做：对话窗 1080×720 带会话侧栏，新对话空态打 /res 弹技能命令补全 → 发送后令牌被剥掉、侧栏顶部出现「未命名会话」转圈 → 加载技能组 → ask_user 卡点「中等深度」再提交 → 任务面板贴着输入框逐条打勾到 6/6（产物 / 变更 / 任务完成，不会自动收起）→ 手动收起看带 [网1] 徽章的回答 → 首轮结束侧栏与窗口标题一起起名 → 追问论文出 arXiv 列表与论文下载卡（解析地址 → 下载中 → 建立索引 → 已保存）；删掉自绘的笔记窗口；资源库 980×660 级联落 4 号槽，先是全部文件网格，再点知识库索引看 100% 9/9 ([dbc85a7](https://github.com/helixnow/deep-student/commit/dbc85a7ee785fc0048ae026122abce01ab1b0ac3))
* **video:** 学习桌面外壳按产品重写（菜单栏 / Dock / 快捷方式 / 小组件 / 开关窗与 genie）；第二幕改走产品真实入口（日程小组件→待办今日→开始专注→显示桌面→双击快捷方式） ([81c883c](https://github.com/helixnow/deep-student/commit/81c883c4e3e38493c6cf79d42e2bebfe72395572))
* **video:** 宣传片扩成 2:30 三幕版：第二天的学习桌面、越用越懂你、配乐重编 ([0d5ed77](https://github.com/helixnow/deep-student/commit/0d5ed777c1bf8d1cc444ad89f4c75553e8e5b5d1))
* **video:** 第一幕来源面板按产品真实行为——流式期间就有「3 个结果」，点 [2] 展开并一直开着 ([4cacf9b](https://github.com/helixnow/deep-student/commit/4cacf9bde5f7ecc9d8ce70006e2d86226d3e0d03))
* **video:** 精修：Dock 悬停气泡与按下态、每次启动前镜头退到全景；第三幕横移运动模糊；片尾缓慢推近 ([087be66](https://github.com/helixnow/deep-student/commit/087be66022ce7e3c9f920f7e9f0a2155f6fe5ae5))
* **video:** 补完宣传片后半段并精修：等高线知识地形收尾、配乐音效、去 AI slop 视觉 ([592f778](https://github.com/helixnow/deep-student/commit/592f778a33b3a461c491031c11e99bba2fa0a35b))
* **workbench:** AI 仪表盘与首页「今日学习」同口径——补错题复习、待复习笔记 ([53d2950](https://github.com/helixnow/deep-student/commit/53d29505d1cc68009b6aaa44661698a775ac1bba))
* **workbench:** 题目集 / 翻译 / 作文的资源列表可收起：标题栏开关，较窄窗口打开资源后默认收起并按应用记住 ([95a5ba5](https://github.com/helixnow/deep-student/commit/95a5ba58384c07a77ab72603bb0800865cdba68f))


### Bug Fixes

* **a11y:** 顶栏命令面板图标按钮无障碍名为空，且在热区里多占一个 Tab 位 ([cd1fadd](https://github.com/helixnow/deep-student/commit/cd1fadd454ef491afa4d1fdf88437db618b26292))
* **anki-tasks:** 跑完但没生成卡片的任务显示「未出卡」而非「已完成」 ([be1d9b0](https://github.com/helixnow/deep-student/commit/be1d9b0114f4c0d1d51ecdc2c93550c846ffeadd))
* **anki:** AI 补进来的卡同样自动加入复习 ([3b1f316](https://github.com/helixnow/deep-student/commit/3b1f316014a8649bfc101a18b5bc2ef51c9f13f7))
* **anki:** drop placeholder cards; error cards keep raw output so repair never cards the error text ([afdbf96](https://github.com/helixnow/deep-student/commit/afdbf9600bea428ea428dfe501ffec47595553e4))
* **anki:** 制卡任务台统计卡片在 880px 窗口下被挤成竖排；划词卡按资料分牌组 ([03eea0b](https://github.com/helixnow/deep-student/commit/03eea0b559109977a71a4e07bb984fbd006cb2e6))
* **anki:** 制卡总量按各段文本量分配，词多的段不再被截掉尾部 ([7d00f13](https://github.com/helixnow/deep-student/commit/7d00f13e587af89f465995711b800ff25ec43032))
* **anki:** 制卡预分析算上引用资料正文（引用 60 词词表推荐成 2 张） ([29a0c23](https://github.com/helixnow/deep-student/commit/29a0c234f5cc0da8c6c4925d073ea6391d723ff7))
* **anki:** 卡片字段里的 [PDF@file_xxx:1] 等对话引用标记在复习 / 导出 Anki 时露出内部 ID ([e9ce474](https://github.com/helixnow/deep-student/commit/e9ce47415a57b9cd483cad2fd713b669cbd5c990))
* **anki:** 文件标题不再单独成段让模型凭空编卡；多模板词表段不再截断 ([57a5886](https://github.com/helixnow/deep-student/commit/57a58860044f7ab0a85d7a241c6e707e4c4cf48f))
* **anki:** 每词一张时按表格行保底配额，取整误差不再漏词 ([faa806b](https://github.com/helixnow/deep-student/commit/faa806bd878eccdca44cc227bbf5226c7b7e6200))
* **anki:** 没配默认模板时回退内置问答模板，不再让模型反问「用哪个模板」 ([5d27506](https://github.com/helixnow/deep-student/commit/5d27506b6d8857d24dc89394e7e31821cf5538bf))
* **anki:** 生成卡的正/背面按语义字段取值，不再取模板首字段 ([20b2349](https://github.com/helixnow/deep-student/commit/20b23497a9503522c1679071bb7793e230edfe82))
* **anki:** 词表制卡分段不再把表格行从中间切断（60 词只出 45 张卡） ([76e4e36](https://github.com/helixnow/deep-student/commit/76e4e363b273f6f119678a84c37161a865664e16))
* **anki:** 词表段输出上限随段长放大，不再整段截断；表格行数区分表头 ([cf3f38f](https://github.com/helixnow/deep-student/commit/cf3f38f7ced7179ba589a9bca415b1354aaa1bfe))
* **backup:** 备份验证通过后列表仍显示「未验证」 ([8025e40](https://github.com/helixnow/deep-student/commit/8025e4036dc00b93d982461ef639c896371a285f))
* **chat:** 「已引用到对话」带「去对话」直达那条引用所在的会话；资料制卡指令按资料类型取材 ([0fe718d](https://github.com/helixnow/deep-student/commit/0fe718ddac630623862a1a8b1f7275a647299356))
* **chat/pdf:** 划词「解释」结果按 Markdown 渲染，不再露出 ** 原文 ([b4d3fd4](https://github.com/helixnow/deep-student/commit/b4d3fd48d5d582036ac4dcdcb483e0b8fabe773e))
* **chatanki:** 有效模板集只剩一个时按单模板生成；add_cards 校验 templateId ([8599ef9](https://github.com/helixnow/deep-student/commit/8599ef96e78d873cca621463d8c1a0fb619745c3))
* **chat:** ask-user options no longer read '(Recommended)（推荐）'; attachment panel closes on send ([90a974f](https://github.com/helixnow/deep-student/commit/90a974f7f85768c6a0ec48aa67b55f3b52df98e0))
* **chat:** blocks interrupted by an app restart no longer spin '正在思考…' forever ([736879a](https://github.com/helixnow/deep-student/commit/736879a525482d071c637c0226758f8f7d0fa572))
* **chat:** citation badges show the source type ([图1]) so [知识库-1] and [图片-1] no longer both read [1] ([7950809](https://github.com/helixnow/deep-student/commit/795080952caf763c8861e28e3cc1fcb7b7510acb))
* **chat:** PDF 选区提问后回答里不再出现点了没反应的 [1] ([39110a4](https://github.com/helixnow/deep-student/commit/39110a487f7f94a5ae1e17c580fdc018fc4406a3))
* **chat:** square the docked composer top corners and drop its white slab ([24009e7](https://github.com/helixnow/deep-student/commit/24009e714b4379f9ed61ea586529e9ca14c50efb))
* **chat:** 中文提问时工具调用前后的过程说明变成英文——系统提示加固定的回复语言规则 ([7b7746f](https://github.com/helixnow/deep-student/commit/7b7746ff2caf52c47dab80c59b5084b6c32ee906))
* **chat:** 会话固定模型被删除/停用后明确回退并提示一次（[#44](https://github.com/helixnow/deep-student/issues/44)） ([2269816](https://github.com/helixnow/deep-student/commit/22698168f1618fbaa5607cefc815ec66d97a2dce))
* **chat:** 右侧面板已打开某份资料时再点其页码徽章，标题不再变成「PDF」 ([fde29ce](https://github.com/helixnow/deep-student/commit/fde29ce3be6a9aae71f48b96da456bb160e10b60))
* **chat:** 工作台里首次从 PDF 划词「添加到聊天」，提示已引用，对话窗口输入框里却没有 ([34fae31](https://github.com/helixnow/deep-student/commit/34fae310dd31a47eebad523ac7fae1941a64ca05))
* **chat:** 引用到对话的提示与引用条显示「第 1 页」而不是 page:1 ([a822eea](https://github.com/helixnow/deep-student/commit/a822eea30c2d65b183c558415e78c30cad2e9854))
* **chat:** 教材引用 [PDF@tb_:N] 在聊天右侧面板打开并跳页，不再离开聊天页 ([db2c942](https://github.com/helixnow/deep-student/commit/db2c94235bef291b458bc9d2fd549c6e9bfa8411))
* **chat:** 来源卡片——能打开原文页、缩略图可显示、标题与摘要不再缺失 ([1724acf](https://github.com/helixnow/deep-student/commit/1724acf3a529bba3f3eedb4d176d3d41d644dee2))
* **chat:** 窗口切走期间挂载的回答 / 用户气泡回到前台后不再是空白框 ([0cc40d4](https://github.com/helixnow/deep-student/commit/0cc40d44654e45f68c2b6b7177ddb3fe6dc7f3b6))
* **chat:** 表格单元格里的 $|E+A^n|$ 把单元格从中间切断 ([6fa2092](https://github.com/helixnow/deep-student/commit/6fa2092eb062ae873ad3a5a38d7a8e6ec7c18419))
* **command-palette:** 「备份数据 / 恢复数据」直达设置 › 数据治理 › 备份（原事件无监听方，点了无反应） ([770925c](https://github.com/helixnow/deep-student/commit/770925cd3aa33dd15f7baa5f81a63bd9f626f716))
* **command-palette:** 导入 APKG 的提示显示加入复习的卡数 ([bffce48](https://github.com/helixnow/deep-student/commit/bffce48875a6a3eb48e4534680ac4b1e6af5c1f3))
* **command-palette:** 搜不到的词仍列出全部命令，回车执行第一条无关命令 ([d99cf84](https://github.com/helixnow/deep-student/commit/d99cf8434e1743749f2104a2ff9f756404bb59a2))
* **demo:** 学习桌面开场排窗适配各种桌面尺寸 ([fa9059e](https://github.com/helixnow/deep-student/commit/fa9059edfa3bf80007f012b1a9007be3bae31dab))
* **demo:** 学习桌面开场窄桌面上先收窗口宽度，闪卡不再压住右边的日程和简报 ([da960a4](https://github.com/helixnow/deep-student/commit/da960a45153c309514eade1fe63d1dee6051a027))
* **demo:** 学习桌面演示收尾细节 ([5362385](https://github.com/helixnow/deep-student/commit/53623858235dd572c410ac0264083d6c8bb2bb95))
* **demo:** 演示嵌入后直达剧本会话，会话上屏后才通知父页撤占位 ([6c3d9fb](https://github.com/helixnow/deep-student/commit/6c3d9fbd4cd7ff2bf431885433864519b5b89785))
* **demo:** 演示里不再向访客要通知权限 ([4eee8fd](https://github.com/helixnow/deep-student/commit/4eee8fd8f3f3dbc6dd8388025396bc4512538a7e))
* **dstu:** 资源库里文件夹的修改时间恒为「不到 1 分钟前」 ([5e6acb0](https://github.com/helixnow/deep-student/commit/5e6acb02bd828ce2d37f0805f622b67f8c310a81))
* **epub:** 窄栏里从目录 / 搜索结果跳转后自动收起侧栏 ([dd51ca8](https://github.com/helixnow/deep-student/commit/dd51ca807acee5613c9e4b954db8d108fa5c7c09))
* **epub:** 窄预览栏里目录默认收起、正文不再被拉出大词距；阅读器配色令牌全部失效 ([5f424a2](https://github.com/helixnow/deep-student/commit/5f424a21c464c5e82c37a94a028f63ae1cd888d2))
* **essay,translation:** 新作文沿用上次的批阅模式（会话无模式时不再兜底日常练习）；作文批完 / 翻译出译文后，名字还是「新作文」「新翻译」时按题目或正文首句、原文首行自动起名 ([ed3f0c1](https://github.com/helixnow/deep-student/commit/ed3f0c1bb2b0d7f5283e4e7b7eeb369fc5ebebd5))
* **essay:** grading mode survives reopen; stats row no longer covers text; full radar/menu labels ([8f728bd](https://github.com/helixnow/deep-student/commit/8f728bd1e52ba6f63d527f97539542195a926bd8))
* **essay:** 批改完成时滚回顶部的分数卡，Tab 行常驻总分徽标（点击回到分数卡）；评分段流式中不再以灰字接在正文后，改为「评分生成中」占位 ([66797e1](https://github.com/helixnow/deep-student/commit/66797e169f282380adedd844d532465e8aca7386))
* **essay:** 新建的空白作文一打开原文就收成「0 词」摘要行、看不到输入框——没有轮次时显示用的轮次号兜底成 1，被 currentRound &gt; 0 当成「已有结果」；改为看当前是否显示已完成的一轮（hasGradedRound），新建作文直接展开输入区 ([47a710e](https://github.com/helixnow/deep-student/commit/47a710e323fef36389ba6817df97b8891f15326f))
* **finder:** 文件大小列「16.5 KB」被折成两行 ([b4e4c24](https://github.com/helixnow/deep-student/commit/b4e4c24a5071f69e1660ee480d8a635f5de387eb))
* **flashcards:** 「另有 416 张已到期」实为没学过的新卡——积压拆成到期复习与待学新卡分开提示 ([726dcc8](https://github.com/helixnow/deep-student/commit/726dcc8f7f5a4ccbbfb090c98406e26630a030b4))
* **flashcards:** 今日「接下来」与卡片库共用显示标题——语义字段优先、填空折叠为 […] ([6ef6639](https://github.com/helixnow/deep-student/commit/6ef6639d4eb4e9fd48885697373ee5c34a4ea685))
* **flashcards:** 卡片库「已到期」不再包含新卡；筛选为空时不再显示「库中暂无卡片」 ([a1f78ec](https://github.com/helixnow/deep-student/commit/a1f78eca025e6dfbf08928f7a949180accda1c55))
* **flashcards:** 卡片库列表按语义字段显示题面与答案 ([5cc7ec7](https://github.com/helixnow/deep-student/commit/5cc7ec786ed12d0bc46c0dcbe824a89ad0636458))
* **flashcards:** 卡片库状态筛选 / 排序 / 计数只作用于当前 20 张一页——改由后端跨页执行 ([b03e7df](https://github.com/helixnow/deep-student/commit/b03e7df567a17bb99a2cb3ea1563e2ea4909142a))
* **flashcards:** 复习切卡不再套用上一张卡的模板 ([cc57790](https://github.com/helixnow/deep-student/commit/cc577902f10ce426c8b18acad80777ed9658e536))
* **flashcards:** 复习舞台模式去掉卡面 iframe 两侧滚动条槽位（模板背景贴边） ([dd06d37](https://github.com/helixnow/deep-student/commit/dd06d37c5c76a6a8e7c0e5059f7f4b964f33bf9f))
* **flashcards:** 有卡未入队时「今日」不再显示「卡片库还是空的」 ([037112e](https://github.com/helixnow/deep-student/commit/037112e7cdae60da602845540d54367c1307cd1e))
* **flashcards:** 移动端复习模板模式不加内边距，避免模板背景外再多一圈框 ([7d99d10](https://github.com/helixnow/deep-student/commit/7d99d10a58a0d0dae8578ce3017b56ebdfd89150))
* **import:** file drops failed on Retina; one bad file aborted the batch; source code can be imported ([474caa3](https://github.com/helixnow/deep-student/commit/474caa3ca46591336c28b4b625ff557dadd4c898))
* **kb/pdf:** 引用跳页打开正确资料；PDF 页码随滚动 / 跳页同步 ([9bd5ba1](https://github.com/helixnow/deep-student/commit/9bd5ba1bbb1d262f8003c70ac0e18fcd78005f77))
* **kb:** PDF 按页建索引——引用与跳页精确到页，并为多模态挂上逐页页图 ([8314401](https://github.com/helixnow/deep-student/commit/83144015381b8a8cab949def688bedc4537a6fef))
* **kb:** 不可用默认嵌入配置的告警同一 id 只打一次，避免索引 worker 每 5 秒刷屏 ([2563567](https://github.com/helixnow/deep-student/commit/2563567a86d68815e150c1ec29cb7554683da0bf))
* **kb:** 不支持建单元的资源类型标为不可索引，消除每 5 秒一次的无限重领 ([27117bb](https://github.com/helixnow/deep-student/commit/27117bb20a18b2dcf1e8943ad24148c0d762660a))
* **kb:** 关闭记忆时记忆笔记不再以「知识库」身份混入检索结果 ([954d49a](https://github.com/helixnow/deep-student/commit/954d49a519b4c424bfb64b19190321a0d61da6bf))
* **kb:** 升级后一次性把多页 PDF 重新排队建索引（逐页单元、旧数据按页重提文字） ([0948d44](https://github.com/helixnow/deep-student/commit/0948d44a140d5ff5fdc1c49b686184612a481391))
* **kb:** 多模态嵌入与文本嵌入同一回退链（维度默认 → 模型分配 → 唯一可用配置） ([d68707f](https://github.com/helixnow/deep-student/commit/d68707f04eb6aa9c20af26cedd89806a07df30db))
* **kb:** 多模态嵌入未设维度默认时回退到模型分配（不做隐式自动启用） ([5119746](https://github.com/helixnow/deep-student/commit/5119746f76d49a749f8cf97da3394bb59a28a1b4))
* **kb:** 嵌入模型不可用不再让知识库静默停摆 ([3e242e2](https://github.com/helixnow/deep-student/commit/3e242e27703e1eb33bc167e926299b408d68f94e))
* **kb:** 旧版多页 PDF（文字无页分隔符）重建索引时强制重建单元以按页重提文字 ([3ab27f5](https://github.com/helixnow/deep-student/commit/3ab27f59397727388a8e28dd7bba755291536ffe))
* **kb:** 未落库会话设置检索范围时给出可执行提示（替代原始外键错误） ([41817a0](https://github.com/helixnow/deep-student/commit/41817a0dd2a180ed76557f29626ac87868b7844e))
* **kb:** 未配置嵌入模型时知识库关键词检索可用；中文自然问句可检索 ([4824626](https://github.com/helixnow/deep-student/commit/4824626c8b8a7883c030d97b1ae645b43a1c95d1))
* **kb:** 检索结果显示笔记/文件/导图的真实标题而非 note_xxx ([1c5170c](https://github.com/helixnow/deep-student/commit/1c5170c574a5ad4168b500cefe54d7e6926309d4))
* **kb:** 视觉嵌入模型（Qwen3-VL-Embedding 等）自动视为多模态嵌入 ([6160777](https://github.com/helixnow/deep-student/commit/61607777a32ea9fe7870b6acc4905141373a1ef8))
* **kb:** 逐页单元不再重复挂全文；旧版多页 PDF 自动按页重提文字 ([e0ec090](https://github.com/helixnow/deep-student/commit/e0ec0907bb87860f243aca2be161c177abb8af5a))
* **latex:** question text renders $f'(0)$ / $A$ instead of raw source ([ce1e0f6](https://github.com/helixnow/deep-student/commit/ce1e0f6cb2de85c18340aa343727de09cccf1917))
* **latex:** square roots vanished in question text and options ([52d8f0f](https://github.com/helixnow/deep-student/commit/52d8f0fa273c3e6f247ad8835fd8e7c3eac65985))
* **learning-hub:** 「用这份资料制卡」不再弹附件面板盖住对话空态 ([4c36d42](https://github.com/helixnow/deep-student/commit/4c36d42300de7ace642c8910d4c4cdb59fc11391))
* **learning-hub:** empty-state create follows the type filter; context menu anchors on keyboard open ([d733d43](https://github.com/helixnow/deep-student/commit/d733d43197827591169471613b611052fdf5a6af))
* **learning-hub:** 拖入资源库里已有的同一份文件，提示「已在资源库中」并打开它 ([71c99ad](https://github.com/helixnow/deep-student/commit/71c99adf6d50af9bc702dbd481ee28fd744517f5))
* **learning-hub:** 资料列表顶部大片空白——列表变短后虚拟列表偏移与真实滚动位置不同步 ([fe6f351](https://github.com/helixnow/deep-student/commit/fe6f35124bc3447b4b39297f27b78fa12ffefaaa))
* **learning-hub:** 资源改名（含翻译 / 作文自动起名）后打开中的标签标题同步更新 ([42230ec](https://github.com/helixnow/deep-student/commit/42230ecbb4cc3259b5a2e9543127a9a940a608d9))
* **markdown:** nested lists in file previews had no bullets or indentation ([480fa59](https://github.com/helixnow/deep-student/commit/480fa59b2a80d96e76c4e54161c4d623bbee40ba))
* **markdown:** 任务清单在资料预览与聊天里不再同时显示圆点和复选框 ([4d6e18a](https://github.com/helixnow/deep-student/commit/4d6e18a79fa503b4697471956b425c8a0b0d2178))
* **mindmap:** .ds-btn 规则限定在导图作用域；编辑态背景色非法 CSS；打开不超 100%；新子节点追加到末尾 ([8c02b9c](https://github.com/helixnow/deep-student/commit/8c02b9c865a0e9186b47a60d7744731dd9a5cc5b))
* **mindmap:** Markdown 转导图——代码围栏里的 # 注释不再变成一级节点，节点标题去掉 ** / ` / 链接标记 ([435b4c9](https://github.com/helixnow/deep-student/commit/435b4c9763c5fc6a7f163c7393d047ac647a310b))
* **mindmap:** 引导模型在讲解具体内容时带节点引用（[思维导图:mv_xxx#节点:标题]） ([748591a](https://github.com/helixnow/deep-student/commit/748591a2faa70c6964c647e898e00e7fedfe3e03))
* **mindmap:** 窄面板顶栏不再挤成竖排；引用预览居中到目标节点并随宽度重新适配 ([7d22842](https://github.com/helixnow/deep-student/commit/7d22842e7227d14014d17e90c5fac4141c9acf21))
* **mindmap:** 节点里的 $Ax = 0$、$A$ 等公式按源码显示——行内公式改用 Pandoc 规则区分货币 ([06a6293](https://github.com/helixnow/deep-student/commit/06a62932351b0f8828734e04b3c049a03df40bb4))
* **mobile-shell:** macOS 桌面窗口拉窄进入移动布局时，红绿灯压住左上角菜单 / 返回按钮 ([4cc1d5c](https://github.com/helixnow/deep-student/commit/4cc1d5cea1bb296cde671519af6ae90a3e1c6703))
* **mobile-shell:** macOS 窄窗口下侧滑抽屉的品牌行与红绿灯叠字 ([ae33ec8](https://github.com/helixnow/deep-student/commit/ae33ec80888460aef7bd06f4c083a83ee2126de7))
* **notes:** Agent 探测按已解析的宿主窗口取编辑器，与写入同一实例 ([110ad71](https://github.com/helixnow/deep-student/commit/110ad71f040249781007437340900f9e61ed5891))
* **notes:** AI 审阅/灵感/宿主文案走 i18n，灵感加载失败可见 ([d3c37e3](https://github.com/helixnow/deep-student/commit/d3c37e31ea3066416db3aeed758fd6ebc04cb853))
* **notes:** AI 直改的高亮定位还原 Markdown 转义 ([6e296dd](https://github.com/helixnow/deep-student/commit/6e296dd88c75ec92d6f84a698e8450b254a987aa))
* **notes:** 划词存的笔记能打开、来源回链能点回原页；标题不在单词中间截断 ([401ec33](https://github.com/helixnow/deep-student/commit/401ec33acca80f69f1218d9eb3a67775ade0643c))
* **notes:** 块选中时不再弹文字格式浮条；属性浮层抽屉 Esc 先关自身 ([82e6bc3](https://github.com/helixnow/deep-student/commit/82e6bc3cde4b16e65d6dbe8902d4936777801071))
* **notes:** 块链接/移动提前置灰说明原因，反链转换不再链错，大纲命令可关闭 ([86c3e69](https://github.com/helixnow/deep-student/commit/86c3e69c04b29efb3e997fa71c7dfa84884c14cb))
* **notes:** 存为笔记/追加的实测问题 ([f1113d8](https://github.com/helixnow/deep-student/commit/f1113d86a3d59db310b56b280775043da9f858d8))
* **notes:** 导入 Markdown 为笔记时开头的一级标题作笔记标题，正文不再重复一遍 ([946e43a](https://github.com/helixnow/deep-student/commit/946e43abb8708ffdc4e2e7abbca7e3c1ea3351de))
* **notes:** 属性面板「学习资源关系」从原型裸控件重做为统一样式 ([eb2d1f8](https://github.com/helixnow/deep-student/commit/eb2d1f80a6c714cc5a579f007a68215b4bb1f822))
* **notes:** 属性面板不再重复露出 study_* 原始键与系统键；无旧属性时隐藏映射工具；去掉工作台重复的关系区 ([902fa4a](https://github.com/helixnow/deep-student/commit/902fa4aac983d510af64878895aadb146906afc5))
* **notes:** 属性面板学习属性/模板预设改为统一控件；抽出笔记通用表单样式 ([e444607](https://github.com/helixnow/deep-student/commit/e44460770f782935d6273020fd920a9f94c1a541))
* **notes:** 打开笔记不再静默改写文件；公式块/标题节奏/顶栏/待办对齐 Notion ([3738212](https://github.com/helixnow/deep-student/commit/3738212f704e99a86959685e508d6b2a18b4a7f3))
* **notes:** 操作并入宿主顶栏时不再画滚动分隔线（避免与标签栏底边成双线） ([62620a3](https://github.com/helixnow/deep-student/commit/62620a3989100aeba2443abebdf6d6172645f031))
* **notes:** 新建学习笔记/个人模板/旧属性映射统一为笔记通用控件 ([a3ffa1d](https://github.com/helixnow/deep-student/commit/a3ffa1df805dd3bbdaaa58e6bc1067fd09fefa7e))
* **notes:** 标签建议下拉浮于输入框下方不再撑高页头；隐藏 _ 前缀的系统内部标签 ([ed92522](https://github.com/helixnow/deep-student/commit/ed92522bceb4b2babed1415ed4a9ae539432e673))
* **notes:** 桌面窄笔记栏不再误用手机端交互；顶栏操作窄宽度自动收为图标 ([1187a04](https://github.com/helixnow/deep-student/commit/1187a044f11fe0a77742ff14dd059721ce204835))
* **notes:** 模板里的空待办渲染为真正的复选框而非字面「[ ]」 ([6891a21](https://github.com/helixnow/deep-student/commit/6891a2132bffd44e95f49e8f4bd875b2fa681900))
* **notes:** 笔记内容区不再被全局 main 规则撑成整窗高；标题聚焦时显示页面操作 ([e6868b8](https://github.com/helixnow/deep-student/commit/e6868b801baf502aa876f9842dc7d242d7d9c46c))
* **notes:** 顶栏保存状态的字数复用 translation:stats.characters ([35a9047](https://github.com/helixnow/deep-student/commit/35a90479a5c77d97414336d6ac0119f5e8249ed7))
* **notification:** desktop toasts show up to two lines instead of single-line ellipsis ([aebaffa](https://github.com/helixnow/deep-student/commit/aebaffa99b5a5432ff6f91ef376577e78d35607a))
* **parser:** 表格提取文本的工作表标题带上行数 ([f6fc1e7](https://github.com/helixnow/deep-student/commit/f6fc1e7ce5a70fd13d87d5c224cd7bf5aae22f0c))
* **pdf:** 「添加到聊天」带上真正的选区与页码，不再变成整本书的引用 ([7139e33](https://github.com/helixnow/deep-student/commit/7139e33b663e24632621fae6546451f1905942d4))
* **pdf:** 对话里点「第4页」右侧面板停在第 1 页；跳到末页时页码框显示上一页 ([07026e9](https://github.com/helixnow/deep-student/commit/07026e9e9ed6ad8cad7e827462ea8c6dbf2e4fe0))
* **pdf:** 解释/翻译面板开着时选中另一段，划词工具条照常出现 ([fd9b560](https://github.com/helixnow/deep-student/commit/fd9b5607223471cfdc3e79398cce81fff82798e0))
* **pdf:** 连字 fi/fl 不再在划词/搜索里丢字；划词结果面板在窄预览栏不再挤坏、去掉重复关闭钮 ([b72cef2](https://github.com/helixnow/deep-student/commit/b72cef2b1bf76f4226b37fc326e7d2b2d60d6d36))
* **pdf:** 附件 OCR 走多引擎回退链路（[#64](https://github.com/helixnow/deep-student/issues/64)） ([a4da2f8](https://github.com/helixnow/deep-student/commit/a4da2f87bc9d13ed8f8cff51148dd2e945199d9c))
* **practice:** no-answer-key choice questions were marked 错误 even when AI graded them correct ([4df968b](https://github.com/helixnow/deep-student/commit/4df968b05633e2d4e83fa3bf323bbab1d1530a78))
* **practice:** re-entering sequential practice no longer skips the unanswered question ([f848d58](https://github.com/helixnow/deep-student/commit/f848d58814cbe1f0f05c8a49df91413f5dce9a7c))
* **providers:** Ollama 填根地址 http://localhost:11434 时拉模型列表与对话都 404（[#384](https://github.com/helixnow/deep-student/issues/384)） ([08dc65d](https://github.com/helixnow/deep-student/commit/08dc65de8ab6988a773b6fdb42f9775eba351bc9))
* **qbank:** 做题区居中栏失效——题卡贴左、与底栏错开约 100px（880 宽窗口：题卡 x=16，底栏 104.5–776.5 居中） ([4f624b2](https://github.com/helixnow/deep-student/commit/4f624b284ff556a8b9786fc0240b9bee27459c52))
* **quick-assistant:** 「存为错题」改为写入题库（旧实现调用已删除的后端命令必然失败） ([3e67325](https://github.com/helixnow/deep-student/commit/3e67325c8a12aec72687cf73caac91f8a547edeb))
* **reasoning:** GPT-6 的 reasoning_effort max 被静默折叠为 xhigh，界面也选不到 max（[#427](https://github.com/helixnow/deep-student/issues/427)） ([c17673c](https://github.com/helixnow/deep-student/commit/c17673c0025c2e862a0a72022cc41ee99fe94b1b))
* **scroll-area:** viewportClassName padding was silently zeroed by OverlayScrollbars ([d515186](https://github.com/helixnow/deep-student/commit/d51518641d18bf7fa3c99efc7b99be153cc5576a))
* **settings:** MCP「快捷操作」菜单撑宽到 ~385px 盖住半个侧栏；「添加预置」弹层超出窗口、标题被顶栏遮住（[#46](https://github.com/helixnow/deep-student/issues/46) 复查） ([0a898b3](https://github.com/helixnow/deep-student/commit/0a898b3923de3f3c3212b9645d9af25c5cc2556a))
* **skills:** 制卡技能与「生成即入队」对齐，不再反问要不要加入复习 ([0ec6df0](https://github.com/helixnow/deep-student/commit/0ec6df014222654c62fc034da0420510a1c41f1d))
* **skills:** 技能管理上移到顶栏时动作折叠进「更多」，标题与计数不再被挤没/重叠 ([f579bc7](https://github.com/helixnow/deep-student/commit/f579bc7104eb9ac1c7031f093e51f6bd42bdd1d6))
* **sync:** S3 region 留空时以空串签名，腾讯云 COS 等兼容服务一律拒绝（[#57](https://github.com/helixnow/deep-student/issues/57)） ([bc5d688](https://github.com/helixnow/deep-student/commit/bc5d68868bdbb1dc95443f11e7b4fe7e84c34267))
* **today:** 「与 AI 复盘」新开对话再填入周报，不再混进当前会话 ([85e2536](https://github.com/helixnow/deep-student/commit/85e2536c002e7356b11b657ab2c362a888baf8c1))
* **todo:** 番茄钟专注某条待办时，该行看不出正在计时——行尾按钮常显为「专注中」 ([ea53d92](https://github.com/helixnow/deep-student/commit/ea53d92dd34033b7d6e79cf874f1c6bd70e1fa55))
* **translation,learning-hub:** 窄栏里翻译工具条不再叠字、上下分栏；新建资源后列表选中跟到新条目 ([63f3da7](https://github.com/helixnow/deep-student/commit/63f3da7e066fa5243d0888ebf8aee112358e62b5))
* **translation:** 划词翻译在默认开思考的模型上一个字都译不出来 ([6a343cb](https://github.com/helixnow/deep-student/commit/6a343cb169e51b840d8f69fdeeaf81e837af473f))
* **video:** 02 资料库 3D 段截图里纸片全缺；去掉扫描中一闪而过的 cos 读数 ([c9a7e85](https://github.com/helixnow/deep-student/commit/c9a7e8500dea6bb86755c416beb9f881f7c66891))
* **video:** 03 导图按产品真实链路重画——点导图卡「打开」= 在会话右侧面板打开（CHAT_OPEN_ATTACHMENT_PREVIEW type=mindmap，替换 PDF 面板），不再整窗展开；面板：头部「微分中值定理 (知识导图)」+ 工具条 + 点阵画布（编辑器灰色主题）+ 缩放组 / 小地图（分支色 + 视口罩）/ 底栏缩放百分比随 fitView 变化；切结构按 StructureSelector 真实行为——每次点「切换结构」开弹层（当前: 思维导图(向右)），点选即关，切两次（组织结构图(向下) → 逻辑图(向右)，fitView padding 0.2 / maxZoom 1），不再出现产品没有的时间轴结构；背诵：点「背诵」出 ReciteStatusBar 两行 →「一键遮住要点」叶子整段铺文字色底、背诵行收成进度行 0/5 → 逐个点开（底色 300ms 渐变成 emerald-100）→「全部揭示」5/5·100%（进度条 --mm-warning）；背诵行出现时画布整体下移、不重新适配（probe-clw-book 根节点 +71）；导图卡头部按真机（标题 12px + 节点数 11px、右上 42.5×28「打开」），根 / 一级节点尺寸按真机；音效跟新节拍；删掉旧的全窗工具栏 / 结构弹层 / 背诵状态栏 ([0751042](https://github.com/helixnow/deep-student/commit/07510428857440581d88b8c60a6f21471bc89511))
* **video:** 04 制卡块按产品真实链路重画——取证 cza-*（demo-anki-cards）+ 读码 Card3DPreview / ankiCardsBlock / ChatAnkiProgressCompact：≤3 张平铺内联卡（608×100、圆角 12），第 4 张起切成 3D 叠放（卡 300×98、圆角 10、底 252、柔影；右上 ▶（自动播放默认关）/ 翻面 / 1 / N；导航点 48 间距只露 4 个），删掉产品没有的叠放自动前进与「生成中 n/12」状态行；进度卡（路由 ✓ → 生成 ◌ → 完成 · AnkiConnect: 未连接 · 百分比 · 进度条 · 正在生成第 N 张卡片… · 卡片：N），完成后出小结条「已生成 12 张卡片 用时 1 秒 · 任务中心 · 导出 APKG」；操作行生成中整体禁用，「复习这批」要等「加入卡片库」拿到真实卡片 id（canReviewBatch）→ 片中先点加入卡片库（转圈 → ✓ 已加入卡片库、共 12 张卡片 已保存）再点复习这批，引导语不再自称已加入卡片库；消息收尾补「3 个结果」+ 页脚、输入框上方「产物 1」；回答正文改 16px/27.52、段距 18.88（probe-clp-12），导图卡出现与 04 生成时按 stick-to-bottom 贴底滚动 ([b6c88d0](https://github.com/helixnow/deep-student/commit/b6c88d0646da75ca514d3d8c01d4e7a0f52a99e6))
* **video:** 04 制卡块按真实后端更正——卡片生成时以 UUID 入库并在完成时自动入队（chatanki_executor Uuid::new_v4 / enqueue_cards_for_session，10-01 起「生成即入队」），canReviewBatch 完成即为真：「复习这批」生成完直接可点，去掉多余的「加入卡片库」点击与「已保存」（那个只在同步到 Anki 后 syncStatus=synced 才显示）；演示壳卡片 id 是 chat-batch-demo-N 占位，取证里按钮发灰是 mock 假象。另按真实后端补：进度卡从块出现就显示（先检测 AnkiConnect、routing → generating），生成中操作行前面有「暂停 / 取消」（有 documentId 时），编辑 / 牌组生成中也可点 ([5f4456a](https://github.com/helixnow/deep-student/commit/5f4456ab73fabf4c102eea77209e6a7dcc20cff5))
* **video:** 04 制卡进度卡 AnkiConnect 改为「已连接」——用户定：片中按开着 Anki 的真实状态画（ChatAnkiProgressCompact available=true → default 徽标 primary/5 底、primary 字），去掉只在未连接时出现的刷新钮，徽标接在百分比前（x = W − 207）；黄色「未连接」警告样式在宣传片里易被读成报错 ([bfb9ed5](https://github.com/helixnow/deep-student/commit/bfb9ed519c67f9456f1d3140609b00d7a9b6c5e8))
* **video:** 05 夜里复习按产品真实界面重做——新取证 d3-闪卡-*（wb2 FC=1 FC_START=1：模拟对话「复习这批」workbenchBus.activate(flashcards, startReview batch)，补 fsrs_enqueue_cards / preview_intervals / rate / get_due / get_stats / get_review_statistics mock；演示壳把 AgentBridge 换成空桩，总线需手动 setEnabled），DOM probe-fca / fcb / fce-*：窗口按级联 0 号槽落在左上 (48, 88)、默认 960×680（原片 860×740 居中、复习完还自己左移给曲线腾位，都不是产品行为）；会话页没有标签栏，顶部 8px 进度条 + 蓝色「本次为批次集中复习，评分将计入正式复习记录。」+「← 退出 … 新 N / 复习 N / 已评 N / 单卡计时 · 撤销 / 编辑 / 跳过 / 暂停」；卡面走卡片模板（正面 15px/600、背面 = 暗淡正面 + 虚线 + 答案）；翻面只播后半程（−88° → 0，300ms），点按钮评分不飞卡，下一张淡入（260ms）；评分键「重来」灰字红框；撤销提示浮在底部按钮上方；删掉产品阈值外的连击 / 稍后重现芯片与「已评 N · 剩 N」；复习顺序 = 卡片块顺序（ξ 那张调到第三张，ANKI_CARDS 1 ↔ 2）；记忆曲线之后先「← 退出」回今日页（今日 / 库 / 统计 三个标签、25% 进度环、接下来 9 张）再点「统计」，统计页改成八格调度概览 + 热力图 / 每日复习 / 评分分布，去掉数字递增与热力图扫出动效；记忆曲线三张卡对齐新评分；05 章节标签压窗口角时不铺柔光底 ([fc10c58](https://github.com/helixnow/deep-student/commit/fc10c58cff3803bf560d62f1be623baff31a0a34))
* **video:** 05 指针入场前闪卡卡面不显示「点击翻面」悬停提示 ([c0b5905](https://github.com/helixnow/deep-student/commit/c0b5905d5e7edf948ba1cd8ac5255defca21845a))
* **video:** 05 白天场景「保存到知识库」转场镜头收紧 ([862366f](https://github.com/helixnow/deep-student/commit/862366fa6eb14a96b10eea70d0c384ec3b64fc2b))
* **video:** 06 做题屏按修好的产品居中——产品 4f624b284 修了做题区 mx-auto 失效后，题卡 / 统计行整栏右移 102.5 到与底栏同一条 672 居中栏（probe-kzx：题卡 x 16 → 118.5）；指针落点（A / 提交 / 滚动 / AI 解析）同步右移，读解析时瞳点停到题卡右侧新的空白（x 818）；镜头中心跟着题卡（1.33 档被屏幕边界钳住，画面不变） ([697fbaa](https://github.com/helixnow/deep-student/commit/697fbaa3fb6e22434066505779a5eaaf7abafeda))
* **video:** 06 题目集按产品最新状态重拍：标题栏加资源列表开关，新建后资源列表自动收起、主区全宽——启动台与识别导入 / 解析 / 导入完成居中 588 栏，拖入遮罩铺满主区，题库网格 3 列（278.3 宽），做题卡左对齐 644 宽、统计四格铺满卡宽、底部导航居中，工具条「顺序」下拉与计时芯片完整露出（不再被挤出）；几何按 880×660 新取证（probe-kz*），镜头中心跟着主区左移 ([ea23868](https://github.com/helixnow/deep-student/commit/ea23868063a4ae15395a83bd680e725a5aa7d7ae))
* **video:** 06 题目集窗口改回产品默认 880×660（双击快捷方式新开窗口不记尺寸）：各屏按 880 宽重新取证转写——题库 2 列、识别导入窄栏、做题工具条照产品画溢出；判错后整块结果面板在底栏下，先滚动再点 AI 解析；镜头按小窗口重排 ([f72f07c](https://github.com/helixnow/deep-student/commit/f72f07c6ccf8b87513766ef08bd947bbd43d292f))
* **video:** 07 作文按产品最新状态重拍：新建后资源列表自动收起、主区全宽；批改前原文占满（47a710e32 修好后的真实状态），开始批改后原文收成「雅思大作文 · DeepSeek V4 · 129 词 … 查看原文 / 取消」摘要行，结果标题并入分段 Tab 行（◌ 批注中 / 润色中 · 已生成 N 字 · 第 1 轮），正文居中 728 栏；评分段流式中正文下出「评分生成中...」占位；批完自动平滑滚回顶部分数卡，Tab 行带 6.5/9 徽标；几何按 880×620 新取证（probe-ey* / ez*） ([9119a16](https://github.com/helixnow/deep-student/commit/9119a162152af711f81d5bad94cb2aa8f122d487))
* **video:** 07 翻译按产品最新状态重拍：标题栏加资源列表开关；880 宽窗口新建后资源列表自动收起（宽 272 → 0、200ms），工作台占满全宽——左右两栏 434.5 / 435.5、语向组居中、流式中工具条多一个「翻译中...」；几何按 880×620 新取证（probe-tz*）重排 ([2eb1d00](https://github.com/helixnow/deep-student/commit/2eb1d003ed88371ae75445eaed84ce23764c3395))
* **video:** 09 MCP 按产品真实链路重画——删掉自拟的「MCP 工具」服务器勾选面板与「Context7 / Query Docs」调用行，改成对话里调用外部 MCP 服务器：工具行「zotero · Zotero Search Items 执行中 → 执行完成 909ms」（显示名 = _serverId · humanizeToolName）→ 回答列出 Zotero 里的笔记与论文；取证驱动修正：MCP 回复改发 tool_call 事件（前端没有 mcp_tool 事件处理器，原 mock 的工具块不渲染）、服务器按导入 JSON 默认形态（id = 键名、无命名空间），新增 ptext: / pprobe: 两个页面级步骤（菜单与子菜单在窗口外的浮层里） ([7f09562](https://github.com/helixnow/deep-student/commit/7f09562a0a0e7408e4a2712000773ff4458dd130))
* **video:** 09 多模型并排按产品真实界面重画——对话窗口 1080×720 带会话栏，用户气泡 → 轮播点 → 三张并行变体卡（deepseek-v4 / glm-5 / kimi-k3，Lobe 单色图标 + 日期），流式时卡框 primary/30、页脚「复制 / 取消」，写完换「复制 / 删除 / ⋯」，三卡随最长内容一起长高；首轮结束侧栏「未命名会话」与窗口标题一起变成会话名；镜头抬高避开字幕。research.tsx 导出对话零件供 09 复用 ([29d6d72](https://github.com/helixnow/deep-student/commit/29d6d72a06e7ce3062f52f730cab7e9853ede513))
* **video:** 09 懂你四块面板推近到内容看得清 ([8128b7b](https://github.com/helixnow/deep-student/commit/8128b7b2203b0ccdff58965f335059cb8d994ea8))
* **video:** 09 技能管理按产品真实界面重画——980×680 窗口，标题栏「所有技能 / 55 个 … ＋ 新建技能 | ⋯」，搜索框 + 芯片「全部 55 · 内置 55」，三列卡片（名称 / 版本 · Deep Student / 三行描述 / 页脚 内置 · 依赖 · 工具数 · 停用 · 编辑 · 更多），文案取技能注册表中文描述，删掉自拟的「内置 58 · 全局 6 · 项目 2 / 技能市场」与卡片入场动画（产品列表无入场动画） ([1874016](https://github.com/helixnow/deep-student/commit/1874016bf022130065a06c4ee58d6e76ddee9d3d))
* **video:** 09 记忆按产品真实链路重画——删掉自拟的记忆卡列表与「已参考 2 条记忆」，改成新会话里问概念：工具行「记忆搜索 执行中 → 执行完成 718ms」→ 两段流式回答带 [忆1] [忆2] 角标（按偏好先讲几何直观、点出 ξ 开区间这个易错点）→「2 个结果」→ 页脚；首轮结束侧栏与标题起名「拉格朗日中值定理」；几何取自 probe-ymc-10 ([bb9eda2](https://github.com/helixnow/deep-student/commit/bb9eda2bc562b1de92b13f7ad77fb557bb054d26))
* **video:** 两处画面问题——记忆曲线复习点标注垫面板底色，曲线从字后面穿过，「期望保留率 90%」挪到虚线左端线下的空角；「06 检验」「07 写作与精读」章节标签压在窗口左上角时不铺柔光底，不再洗白窗口角和红绿灯 ([fa26c09](https://github.com/helixnow/deep-student/commit/fa26c09fdfadb65ff1fd81a7a5597f4676cbea40))
* **video:** 夜里复习镜头推近到卡面 + 评分行，FSRS 排出的间隔看得清 ([92d9ff4](https://github.com/helixnow/deep-student/commit/92d9ff4aee8bae3514cec1a3a61fe29737289013))
* **video:** 技能数字与画面对齐——09 字幕和收尾副标题「40+ 技能」改「50+」 ([bbfd42b](https://github.com/helixnow/deep-student/commit/bbfd42b218805fcc1f1f8f0e579934fcba7c6140))
* **video:** 收尾地形 4K 版是 1080p 放大——画布与那页纸贴图跟随渲染倍率 ([093b3d9](https://github.com/helixnow/deep-student/commit/093b3d9ed4d093a6fc5f5044123f382315cc4b9f))
* **video:** 收尾等高线地形不再断裂——脊状分形的 |n| 换成平滑绝对值 √(n²+ε²)/(1−ε)（JS 与 GLSL 同步）：硬折痕在四层噪声里铺满山体，晕渲成一块块三角面、等高线在每道棱上折断；脊顶高度保持不变，山头标注与那一页纸的位置照旧 ([154ed06](https://github.com/helixnow/deep-student/commit/154ed06e968dd3b66ce67ec676f7bfa5040c12c0))
* **video:** 检索段探针改为实心点与细尾迹，相似度波前改为细线圆环；暗场字幕用深色柔光底 ([f65b3fb](https://github.com/helixnow/deep-student/commit/f65b3fb07b84badda5b23e0887d30eda9f22d579))
* **video:** 第一幕 3D 检索落点跟随新时间线行——Handoff ROW_Y 改用 TL_PITCH 行距、ROW_X 落到工具图标上（行前圆点删掉后图标从 +22 挪到 +12） ([bd9ba38](https://github.com/helixnow/deep-student/commit/bd9ba38397b2061e71733a5cb17ef70cbfcc6e05))
* **video:** 第一幕 PDF 划选工具条按真机——删掉 PDF 里不存在的「添加为上下文」（PdfSelectionActions 不传 onAddAsContext），剩 6 项（复制 / 解释 / 翻译 / 保存为笔记 / 制卡 / 添加到聊天），29 高、圆角 7、11px，片中改为点「添加到聊天」（有资源 id 时即选区引用）；引用芯片文字改成真机显示名「高等数学（第七版）上册 第 132 页」（原来是 locator 原文 page:132） ([77f25db](https://github.com/helixnow/deep-student/commit/77f25db3107cb2e10b799f9ad5d53f194aefbc00))
* **video:** 第一幕 PDF 面板外框按真机重画——头部「文件图标 + 文件名.pdf (文档) … 外部打开 / 关闭」（12px，40.5 高、无分隔线）；底部工具条换成真机那一排（缩略图 / 搜索 | 书签 / 批注笔激活 / − 100% ▾ + | ‹ [页码框] /总页 › / 旋转 / 夜间 / 阅读 / 全屏，居中）；阅读进度条加灰轨与右侧百分比浮标；几何取自 probe-clr-pdf ([5c61630](https://github.com/helixnow/deep-student/commit/5c6163009ec4e7613636e0b59b0eb7ef7b32aa13))
* **video:** 第一幕两张错题照片从简笔画换成程序渲染的手机俯拍作业照 ([069a9ad](https://github.com/helixnow/deep-student/commit/069a9ad52203a9cc0d469c16857dbba14e29b330))
* **video:** 第一幕划词选区不再闪烁——选中部分合成一条连续底色（不再逐字铺半透明底叠出深缝、斜体字行框高低不齐），删掉选区上自绘的扫光，漂浮教材页落平后不走 3D 合成层、面板全不透明后才交接且对上面板 1px 左边框；选区色改用产品 PDF 文字层的 primary / 0.4 ([f6ba5f3](https://github.com/helixnow/deep-student/commit/f6ba5f348652d9eccaa93cf64bc82949f9c0e6c3))
* **video:** 第一幕时间线行与角标按真机样式——删掉行前圆点，思考行 16px「正在思考 N 秒…」→ 收起为「已用时 N 秒 ›」（原来是 completed 文案「已思考用时」），统一搜索 / 记忆搜索改成工具行「执行中... 1s → ⊙ 执行完成 1.1s / 718ms」（原来的「已检索 N 条来源」是检索块文案），行距 36.7；引用角标 [n] 改成 17.5 高、圆角 9、11px，PDF 页码角标「第N页」去掉图标、9.8px 细框（取证 probe-clq-4 / probe-clr-pdf） ([1db974c](https://github.com/helixnow/deep-student/commit/1db974c77bac8893077eb12ff01e2081e48a87c6))
* **video:** 第一幕经典壳左栏与标题行按真机重画——左栏几何取自 probe-cla-0（导航 7 项、「设置」贴底、「课题 / 对话」分区头带图标、会话行右侧相对时间、删掉自拟的置顶「高数期末复习计划」）；会话按产品逻辑：草稿不进侧栏 → 发出后顶部「未命名会话」+ 转圈 → 首轮结束起名；标题行「边栏 / ← / →」挪到左栏顶，主区只有「&gt;_」+ 会话名（草稿时为空、起名前只有「&gt;_」），删掉多出的新建图标 ([b6b3ef3](https://github.com/helixnow/deep-student/commit/b6b3ef39b5bb2711dfe4900da80df3fa77001307))
* **video:** 第一幕输入框与用户消息按真机结构重画——输入框：选区引用玫红药丸单独一行（Quotes + 显示名 + ×）在上、照片附件药丸（26.3 高、20px 圆形缩略图 + 11px/600 文件名）在下，文本框 15px、占位符「请输入问题...」，底栏换成真机的 + | deepseek「高」▾ | 语音 | 28px 发送（原来是 ⚡▾ 与转圈图标）；用户消息：气泡在上，附件与引用改成气泡下方右对齐的 56×56 方块（图片 → 引用，引用是通用文件图标 + 截断显示名），最下复制 + 21:00（取证 probe-clu-att / clr-pdf，读码 ContextRefsDisplay / ContextRefChips / AttachmentPreviewChips）；用户消息变高后助手块整体下移 49.4（向量化气泡锚点、向量条、3D 检索落点、镜头与瞳孔目标、卡片块上滚距离同步），空态标题换成产品实际会出的变体，引用通知副标题用显示名 ([a2d5da6](https://github.com/helixnow/deep-student/commit/a2d5da64796d96ea8e57f29f50ce59c7fd039246))
* **workbench:** 桌面「AI 学习简报」1 项未完成待办显示「待办进度 100%」 ([0a75fdc](https://github.com/helixnow/deep-student/commit/0a75fdcea6c7778d8d2227c11c290efc1c91cf63))
* **workbench:** 浮动对话窗铺到底边时被 Dock 盖住输入栏底部一排按钮 ([e2ba1aa](https://github.com/helixnow/deep-student/commit/e2ba1aa7e1bc278b60bab5db388a00fc80ee0327))
* **workbench:** 补齐工作台下失效的跳转——题目集、在学习中心打开、知识库/记忆定位 ([accfa98](https://github.com/helixnow/deep-student/commit/accfa98cd975f3c8891144c0226dd19e465ee23b))
* **workbench:** 首次划词「添加到聊天」对话窗口直接盖住正在读的 PDF；提示里缺「去对话」 ([fcf48b4](https://github.com/helixnow/deep-student/commit/fcf48b47bffb5ab3ee4ba6e637bbbc1690336c03))


### Performance Improvements

* **app:** keep shell sidebars mounted to avoid refetch on navigation ([30896a2](https://github.com/helixnow/deep-student/commit/30896a24e4986f39588beabf9a0d5dd50e531e75))
* **build:** stop polling the repo and narrow tailwind content globs ([d983f7e](https://github.com/helixnow/deep-student/commit/d983f7e388a40980f378fb23c4d783b0737c86eb))
* **chat:** hand scrolling back to the browser and unblock the timeline ([4ee3507](https://github.com/helixnow/deep-student/commit/4ee3507166bc9a33c37ea50df53a857a4ff89efd))
* **chat:** hoist session list cache into a module-level store ([5e18b28](https://github.com/helixnow/deep-student/commit/5e18b28772a164c064d1398186c688d922cbd3fe))
* **chat:** keep shell sidebars mounted and share the session list via a store ([0f4e7bd](https://github.com/helixnow/deep-student/commit/0f4e7bd056b6f33f249ff3e62712433fcb5a9ac3))
* **demo:** 学习桌面开场更快 ([789663f](https://github.com/helixnow/deep-student/commit/789663f6af1bfd7d234b285ec85923010563484f))
* **notes:** 模板库打开/切换不再卡 3 秒 ([6dcc924](https://github.com/helixnow/deep-student/commit/6dcc92490b810d54a80e8aec57681bcc571896c1))
* **startup:** replace the startup preflight card with a static boot surface ([7331060](https://github.com/helixnow/deep-student/commit/7331060bd867b4ebdb4e3864a79241edd621c76c))
* **ui:** drop per-frame blur and backdrop-filter from shell transitions ([1a6e94c](https://github.com/helixnow/deep-student/commit/1a6e94cb79e2491f8e1cdcc66d8d5685fdf7961c))


### Code Refactoring

* **reasoning:** unify thinking levels across all channels with backend-side mapping ([00c53e0](https://github.com/helixnow/deep-student/commit/00c53e006461047aed3447c03f0e6200893973b0)), closes [#427](https://github.com/helixnow/deep-student/issues/427)

## [0.9.73](https://github.com/helixnow/deep-student/compare/v0.9.72...v0.9.73) (2026-10-01)


### Features

* add pelican bicycle svg animation ([6de34e3](https://github.com/helixnow/deep-student/commit/6de34e3a5f8ed24d98daef72d6670e69be4568b2))
* add Qin emperor pelican flight SVG animation ([efb2b0d](https://github.com/helixnow/deep-student/commit/efb2b0da540bd374db7fc375d7d381d6e3e491dd))
* **chat-v2:** G01-a ExecutionEventSink 接口提取——无界面执行内核总入口 ([8900013](https://github.com/helixnow/deep-student/commit/890001395a8e755e0073c5603332eb140ce7029e))
* **chat-v2:** G01-b LLM 流式层去 Window 依赖——StreamEventSink ([a220633](https://github.com/helixnow/deep-student/commit/a2206333448e502a047f9aad354e384dd74b528f))
* **chat-v2:** G01-c ToolDescriptor 后端权威注册表（元数据 SSOT） ([d0bfef4](https://github.com/helixnow/deep-student/commit/d0bfef4e38de4a0f5f3a57a6699eb1005eaf30d8))
* **chat-v2:** G01-d headless 入口收口 + G03-d 无窗唤醒轮接通 ([fa47e18](https://github.com/helixnow/deep-student/commit/fa47e1822be2fd196d0b369fc28f0159b1e9a51c))
* **chat-v2:** G02-P1 DelegatedGrant 委派授权数据模型 + 撤权 epoch 实时生效 ([35de775](https://github.com/helixnow/deep-student/commit/35de77502ec3c9e9343e1a246338e91191662f6b))
* **chat-v2:** G02-P2 撤权 epoch 落库 + G08-P2 预算 settings 可配与快照 ([5b753d7](https://github.com/helixnow/deep-student/commit/5b753d7ba0cb8f9f279b50a53148bf6a2e1b40b7))
* **chat-v2:** G03-a 子代理完成投递持久账本 + 后端 CompletionDispatcher + Unknown 代际 ([4a2ff86](https://github.com/helixnow/deep-student/commit/4a2ff864a8b740e68a33dbfa700955ba3c327664))
* **chat-v2:** G04-P0 连接器操作持久账本——状态机 + 系统幂等键 + outcome_unknown ([ce729c6](https://github.com/helixnow/deep-student/commit/ce729c63494da7ceab7ad0f246910303795d3b04))
* **chat-v2:** G04-P1 首个真实 connector provider 纵向打通 + provider 对账 ([9e5306c](https://github.com/helixnow/deep-student/commit/9e5306c344c951356ba5e95476713146ca134af4))
* **chat-v2:** G05-P1 程序化工具组合（PTC）——Starlark broker + 只读工具面 ([06f82dc](https://github.com/helixnow/deep-student/commit/06f82dc2aadfa387c8edc6b4c9b5d0d2dcb0f589))
* **chat-v2:** G05-P2 PTC object_read 分页回读 ([7b4a42d](https://github.com/helixnow/deep-student/commit/7b4a42d783ce60a4d2c280c8803a69a9f22c0cb2))
* **chat-v2:** G05-P3 PTC 受控写与对象写回 ([c321d54](https://github.com/helixnow/deep-student/commit/c321d5435eec489be21940e6263cb923d05e48c6))
* **chat-v2:** G06-P1 能力声明驱动门禁推广至 docx/pptx + 格式无关骨架 ([9cca7c3](https://github.com/helixnow/deep-student/commit/9cca7c32183610e13f6d8c39a16009397e2bdd4d))
* **chat-v2:** G07-a candidate_complete 与任务验收分离——TaskFinalizer 骨架 ([f839baf](https://github.com/helixnow/deep-student/commit/f839baf8e2ef544b17ff97676b7fb095ceb4f4d3))
* **chat-v2:** G07-b TaskFinalizer 验收器补全——BatchCoverage + SideEffectsSettled ([c0cccaa](https://github.com/helixnow/deep-student/commit/c0cccaaeff30a3be25869d6eaa279025c2a635a5))
* **chat-v2:** G08 全树预算管控——BudgetLedger 树根账本 + hooks 预算门 ([555aef5](https://github.com/helixnow/deep-student/commit/555aef5d6d5899ffef2f9f5189327b5970fdac9f))
* **chat-v2:** G08 环境清单与漂移检测（environment manifest 半边） ([17e91c4](https://github.com/helixnow/deep-student/commit/17e91c48835b4b46f1fa02efeb6fc6d463727e61))
* **chat-v2:** G09-P0 技能使用后端账目 + 经验候选库（只记录不回放） ([6c488ab](https://github.com/helixnow/deep-student/commit/6c488ab79054949b2ba4821836ddf7321f8f2a94))
* **chat-v2:** G09-P1 技能经验回放器（dry-run 对账 + 人工晋升） ([f81601b](https://github.com/helixnow/deep-student/commit/f81601b12930c21dfa914e903fdb7b2246cae63f))
* **chat-v2:** G09-P2 技能晋升成文 + G07 终态 outcome 回流 + 反例候选 ([e4df3f3](https://github.com/helixnow/deep-student/commit/e4df3f365e18b110e77c251fc2604cf795b7ea9f))
* **chat-v2:** G10-P1 iLink 入站统一 TaskCommand——接入同一任务运行系统 ([39ad415](https://github.com/helixnow/deep-student/commit/39ad415be96dce4af41ddb8d94e41c5da417b546))
* **chat-v2:** G11-P1 TaskObjectHandle 血缘补全 + 统一 builder ([1f29dba](https://github.com/helixnow/deep-student/commit/1f29dba4e98319260066ca6af4e5b6046f2305ab))
* **chat-v2:** G11-P2 分页 CorpusManifest——超限附件不再静默截断 ([901edee](https://github.com/helixnow/deep-student/commit/901edee9181b0f674e709c9066bea94aada4526e))
* **chat-v2:** 注册 V20260907/08/09 三个迁移的 MigrationDef ([3444114](https://github.com/helixnow/deep-student/commit/34441141d8d389836b9c4210227df3155903e3f0))
* **chat:** add session goal mode with cross-turn auto-continuation ([5edffa1](https://github.com/helixnow/deep-student/commit/5edffa1a6dd36dfd20bc0e488ec854f62071cf8d))
* **chat:** add snapshot file import export flow ([9c25d7e](https://github.com/helixnow/deep-student/commit/9c25d7e648ef3255dc4bb062959502923f2d83fe))
* **chat:** add snapshot import action to session browser ([9ffbfce](https://github.com/helixnow/deep-student/commit/9ffbfcead61224081e9cd96e6d871d0d4c5fe97b))
* **chat:** add transactional conversation snapshot import ([3ee514d](https://github.com/helixnow/deep-student/commit/3ee514d01e17056cbf5428a18b47109392d67829))
* **chat:** expose conversation snapshot APIs ([91c9222](https://github.com/helixnow/deep-student/commit/91c9222a03f60af427de419d4575c77ef5eb7356))
* **chat:** G07-a 前端收尾——CompletionCard 验收徽章 ([c9e377d](https://github.com/helixnow/deep-student/commit/c9e377d00690846e431947ba9ace8a1805432716))
* **chat:** gate rich renderers by user settings ([4dff7a6](https://github.com/helixnow/deep-student/commit/4dff7a6983ad88760f7ec218311c56cf439529f2))
* **chat:** goal mode frontend — status chip, builtin tools, stream race fix ([a6bca19](https://github.com/helixnow/deep-student/commit/a6bca190cb74f225872a0a69e6a54b02ade1ba8c))
* **chat:** P0 选区即上下文 — selection contextRef 类型 + 四面接入（PDF/消息/导图/笔记） ([cee3fe2](https://github.com/helixnow/deep-student/commit/cee3fe28722f082e7d3e498f1c551aa99d2a0c06))
* **chat:** P1 产物一等公民化 — 会话级 artifact registry + 产物面板 ([32f4eb0](https://github.com/helixnow/deep-student/commit/32f4eb083cab6f4f542b331eddbc1cbb794270ee))
* **chat:** render inline chemical structures ([247103b](https://github.com/helixnow/deep-student/commit/247103b640d0e1611cff2fc2380e0375060db496))
* **chat:** unrestricted host shell tier for danger_full_access ([7191a59](https://github.com/helixnow/deep-student/commit/7191a5910cb41821649380a2991357fb7266d997))
* **chat:** unrestricted tier contracts and race-free preset switching ([03d007c](https://github.com/helixnow/deep-student/commit/03d007cf1bdb92c8a43f6dcab2634ad00acbc895))
* **chatv2:** 压缩落盘即广播 compaction_completed，水位环立即刷新 ([1ff07ca](https://github.com/helixnow/deep-student/commit/1ff07cae79edded9d8aaf645a285bc322bf50e82))
* **chat:** 产物面板与入口视觉收敛——入口对齐顶栏 toolbar 家族并有产物才显示，面板列表去彩色、徽章 token 化、窄容器强制单列 ([2c52346](https://github.com/helixnow/deep-student/commit/2c52346080575c7c6b210ceb47eefb4d25d45e08))
* **chat:** 产物面板收敛为会话底部可折叠产物列表 ([e5221e3](https://github.com/helixnow/deep-student/commit/e5221e33ed4d12c82cbb6fba1d2dc178fd8a716f))
* **chat:** 会话分组支持主题色 ([e774d3d](https://github.com/helixnow/deep-student/commit/e774d3d805fa72f32e3bca1f1f06c2f27b512484))
* **chat:** 侧栏会话筛选菜单（默认隐藏子代理会话）+ 行内指示器与操作簇重叠让位 ([57bf33a](https://github.com/helixnow/deep-student/commit/57bf33a412d592e028ef28ebf317d4ab2be74c70))
* **chat:** 历史消息向上懒加载 UI——顶部横幅/自动触发/重试/exhausted ([dadb7ed](https://github.com/helixnow/deep-student/commit/dadb7edd64e250e50b09f563faf3ae947c2b557c))
* **chat:** 工作区文件分区沉底并默认折叠 ([2589644](https://github.com/helixnow/deep-student/commit/2589644c3baaf852db2b6908ce758c3d140792ab))
* **chat:** 工具轮次默认不限并整体移除 doom loop 机制（长程 agent 支持） ([897411a](https://github.com/helixnow/deep-student/commit/897411afc6bee3b2b074efdeed54f3bb941411ae))
* **chat:** 新增 fsrs_get/update_scheduler_config 闪卡调度设置对话工具 ([c2263a0](https://github.com/helixnow/deep-student/commit/c2263a0bde6ffb88ffd01bb8caf4abf23b898d6b))
* **chat:** 新增 model_profile_add 工具——agent 经逐次审批后可新增模型配置 ([5e8c1cf](https://github.com/helixnow/deep-student/commit/5e8c1cf143d09e9da2e84d8b0028119f3592e672))
* **command-palette:** 容器升级液态玻璃材质——低透明 tint + specular 环，对齐桌面 wb-glass 配方 ([06b8e44](https://github.com/helixnow/deep-student/commit/06b8e44e3551e52063ec7b3cda918306e7644a21))
* connect live demos to question practice and full mindmaps ([addf44a](https://github.com/helixnow/deep-student/commit/addf44ad9b8d5bb3da2a72467b572322e9e514a6))
* **demo:** hero 落地页手机模式——去窗壳全宽自适应移动端演示 ([9ee2dac](https://github.com/helixnow/deep-student/commit/9ee2dac3bc7818bd1da2c613bf20a3aeb420febb))
* **demo:** 手机端分页改 transform 分页器——彻底关闭自由滚动 ([e0b6566](https://github.com/helixnow/deep-student/commit/e0b6566c2fe47abd3ab022f839b8eb7009c48aa7))
* **demo:** 手机端多屏竖直滚动——题辞一屏、演示独占一屏 ([8692b5f](https://github.com/helixnow/deep-student/commit/8692b5fdba4778a874d58905445539e497ffe8cb))
* **demo:** 手机端整屏磁吸滚动（scroll-snap） ([da0fcaf](https://github.com/helixnow/deep-student/commit/da0fcaf9d0a331d0b8959ca4e37d921095a8fac2))
* **demo:** 手机端演示不呼出输入法 + 打字速度 2 倍 ([5e1f267](https://github.com/helixnow/deep-student/commit/5e1f267c9aa57c5c4698993b2bc6f8448fe96c22))
* **demo:** 新增会话④周度学习看板剧本（P1 产物面板 + P3 模板演示） ([1adbb01](https://github.com/helixnow/deep-student/commit/1adbb01cac669b32d2314f9799b98a038a68324b))
* **demo:** 首屏预热演示加载 + 加载占位 ([c59685b](https://github.com/helixnow/deep-student/commit/c59685b98578ebbc627397f22f6971eaab197a93))
* expand live learning demos with follow-ups and materials ([a3d5c68](https://github.com/helixnow/deep-student/commit/a3d5c68b11a148e6f61660e7416b9a209a7159ac))
* **flashcards:** 闪卡传统壳入口、FSRS 调度设置对话工具、跨会话引导与移动端 APKG 导入修复 ([316b7e3](https://github.com/helixnow/deep-student/commit/316b7e39d5d9da805fb3751924f1bf525b00bfa9))
* **flashcards:** 闪卡挂载传统壳——视图/侧边栏/移动启动器/降级映射 ([d693d7e](https://github.com/helixnow/deep-student/commit/d693d7e1ce3ae76ecedd68361c5ad25b5d33db1f))
* **fsrs:** 今日计划与额度外积压/等待学习卡分开呈现（F08） ([7065f6d](https://github.com/helixnow/deep-student/commit/7065f6df708f3b83a2821c2435dbe3b15c7f8d68))
* **fsrs:** 评分现场显示判断标准（F09） ([5bdce04](https://github.com/helixnow/deep-student/commit/5bdce048214b38fbac021dbff6491503a6ecb64d))
* **insight:** 阶段一前端——insights API 层 + 确认两问对话框 + 笔记工作区灵感合集区块 ([ce04988](https://github.com/helixnow/deep-student/commit/ce04988ca4ea88ee98e3bceca122fc966790d9f2))
* **insight:** 阶段一后端——灵感卡五表迁移 + InsightService 采集/确认/纠正/墓碑删除 + VfsResourceType::InsightCard 全链路注册 ([3740b50](https://github.com/helixnow/deep-student/commit/3740b506dea33c0bbcf8767eae37dd212f456932))
* **insight:** 阶段三前端——确认/纠正后触发 insight_run_jobs 巩固 worker ([7348826](https://github.com/helixnow/deep-student/commit/734882623703f4dd173cb49c11355a5f828e24e6))
* **insight:** 阶段三演化——合并提案/原则合成（≥2案例+1反例+条件化）/原则复审 → 灵感演化待办（附件回链，marker 幂等）；修正派生边方向语义 ([5c9492d](https://github.com/helixnow/deep-student/commit/5c9492d64fff84312ade2be88e9a52fc114e67ac))
* **insight:** 阶段三骨干——insight_jobs 队列（lease+dedupe+退避+启动恢复）+ SRS 投影物化（inspiration 回链/修订重生成/墓碑传播） ([4781fef](https://github.com/helixnow/deep-student/commit/4781fef11f2731adfbec35096a426ea8062efd8e))
* **insight:** 阶段二前端——insightRecall 检索块（披露级徽章+点击纠正）+ RetrievalSourceType/Citation 加 insight 源 + [灵感-N] 引用解析 + i18n ([a3568c8](https://github.com/helixnow/deep-student/commit/a3568c8e260a3fda2730f2562180ae81510a39ae))
* **insight:** 阶段二接入——InsightRecallExecutor（范式A+披露过滤出口）+ 被动注入 turn-volatile + [灵感-N] 引用前缀 + 前端工具技能 ([2e9ed99](https://github.com/helixnow/deep-student/commit/2e9ed99122459325b98d8b5c17d5e964e8b4cf95))
* **insight:** 阶段二核心——insight_fts 召回管道 + 披露控制器（四沉默分账）+ mastery_events 加 insight 源 + 幂等事件写入 ([015ee91](https://github.com/helixnow/deep-student/commit/015ee91c9b020b81a8de601c471a0520ba67ee7b))
* **insight:** 阶段四自适应——效用门控校准（三本账）+ 跨簇类比挖掘（关系边固定预算）+ 内化退场降权（0.3 下限） ([7e5cefa](https://github.com/helixnow/deep-student/commit/7e5cefa3eb36fede8035430168ee1e68b52ec19a))
* **llm:** Moonshot/Kimi 工具 schema 按 MFJS 方言规范化 ([9e47974](https://github.com/helixnow/deep-student/commit/9e47974e827757e4276e64c744be4b3eff6a8461))
* **llm:** V4 历史 reasoning 回传按 tools 分流并对齐 max 档官方语义 ([26e91d6](https://github.com/helixnow/deep-student/commit/26e91d6dc7ccdb9c857b6c206a431480e1b05a3c))
* **llm:** 官方 DeepSeek V4 sampling 分档锁定与 top_p/penalty 精细化 ([691dc65](https://github.com/helixnow/deep-student/commit/691dc65590d99cc6258f22389bde06eb7e6baa3b))
* **llm:** 官方 V4 推理强度契约 fail-fast（对齐 DSH UNSUPPORTED_REASONING_EFFORT） ([1082ee1](https://github.com/helixnow/deep-student/commit/1082ee195093d6772c01510120fa75529b15f894))
* **llm:** 引入稳定 LLM 错误码并吸收 DSH 兼容语义（第一批） ([7692408](https://github.com/helixnow/deep-student/commit/769240881a524569e743ebe81e19f0fbca0b5e56))
* **llm:** 支持 DeepSeek V4.1 Flash（deepseek-flash）并对齐官方 Responses 语义 ([3b6b6f5](https://github.com/helixnow/deep-student/commit/3b6b6f5a6718ab055a26ce315e8162e1afd736a2))
* **mcp,qwen:** MCP unrestricted mode and Qwen reasoning controls ([af7f368](https://github.com/helixnow/deep-student/commit/af7f36879cb70fa7571f0a15509333f081522438))
* **memory:** 吸收 Hermes 策略——画像溢出当轮自合并协议 + 记忆内容安全扫描 ([e0cd8bf](https://github.com/helixnow/deep-student/commit/e0cd8bf78eecdeaf9c09e4c156ac800c05b0c6d1))
* **memory:** 打通记忆蒸馏层到原始会话的回溯链路，记忆模式泛化到工程/通用场景 ([a0906b7](https://github.com/helixnow/deep-student/commit/a0906b75b8701522122d35a9b82f20661fe6a7c1))
* **migration:** absorb safe upstream reliability fixes ([1001b14](https://github.com/helixnow/deep-student/commit/1001b14b3d1882475f088b0cddd6768f19fad024))
* **migration:** absorb verified reliability improvements ([3d81791](https://github.com/helixnow/deep-student/commit/3d81791fcce06668b03a45a612a7ef18fbd9022f))
* **migration:** document upstream optimization absorption plan ([ee9024c](https://github.com/helixnow/deep-student/commit/ee9024cf04006cf986252f25525f30f104f343b5))
* **migration:** harden chat overscroll and settings batching ([b9a1622](https://github.com/helixnow/deep-student/commit/b9a1622dedea993fe530be29ab93fa92c77a33f6))
* **notes:** improve editing reliability and add local history ([502a0ce](https://github.com/helixnow/deep-student/commit/502a0ce390bea3236251a4fb41a77586cc43f861))
* **notes:** integrate structured editing and simplify note controls ([fcfdca9](https://github.com/helixnow/deep-student/commit/fcfdca9e75666d497ae3b8d57a05d2eec889149a))
* **notes:** refine block drag feedback ([a8bfd3a](https://github.com/helixnow/deep-student/commit/a8bfd3ab9f3121f74e057e41c3306ae3d71c71e3))
* **notes:** 阅读态隐藏格式条、属性内容身份与工具条减法（C9/C12/B04） ([ee6333f](https://github.com/helixnow/deep-student/commit/ee6333f76f7a2754831d47e3e0ae533c643f78bd))
* **office:** G06-P0 xlsx 编辑强制保真门禁——critical 特征阻断 + 统一交付 ([8decc52](https://github.com/helixnow/deep-student/commit/8decc525fe112aecc8024346cf7f3cc143d879db))
* P2 人机双写 — 笔记 checkpoint 栈化 + 导图建议确认条 + anki 审批 diff + action undo + 变更分段 ([9015be6](https://github.com/helixnow/deep-student/commit/9015be694bae874b96995f6b967330987569d010))
* **pdf:** backfill missing historical previews ([1ea4b89](https://github.com/helixnow/deep-student/commit/1ea4b897def4c402bc1b4b43701155b6453fe162))
* **pdf:** schedule historical preview backfill ([760dd31](https://github.com/helixnow/deep-student/commit/760dd31d99e248e0ada0b084905df7c61ef5e793))
* **prompt-cache:** 工具面首轮定型 + 一次性加载约束，减少中途扩容导致的缓存失效 ([#395](https://github.com/helixnow/deep-student/issues/395)) ([d03e5a8](https://github.com/helixnow/deep-student/commit/d03e5a801b9534d7ab17b0a7cc725ff66ed50057))
* **qbank:** AI question generation v3 — background tasks, dedicated model slot, reference injection modes & chat tools ([#391](https://github.com/helixnow/deep-student/issues/391)) ([6ec3cb1](https://github.com/helixnow/deep-student/commit/6ec3cb161fb93232b5c3ccb7a9b518e71bdb6b4d))
* **qbank:** AI 出题原始返回完整落盘与失败日志取证 ([#407](https://github.com/helixnow/deep-student/issues/407)) ([66f2748](https://github.com/helixnow/deep-student/commit/66f2748208cd2c40d11316c30d9d1618d70e512c))
* **qbank:** image answer upload UI with compression and playback ([0cdad20](https://github.com/helixnow/deep-student/commit/0cdad20121432f2322e6dbb9eb4bd1366348dfde))
* **qbank:** image_answer user_answer envelope contract ([891fdaa](https://github.com/helixnow/deep-student/commit/891fdaaf1972ba82d8988af6361f0d0aef0f08dd))
* **qbank:** multimodal AI grading for image answers ([0c16da1](https://github.com/helixnow/deep-student/commit/0c16da1387fcf3ff8ae9181f38c802c508b59fc6))
* **qbank:** 单题型上限放宽，组卷数字输入不设上限并校验题库余量 ([c35cca3](https://github.com/helixnow/deep-student/commit/c35cca3dd46d84f0be9aa4e344f8eff89b3e77ae))
* **qbank:** 单题型上限放宽与组卷余量校验；填空题改走 AI 评判并回写判定结果 ([7fe0999](https://github.com/helixnow/deep-student/commit/7fe09990b0dbce7da792401d946a774ac03a90b5))
* **quick-assistant:** 原生毛玻璃质感 + 逻辑像素尺寸持久化 ([8ac1ac5](https://github.com/helixnow/deep-student/commit/8ac1ac50c2d1205c557e8c301ba422b908e13e59))
* **qwen:** add xhigh/max thinking-depth presets with error-hint fallback ([#412](https://github.com/helixnow/deep-student/issues/412)) ([1a8297d](https://github.com/helixnow/deep-student/commit/1a8297d5ae0373ee37f25ab4b3095fcc6082b1b0))
* redesign DeepStudent landing page around live demo ([cf76e68](https://github.com/helixnow/deep-student/commit/cf76e68bca3bdc49e601a99edd57cca123bd09b9))
* **settings:** 会话宽度占比滑块——宽屏阅读列按 --chat-thread-ratio 延展（外观设置 + 启动初始化 + 契约测试） ([edaef51](https://github.com/helixnow/deep-student/commit/edaef517befcfaa5ede2269a858c8afe3b4a6f1c))
* **settings:** 供应商模型探测回填上下文窗口/最大输出（对齐 DSH 目录语义） ([ee52761](https://github.com/helixnow/deep-student/commit/ee5276142cb3ea5c57b239d94dff6fe5da40e23e))
* **settings:** 桌面端获取可用模型改回内联卡片，移除 Dialog 形态 ([962807d](https://github.com/helixnow/deep-student/commit/962807d7d0028695598ace0c7d28c1ee5aec189e))
* **settings:** 测试连接复用生产请求管线——结构化 ConnectionTestOutcome + 流式首事件探测 + 失败分类归因 ([cf0a0d3](https://github.com/helixnow/deep-student/commit/cf0a0d352283c3c846342e6bd3bc897961e057f0))
* **settings:** 移动端隐藏学习桌面设置入口 ([b18c958](https://github.com/helixnow/deep-student/commit/b18c958e70afdabf8211fc73cf13660a0d7b5cf9))
* **shell:** Windows PowerShell 5.1 语法三层引导——消除 bash 语法盲试循环 ([b881316](https://github.com/helixnow/deep-student/commit/b881316691282a7abae75a8d6de148774996fa16))
* showcase learning workflows in live demo ([ffe2f67](https://github.com/helixnow/deep-student/commit/ffe2f67f9f1c08aff20de642ffa7ad4fd21e3b02))
* **skills:** P3 产物模板 skill 化（canvas-in-skills） ([73a9d01](https://github.com/helixnow/deep-student/commit/73a9d014857b51716c904088df43a87f999e6de0))
* **sync:** 云存储等待窗口状态透传前端——消除限流/退避期假卡死 ([fbd6cc2](https://github.com/helixnow/deep-student/commit/fbd6cc2f059e714fb000ef2b4e69566d6053368f))
* **sync:** 协作式取消 + WebDAV 传输健壮性 ([818db13](https://github.com/helixnow/deep-student/commit/818db13d4dc87e0875581aefecc92addcd0fd3d5))
* **templates:** confirm schema impact before destructive edits ([1c7b3bd](https://github.com/helixnow/deep-student/commit/1c7b3bd598e1b7990d038a2a99f4f80d5e42344b))
* **workbench:** 液态玻璃整面壁纸复刻折射——WallpaperReplica 基建 + 全桌面玻璃面接入 + 全周 specular 环 ([fbf6c77](https://github.com/helixnow/deep-student/commit/fbf6c771daceb6bc107953950e80955c0e05861e))
* **workspace:** add coding navigation and git tools ([86b4fee](https://github.com/helixnow/deep-student/commit/86b4fee1e302306a1c0cc65c50a05618751a9b6d))
* **workspace:** 新增 workspace_file_edit 局部编辑工具，补齐 coding 能力最关键的'手' ([8fcdf05](https://github.com/helixnow/deep-student/commit/8fcdf05c7285a4be164b853247c5f3e5c9b78953))


### Bug Fixes

* **android:** apk_installer 用全限定 Manager::manage——修复 mobile-slim Android 构建 E0599（trait 未导入） ([412e853](https://github.com/helixnow/deep-student/commit/412e853360b50095315dbf640e711c9432e2c39b))
* **android:** declare permission for in-app APK installation ([4d04653](https://github.com/helixnow/deep-student/commit/4d046534e7f28cf2b3d895103131f75e209af17d))
* **android:** MainActivity.kt doc 注释内 `/*` 触发 Kotlin 嵌套块注释致 EOF 未闭合——改写路径表述 ([6e49d41](https://github.com/helixnow/deep-student/commit/6e49d41065690e6c9ef1a91a895480fe9d5cb74b))
* **anki:** 全局限额按全文等距抽样分配，零额度段标记跳过原因（F14） ([75eaea6](https://github.com/helixnow/deep-student/commit/75eaea650ff9719512afd78f1abac712257f3ff7))
* **anki:** 卡片删除撤销窗口/提交脱离组件生命周期（F19） ([0e7514b](https://github.com/helixnow/deep-student/commit/0e7514ba5d9faff048e5d05d068493ab7cb504d7))
* **anki:** 卡面 iframe 显式主题背景——修复移动端深色全白不可见 ([d1bb509](https://github.com/helixnow/deep-student/commit/d1bb5090ae5f83a3807314c229fd18b6d4751d0d))
* **anki:** 同名 note_type 冲突同步前告警并可见（F18） ([d7aae8b](https://github.com/helixnow/deep-student/commit/d7aae8b3fb2ea3c2840d4ebac1f44fcffbade74f))
* **anki:** 直接导出入口返回并展示媒体完整性报告（F16） ([28884c3](https://github.com/helixnow/deep-student/commit/28884c34bdbffebd389430a445f4a0bb2d00626b))
* **apkg:** 多模板 model id 由 template_id 稳定派生（F21） ([f026deb](https://github.com/helixnow/deep-student/commit/f026debb71a7d3660bc3eedf04385acbabfcd538))
* **attachments:** preserve ready image fallback ([784964f](https://github.com/helixnow/deep-student/commit/784964fb935dfb943db0b3a7a3013bad31e389f3))
* **attachments:** smart default inject modes + auto panel + OCR speedup + runtime multimodal decision ([2d9fa1f](https://github.com/helixnow/deep-student/commit/2d9fa1f84d2b393fa53aa6304b6037250300a6d3))
* **background:** N10 TaskTracker 关闭改为准入关闭，shutdown 先停准入再收敛 ([e931779](https://github.com/helixnow/deep-student/commit/e9317793389d7183e5b69b886c403c46c542ba02))
* **background:** 撤回误入 N10 提交的 insight_run_jobs 注册行 ([d4fbb93](https://github.com/helixnow/deep-student/commit/d4fbb930cd76fb0a089af457167c712d6bb7760f))
* **browser:** 功能开关判定与入口可用性刷新 ([ab2e5e2](https://github.com/helixnow/deep-student/commit/ab2e5e23d054c4bf1a32204fb6d63474cacbbeb5))
* **build:** align Android version baseline ([2da873e](https://github.com/helixnow/deep-student/commit/2da873ecde140181d73999c6325498eeae8711a3))
* **build:** align Android version baseline with v0.9.53 release ([a1eaa24](https://github.com/helixnow/deep-student/commit/a1eaa2425d1c4077bd4d374da961f0641c534710))
* **build:** bump Android baseline to v0.9.54, fix release-please annotation ([a80956f](https://github.com/helixnow/deep-student/commit/a80956fd3ce50fae59a07e5c615b060cf5211997))
* **build:** F1 Android versionCode 锚点固定——摘除基准的 release-please 自动重写 ([6b870f9](https://github.com/helixnow/deep-student/commit/6b870f981f9b467de3fe1612c0083864225688dd))
* **bundle:** discover entry from built module script ([6a010db](https://github.com/helixnow/deep-student/commit/6a010db7dea474076eefc224e64e3f88c066d756))
* **button-audit:** 修复阻塞发版的 tsc 错误——items 数组字面量 union widening 加 as AuditItem[]、SegmentedControl onValueChange 类型适配、补 notes-misc 缺失的 note 字段 ([4c49b58](https://github.com/helixnow/deep-student/commit/4c49b58ece672f3f722bd76e190751aa7c1d47ac))
* **canonical-images:** never send file bytes as image parts (PDF count_token_failed) ([29daf03](https://github.com/helixnow/deep-student/commit/29daf032becbc1112438170bfb198319510eb044))
* **chat_v2:** preflight 暴露不可降级守卫的 Deny 判定 ([25f662a](https://github.com/helixnow/deep-student/commit/25f662ae2ff17555f768f4692d480e3ad4c5a3fe))
* **chat_v2:** 完全信任档 preflight 允许绝对路径 cwd ([690f3e9](https://github.com/helixnow/deep-student/commit/690f3e9c5ce49b7c3f1806bec1fe3c4bb8216932))
* **chat_v2:** 完全信任档审批绑定允许绝对路径 cwd ([32c83d6](https://github.com/helixnow/deep-student/commit/32c83d6e40996e492b5695002de31b3d8a7e6022))
* **chat-v2:** unify academic citation numbering ([bbc26dd](https://github.com/helixnow/deep-student/commit/bbc26dd175ccc4bf1492f7180058eec9c75fbbb4))
* **chat-v2:** 修复 HashMap 序列化序导致的'内容已变'误判——压缩管线范围指纹 + Anki 导出键序比对 ([7f7ebac](https://github.com/helixnow/deep-student/commit/7f7ebac7f8646e45d6b47f137bfeb343e65bb395))
* **chat,sync:** pin chat model per session and fix drift precheck ([#415](https://github.com/helixnow/deep-student/issues/415)) ([15b9043](https://github.com/helixnow/deep-student/commit/15b9043097b99774513383fff51213450f0263d2))
* **chat:** admit packed tools through pipeline ([586cf30](https://github.com/helixnow/deep-student/commit/586cf30eb81444434509251a9b89053da8190f54))
* **chat:** align retired authority and host cwd ([b7d74a5](https://github.com/helixnow/deep-student/commit/b7d74a596885d1351cadf96765eb82270b6d9d6d))
* **chatanki:** statusNotFound 失败信息引导跨会话改用库级工具 ([5eefeba](https://github.com/helixnow/deep-student/commit/5eefeba4214a212bd58b5e0b5990311974d555a7))
* **chat:** enforce snapshot import size limit ([8892af5](https://github.com/helixnow/deep-student/commit/8892af59ad04a1cf3c29ca5ba2a4a93eb610546e))
* **chat:** guard snapshot file import size ([e9b42f9](https://github.com/helixnow/deep-student/commit/e9b42f9325666ee11481c748e09c72f7c7a94aeb))
* **chat:** harden file reads and exports ([603a57e](https://github.com/helixnow/deep-student/commit/603a57e433b9230f2536671a49ae6e23676ec2f2))
* **chat:** isolate stale streams and corrupt history records ([1d2302e](https://github.com/helixnow/deep-student/commit/1d2302e59639e1eb9dc1462e4b310c4384b8dc41))
* **chat:** load token colors with the default code renderer ([135ec11](https://github.com/helixnow/deep-student/commit/135ec1184160ced5b16cf239e2d1b9a27eee67d6))
* **chat:** name worker fallback as an ordinary callback ([6242ba1](https://github.com/helixnow/deep-student/commit/6242ba11e3c82a32ebca4ff0d6c27315b10b849a))
* **chat:** P0 复审修复——workbench 壳 selection 回链 + 死按钮/截断计数/注册契约/demo mock ([729d70f](https://github.com/helixnow/deep-student/commit/729d70fd5922fef3fa3e6adb47e4abbda11fecfa))
* **chat:** P2 复审修复——变更记录接入导图/anki 来源 + 建议回执文案消除双重应用隐患 ([47882ef](https://github.com/helixnow/deep-student/commit/47882ef258fad156dd276104ae2eb619fcdd3f15))
* **chat:** PR [#376](https://github.com/helixnow/deep-student/issues/376) 合并后修复——匿名 Job 防跨执行误杀 + 测试同步 ([1fef7e1](https://github.com/helixnow/deep-student/commit/1fef7e108b975ea75129f46bd96311f02674a442))
* **chat:** preserve position across history windows ([08e21fb](https://github.com/helixnow/deep-student/commit/08e21fb55da968ffd7e09176d7f672893fac08d8))
* **chat:** preserve streaming renderer behavior without remount churn ([0f2ef30](https://github.com/helixnow/deep-student/commit/0f2ef3015f1aa54305d8f567684e9ef2560e008d))
* **chat:** reclaim excess session cache and complete manager events ([46ff59d](https://github.com/helixnow/deep-student/commit/46ff59dfea5aa44b54adf11786be59323e642e87))
* **chat:** register goal commands in permissions manifest ([b13be90](https://github.com/helixnow/deep-student/commit/b13be90fd64d2e83f38f56a6520d0afe45723d08))
* **chat:** repair attachments and Windows shell payloads ([a538280](https://github.com/helixnow/deep-student/commit/a5382801f7976b052dc90428ef0ded381670452f))
* **chat:** reset content selector per session store ([9158659](https://github.com/helixnow/deep-student/commit/9158659dfc30a47a68510a64a59693d276d82a87))
* **chat:** resolve same-name model across vendors by config ID ([#417](https://github.com/helixnow/deep-student/issues/417)) ([471082d](https://github.com/helixnow/deep-student/commit/471082dd259ac30cca259e73103a6ee4737d02cf))
* **chat:** retain lazy highlighting in blocked markdown ([21a37df](https://github.com/helixnow/deep-student/commit/21a37df937edcce1f2d629f7cdd20bb7f86b7b0e))
* **chat:** retry empty model responses ([481c6ef](https://github.com/helixnow/deep-student/commit/481c6efe20d88bc305af9a91ab4bbc04beb6632d))
* **chat:** search hint for unloaded history window + history-window adapter tests ([a61b3bf](https://github.com/helixnow/deep-student/commit/a61b3bf50cf1a1a637aacd9e792fdd6edd7311e8))
* **chat:** serialize batched event delivery and retain per-variant chunks ([02b1521](https://github.com/helixnow/deep-student/commit/02b1521f23f4cf0ae9442ce299cdc69e871ab22c))
* **chat:** serialize history window backfill ([3d3972a](https://github.com/helixnow/deep-student/commit/3d3972aa8aad9ce161a4363d68c3bd9cfe832e87))
* **chat:** tolerate legacy stores without goal fetcher ([74255e9](https://github.com/helixnow/deep-student/commit/74255e9788f059c12b759762e965d334f9ae3485))
* **chat:** tolerate partial staged restore payloads ([34d7216](https://github.com/helixnow/deep-student/commit/34d7216284457d2be5b5164cee583f16fb9c5b42))
* **chat:** use typed snapshot API schemas ([cf7e9d5](https://github.com/helixnow/deep-student/commit/cf7e9d5d9b7ca3ec30c6de5f165f42120ec90180))
* **chatv2:** 压缩会话守卫改 token 体量判定，修复多工具重型会话永不压缩 ([2733db1](https://github.com/helixnow/deep-student/commit/2733db1324910021008aad8452c25198744bfc92))
* **chat:** validate record identifiers during staged restore ([3eb31e1](https://github.com/helixnow/deep-student/commit/3eb31e19acf3ec71061aa8c5e4da5e4fb5efc168))
* **chat:** 二轮深检修复——skeletonRef 活跃性校验 + 建议暂存 TTL + anki diff 前缀归一 ([54abb2f](https://github.com/helixnow/deep-student/commit/54abb2fa71dc0405991fcc8c2e9b24d3cb162e7f))
* **chat:** 产物面板 note/file 详情内联复用 UnifiedAppPanel 预览 ([bb9eb5b](https://github.com/helixnow/deep-student/commit/bb9eb5b61245d3c60fee7175e136de5b8fc49d73))
* **chat:** 划词工具栏交互标记先于按键判断消费——修右键点工具栏后下一次划词不弹出 ([e5ee102](https://github.com/helixnow/deep-student/commit/e5ee10233f5f967bc73759b00692f8dd3134b495))
* **chat:** 制卡事件合并缓冲，修复批量制卡前端 O(N²) 卡顿 ([d5dcc18](https://github.com/helixnow/deep-student/commit/d5dcc186674640ba81a1eb3bdfecad37faca9c81))
* **chat:** 制卡事件合并缓冲，修复批量制卡前端 O(N²) 卡顿 ([5df87c3](https://github.com/helixnow/deep-student/commit/5df87c3fbb53613a23497544ab58f2ce1921f77a))
* **chat:** 子代理 wait=true 同步交付后不再被完成事件二次唤醒 ([10934c2](https://github.com/helixnow/deep-student/commit/10934c21e63769bbc34a7a2a63915d2c06acbf13))
* **chat:** 审批卡技术细节默认折叠——对齐 Claude Code 的极简审批面 ([d7ce14d](https://github.com/helixnow/deep-student/commit/d7ce14def4608ae728988ec9124710323b9a096a))
* **chat:** 审批已决态即点即出队——APPROVAL_RESOLUTION_DISPLAY_MS 1000ms→0 ([dd46b14](https://github.com/helixnow/deep-student/commit/dd46b149b3554962eea8bcf88a100206ee052ae4))
* **chat:** 审批栏卡死——approval_expired 反复弹通知但审批栏不消失 ([dbfc7d0](https://github.com/helixnow/deep-student/commit/dbfc7d0de4e6139e3502246c6846aeecc7562a6a))
* **chat:** 收敛附件上传与共享资源生命周期 ([00ca3c7](https://github.com/helixnow/deep-student/commit/00ca3c7ca1da14d6642d0de13565fe1796ebc03b))
* **chat:** 晚到/重放块按时间戳稳定归位——流式期间乱序块不再沉底 ([3e3a470](https://github.com/helixnow/deep-student/commit/3e3a47087d5cc2b280f3b1d3b4f27df3747b83ba))
* **chat:** 稳定 MessageSearchContext value 引用——修划词工具条弹出瞬间 Markdown 重建导致高亮消失 ([dfb9c84](https://github.com/helixnow/deep-student/commit/dfb9c84586fc59a65b967497ce01cf49138f0b0f))
* **ci:** Android 作业接入 sccache——runner 回收后编译单元不丢 ([05f2a78](https://github.com/helixnow/deep-student/commit/05f2a7804d5c1d30286f292eb75f283c418b637d))
* **ci:** Build Archive 超时 60→90 分钟 ([7e281db](https://github.com/helixnow/deep-student/commit/7e281db505fdcc50cb3854c185aad569130fd3ba))
* **ci:** build MinIO fixtures from verified releases ([516b63f](https://github.com/helixnow/deep-student/commit/516b63f518fac584f061cff8f2c28b021ea62bcf))
* **ci:** cap Android build jobs and expand swap ([bc8546c](https://github.com/helixnow/deep-student/commit/bc8546ce1bf9eb065cef4cfc7b4809acdddcbca8))
* **ci:** cap Linux release build parallelism ([9d0606c](https://github.com/helixnow/deep-student/commit/9d0606cc5f979623df125bda1c45546b5d476600))
* **ci:** Cloud Provider Contract Gate 按 provider 拆 matrix 并行 ([2ef82f6](https://github.com/helixnow/deep-student/commit/2ef82f6dc3630de6c738dd91af6d9f5e20f4a896))
* **ci:** F9 恢复发布级迁移兼容性门禁 ([35e83d7](https://github.com/helixnow/deep-student/commit/35e83d7b1a5ee3c12c2c6c23df11b4399a03a144))
* **ci:** main 基线四项红修复——fmt 债/cooldown 漂移守卫/侧栏源契约/provider 契约矩阵适配 ([8bda386](https://github.com/helixnow/deep-student/commit/8bda386db474b67cdda631993c70fa34a1e4cdb0))
* **ci:** make release builds resumable and resource bounded ([54667f5](https://github.com/helixnow/deep-student/commit/54667f5889b5b8f8a889b40e04d8a7ff8ca68e5d))
* **ci:** preserve Vitest coordinator heap budget ([b377d5f](https://github.com/helixnow/deep-student/commit/b377d5fbb33bc393087d176302272b1f89f9f619))
* **ci:** provide headless runtime and align Rust contracts ([fa096a0](https://github.com/helixnow/deep-student/commit/fa096a07f16371f38d8fc8b304288de7c61f65b9))
* **ci:** Provider Contract 超时 75→90 分钟 ([deff4a3](https://github.com/helixnow/deep-student/commit/deff4a3513721d8840130593c5bfa16b29387b44))
* **ci:** release catch-up 恢复门禁——tag 指向 release 提交的下游合并提交时兼容接受；catch-up 扫描遇到已发布的更新版本即停止（更早未发布 release 视为已被取代，防止坏 release commit 毒化后续每次 push） ([26391fb](https://github.com/helixnow/deep-student/commit/26391fb4ea0c597c1b15183280ee306003aced64))
* **ci:** restore MinIO provider contract fixtures ([7f42397](https://github.com/helixnow/deep-student/commit/7f423977c9e1d03c0694a57aa0cb3b490e8baef1))
* **ci:** reuse existing release PR validation ([916f3eb](https://github.com/helixnow/deep-student/commit/916f3ebd50af9673e47af60f6999d2614b87dd82))
* **ci:** stabilize release migration gate runner ([d4aa0fe](https://github.com/helixnow/deep-student/commit/d4aa0fe82bfffabb28a4bd3565aaa700a0e62db2))
* **ci:** verify Linux development packages after cache restore ([9ff43a5](https://github.com/helixnow/deep-student/commit/9ff43a57b6441ab7e4cbdd514e802c5fae28c89f))
* **ci:** Vitest 长尾 17 文件 160 例全绿 + Migration Gate 钉版 ([3389725](https://github.com/helixnow/deep-student/commit/3389725b2f4a95e7ddc799f3d9a141daf491e9cb))
* **ci:** 修复 main 基线五项红项——lint/迁移锁/测试 mock/样式契约 ([7f8be1d](https://github.com/helixnow/deep-student/commit/7f8be1d8eda1726b3ed6ef3d227527ddcd96abb1))
* **ci:** 修复 Vitest 2/4+3/4 基线——18 例失败全修（118 绿） ([d5c41f1](https://github.com/helixnow/deep-student/commit/d5c41f166c16dc65d69f3475be02bc77ca34555d))
* **ci:** 根治 Android 构建连败与 runner 回收——堆上限/钉版/fmt ([1727aaa](https://github.com/helixnow/deep-student/commit/1727aaa5c3f623db477b5b42ef56e08047416218))
* **ci:** 统一 OOM 缓解——Backend/provider/migration/nightly 补 swap+并行度限制 ([532dc79](https://github.com/helixnow/deep-student/commit/532dc79bea4f33b5cf12a6b88777efea05842fcf))
* **command-palette:** 取消过期聚焦 rAF——Esc 竞态致焦点掉 body；CI 缓存随钉版镜像隔离 ([21adb95](https://github.com/helixnow/deep-student/commit/21adb9539dee0baefd9657deb6590a4f043ac8b1))
* **demo:** 修手机磁吸手感——几何稳定 + 逐屏停驻 ([7f3c5a3](https://github.com/helixnow/deep-student/commit/7f3c5a31add0946a9ef94291baf4dc9a2e7f8381))
* **demo:** 手机端刊头改为随题辞屏滚走，不再遮挡演示区 ([b6ab1bf](https://github.com/helixnow/deep-student/commit/b6ab1bf9d8a97cb554cfd163a75a3f935f36561c))
* **demo:** 手机端整屏分页改 JS 实现——根治回弹与惯性过头 ([55f5348](https://github.com/helixnow/deep-student/commit/55f5348da7b1a386fa121926f50abad0623ad631))
* **demo:** 补 dstu_list mock——修手机端右滑资源库崩溃 ([c8c3f7c](https://github.com/helixnow/deep-student/commit/c8c3f7caade9fee65252fe2b55758d613c0781a9))
* enable question previews and artifact exports in chat ([94724c5](https://github.com/helixnow/deep-student/commit/94724c57b1a98debe1813cd7b6e8be8c0c6d6abf))
* **flashcards:** configure learn-ahead and preserve rating retry payload ([ad47cb1](https://github.com/helixnow/deep-student/commit/ad47cb12804f5beceabe536bf3a2304e72af4810))
* **flashcards:** FSRS 会话代际与撤销恢复 ([dbb88d2](https://github.com/helixnow/deep-student/commit/dbb88d2f30d82884c77687cf3286db8a19814546))
* **flashcards:** isolate AnkiConnect models by template identity ([508e7fe](https://github.com/helixnow/deep-student/commit/508e7fedcf54084ab64df5817b5ff95b5fc5924a))
* **flashcards:** measure active question-to-rating duration ([714ebad](https://github.com/helixnow/deep-student/commit/714ebad816f12efdc4433b70a662e4361795bbe1))
* **flashcards:** preserve imported Cloze note and ordinal identity in APKG ([c78a466](https://github.com/helixnow/deep-student/commit/c78a4664401167887ff8100a6d33b1895afdcd30))
* **flashcards:** render template math and imported cloze fallback ([681e1e1](https://github.com/helixnow/deep-student/commit/681e1e128826ac60a85f6625fef03dda7706e1a9))
* **flashcards:** unify mobile page titles actions and navigation ([#413](https://github.com/helixnow/deep-student/issues/413)) ([7321dfb](https://github.com/helixnow/deep-student/commit/7321dfb207c00fd85e2375cd8b814e6338a01ff9))
* **flashcards:** 移动端导入 APKG 兼容 content:// 虚拟 URI ([e36c846](https://github.com/helixnow/deep-student/commit/e36c8462eaedc1185a56a4c806941964ad65a4b9))
* **fsrs:** leech 自动暂停回写会话并出队（F04） ([aa968e4](https://github.com/helixnow/deep-student/commit/aa968e44adb353d6d5672170d340396527415234))
* **fsrs:** N05 掌握度 outbox 读取失败不再误确认事件 ([f45bf77](https://github.com/helixnow/deep-student/commit/f45bf776a866af91d0229cfec919a0d4b22b9238))
* **fsrs:** preserve learn-ahead setting in config updates ([1452c93](https://github.com/helixnow/deep-student/commit/1452c93aa55800ed39fd73c9ef125e83ab288786))
* **fsrs:** 掌握度排序不越过分钟级到期学习卡（F02） ([1a66bd1](https://github.com/helixnow/deep-student/commit/1a66bd1456454bd82c329466c40bccfb7b538407))
* **fsrs:** 滑动评分动画按本轮作答身份复位（F07） ([f57014c](https://github.com/helixnow/deep-student/commit/f57014c27a57a7df9f6cbd30d844f6b61681593c))
* **fsrs:** 目标保持率配置接入入队/评分/预览/重置（F01） ([ced045e](https://github.com/helixnow/deep-student/commit/ced045eb31f99a6ef84b3e9a640b413d2da8efa4))
* **fsrs:** 评分提交后补偿失败不再回滚命令，重试复用操作 ID（F11） ([f6d5377](https://github.com/helixnow/deep-student/commit/f6d5377cb334b2caeb5615f58dde40eff4c058d8))
* **generative-ui:** Markdown 正文渲染自足（数学、链接与净化） ([7c4d264](https://github.com/helixnow/deep-student/commit/7c4d264aebd30786f17ce96c349c7d5c9bbee2bb))
* **generative-ui:** N09 timeout 移入 rate-limit 内层，超时不再永久占用 in-flight ([7e6d89c](https://github.com/helixnow/deep-student/commit/7e6d89c25b2c6309ad713bd93d713f6bced12855))
* **goal:** F4 续跑改 CAS 认领 + 失败关闭 + pause/clear 取消在飞续跑 ([ec52945](https://github.com/helixnow/deep-student/commit/ec529457c43b99a17155cc9992106285dc754b6d))
* **insight:** CITATION_GUIDE 静态预算 750→780（新增 [灵感-N] 来源类型行，文案精简） ([92e850c](https://github.com/helixnow/deep-student/commit/92e850c8a8cb916eb6410a2a134930d28ea4f125))
* **insight:** 自查修复——计数器与幂等事件联动（重试/变体不重复计数）+ insight_fts UPDATE 触发器收窄（V20260911，计数累加不重建索引）+ 块披露级徽章取真最大值 ([b5d2833](https://github.com/helixnow/deep-student/commit/b5d2833fd03e73dfc6690963a0595f4135ddc3e0))
* isolate DeepSeek harness optimizations by provider ([4a804b5](https://github.com/helixnow/deep-student/commit/4a804b59ca0ecfd5f1cc073922d03b3e5d6a160f))
* **llm:** compaction 健壮性——失败冷却防抖动 + RAW_PROMPT 瞬态重试 + token 估算采样外推 ([4952286](https://github.com/helixnow/deep-student/commit/4952286d64b69b2f207c379c64b48c528cf633c0))
* **llm:** 同步 V4 low/high/max 档与 64K 输出默认的前端镜像 ([d932907](https://github.com/helixnow/deep-student/commit/d93290745c3aa094b5b66e4fedcc20c21c25ae03))
* **mcp:** connection-test failures against strict servers (null experimental, swallowed errors, loopback proxy, SSE task leak) ([9eea047](https://github.com/helixnow/deep-student/commit/9eea047cce74f55238b197e02bc8a5abcf1495d4))
* **mcp:** F5 日志只记元数据——message_loop/notification 不再输出原文 ([dda858b](https://github.com/helixnow/deep-student/commit/dda858bd2d05a0073fdf21dc64c06d7b5fbbee72))
* **mcp:** harden stdio spawn path & self-heal tool injection on send ([1a1661d](https://github.com/helixnow/deep-student/commit/1a1661db62e4078ff9dace8bbc730bd60ee32cc9))
* **mcp:** harden stdio spawn, self-heal tool injection, wire Settings status ([25de0b4](https://github.com/helixnow/deep-student/commit/25de0b4ee3dd14bfc53a0a03b6d6487cce55561d))
* **mcp:** make propose connection tests work against strict servers ([e0e8b58](https://github.com/helixnow/deep-student/commit/e0e8b58f8d035715b09d5b819d1023abc9b0cb11))
* **mcp:** N01 通知分发改 envelope 互斥判别 + 标准方法名兼容映射 ([3e5d839](https://github.com/helixnow/deep-student/commit/3e5d8394a57c9c7c10e4ad9bcd7177e95efc4a04))
* **mcp:** omit JSON-RPC params field when None instead of sending null ([#411](https://github.com/helixnow/deep-student/issues/411)) ([71d22c6](https://github.com/helixnow/deep-student/commit/71d22c6f9a927458112e3e119e02c492bc176338))
* **mcp:** Rust 侧 MCP 协议类型补 camelCase serde rename ([3185361](https://github.com/helixnow/deep-student/commit/3185361c3848153441fe5f69b8283fa291754e54))
* **mcp:** 修复 MCP stdio 全链路四个断点——ping schema/重连不刷新/空缓存TTL/启动竞态清洗 ([16efa10](https://github.com/helixnow/deep-student/commit/16efa10370038190c7c144a2b4eef923df8a2e02))
* **mindmap:** 为文档加载与保存加代际守卫 ([482201b](https://github.com/helixnow/deep-student/commit/482201b2e04b5033118b6881b6ff51457a3a52f9))
* **notes:** improve editor layout and save lifecycle ([def7b32](https://github.com/helixnow/deep-student/commit/def7b32fd786af7e055e07698b9282c9b9729e79))
* **notes:** keep drafts, info-panel tabs and narrow-pane search usable ([3852cdb](https://github.com/helixnow/deep-student/commit/3852cdb80105977a2409f2011565ff53b04fe5c0))
* **notes:** N02 分窗重组保持原文——边界分隔符恒为一个换行 ([0aaa70a](https://github.com/helixnow/deep-student/commit/0aaa70a29dd2bef9a06a8a6cb9ae1f1200652722))
* **notes:** N03 正则替换接入统一输出预算，逐匹配累加提前中止 ([2c2ae03](https://github.com/helixnow/deep-student/commit/2c2ae0384673a80afd6f219d17bdc3680b205a90))
* **notes:** read update state within one transaction snapshot ([d80b89b](https://github.com/helixnow/deep-student/commit/d80b89bb79363bf358f660e1532b5559433d7eb9))
* **notes:** restore the AI review accept path and cover it with real controls ([3701ea9](https://github.com/helixnow/deep-student/commit/3701ea9cf5a2899be35ee36149e120432b5d01f1))
* **notes:** share full-document API and preserve save error and dirty state ([35910a0](https://github.com/helixnow/deep-student/commit/35910a06a9dec683d35b3c629514199f1c73c0d9))
* **notes:** stabilize block handles and mobile title layout ([11f38ab](https://github.com/helixnow/deep-student/commit/11f38ab7670980234a1a2df7cac3386d9cd42467))
* **notes:** 保存与关闭一致性（C1/C2/C3/C15） ([6e70e76](https://github.com/helixnow/deep-student/commit/6e70e7694263cafd42a10cf475852af8ed9738c4))
* **notes:** 元数据 CAS、大纲消歧与局部标签范围（C6/C8/C13/B04） ([7f1de57](https://github.com/helixnow/deep-student/commit/7f1de5779a7393784f7f11978bed13d13b5cfd81))
* **notes:** 导出保存屏障与全文范围提示（C7/C16） ([a530dc4](https://github.com/helixnow/deep-student/commit/a530dc48fcb255aca073d68d7ccf40697373830d))
* **notes:** 强制外部更新与显式保存按视图归属（C4） ([3828baf](https://github.com/helixnow/deep-student/commit/3828baf3b4ccf358a5428e9f1888a81f46d647c3))
* **notes:** 移动端 UX 修复——16px rem 基准、标题层级、触控目标 44px、专注模式规则归位 ([f391bfc](https://github.com/helixnow/deep-student/commit/f391bfc64d72f68ef4b743c5c8070d9e10c4f968))
* **notes:** 笔记异步加载与 AI 编辑代际收敛 ([7eba92e](https://github.com/helixnow/deep-student/commit/7eba92e197e924ccf90d4d1dcf1400883de54341))
* **notes:** 统一改名双链维护、查找面板所有权与输入法守卫（C5/C10/C14） ([4c97052](https://github.com/helixnow/deep-student/commit/4c97052b86aa2ae5a4320da684f7c5d97e44f219))
* **notes:** 补齐标题保存契约并顺序执行关闭保存（C15） ([598486a](https://github.com/helixnow/deep-student/commit/598486a1bc1795e31968e58ba17e8bf48269561b))
* **ocr:** discard cancelled page results before persistence ([f09d2ed](https://github.com/helixnow/deep-student/commit/f09d2edeb5fb4fa925f94f3a9b8bdddc3f8568d2))
* **ocr:** respect native engine preference and isolate SAF staging ([b152cba](https://github.com/helixnow/deep-student/commit/b152cbac2c87a954904c4e34576631446fa5313a))
* **ocr:** settings persistence + assignment consistency + PDF local fallback + 4xx circuit break ([e419cc3](https://github.com/helixnow/deep-student/commit/e419cc37fda114dbcfe069e807751c71e317d5f9))
* **package-manager:** N12 安装子进程改 tokio::process，加总 deadline 与有界输出 ([548f196](https://github.com/helixnow/deep-student/commit/548f19695d44201e0c946a3cd1a48fdff0f02f25))
* **pdf:** expose safe attachment path check ([9b685b2](https://github.com/helixnow/deep-student/commit/9b685b26070723532f6aaa04e483dfaf56a0ddd9))
* **pdf:** unified content classification + readiness-driven inject modes + variant multimodal passthrough ([aaa90fb](https://github.com/helixnow/deep-student/commit/aaa90fbb0347abc5a0da1c7361965bfdac8f31cd))
* **pdf:** upgrade pdfium-render 0.8.37 -&gt; 0.9.4 to fix native crash on concurrent PDF text extraction ([04bb67d](https://github.com/helixnow/deep-student/commit/04bb67de9c84d156a06df1536291c8c76ca6b45d))
* **pdf:** 批注保存串行化并加固加载生命周期 ([a31b363](https://github.com/helixnow/deep-student/commit/a31b3635af10e1c12a2c6fcda6ff08b4324ffb8f))
* **pomodoro:** N11 已失败的会话记录不再从 flush 边界消失 ([ef78b96](https://github.com/helixnow/deep-student/commit/ef78b962a3c60fce59a02784d9c6dee8c17163c5))
* **practice:** 统一练习/考试请求与计时器归属 ([18c48f6](https://github.com/helixnow/deep-student/commit/18c48f630e25cbf4fa3724d8f735c81576138411))
* **qbank:** include structured_data in AI grading prompt ([dcd4daa](https://github.com/helixnow/deep-student/commit/dcd4daa3f2ae4c58f7d34dea39a4ceab42ab23d2))
* **qbank:** N13 不完整评判流只落草稿，正文示例标签不再被当最终成绩 ([61d6376](https://github.com/helixnow/deep-student/commit/61d6376b894688ab95e536bd397d8e0e6b6a2ff5))
* **qbank:** preserve GIF MIME and resolve synced answer image aliases ([6a17c8d](https://github.com/helixnow/deep-student/commit/6a17c8d3b4bd12a79df02410ea267a89745faadb))
* **qbank:** preserve image answer ownership and review ([fcc1c93](https://github.com/helixnow/deep-student/commit/fcc1c93fa6c17dd9de276f997b8f16a9f22a61e0))
* **qbank:** SSE 缓冲 O(n²)→O(n) 线性扫描，修复安卓大题量出题流中断 ([b1397c5](https://github.com/helixnow/deep-student/commit/b1397c5d615683539d0e7e492678901326aeaed8))
* **qbank:** 填空题改走 AI 评判，判定结果回写练习进度与模拟考成绩 ([6dbf42c](https://github.com/helixnow/deep-student/commit/6dbf42cf9486c9a7fb117e4228328a126b87e1f2))
* **qbank:** 组卷余量校验在统计失败时跳过而非误报库存不足 ([19ff679](https://github.com/helixnow/deep-student/commit/19ff67987dc6273254ac24fb5223d16be816a700))
* **qbank:** 聊天管线补注 QuestionBankService 并让 card_id 查询兼容 question id ([3312364](https://github.com/helixnow/deep-student/commit/3312364975f74d83720a7d2326c96cc0d8b6272f))
* **rag:** repair dangling embedding defaults ([8143ad7](https://github.com/helixnow/deep-student/commit/8143ad77ebf044aa791c65c02caf780a19729e8f))
* **rag:** 多模态嵌入默认设置悬空引用自愈（VL 轨道同款修复） ([077d494](https://github.com/helixnow/deep-student/commit/077d49406d60cc9194ca8ecac42734e6474dcb1c))
* **rag:** 嵌入默认设置悬空引用自愈，修复全量索引「找不到嵌入模型配置」 ([9277368](https://github.com/helixnow/deep-student/commit/9277368e9506e2f3867d2bbd905442029866016a))
* **release:** clear SAF and sync validation blockers ([#428](https://github.com/helixnow/deep-student/issues/428)) ([cc36263](https://github.com/helixnow/deep-student/commit/cc3626356bf48ec82716f1d620f53c186cbbda2a))
* **release:** default desktop rebuilds to unsigned platform bundles ([ccd614f](https://github.com/helixnow/deep-student/commit/ccd614fb8a527513d16f325ea6539b464f24137d))
* **release:** refresh dependency license metadata ([4d41851](https://github.com/helixnow/deep-student/commit/4d41851d03467a8e5a753081f09548833388fff9))
* **release:** release-please extra-files 纳入 Cargo.lock 根版本——根治 --locked 构建门禁追逐移动版本的死循环 ([797abf2](https://github.com/helixnow/deep-student/commit/797abf2474a3bc10fccc245621c90fa8dda25f72))
* **release:** 重新生成第三方声明——同步 Cargo.lock 根版本后的 SHA256，修复 --locked 构建门禁 ([1eb646f](https://github.com/helixnow/deep-student/commit/1eb646f0d7a8517a5c9b161de22fd26e6595d736))
* **security:** F7+F8 资源硬上限与 token 保守估算 ([6e98f21](https://github.com/helixnow/deep-student/commit/6e98f21903f1686a193f7ead180f386476dc53a5))
* **settings:** N06 批量写入回滚基线严格化 + 删除失败可见 ([f03a40f](https://github.com/helixnow/deep-student/commit/f03a40f0701fead66b4cdb3a28795366c77fe7ee))
* **settings:** restore unified API imports ([3617a71](https://github.com/helixnow/deep-student/commit/3617a718f9885764a1ada3d2b80595f4be6d35d4))
* **settings:** rollback partial batch writes ([88a48fb](https://github.com/helixnow/deep-student/commit/88a48fb677dd389251792d17701402db7cece903))
* **settings:** wire MCP connection status into editor section ([f8ebb63](https://github.com/helixnow/deep-student/commit/f8ebb63ec18f433812c0aaacdbe9db24f3aaaf69))
* **shell:** improve Windows shell fallback diagnostics ([d22e345](https://github.com/helixnow/deep-student/commit/d22e345b2144e34ec9045590e8deee15d1c4f2d0))
* **shell:** mac/Linux 完全信任通道不再施加 RLIMIT 资源上限 ([0c4abe3](https://github.com/helixnow/deep-student/commit/0c4abe35cdd47b03bdb0f8acdbb4ee939c29908e))
* **shortcuts:** 导航快捷键尊重输入态与 IME ([f7f6968](https://github.com/helixnow/deep-student/commit/f7f6968030d8bf966ce5118a61daeba533d6c6bd))
* **skills:** P3 复审修复——skeletonRef live 路径回显 + 通知 i18n 化 + 白名单三方契约测试 ([b03c1b6](https://github.com/helixnow/deep-student/commit/b03c1b6bc6c0f5d5ba15edd07bd6e9ad1991127b))
* **startup:** keep React runtime in one production chunk ([c7248a2](https://github.com/helixnow/deep-student/commit/c7248a222191eef28b5f175d4a7217289594240e))
* **startup:** raise recovery preflight timeout 15s -&gt; 120s ([b3d1652](https://github.com/helixnow/deep-student/commit/b3d16528266a4620bdd54c75fb09b0d058870be7))
* **startup:** retry recovery preflight to survive Android IPC race ([92ae5f1](https://github.com/helixnow/deep-student/commit/92ae5f166a85f6fa0bb5767a062bd667045ee86d))
* **startup:** retry recovery preflight to survive Android IPC race ([f623869](https://github.com/helixnow/deep-student/commit/f623869b7d6f18723275de62f489a5537773a260))
* **startup:** setup 完成闸门修复启动预检误报 blocked ([4ccd2c1](https://github.com/helixnow/deep-student/commit/4ccd2c121a58c505604864c76ad3718b3fdbf13b))
* **stats:** 留存按每卡每日首次复习计，参数面板改为记忆状态分布（F10） ([bb418a4](https://github.com/helixnow/deep-student/commit/bb418a4c8140920921d7dd6114db23a226c685f5))
* **sync:** add provider-aware WebDAV request limiter ([ba3de70](https://github.com/helixnow/deep-student/commit/ba3de709ad44c06913e5693cb82dd5d9a05cff49))
* **sync:** classify local state and preserve deletion timestamps ([23abd4b](https://github.com/helixnow/deep-student/commit/23abd4b26df792e1f9f9ce52a5b1a2bb5de19856))
* **sync:** classify the new note tables and stop replay echoes ([977f2c9](https://github.com/helixnow/deep-student/commit/977f2c979ac849648dc5f25add07e8d1519a3058))
* **sync:** fence in-flight encryption marker claims ([753e63f](https://github.com/helixnow/deep-student/commit/753e63f4072a48de54fd7cb64e181f50355b075d))
* **sync:** 资产墓碑回收不再被 conflict 副本复活 ([ba694a1](https://github.com/helixnow/deep-student/commit/ba694a16c323ad7c41fde5f7db396b2088a099db))
* **tools:** preserve cancelled pack results in headless runs ([32cea33](https://github.com/helixnow/deep-student/commit/32cea33b1e933e9f2acae15ca0cfb04b7021bebe))
* **tools:** resolve file IDs through reference resources for document tools ([7645016](https://github.com/helixnow/deep-student/commit/764501658436d22844ce354ac957fcf054734b83))
* **ui:** align flashcards with mobile visual system ([6076859](https://github.com/helixnow/deep-student/commit/60768595753063815fdcf0e19d43682d8a1e604e))
* **ui:** harden shared dialogs, focus traps and reader targeting ([94b1629](https://github.com/helixnow/deep-student/commit/94b1629f6093cf7e0723b3ccae9c80be0ab750ef))
* **ui:** make focus traps layout-agnostic and stop losing trailing placeholders ([596b86a](https://github.com/helixnow/deep-student/commit/596b86abc725edef5420e92a4ce704ea99435965))
* **ui:** use shared mobile scrollbar styling ([db661be](https://github.com/helixnow/deep-student/commit/db661beb0a2a980de8e848a23215ed7527f6f069))
* **vfs:** image-only PDF mode no longer warns "text extraction failed" ([c80b5ab](https://github.com/helixnow/deep-student/commit/c80b5abbb9ff7964e381819c7ce399a6b804727a))
* **vfs:** N04 孤儿 blob 补偿与并发同 hash 复用串行，关闭活引用误删窗口 ([16d81fe](https://github.com/helixnow/deep-student/commit/16d81feab1161b0c839ab62da053a3976b959079))
* **vfs:** N07 reset_unit_index 用 IMMEDIATE 事务保证原子状态转换 ([d9b0f13](https://github.com/helixnow/deep-student/commit/d9b0f13d10fe8e2d13788b895a9c363ee2fe1ada))
* **vfs:** reserve upload write locks before snapshot reads ([95a0094](https://github.com/helixnow/deep-student/commit/95a009417401d6fe86b196408efb5023eaa8d48c))
* **voice:** N08 权限等待期间可取消——启动代际 + 迟到资源立即释放 ([31eac40](https://github.com/helixnow/deep-student/commit/31eac406016fa2ebf30bdd70e7f064b691a9fa37))
* **wallpaper,backup,cache:** 自定义壁纸白屏、跨设备备份导入、Prompt 缓存诊断日志 ([#393](https://github.com/helixnow/deep-student/issues/393)) ([086900c](https://github.com/helixnow/deep-student/commit/086900c23a99983f3a3b854728b13cf02a325104))
* **webdav:** share provider request limiter across sessions ([1bd83dd](https://github.com/helixnow/deep-student/commit/1bd83dda3ec5c0ee73b7fa1d98dc496edbfbb271))
* **windows:** F6 direct-shell 挂起创建——先绑定 Job 再恢复主线程 ([d65ad36](https://github.com/helixnow/deep-student/commit/d65ad36c85a3cd621d70057a66258f0235bbfad6))
* **workbench:** N14 仲裁 abort 改为吸收态，暂停超时不再丢失中止决定 ([273cc1f](https://github.com/helixnow/deep-student/commit/273cc1fa9c9d92826fddcfb10b0ac05dd0d4c15a))
* **workbench:** remove impossible closed-phase comparison ([0ef3d3d](https://github.com/helixnow/deep-student/commit/0ef3d3deed8791bc07c36b3420e28067d2c84775))
* 修复 v0.9.61 交互测试确认的产品问题 ([3df6f88](https://github.com/helixnow/deep-student/commit/3df6f8878e95ed5187f24a6baa900f7c9cfe1763))


### Performance Improvements

* **android:** wake SAF permission queue on demand ([6975f3c](https://github.com/helixnow/deep-student/commit/6975f3c91968c0464ae5f8ea17fdd2477aa39eef))
* **backend:** cap temp_sessions memory and move document parsing off the async executor ([dbf87fb](https://github.com/helixnow/deep-student/commit/dbf87fb55ed4eaf21602ee8a15875018d108207a))
* **chat:** append variant text snapshots incrementally ([2860886](https://github.com/helixnow/deep-student/commit/2860886ed66c0c6d612d9ddb8951ed7370a7412d))
* **chat:** avoid retaining chat state in chunk buffering ([ed1d037](https://github.com/helixnow/deep-student/commit/ed1d037dec52c59783e581d2324f1c8252b26691))
* **chat:** batch streaming content/thinking chunks at the IPC boundary ([61c71ab](https://github.com/helixnow/deep-student/commit/61c71abc0e14fb01a797b59aec2e14f1b88718e4))
* **chat:** block-level render skip, content-size admission, windowed history backfill ([9cbabe7](https://github.com/helixnow/deep-student/commit/9cbabe709e0fd33e5f034908bb9189603c2b2b4b))
* **chat:** cache search in a worker and suspend hidden session rendering ([05bae31](https://github.com/helixnow/deep-student/commit/05bae311c875c9faf4c0094eba7afdd1ff9f80ba))
* **chat:** coalesce search work and suspend hidden indexing ([1105518](https://github.com/helixnow/deep-student/commit/110551824a4b8a0ec9df899f0da302cb0baa142c))
* **chat:** cut long-session streaming costs to O(active message) ([55a6d74](https://github.com/helixnow/deep-student/commit/55a6d747f5e89cf5c6e4347ca607351cfdbfa16f))
* **chat:** defer hidden search highlights and image previews ([72e62ee](https://github.com/helixnow/deep-student/commit/72e62ee64255388e5a43a6018abe0d6493292958))
* **chat:** eliminate streaming jank and reduce memory footprint ([ecaed01](https://github.com/helixnow/deep-student/commit/ecaed019921ec6ec122c629ef6cebbf66d81d980))
* **chat:** F3 anki 卡片判重改 ID 索引——合并窗口内近线性 ([acad207](https://github.com/helixnow/deep-student/commit/acad2078ba20dfa5822b0c8d4143cd29c376a55e))
* **chat:** harden long-context rendering and history windows ([8daed54](https://github.com/helixnow/deep-student/commit/8daed545220b0c88fd22e495b25d34f9dea74c52))
* **chat:** make streaming caches session-safe ([33c76e7](https://github.com/helixnow/deep-student/commit/33c76e71f447b29fdadd1c77210e8e693e151ff6))
* **chat:** replace 1s polling hooks with event-driven sync; gate stream-complete token log ([cbddba4](https://github.com/helixnow/deep-student/commit/cbddba41bc71f2f971daed0a503864e45e88019e))
* **chat:** slow streaming store updates to 120ms and defer flowtoken animation until stream end ([03bc72d](https://github.com/helixnow/deep-student/commit/03bc72d0bcec6e5f9a731202917fdde4b5ea1643))
* **chat:** stabilize Markdown renderers and narrow task subscriptions ([30a41b3](https://github.com/helixnow/deep-student/commit/30a41b38a16e3aaf7622e27795189fd2a0531819))
* **chat:** subscribe MessageItem to segment-structure fingerprint, not block identity ([dc7f0a3](https://github.com/helixnow/deep-student/commit/dc7f0a3d77f3787850c335744372e66cf0570a04))
* **chat:** window history before hydration and persist dirty blocks only ([a49e19c](https://github.com/helixnow/deep-student/commit/a49e19ce38ac22878d7142993449397783ec358f))
* **debug:** collect detailed tool diagnostics only when enabled ([7e32e6b](https://github.com/helixnow/deep-student/commit/7e32e6bed132baa54c7c47ba4bdb80c796fae92d))
* **frontend:** defer FlowToken code rendering dependencies ([fd87fed](https://github.com/helixnow/deep-student/commit/fd87fed3f71d504c6d78b668cda91a6fc3293066))
* **governance:** remove backup waits and bound ZIP and JSON overhead ([fb23000](https://github.com/helixnow/deep-student/commit/fb23000d05fa78f974ac7beb97bdc8a1f2985be4))
* **media:** bound OCR and image work without holding database leases ([1dbd8fb](https://github.com/helixnow/deep-student/commit/1dbd8fbcc2ae709bee4e38974159f2a19284ad83))
* **ocr:** share media limits with indexing fallback and release database leases ([8c8714a](https://github.com/helixnow/deep-student/commit/8c8714ab7b429ef70315d11824be43a349484812))
* **retrieval:** filter lexical scope before limiting and gate unavailable vectors ([728c209](https://github.com/helixnow/deep-student/commit/728c209ac1bd18835073c7164406ee7fd055fe57))
* **startup:** isolate editor state and generative schemas from heavy UI ([b026808](https://github.com/helixnow/deep-student/commit/b026808aa6903768416e335b7105063e709370b1))
* **sync:** move file encryption work off async runtime ([cca2e6e](https://github.com/helixnow/deep-student/commit/cca2e6e30ac1a4a72699ddf501d56ac94790ffb0))
* **vfs:** offload todo and pomodoro database commands ([63998e8](https://github.com/helixnow/deep-student/commit/63998e811be01b9f1d1a0617d50397a41537599d))
* **vfs:** offload uploads and reuse index connection ([0506ad0](https://github.com/helixnow/deep-student/commit/0506ad07c023bf2ac15e40b4a85be9923edb4756))


### Reverts

* **notes:** 属性大纲仍使用可见窗口内容（尊重既有 windowing 契约） ([c00f6c1](https://github.com/helixnow/deep-student/commit/c00f6c1099d62fab20a479492848804e7cb3e27c))

## [0.9.72](https://github.com/helixnow/deep-student/compare/v0.9.71...v0.9.72) (2026-09-27)

### Features

* **qbank:** support handwritten image answers for subjective and fill-blank questions, multimodal grading, and image review ([#425](https://github.com/helixnow/deep-student/pull/425), thanks @qeryuo112).

### Performance Improvements

* **chat:** hydrate bounded history windows, persist dirty blocks, stabilize Markdown components, and narrow task subscriptions while retaining upstream long-context optimizations.
* **search:** coalesce streaming search to one in-flight Worker request and suspend indexing for hidden sessions.
* **startup:** defer heavy editor, chart and FlowToken dependencies; correct built-entry bundle inspection.
* **backend:** move synchronous uploads, document processing, Todo/Pomodoro queries and encryption work off asynchronous executors, and reduce redundant database leases.
* **media:** share OCR concurrency limits with indexing fallback and avoid holding database connections during expensive image work.
* **governance:** reduce backup waits and ZIP/JSON overhead; filter lexical retrieval scope before limiting results.

### Bug Fixes

* **chat:** retain syntax highlighting, token colors, and copying in the default block-based streaming renderer without eagerly loading highlighting code.
* **qbank:** keep uploads bound to their question, preserve fill-blank text alongside images, reject unsupported image formats before saving, and restore submitted image review.
* **qbank:** preserve GIF MIME when sending images to models and resolve synchronized attachment aliases for preview and grading.
* **ocr:** honor the system OCR disable setting and discard late results from cancelled page processing.
* **vfs:** reserve ordinary upload write transactions before snapshot reads and reuse existing index connections.
* **android:** wake SAF permission processing on demand and isolate concurrent URI staging files.

### Known Issues

* Mixed attachment/file uploads can still encounter the existing write-lock/partial-preview issue; cancelled media tasks can resume after restart; Android query planning after restoring desktop index profiles needs further correction. See the [three open P1 findings](docs/dev/perf-audit-2026-09/ROUND3-REVIEW-2026-09-27.md).
* Windows/Android device performance has not been re-measured; scoped validation and observed latency limits are documented in the [P2 verification report](docs/dev/perf-audit-2026-09/P2-IMPLEMENTATION-2026-09-27.md).

## [0.9.71](https://github.com/helixnow/deep-student/compare/v0.9.70...v0.9.71) (2026-09-26)


### Bug Fixes

* **chat:** preserve position across history windows ([08e21fb](https://github.com/helixnow/deep-student/commit/08e21fb55da968ffd7e09176d7f672893fac08d8))
* **chat:** reset content selector per session store ([9158659](https://github.com/helixnow/deep-student/commit/9158659dfc30a47a68510a64a59693d276d82a87))
* **chat:** search hint for unloaded history window + history-window adapter tests ([a61b3bf](https://github.com/helixnow/deep-student/commit/a61b3bf50cf1a1a637aacd9e792fdd6edd7311e8))
* **chat:** serialize history window backfill ([3d3972a](https://github.com/helixnow/deep-student/commit/3d3972aa8aad9ce161a4363d68c3bd9cfe832e87))


### Performance Improvements

* **chat:** block-level render skip, content-size admission, windowed history backfill ([9cbabe7](https://github.com/helixnow/deep-student/commit/9cbabe709e0fd33e5f034908bb9189603c2b2b4b))
* **chat:** cut long-session streaming costs to O(active message) ([55a6d74](https://github.com/helixnow/deep-student/commit/55a6d747f5e89cf5c6e4347ca607351cfdbfa16f))
* **chat:** harden long-context rendering and history windows ([8daed54](https://github.com/helixnow/deep-student/commit/8daed545220b0c88fd22e495b25d34f9dea74c52))
* **chat:** make streaming caches session-safe ([33c76e7](https://github.com/helixnow/deep-student/commit/33c76e71f447b29fdadd1c77210e8e693e151ff6))

## [0.9.70](https://github.com/helixnow/deep-student/compare/v0.9.69...v0.9.70) (2026-09-25)


### Bug Fixes

* **chat:** preserve streaming renderer behavior without remount churn ([0f2ef30](https://github.com/helixnow/deep-student/commit/0f2ef3015f1aa54305d8f567684e9ef2560e008d))
* **chat:** reclaim excess session cache and complete manager events ([46ff59d](https://github.com/helixnow/deep-student/commit/46ff59dfea5aa44b54adf11786be59323e642e87))
* **chat:** serialize batched event delivery and retain per-variant chunks ([02b1521](https://github.com/helixnow/deep-student/commit/02b1521f23f4cf0ae9442ce299cdc69e871ab22c))
* **ci:** build MinIO fixtures from verified releases ([516b63f](https://github.com/helixnow/deep-student/commit/516b63f518fac584f061cff8f2c28b021ea62bcf))
* **ci:** restore MinIO provider contract fixtures ([7f42397](https://github.com/helixnow/deep-student/commit/7f423977c9e1d03c0694a57aa0cb3b490e8baef1))


### Performance Improvements

* **backend:** cap temp_sessions memory and move document parsing off the async executor ([dbf87fb](https://github.com/helixnow/deep-student/commit/dbf87fb55ed4eaf21602ee8a15875018d108207a))
* **chat:** append variant text snapshots incrementally ([2860886](https://github.com/helixnow/deep-student/commit/2860886ed66c0c6d612d9ddb8951ed7370a7412d))
* **chat:** avoid retaining chat state in chunk buffering ([ed1d037](https://github.com/helixnow/deep-student/commit/ed1d037dec52c59783e581d2324f1c8252b26691))
* **chat:** batch streaming content/thinking chunks at the IPC boundary ([61c71ab](https://github.com/helixnow/deep-student/commit/61c71abc0e14fb01a797b59aec2e14f1b88718e4))
* **chat:** eliminate streaming jank and reduce memory footprint ([ecaed01](https://github.com/helixnow/deep-student/commit/ecaed019921ec6ec122c629ef6cebbf66d81d980))
* **chat:** replace 1s polling hooks with event-driven sync; gate stream-complete token log ([cbddba4](https://github.com/helixnow/deep-student/commit/cbddba41bc71f2f971daed0a503864e45e88019e))
* **chat:** slow streaming store updates to 120ms and defer flowtoken animation until stream end ([03bc72d](https://github.com/helixnow/deep-student/commit/03bc72d0bcec6e5f9a731202917fdde4b5ea1643))
* **chat:** subscribe MessageItem to segment-structure fingerprint, not block identity ([dc7f0a3](https://github.com/helixnow/deep-student/commit/dc7f0a3d77f3787850c335744372e66cf0570a04))

## [0.9.69](https://github.com/helixnow/deep-student/compare/v0.9.68...v0.9.69) (2026-09-24)


### Bug Fixes

* **chat:** resolve same-name model across vendors by config ID ([#417](https://github.com/helixnow/deep-student/issues/417)) ([471082d](https://github.com/helixnow/deep-student/commit/471082dd259ac30cca259e73103a6ee4737d02cf))

## [0.9.68](https://github.com/helixnow/deep-student/compare/v0.9.67...v0.9.68) (2026-09-23)


### Bug Fixes

* **chat,sync:** pin chat model per session and fix drift precheck ([#415](https://github.com/helixnow/deep-student/issues/415)) ([15b9043](https://github.com/helixnow/deep-student/commit/15b9043097b99774513383fff51213450f0263d2))

## [0.9.67](https://github.com/helixnow/deep-student/compare/v0.9.66...v0.9.67) (2026-09-23)


### Features

* **qbank:** AI 出题原始返回完整落盘与失败日志取证 ([#407](https://github.com/helixnow/deep-student/issues/407)) ([66f2748](https://github.com/helixnow/deep-student/commit/66f2748208cd2c40d11316c30d9d1618d70e512c))
* **qwen:** add xhigh/max thinking-depth presets with error-hint fallback ([#412](https://github.com/helixnow/deep-student/issues/412)) ([1a8297d](https://github.com/helixnow/deep-student/commit/1a8297d5ae0373ee37f25ab4b3095fcc6082b1b0))


### Bug Fixes

* **flashcards:** unify mobile page titles actions and navigation ([#413](https://github.com/helixnow/deep-student/issues/413)) ([7321dfb](https://github.com/helixnow/deep-student/commit/7321dfb207c00fd85e2375cd8b814e6338a01ff9))
* **mcp:** omit JSON-RPC params field when None instead of sending null ([#411](https://github.com/helixnow/deep-student/issues/411)) ([71d22c6](https://github.com/helixnow/deep-student/commit/71d22c6f9a927458112e3e119e02c492bc176338))

## [0.9.66](https://github.com/helixnow/deep-student/compare/v0.9.65...v0.9.66) (2026-09-23)


### Features

* **mcp,qwen:** MCP unrestricted mode and Qwen reasoning controls ([af7f368](https://github.com/helixnow/deep-student/commit/af7f36879cb70fa7571f0a15509333f081522438))


### Bug Fixes

* **ui:** align flashcards with mobile visual system ([6076859](https://github.com/helixnow/deep-student/commit/60768595753063815fdcf0e19d43682d8a1e604e))
* **ui:** use shared mobile scrollbar styling ([db661be](https://github.com/helixnow/deep-student/commit/db661beb0a2a980de8e848a23215ed7527f6f069))

## [0.9.65](https://github.com/helixnow/deep-student/compare/v0.9.64...v0.9.65) (2026-09-22)


### Features

* **notes:** improve editing reliability and add local history ([502a0ce](https://github.com/helixnow/deep-student/commit/502a0ce390bea3236251a4fb41a77586cc43f861))
* **notes:** integrate structured editing and simplify note controls ([fcfdca9](https://github.com/helixnow/deep-student/commit/fcfdca9e75666d497ae3b8d57a05d2eec889149a))


### Bug Fixes

* **notes:** keep drafts, info-panel tabs and narrow-pane search usable ([3852cdb](https://github.com/helixnow/deep-student/commit/3852cdb80105977a2409f2011565ff53b04fe5c0))
* **notes:** restore the AI review accept path and cover it with real controls ([3701ea9](https://github.com/helixnow/deep-student/commit/3701ea9cf5a2899be35ee36149e120432b5d01f1))
* **sync:** classify the new note tables and stop replay echoes ([977f2c9](https://github.com/helixnow/deep-student/commit/977f2c979ac849648dc5f25add07e8d1519a3058))
* **ui:** harden shared dialogs, focus traps and reader targeting ([94b1629](https://github.com/helixnow/deep-student/commit/94b1629f6093cf7e0723b3ccae9c80be0ab750ef))
* **ui:** make focus traps layout-agnostic and stop losing trailing placeholders ([596b86a](https://github.com/helixnow/deep-student/commit/596b86abc725edef5420e92a4ce704ea99435965))

## [0.9.64](https://github.com/helixnow/deep-student/compare/v0.9.63...v0.9.64) (2026-09-21)


### Bug Fixes

* **android:** declare permission for in-app APK installation ([4d04653](https://github.com/helixnow/deep-student/commit/4d046534e7f28cf2b3d895103131f75e209af17d))
* **startup:** keep React runtime in one production chunk ([c7248a2](https://github.com/helixnow/deep-student/commit/c7248a222191eef28b5f175d4a7217289594240e))

## [0.9.63](https://github.com/helixnow/deep-student/compare/v0.9.62...v0.9.63) (2026-09-20)


### Bug Fixes

* **ci:** make release builds resumable and resource bounded ([54667f5](https://github.com/helixnow/deep-student/commit/54667f5889b5b8f8a889b40e04d8a7ff8ca68e5d))
* **ci:** preserve Vitest coordinator heap budget ([b377d5f](https://github.com/helixnow/deep-student/commit/b377d5fbb33bc393087d176302272b1f89f9f619))
* **ci:** provide headless runtime and align Rust contracts ([fa096a0](https://github.com/helixnow/deep-student/commit/fa096a07f16371f38d8fc8b304288de7c61f65b9))
* **ci:** reuse existing release PR validation ([916f3eb](https://github.com/helixnow/deep-student/commit/916f3ebd50af9673e47af60f6999d2614b87dd82))
* **notes:** read update state within one transaction snapshot ([d80b89b](https://github.com/helixnow/deep-student/commit/d80b89bb79363bf358f660e1532b5559433d7eb9))
* **sync:** classify local state and preserve deletion timestamps ([23abd4b](https://github.com/helixnow/deep-student/commit/23abd4b26df792e1f9f9ce52a5b1a2bb5de19856))
* **sync:** fence in-flight encryption marker claims ([753e63f](https://github.com/helixnow/deep-student/commit/753e63f4072a48de54fd7cb64e181f50355b075d))
* **tools:** preserve cancelled pack results in headless runs ([32cea33](https://github.com/helixnow/deep-student/commit/32cea33b1e933e9f2acae15ca0cfb04b7021bebe))

## [0.9.62](https://github.com/helixnow/deep-student/compare/v0.9.61...v0.9.62) (2026-09-17)


### Features

* **fsrs:** 今日计划与额度外积压/等待学习卡分开呈现（F08） ([7065f6d](https://github.com/helixnow/deep-student/commit/7065f6df708f3b83a2821c2435dbe3b15c7f8d68))
* **fsrs:** 评分现场显示判断标准（F09） ([5bdce04](https://github.com/helixnow/deep-student/commit/5bdce048214b38fbac021dbff6491503a6ecb64d))
* **notes:** 阅读态隐藏格式条、属性内容身份与工具条减法（C9/C12/B04） ([ee6333f](https://github.com/helixnow/deep-student/commit/ee6333f76f7a2754831d47e3e0ae533c643f78bd))
* **templates:** confirm schema impact before destructive edits ([1c7b3bd](https://github.com/helixnow/deep-student/commit/1c7b3bd598e1b7990d038a2a99f4f80d5e42344b))


### Bug Fixes

* **anki:** 全局限额按全文等距抽样分配，零额度段标记跳过原因（F14） ([75eaea6](https://github.com/helixnow/deep-student/commit/75eaea650ff9719512afd78f1abac712257f3ff7))
* **anki:** 卡片删除撤销窗口/提交脱离组件生命周期（F19） ([0e7514b](https://github.com/helixnow/deep-student/commit/0e7514ba5d9faff048e5d05d068493ab7cb504d7))
* **anki:** 同名 note_type 冲突同步前告警并可见（F18） ([d7aae8b](https://github.com/helixnow/deep-student/commit/d7aae8b3fb2ea3c2840d4ebac1f44fcffbade74f))
* **anki:** 直接导出入口返回并展示媒体完整性报告（F16） ([28884c3](https://github.com/helixnow/deep-student/commit/28884c34bdbffebd389430a445f4a0bb2d00626b))
* **apkg:** 多模板 model id 由 template_id 稳定派生（F21） ([f026deb](https://github.com/helixnow/deep-student/commit/f026debb71a7d3660bc3eedf04385acbabfcd538))
* **browser:** 功能开关判定与入口可用性刷新 ([ab2e5e2](https://github.com/helixnow/deep-student/commit/ab2e5e23d054c4bf1a32204fb6d63474cacbbeb5))
* **chat:** 收敛附件上传与共享资源生命周期 ([00ca3c7](https://github.com/helixnow/deep-student/commit/00ca3c7ca1da14d6642d0de13565fe1796ebc03b))
* **flashcards:** configure learn-ahead and preserve rating retry payload ([ad47cb1](https://github.com/helixnow/deep-student/commit/ad47cb12804f5beceabe536bf3a2304e72af4810))
* **flashcards:** FSRS 会话代际与撤销恢复 ([dbb88d2](https://github.com/helixnow/deep-student/commit/dbb88d2f30d82884c77687cf3286db8a19814546))
* **flashcards:** isolate AnkiConnect models by template identity ([508e7fe](https://github.com/helixnow/deep-student/commit/508e7fedcf54084ab64df5817b5ff95b5fc5924a))
* **flashcards:** measure active question-to-rating duration ([714ebad](https://github.com/helixnow/deep-student/commit/714ebad816f12efdc4433b70a662e4361795bbe1))
* **flashcards:** preserve imported Cloze note and ordinal identity in APKG ([c78a466](https://github.com/helixnow/deep-student/commit/c78a4664401167887ff8100a6d33b1895afdcd30))
* **flashcards:** render template math and imported cloze fallback ([681e1e1](https://github.com/helixnow/deep-student/commit/681e1e128826ac60a85f6625fef03dda7706e1a9))
* **fsrs:** leech 自动暂停回写会话并出队（F04） ([aa968e4](https://github.com/helixnow/deep-student/commit/aa968e44adb353d6d5672170d340396527415234))
* **fsrs:** 掌握度排序不越过分钟级到期学习卡（F02） ([1a66bd1](https://github.com/helixnow/deep-student/commit/1a66bd1456454bd82c329466c40bccfb7b538407))
* **fsrs:** 滑动评分动画按本轮作答身份复位（F07） ([f57014c](https://github.com/helixnow/deep-student/commit/f57014c27a57a7df9f6cbd30d844f6b61681593c))
* **fsrs:** 目标保持率配置接入入队/评分/预览/重置（F01） ([ced045e](https://github.com/helixnow/deep-student/commit/ced045eb31f99a6ef84b3e9a640b413d2da8efa4))
* **fsrs:** 评分提交后补偿失败不再回滚命令，重试复用操作 ID（F11） ([f6d5377](https://github.com/helixnow/deep-student/commit/f6d5377cb334b2caeb5615f58dde40eff4c058d8))
* **generative-ui:** Markdown 正文渲染自足（数学、链接与净化） ([7c4d264](https://github.com/helixnow/deep-student/commit/7c4d264aebd30786f17ce96c349c7d5c9bbee2bb))
* **mindmap:** 为文档加载与保存加代际守卫 ([482201b](https://github.com/helixnow/deep-student/commit/482201b2e04b5033118b6881b6ff51457a3a52f9))
* **notes:** share full-document API and preserve save error and dirty state ([35910a0](https://github.com/helixnow/deep-student/commit/35910a06a9dec683d35b3c629514199f1c73c0d9))
* **notes:** 保存与关闭一致性（C1/C2/C3/C15） ([6e70e76](https://github.com/helixnow/deep-student/commit/6e70e7694263cafd42a10cf475852af8ed9738c4))
* **notes:** 元数据 CAS、大纲消歧与局部标签范围（C6/C8/C13/B04） ([7f1de57](https://github.com/helixnow/deep-student/commit/7f1de5779a7393784f7f11978bed13d13b5cfd81))
* **notes:** 导出保存屏障与全文范围提示（C7/C16） ([a530dc4](https://github.com/helixnow/deep-student/commit/a530dc48fcb255aca073d68d7ccf40697373830d))
* **notes:** 强制外部更新与显式保存按视图归属（C4） ([3828baf](https://github.com/helixnow/deep-student/commit/3828baf3b4ccf358a5428e9f1888a81f46d647c3))
* **notes:** 笔记异步加载与 AI 编辑代际收敛 ([7eba92e](https://github.com/helixnow/deep-student/commit/7eba92e197e924ccf90d4d1dcf1400883de54341))
* **notes:** 统一改名双链维护、查找面板所有权与输入法守卫（C5/C10/C14） ([4c97052](https://github.com/helixnow/deep-student/commit/4c97052b86aa2ae5a4320da684f7c5d97e44f219))
* **notes:** 补齐标题保存契约并顺序执行关闭保存（C15） ([598486a](https://github.com/helixnow/deep-student/commit/598486a1bc1795e31968e58ba17e8bf48269561b))
* **pdf:** 批注保存串行化并加固加载生命周期 ([a31b363](https://github.com/helixnow/deep-student/commit/a31b3635af10e1c12a2c6fcda6ff08b4324ffb8f))
* **practice:** 统一练习/考试请求与计时器归属 ([18c48f6](https://github.com/helixnow/deep-student/commit/18c48f630e25cbf4fa3724d8f735c81576138411))
* **qbank:** 聊天管线补注 QuestionBankService 并让 card_id 查询兼容 question id ([3312364](https://github.com/helixnow/deep-student/commit/3312364975f74d83720a7d2326c96cc0d8b6272f))
* **shortcuts:** 导航快捷键尊重输入态与 IME ([f7f6968](https://github.com/helixnow/deep-student/commit/f7f6968030d8bf966ce5118a61daeba533d6c6bd))
* **stats:** 留存按每卡每日首次复习计，参数面板改为记忆状态分布（F10） ([bb418a4](https://github.com/helixnow/deep-student/commit/bb418a4c8140920921d7dd6114db23a226c685f5))
* 修复 v0.9.61 交互测试确认的产品问题 ([3df6f88](https://github.com/helixnow/deep-student/commit/3df6f8878e95ed5187f24a6baa900f7c9cfe1763))


### Reverts

* **notes:** 属性大纲仍使用可见窗口内容（尊重既有 windowing 契约） ([c00f6c1](https://github.com/helixnow/deep-student/commit/c00f6c1099d62fab20a479492848804e7cb3e27c))

## [0.9.61](https://github.com/helixnow/deep-student/compare/v0.9.60...v0.9.61) (2026-09-12)


### Features

* **chatv2:** 压缩落盘即广播 compaction_completed，水位环立即刷新 ([1ff07ca](https://github.com/helixnow/deep-student/commit/1ff07cae79edded9d8aaf645a285bc322bf50e82))
* connect live demos to question practice and full mindmaps ([addf44a](https://github.com/helixnow/deep-student/commit/addf44ad9b8d5bb3da2a72467b572322e9e514a6))
* expand live learning demos with follow-ups and materials ([a3d5c68](https://github.com/helixnow/deep-student/commit/a3d5c68b11a148e6f61660e7416b9a209a7159ac))
* **llm:** 官方 DeepSeek V4 sampling 分档锁定与 top_p/penalty 精细化 ([691dc65](https://github.com/helixnow/deep-student/commit/691dc65590d99cc6258f22389bde06eb7e6baa3b))
* **notes:** refine block drag feedback ([a8bfd3a](https://github.com/helixnow/deep-student/commit/a8bfd3ab9f3121f74e057e41c3306ae3d71c71e3))
* **qbank:** 单题型上限放宽，组卷数字输入不设上限并校验题库余量 ([c35cca3](https://github.com/helixnow/deep-student/commit/c35cca3dd46d84f0be9aa4e344f8eff89b3e77ae))
* **qbank:** 单题型上限放宽与组卷余量校验；填空题改走 AI 评判并回写判定结果 ([7fe0999](https://github.com/helixnow/deep-student/commit/7fe09990b0dbce7da792401d946a774ac03a90b5))
* redesign DeepStudent landing page around live demo ([cf76e68](https://github.com/helixnow/deep-student/commit/cf76e68bca3bdc49e601a99edd57cca123bd09b9))
* **settings:** 移动端隐藏学习桌面设置入口 ([b18c958](https://github.com/helixnow/deep-student/commit/b18c958e70afdabf8211fc73cf13660a0d7b5cf9))
* showcase learning workflows in live demo ([ffe2f67](https://github.com/helixnow/deep-student/commit/ffe2f67f9f1c08aff20de642ffa7ad4fd21e3b02))


### Bug Fixes

* **chatv2:** 压缩会话守卫改 token 体量判定，修复多工具重型会话永不压缩 ([2733db1](https://github.com/helixnow/deep-student/commit/2733db1324910021008aad8452c25198744bfc92))
* enable question previews and artifact exports in chat ([94724c5](https://github.com/helixnow/deep-student/commit/94724c57b1a98debe1813cd7b6e8be8c0c6d6abf))
* isolate DeepSeek harness optimizations by provider ([4a804b5](https://github.com/helixnow/deep-student/commit/4a804b59ca0ecfd5f1cc073922d03b3e5d6a160f))
* **notes:** improve editor layout and save lifecycle ([def7b32](https://github.com/helixnow/deep-student/commit/def7b32fd786af7e055e07698b9282c9b9729e79))
* **notes:** stabilize block handles and mobile title layout ([11f38ab](https://github.com/helixnow/deep-student/commit/11f38ab7670980234a1a2df7cac3386d9cd42467))
* **qbank:** SSE 缓冲 O(n²)→O(n) 线性扫描，修复安卓大题量出题流中断 ([b1397c5](https://github.com/helixnow/deep-student/commit/b1397c5d615683539d0e7e492678901326aeaed8))
* **qbank:** 填空题改走 AI 评判，判定结果回写练习进度与模拟考成绩 ([6dbf42c](https://github.com/helixnow/deep-student/commit/6dbf42cf9486c9a7fb117e4228328a126b87e1f2))
* **qbank:** 组卷余量校验在统计失败时跳过而非误报库存不足 ([19ff679](https://github.com/helixnow/deep-student/commit/19ff67987dc6273254ac24fb5223d16be816a700))
* **rag:** repair dangling embedding defaults ([8143ad7](https://github.com/helixnow/deep-student/commit/8143ad77ebf044aa791c65c02caf780a19729e8f))
* **rag:** 多模态嵌入默认设置悬空引用自愈（VL 轨道同款修复） ([077d494](https://github.com/helixnow/deep-student/commit/077d49406d60cc9194ca8ecac42734e6474dcb1c))
* **rag:** 嵌入默认设置悬空引用自愈，修复全量索引「找不到嵌入模型配置」 ([9277368](https://github.com/helixnow/deep-student/commit/9277368e9506e2f3867d2bbd905442029866016a))

## [0.9.60](https://github.com/helixnow/deep-student/compare/v0.9.59...v0.9.60) (2026-09-10)


### Features

* **chat:** 产物面板收敛为会话底部可折叠产物列表 ([e5221e3](https://github.com/helixnow/deep-student/commit/e5221e33ed4d12c82cbb6fba1d2dc178fd8a716f))
* **chat:** 会话分组支持主题色 ([e774d3d](https://github.com/helixnow/deep-student/commit/e774d3d805fa72f32e3bca1f1f06c2f27b512484))
* **chat:** 工作区文件分区沉底并默认折叠 ([2589644](https://github.com/helixnow/deep-student/commit/2589644c3baaf852db2b6908ce758c3d140792ab))
* **llm:** Moonshot/Kimi 工具 schema 按 MFJS 方言规范化 ([9e47974](https://github.com/helixnow/deep-student/commit/9e47974e827757e4276e64c744be4b3eff6a8461))
* **llm:** V4 历史 reasoning 回传按 tools 分流并对齐 max 档官方语义 ([26e91d6](https://github.com/helixnow/deep-student/commit/26e91d6dc7ccdb9c857b6c206a431480e1b05a3c))
* **llm:** 官方 V4 推理强度契约 fail-fast（对齐 DSH UNSUPPORTED_REASONING_EFFORT） ([1082ee1](https://github.com/helixnow/deep-student/commit/1082ee195093d6772c01510120fa75529b15f894))
* **llm:** 引入稳定 LLM 错误码并吸收 DSH 兼容语义（第一批） ([7692408](https://github.com/helixnow/deep-student/commit/769240881a524569e743ebe81e19f0fbca0b5e56))
* **llm:** 支持 DeepSeek V4.1 Flash（deepseek-flash）并对齐官方 Responses 语义 ([3b6b6f5](https://github.com/helixnow/deep-student/commit/3b6b6f5a6718ab055a26ce315e8162e1afd736a2))
* **prompt-cache:** 工具面首轮定型 + 一次性加载约束，减少中途扩容导致的缓存失效 ([#395](https://github.com/helixnow/deep-student/issues/395)) ([d03e5a8](https://github.com/helixnow/deep-student/commit/d03e5a801b9534d7ab17b0a7cc725ff66ed50057))
* **quick-assistant:** 原生毛玻璃质感 + 逻辑像素尺寸持久化 ([8ac1ac5](https://github.com/helixnow/deep-student/commit/8ac1ac50c2d1205c557e8c301ba422b908e13e59))
* **settings:** 供应商模型探测回填上下文窗口/最大输出（对齐 DSH 目录语义） ([ee52761](https://github.com/helixnow/deep-student/commit/ee5276142cb3ea5c57b239d94dff6fe5da40e23e))


### Bug Fixes

* **chat:** 产物面板 note/file 详情内联复用 UnifiedAppPanel 预览 ([bb9eb5b](https://github.com/helixnow/deep-student/commit/bb9eb5b61245d3c60fee7175e136de5b8fc49d73))
* **ci:** Build Archive 超时 60→90 分钟 ([7e281db](https://github.com/helixnow/deep-student/commit/7e281db505fdcc50cb3854c185aad569130fd3ba))
* **ci:** Provider Contract 超时 75→90 分钟 ([deff4a3](https://github.com/helixnow/deep-student/commit/deff4a3513721d8840130593c5bfa16b29387b44))
* **ci:** 统一 OOM 缓解——Backend/provider/migration/nightly 补 swap+并行度限制 ([532dc79](https://github.com/helixnow/deep-student/commit/532dc79bea4f33b5cf12a6b88777efea05842fcf))
* **llm:** 同步 V4 low/high/max 档与 64K 输出默认的前端镜像 ([d932907](https://github.com/helixnow/deep-student/commit/d93290745c3aa094b5b66e4fedcc20c21c25ae03))
* **sync:** 资产墓碑回收不再被 conflict 副本复活 ([ba694a1](https://github.com/helixnow/deep-student/commit/ba694a16c323ad7c41fde5f7db396b2088a099db))
* **wallpaper,backup,cache:** 自定义壁纸白屏、跨设备备份导入、Prompt 缓存诊断日志 ([#393](https://github.com/helixnow/deep-student/issues/393)) ([086900c](https://github.com/helixnow/deep-student/commit/086900c23a99983f3a3b854728b13cf02a325104))

## [0.9.59](https://github.com/helixnow/deep-student/compare/v0.9.58...v0.9.59) (2026-09-09)


### Features

* **qbank:** AI question generation v3 — background tasks, dedicated model slot, reference injection modes & chat tools ([#391](https://github.com/helixnow/deep-student/issues/391)) ([6ec3cb1](https://github.com/helixnow/deep-student/commit/6ec3cb161fb93232b5c3ccb7a9b518e71bdb6b4d))


### Bug Fixes

* **ci:** cap Android build jobs and expand swap ([bc8546c](https://github.com/helixnow/deep-student/commit/bc8546ce1bf9eb065cef4cfc7b4809acdddcbca8))
* **ci:** stabilize release migration gate runner ([d4aa0fe](https://github.com/helixnow/deep-student/commit/d4aa0fe82bfffabb28a4bd3565aaa700a0e62db2))

## [0.9.58](https://github.com/helixnow/deep-student/compare/v0.9.57...v0.9.58) (2026-09-08)


### Bug Fixes

* **release:** refresh dependency license metadata ([4d41851](https://github.com/helixnow/deep-student/commit/4d41851d03467a8e5a753081f09548833388fff9))

## [0.9.57](https://github.com/helixnow/deep-student/compare/v0.9.56...v0.9.57) (2026-09-08)


### Features

* **chat-v2:** G01-a ExecutionEventSink 接口提取——无界面执行内核总入口 ([8900013](https://github.com/helixnow/deep-student/commit/890001395a8e755e0073c5603332eb140ce7029e))
* **chat-v2:** G01-b LLM 流式层去 Window 依赖——StreamEventSink ([a220633](https://github.com/helixnow/deep-student/commit/a2206333448e502a047f9aad354e384dd74b528f))
* **chat-v2:** G01-c ToolDescriptor 后端权威注册表（元数据 SSOT） ([d0bfef4](https://github.com/helixnow/deep-student/commit/d0bfef4e38de4a0f5f3a57a6699eb1005eaf30d8))
* **chat-v2:** G01-d headless 入口收口 + G03-d 无窗唤醒轮接通 ([fa47e18](https://github.com/helixnow/deep-student/commit/fa47e1822be2fd196d0b369fc28f0159b1e9a51c))
* **chat-v2:** G02-P1 DelegatedGrant 委派授权数据模型 + 撤权 epoch 实时生效 ([35de775](https://github.com/helixnow/deep-student/commit/35de77502ec3c9e9343e1a246338e91191662f6b))
* **chat-v2:** G02-P2 撤权 epoch 落库 + G08-P2 预算 settings 可配与快照 ([5b753d7](https://github.com/helixnow/deep-student/commit/5b753d7ba0cb8f9f279b50a53148bf6a2e1b40b7))
* **chat-v2:** G03-a 子代理完成投递持久账本 + 后端 CompletionDispatcher + Unknown 代际 ([4a2ff86](https://github.com/helixnow/deep-student/commit/4a2ff864a8b740e68a33dbfa700955ba3c327664))
* **chat-v2:** G04-P0 连接器操作持久账本——状态机 + 系统幂等键 + outcome_unknown ([ce729c6](https://github.com/helixnow/deep-student/commit/ce729c63494da7ceab7ad0f246910303795d3b04))
* **chat-v2:** G04-P1 首个真实 connector provider 纵向打通 + provider 对账 ([9e5306c](https://github.com/helixnow/deep-student/commit/9e5306c344c951356ba5e95476713146ca134af4))
* **chat-v2:** G05-P1 程序化工具组合（PTC）——Starlark broker + 只读工具面 ([06f82dc](https://github.com/helixnow/deep-student/commit/06f82dc2aadfa387c8edc6b4c9b5d0d2dcb0f589))
* **chat-v2:** G05-P2 PTC object_read 分页回读 ([7b4a42d](https://github.com/helixnow/deep-student/commit/7b4a42d783ce60a4d2c280c8803a69a9f22c0cb2))
* **chat-v2:** G05-P3 PTC 受控写与对象写回 ([c321d54](https://github.com/helixnow/deep-student/commit/c321d5435eec489be21940e6263cb923d05e48c6))
* **chat-v2:** G06-P1 能力声明驱动门禁推广至 docx/pptx + 格式无关骨架 ([9cca7c3](https://github.com/helixnow/deep-student/commit/9cca7c32183610e13f6d8c39a16009397e2bdd4d))
* **chat-v2:** G07-a candidate_complete 与任务验收分离——TaskFinalizer 骨架 ([f839baf](https://github.com/helixnow/deep-student/commit/f839baf8e2ef544b17ff97676b7fb095ceb4f4d3))
* **chat-v2:** G07-b TaskFinalizer 验收器补全——BatchCoverage + SideEffectsSettled ([c0cccaa](https://github.com/helixnow/deep-student/commit/c0cccaaeff30a3be25869d6eaa279025c2a635a5))
* **chat-v2:** G08 全树预算管控——BudgetLedger 树根账本 + hooks 预算门 ([555aef5](https://github.com/helixnow/deep-student/commit/555aef5d6d5899ffef2f9f5189327b5970fdac9f))
* **chat-v2:** G08 环境清单与漂移检测（environment manifest 半边） ([17e91c4](https://github.com/helixnow/deep-student/commit/17e91c48835b4b46f1fa02efeb6fc6d463727e61))
* **chat-v2:** G09-P0 技能使用后端账目 + 经验候选库（只记录不回放） ([6c488ab](https://github.com/helixnow/deep-student/commit/6c488ab79054949b2ba4821836ddf7321f8f2a94))
* **chat-v2:** G09-P1 技能经验回放器（dry-run 对账 + 人工晋升） ([f81601b](https://github.com/helixnow/deep-student/commit/f81601b12930c21dfa914e903fdb7b2246cae63f))
* **chat-v2:** G09-P2 技能晋升成文 + G07 终态 outcome 回流 + 反例候选 ([e4df3f3](https://github.com/helixnow/deep-student/commit/e4df3f365e18b110e77c251fc2604cf795b7ea9f))
* **chat-v2:** G10-P1 iLink 入站统一 TaskCommand——接入同一任务运行系统 ([39ad415](https://github.com/helixnow/deep-student/commit/39ad415be96dce4af41ddb8d94e41c5da417b546))
* **chat-v2:** G11-P1 TaskObjectHandle 血缘补全 + 统一 builder ([1f29dba](https://github.com/helixnow/deep-student/commit/1f29dba4e98319260066ca6af4e5b6046f2305ab))
* **chat-v2:** G11-P2 分页 CorpusManifest——超限附件不再静默截断 ([901edee](https://github.com/helixnow/deep-student/commit/901edee9181b0f674e709c9066bea94aada4526e))
* **chat-v2:** 注册 V20260907/08/09 三个迁移的 MigrationDef ([3444114](https://github.com/helixnow/deep-student/commit/34441141d8d389836b9c4210227df3155903e3f0))
* **chat:** G07-a 前端收尾——CompletionCard 验收徽章 ([c9e377d](https://github.com/helixnow/deep-student/commit/c9e377d00690846e431947ba9ace8a1805432716))
* **chat:** gate rich renderers by user settings ([4dff7a6](https://github.com/helixnow/deep-student/commit/4dff7a6983ad88760f7ec218311c56cf439529f2))
* **chat:** P0 选区即上下文 — selection contextRef 类型 + 四面接入（PDF/消息/导图/笔记） ([cee3fe2](https://github.com/helixnow/deep-student/commit/cee3fe28722f082e7d3e498f1c551aa99d2a0c06))
* **chat:** P1 产物一等公民化 — 会话级 artifact registry + 产物面板 ([32f4eb0](https://github.com/helixnow/deep-student/commit/32f4eb083cab6f4f542b331eddbc1cbb794270ee))
* **chat:** render inline chemical structures ([247103b](https://github.com/helixnow/deep-student/commit/247103b640d0e1611cff2fc2380e0375060db496))
* **chat:** 产物面板与入口视觉收敛——入口对齐顶栏 toolbar 家族并有产物才显示，面板列表去彩色、徽章 token 化、窄容器强制单列 ([2c52346](https://github.com/helixnow/deep-student/commit/2c52346080575c7c6b210ceb47eefb4d25d45e08))
* **command-palette:** 容器升级液态玻璃材质——低透明 tint + specular 环，对齐桌面 wb-glass 配方 ([06b8e44](https://github.com/helixnow/deep-student/commit/06b8e44e3551e52063ec7b3cda918306e7644a21))
* **demo:** 新增会话④周度学习看板剧本（P1 产物面板 + P3 模板演示） ([1adbb01](https://github.com/helixnow/deep-student/commit/1adbb01cac669b32d2314f9799b98a038a68324b))
* **insight:** 阶段一前端——insights API 层 + 确认两问对话框 + 笔记工作区灵感合集区块 ([ce04988](https://github.com/helixnow/deep-student/commit/ce04988ca4ea88ee98e3bceca122fc966790d9f2))
* **insight:** 阶段一后端——灵感卡五表迁移 + InsightService 采集/确认/纠正/墓碑删除 + VfsResourceType::InsightCard 全链路注册 ([3740b50](https://github.com/helixnow/deep-student/commit/3740b506dea33c0bbcf8767eae37dd212f456932))
* **insight:** 阶段三前端——确认/纠正后触发 insight_run_jobs 巩固 worker ([7348826](https://github.com/helixnow/deep-student/commit/734882623703f4dd173cb49c11355a5f828e24e6))
* **insight:** 阶段三演化——合并提案/原则合成（≥2案例+1反例+条件化）/原则复审 → 灵感演化待办（附件回链，marker 幂等）；修正派生边方向语义 ([5c9492d](https://github.com/helixnow/deep-student/commit/5c9492d64fff84312ade2be88e9a52fc114e67ac))
* **insight:** 阶段三骨干——insight_jobs 队列（lease+dedupe+退避+启动恢复）+ SRS 投影物化（inspiration 回链/修订重生成/墓碑传播） ([4781fef](https://github.com/helixnow/deep-student/commit/4781fef11f2731adfbec35096a426ea8062efd8e))
* **insight:** 阶段二前端——insightRecall 检索块（披露级徽章+点击纠正）+ RetrievalSourceType/Citation 加 insight 源 + [灵感-N] 引用解析 + i18n ([a3568c8](https://github.com/helixnow/deep-student/commit/a3568c8e260a3fda2730f2562180ae81510a39ae))
* **insight:** 阶段二接入——InsightRecallExecutor（范式A+披露过滤出口）+ 被动注入 turn-volatile + [灵感-N] 引用前缀 + 前端工具技能 ([2e9ed99](https://github.com/helixnow/deep-student/commit/2e9ed99122459325b98d8b5c17d5e964e8b4cf95))
* **insight:** 阶段二核心——insight_fts 召回管道 + 披露控制器（四沉默分账）+ mastery_events 加 insight 源 + 幂等事件写入 ([015ee91](https://github.com/helixnow/deep-student/commit/015ee91c9b020b81a8de601c471a0520ba67ee7b))
* **insight:** 阶段四自适应——效用门控校准（三本账）+ 跨簇类比挖掘（关系边固定预算）+ 内化退场降权（0.3 下限） ([7e5cefa](https://github.com/helixnow/deep-student/commit/7e5cefa3eb36fede8035430168ee1e68b52ec19a))
* **office:** G06-P0 xlsx 编辑强制保真门禁——critical 特征阻断 + 统一交付 ([8decc52](https://github.com/helixnow/deep-student/commit/8decc525fe112aecc8024346cf7f3cc143d879db))
* P2 人机双写 — 笔记 checkpoint 栈化 + 导图建议确认条 + anki 审批 diff + action undo + 变更分段 ([9015be6](https://github.com/helixnow/deep-student/commit/9015be694bae874b96995f6b967330987569d010))
* **settings:** 会话宽度占比滑块——宽屏阅读列按 --chat-thread-ratio 延展（外观设置 + 启动初始化 + 契约测试） ([edaef51](https://github.com/helixnow/deep-student/commit/edaef517befcfaa5ede2269a858c8afe3b4a6f1c))
* **settings:** 测试连接复用生产请求管线——结构化 ConnectionTestOutcome + 流式首事件探测 + 失败分类归因 ([cf0a0d3](https://github.com/helixnow/deep-student/commit/cf0a0d352283c3c846342e6bd3bc897961e057f0))
* **skills:** P3 产物模板 skill 化（canvas-in-skills） ([73a9d01](https://github.com/helixnow/deep-student/commit/73a9d014857b51716c904088df43a87f999e6de0))
* **workbench:** 液态玻璃整面壁纸复刻折射——WallpaperReplica 基建 + 全桌面玻璃面接入 + 全周 specular 环 ([fbf6c77](https://github.com/helixnow/deep-student/commit/fbf6c771daceb6bc107953950e80955c0e05861e))


### Bug Fixes

* **attachments:** preserve ready image fallback ([784964f](https://github.com/helixnow/deep-student/commit/784964fb935dfb943db0b3a7a3013bad31e389f3))
* **attachments:** smart default inject modes + auto panel + OCR speedup + runtime multimodal decision ([2d9fa1f](https://github.com/helixnow/deep-student/commit/2d9fa1f84d2b393fa53aa6304b6037250300a6d3))
* **background:** N10 TaskTracker 关闭改为准入关闭，shutdown 先停准入再收敛 ([e931779](https://github.com/helixnow/deep-student/commit/e9317793389d7183e5b69b886c403c46c542ba02))
* **background:** 撤回误入 N10 提交的 insight_run_jobs 注册行 ([d4fbb93](https://github.com/helixnow/deep-student/commit/d4fbb930cd76fb0a089af457167c712d6bb7760f))
* **build:** F1 Android versionCode 锚点固定——摘除基准的 release-please 自动重写 ([6b870f9](https://github.com/helixnow/deep-student/commit/6b870f981f9b467de3fe1612c0083864225688dd))
* **canonical-images:** never send file bytes as image parts (PDF count_token_failed) ([29daf03](https://github.com/helixnow/deep-student/commit/29daf032becbc1112438170bfb198319510eb044))
* **chat-v2:** unify academic citation numbering ([bbc26dd](https://github.com/helixnow/deep-student/commit/bbc26dd175ccc4bf1492f7180058eec9c75fbbb4))
* **chat-v2:** 修复 HashMap 序列化序导致的'内容已变'误判——压缩管线范围指纹 + Anki 导出键序比对 ([7f7ebac](https://github.com/helixnow/deep-student/commit/7f7ebac7f8646e45d6b47f137bfeb343e65bb395))
* **chat:** P0 复审修复——workbench 壳 selection 回链 + 死按钮/截断计数/注册契约/demo mock ([729d70f](https://github.com/helixnow/deep-student/commit/729d70fd5922fef3fa3e6adb47e4abbda11fecfa))
* **chat:** P2 复审修复——变更记录接入导图/anki 来源 + 建议回执文案消除双重应用隐患 ([47882ef](https://github.com/helixnow/deep-student/commit/47882ef258fad156dd276104ae2eb619fcdd3f15))
* **chat:** 二轮深检修复——skeletonRef 活跃性校验 + 建议暂存 TTL + anki diff 前缀归一 ([54abb2f](https://github.com/helixnow/deep-student/commit/54abb2fa71dc0405991fcc8c2e9b24d3cb162e7f))
* **chat:** 划词工具栏交互标记先于按键判断消费——修右键点工具栏后下一次划词不弹出 ([e5ee102](https://github.com/helixnow/deep-student/commit/e5ee10233f5f967bc73759b00692f8dd3134b495))
* **chat:** 稳定 MessageSearchContext value 引用——修划词工具条弹出瞬间 Markdown 重建导致高亮消失 ([dfb9c84](https://github.com/helixnow/deep-student/commit/dfb9c84586fc59a65b967497ce01cf49138f0b0f))
* **ci:** F9 恢复发布级迁移兼容性门禁 ([35e83d7](https://github.com/helixnow/deep-student/commit/35e83d7b1a5ee3c12c2c6c23df11b4399a03a144))
* **ci:** main 基线四项红修复——fmt 债/cooldown 漂移守卫/侧栏源契约/provider 契约矩阵适配 ([8bda386](https://github.com/helixnow/deep-student/commit/8bda386db474b67cdda631993c70fa34a1e4cdb0))
* **fsrs:** N05 掌握度 outbox 读取失败不再误确认事件 ([f45bf77](https://github.com/helixnow/deep-student/commit/f45bf776a866af91d0229cfec919a0d4b22b9238))
* **generative-ui:** N09 timeout 移入 rate-limit 内层，超时不再永久占用 in-flight ([7e6d89c](https://github.com/helixnow/deep-student/commit/7e6d89c25b2c6309ad713bd93d713f6bced12855))
* **goal:** F4 续跑改 CAS 认领 + 失败关闭 + pause/clear 取消在飞续跑 ([ec52945](https://github.com/helixnow/deep-student/commit/ec529457c43b99a17155cc9992106285dc754b6d))
* **insight:** CITATION_GUIDE 静态预算 750→780（新增 [灵感-N] 来源类型行，文案精简） ([92e850c](https://github.com/helixnow/deep-student/commit/92e850c8a8cb916eb6410a2a134930d28ea4f125))
* **insight:** 自查修复——计数器与幂等事件联动（重试/变体不重复计数）+ insight_fts UPDATE 触发器收窄（V20260911，计数累加不重建索引）+ 块披露级徽章取真最大值 ([b5d2833](https://github.com/helixnow/deep-student/commit/b5d2833fd03e73dfc6690963a0595f4135ddc3e0))
* **mcp:** F5 日志只记元数据——message_loop/notification 不再输出原文 ([dda858b](https://github.com/helixnow/deep-student/commit/dda858bd2d05a0073fdf21dc64c06d7b5fbbee72))
* **mcp:** N01 通知分发改 envelope 互斥判别 + 标准方法名兼容映射 ([3e5d839](https://github.com/helixnow/deep-student/commit/3e5d8394a57c9c7c10e4ad9bcd7177e95efc4a04))
* **notes:** N02 分窗重组保持原文——边界分隔符恒为一个换行 ([0aaa70a](https://github.com/helixnow/deep-student/commit/0aaa70a29dd2bef9a06a8a6cb9ae1f1200652722))
* **notes:** N03 正则替换接入统一输出预算，逐匹配累加提前中止 ([2c2ae03](https://github.com/helixnow/deep-student/commit/2c2ae0384673a80afd6f219d17bdc3680b205a90))
* **ocr:** settings persistence + assignment consistency + PDF local fallback + 4xx circuit break ([e419cc3](https://github.com/helixnow/deep-student/commit/e419cc37fda114dbcfe069e807751c71e317d5f9))
* **package-manager:** N12 安装子进程改 tokio::process，加总 deadline 与有界输出 ([548f196](https://github.com/helixnow/deep-student/commit/548f19695d44201e0c946a3cd1a48fdff0f02f25))
* **pdf:** unified content classification + readiness-driven inject modes + variant multimodal passthrough ([aaa90fb](https://github.com/helixnow/deep-student/commit/aaa90fbb0347abc5a0da1c7361965bfdac8f31cd))
* **pdf:** upgrade pdfium-render 0.8.37 -&gt; 0.9.4 to fix native crash on concurrent PDF text extraction ([04bb67d](https://github.com/helixnow/deep-student/commit/04bb67de9c84d156a06df1536291c8c76ca6b45d))
* **pomodoro:** N11 已失败的会话记录不再从 flush 边界消失 ([ef78b96](https://github.com/helixnow/deep-student/commit/ef78b962a3c60fce59a02784d9c6dee8c17163c5))
* **qbank:** N13 不完整评判流只落草稿，正文示例标签不再被当最终成绩 ([61d6376](https://github.com/helixnow/deep-student/commit/61d6376b894688ab95e536bd397d8e0e6b6a2ff5))
* **security:** F7+F8 资源硬上限与 token 保守估算 ([6e98f21](https://github.com/helixnow/deep-student/commit/6e98f21903f1686a193f7ead180f386476dc53a5))
* **settings:** N06 批量写入回滚基线严格化 + 删除失败可见 ([f03a40f](https://github.com/helixnow/deep-student/commit/f03a40f0701fead66b4cdb3a28795366c77fe7ee))
* **skills:** P3 复审修复——skeletonRef live 路径回显 + 通知 i18n 化 + 白名单三方契约测试 ([b03c1b6](https://github.com/helixnow/deep-student/commit/b03c1b6bc6c0f5d5ba15edd07bd6e9ad1991127b))
* **startup:** retry recovery preflight to survive Android IPC race ([92ae5f1](https://github.com/helixnow/deep-student/commit/92ae5f166a85f6fa0bb5767a062bd667045ee86d))
* **startup:** retry recovery preflight to survive Android IPC race ([f623869](https://github.com/helixnow/deep-student/commit/f623869b7d6f18723275de62f489a5537773a260))
* **tools:** resolve file IDs through reference resources for document tools ([7645016](https://github.com/helixnow/deep-student/commit/764501658436d22844ce354ac957fcf054734b83))
* **vfs:** image-only PDF mode no longer warns "text extraction failed" ([c80b5ab](https://github.com/helixnow/deep-student/commit/c80b5abbb9ff7964e381819c7ce399a6b804727a))
* **vfs:** N04 孤儿 blob 补偿与并发同 hash 复用串行，关闭活引用误删窗口 ([16d81fe](https://github.com/helixnow/deep-student/commit/16d81feab1161b0c839ab62da053a3976b959079))
* **vfs:** N07 reset_unit_index 用 IMMEDIATE 事务保证原子状态转换 ([d9b0f13](https://github.com/helixnow/deep-student/commit/d9b0f13d10fe8e2d13788b895a9c363ee2fe1ada))
* **voice:** N08 权限等待期间可取消——启动代际 + 迟到资源立即释放 ([31eac40](https://github.com/helixnow/deep-student/commit/31eac406016fa2ebf30bdd70e7f064b691a9fa37))
* **windows:** F6 direct-shell 挂起创建——先绑定 Job 再恢复主线程 ([d65ad36](https://github.com/helixnow/deep-student/commit/d65ad36c85a3cd621d70057a66258f0235bbfad6))
* **workbench:** N14 仲裁 abort 改为吸收态，暂停超时不再丢失中止决定 ([273cc1f](https://github.com/helixnow/deep-student/commit/273cc1fa9c9d92826fddcfb10b0ac05dd0d4c15a))
* **workbench:** remove impossible closed-phase comparison ([0ef3d3d](https://github.com/helixnow/deep-student/commit/0ef3d3deed8791bc07c36b3420e28067d2c84775))


### Performance Improvements

* **chat:** F3 anki 卡片判重改 ID 索引——合并窗口内近线性 ([acad207](https://github.com/helixnow/deep-student/commit/acad2078ba20dfa5822b0c8d4143cd29c376a55e))

## [0.9.56](https://github.com/helixnow/deep-student/compare/v0.9.55...v0.9.56) (2026-09-06)


### Features

* **260716-kcq:** import custom wallpapers into app storage ([7459ac1](https://github.com/helixnow/deep-student/commit/7459ac1dd478d7e71438044ce6b482bddfb16312))
* add pelican bicycle svg animation ([6de34e3](https://github.com/helixnow/deep-student/commit/6de34e3a5f8ed24d98daef72d6670e69be4568b2))
* **agent:** expand Chat tool execution and automation runtime ([f32d820](https://github.com/helixnow/deep-student/commit/f32d820a356e542537e8839dac984dedeb742157))
* **anki:** complete APKG and FSRS review workflows ([76c5f8f](https://github.com/helixnow/deep-student/commit/76c5f8f9ece9e0da3c99ac19c7b6ea2c3f0f7c4c))
* **app:** 0824 批次应用外壳与其余前端改动 ([1d81763](https://github.com/helixnow/deep-student/commit/1d8176383d7debaf88df1dade8a8286020590360))
* **app:** add recovery flows and harden agent runtime ([380ea70](https://github.com/helixnow/deep-student/commit/380ea703efc2646b3b32bffb4ed64a10ee459324))
* **app:** unify titlebar surface, clean native material, and lazy-load debug panel ([7d01fad](https://github.com/helixnow/deep-student/commit/7d01fadbf46d27c843127d4dc72b3a595aa2db97))
* **automation-ui:** surface completed runs and sessions ([3dadd67](https://github.com/helixnow/deep-student/commit/3dadd67a1583573b9cb6dfcab66c8ead444f556e))
* **boot:** brand boot and lazy-load screens with square logo mark ([679471c](https://github.com/helixnow/deep-student/commit/679471c9be3196bcca55e01b8b6a338f874903f9))
* **browser,codex:** add native browsing and Codex account management ([e76f7ba](https://github.com/helixnow/deep-student/commit/e76f7ba30d086367e661b82f8d85e1bfc28c5acc))
* **browser:** harden sessions, navigation policy, and takeover flow ([1df76fc](https://github.com/helixnow/deep-student/commit/1df76fce39ab45535321175583fca61b829985fb))
* **chat-v2:** add agent tool executors, export handlers, and compaction lineage ([3c6a57f](https://github.com/helixnow/deep-student/commit/3c6a57f0924cbfd0fdd6b0739d91c6ea1451ecde))
* **chat-v2:** harden shell sandbox, skill trust, and file preview systems ([1ca3b8f](https://github.com/helixnow/deep-student/commit/1ca3b8fac1a3110719e508cde5e2fb555809f65d))
* **chat-v2:** harden subagent runtime, workspace integration, and notes app ([a3f4b3a](https://github.com/helixnow/deep-student/commit/a3f4b3affe0bb9a69961aa72f54bb0a3648929d0))
* **chat-v2:** rework retrieval executor, automations, and session management ([aadbeb7](https://github.com/helixnow/deep-student/commit/aadbeb7d2730465eec27484c151eb483b3459d3b))
* **chat-v2:** strengthen tool execution and agent coordination ([a9c0ad7](https://github.com/helixnow/deep-student/commit/a9c0ad70c108e16cfdee193b1122eb171c7fca3b))
* **chat,editor,workbench:** expand productivity tools and runtime roots ([180625c](https://github.com/helixnow/deep-student/commit/180625c7299e360b0ee47dd6212dd22a5ea08783))
* **chat:** 0824 批次聊天域前端迭代 ([707acef](https://github.com/helixnow/deep-student/commit/707aceff918b8db9e1ac9bb6d901c8a9547368fe))
* **chat:** add in-conversation message search with hit navigation ([f5d7091](https://github.com/helixnow/deep-student/commit/f5d70918d4d36029f16d20403888dc361e1427f0))
* **chat:** add session goal mode with cross-turn auto-continuation ([5edffa1](https://github.com/helixnow/deep-student/commit/5edffa1a6dd36dfd20bc0e488ec854f62071cf8d))
* **chat:** add snapshot file import export flow ([9c25d7e](https://github.com/helixnow/deep-student/commit/9c25d7e648ef3255dc4bb062959502923f2d83fe))
* **chat:** add snapshot import action to session browser ([9ffbfce](https://github.com/helixnow/deep-student/commit/9ffbfcead61224081e9cd96e6d871d0d4c5fe97b))
* **chat:** add transactional conversation snapshot import ([3ee514d](https://github.com/helixnow/deep-student/commit/3ee514d01e17056cbf5428a18b47109392d67829))
* **chat:** async subagent wake, read-only sessions, and stream cleanup ([8e08f0a](https://github.com/helixnow/deep-student/commit/8e08f0afff50210982b5756d45841ae06790a479))
* **chat:** compact tool activity timeline with sweep visuals and tool grouping ([fbe2e96](https://github.com/helixnow/deep-student/commit/fbe2e9640aa6773850d7fab7f0140717063ddd6e))
* **chat:** enhance message list auto-scroll behavior and user interaction detection ([8681470](https://github.com/helixnow/deep-student/commit/8681470f8c6464e211c2f86184dd57aac016c2c3))
* **chat:** expand tool executors and policy gating ([76034bd](https://github.com/helixnow/deep-student/commit/76034bddc3003ce9588203d8e76352d11717dbbe))
* **chat:** expose conversation snapshot APIs ([91c9222](https://github.com/helixnow/deep-student/commit/91c9222a03f60af427de419d4575c77ef5eb7356))
* **chat:** goal mode frontend — status chip, builtin tools, stream race fix ([a6bca19](https://github.com/helixnow/deep-student/commit/a6bca190cb74f225872a0a69e6a54b02ade1ba8c))
* **chat:** harden agent runtime, tools, and session lifecycle ([975c8f1](https://github.com/helixnow/deep-student/commit/975c8f1b4ebf3658ff22236547b6306934e45a5a))
* **chat:** harden tool permissions and workflows ([3021373](https://github.com/helixnow/deep-student/commit/30213739a2476f9647d0f1a7ca2003a9e164cd49))
* **chat:** headless runner and pipeline tool-loop rework ([b085f85](https://github.com/helixnow/deep-student/commit/b085f854b8cb3501a03a85afe0cac77d52ace682))
* **chat:** integrate adapters, UI shell, and remaining chat surfaces ([9a4d86c](https://github.com/helixnow/deep-student/commit/9a4d86cb2dc8187367e78514e317ebf4ff251b83))
* **chat:** rebuild input bar, anki card blocks, and mobile message actions ([f1d665e](https://github.com/helixnow/deep-student/commit/f1d665e519676bea4422d63ff9009ac53b6498fe))
* **chat:** refine composer, streaming, sources, and sessions ([f1a4386](https://github.com/helixnow/deep-student/commit/f1a4386650c709795f1ca5158109ad626b87c971))
* **chat:** rework stream lifecycle, agent task UI, and session browser ([00df945](https://github.com/helixnow/deep-student/commit/00df945151160ebdf58e380a54d664bdde4db36c))
* **chat:** scoped approval manager and blocking approval UX ([24eb0b8](https://github.com/helixnow/deep-student/commit/24eb0b8a57182113b280205022da0d5b943f667b))
* **chat:** skills lifecycle, automations, and runtime roots ([9f79bfd](https://github.com/helixnow/deep-student/commit/9f79bfdb7302c66157e25b5cceead68435aba3cc))
* **chat:** unify conversation controls into plus menu and full-bleed mobile drawer chrome ([dc47688](https://github.com/helixnow/deep-student/commit/dc47688344a33b2ce568236088727879f62c2ca6))
* **chat:** unrestricted host shell tier for danger_full_access ([7191a59](https://github.com/helixnow/deep-student/commit/7191a5910cb41821649380a2991357fb7266d997))
* **chat:** unrestricted tier contracts and race-free preset switching ([03d007c](https://github.com/helixnow/deep-student/commit/03d007cf1bdb92c8a43f6dcab2634ad00acbc895))
* **chat:** workspace and workbench ops overhaul ([71d650e](https://github.com/helixnow/deep-student/commit/71d650e47a69bc88a3a2141138349c2159b797b5))
* **chat:** 侧栏会话筛选菜单（默认隐藏子代理会话）+ 行内指示器与操作簇重叠让位 ([57bf33a](https://github.com/helixnow/deep-student/commit/57bf33a412d592e028ef28ebf317d4ab2be74c70))
* **chat:** 历史消息向上懒加载 UI——顶部横幅/自动触发/重试/exhausted ([dadb7ed](https://github.com/helixnow/deep-student/commit/dadb7edd64e250e50b09f563faf3ae947c2b557c))
* **chat:** 对话控制面板不再显示 DeepSeek V4 采样锁定提示气泡 ([00bed8e](https://github.com/helixnow/deep-student/commit/00bed8e48326a5a7f143db5b5bd15532a70a6959))
* **chat:** 工具轮次默认不限并整体移除 doom loop 机制（长程 agent 支持） ([897411a](https://github.com/helixnow/deep-student/commit/897411afc6bee3b2b074efdeed54f3bb941411ae))
* **chat:** 新增 model_profile_add 工具——agent 经逐次审批后可新增模型配置 ([5e8c1cf](https://github.com/helixnow/deep-student/commit/5e8c1cf143d09e9da2e84d8b0028119f3592e672))
* complete agent workflows and platform hardening ([c273c1e](https://github.com/helixnow/deep-student/commit/c273c1e3cd4599527b4411e59117fa1d88c9486c))
* **components:** 0824 批次共享组件库迭代 ([ee2e28e](https://github.com/helixnow/deep-student/commit/ee2e28ea865652352e2cdc836da0fb4b106b67c0))
* **content:** improve learning hub, notes, and reader workflows ([8bc6018](https://github.com/helixnow/deep-student/commit/8bc6018b15f6e39036852700fa13b2d924a9122d))
* **data:** strengthen backup, sync, and VFS consistency ([62f43cb](https://github.com/helixnow/deep-student/commit/62f43cb1086e6db29d7e3ed85289d26ec7713b0b))
* **debug-panel:** 0824 批次调试面板迭代 ([f71d5ad](https://github.com/helixnow/deep-student/commit/f71d5ad64a10bb9ffc026c16699e2621c2b143a7))
* **demo:** hero 落地页手机模式——去窗壳全宽自适应移动端演示 ([9ee2dac](https://github.com/helixnow/deep-student/commit/9ee2dac3bc7818bd1da2c613bf20a3aeb420febb))
* **demo:** 手机端分页改 transform 分页器——彻底关闭自由滚动 ([e0b6566](https://github.com/helixnow/deep-student/commit/e0b6566c2fe47abd3ab022f839b8eb7009c48aa7))
* **demo:** 手机端多屏竖直滚动——题辞一屏、演示独占一屏 ([8692b5f](https://github.com/helixnow/deep-student/commit/8692b5fdba4778a874d58905445539e497ffe8cb))
* **demo:** 手机端整屏磁吸滚动（scroll-snap） ([da0fcaf](https://github.com/helixnow/deep-student/commit/da0fcaf9d0a331d0b8959ca4e37d921095a8fac2))
* **demo:** 手机端演示不呼出输入法 + 打字速度 2 倍 ([5e1f267](https://github.com/helixnow/deep-student/commit/5e1f267c9aa57c5c4698993b2bc6f8448fe96c22))
* **demo:** 收窄演示壳二三级入口，只留一级功能菜单 ([913ea7f](https://github.com/helixnow/deep-student/commit/913ea7f9cd405cd6b717c23b3c499b88ad961768))
* **demo:** 空态输入框打字机动画——自动播放更像真人操作 ([712db0e](https://github.com/helixnow/deep-student/commit/712db0e33da54061b875ea4bb562047799575704))
* **demo:** 自动播放改为从第一问开始 + 修复侧栏开关被误藏 ([51e52eb](https://github.com/helixnow/deep-student/commit/51e52eb65b7211ad358b26fd0389e9dbe4078f69))
* **demo:** 重写三个剧本会话走差异化能力 + 卡片模板样式与切回闪烁修复 ([ad020b5](https://github.com/helixnow/deep-student/commit/ad020b5f3c454d3c79f1977ed16ea14de70e0cf7))
* **demo:** 门户 Hero 页 + 演示壳收窄主会话交互 + 首屏瘦身 ([86dce6a](https://github.com/helixnow/deep-student/commit/86dce6ae5cdb5d45355dddac5696b64d43a14a4c))
* **demo:** 附件能力完整演示——错题照片缩略图/全屏预览 + 上传PDF面板渲染与页码跳转 ([f098fc9](https://github.com/helixnow/deep-student/commit/f098fc9f2ea1faad1498754cef1477e1156b8b3f))
* **demo:** 首屏预热演示加载 + 加载占位 ([c59685b](https://github.com/helixnow/deep-student/commit/c59685b98578ebbc627397f22f6971eaab197a93))
* **devtools:** unify devtools toggling in a shared helper with tauri command ([f968be4](https://github.com/helixnow/deep-student/commit/f968be4eb0d235db3885762b2511a465abb1083f))
* **dev:** ui-lab 窗口默认落在第二块屏幕，避免占用主屏 ([9975cbb](https://github.com/helixnow/deep-student/commit/9975cbb0ec710f7b9800e41353463309f93d4cad))
* **documents:** secure parsing, export, and multimodal workflows ([65bbc9a](https://github.com/helixnow/deep-student/commit/65bbc9a462195ebb70d77dc84d80ea226ac252b7))
* **dstu:** 0824 批次 dstu 模块迭代 ([de3d98d](https://github.com/helixnow/deep-student/commit/de3d98de55f13b99e3aacbc09cbabdf7b853006d))
* **dstu:** add agent document and canvas operations ([34ee5cc](https://github.com/helixnow/deep-student/commit/34ee5ccf57684b41536e66ef644f479b1c626bdf))
* **essay-grading:** 0824 批次作文批改迭代 ([44af9b8](https://github.com/helixnow/deep-student/commit/44af9b81b6887284833caf94ffffac6458851b3d))
* **features:** 0824 批次其余功能域前端迭代 ([adc834b](https://github.com/helixnow/deep-student/commit/adc834b37c033a54bb89ab48b25173cba8830c9f))
* **fixtures:** add script for generating learning resource preview fixtures ([a271a67](https://github.com/helixnow/deep-student/commit/a271a67164aba5b81cb140d8c08bcdf57e4c15a4))
* **generative-ui:** 0824 批次生成式 UI 前端迭代 ([2302215](https://github.com/helixnow/deep-student/commit/23022152d338cbb8bebddfdead9715e1fb70a1e8))
* **i18n:** 0824 批次本地化与翻译迭代 ([ca3c9e7](https://github.com/helixnow/deep-student/commit/ca3c9e7dbba494e83c1c75eded53fde2f715b4ae))
* **i18n:** enhance lazy-loading and language change handling ([8b57cfa](https://github.com/helixnow/deep-student/commit/8b57cfa24a83d9070ff3d2f34bbbff7c6a76567a))
* **learning-hub:** 0824 批次学习中心前端迭代 ([0e53031](https://github.com/helixnow/deep-student/commit/0e5303143843660fdb571c77285bd9d1e9534ee9))
* **learning:** harden memory, FSRS, and question workflows ([4a24926](https://github.com/helixnow/deep-student/commit/4a2492625558c34c1e1dd5398004ab8b447a887e))
* **llm:** 0824 批次 LLM 管理与 HPIAS 迭代 ([a1a6146](https://github.com/helixnow/deep-student/commit/a1a6146e3cfeaf1c09af330e6b7614e016d8f5dd))
* **llm:** add routing/failover layer and expand provider streaming ([53a22a3](https://github.com/helixnow/deep-student/commit/53a22a3117a28edaf96def34c8c3738bedd54bac))
* **memory:** learner profile, compaction flush, and VFS hardening ([73ad465](https://github.com/helixnow/deep-student/commit/73ad4658a42e6e36da2eecd47d7f9744f3ba7b66))
* **memory:** 吸收 Hermes 策略——画像溢出当轮自合并协议 + 记忆内容安全扫描 ([e0cd8bf](https://github.com/helixnow/deep-student/commit/e0cd8bf78eecdeaf9c09e4c156ac800c05b0c6d1))
* **memory:** 打通记忆蒸馏层到原始会话的回溯链路，记忆模式泛化到工程/通用场景 ([a0906b7](https://github.com/helixnow/deep-student/commit/a0906b75b8701522122d35a9b82f20661fe6a7c1))
* merge os into main for experimental release ([39e7c59](https://github.com/helixnow/deep-student/commit/39e7c591a3e57e81e47d30d380ad70264fc965f1))
* **migration:** absorb safe upstream reliability fixes ([1001b14](https://github.com/helixnow/deep-student/commit/1001b14b3d1882475f088b0cddd6768f19fad024))
* **migration:** absorb verified reliability improvements ([3d81791](https://github.com/helixnow/deep-student/commit/3d81791fcce06668b03a45a612a7ef18fbd9022f))
* **migration:** document upstream optimization absorption plan ([ee9024c](https://github.com/helixnow/deep-student/commit/ee9024cf04006cf986252f25525f30f104f343b5))
* **migration:** harden chat overscroll and settings batching ([b9a1622](https://github.com/helixnow/deep-student/commit/b9a1622dedea993fe530be29ab93fa92c77a33f6))
* **mindmap:** enhance canvas interactions, outline multiselect, and version lookup ([11b057f](https://github.com/helixnow/deep-student/commit/11b057f575b7c5c85621ea43880706a370c28bb0))
* **mindmap:** isolate instances and make batch edits atomic ([48fdd6c](https://github.com/helixnow/deep-student/commit/48fdd6cd87bfa7925a173cbc6f64c9d3e58ab44a))
* **mindmap:** refine interactions, layouts, and import workflows ([3965276](https://github.com/helixnow/deep-student/commit/396527613432cc48ee9aeb1cc681859ae8191b24))
* **mindmap:** split outline view, add layout engines, and mobile toolbar ([f21319f](https://github.com/helixnow/deep-student/commit/f21319fee2660c7c27b8104fd7d38fb1b91be38b))
* **mobile:** polish sidebar nav divider, composer button and empty state ([defa861](https://github.com/helixnow/deep-student/commit/defa8613e7e2cd99391c8e17356347fc96c6783f))
* **mobile:** 六宫格应用启动器移到所有侧栏（抽屉）底部固定 ([636f0d1](https://github.com/helixnow/deep-student/commit/636f0d107ebabd5abdf8a9b99ba70f168ab2fedf))
* **models:** improve provider capabilities and routing controls ([7b1da2d](https://github.com/helixnow/deep-student/commit/7b1da2dc1f2aa70cbc6224ec9fbe72a17facfa11))
* **navigation:** 移动端应用启动器收口 + 导航去重，附输入栏/时间线/hero 页配套改动 ([86212db](https://github.com/helixnow/deep-student/commit/86212dbbd3b6f7f1b9b085ac7a8db8d2e77937be))
* **notes,learning-hub:** add note tags, agent follow, and exam view rework ([b647e81](https://github.com/helixnow/deep-student/commit/b647e81e610abbfc44de1ffdddbb4c9d08940bab))
* **notes,learning-hub:** improve editing, previews, and navigation ([1b009e6](https://github.com/helixnow/deep-student/commit/1b009e67ef3c5a6cc738421ff48447a63f33d651))
* **notes,learning-hub:** rework pdf viewer, media players, and crepe plugins ([805279a](https://github.com/helixnow/deep-student/commit/805279ab262bc4e35f0ee35fcd6a5566d59fb91a))
* **notes,mindmap:** introduce comprehensive UI/UX remediation prompt and enhance command palette functionality ([0f44c91](https://github.com/helixnow/deep-student/commit/0f44c913e29eb8dd19077a47b061f755eb79913b))
* **notes:** 0824 批次笔记与脑图前端迭代 ([4ad43ab](https://github.com/helixnow/deep-student/commit/4ad43ab77f4db041ad1d6526eec314bfcfa568a8))
* **notes:** harden editor save paths and notes export ([94c0588](https://github.com/helixnow/deep-student/commit/94c0588352684ba147e1f62f0cfa8a1f81fa2880))
* **pdf:** backfill missing historical previews ([1ea4b89](https://github.com/helixnow/deep-student/commit/1ea4b897def4c402bc1b4b43701155b6453fe162))
* **pdf:** schedule historical preview backfill ([760dd31](https://github.com/helixnow/deep-student/commit/760dd31d99e248e0ada0b084905df7c61ef5e793))
* **platform:** 0824 批次前端平台层（hooks/stores/utils/shared/styles）迭代 ([97a678e](https://github.com/helixnow/deep-student/commit/97a678e2cb4933659d7da87b5c13846b975281fb))
* **platform:** harden backup, sync, storage, and recovery ([8a68823](https://github.com/helixnow/deep-student/commit/8a68823ec5517c998a794ebf1f3cd239efc0e745))
* **platform:** harden storage layer, memory dedup, and system services ([c006f45](https://github.com/helixnow/deep-student/commit/c006f457b00939add5f4f4236f2eaac6c15b21a7))
* **platform:** rework notes storage, migration safety rails, and media backend ([027670a](https://github.com/helixnow/deep-student/commit/027670a6123cf3a52dfee94dcbaa9d39415bf2a3))
* **plugins:** add managed extensions and iLink bot integration ([59df0ab](https://github.com/helixnow/deep-student/commit/59df0ab4722bcffa0a173a7fbbacc1913a7d6675))
* **practice,anki:** add structured question types and stats charts ([c2c9e33](https://github.com/helixnow/deep-student/commit/c2c9e3345cfed8b31253f9a1d0e5f0556c3a6f85))
* **practice,anki:** improve question banks, review, and card workflows ([1cc9be7](https://github.com/helixnow/deep-student/commit/1cc9be741da30e928cef5015169d9da7f9f55d71))
* **practice,anki:** rework flashcards screens and template management ([5ec5c29](https://github.com/helixnow/deep-student/commit/5ec5c294e254ab46e959719e3809ed8a033d5c00))
* **productivity:** refresh todo, pomodoro, and sandbox UI ([7443da4](https://github.com/helixnow/deep-student/commit/7443da4049ed96f9c88a1d2fd60511ca121339cd))
* **qbank:** expand question management and review workflows ([2d7b76c](https://github.com/helixnow/deep-student/commit/2d7b76c4f78cd6af6839a0da62727d82384da26f))
* **qbank:** unify exam tab visuals with manage-view style and fix wrong-answer tracking ([cea6c04](https://github.com/helixnow/deep-student/commit/cea6c044babe9b140a3444c47e29451ca2afc43b))
* **scroll:** platform-aware track click and native scrollbar polish ([e1a76c5](https://github.com/helixnow/deep-student/commit/e1a76c5666cd678a2fedb29a49fb52e282a8857f))
* **settings,data:** 移动端模型编辑与数据中心界面修订 ([b063340](https://github.com/helixnow/deep-student/commit/b0633401a17cf2d3009e86b557ba787d1f569136))
* **settings:** 0824 批次设置页面前端迭代 ([e2562ee](https://github.com/helixnow/deep-student/commit/e2562ee5ec5f16e48fe791c43ec871d92800e6be))
* **settings:** add system permissions and subagent profiles sections ([1d2a964](https://github.com/helixnow/deep-student/commit/1d2a9647e1dcea99ea35c95e295d9781a091dd3e))
* **settings:** add workbench settings section and shell UX polish ([45e424c](https://github.com/helixnow/deep-student/commit/45e424c476a1c695b9337d0c8091593ec82e8328))
* **settings:** expand models, permissions, and system controls ([d89e772](https://github.com/helixnow/deep-student/commit/d89e772776983cc845605e93316fd99b2542bf8a))
* **settings:** MCP 页移动端交互统一与 Subagent 按钮降噪 ([bb205bf](https://github.com/helixnow/deep-student/commit/bb205bf662087ba0de7196016cdbef48999404e1))
* **settings:** present mobile settings as a full-screen sheet ([c54e0fb](https://github.com/helixnow/deep-student/commit/c54e0fb5eb210d87e3399794c4987cbfc47d1566))
* **settings:** redesign mobile settings home as two-column card grid ([e8cc328](https://github.com/helixnow/deep-student/commit/e8cc328cd08e55b6436b134b2c12a0d4defcad56))
* **settings:** require explicit save for API keys with paste sanitization and temporary reveal ([b1ad1a1](https://github.com/helixnow/deep-student/commit/b1ad1a12ae3036acc5d388d7493c272c7e5934db))
* **settings:** rework automation section and vendor configuration ([6d9abf2](https://github.com/helixnow/deep-student/commit/6d9abf297ae800c3d7048c173cb53cf5db529877))
* **settings:** show DeepSeek account balance badge for official vendors ([7428b10](https://github.com/helixnow/deep-student/commit/7428b102924c8fe6a2b1789f862f0a15b8a59e72))
* **settings:** 供应商 key 录入入口可发现性（P3-10） ([ab8d01f](https://github.com/helixnow/deep-student/commit/ab8d01fa2f012521423f3bece18530bf3cdd0449))
* **settings:** 子页面分区卡片改无描边纯填充灰卡，小标题外置 ([024f4fc](https://github.com/helixnow/deep-student/commit/024f4fc8781f5fa334c365374c183470508ac9e2))
* **settings:** 拆分超长设置页——语音听写/记忆/学习桌面/文档处理独立分区 ([265a79b](https://github.com/helixnow/deep-student/commit/265a79bc45e7dfe0111df35bb670a99bd523cb5a))
* **settings:** 桌面端获取可用模型改回内联卡片，移除 Dialog 形态 ([962807d](https://github.com/helixnow/deep-student/commit/962807d7d0028695598ace0c7d28c1ee5aec189e))
* **settings:** 模型供应商移动端界面精简与按钮降噪 ([dc97a95](https://github.com/helixnow/deep-student/commit/dc97a95182716c42a0ddd50c84eefaadf2498f14))
* **settings:** 移动 UI 设置内按钮统一右&lt;|sep|&gt; ([44e821e](https://github.com/helixnow/deep-student/commit/44e821e565f4d6d570d7a629ee70fcb0e8beaaed))
* **settings:** 自定义区域卡无描边灰填充 + 次级操作按钮统一描边 ([40e4c94](https://github.com/helixnow/deep-student/commit/40e4c941ae1cded1bbf51f3425069f2ccb670476))
* **settings:** 页内层级切换动画 ShellViewSwitch，前进/后退方向互为镜像 ([18f7a11](https://github.com/helixnow/deep-student/commit/18f7a1129deb6d497e693d04ef40a6716ac39c14))
* **shell:** inline title editing, sidebar action cluster, and collapse surface motion ([6ddf325](https://github.com/helixnow/deep-student/commit/6ddf3255bdd7c53130f3103581073142dcae2990))
* **shell:** show new-session action when sidebar collapsed ([1ad0074](https://github.com/helixnow/deep-student/commit/1ad0074cde85f059f6fa6096f3351a49d8f6c69b))
* **shell:** Windows PowerShell 5.1 语法三层引导——消除 bash 语法盲试循环 ([b881316](https://github.com/helixnow/deep-student/commit/b881316691282a7abae75a8d6de148774996fa16))
* **sidebar:** reveal create-conversation action on section hover ([8bc50b5](https://github.com/helixnow/deep-student/commit/8bc50b51e5640a0e5a64075e145a1eaf238cec3f))
* **skills,workbench,anki:** expand skill ecosystem with tap sources and task management ([544d270](https://github.com/helixnow/deep-student/commit/544d270aa69cbc3e77f3643b83b2e763cfeaad87))
* **skills:** improve managed tool configuration surfaces ([8f1d0e1](https://github.com/helixnow/deep-student/commit/8f1d0e1ea9c22e063bb6e70f9bd5bf625fb922cb))
* **skills:** migrate community marketplace and runtime admission ([930bd22](https://github.com/helixnow/deep-student/commit/930bd22d82c9a0ce8b2cf7b0d89a7cc4ef6c2a7c))
* **skills:** support JSON Schema composition keywords ([37ae1d5](https://github.com/helixnow/deep-student/commit/37ae1d572712827d65b3bd38c50d753334a50736))
* **sync:** harden cloud conflict and restore handling ([90fe67d](https://github.com/helixnow/deep-student/commit/90fe67dea1066c63ebd7e6062717a545367db358))
* **sync:** 云存储等待窗口状态透传前端——消除限流/退避期假卡死 ([fbd6cc2](https://github.com/helixnow/deep-student/commit/fbd6cc2f059e714fb000ef2b4e69566d6053368f))
* **sync:** 协作式取消 + WebDAV 传输健壮性 ([818db13](https://github.com/helixnow/deep-student/commit/818db13d4dc87e0875581aefecc92addcd0fd3d5))
* **theme:** add bright-pink accent palette ([13f1819](https://github.com/helixnow/deep-student/commit/13f1819bee91b388c5e9769eaa733114d83e1afa))
* **theme:** sync native macOS window appearance with app theme ([7d682fe](https://github.com/helixnow/deep-student/commit/7d682febb07c1e3b4b74d7fce014e367e650825f))
* **todo,pomodoro:** decompose main panel and add automation workspace ([dafdfdb](https://github.com/helixnow/deep-student/commit/dafdfdb223ccdad87914606568eb7122b300fd55))
* **todo,pomodoro:** redesign task detail and add pomodoro stats sync ([08130d5](https://github.com/helixnow/deep-student/commit/08130d50de34f2fe864c5f1950e7fbed50a2a3eb))
* **todo,pomodoro:** refine task and focus workflows ([90bc551](https://github.com/helixnow/deep-student/commit/90bc551d8a96028b2112e004c9c2e8df907201ff))
* **todo,skills,workbench:** 页面工具栏迁入全局顶栏，消除三层条带堆叠 ([478f8f0](https://github.com/helixnow/deep-student/commit/478f8f01ce8c40a2fc4943c383d6b1852dc55477))
* **tooltip:** fade-out animation with CSS variable driven duration ([e4a6ead](https://github.com/helixnow/deep-student/commit/e4a6ead58dcbd4629d742646bc9108f1243ad87c))
* **translation,essay-grading:** add candidate pipeline and inline grading settings ([698f111](https://github.com/helixnow/deep-student/commit/698f111116ddc4fa367dece8a7aa17f1709a3bea))
* **translation,essay-grading:** improve review and grading workbenches ([69d7557](https://github.com/helixnow/deep-student/commit/69d755764ad703f8fe2a1c789329f9c6dcdaa30b))
* **translation,essay-grading:** rework streaming workbenches end to end ([04774b9](https://github.com/helixnow/deep-student/commit/04774b9d7dc13b0b89c2cc90d7c415659584a9ee))
* **ui, learning-hub:** enhance UI responsiveness and silent refresh logic ([55c914b](https://github.com/helixnow/deep-student/commit/55c914b95b426046b6bb6ecbc9e3b4b9e045a68c))
* **ui:** enhance responsiveness and accessibility across components ([edf04d2](https://github.com/helixnow/deep-student/commit/edf04d24e0463cc488f56d269192563754b062a0))
* **ui:** sidebar hover polish, scrolling labels, and accordion motion ([efa8d34](https://github.com/helixnow/deep-student/commit/efa8d34da0d9757dc9761f0476af216e3f4d6227))
* **ui:** update translation, dashboard, and misc feature surfaces ([a524259](https://github.com/helixnow/deep-student/commit/a524259fd616dc0dfc1e27ed52999a9c2c4bd6ea))
* **vfs:** add multimodal retrieval and vector index profiles ([d6623cd](https://github.com/helixnow/deep-student/commit/d6623cdabff3e73e814dba93e05bae1647d9a3c9))
* VLM grounding fallback, prompt-cache replay consistency, deepseek Responses API, release metadata refresh ([#152](https://github.com/helixnow/deep-student/issues/152)) ([f473a6d](https://github.com/helixnow/deep-student/commit/f473a6d6495ecf848997eee5a46b5827e49ba7fb))
* **workbench,quick-assistant:** add quick assistant window and enhance app icon system ([38e590b](https://github.com/helixnow/deep-student/commit/38e590bc07f8c21893418a4b527d79d93dd67597))
* **workbench,ui:** expand workbench mode switcher and enhance icon system ([fc287b7](https://github.com/helixnow/deep-student/commit/fc287b7d42321a303909a60472fe58ab48b6fc8f))
* **workbench:** 0824 批次工作台前端迭代 ([8fa9d38](https://github.com/helixnow/deep-student/commit/8fa9d38b68a5010c5ec7f34e107bc6100e4b0e12))
* **workbench:** add agent manifests with ACR4 tests and dock visuals ([9220f15](https://github.com/helixnow/deep-student/commit/9220f15e3bbb2d5f6f464f322d4e46d85f83edd1))
* **workbench:** add wallpapers, shortcuts, and native materials ([ded47a4](https://github.com/helixnow/deep-student/commit/ded47a4ee6ee7b95dc006a1e007a89d1cf60cfea))
* **workbench:** expand desktop workspace and navigation surfaces ([b6883dc](https://github.com/helixnow/deep-student/commit/b6883dcaf6673b34187f722821fb9d0781c7f298))
* **workbench:** harden window lifecycle and content apps ([36b4bbe](https://github.com/helixnow/deep-student/commit/36b4bbea873d3e1616ab88d08a14aebf5283ed9c))
* **workbench:** implement agent runtime, control center, and app manifests ([203175b](https://github.com/helixnow/deep-student/commit/203175bde79a42f539268d92b24d432dfb122a3e))
* **workbench:** integrate notes workspace, mind-map refinements, and agenda widget ([a713b52](https://github.com/helixnow/deep-student/commit/a713b528a8585d3fe61e8e0ece9ab23edb77742e))
* **workbench:** redesign Agent Control Center UI and fix popover layout issues ([71dfc4c](https://github.com/helixnow/deep-student/commit/71dfc4c62e5ad3da6088a53cb5aacf68a01a5f39))
* **workbench:** refine notes UI, harden sync contracts, and enhance IME handling ([dd8ac47](https://github.com/helixnow/deep-student/commit/dd8ac47c4726891f429a3c6f74d20ed4867df008))
* **workbench:** rework notes app surfaces, previews, and perf pause logic ([59331f1](https://github.com/helixnow/deep-student/commit/59331f128c2ffc7ffcc011b74899767060e7f244))
* **workspace:** add coding navigation and git tools ([86b4fee](https://github.com/helixnow/deep-student/commit/86b4fee1e302306a1c0cc65c50a05618751a9b6d))
* **workspace:** 新增 workspace_file_edit 局部编辑工具，补齐 coding 能力最关键的'手' ([8fcdf05](https://github.com/helixnow/deep-student/commit/8fcdf05c7285a4be164b853247c5f3e5c9b78953))


### Bug Fixes

* **a11y:** P3-11 会话列表项补 role=button/tabIndex 与键盘激活 ([cd255cc](https://github.com/helixnow/deep-student/commit/cd255cc0453528e816af5d57e519fe5c6b35ada7))
* **a11y:** P3-9 弹层可访问名——AppMenu 菜单兜底用触发器命名，DsAlertDialog 接线标题 ([e5a3258](https://github.com/helixnow/deep-student/commit/e5a325842dc460edb244ef8568f674cdb561f5f6))
* **android:** apk_installer 用全限定 Manager::manage——修复 mobile-slim Android 构建 E0599（trait 未导入） ([412e853](https://github.com/helixnow/deep-student/commit/412e853360b50095315dbf640e711c9432e2c39b))
* **android:** guard desktop-only browser APIs ([c6c497c](https://github.com/helixnow/deep-student/commit/c6c497c2ad8a16817bb52809b482d686d6563e14))
* **android:** guard desktop-only browser APIs ([dd44bce](https://github.com/helixnow/deep-student/commit/dd44bce27b539f9544ab50a8c28ec9ed4d120281))
* **android:** MainActivity.kt doc 注释内 `/*` 触发 Kotlin 嵌套块注释致 EOF 未闭合——改写路径表述 ([6e49d41](https://github.com/helixnow/deep-student/commit/6e49d41065690e6c9ef1a91a895480fe9d5cb74b))
* **anki:** 卡面 iframe 显式主题背景——修复移动端深色全白不可见 ([d1bb509](https://github.com/helixnow/deep-student/commit/d1bb5090ae5f83a3807314c229fd18b6d4751d0d))
* **automation-ui:** preserve agent prompts and protect heartbeat ([51052fe](https://github.com/helixnow/deep-student/commit/51052fe7ec782d2c20120138cdd2898b02144ddc))
* **automation:** harden scheduler runtime and recovery ([9c24e06](https://github.com/helixnow/deep-student/commit/9c24e0694164b6c084d1274740c7fc92483a914b))
* backfill missing VFS tables before change_log pre-repair ([b2a85a6](https://github.com/helixnow/deep-student/commit/b2a85a6900034943a2bedb7c5ebcf95ec7854fea))
* **build:** align Android version baseline ([2da873e](https://github.com/helixnow/deep-student/commit/2da873ecde140181d73999c6325498eeae8711a3))
* **build:** align Android version baseline with v0.9.53 release ([a1eaa24](https://github.com/helixnow/deep-student/commit/a1eaa2425d1c4077bd4d374da961f0641c534710))
* **build:** bump Android baseline to v0.9.54, fix release-please annotation ([a80956f](https://github.com/helixnow/deep-student/commit/a80956fd3ce50fae59a07e5c615b060cf5211997))
* **button-audit:** 修复阻塞发版的 tsc 错误——items 数组字面量 union widening 加 as AuditItem[]、SegmentedControl onValueChange 类型适配、补 notes-misc 缺失的 note 字段 ([4c49b58](https://github.com/helixnow/deep-student/commit/4c49b58ece672f3f722bd76e190751aa7c1d47ac))
* **chat_v2:** 0824 批次后端会话/工具链迭代与 Windows 沙箱保护修复 ([5e29fc4](https://github.com/helixnow/deep-student/commit/5e29fc458026aa09ff020d121ad07a57918c360f))
* **chat_v2:** advance CURRENT_SCHEMA_VERSION to 20260806 ([#154](https://github.com/helixnow/deep-student/issues/154)) ([1cf6cab](https://github.com/helixnow/deep-student/commit/1cf6cabc2ba1f9fea2c7d2819849db25853baab6))
* **chat_v2:** preflight 暴露不可降级守卫的 Deny 判定 ([25f662a](https://github.com/helixnow/deep-student/commit/25f662ae2ff17555f768f4692d480e3ad4c5a3fe))
* **chat_v2:** 完全信任档 preflight 允许绝对路径 cwd ([690f3e9](https://github.com/helixnow/deep-student/commit/690f3e9c5ce49b7c3f1806bec1fe3c4bb8216932))
* **chat_v2:** 完全信任档审批绑定允许绝对路径 cwd ([32c83d6](https://github.com/helixnow/deep-student/commit/32c83d6e40996e492b5695002de31b3d8a7e6022))
* **chat-markdown:** restore spacing between streamed blocks ([ee2cd28](https://github.com/helixnow/deep-student/commit/ee2cd28b1f4482591588254facd6775ad97831a7))
* **chat:** admit packed tools through pipeline ([586cf30](https://github.com/helixnow/deep-student/commit/586cf30eb81444434509251a9b89053da8190f54))
* **chat:** align retired authority and host cwd ([b7d74a5](https://github.com/helixnow/deep-student/commit/b7d74a596885d1351cadf96765eb82270b6d9d6d))
* **chat:** dedupe overlapping sessions in the sidebar feed ([6c1903c](https://github.com/helixnow/deep-student/commit/6c1903ccc844f849b25c1ca8934e9a752c5c3884))
* **chat:** enforce snapshot import size limit ([8892af5](https://github.com/helixnow/deep-student/commit/8892af59ad04a1cf3c29ca5ba2a4a93eb610546e))
* **chat:** guard snapshot file import size ([e9b42f9](https://github.com/helixnow/deep-student/commit/e9b42f9325666ee11481c748e09c72f7c7a94aeb))
* **chat:** harden file reads and exports ([603a57e](https://github.com/helixnow/deep-student/commit/603a57e433b9230f2536671a49ae6e23676ec2f2))
* **chat:** isolate stale streams and corrupt history records ([1d2302e](https://github.com/helixnow/deep-student/commit/1d2302e59639e1eb9dc1462e4b310c4384b8dc41))
* **chat:** keep an empty current-session title empty in the shell ([049e7a4](https://github.com/helixnow/deep-student/commit/049e7a4fa9c70f2bf6ab5b3debfb0ecd3caa7d16))
* **chat:** keep translation popover within viewport ([caa756f](https://github.com/helixnow/deep-student/commit/caa756f2dfe225be031a592f289dd653595a847c))
* **chat:** PR [#376](https://github.com/helixnow/deep-student/issues/376) 合并后修复——匿名 Job 防跨执行误杀 + 测试同步 ([1fef7e1](https://github.com/helixnow/deep-student/commit/1fef7e108b975ea75129f46bd96311f02674a442))
* **chat:** register goal commands in permissions manifest ([b13be90](https://github.com/helixnow/deep-student/commit/b13be90fd64d2e83f38f56a6520d0afe45723d08))
* **chat:** repair attachments and Windows shell payloads ([a538280](https://github.com/helixnow/deep-student/commit/a5382801f7976b052dc90428ef0ded381670452f))
* **chat:** retry empty model responses ([481c6ef](https://github.com/helixnow/deep-student/commit/481c6efe20d88bc305af9a91ab4bbc04beb6632d))
* **chat:** tolerate legacy stores without goal fetcher ([74255e9](https://github.com/helixnow/deep-student/commit/74255e9788f059c12b759762e965d334f9ae3485))
* **chat:** tolerate partial staged restore payloads ([34d7216](https://github.com/helixnow/deep-student/commit/34d7216284457d2be5b5164cee583f16fb9c5b42))
* **chat:** use typed snapshot API schemas ([cf7e9d5](https://github.com/helixnow/deep-student/commit/cf7e9d5d9b7ca3ec30c6de5f165f42120ec90180))
* **chat:** validate record identifiers during staged restore ([3eb31e1](https://github.com/helixnow/deep-student/commit/3eb31e19acf3ec71061aa8c5e4da5e4fb5efc168))
* **chat:** 制卡事件合并缓冲，修复批量制卡前端 O(N²) 卡顿 ([d5dcc18](https://github.com/helixnow/deep-student/commit/d5dcc186674640ba81a1eb3bdfecad37faca9c81))
* **chat:** 制卡事件合并缓冲，修复批量制卡前端 O(N²) 卡顿 ([5df87c3](https://github.com/helixnow/deep-student/commit/5df87c3fbb53613a23497544ab58f2ce1921f77a))
* **chat:** 子代理 wait=true 同步交付后不再被完成事件二次唤醒 ([10934c2](https://github.com/helixnow/deep-student/commit/10934c21e63769bbc34a7a2a63915d2c06acbf13))
* **chat:** 审批卡技术细节默认折叠——对齐 Claude Code 的极简审批面 ([d7ce14d](https://github.com/helixnow/deep-student/commit/d7ce14def4608ae728988ec9124710323b9a096a))
* **chat:** 审批已决态即点即出队——APPROVAL_RESOLUTION_DISPLAY_MS 1000ms→0 ([dd46b14](https://github.com/helixnow/deep-student/commit/dd46b149b3554962eea8bcf88a100206ee052ae4))
* **chat:** 审批栏卡死——approval_expired 反复弹通知但审批栏不消失 ([dbfc7d0](https://github.com/helixnow/deep-student/commit/dbfc7d0de4e6139e3502246c6846aeecc7562a6a))
* **chat:** 晚到/重放块按时间戳稳定归位——流式期间乱序块不再沉底 ([3e3a470](https://github.com/helixnow/deep-student/commit/3e3a47087d5cc2b280f3b1d3b4f27df3747b83ba))
* **chat:** 移动端欢迎空态不再显示 Ctrl/⌘+N 键盘快捷键提示 ([3d2bb2a](https://github.com/helixnow/deep-student/commit/3d2bb2a6dfce1892a33dce2367e73d5cb2d9c961))
* **chat:** 闪卡复习按钮移动端隐藏，避免仅桌面端可用的死路动作 ([ccd6f43](https://github.com/helixnow/deep-student/commit/ccd6f43775b822e866577f864ce7edc775d2fca8))
* **ci:** allow explicit fixture override for release recovery ([f5a88a8](https://github.com/helixnow/deep-student/commit/f5a88a83f33c5985d88bf7fd1938155c95987685))
* **ci:** allow explicit fixture override for release recovery ([7ddc93d](https://github.com/helixnow/deep-student/commit/7ddc93df77e7090acc045ab69ee7273aa40eb29f))
* **ci:** allow explicit unsigned desktop release recovery ([d1875b6](https://github.com/helixnow/deep-student/commit/d1875b6d08759bd239d7dd9ffb873a13a54a1d0e))
* **ci:** allow explicit unsigned desktop release recovery ([04361b6](https://github.com/helixnow/deep-student/commit/04361b685eb34a388907f4a24980536cef75f4c0))
* **ci:** Android 作业接入 sccache——runner 回收后编译单元不丢 ([05f2a78](https://github.com/helixnow/deep-student/commit/05f2a7804d5c1d30286f292eb75f283c418b637d))
* **ci:** build only Android APK ([0b199ae](https://github.com/helixnow/deep-student/commit/0b199ae84b52437634975df31e1f5b7f76cdaa51))
* **ci:** build only Android APK ([608f2ad](https://github.com/helixnow/deep-student/commit/608f2ad5e550826bbe083d0c44b993cc53795866))
* **ci:** build only NSIS on Windows releases ([5cf2819](https://github.com/helixnow/deep-student/commit/5cf281909eb61ec3faef3135eac4669014f9c87d))
* **ci:** build only NSIS on Windows releases ([b41a835](https://github.com/helixnow/deep-student/commit/b41a83532b3e5b30d48c11d422d50bd65afdf892))
* **ci:** Cloud Provider Contract Gate 按 provider 拆 matrix 并行 ([2ef82f6](https://github.com/helixnow/deep-student/commit/2ef82f6dc3630de6c738dd91af6d9f5e20f4a896))
* **ci:** extend macOS release build timeout ([db16fd8](https://github.com/helixnow/deep-student/commit/db16fd864ca3a1b74f3361b9cbb7d5ffacc4e11a))
* **ci:** extend macOS release build timeout ([f6accc4](https://github.com/helixnow/deep-student/commit/f6accc47133b9c85beb4eb18033fec400938a007))
* **ci:** fetch full history for migration release gate ([cdd9d73](https://github.com/helixnow/deep-student/commit/cdd9d73aad25929061cb5fc35018a986799dc6a9))
* **ci:** fetch full history for migration release gate ([211f138](https://github.com/helixnow/deep-student/commit/211f1386463b31427e2e01777364d2e5f36126cb))
* **ci:** finish v0.9.43 Android recovery build ([9834207](https://github.com/helixnow/deep-student/commit/983420766c0dbbc0f49ae0501420669823081ed1))
* **ci:** flatten Linux hotfix artifacts ([fdee8aa](https://github.com/helixnow/deep-student/commit/fdee8aa2a0d0a4fc354d8c87b679510f04901c02))
* **ci:** flatten Linux hotfix artifacts ([#146](https://github.com/helixnow/deep-student/issues/146)) ([b10b0bb](https://github.com/helixnow/deep-student/commit/b10b0bb9cdbf2fce55b563f535365ce1a37298b3))
* **ci:** include version in macOS updater archive names ([#156](https://github.com/helixnow/deep-student/issues/156)) ([0e4c9fa](https://github.com/helixnow/deep-student/commit/0e4c9fad55aee40c42418ada71b6d03caecc25ec))
* **ci:** isolate Android recovery queues ([cccad99](https://github.com/helixnow/deep-student/commit/cccad99f46c18b3f27904789712f562357e5e736))
* **ci:** isolate Android recovery queues ([793b196](https://github.com/helixnow/deep-student/commit/793b1961db34d17a491aef047110f9842809cf5b))
* **ci:** make release workflows parse on GitHub Actions ([9a3572d](https://github.com/helixnow/deep-student/commit/9a3572ddaa75228d0aa70a2146cfb0c356cdfcef))
* **ci:** make unsigned macOS recovery builds work ([336d6a3](https://github.com/helixnow/deep-student/commit/336d6a3e7a62427bbb2089206b92a9ffd9852186))
* **ci:** make unsigned macOS recovery builds work ([#147](https://github.com/helixnow/deep-student/issues/147)) ([30fdf51](https://github.com/helixnow/deep-student/commit/30fdf51cd832b38daf8d660ff06b7c6fa1780c03))
* **ci:** mark rebuilt Android release available ([3e2e914](https://github.com/helixnow/deep-student/commit/3e2e91496d4bd06b93dd923c8eed7ae8f7154387))
* **ci:** mark rebuilt Android release available ([e80b159](https://github.com/helixnow/deep-student/commit/e80b159ca0e90c2f6fc65263d1bd1e9eace2672b))
* **ci:** multipart upload large R2 release assets ([30b830c](https://github.com/helixnow/deep-student/commit/30b830cec4918bfd6137dadd4990635b4aa6ec9c))
* **ci:** multipart upload large R2 release assets ([2d9de10](https://github.com/helixnow/deep-student/commit/2d9de1089a5203678c6af61c072e85bafe051367))
* **ci:** overlay macOS release tooling ([7bc74ca](https://github.com/helixnow/deep-student/commit/7bc74cae697163a14609cfb03c5974ae81e48d32))
* **ci:** overlay macOS release tooling ([32586f3](https://github.com/helixnow/deep-student/commit/32586f30ee6da642296815837b7b8f9cfdda5e49))
* **ci:** overlay release fixture harness ([41f72ef](https://github.com/helixnow/deep-student/commit/41f72efcb4829f6f0a072e68cbe0d70c8b13a5b4))
* **ci:** overlay release fixture harness ([943b067](https://github.com/helixnow/deep-student/commit/943b06725d59ba82feda4dce9280eb154a1e88e5))
* **ci:** provision release migration fixture ([0e6f8d1](https://github.com/helixnow/deep-student/commit/0e6f8d1fa5b23ab7163edb489f85ad6c3a0333b8))
* **ci:** provision strict release migration fixture ([cb54533](https://github.com/helixnow/deep-student/commit/cb54533344ecfc5de2439c2ce44bfdb02c5d5d8d))
* **ci:** reduce Android release compile latency ([342e961](https://github.com/helixnow/deep-student/commit/342e961f0237ed8b9f031d6892df961f7c810117))
* **ci:** reduce Android release compile latency ([#145](https://github.com/helixnow/deep-student/issues/145)) ([4240f4d](https://github.com/helixnow/deep-student/commit/4240f4d9e74cac5da4fdcca451caf32d7fc5ede0))
* **ci:** refresh release lock metadata before packaging ([ea7896c](https://github.com/helixnow/deep-student/commit/ea7896c2bbd2f1960b52300f8be31c9d804f96a1))
* **ci:** refresh release lock metadata before packaging ([9df69c4](https://github.com/helixnow/deep-student/commit/9df69c4c98eaa2797653728615675b28cae3a148))
* **ci:** release catch-up 恢复门禁——tag 指向 release 提交的下游合并提交时兼容接受；catch-up 扫描遇到已发布的更新版本即停止（更早未发布 release 视为已被取代，防止坏 release commit 毒化后续每次 push） ([26391fb](https://github.com/helixnow/deep-student/commit/26391fb4ea0c597c1b15183280ee306003aced64))
* **ci:** restore GitHub Actions release workflow parsing ([d5d8647](https://github.com/helixnow/deep-student/commit/d5d8647cd946ec79df44d7005a282e445afd2ac8))
* **ci:** retry pdfium downloads ([201be66](https://github.com/helixnow/deep-student/commit/201be668e5a974779725416b3d0f81c631f175fd))
* **ci:** retry pdfium downloads ([a677bbc](https://github.com/helixnow/deep-student/commit/a677bbcaa025aed975105ab992ce902f4366ecd3))
* **ci:** shorten Android release compilation ([058808a](https://github.com/helixnow/deep-student/commit/058808ad9d11009eace360120a244ee9cda445dd))
* **ci:** shorten Android release compilation ([f0f5145](https://github.com/helixnow/deep-student/commit/f0f514502a111c191833f8f8262219d611b5f071))
* **ci:** stabilize release builds across hosted runners ([bac0b36](https://github.com/helixnow/deep-student/commit/bac0b366972605da2e22eb75704314e5219eb20e))
* **ci:** stabilize release builds across hosted runners ([5740392](https://github.com/helixnow/deep-student/commit/5740392e4029ef7a1d40ab3fecafdefad10329b5))
* **ci:** support Tauri v2 Linux updater artifacts ([78ad9bc](https://github.com/helixnow/deep-student/commit/78ad9bc67b0ad898ef40ec23cca4ac1567a0fdca))
* **ci:** support Tauri v2 Linux updater artifacts ([#144](https://github.com/helixnow/deep-student/issues/144)) ([d420ec0](https://github.com/helixnow/deep-student/commit/d420ec0dfe8bee9f9b59aa2dc0ff6e9b32389125))
* **ci:** use lean Android release feature profile ([5738930](https://github.com/helixnow/deep-student/commit/5738930ef28aaf1605638c3a3ec2e2d5d2e3a537))
* **ci:** Vitest 长尾 17 文件 160 例全绿 + Migration Gate 钉版 ([3389725](https://github.com/helixnow/deep-student/commit/3389725b2f4a95e7ddc799f3d9a141daf491e9cb))
* **ci:** 修复 main 基线五项红项——lint/迁移锁/测试 mock/样式契约 ([7f8be1d](https://github.com/helixnow/deep-student/commit/7f8be1d8eda1726b3ed6ef3d227527ddcd96abb1))
* **ci:** 修复 Vitest 2/4+3/4 基线——18 例失败全修（118 绿） ([d5c41f1](https://github.com/helixnow/deep-student/commit/d5c41f166c16dc65d69f3475be02bc77ca34555d))
* **ci:** 根治 Android 构建连败与 runner 回收——堆上限/钉版/fmt ([1727aaa](https://github.com/helixnow/deep-student/commit/1727aaa5c3f623db477b5b42ef56e08047416218))
* **command-palette:** 取消过期聚焦 rAF——Esc 竞态致焦点掉 body；CI 缓存随钉版镜像隔离 ([21adb95](https://github.com/helixnow/deep-student/commit/21adb9539dee0baefd9657deb6590a4f043ac8b1))
* **data:** recover chat_v2 schema fingerprint drift ([f174231](https://github.com/helixnow/deep-student/commit/f174231a8af2596d5471b2783138db04081ba218))
* **demo:** 修手机磁吸手感——几何稳定 + 逐屏停驻 ([7f3c5a3](https://github.com/helixnow/deep-student/commit/7f3c5a31add0946a9ef94291baf4dc9a2e7f8381))
* **demo:** 手机端刊头改为随题辞屏滚走，不再遮挡演示区 ([b6ab1bf](https://github.com/helixnow/deep-student/commit/b6ab1bf9d8a97cb554cfd163a75a3f935f36561c))
* **demo:** 手机端整屏分页改 JS 实现——根治回弹与惯性过头 ([55f5348](https://github.com/helixnow/deep-student/commit/55f5348da7b1a386fa121926f50abad0623ad631))
* **demo:** 消除"已自动分配6个模型"气泡等演示痕迹 ([eb3cc10](https://github.com/helixnow/deep-student/commit/eb3cc1019dc87bece00a53ede4f30f4a856f6e2d))
* **demo:** 补 dstu_list mock——修手机端右滑资源库崩溃 ([c8c3f7c](https://github.com/helixnow/deep-student/commit/c8c3f7caade9fee65252fe2b55758d613c0781a9))
* **dev:** restore opaque window and IPv4 dev loading ([35c892b](https://github.com/helixnow/deep-student/commit/35c892b519f83948b28012ff5aee167791287442))
* **editor:** stabilize note saves, search, and keyboard flows ([0628707](https://github.com/helixnow/deep-student/commit/062870732be4a26b77d3ceabcc554c024e5c2593))
* **governance:** 0824 批次数据治理与迁移修复 ([6aec935](https://github.com/helixnow/deep-student/commit/6aec93509e7c41ba9eeec78180abbb9741dbd430))
* **learning-hub:** 移除挤压主内容区的 GenerativeBriefing 简报组件 ([8adb78d](https://github.com/helixnow/deep-student/commit/8adb78d39f0d2dd936da396aba3225e6c3fd7124))
* **license:** 门禁哈希剔除 package-lock.json 版本字段 ([419d213](https://github.com/helixnow/deep-student/commit/419d2130883e9e11510cc5d015be378f9e74a86e))
* **llm:** compaction 健壮性——失败冷却防抖动 + RAW_PROMPT 瞬态重试 + token 估算采样外推 ([4952286](https://github.com/helixnow/deep-student/commit/4952286d64b69b2f207c379c64b48c528cf633c0))
* make full access execution unsandboxed ([e5d7bf5](https://github.com/helixnow/deep-student/commit/e5d7bf521c169b8e661fbfacf925ca462fe73c9d))
* **mcp:** align stdio framing to JSONL and harden MCP settings ([54e2cde](https://github.com/helixnow/deep-student/commit/54e2cdedeb35e24effc2c3ba572aca09323a3a72))
* **mcp:** connection-test failures against strict servers (null experimental, swallowed errors, loopback proxy, SSE task leak) ([9eea047](https://github.com/helixnow/deep-student/commit/9eea047cce74f55238b197e02bc8a5abcf1495d4))
* **mcp:** harden stdio spawn path & self-heal tool injection on send ([1a1661d](https://github.com/helixnow/deep-student/commit/1a1661db62e4078ff9dace8bbc730bd60ee32cc9))
* **mcp:** harden stdio spawn, self-heal tool injection, wire Settings status ([25de0b4](https://github.com/helixnow/deep-student/commit/25de0b4ee3dd14bfc53a0a03b6d6487cce55561d))
* **mcp:** make propose connection tests work against strict servers ([e0e8b58](https://github.com/helixnow/deep-student/commit/e0e8b58f8d035715b09d5b819d1023abc9b0cb11))
* **mcp:** Rust 侧 MCP 协议类型补 camelCase serde rename ([3185361](https://github.com/helixnow/deep-student/commit/3185361c3848153441fe5f69b8283fa291754e54))
* **mcp:** 修复 MCP stdio 全链路四个断点——ping schema/重连不刷新/空缓存TTL/启动竞态清洗 ([16efa10](https://github.com/helixnow/deep-student/commit/16efa10370038190c7c144a2b4eef923df8a2e02))
* **mindmap:** clamp blank action popup to viewport ([5e77480](https://github.com/helixnow/deep-student/commit/5e7748029d22e7a34a5ab68fb42d757405977f4d))
* **mobile:** 修复手势 touchcancel 卡死与滑动误触豁免 ([7122093](https://github.com/helixnow/deep-student/commit/712209310ca4f555a4f5c4c976dbd88d93e8cbec))
* **mobile:** 总览/数据管理顶栏改 ☰ 抽屉导航（P3-1） ([1a3dc60](https://github.com/helixnow/deep-student/commit/1a3dc600c0c68315c370a9e032ccea0fb047af35))
* **mobile:** 触控目标 44px 契约真正生效——修正 rem 锚点缩水 ([c9c1acc](https://github.com/helixnow/deep-student/commit/c9c1acc0633df51bfbd447f63e6afca691dc0e87))
* **mobile:** 输入框防缩放、横屏安全区与触控可读性修复 ([91d538f](https://github.com/helixnow/deep-student/commit/91d538fb652b2114df4154a7a5cf3863ba77460e))
* normalize pasted note image paths ([7691dc8](https://github.com/helixnow/deep-student/commit/7691dc8cd8a6ab391e489537981739e5e0fe2b6a))
* **notes:** measure context menus before clamping ([b618761](https://github.com/helixnow/deep-student/commit/b618761faaa3067be5ccfbef036e8e58b09e6d5a))
* **notes:** 移动端 UX 修复——16px rem 基准、标题层级、触控目标 44px、专注模式规则归位 ([f391bfc](https://github.com/helixnow/deep-student/commit/f391bfc64d72f68ef4b743c5c8070d9e10c4f968))
* **overview:** 总览图表区无数据时渲染空状态，不再留白 ([797d6cd](https://github.com/helixnow/deep-student/commit/797d6cd929f912e8f0fe2057e9192c8b48538f80))
* **pdf:** expose safe attachment path check ([9b685b2](https://github.com/helixnow/deep-student/commit/9b685b26070723532f6aaa04e483dfaf56a0ddd9))
* **preview:** 沙箱预览自动高度只涨不缩的棘轮——测量时临时解除 html/body 100% 钉高 ([0a5e8db](https://github.com/helixnow/deep-student/commit/0a5e8dba85078dc2fa06536b11c23116dec2189c))
* **quick-260713-syv:** enlarge workbench window control targets ([5b7aad4](https://github.com/helixnow/deep-student/commit/5b7aad4c45e0a764dbf80dacacb7f479bb23b291))
* **release:** release-please extra-files 纳入 Cargo.lock 根版本——根治 --locked 构建门禁追逐移动版本的死循环 ([797abf2](https://github.com/helixnow/deep-student/commit/797abf2474a3bc10fccc245621c90fa8dda25f72))
* **release:** 重新生成第三方声明——同步 Cargo.lock 根版本后的 SHA256，修复 --locked 构建门禁 ([1eb646f](https://github.com/helixnow/deep-student/commit/1eb646f0d7a8517a5c9b161de22fd26e6595d736))
* **rust:** resolve executor and helper integration issues ([615419a](https://github.com/helixnow/deep-student/commit/615419aa2d2ba86b0ad66d8f695b9e5b71554bf9))
* satisfy release gates ([cf00832](https://github.com/helixnow/deep-student/commit/cf00832a7c4d4a58cc8f99f2745dceebbf44adc8))
* **search-ui:** normalize fields and quiet focus styling ([bf7b91e](https://github.com/helixnow/deep-student/commit/bf7b91eda9832621e0befefc78cd3c50742d7d89))
* **settings:** CloudStorageSection dialog/区块标题 text-lg → text-base font-semibold ([9ccd45a](https://github.com/helixnow/deep-student/commit/9ccd45a2b4aa4c76ba3bc1c6447b16ed7deae019))
* **settings:** layer editor menus above the modal surface and refine latency styling ([ffcc813](https://github.com/helixnow/deep-student/commit/ffcc813b68886b1a9041a9c6a776bffe09ea7791))
* **settings:** MCP 统计条/空态 + 供应商列表统一灰卡 ([db71edc](https://github.com/helixnow/deep-student/commit/db71edc6a9a0bcc1ab77f7386f36b3b3bacb218b))
* **settings:** P0 裸奔行组包灰卡——模型分配/关于/快捷键/外部搜索全局组 ([a19b0aa](https://github.com/helixnow/deep-student/commit/a19b0aa1dff86087de87ceaa25f6fc4e17337cbd))
* **settings:** P1b 描边旧卡清零——shad Card/ring 卡统一为灰卡 ([2db7a8f](https://github.com/helixnow/deep-student/commit/2db7a8f93b011626f63c2239fc289df0beb91ab7))
* **settings:** P2 区域标题字重归位 + 行内确认取消按钮统一 ([e66050b](https://github.com/helixnow/deep-student/commit/e66050b9c540d40a2ba27cf0156b254c32fb5016))
* **settings:** P2 收尾——虚线空态灰卡化 + McpTools 控件契约化 ([3682639](https://github.com/helixnow/deep-student/commit/368263992f65c3bdf5f163f16cd57f97f8dfe574))
* **settings:** P2 统一收尾——供应商详情虚拟化模式/编辑表单/空态、归档、统计标题 ([2b73392](https://github.com/helixnow/deep-student/commit/2b733928b2c7e7a224bd66d58ebf47abe85bceff))
* **settings:** P2-9 供应商列表行补键盘激活与移动端语义 ([b656f79](https://github.com/helixnow/deep-student/commit/b656f7981b2f9501a67a580b00ba1fb8ddbfb921))
* **settings:** restore unified API imports ([3617a71](https://github.com/helixnow/deep-student/commit/3617a718f9885764a1ada3d2b80595f4be6d35d4))
* **settings:** rollback partial batch writes ([88a48fb](https://github.com/helixnow/deep-student/commit/88a48fb677dd389251792d17701402db7cece903))
* **settings:** wire MCP connection status into editor section ([f8ebb63](https://github.com/helixnow/deep-student/commit/f8ebb63ec18f433812c0aaacdbe9db24f3aaaf69))
* **settings:** 下拉选择器摘掉 h-11+text-xs 覆盖，尺寸交还按钮契约 ([a362552](https://github.com/helixnow/deep-student/commit/a362552f35f1d79462fe182840a049abfa75b330))
* **settings:** 修复移动端设置抽屉返回/关闭按钮被拖拽手势误吞 ([51d7385](https://github.com/helixnow/deep-student/commit/51d7385312f84f2e6247d6f9affe02e510a3df0d))
* **settings:** 卡内次级按钮统一描边、空态标题统一左对齐（自动化/Subagent/MCP/供应商/记忆/听写/Codex/OCR） ([b8ac600](https://github.com/helixnow/deep-student/commit/b8ac6007d494ed27369cb8f29b0f4351465fc331))
* **settings:** 外部搜索引擎详情标题外置——h3 移出卡片，内容/策略区独立成卡 ([e908570](https://github.com/helixnow/deep-student/commit/e908570d0cfaa0661aa274fb2f1d9a8add7ed0ae))
* **settings:** 常规/外观页卡内按钮统一描边（default/ghost/primary→outline），下拉触发器同步 ([237d4e1](https://github.com/helixnow/deep-student/commit/237d4e1262bb1f4e0e4fbdfa45079448a6bdf62d))
* **settings:** 按钮变体收尾——剩余 default 省略/动态 default 全部归位 ([783e5df](https://github.com/helixnow/deep-student/commit/783e5dfcde8a45a97477c3a71487ef92f59a84ab))
* **settings:** 按钮变体收敛——消灭 tonal 灰底类，独立操作统一 outline ([e664492](https://github.com/helixnow/deep-student/commit/e664492323134f39f4e81a91813916ca0382a26a))
* **settings:** 插件/关于页卡内按钮统一描边，开源致谢内联卡改无描边灰填充 ([26ae52a](https://github.com/helixnow/deep-student/commit/26ae52a8a1b45a9e6ca7c0396ccf7247b190191b))
* **settings:** 数据治理/数据统计卡内按钮统一描边，概览卡片改无描边灰填充 ([0fa542b](https://github.com/helixnow/deep-student/commit/0fa542bd5c525961de20ee68a4f1d4a2e5eb55c9))
* **settings:** 数据治理四 tab 统一灰卡语言 ([db8827d](https://github.com/helixnow/deep-student/commit/db8827d90d0b64f6c1831f6edb0e531e30dd2fca))
* **settings:** 自动化页标题外置——非嵌入态 section 去整体卡壳，内容区单独包灰卡 ([da8dfd3](https://github.com/helixnow/deep-student/commit/da8dfd391821eed1a0cfa52b73fc119895b3656b))
* **settings:** 语音听写/记忆独立页补灰卡容器（拆分遗失的 embedded 宿主卡） ([3715845](https://github.com/helixnow/deep-student/commit/37158458c6c45b68282bafa0fa722da8dc71f629))
* **shell:** improve Windows shell fallback diagnostics ([d22e345](https://github.com/helixnow/deep-student/commit/d22e345b2144e34ec9045590e8deee15d1c4f2d0))
* **shell:** mac/Linux 完全信任通道不再施加 RLIMIT 资源上限 ([0c4abe3](https://github.com/helixnow/deep-student/commit/0c4abe35cdd47b03bdb0f8acdbb4ee939c29908e))
* **shell:** 修复沙箱反馈四连——失败原因回传 AI、localhost 例外、完全信任模式真正放开 ([1d15b74](https://github.com/helixnow/deep-student/commit/1d15b74b5a8968f567cdf3db41ce2b006cbb310c))
* **shell:** 移动端视图层切换动画方向镜像（返回时反向滑出） ([e9803c0](https://github.com/helixnow/deep-student/commit/e9803c0a2415ef580cb6bd1cede1d03da70a7610))
* **skills:** 技能卡片网格补 grid-cols-1，修复移动端卡片横向溢出 21px ([5a5d460](https://github.com/helixnow/deep-student/commit/5a5d460ca89901bf628c2eb20b0d95b05f071ff5))
* stabilize migration recovery and release gates ([e0cf3b0](https://github.com/helixnow/deep-student/commit/e0cf3b09b0471b6f83b420dba2e52cc1a0366025))
* **startup:** raise recovery preflight timeout 15s -&gt; 120s ([b3d1652](https://github.com/helixnow/deep-student/commit/b3d16528266a4620bdd54c75fb09b0d058870be7))
* **startup:** setup 完成闸门修复启动预检误报 blocked ([4ccd2c1](https://github.com/helixnow/deep-student/commit/4ccd2c121a58c505604864c76ad3718b3fdbf13b))
* **sync:** 0824 批次云存储与同步修复 ([5fc21a2](https://github.com/helixnow/deep-student/commit/5fc21a2e4eab5ff717a7694f3ba576f5d5255319))
* **sync:** add provider-aware WebDAV request limiter ([ba3de70](https://github.com/helixnow/deep-student/commit/ba3de709ad44c06913e5693cb82dd5d9a05cff49))
* **template-mgmt:** 面包屑标题语义化 h1 并锁定 14px 字号，滚动内边距移到内容包装层 ([55237bb](https://github.com/helixnow/deep-student/commit/55237bb5ef010904f7b52ba4f2aae9ee271db878))
* **todo:** 移除子屏各自叠加的底部安全区，消除与 overlay 容器兜底的双计留白 ([400797b](https://github.com/helixnow/deep-student/commit/400797bd2ee6e254eb9c1e3405a231baa67751e4))
* **todo:** 移除空态背景同心圆环装饰（产品决策：观感不佳） ([bf2c2ba](https://github.com/helixnow/deep-student/commit/bf2c2ba08bd89e19324e454931572829b393ec0d))
* **todo:** 空态同心圆环不居中——过约束绝对定位下 auto margin 解析为 0 ([9d96848](https://github.com/helixnow/deep-student/commit/9d96848a4fe5bf6e2bffd2bc288e3725b4681ca6))
* **todo:** 顶部工具栏按钮尺寸统一——摘手写 h-8/coarse 覆盖交还按钮契约 ([2b3d5ee](https://github.com/helixnow/deep-student/commit/2b3d5eeda9f9d424f3557b8421363bdb17537807))
* **tools:** 修复调研发现的同类问题——chatanki 错误人读化、业务失败语义、SSRF 正源统一 ([bc21a4f](https://github.com/helixnow/deep-student/commit/bc21a4fdd7d856e27fea50e9c42cd4040efccc4e))
* **ui:** stabilize shared overlay placement ([bf8ad66](https://github.com/helixnow/deep-student/commit/bf8ad66e9830f8887de2b5199f97a1f275864ea9))
* **ui:** 移动端按钮壳-内容比例协调（44px 壳配更大字号/图标） ([8f7e519](https://github.com/helixnow/deep-student/commit/8f7e5190212e95f9df67a506693fb4be1cb1223a))
* **vfs:** 0824 批次虚拟文件系统修复 ([96511e1](https://github.com/helixnow/deep-student/commit/96511e1350120a6e0df19563d4edeec08e162095))
* **vfs:** avoid reopening retired vector catalogs ([3ce3169](https://github.com/helixnow/deep-student/commit/3ce31691eb9fb2976a4613d7d9165883ab83c005))
* **webdav:** share provider request limiter across sessions ([1bd83dd](https://github.com/helixnow/deep-student/commit/1bd83dda3ec5c0ee73b7fa1d98dc496edbfbb271))
* **windows:** restore stable backend compilation ([6d0d9e0](https://github.com/helixnow/deep-student/commit/6d0d9e038dd97311da4a14a1c4a792a7e28cc91d))
* **workbench:** avoid Windows chrome overlap ([4d03a83](https://github.com/helixnow/deep-student/commit/4d03a835c53abbbcd2f479f69898328843aafe86))
* **workbench:** remove stale flashcard mock state ([0d7209c](https://github.com/helixnow/deep-student/commit/0d7209c80d1cbb9643bd73ad0ea6e6e4cf10e61e))
* **workbench:** restore native window close path ([767f0d5](https://github.com/helixnow/deep-student/commit/767f0d5f9f7d11aba9f180fa56bbabdd0817344f))
* **workbench:** simplify agent control dock indicators ([824f05b](https://github.com/helixnow/deep-student/commit/824f05b0206e55dc99dbdbcc2a4f30031376b308))
* **workbench:** 桌面 AI 简报移入右上角组件栏，修复与桌面图标重叠 ([4e214ff](https://github.com/helixnow/deep-student/commit/4e214ff7793b6246730e9b1cae9a03448ce8fa50))
* **workbench:** 窄桌面组件栏隐藏与状态栏断点对齐全局 ([e5f9792](https://github.com/helixnow/deep-student/commit/e5f9792085e3f2266c1164c6f4fc7bb87fedff85))


### Performance Improvements

* **workbench:** fix style-invalidation hotspots behind window-drag jank ([a064ac6](https://github.com/helixnow/deep-student/commit/a064ac689e2632334407ff9807df2128ddb72824))

## [0.9.55](https://github.com/helixnow/deep-student/compare/v0.9.54...v0.9.55) (2026-09-06)


### Features

* add pelican bicycle svg animation ([6de34e3](https://github.com/helixnow/deep-student/commit/6de34e3a5f8ed24d98daef72d6670e69be4568b2))
* **chat:** 侧栏会话筛选菜单（默认隐藏子代理会话）+ 行内指示器与操作簇重叠让位 ([57bf33a](https://github.com/helixnow/deep-student/commit/57bf33a412d592e028ef28ebf317d4ab2be74c70))


### Bug Fixes

* **build:** bump Android baseline to v0.9.54, fix release-please annotation ([a80956f](https://github.com/helixnow/deep-student/commit/a80956fd3ce50fae59a07e5c615b060cf5211997))
* **chat:** 制卡事件合并缓冲，修复批量制卡前端 O(N²) 卡顿 ([d5dcc18](https://github.com/helixnow/deep-student/commit/d5dcc186674640ba81a1eb3bdfecad37faca9c81))
* **chat:** 制卡事件合并缓冲，修复批量制卡前端 O(N²) 卡顿 ([5df87c3](https://github.com/helixnow/deep-student/commit/5df87c3fbb53613a23497544ab58f2ce1921f77a))
* **chat:** 审批已决态即点即出队——APPROVAL_RESOLUTION_DISPLAY_MS 1000ms→0 ([dd46b14](https://github.com/helixnow/deep-student/commit/dd46b149b3554962eea8bcf88a100206ee052ae4))
* **chat:** 审批栏卡死——approval_expired 反复弹通知但审批栏不消失 ([dbfc7d0](https://github.com/helixnow/deep-student/commit/dbfc7d0de4e6139e3502246c6846aeecc7562a6a))
* **ci:** Android 作业接入 sccache——runner 回收后编译单元不丢 ([05f2a78](https://github.com/helixnow/deep-student/commit/05f2a7804d5c1d30286f292eb75f283c418b637d))
* **ci:** Cloud Provider Contract Gate 按 provider 拆 matrix 并行 ([2ef82f6](https://github.com/helixnow/deep-student/commit/2ef82f6dc3630de6c738dd91af6d9f5e20f4a896))
* **ci:** Vitest 长尾 17 文件 160 例全绿 + Migration Gate 钉版 ([3389725](https://github.com/helixnow/deep-student/commit/3389725b2f4a95e7ddc799f3d9a141daf491e9cb))
* **ci:** 修复 main 基线五项红项——lint/迁移锁/测试 mock/样式契约 ([7f8be1d](https://github.com/helixnow/deep-student/commit/7f8be1d8eda1726b3ed6ef3d227527ddcd96abb1))
* **ci:** 修复 Vitest 2/4+3/4 基线——18 例失败全修（118 绿） ([d5c41f1](https://github.com/helixnow/deep-student/commit/d5c41f166c16dc65d69f3475be02bc77ca34555d))
* **ci:** 根治 Android 构建连败与 runner 回收——堆上限/钉版/fmt ([1727aaa](https://github.com/helixnow/deep-student/commit/1727aaa5c3f623db477b5b42ef56e08047416218))
* **command-palette:** 取消过期聚焦 rAF——Esc 竞态致焦点掉 body；CI 缓存随钉版镜像隔离 ([21adb95](https://github.com/helixnow/deep-student/commit/21adb9539dee0baefd9657deb6590a4f043ac8b1))
* **llm:** compaction 健壮性——失败冷却防抖动 + RAW_PROMPT 瞬态重试 + token 估算采样外推 ([4952286](https://github.com/helixnow/deep-student/commit/4952286d64b69b2f207c379c64b48c528cf633c0))
* **mcp:** harden stdio spawn path & self-heal tool injection on send ([1a1661d](https://github.com/helixnow/deep-student/commit/1a1661db62e4078ff9dace8bbc730bd60ee32cc9))
* **mcp:** harden stdio spawn, self-heal tool injection, wire Settings status ([25de0b4](https://github.com/helixnow/deep-student/commit/25de0b4ee3dd14bfc53a0a03b6d6487cce55561d))
* **settings:** wire MCP connection status into editor section ([f8ebb63](https://github.com/helixnow/deep-student/commit/f8ebb63ec18f433812c0aaacdbe9db24f3aaaf69))
* **startup:** raise recovery preflight timeout 15s -&gt; 120s ([b3d1652](https://github.com/helixnow/deep-student/commit/b3d16528266a4620bdd54c75fb09b0d058870be7))
* **startup:** setup 完成闸门修复启动预检误报 blocked ([4ccd2c1](https://github.com/helixnow/deep-student/commit/4ccd2c121a58c505604864c76ad3718b3fdbf13b))

## [0.9.54](https://github.com/helixnow/deep-student/compare/v0.9.53...v0.9.54) (2026-09-05)


### Features

* **chat:** add session goal mode with cross-turn auto-continuation ([5edffa1](https://github.com/helixnow/deep-student/commit/5edffa1a6dd36dfd20bc0e488ec854f62071cf8d))
* **chat:** add snapshot file import export flow ([9c25d7e](https://github.com/helixnow/deep-student/commit/9c25d7e648ef3255dc4bb062959502923f2d83fe))
* **chat:** add snapshot import action to session browser ([9ffbfce](https://github.com/helixnow/deep-student/commit/9ffbfcead61224081e9cd96e6d871d0d4c5fe97b))
* **chat:** add transactional conversation snapshot import ([3ee514d](https://github.com/helixnow/deep-student/commit/3ee514d01e17056cbf5428a18b47109392d67829))
* **chat:** expose conversation snapshot APIs ([91c9222](https://github.com/helixnow/deep-student/commit/91c9222a03f60af427de419d4575c77ef5eb7356))
* **chat:** goal mode frontend — status chip, builtin tools, stream race fix ([a6bca19](https://github.com/helixnow/deep-student/commit/a6bca190cb74f225872a0a69e6a54b02ade1ba8c))
* **chat:** unrestricted host shell tier for danger_full_access ([7191a59](https://github.com/helixnow/deep-student/commit/7191a5910cb41821649380a2991357fb7266d997))
* **chat:** unrestricted tier contracts and race-free preset switching ([03d007c](https://github.com/helixnow/deep-student/commit/03d007cf1bdb92c8a43f6dcab2634ad00acbc895))
* **chat:** 历史消息向上懒加载 UI——顶部横幅/自动触发/重试/exhausted ([dadb7ed](https://github.com/helixnow/deep-student/commit/dadb7edd64e250e50b09f563faf3ae947c2b557c))
* **migration:** absorb safe upstream reliability fixes ([1001b14](https://github.com/helixnow/deep-student/commit/1001b14b3d1882475f088b0cddd6768f19fad024))
* **migration:** absorb verified reliability improvements ([3d81791](https://github.com/helixnow/deep-student/commit/3d81791fcce06668b03a45a612a7ef18fbd9022f))
* **migration:** document upstream optimization absorption plan ([ee9024c](https://github.com/helixnow/deep-student/commit/ee9024cf04006cf986252f25525f30f104f343b5))
* **migration:** harden chat overscroll and settings batching ([b9a1622](https://github.com/helixnow/deep-student/commit/b9a1622dedea993fe530be29ab93fa92c77a33f6))
* **pdf:** backfill missing historical previews ([1ea4b89](https://github.com/helixnow/deep-student/commit/1ea4b897def4c402bc1b4b43701155b6453fe162))
* **pdf:** schedule historical preview backfill ([760dd31](https://github.com/helixnow/deep-student/commit/760dd31d99e248e0ada0b084905df7c61ef5e793))
* **sync:** 云存储等待窗口状态透传前端——消除限流/退避期假卡死 ([fbd6cc2](https://github.com/helixnow/deep-student/commit/fbd6cc2f059e714fb000ef2b4e69566d6053368f))
* **sync:** 协作式取消 + WebDAV 传输健壮性 ([818db13](https://github.com/helixnow/deep-student/commit/818db13d4dc87e0875581aefecc92addcd0fd3d5))


### Bug Fixes

* **build:** align Android version baseline with v0.9.53 release ([a1eaa24](https://github.com/helixnow/deep-student/commit/a1eaa2425d1c4077bd4d374da961f0641c534710))
* **chat:** enforce snapshot import size limit ([8892af5](https://github.com/helixnow/deep-student/commit/8892af59ad04a1cf3c29ca5ba2a4a93eb610546e))
* **chat:** guard snapshot file import size ([e9b42f9](https://github.com/helixnow/deep-student/commit/e9b42f9325666ee11481c748e09c72f7c7a94aeb))
* **chat:** isolate stale streams and corrupt history records ([1d2302e](https://github.com/helixnow/deep-student/commit/1d2302e59639e1eb9dc1462e4b310c4384b8dc41))
* **chat:** PR [#376](https://github.com/helixnow/deep-student/issues/376) 合并后修复——匿名 Job 防跨执行误杀 + 测试同步 ([1fef7e1](https://github.com/helixnow/deep-student/commit/1fef7e108b975ea75129f46bd96311f02674a442))
* **chat:** register goal commands in permissions manifest ([b13be90](https://github.com/helixnow/deep-student/commit/b13be90fd64d2e83f38f56a6520d0afe45723d08))
* **chat:** tolerate legacy stores without goal fetcher ([74255e9](https://github.com/helixnow/deep-student/commit/74255e9788f059c12b759762e965d334f9ae3485))
* **chat:** tolerate partial staged restore payloads ([34d7216](https://github.com/helixnow/deep-student/commit/34d7216284457d2be5b5164cee583f16fb9c5b42))
* **chat:** use typed snapshot API schemas ([cf7e9d5](https://github.com/helixnow/deep-student/commit/cf7e9d5d9b7ca3ec30c6de5f165f42120ec90180))
* **chat:** validate record identifiers during staged restore ([3eb31e1](https://github.com/helixnow/deep-student/commit/3eb31e19acf3ec71061aa8c5e4da5e4fb5efc168))
* **mcp:** connection-test failures against strict servers (null experimental, swallowed errors, loopback proxy, SSE task leak) ([9eea047](https://github.com/helixnow/deep-student/commit/9eea047cce74f55238b197e02bc8a5abcf1495d4))
* **mcp:** make propose connection tests work against strict servers ([e0e8b58](https://github.com/helixnow/deep-student/commit/e0e8b58f8d035715b09d5b819d1023abc9b0cb11))
* **pdf:** expose safe attachment path check ([9b685b2](https://github.com/helixnow/deep-student/commit/9b685b26070723532f6aaa04e483dfaf56a0ddd9))
* **settings:** restore unified API imports ([3617a71](https://github.com/helixnow/deep-student/commit/3617a718f9885764a1ada3d2b80595f4be6d35d4))
* **settings:** rollback partial batch writes ([88a48fb](https://github.com/helixnow/deep-student/commit/88a48fb677dd389251792d17701402db7cece903))
* **shell:** improve Windows shell fallback diagnostics ([d22e345](https://github.com/helixnow/deep-student/commit/d22e345b2144e34ec9045590e8deee15d1c4f2d0))
* **sync:** add provider-aware WebDAV request limiter ([ba3de70](https://github.com/helixnow/deep-student/commit/ba3de709ad44c06913e5693cb82dd5d9a05cff49))
* **webdav:** share provider request limiter across sessions ([1bd83dd](https://github.com/helixnow/deep-student/commit/1bd83dda3ec5c0ee73b7fa1d98dc496edbfbb271))

## [0.9.53](https://github.com/helixnow/deep-student/compare/v0.9.52...v0.9.53) (2026-09-05)


### Features

* **chat:** 工具轮次默认不限并整体移除 doom loop 机制（长程 agent 支持） ([897411a](https://github.com/helixnow/deep-student/commit/897411afc6bee3b2b074efdeed54f3bb941411ae))
* **chat:** 新增 model_profile_add 工具——agent 经逐次审批后可新增模型配置 ([5e8c1cf](https://github.com/helixnow/deep-student/commit/5e8c1cf143d09e9da2e84d8b0028119f3592e672))
* **memory:** 吸收 Hermes 策略——画像溢出当轮自合并协议 + 记忆内容安全扫描 ([e0cd8bf](https://github.com/helixnow/deep-student/commit/e0cd8bf78eecdeaf9c09e4c156ac800c05b0c6d1))
* **memory:** 打通记忆蒸馏层到原始会话的回溯链路，记忆模式泛化到工程/通用场景 ([a0906b7](https://github.com/helixnow/deep-student/commit/a0906b75b8701522122d35a9b82f20661fe6a7c1))
* **settings:** 桌面端获取可用模型改回内联卡片，移除 Dialog 形态 ([962807d](https://github.com/helixnow/deep-student/commit/962807d7d0028695598ace0c7d28c1ee5aec189e))
* **workspace:** add coding navigation and git tools ([86b4fee](https://github.com/helixnow/deep-student/commit/86b4fee1e302306a1c0cc65c50a05618751a9b6d))
* **workspace:** 新增 workspace_file_edit 局部编辑工具，补齐 coding 能力最关键的'手' ([8fcdf05](https://github.com/helixnow/deep-student/commit/8fcdf05c7285a4be164b853247c5f3e5c9b78953))


### Bug Fixes

* **build:** align Android version baseline ([2da873e](https://github.com/helixnow/deep-student/commit/2da873ecde140181d73999c6325498eeae8711a3))
* **chat:** admit packed tools through pipeline ([586cf30](https://github.com/helixnow/deep-student/commit/586cf30eb81444434509251a9b89053da8190f54))
* **chat:** align retired authority and host cwd ([b7d74a5](https://github.com/helixnow/deep-student/commit/b7d74a596885d1351cadf96765eb82270b6d9d6d))
* **chat:** harden file reads and exports ([603a57e](https://github.com/helixnow/deep-student/commit/603a57e433b9230f2536671a49ae6e23676ec2f2))
* **chat:** repair attachments and Windows shell payloads ([a538280](https://github.com/helixnow/deep-student/commit/a5382801f7976b052dc90428ef0ded381670452f))
* **chat:** retry empty model responses ([481c6ef](https://github.com/helixnow/deep-student/commit/481c6efe20d88bc305af9a91ab4bbc04beb6632d))
* **chat:** 子代理 wait=true 同步交付后不再被完成事件二次唤醒 ([10934c2](https://github.com/helixnow/deep-student/commit/10934c21e63769bbc34a7a2a63915d2c06acbf13))
* **chat:** 晚到/重放块按时间戳稳定归位——流式期间乱序块不再沉底 ([3e3a470](https://github.com/helixnow/deep-student/commit/3e3a47087d5cc2b280f3b1d3b4f27df3747b83ba))

## [0.9.52](https://github.com/helixnow/deep-student/compare/v0.9.51...v0.9.52) (2026-09-03)


### Bug Fixes

* **android:** MainActivity.kt doc 注释内 `/*` 触发 Kotlin 嵌套块注释致 EOF 未闭合——改写路径表述 ([6e49d41](https://github.com/helixnow/deep-student/commit/6e49d41065690e6c9ef1a91a895480fe9d5cb74b))

## [0.9.51](https://github.com/helixnow/deep-student/compare/v0.9.50...v0.9.51) (2026-09-03)


### Bug Fixes

* **android:** apk_installer 用全限定 Manager::manage——修复 mobile-slim Android 构建 E0599（trait 未导入） ([412e853](https://github.com/helixnow/deep-student/commit/412e853360b50095315dbf640e711c9432e2c39b))

## [0.9.50](https://github.com/helixnow/deep-student/compare/v0.9.49...v0.9.50) (2026-09-03)


### Bug Fixes

* **release:** release-please extra-files 纳入 Cargo.lock 根版本——根治 --locked 构建门禁追逐移动版本的死循环 ([797abf2](https://github.com/helixnow/deep-student/commit/797abf2474a3bc10fccc245621c90fa8dda25f72))

## [0.9.49](https://github.com/helixnow/deep-student/compare/v0.9.48...v0.9.49) (2026-09-03)


### Bug Fixes

* **release:** 重新生成第三方声明——同步 Cargo.lock 根版本后的 SHA256，修复 --locked 构建门禁 ([1eb646f](https://github.com/helixnow/deep-student/commit/1eb646f0d7a8517a5c9b161de22fd26e6595d736))

## [0.9.48](https://github.com/helixnow/deep-student/compare/v0.9.47...v0.9.48) (2026-09-03)


### Bug Fixes

* **button-audit:** 修复阻塞发版的 tsc 错误——items 数组字面量 union widening 加 as AuditItem[]、SegmentedControl onValueChange 类型适配、补 notes-misc 缺失的 note 字段 ([4c49b58](https://github.com/helixnow/deep-student/commit/4c49b58ece672f3f722bd76e190751aa7c1d47ac))

## [0.9.47](https://github.com/helixnow/deep-student/compare/v0.9.46...v0.9.47) (2026-09-03)


### Features

* **chat:** 对话控制面板不再显示 DeepSeek V4 采样锁定提示气泡 ([00bed8e](https://github.com/helixnow/deep-student/commit/00bed8e48326a5a7f143db5b5bd15532a70a6959))
* **demo:** hero 落地页手机模式——去窗壳全宽自适应移动端演示 ([9ee2dac](https://github.com/helixnow/deep-student/commit/9ee2dac3bc7818bd1da2c613bf20a3aeb420febb))
* **demo:** 手机端分页改 transform 分页器——彻底关闭自由滚动 ([e0b6566](https://github.com/helixnow/deep-student/commit/e0b6566c2fe47abd3ab022f839b8eb7009c48aa7))
* **demo:** 手机端多屏竖直滚动——题辞一屏、演示独占一屏 ([8692b5f](https://github.com/helixnow/deep-student/commit/8692b5fdba4778a874d58905445539e497ffe8cb))
* **demo:** 手机端整屏磁吸滚动（scroll-snap） ([da0fcaf](https://github.com/helixnow/deep-student/commit/da0fcaf9d0a331d0b8959ca4e37d921095a8fac2))
* **demo:** 手机端演示不呼出输入法 + 打字速度 2 倍 ([5e1f267](https://github.com/helixnow/deep-student/commit/5e1f267c9aa57c5c4698993b2bc6f8448fe96c22))
* **demo:** 收窄演示壳二三级入口，只留一级功能菜单 ([913ea7f](https://github.com/helixnow/deep-student/commit/913ea7f9cd405cd6b717c23b3c499b88ad961768))
* **demo:** 空态输入框打字机动画——自动播放更像真人操作 ([712db0e](https://github.com/helixnow/deep-student/commit/712db0e33da54061b875ea4bb562047799575704))
* **demo:** 自动播放改为从第一问开始 + 修复侧栏开关被误藏 ([51e52eb](https://github.com/helixnow/deep-student/commit/51e52eb65b7211ad358b26fd0389e9dbe4078f69))
* **demo:** 重写三个剧本会话走差异化能力 + 卡片模板样式与切回闪烁修复 ([ad020b5](https://github.com/helixnow/deep-student/commit/ad020b5f3c454d3c79f1977ed16ea14de70e0cf7))
* **demo:** 门户 Hero 页 + 演示壳收窄主会话交互 + 首屏瘦身 ([86dce6a](https://github.com/helixnow/deep-student/commit/86dce6ae5cdb5d45355dddac5696b64d43a14a4c))
* **demo:** 附件能力完整演示——错题照片缩略图/全屏预览 + 上传PDF面板渲染与页码跳转 ([f098fc9](https://github.com/helixnow/deep-student/commit/f098fc9f2ea1faad1498754cef1477e1156b8b3f))
* **demo:** 首屏预热演示加载 + 加载占位 ([c59685b](https://github.com/helixnow/deep-student/commit/c59685b98578ebbc627397f22f6971eaab197a93))
* **dev:** ui-lab 窗口默认落在第二块屏幕，避免占用主屏 ([9975cbb](https://github.com/helixnow/deep-student/commit/9975cbb0ec710f7b9800e41353463309f93d4cad))
* **mobile:** 六宫格应用启动器移到所有侧栏（抽屉）底部固定 ([636f0d1](https://github.com/helixnow/deep-student/commit/636f0d107ebabd5abdf8a9b99ba70f168ab2fedf))
* **navigation:** 移动端应用启动器收口 + 导航去重，附输入栏/时间线/hero 页配套改动 ([86212db](https://github.com/helixnow/deep-student/commit/86212dbbd3b6f7f1b9b085ac7a8db8d2e77937be))
* **settings,data:** 移动端模型编辑与数据中心界面修订 ([b063340](https://github.com/helixnow/deep-student/commit/b0633401a17cf2d3009e86b557ba787d1f569136))
* **settings:** MCP 页移动端交互统一与 Subagent 按钮降噪 ([bb205bf](https://github.com/helixnow/deep-student/commit/bb205bf662087ba0de7196016cdbef48999404e1))
* **settings:** 供应商 key 录入入口可发现性（P3-10） ([ab8d01f](https://github.com/helixnow/deep-student/commit/ab8d01fa2f012521423f3bece18530bf3cdd0449))
* **settings:** 子页面分区卡片改无描边纯填充灰卡，小标题外置 ([024f4fc](https://github.com/helixnow/deep-student/commit/024f4fc8781f5fa334c365374c183470508ac9e2))
* **settings:** 拆分超长设置页——语音听写/记忆/学习桌面/文档处理独立分区 ([265a79b](https://github.com/helixnow/deep-student/commit/265a79bc45e7dfe0111df35bb670a99bd523cb5a))
* **settings:** 模型供应商移动端界面精简与按钮降噪 ([dc97a95](https://github.com/helixnow/deep-student/commit/dc97a95182716c42a0ddd50c84eefaadf2498f14))
* **settings:** 移动 UI 设置内按钮统一右&lt;|sep|&gt; ([44e821e](https://github.com/helixnow/deep-student/commit/44e821e565f4d6d570d7a629ee70fcb0e8beaaed))
* **settings:** 自定义区域卡无描边灰填充 + 次级操作按钮统一描边 ([40e4c94](https://github.com/helixnow/deep-student/commit/40e4c941ae1cded1bbf51f3425069f2ccb670476))
* **settings:** 页内层级切换动画 ShellViewSwitch，前进/后退方向互为镜像 ([18f7a11](https://github.com/helixnow/deep-student/commit/18f7a1129deb6d497e693d04ef40a6716ac39c14))
* **shell:** Windows PowerShell 5.1 语法三层引导——消除 bash 语法盲试循环 ([b881316](https://github.com/helixnow/deep-student/commit/b881316691282a7abae75a8d6de148774996fa16))


### Bug Fixes

* **a11y:** P3-11 会话列表项补 role=button/tabIndex 与键盘激活 ([cd255cc](https://github.com/helixnow/deep-student/commit/cd255cc0453528e816af5d57e519fe5c6b35ada7))
* **a11y:** P3-9 弹层可访问名——AppMenu 菜单兜底用触发器命名，DsAlertDialog 接线标题 ([e5a3258](https://github.com/helixnow/deep-student/commit/e5a325842dc460edb244ef8568f674cdb561f5f6))
* **anki:** 卡面 iframe 显式主题背景——修复移动端深色全白不可见 ([d1bb509](https://github.com/helixnow/deep-student/commit/d1bb5090ae5f83a3807314c229fd18b6d4751d0d))
* **chat_v2:** preflight 暴露不可降级守卫的 Deny 判定 ([25f662a](https://github.com/helixnow/deep-student/commit/25f662ae2ff17555f768f4692d480e3ad4c5a3fe))
* **chat_v2:** 完全信任档 preflight 允许绝对路径 cwd ([690f3e9](https://github.com/helixnow/deep-student/commit/690f3e9c5ce49b7c3f1806bec1fe3c4bb8216932))
* **chat_v2:** 完全信任档审批绑定允许绝对路径 cwd ([32c83d6](https://github.com/helixnow/deep-student/commit/32c83d6e40996e492b5695002de31b3d8a7e6022))
* **chat:** 审批卡技术细节默认折叠——对齐 Claude Code 的极简审批面 ([d7ce14d](https://github.com/helixnow/deep-student/commit/d7ce14def4608ae728988ec9124710323b9a096a))
* **demo:** 修手机磁吸手感——几何稳定 + 逐屏停驻 ([7f3c5a3](https://github.com/helixnow/deep-student/commit/7f3c5a31add0946a9ef94291baf4dc9a2e7f8381))
* **demo:** 手机端刊头改为随题辞屏滚走，不再遮挡演示区 ([b6ab1bf](https://github.com/helixnow/deep-student/commit/b6ab1bf9d8a97cb554cfd163a75a3f935f36561c))
* **demo:** 手机端整屏分页改 JS 实现——根治回弹与惯性过头 ([55f5348](https://github.com/helixnow/deep-student/commit/55f5348da7b1a386fa121926f50abad0623ad631))
* **demo:** 消除"已自动分配6个模型"气泡等演示痕迹 ([eb3cc10](https://github.com/helixnow/deep-student/commit/eb3cc1019dc87bece00a53ede4f30f4a856f6e2d))
* **demo:** 补 dstu_list mock——修手机端右滑资源库崩溃 ([c8c3f7c](https://github.com/helixnow/deep-student/commit/c8c3f7caade9fee65252fe2b55758d613c0781a9))
* **mcp:** Rust 侧 MCP 协议类型补 camelCase serde rename ([3185361](https://github.com/helixnow/deep-student/commit/3185361c3848153441fe5f69b8283fa291754e54))
* **mcp:** 修复 MCP stdio 全链路四个断点——ping schema/重连不刷新/空缓存TTL/启动竞态清洗 ([16efa10](https://github.com/helixnow/deep-student/commit/16efa10370038190c7c144a2b4eef923df8a2e02))
* **mobile:** 总览/数据管理顶栏改 ☰ 抽屉导航（P3-1） ([1a3dc60](https://github.com/helixnow/deep-student/commit/1a3dc600c0c68315c370a9e032ccea0fb047af35))
* **notes:** 移动端 UX 修复——16px rem 基准、标题层级、触控目标 44px、专注模式规则归位 ([f391bfc](https://github.com/helixnow/deep-student/commit/f391bfc64d72f68ef4b743c5c8070d9e10c4f968))
* **overview:** 总览图表区无数据时渲染空状态，不再留白 ([797d6cd](https://github.com/helixnow/deep-student/commit/797d6cd929f912e8f0fe2057e9192c8b48538f80))
* **preview:** 沙箱预览自动高度只涨不缩的棘轮——测量时临时解除 html/body 100% 钉高 ([0a5e8db](https://github.com/helixnow/deep-student/commit/0a5e8dba85078dc2fa06536b11c23116dec2189c))
* **settings:** CloudStorageSection dialog/区块标题 text-lg → text-base font-semibold ([9ccd45a](https://github.com/helixnow/deep-student/commit/9ccd45a2b4aa4c76ba3bc1c6447b16ed7deae019))
* **settings:** MCP 统计条/空态 + 供应商列表统一灰卡 ([db71edc](https://github.com/helixnow/deep-student/commit/db71edc6a9a0bcc1ab77f7386f36b3b3bacb218b))
* **settings:** P0 裸奔行组包灰卡——模型分配/关于/快捷键/外部搜索全局组 ([a19b0aa](https://github.com/helixnow/deep-student/commit/a19b0aa1dff86087de87ceaa25f6fc4e17337cbd))
* **settings:** P1b 描边旧卡清零——shad Card/ring 卡统一为灰卡 ([2db7a8f](https://github.com/helixnow/deep-student/commit/2db7a8f93b011626f63c2239fc289df0beb91ab7))
* **settings:** P2 区域标题字重归位 + 行内确认取消按钮统一 ([e66050b](https://github.com/helixnow/deep-student/commit/e66050b9c540d40a2ba27cf0156b254c32fb5016))
* **settings:** P2 收尾——虚线空态灰卡化 + McpTools 控件契约化 ([3682639](https://github.com/helixnow/deep-student/commit/368263992f65c3bdf5f163f16cd57f97f8dfe574))
* **settings:** P2 统一收尾——供应商详情虚拟化模式/编辑表单/空态、归档、统计标题 ([2b73392](https://github.com/helixnow/deep-student/commit/2b733928b2c7e7a224bd66d58ebf47abe85bceff))
* **settings:** P2-9 供应商列表行补键盘激活与移动端语义 ([b656f79](https://github.com/helixnow/deep-student/commit/b656f7981b2f9501a67a580b00ba1fb8ddbfb921))
* **settings:** 下拉选择器摘掉 h-11+text-xs 覆盖，尺寸交还按钮契约 ([a362552](https://github.com/helixnow/deep-student/commit/a362552f35f1d79462fe182840a049abfa75b330))
* **settings:** 修复移动端设置抽屉返回/关闭按钮被拖拽手势误吞 ([51d7385](https://github.com/helixnow/deep-student/commit/51d7385312f84f2e6247d6f9affe02e510a3df0d))
* **settings:** 卡内次级按钮统一描边、空态标题统一左对齐（自动化/Subagent/MCP/供应商/记忆/听写/Codex/OCR） ([b8ac600](https://github.com/helixnow/deep-student/commit/b8ac6007d494ed27369cb8f29b0f4351465fc331))
* **settings:** 外部搜索引擎详情标题外置——h3 移出卡片，内容/策略区独立成卡 ([e908570](https://github.com/helixnow/deep-student/commit/e908570d0cfaa0661aa274fb2f1d9a8add7ed0ae))
* **settings:** 常规/外观页卡内按钮统一描边（default/ghost/primary→outline），下拉触发器同步 ([237d4e1](https://github.com/helixnow/deep-student/commit/237d4e1262bb1f4e0e4fbdfa45079448a6bdf62d))
* **settings:** 按钮变体收尾——剩余 default 省略/动态 default 全部归位 ([783e5df](https://github.com/helixnow/deep-student/commit/783e5dfcde8a45a97477c3a71487ef92f59a84ab))
* **settings:** 按钮变体收敛——消灭 tonal 灰底类，独立操作统一 outline ([e664492](https://github.com/helixnow/deep-student/commit/e664492323134f39f4e81a91813916ca0382a26a))
* **settings:** 插件/关于页卡内按钮统一描边，开源致谢内联卡改无描边灰填充 ([26ae52a](https://github.com/helixnow/deep-student/commit/26ae52a8a1b45a9e6ca7c0396ccf7247b190191b))
* **settings:** 数据治理/数据统计卡内按钮统一描边，概览卡片改无描边灰填充 ([0fa542b](https://github.com/helixnow/deep-student/commit/0fa542bd5c525961de20ee68a4f1d4a2e5eb55c9))
* **settings:** 数据治理四 tab 统一灰卡语言 ([db8827d](https://github.com/helixnow/deep-student/commit/db8827d90d0b64f6c1831f6edb0e531e30dd2fca))
* **settings:** 自动化页标题外置——非嵌入态 section 去整体卡壳，内容区单独包灰卡 ([da8dfd3](https://github.com/helixnow/deep-student/commit/da8dfd391821eed1a0cfa52b73fc119895b3656b))
* **settings:** 语音听写/记忆独立页补灰卡容器（拆分遗失的 embedded 宿主卡） ([3715845](https://github.com/helixnow/deep-student/commit/37158458c6c45b68282bafa0fa722da8dc71f629))
* **shell:** mac/Linux 完全信任通道不再施加 RLIMIT 资源上限 ([0c4abe3](https://github.com/helixnow/deep-student/commit/0c4abe35cdd47b03bdb0f8acdbb4ee939c29908e))
* **shell:** 修复沙箱反馈四连——失败原因回传 AI、localhost 例外、完全信任模式真正放开 ([1d15b74](https://github.com/helixnow/deep-student/commit/1d15b74b5a8968f567cdf3db41ce2b006cbb310c))
* **shell:** 移动端视图层切换动画方向镜像（返回时反向滑出） ([e9803c0](https://github.com/helixnow/deep-student/commit/e9803c0a2415ef580cb6bd1cede1d03da70a7610))
* **skills:** 技能卡片网格补 grid-cols-1，修复移动端卡片横向溢出 21px ([5a5d460](https://github.com/helixnow/deep-student/commit/5a5d460ca89901bf628c2eb20b0d95b05f071ff5))
* **template-mgmt:** 面包屑标题语义化 h1 并锁定 14px 字号，滚动内边距移到内容包装层 ([55237bb](https://github.com/helixnow/deep-student/commit/55237bb5ef010904f7b52ba4f2aae9ee271db878))
* **todo:** 顶部工具栏按钮尺寸统一——摘手写 h-8/coarse 覆盖交还按钮契约 ([2b3d5ee](https://github.com/helixnow/deep-student/commit/2b3d5eeda9f9d424f3557b8421363bdb17537807))
* **tools:** 修复调研发现的同类问题——chatanki 错误人读化、业务失败语义、SSRF 正源统一 ([bc21a4f](https://github.com/helixnow/deep-student/commit/bc21a4fdd7d856e27fea50e9c42cd4040efccc4e))
* **ui:** 移动端按钮壳-内容比例协调（44px 壳配更大字号/图标） ([8f7e519](https://github.com/helixnow/deep-student/commit/8f7e5190212e95f9df67a506693fb4be1cb1223a))

## [0.9.46](https://github.com/helixnow/deep-student/compare/v0.9.45...v0.9.46) (2026-08-30)


### Bug Fixes

* **license:** 门禁哈希剔除 package-lock.json 版本字段 ([419d213](https://github.com/helixnow/deep-student/commit/419d2130883e9e11510cc5d015be378f9e74a86e))

## [0.9.45](https://github.com/helixnow/deep-student/compare/v0.9.44...v0.9.45) (2026-08-30)


### Features

* **app:** 0824 批次应用外壳与其余前端改动 ([1d81763](https://github.com/helixnow/deep-student/commit/1d8176383d7debaf88df1dade8a8286020590360))
* **chat:** 0824 批次聊天域前端迭代 ([707acef](https://github.com/helixnow/deep-student/commit/707aceff918b8db9e1ac9bb6d901c8a9547368fe))
* **components:** 0824 批次共享组件库迭代 ([ee2e28e](https://github.com/helixnow/deep-student/commit/ee2e28ea865652352e2cdc836da0fb4b106b67c0))
* **debug-panel:** 0824 批次调试面板迭代 ([f71d5ad](https://github.com/helixnow/deep-student/commit/f71d5ad64a10bb9ffc026c16699e2621c2b143a7))
* **dstu:** 0824 批次 dstu 模块迭代 ([de3d98d](https://github.com/helixnow/deep-student/commit/de3d98de55f13b99e3aacbc09cbabdf7b853006d))
* **essay-grading:** 0824 批次作文批改迭代 ([44af9b8](https://github.com/helixnow/deep-student/commit/44af9b81b6887284833caf94ffffac6458851b3d))
* **features:** 0824 批次其余功能域前端迭代 ([adc834b](https://github.com/helixnow/deep-student/commit/adc834b37c033a54bb89ab48b25173cba8830c9f))
* **generative-ui:** 0824 批次生成式 UI 前端迭代 ([2302215](https://github.com/helixnow/deep-student/commit/23022152d338cbb8bebddfdead9715e1fb70a1e8))
* **i18n:** 0824 批次本地化与翻译迭代 ([ca3c9e7](https://github.com/helixnow/deep-student/commit/ca3c9e7dbba494e83c1c75eded53fde2f715b4ae))
* **learning-hub:** 0824 批次学习中心前端迭代 ([0e53031](https://github.com/helixnow/deep-student/commit/0e5303143843660fdb571c77285bd9d1e9534ee9))
* **llm:** 0824 批次 LLM 管理与 HPIAS 迭代 ([a1a6146](https://github.com/helixnow/deep-student/commit/a1a6146e3cfeaf1c09af330e6b7614e016d8f5dd))
* **notes:** 0824 批次笔记与脑图前端迭代 ([4ad43ab](https://github.com/helixnow/deep-student/commit/4ad43ab77f4db041ad1d6526eec314bfcfa568a8))
* **platform:** 0824 批次前端平台层（hooks/stores/utils/shared/styles）迭代 ([97a678e](https://github.com/helixnow/deep-student/commit/97a678e2cb4933659d7da87b5c13846b975281fb))
* **settings:** 0824 批次设置页面前端迭代 ([e2562ee](https://github.com/helixnow/deep-student/commit/e2562ee5ec5f16e48fe791c43ec871d92800e6be))
* **todo,skills,workbench:** 页面工具栏迁入全局顶栏，消除三层条带堆叠 ([478f8f0](https://github.com/helixnow/deep-student/commit/478f8f01ce8c40a2fc4943c383d6b1852dc55477))
* **workbench:** 0824 批次工作台前端迭代 ([8fa9d38](https://github.com/helixnow/deep-student/commit/8fa9d38b68a5010c5ec7f34e107bc6100e4b0e12))


### Bug Fixes

* backfill missing VFS tables before change_log pre-repair ([b2a85a6](https://github.com/helixnow/deep-student/commit/b2a85a6900034943a2bedb7c5ebcf95ec7854fea))
* **chat_v2:** 0824 批次后端会话/工具链迭代与 Windows 沙箱保护修复 ([5e29fc4](https://github.com/helixnow/deep-student/commit/5e29fc458026aa09ff020d121ad07a57918c360f))
* **chat:** 移动端欢迎空态不再显示 Ctrl/⌘+N 键盘快捷键提示 ([3d2bb2a](https://github.com/helixnow/deep-student/commit/3d2bb2a6dfce1892a33dce2367e73d5cb2d9c961))
* **chat:** 闪卡复习按钮移动端隐藏，避免仅桌面端可用的死路动作 ([ccd6f43](https://github.com/helixnow/deep-student/commit/ccd6f43775b822e866577f864ce7edc775d2fca8))
* **ci:** include version in macOS updater archive names ([#156](https://github.com/helixnow/deep-student/issues/156)) ([0e4c9fa](https://github.com/helixnow/deep-student/commit/0e4c9fad55aee40c42418ada71b6d03caecc25ec))
* **governance:** 0824 批次数据治理与迁移修复 ([6aec935](https://github.com/helixnow/deep-student/commit/6aec93509e7c41ba9eeec78180abbb9741dbd430))
* **learning-hub:** 移除挤压主内容区的 GenerativeBriefing 简报组件 ([8adb78d](https://github.com/helixnow/deep-student/commit/8adb78d39f0d2dd936da396aba3225e6c3fd7124))
* **mobile:** 修复手势 touchcancel 卡死与滑动误触豁免 ([7122093](https://github.com/helixnow/deep-student/commit/712209310ca4f555a4f5c4c976dbd88d93e8cbec))
* **mobile:** 触控目标 44px 契约真正生效——修正 rem 锚点缩水 ([c9c1acc](https://github.com/helixnow/deep-student/commit/c9c1acc0633df51bfbd447f63e6afca691dc0e87))
* **mobile:** 输入框防缩放、横屏安全区与触控可读性修复 ([91d538f](https://github.com/helixnow/deep-student/commit/91d538fb652b2114df4154a7a5cf3863ba77460e))
* **sync:** 0824 批次云存储与同步修复 ([5fc21a2](https://github.com/helixnow/deep-student/commit/5fc21a2e4eab5ff717a7694f3ba576f5d5255319))
* **todo:** 移除子屏各自叠加的底部安全区，消除与 overlay 容器兜底的双计留白 ([400797b](https://github.com/helixnow/deep-student/commit/400797bd2ee6e254eb9c1e3405a231baa67751e4))
* **todo:** 移除空态背景同心圆环装饰（产品决策：观感不佳） ([bf2c2ba](https://github.com/helixnow/deep-student/commit/bf2c2ba08bd89e19324e454931572829b393ec0d))
* **todo:** 空态同心圆环不居中——过约束绝对定位下 auto margin 解析为 0 ([9d96848](https://github.com/helixnow/deep-student/commit/9d96848a4fe5bf6e2bffd2bc288e3725b4681ca6))
* **vfs:** 0824 批次虚拟文件系统修复 ([96511e1](https://github.com/helixnow/deep-student/commit/96511e1350120a6e0df19563d4edeec08e162095))
* **workbench:** 桌面 AI 简报移入右上角组件栏，修复与桌面图标重叠 ([4e214ff](https://github.com/helixnow/deep-student/commit/4e214ff7793b6246730e9b1cae9a03448ce8fa50))
* **workbench:** 窄桌面组件栏隐藏与状态栏断点对齐全局 ([e5f9792](https://github.com/helixnow/deep-student/commit/e5f9792085e3f2266c1164c6f4fc7bb87fedff85))

## [0.9.44](https://github.com/helixnow/deep-student/compare/v0.9.43...v0.9.44) (2026-08-08)


### Features

* VLM grounding fallback, prompt-cache replay consistency, deepseek Responses API, release metadata refresh ([#152](https://github.com/helixnow/deep-student/issues/152)) ([f473a6d](https://github.com/helixnow/deep-student/commit/f473a6d6495ecf848997eee5a46b5827e49ba7fb))


### Bug Fixes

* **android:** guard desktop-only browser APIs ([c6c497c](https://github.com/helixnow/deep-student/commit/c6c497c2ad8a16817bb52809b482d686d6563e14))
* **android:** guard desktop-only browser APIs ([dd44bce](https://github.com/helixnow/deep-student/commit/dd44bce27b539f9544ab50a8c28ec9ed4d120281))
* **ci:** allow explicit fixture override for release recovery ([f5a88a8](https://github.com/helixnow/deep-student/commit/f5a88a83f33c5985d88bf7fd1938155c95987685))
* **ci:** allow explicit fixture override for release recovery ([7ddc93d](https://github.com/helixnow/deep-student/commit/7ddc93df77e7090acc045ab69ee7273aa40eb29f))
* **ci:** allow explicit unsigned desktop release recovery ([d1875b6](https://github.com/helixnow/deep-student/commit/d1875b6d08759bd239d7dd9ffb873a13a54a1d0e))
* **ci:** allow explicit unsigned desktop release recovery ([04361b6](https://github.com/helixnow/deep-student/commit/04361b685eb34a388907f4a24980536cef75f4c0))
* **ci:** build only Android APK ([0b199ae](https://github.com/helixnow/deep-student/commit/0b199ae84b52437634975df31e1f5b7f76cdaa51))
* **ci:** build only Android APK ([608f2ad](https://github.com/helixnow/deep-student/commit/608f2ad5e550826bbe083d0c44b993cc53795866))
* **ci:** build only NSIS on Windows releases ([5cf2819](https://github.com/helixnow/deep-student/commit/5cf281909eb61ec3faef3135eac4669014f9c87d))
* **ci:** build only NSIS on Windows releases ([b41a835](https://github.com/helixnow/deep-student/commit/b41a83532b3e5b30d48c11d422d50bd65afdf892))
* **ci:** extend macOS release build timeout ([db16fd8](https://github.com/helixnow/deep-student/commit/db16fd864ca3a1b74f3361b9cbb7d5ffacc4e11a))
* **ci:** extend macOS release build timeout ([f6accc4](https://github.com/helixnow/deep-student/commit/f6accc47133b9c85beb4eb18033fec400938a007))
* **ci:** fetch full history for migration release gate ([cdd9d73](https://github.com/helixnow/deep-student/commit/cdd9d73aad25929061cb5fc35018a986799dc6a9))
* **ci:** fetch full history for migration release gate ([211f138](https://github.com/helixnow/deep-student/commit/211f1386463b31427e2e01777364d2e5f36126cb))
* **ci:** finish v0.9.43 Android recovery build ([9834207](https://github.com/helixnow/deep-student/commit/983420766c0dbbc0f49ae0501420669823081ed1))
* **ci:** flatten Linux hotfix artifacts ([fdee8aa](https://github.com/helixnow/deep-student/commit/fdee8aa2a0d0a4fc354d8c87b679510f04901c02))
* **ci:** flatten Linux hotfix artifacts ([#146](https://github.com/helixnow/deep-student/issues/146)) ([b10b0bb](https://github.com/helixnow/deep-student/commit/b10b0bb9cdbf2fce55b563f535365ce1a37298b3))
* **ci:** isolate Android recovery queues ([cccad99](https://github.com/helixnow/deep-student/commit/cccad99f46c18b3f27904789712f562357e5e736))
* **ci:** isolate Android recovery queues ([793b196](https://github.com/helixnow/deep-student/commit/793b1961db34d17a491aef047110f9842809cf5b))
* **ci:** make unsigned macOS recovery builds work ([336d6a3](https://github.com/helixnow/deep-student/commit/336d6a3e7a62427bbb2089206b92a9ffd9852186))
* **ci:** make unsigned macOS recovery builds work ([#147](https://github.com/helixnow/deep-student/issues/147)) ([30fdf51](https://github.com/helixnow/deep-student/commit/30fdf51cd832b38daf8d660ff06b7c6fa1780c03))
* **ci:** mark rebuilt Android release available ([3e2e914](https://github.com/helixnow/deep-student/commit/3e2e91496d4bd06b93dd923c8eed7ae8f7154387))
* **ci:** mark rebuilt Android release available ([e80b159](https://github.com/helixnow/deep-student/commit/e80b159ca0e90c2f6fc65263d1bd1e9eace2672b))
* **ci:** multipart upload large R2 release assets ([30b830c](https://github.com/helixnow/deep-student/commit/30b830cec4918bfd6137dadd4990635b4aa6ec9c))
* **ci:** multipart upload large R2 release assets ([2d9de10](https://github.com/helixnow/deep-student/commit/2d9de1089a5203678c6af61c072e85bafe051367))
* **ci:** overlay macOS release tooling ([7bc74ca](https://github.com/helixnow/deep-student/commit/7bc74cae697163a14609cfb03c5974ae81e48d32))
* **ci:** overlay macOS release tooling ([32586f3](https://github.com/helixnow/deep-student/commit/32586f30ee6da642296815837b7b8f9cfdda5e49))
* **ci:** overlay release fixture harness ([41f72ef](https://github.com/helixnow/deep-student/commit/41f72efcb4829f6f0a072e68cbe0d70c8b13a5b4))
* **ci:** overlay release fixture harness ([943b067](https://github.com/helixnow/deep-student/commit/943b06725d59ba82feda4dce9280eb154a1e88e5))
* **ci:** provision release migration fixture ([0e6f8d1](https://github.com/helixnow/deep-student/commit/0e6f8d1fa5b23ab7163edb489f85ad6c3a0333b8))
* **ci:** provision strict release migration fixture ([cb54533](https://github.com/helixnow/deep-student/commit/cb54533344ecfc5de2439c2ce44bfdb02c5d5d8d))
* **ci:** reduce Android release compile latency ([342e961](https://github.com/helixnow/deep-student/commit/342e961f0237ed8b9f031d6892df961f7c810117))
* **ci:** reduce Android release compile latency ([#145](https://github.com/helixnow/deep-student/issues/145)) ([4240f4d](https://github.com/helixnow/deep-student/commit/4240f4d9e74cac5da4fdcca451caf32d7fc5ede0))
* **ci:** refresh release lock metadata before packaging ([ea7896c](https://github.com/helixnow/deep-student/commit/ea7896c2bbd2f1960b52300f8be31c9d804f96a1))
* **ci:** refresh release lock metadata before packaging ([9df69c4](https://github.com/helixnow/deep-student/commit/9df69c4c98eaa2797653728615675b28cae3a148))
* **ci:** retry pdfium downloads ([201be66](https://github.com/helixnow/deep-student/commit/201be668e5a974779725416b3d0f81c631f175fd))
* **ci:** retry pdfium downloads ([a677bbc](https://github.com/helixnow/deep-student/commit/a677bbcaa025aed975105ab992ce902f4366ecd3))
* **ci:** shorten Android release compilation ([058808a](https://github.com/helixnow/deep-student/commit/058808ad9d11009eace360120a244ee9cda445dd))
* **ci:** shorten Android release compilation ([f0f5145](https://github.com/helixnow/deep-student/commit/f0f514502a111c191833f8f8262219d611b5f071))
* **ci:** stabilize release builds across hosted runners ([bac0b36](https://github.com/helixnow/deep-student/commit/bac0b366972605da2e22eb75704314e5219eb20e))
* **ci:** stabilize release builds across hosted runners ([5740392](https://github.com/helixnow/deep-student/commit/5740392e4029ef7a1d40ab3fecafdefad10329b5))
* **ci:** support Tauri v2 Linux updater artifacts ([78ad9bc](https://github.com/helixnow/deep-student/commit/78ad9bc67b0ad898ef40ec23cca4ac1567a0fdca))
* **ci:** support Tauri v2 Linux updater artifacts ([#144](https://github.com/helixnow/deep-student/issues/144)) ([d420ec0](https://github.com/helixnow/deep-student/commit/d420ec0dfe8bee9f9b59aa2dc0ff6e9b32389125))
* **ci:** use lean Android release feature profile ([5738930](https://github.com/helixnow/deep-student/commit/5738930ef28aaf1605638c3a3ec2e2d5d2e3a537))

## [0.9.43](https://github.com/helixnow/deep-student/compare/v0.9.42...v0.9.43) (2026-08-03)


### Features

* **260716-kcq:** import custom wallpapers into app storage ([7459ac1](https://github.com/helixnow/deep-student/commit/7459ac1dd478d7e71438044ce6b482bddfb16312))
* **agent:** expand Chat tool execution and automation runtime ([f32d820](https://github.com/helixnow/deep-student/commit/f32d820a356e542537e8839dac984dedeb742157))
* **anki:** complete APKG and FSRS review workflows ([76c5f8f](https://github.com/helixnow/deep-student/commit/76c5f8f9ece9e0da3c99ac19c7b6ea2c3f0f7c4c))
* **app:** add recovery flows and harden agent runtime ([380ea70](https://github.com/helixnow/deep-student/commit/380ea703efc2646b3b32bffb4ed64a10ee459324))
* **app:** unify titlebar surface, clean native material, and lazy-load debug panel ([7d01fad](https://github.com/helixnow/deep-student/commit/7d01fadbf46d27c843127d4dc72b3a595aa2db97))
* **automation-ui:** surface completed runs and sessions ([3dadd67](https://github.com/helixnow/deep-student/commit/3dadd67a1583573b9cb6dfcab66c8ead444f556e))
* **boot:** brand boot and lazy-load screens with square logo mark ([679471c](https://github.com/helixnow/deep-student/commit/679471c9be3196bcca55e01b8b6a338f874903f9))
* **browser,codex:** add native browsing and Codex account management ([e76f7ba](https://github.com/helixnow/deep-student/commit/e76f7ba30d086367e661b82f8d85e1bfc28c5acc))
* **browser:** add embedded browser stack for workbench ([5c85e06](https://github.com/helixnow/deep-student/commit/5c85e0688887fa7e7fec7179bb61789a2e274ed3))
* **browser:** harden sessions, navigation policy, and takeover flow ([1df76fc](https://github.com/helixnow/deep-student/commit/1df76fce39ab45535321175583fca61b829985fb))
* **chat-v2:** add agent tool executors, export handlers, and compaction lineage ([3c6a57f](https://github.com/helixnow/deep-student/commit/3c6a57f0924cbfd0fdd6b0739d91c6ea1451ecde))
* **chat-v2:** harden shell sandbox, skill trust, and file preview systems ([1ca3b8f](https://github.com/helixnow/deep-student/commit/1ca3b8fac1a3110719e508cde5e2fb555809f65d))
* **chat-v2:** harden subagent runtime, workspace integration, and notes app ([a3f4b3a](https://github.com/helixnow/deep-student/commit/a3f4b3affe0bb9a69961aa72f54bb0a3648929d0))
* **chat-v2:** rework retrieval executor, automations, and session management ([aadbeb7](https://github.com/helixnow/deep-student/commit/aadbeb7d2730465eec27484c151eb483b3459d3b))
* **chat-v2:** strengthen tool execution and agent coordination ([a9c0ad7](https://github.com/helixnow/deep-student/commit/a9c0ad70c108e16cfdee193b1122eb171c7fca3b))
* **chat,editor,workbench:** expand productivity tools and runtime roots ([180625c](https://github.com/helixnow/deep-student/commit/180625c7299e360b0ee47dd6212dd22a5ea08783))
* **chat:** add in-conversation message search with hit navigation ([f5d7091](https://github.com/helixnow/deep-student/commit/f5d70918d4d36029f16d20403888dc361e1427f0))
* **chat:** async subagent wake, read-only sessions, and stream cleanup ([8e08f0a](https://github.com/helixnow/deep-student/commit/8e08f0afff50210982b5756d45841ae06790a479))
* **chat:** compact tool activity timeline with sweep visuals and tool grouping ([fbe2e96](https://github.com/helixnow/deep-student/commit/fbe2e9640aa6773850d7fab7f0140717063ddd6e))
* **chat:** enhance message list auto-scroll behavior and user interaction detection ([8681470](https://github.com/helixnow/deep-student/commit/8681470f8c6464e211c2f86184dd57aac016c2c3))
* **chat:** expand tool executors and policy gating ([76034bd](https://github.com/helixnow/deep-student/commit/76034bddc3003ce9588203d8e76352d11717dbbe))
* **chat:** harden agent runtime, tools, and session lifecycle ([975c8f1](https://github.com/helixnow/deep-student/commit/975c8f1b4ebf3658ff22236547b6306934e45a5a))
* **chat:** harden tool permissions and workflows ([3021373](https://github.com/helixnow/deep-student/commit/30213739a2476f9647d0f1a7ca2003a9e164cd49))
* **chat:** headless runner and pipeline tool-loop rework ([b085f85](https://github.com/helixnow/deep-student/commit/b085f854b8cb3501a03a85afe0cac77d52ace682))
* **chat:** integrate adapters, UI shell, and remaining chat surfaces ([9a4d86c](https://github.com/helixnow/deep-student/commit/9a4d86cb2dc8187367e78514e317ebf4ff251b83))
* **chat:** rebuild input bar, anki card blocks, and mobile message actions ([f1d665e](https://github.com/helixnow/deep-student/commit/f1d665e519676bea4422d63ff9009ac53b6498fe))
* **chat:** refine composer, streaming, sources, and sessions ([f1a4386](https://github.com/helixnow/deep-student/commit/f1a4386650c709795f1ca5158109ad626b87c971))
* **chat:** rework stream lifecycle, agent task UI, and session browser ([00df945](https://github.com/helixnow/deep-student/commit/00df945151160ebdf58e380a54d664bdde4db36c))
* **chat:** scoped approval manager and blocking approval UX ([24eb0b8](https://github.com/helixnow/deep-student/commit/24eb0b8a57182113b280205022da0d5b943f667b))
* **chat:** skills lifecycle, automations, and runtime roots ([9f79bfd](https://github.com/helixnow/deep-student/commit/9f79bfdb7302c66157e25b5cceead68435aba3cc))
* **chat:** unify conversation controls into plus menu and full-bleed mobile drawer chrome ([dc47688](https://github.com/helixnow/deep-student/commit/dc47688344a33b2ce568236088727879f62c2ca6))
* **chat:** workspace and workbench ops overhaul ([71d650e](https://github.com/helixnow/deep-student/commit/71d650e47a69bc88a3a2141138349c2159b797b5))
* complete agent workflows and platform hardening ([c273c1e](https://github.com/helixnow/deep-student/commit/c273c1e3cd4599527b4411e59117fa1d88c9486c))
* **content:** improve learning hub, notes, and reader workflows ([8bc6018](https://github.com/helixnow/deep-student/commit/8bc6018b15f6e39036852700fa13b2d924a9122d))
* **data:** strengthen backup, sync, and VFS consistency ([62f43cb](https://github.com/helixnow/deep-student/commit/62f43cb1086e6db29d7e3ed85289d26ec7713b0b))
* **devtools:** unify devtools toggling in a shared helper with tauri command ([f968be4](https://github.com/helixnow/deep-student/commit/f968be4eb0d235db3885762b2511a465abb1083f))
* **documents:** secure parsing, export, and multimodal workflows ([65bbc9a](https://github.com/helixnow/deep-student/commit/65bbc9a462195ebb70d77dc84d80ea226ac252b7))
* **dstu:** add agent document and canvas operations ([34ee5cc](https://github.com/helixnow/deep-student/commit/34ee5ccf57684b41536e66ef644f479b1c626bdf))
* **eslint:** add react-hooks plugin and rules for hooks validation ([bd2114f](https://github.com/helixnow/deep-student/commit/bd2114f2703eb99bc5346b9ae45cadca8a546df7))
* **fixtures:** add script for generating learning resource preview fixtures ([a271a67](https://github.com/helixnow/deep-student/commit/a271a67164aba5b81cb140d8c08bcdf57e4c15a4))
* **flashcards:** add FSRS review app and Anki service layer ([82fb6c0](https://github.com/helixnow/deep-student/commit/82fb6c00711cbaba36e4d56fc873acc27a89a2f9))
* **i18n:** enhance lazy-loading and language change handling ([8b57cfa](https://github.com/helixnow/deep-student/commit/8b57cfa24a83d9070ff3d2f34bbbff7c6a76567a))
* **learning-hub:** improve previews, finder, tabs, and export ([8ddf754](https://github.com/helixnow/deep-student/commit/8ddf754e31fb52d2e19697440a60fae1be6d94f5))
* **learning:** harden memory, FSRS, and question workflows ([4a24926](https://github.com/helixnow/deep-student/commit/4a2492625558c34c1e1dd5398004ab8b447a887e))
* **llm:** add routing/failover layer and expand provider streaming ([53a22a3](https://github.com/helixnow/deep-student/commit/53a22a3117a28edaf96def34c8c3738bedd54bac))
* **memory:** learner profile, compaction flush, and VFS hardening ([73ad465](https://github.com/helixnow/deep-student/commit/73ad4658a42e6e36da2eecd47d7f9744f3ba7b66))
* merge os into main for experimental release ([39e7c59](https://github.com/helixnow/deep-student/commit/39e7c591a3e57e81e47d30d380ad70264fc965f1))
* **mindmap:** enhance canvas interactions, outline multiselect, and version lookup ([11b057f](https://github.com/helixnow/deep-student/commit/11b057f575b7c5c85621ea43880706a370c28bb0))
* **mindmap:** enhance outline editing, search, and node operations ([679bcb4](https://github.com/helixnow/deep-student/commit/679bcb41f5b7414b0b0996e28b86efc9d2708c57))
* **mindmap:** isolate instances and make batch edits atomic ([48fdd6c](https://github.com/helixnow/deep-student/commit/48fdd6cd87bfa7925a173cbc6f64c9d3e58ab44a))
* **mindmap:** refine interactions, layouts, and import workflows ([3965276](https://github.com/helixnow/deep-student/commit/396527613432cc48ee9aeb1cc681859ae8191b24))
* **mindmap:** split outline view, add layout engines, and mobile toolbar ([f21319f](https://github.com/helixnow/deep-student/commit/f21319fee2660c7c27b8104fd7d38fb1b91be38b))
* **mobile-ui:** comprehensive UI drive and mobile UX audit infrastructure ([c88c600](https://github.com/helixnow/deep-student/commit/c88c600bb59de57ed8538042316572a78083bb47))
* **mobile:** command palette drawer entry, image pinch zoom, tab rail scroll hint ([ef62101](https://github.com/helixnow/deep-student/commit/ef621014d7927f8199aca28811bd0aadc343a266))
* **mobile:** polish sidebar nav divider, composer button and empty state ([defa861](https://github.com/helixnow/deep-student/commit/defa8613e7e2cd99391c8e17356347fc96c6783f))
* **models:** improve provider capabilities and routing controls ([7b1da2d](https://github.com/helixnow/deep-student/commit/7b1da2dc1f2aa70cbc6224ec9fbe72a17facfa11))
* **notes,learning-hub:** add note tags, agent follow, and exam view rework ([b647e81](https://github.com/helixnow/deep-student/commit/b647e81e610abbfc44de1ffdddbb4c9d08940bab))
* **notes,learning-hub:** improve editing, previews, and navigation ([1b009e6](https://github.com/helixnow/deep-student/commit/1b009e67ef3c5a6cc738421ff48447a63f33d651))
* **notes,learning-hub:** rework pdf viewer, media players, and crepe plugins ([805279a](https://github.com/helixnow/deep-student/commit/805279ab262bc4e35f0ee35fcd6a5566d59fb91a))
* **notes,mindmap:** introduce comprehensive UI/UX remediation prompt and enhance command palette functionality ([0f44c91](https://github.com/helixnow/deep-student/commit/0f44c913e29eb8dd19077a47b061f755eb79913b))
* **notes:** harden editor save paths and notes export ([94c0588](https://github.com/helixnow/deep-student/commit/94c0588352684ba147e1f62f0cfa8a1f81fa2880))
* **platform:** harden backup, sync, storage, and recovery ([8a68823](https://github.com/helixnow/deep-student/commit/8a68823ec5517c998a794ebf1f3cd239efc0e745))
* **platform:** harden storage layer, memory dedup, and system services ([c006f45](https://github.com/helixnow/deep-student/commit/c006f457b00939add5f4f4236f2eaac6c15b21a7))
* **platform:** rework notes storage, migration safety rails, and media backend ([027670a](https://github.com/helixnow/deep-student/commit/027670a6123cf3a52dfee94dcbaa9d39415bf2a3))
* **plugins:** add managed extensions and iLink bot integration ([59df0ab](https://github.com/helixnow/deep-student/commit/59df0ab4722bcffa0a173a7fbbacc1913a7d6675))
* **practice,anki:** add structured question types and stats charts ([c2c9e33](https://github.com/helixnow/deep-student/commit/c2c9e3345cfed8b31253f9a1d0e5f0556c3a6f85))
* **practice,anki:** improve question banks, review, and card workflows ([1cc9be7](https://github.com/helixnow/deep-student/commit/1cc9be741da30e928cef5015169d9da7f9f55d71))
* **practice,anki:** rework flashcards screens and template management ([5ec5c29](https://github.com/helixnow/deep-student/commit/5ec5c294e254ab46e959719e3809ed8a033d5c00))
* **productivity:** refresh todo, pomodoro, and sandbox UI ([7443da4](https://github.com/helixnow/deep-student/commit/7443da4049ed96f9c88a1d2fd60511ca121339cd))
* **qbank:** expand question management and review workflows ([2d7b76c](https://github.com/helixnow/deep-student/commit/2d7b76c4f78cd6af6839a0da62727d82384da26f))
* **qbank:** unify exam tab visuals with manage-view style and fix wrong-answer tracking ([cea6c04](https://github.com/helixnow/deep-student/commit/cea6c044babe9b140a3444c47e29451ca2afc43b))
* **scroll:** platform-aware track click and native scrollbar polish ([e1a76c5](https://github.com/helixnow/deep-student/commit/e1a76c5666cd678a2fedb29a49fb52e282a8857f))
* **settings:** add system permissions and subagent profiles sections ([1d2a964](https://github.com/helixnow/deep-student/commit/1d2a9647e1dcea99ea35c95e295d9781a091dd3e))
* **settings:** add workbench settings section and shell UX polish ([45e424c](https://github.com/helixnow/deep-student/commit/45e424c476a1c695b9337d0c8091593ec82e8328))
* **settings:** expand models, permissions, and system controls ([d89e772](https://github.com/helixnow/deep-student/commit/d89e772776983cc845605e93316fd99b2542bf8a))
* **settings:** present mobile settings as a full-screen sheet ([c54e0fb](https://github.com/helixnow/deep-student/commit/c54e0fb5eb210d87e3399794c4987cbfc47d1566))
* **settings:** redesign mobile settings home as two-column card grid ([e8cc328](https://github.com/helixnow/deep-student/commit/e8cc328cd08e55b6436b134b2c12a0d4defcad56))
* **settings:** require explicit save for API keys with paste sanitization and temporary reveal ([b1ad1a1](https://github.com/helixnow/deep-student/commit/b1ad1a12ae3036acc5d388d7493c272c7e5934db))
* **settings:** rework automation section and vendor configuration ([6d9abf2](https://github.com/helixnow/deep-student/commit/6d9abf297ae800c3d7048c173cb53cf5db529877))
* **settings:** show DeepSeek account balance badge for official vendors ([7428b10](https://github.com/helixnow/deep-student/commit/7428b102924c8fe6a2b1789f862f0a15b8a59e72))
* **shell:** inline title editing, sidebar action cluster, and collapse surface motion ([6ddf325](https://github.com/helixnow/deep-student/commit/6ddf3255bdd7c53130f3103581073142dcae2990))
* **shell:** show new-session action when sidebar collapsed ([1ad0074](https://github.com/helixnow/deep-student/commit/1ad0074cde85f059f6fa6096f3351a49d8f6c69b))
* **sidebar:** reveal create-conversation action on section hover ([8bc50b5](https://github.com/helixnow/deep-student/commit/8bc50b51e5640a0e5a64075e145a1eaf238cec3f))
* **skills,workbench,anki:** expand skill ecosystem with tap sources and task management ([544d270](https://github.com/helixnow/deep-student/commit/544d270aa69cbc3e77f3643b83b2e763cfeaad87))
* **skills:** improve managed tool configuration surfaces ([8f1d0e1](https://github.com/helixnow/deep-student/commit/8f1d0e1ea9c22e063bb6e70f9bd5bf625fb922cb))
* **skills:** migrate community marketplace and runtime admission ([930bd22](https://github.com/helixnow/deep-student/commit/930bd22d82c9a0ce8b2cf7b0d89a7cc4ef6c2a7c))
* **skills:** support JSON Schema composition keywords ([37ae1d5](https://github.com/helixnow/deep-student/commit/37ae1d572712827d65b3bd38c50d753334a50736))
* **sync:** harden cloud conflict and restore handling ([90fe67d](https://github.com/helixnow/deep-student/commit/90fe67dea1066c63ebd7e6062717a545367db358))
* **theme:** add bright-pink accent palette ([13f1819](https://github.com/helixnow/deep-student/commit/13f1819bee91b388c5e9769eaa733114d83e1afa))
* **theme:** sync native macOS window appearance with app theme ([7d682fe](https://github.com/helixnow/deep-student/commit/7d682febb07c1e3b4b74d7fce014e367e650825f))
* **todo,pomodoro:** decompose main panel and add automation workspace ([dafdfdb](https://github.com/helixnow/deep-student/commit/dafdfdb223ccdad87914606568eb7122b300fd55))
* **todo,pomodoro:** redesign task detail and add pomodoro stats sync ([08130d5](https://github.com/helixnow/deep-student/commit/08130d50de34f2fe864c5f1950e7fbed50a2a3eb))
* **todo,pomodoro:** refine task and focus workflows ([90bc551](https://github.com/helixnow/deep-student/commit/90bc551d8a96028b2112e004c9c2e8df907201ff))
* **tooltip:** fade-out animation with CSS variable driven duration ([e4a6ead](https://github.com/helixnow/deep-student/commit/e4a6ead58dcbd4629d742646bc9108f1243ad87c))
* **translation,essay-grading:** add candidate pipeline and inline grading settings ([698f111](https://github.com/helixnow/deep-student/commit/698f111116ddc4fa367dece8a7aa17f1709a3bea))
* **translation,essay-grading:** improve review and grading workbenches ([69d7557](https://github.com/helixnow/deep-student/commit/69d755764ad703f8fe2a1c789329f9c6dcdaa30b))
* **translation,essay-grading:** rework streaming workbenches end to end ([04774b9](https://github.com/helixnow/deep-student/commit/04774b9d7dc13b0b89c2cc90d7c415659584a9ee))
* **ui, learning-hub:** enhance UI responsiveness and silent refresh logic ([55c914b](https://github.com/helixnow/deep-student/commit/55c914b95b426046b6bb6ecbc9e3b4b9e045a68c))
* **ui:** enhance responsiveness and accessibility across components ([edf04d2](https://github.com/helixnow/deep-student/commit/edf04d24e0463cc488f56d269192563754b062a0))
* **ui:** sidebar hover polish, scrolling labels, and accordion motion ([efa8d34](https://github.com/helixnow/deep-student/commit/efa8d34da0d9757dc9761f0476af216e3f4d6227))
* **ui:** update translation, dashboard, and misc feature surfaces ([a524259](https://github.com/helixnow/deep-student/commit/a524259fd616dc0dfc1e27ed52999a9c2c4bd6ea))
* **vfs:** add multimodal retrieval and vector index profiles ([d6623cd](https://github.com/helixnow/deep-student/commit/d6623cdabff3e73e814dba93e05bae1647d9a3c9))
* **workbench,quick-assistant:** add quick assistant window and enhance app icon system ([38e590b](https://github.com/helixnow/deep-student/commit/38e590bc07f8c21893418a4b527d79d93dd67597))
* **workbench,ui:** expand workbench mode switcher and enhance icon system ([fc287b7](https://github.com/helixnow/deep-student/commit/fc287b7d42321a303909a60472fe58ab48b6fc8f))
* **workbench:** add agent collaborator runtime bridge ([88f6e98](https://github.com/helixnow/deep-student/commit/88f6e98b94b7aad680dfe2516f34eef4e2137648))
* **workbench:** add agent manifests with ACR4 tests and dock visuals ([9220f15](https://github.com/helixnow/deep-student/commit/9220f15e3bbb2d5f6f464f322d4e46d85f83edd1))
* **workbench:** add core window platform and lifecycle engine ([906d5e5](https://github.com/helixnow/deep-student/commit/906d5e5fb3e2db15e4a1eea810059ca551ae69e2))
* **workbench:** add desktop shell, dock, and window chrome ([2e8297d](https://github.com/helixnow/deep-student/commit/2e8297d3d7a2c8d2d54ec56769c150d0048f248f))
* **workbench:** add wallpapers, shortcuts, and native materials ([ded47a4](https://github.com/helixnow/deep-student/commit/ded47a4ee6ee7b95dc006a1e007a89d1cf60cfea))
* **workbench:** expand desktop workspace and navigation surfaces ([b6883dc](https://github.com/helixnow/deep-student/commit/b6883dcaf6673b34187f722821fb9d0781c7f298))
* **workbench:** export public API, progress docs, and integration tests ([6cc4b55](https://github.com/helixnow/deep-student/commit/6cc4b55a2c435901938d494092d6e1c7f8e678c0))
* **workbench:** harden window lifecycle and content apps ([36b4bbe](https://github.com/helixnow/deep-student/commit/36b4bbea873d3e1616ab88d08a14aebf5283ed9c))
* **workbench:** implement agent runtime, control center, and app manifests ([203175b](https://github.com/helixnow/deep-student/commit/203175bde79a42f539268d92b24d432dfb122a3e))
* **workbench:** integrate notes workspace, mind-map refinements, and agenda widget ([a713b52](https://github.com/helixnow/deep-student/commit/a713b528a8585d3fe61e8e0ece9ab23edb77742e))
* **workbench:** redesign Agent Control Center UI and fix popover layout issues ([71dfc4c](https://github.com/helixnow/deep-student/commit/71dfc4c62e5ad3da6088a53cb5aacf68a01a5f39))
* **workbench:** refine notes UI, harden sync contracts, and enhance IME handling ([dd8ac47](https://github.com/helixnow/deep-student/commit/dd8ac47c4726891f429a3c6f74d20ed4867df008))
* **workbench:** register workbench app windows ([4e305bd](https://github.com/helixnow/deep-student/commit/4e305bd18fca0752880c09a583b845840ea72482))
* **workbench:** rework notes app surfaces, previews, and perf pause logic ([59331f1](https://github.com/helixnow/deep-student/commit/59331f128c2ffc7ffcc011b74899767060e7f244))


### Bug Fixes

* **android:** declare microphone permissions ([cc452c9](https://github.com/helixnow/deep-student/commit/cc452c982788137e04c069baf35ec8b23e43ffcb))
* **android:** resolve keyboard navigation and dialog compression bugs ([c17efda](https://github.com/helixnow/deep-student/commit/c17efdabd35739da5e398e82936c11e58c00a6b9))
* **automation-ui:** preserve agent prompts and protect heartbeat ([51052fe](https://github.com/helixnow/deep-student/commit/51052fe7ec782d2c20120138cdd2898b02144ddc))
* **automation:** harden scheduler runtime and recovery ([9c24e06](https://github.com/helixnow/deep-student/commit/9c24e0694164b6c084d1274740c7fc92483a914b))
* **chat-markdown:** restore spacing between streamed blocks ([ee2cd28](https://github.com/helixnow/deep-student/commit/ee2cd28b1f4482591588254facd6775ad97831a7))
* **chat:** dedupe overlapping sessions in the sidebar feed ([6c1903c](https://github.com/helixnow/deep-student/commit/6c1903ccc844f849b25c1ca8934e9a752c5c3884))
* **chat:** keep an empty current-session title empty in the shell ([049e7a4](https://github.com/helixnow/deep-student/commit/049e7a4fa9c70f2bf6ab5b3debfb0ecd3caa7d16))
* **chat:** keep translation popover within viewport ([caa756f](https://github.com/helixnow/deep-student/commit/caa756f2dfe225be031a592f289dd653595a847c))
* **ci:** make release workflows parse on GitHub Actions ([9a3572d](https://github.com/helixnow/deep-student/commit/9a3572ddaa75228d0aa70a2146cfb0c356cdfcef))
* **ci:** restore GitHub Actions release workflow parsing ([d5d8647](https://github.com/helixnow/deep-student/commit/d5d8647cd946ec79df44d7005a282e445afd2ac8))
* **data:** recover chat_v2 schema fingerprint drift ([f174231](https://github.com/helixnow/deep-student/commit/f174231a8af2596d5471b2783138db04081ba218))
* **dev:** restore opaque window and IPv4 dev loading ([35c892b](https://github.com/helixnow/deep-student/commit/35c892b519f83948b28012ff5aee167791287442))
* **editor:** stabilize note saves, search, and keyboard flows ([0628707](https://github.com/helixnow/deep-student/commit/062870732be4a26b77d3ceabcc554c024e5c2593))
* make full access execution unsandboxed ([e5d7bf5](https://github.com/helixnow/deep-student/commit/e5d7bf521c169b8e661fbfacf925ca462fe73c9d))
* **mcp:** align stdio framing to JSONL and harden MCP settings ([54e2cde](https://github.com/helixnow/deep-student/commit/54e2cdedeb35e24effc2c3ba572aca09323a3a72))
* **mindmap:** clamp blank action popup to viewport ([5e77480](https://github.com/helixnow/deep-student/commit/5e7748029d22e7a34a5ab68fb42d757405977f4d))
* **mobile:** sync MainActivity in builds, trim stale paddings, cap alive views on touch ([d3df144](https://github.com/helixnow/deep-student/commit/d3df14448cd9f130ac64d809f6d36afe88a9e9f0))
* normalize pasted note image paths ([7691dc8](https://github.com/helixnow/deep-student/commit/7691dc8cd8a6ab391e489537981739e5e0fe2b6a))
* **notes:** measure context menus before clamping ([b618761](https://github.com/helixnow/deep-student/commit/b618761faaa3067be5ccfbef036e8e58b09e6d5a))
* **quick-260713-syv:** enlarge workbench window control targets ([5b7aad4](https://github.com/helixnow/deep-student/commit/5b7aad4c45e0a764dbf80dacacb7f479bb23b291))
* **rust:** resolve executor and helper integration issues ([615419a](https://github.com/helixnow/deep-student/commit/615419aa2d2ba86b0ad66d8f695b9e5b71554bf9))
* satisfy release gates ([cf00832](https://github.com/helixnow/deep-student/commit/cf00832a7c4d4a58cc8f99f2745dceebbf44adc8))
* **search-ui:** normalize fields and quiet focus styling ([bf7b91e](https://github.com/helixnow/deep-student/commit/bf7b91eda9832621e0befefc78cd3c50742d7d89))
* **settings:** layer editor menus above the modal surface and refine latency styling ([ffcc813](https://github.com/helixnow/deep-student/commit/ffcc813b68886b1a9041a9c6a776bffe09ea7791))
* stabilize migration recovery and release gates ([e0cf3b0](https://github.com/helixnow/deep-student/commit/e0cf3b09b0471b6f83b420dba2e52cc1a0366025))
* **ui:** stabilize shared overlay placement ([bf8ad66](https://github.com/helixnow/deep-student/commit/bf8ad66e9830f8887de2b5199f97a1f275864ea9))
* **vfs:** avoid reopening retired vector catalogs ([3ce3169](https://github.com/helixnow/deep-student/commit/3ce31691eb9fb2976a4613d7d9165883ab83c005))
* **windows:** restore stable backend compilation ([6d0d9e0](https://github.com/helixnow/deep-student/commit/6d0d9e038dd97311da4a14a1c4a792a7e28cc91d))
* **workbench:** avoid Windows chrome overlap ([4d03a83](https://github.com/helixnow/deep-student/commit/4d03a835c53abbbcd2f479f69898328843aafe86))
* **workbench:** remove stale flashcard mock state ([0d7209c](https://github.com/helixnow/deep-student/commit/0d7209c80d1cbb9643bd73ad0ea6e6e4cf10e61e))
* **workbench:** restore native window close path ([767f0d5](https://github.com/helixnow/deep-student/commit/767f0d5f9f7d11aba9f180fa56bbabdd0817344f))
* **workbench:** simplify agent control dock indicators ([824f05b](https://github.com/helixnow/deep-student/commit/824f05b0206e55dc99dbdbcc2a4f30031376b308))


### Performance Improvements

* **workbench:** fix style-invalidation hotspots behind window-drag jank ([a064ac6](https://github.com/helixnow/deep-student/commit/a064ac689e2632334407ff9807df2128ddb72824))

## [0.9.42](https://github.com/helixnow/deep-student/compare/v0.9.41...v0.9.42) (2026-06-30)


### Bug Fixes

* stabilize release builds on Windows and Android ([#120](https://github.com/helixnow/deep-student/issues/120)) ([6adff3a](https://github.com/helixnow/deep-student/commit/6adff3adc9329c947cda648d4b468219ea0c8fe9))

## [0.9.41](https://github.com/helixnow/deep-student/compare/v0.9.40...v0.9.41) (2026-06-30)


### Features

* add save botton to siliconflow section ([#87](https://github.com/helixnow/deep-student/issues/87)) ([3bab9cf](https://github.com/helixnow/deep-student/commit/3bab9cf725066a67352902a074503f8a41a9434b))


### Bug Fixes

* add RECORD_AUDIO permission for Android manifest ([#89](https://github.com/helixnow/deep-student/issues/89)) ([d2f4424](https://github.com/helixnow/deep-student/commit/d2f442488d8a292e0b7d80be4ca2c2b91c723f2b))

## [0.9.40](https://github.com/helixnow/deep-student/compare/v0.9.39...v0.9.40) (2026-05-27)


### Features

* sync latest nightly into main for 0.9.40 ([#84](https://github.com/helixnow/deep-student/issues/84)) ([53add86](https://github.com/helixnow/deep-student/commit/53add861020ad6f1c8ae8d6941036fd8f835f0e5))

## [0.9.39](https://github.com/helixnow/deep-student/compare/v0.9.38...v0.9.39) (2026-05-25)


### Bug Fixes

* **ci:** split sync regression targets across jobs ([#80](https://github.com/helixnow/deep-student/issues/80)) ([ed7efb2](https://github.com/helixnow/deep-student/commit/ed7efb25c5cf18728693fd88535ea4d5d23064a2))

## [0.9.38](https://github.com/helixnow/deep-student/compare/v0.9.37...v0.9.38) (2026-05-24)


### Bug Fixes

* add @lobehub/ui and antd dependencies ([c2f43f8](https://github.com/helixnow/deep-student/commit/c2f43f8bfd16624491b2ba4d9bc892ffc9515142))

## [0.9.37](https://github.com/helixnow/deep-student/compare/v0.9.36...v0.9.37) (2026-05-24)


### Bug Fixes

* pin @lobehub/icons to 5.6.0 ([d04fb13](https://github.com/helixnow/deep-student/commit/d04fb132ec29b081b93057cf20d11d750b130ebf))
* **rebuild:** add --legacy-peer-deps to npm ci ([449a0c2](https://github.com/helixnow/deep-student/commit/449a0c2a71cdc0411e18dddaa98c62a757513724))
* **release:** add --legacy-peer-deps to npm ci ([e0bb680](https://github.com/helixnow/deep-student/commit/e0bb680f32b451127962713f83a6641a4bbef371))

## [0.9.36](https://github.com/helixnow/deep-student/compare/v0.9.35...v0.9.36) (2026-05-24)


### Features

* **data_governance:** support virtual URI targets for ZIP exports ([b5bd171](https://github.com/helixnow/deep-student/commit/b5bd171fb5a8c16f71797c5bf191c5e25e31a320))


### Bug Fixes

* 修正在学习资源内题库中答题结束的祝贺弹窗在移动端的错误位置 ([#51](https://github.com/helixnow/deep-student/issues/51)) ([f6690e9](https://github.com/helixnow/deep-student/commit/f6690e960585f0338d96b95146479ec3566c036b))

## [0.9.35](https://github.com/helixnow/deep-student/compare/v0.9.34...v0.9.35) (2026-03-14)


### Features

* **todo:** add database constraints and improve code formatting ([2500b9c](https://github.com/helixnow/deep-student/commit/2500b9ce34550b131eeb3775da7658c74bd211d9))
* **tools:** add arg_utils for JSON parsing and MCP server configuration ([44c70b4](https://github.com/helixnow/deep-student/commit/44c70b4570bffbd087c573ee9be2c37dd1940542))


### Bug Fixes

* **ci:** auto-recover android release builds ([ac74c9b](https://github.com/helixnow/deep-student/commit/ac74c9be414f2a4b61f22224cfccec7b6d2cf829))
* **ci:** avoid android rebuild invalidation and add heartbeat ([4740877](https://github.com/helixnow/deep-student/commit/4740877946eafdabf55c6382c440e4f5be1391e3))
* **ci:** remove android tee wrapper and add timeout ([79df4e0](https://github.com/helixnow/deep-student/commit/79df4e0813b5b3ee405105bda57e45fe96e1b097))
* **ci:** retry transient android dependency failures ([3734c5c](https://github.com/helixnow/deep-student/commit/3734c5ce3c5612d6dc65c2cedee84d72da6a88f0))

## [0.9.34](https://github.com/helixnow/deep-student/compare/v0.9.33...v0.9.34) (2026-03-09)


### Features

* **i18n:** add Todo localization support for en-US and zh-CN ([e61ee8e](https://github.com/helixnow/deep-student/commit/e61ee8e561e99ca44fe7b57bac283ad7eaa35494))
* **pomodoro:** add immersive focus mode with white noise and circular progress ([2ee581c](https://github.com/helixnow/deep-student/commit/2ee581cc41cc55f2053811e414a27310c872d7e0))
* **pomodoro:** add Pomodoro timer support for todo items ([6ad54d9](https://github.com/helixnow/deep-student/commit/6ad54d9765f0e7bd7c903525672cd1ba724c3ae8))
* **todo:** add comprehensive Todo support across DSTU system ([3863cf9](https://github.com/helixnow/deep-student/commit/3863cf9384fc327dc6b27a089e8438ca4f1a61db))
* **todo:** add Todo resource type support across Learning Hub ([b8e418d](https://github.com/helixnow/deep-student/commit/b8e418dd7225cf48c549c0ed419918da065bb21d))
* **vfs:** decouple todo_lists from VFS resources system ([2be0e94](https://github.com/helixnow/deep-student/commit/2be0e943b263a0b544009c26f9b4a0121ff1cb4a))


### Bug Fixes

* **build:** bump Android versionCode to 13516 and add parse_timestamp import ([045703e](https://github.com/helixnow/deep-student/commit/045703ef5c454dcce0da62405fab03bc48b5dce2))
* **ci:** add three-path release detection to handle merge commits burying release commit ([466152c](https://github.com/helixnow/deep-student/commit/466152c651918718833dbf311a4307ed345fe4c6))
* **ci:** harden Android build against runner resource exhaustion ([985bc7b](https://github.com/helixnow/deep-student/commit/985bc7bc9f7ad4ced66d5d97e56fad3248024ec5))
* **settings:** prevent auto-save from overwriting backend config when loadConfig fails ([21fbb00](https://github.com/helixnow/deep-student/commit/21fbb00106e6408e8948f171e78153040fdeab39))


### Performance Improvements

* **bundle:** optimize initial load performance with lazy loading and selective subscriptions ([0da3cba](https://github.com/helixnow/deep-student/commit/0da3cbab0f0d3a1b7ebd8315d3354c1c31f88d83))

## [0.9.33](https://github.com/helixnow/deep-student/compare/v0.9.32...v0.9.33) (2026-03-08)


### Features

* **llm:** add model capability registry with automatic vision/tools/reasoning inference ([837aa6c](https://github.com/helixnow/deep-student/commit/837aa6ce338d2f9bbd20d98555906b93987249c1))
* **memory-system:** hide system-reserved folders/notes with `__*__` pattern across Finder and implement memory folder navigation ([7ddf4c3](https://github.com/helixnow/deep-student/commit/7ddf4c3c743a581f25ef72ba36afd3973e8b98f7))
* **notes,textbooks:** detect and sanitize opaque Android document IDs in filenames across frontend and backend ([d75ac97](https://github.com/helixnow/deep-student/commit/d75ac976eea724243ed1473bb54b3910fd681669))
* **notes,textbooks:** extract H1 heading from markdown when title is generic placeholder and generate friendly names for opaque document IDs ([c62a022](https://github.com/helixnow/deep-student/commit/c62a022aad40ac6da8f2567402038762bcee778a))
* **notes:** add reading mode toggle to prevent keyboard popup on mobile during scrolling ([648d763](https://github.com/helixnow/deep-student/commit/648d7636eea2d9d11d0f22effc8922351f91582e))
* **pdf,polyfills:** add Promise.withResolvers polyfill for older browsers and remove unused active feature chips ([aebf481](https://github.com/helixnow/deep-student/commit/aebf481d35dd6907e0f380df04c04f7ad6fc50ce))
* **question-bank:** add question history view and refactor timer management for advanced practice modes ([36746a8](https://github.com/helixnow/deep-student/commit/36746a8f124c82d93f61ec95c0723df7d27fdd41))
* **skills-executor:** add custom deserializer to handle stringified array parameters from LLMs ([493677f](https://github.com/helixnow/deep-student/commit/493677fe7145a27014ba358ec5ffc3f74969151a))
* **todo:** add user-facing todo system with database schema and system prompt integration ([ba1dfa4](https://github.com/helixnow/deep-student/commit/ba1dfa471a1c6ea49c640047e17a41525768a9e9))


### Bug Fixes

* **ci:** detect merged release commits with PR suffix ([14547bb](https://github.com/helixnow/deep-student/commit/14547bbc726bcabaf4960e2c085582f36b6cb35c))

## [0.9.32](https://github.com/helixnow/deep-student/compare/v0.9.31...v0.9.32) (2026-03-06)


### Features

* **chat_v2,workspace,qbank,sync:** add cross-session permission checks and harden tool whitelist bypass ([04a9b10](https://github.com/helixnow/deep-student/commit/04a9b10ac9b8a446f811dfc06b5915f386a0a956))
* **chat-v2,learning-hub:** enhance resource handling and state management ([168c253](https://github.com/helixnow/deep-student/commit/168c253780c9833c2fd0d6d3e19e63dbe76893f1))
* **chat-v2:** enhance skill state management and event handling ([3c8027a](https://github.com/helixnow/deep-student/commit/3c8027aaada91c74f8a98de4b3e915a504f1ffb2))
* **chat,vfs:** add answer submission idempotency and enhance context ref handling ([580db0f](https://github.com/helixnow/deep-student/commit/580db0f271f6ad3a03cc18b136e592437a3960cf))
* **gemini,chat-v2,notes,providers:** enhance multimodal handling, cache tokens, and batch import cleanup ([b287a23](https://github.com/helixnow/deep-student/commit/b287a237563db711c79e6bda9e7b2933717e6a65))
* **gemini,memory,llm:** add frequency/presence penalties, batch memory write, and provider_scope routing ([958979c](https://github.com/helixnow/deep-student/commit/958979c40c4fee5e82e4c9b5cf5161fbb4df8ba0))


### Bug Fixes

* **ci:** avoid duplicate release creation blocking release-please ([21998cc](https://github.com/helixnow/deep-student/commit/21998cc530f566e3d10f40f9e4097578d0c97194))

## [0.9.31](https://github.com/helixnow/deep-student/compare/v0.9.30...v0.9.31) (2026-03-05)


### Features

* **workflows:** add hotfix workflow for Linux release assets and improve sync reliability ([4b7a71f](https://github.com/helixnow/deep-student/commit/4b7a71fbdc42fec4adc872c86b874713161e6739))


### Bug Fixes

* **chat:** change SessionCard height from fixed to min-height ([cbb156d](https://github.com/helixnow/deep-student/commit/cbb156d89011d51c550762aac35bf142aff725ae))

## [0.9.30](https://github.com/helixnow/deep-student/compare/v0.9.29...v0.9.30) (2026-03-03)


### Features

* add build support for linux ([#41](https://github.com/helixnow/deep-student/issues/41)) ([1d253f2](https://github.com/helixnow/deep-student/commit/1d253f25e78aaf7f3c906943bd30e332059ab4a1))
* **memory:** implement write idempotency and enhance data integrity ([bb18278](https://github.com/helixnow/deep-student/commit/bb1827852b4018fd51de1c3bd78f6368447413d0))
* **vfs:** mark resource as pending after successful unit sync ([77c24f1](https://github.com/helixnow/deep-student/commit/77c24f1218f402e0290b3de5bc8f199d0ebb3454))


### Bug Fixes

* add execute right for build_linux_all.sh ([1d253f2](https://github.com/helixnow/deep-student/commit/1d253f25e78aaf7f3c906943bd30e332059ab4a1))

## [0.9.29](https://github.com/helixnow/deep-student/compare/v0.9.28...v0.9.29) (2026-03-02)


### Features

* **session-management:** introduce session management tools and enhance request handling ([8d26ddb](https://github.com/helixnow/deep-student/commit/8d26ddb4eea67203a6fe18d595bc12b8d6014215))


### Bug Fixes

* **chat-v2:** enforce explicit model resolution for multimodal injection ([be308bf](https://github.com/helixnow/deep-student/commit/be308bf67f0eeb7a3bc14cbf4ef23e7874428434))

## [0.9.28](https://github.com/helixnow/deep-student/compare/v0.9.27...v0.9.28) (2026-03-02)


### Features

* add development scripts for Android environment setup ([ab2953f](https://github.com/helixnow/deep-student/commit/ab2953f4bd35ea1ba657154063ff72bf5dcd4d27))
* **ankiCards:** enhance event handling and error reporting ([6f2642c](https://github.com/helixnow/deep-student/commit/6f2642c428e1dd2512559f1bb14b6faa20a097ba))
* **debug:** implement debug log persistence and filtering options ([fa8f4c9](https://github.com/helixnow/deep-student/commit/fa8f4c9fc99f98ff082890a37beb51ffecbcea5f))
* **exam:** enhance exam XML generation and qbank tools ([fc80777](https://github.com/helixnow/deep-student/commit/fc8077744d99fe66d420552401a69753d6d1b4c6))


### Bug Fixes

* **android-files:** support virtual URI import export flows ([58c4234](https://github.com/helixnow/deep-student/commit/58c4234762a9fa1eec6c7b3f0672069384c1c646))

## [0.9.27](https://github.com/helixnow/deep-student/compare/v0.9.26...v0.9.27) (2026-03-01)


### Features

* enhance Anki card handling with action locks, pagination, and improved error handling ([bf5f2bd](https://github.com/helixnow/deep-student/commit/bf5f2bd189750f8bd971486fce6ea5673323ec21))
* enhance file name handling and import error reporting ([c167b25](https://github.com/helixnow/deep-student/commit/c167b253ee06637c9752ab8437bc30b6d6f9a801))
* implement resource export system with format-specific adapters ([ed6f8f8](https://github.com/helixnow/deep-student/commit/ed6f8f834025b6e5356708948c05556c43c60f1e))
* standardize Tauri v2 parameter naming to camelCase for automatic snake_case mapping ([64f541c](https://github.com/helixnow/deep-student/commit/64f541cbd6d81ce4e03134727678cdcb4362380f))

## [0.9.26](https://github.com/helixnow/deep-student/compare/v0.9.25...v0.9.26) (2026-03-01)


### Features

* enhance bidirectional sync with download-first strategy and improved conflict handling ([4fb78e3](https://github.com/helixnow/deep-student/commit/4fb78e30737575bdbfafab6c24d432b6939754e0))
* enhance file handling with new extraction utilities ([be86d16](https://github.com/helixnow/deep-student/commit/be86d166798455d99cd142808f1c676c4f9cd1a5))
* fix tool call handling and user message deduplication in chat history ([6b38748](https://github.com/helixnow/deep-student/commit/6b3874895b00d1a15dc3d7d87fd0d3fc9f5fe2ff))


### Bug Fixes

* use adapter-transformed request body for LLM request logging ([a93ed02](https://github.com/helixnow/deep-student/commit/a93ed02f9e45c52352035628273196623894cac9))

## [0.9.25](https://github.com/helixnow/deep-student/compare/v0.9.24...v0.9.25) (2026-03-01)


### Features

* add GitHub Actions workflow for rebuilding Android APK ([1285e99](https://github.com/helixnow/deep-student/commit/1285e99643d8f26d61ef2e91d91e11a502e8bd75))
* add image payload parsing and handling utilities ([a16033e](https://github.com/helixnow/deep-student/commit/a16033ef6a27041d11de2a743a5c74f91a013079))
* enhance memory management with new relation and tagging features ([d7dc855](https://github.com/helixnow/deep-student/commit/d7dc8559ee47cdc253a9f71dbe2998808cf774ad))
* enhance model capability registry and update related scripts ([9caea57](https://github.com/helixnow/deep-student/commit/9caea57694f947c92abca1d5bd02cd4eb24c1697))
* enhance sync functionality with merge strategy and timestamp parsing ([274a81e](https://github.com/helixnow/deep-student/commit/274a81ec49a88803d22fd6be6be40d184f813d76))
* implement content search and session tagging system ([cb846b5](https://github.com/helixnow/deep-student/commit/cb846b51741e4fad7ce31d4dfcc0224eba94ff50))
* implement CORS-compliant fetch function for mobile platforms in useAppUpdater ([8206224](https://github.com/helixnow/deep-student/commit/8206224ebae1a6efc9afa0689d7559be7c2cb46a))


### Bug Fixes

* update model capabilities and context token limits ([545d645](https://github.com/helixnow/deep-student/commit/545d64551045f305139be231fa6621cbc4897a5e))

## [0.9.24](https://github.com/helixnow/deep-student/compare/v0.9.23...v0.9.24) (2026-02-27)


### Features

* add ChatAnki integration test plugin for automated testing ([fc20b15](https://github.com/helixnow/deep-student/commit/fc20b15f47590cfe3a21dc813821f16125596b0d))
* add memory audit log functionality and enhance memory management ([24cb17b](https://github.com/helixnow/deep-student/commit/24cb17ba77e7f37b30506cd6bae10457a27e7f16))
* enhance image preview handling and improve NoteContentView layout ([ffe392b](https://github.com/helixnow/deep-student/commit/ffe392bd44da32a28dd9f5725b335dc3bad6492c))
* implement auto-extract frequency settings for memory management ([69a5990](https://github.com/helixnow/deep-student/commit/69a59905f934cad14416c86571ab4fb20f49193f))
* implement automatic migration for GLM-4.1V to GLM-4.6V model ([2d194d9](https://github.com/helixnow/deep-student/commit/2d194d9b35598a1146f418901d02594aa4ff5123))
* introduce release channel management and update README ([4c47987](https://github.com/helixnow/deep-student/commit/4c4798752fa69436f9e16939d015ea2495cc4045))
* update OCR model configurations and enhance engine selection logic ([30097ec](https://github.com/helixnow/deep-student/commit/30097ecdb58b9cb24cb3bc03bf32c6b9f55dea7d))

## [0.9.23](https://github.com/helixnow/deep-student/compare/v0.9.22...v0.9.23) (2026-02-27)


### Bug Fixes

* handle release-please comment failure on locked PRs ([6df5ff8](https://github.com/helixnow/deep-student/commit/6df5ff895eb80e93157e58f82355821ebf29c494))
* resolve TypeScript errors in i18n fallbackLng and IndexStatusView ([00a438a](https://github.com/helixnow/deep-student/commit/00a438a597816de462e51c6e1ab8e58a65e91951))

## [0.9.22](https://github.com/helixnow/deep-student/compare/v0.9.21...v0.9.22) (2026-02-27)


### Features

* add rebuild-release workflow for manual tag rebuilding ([3d28fec](https://github.com/helixnow/deep-student/commit/3d28fec4f6c5fefb794fef3ed2bf2e016a436fb4))

## [0.9.21](https://github.com/helixnow/deep-student/compare/v0.9.20...v0.9.21) (2026-02-26)


### Features

* enhance memory management with auto extraction and category management ([0b5d8fb](https://github.com/helixnow/deep-student/commit/0b5d8fb83158b2811d696852cb6fc7bd07446ace))
* enhance memory management with new settings and export functionality ([2b48b71](https://github.com/helixnow/deep-student/commit/2b48b71e3c33e14ec85fb6f8396d4bdca04dbf18))
* enhance MemoryView with batch selection and editing capabilities ([788147e](https://github.com/helixnow/deep-student/commit/788147e992bdd368b465253308920c7e78eb1402))
* enhance Smart Memory with self-evolving profile and auto-extraction features ([c29005a](https://github.com/helixnow/deep-student/commit/c29005af5e17da3c985bc99e9e510acdddb9d8c5))
* enhance web search tool with dynamic engine injection ([66b5902](https://github.com/helixnow/deep-student/commit/66b590205b828a47f0b449f3b2bd0a608bd6e960))


### Bug Fixes

* correct SQL LIKE pattern escape syntax in note query ([8d96e08](https://github.com/helixnow/deep-student/commit/8d96e08bc5bc5cca947e58f7446db68049a7dc2d))
* increase MCP cache max size for improved performance ([7896e76](https://github.com/helixnow/deep-student/commit/7896e76b09d87ed534041e48d43bd31b08be1cd9))
* prevent action buttons from overlapping session title during edit ([5278d4b](https://github.com/helixnow/deep-student/commit/5278d4beacef6dfa1e63aa85619a490132bf804f))

## [0.9.20](https://github.com/helixnow/deep-student/compare/v0.9.19...v0.9.20) (2026-02-25)


### Features

* add DOCX VLM direct extraction path with streaming and checkpoint recovery ([2ee580f](https://github.com/helixnow/deep-student/commit/2ee580fd8f8465e9a6b867bc505a3e71f38f1fd4))
* add native DOCX import with embedded image support ([304d940](https://github.com/helixnow/deep-student/commit/304d940663577171f8542db8b86e869f2f1274c4))


### Bug Fixes

* improve question import quality and blob path resolution ([aeb5608](https://github.com/helixnow/deep-student/commit/aeb5608115795efbbc99539878d2109ba2f29348))
* update links in README_EN.md for Quick Start and User Guide ([f4611a5](https://github.com/helixnow/deep-student/commit/f4611a5e61463fc88642d30763774b4213e16659))

## [0.9.19](https://github.com/helixnow/deep-student/compare/v0.9.18...v0.9.19) (2026-02-25)


### Bug Fixes

* add fallback logic for empty Anki back field and replace custom scrollbars with CustomScrollArea ([341c9dc](https://github.com/helixnow/deep-student/commit/341c9dc6be4553dff604b9192f8a5bbf92714961))
* prevent duplicate user messages in history and improve IME handling across platforms ([f903bd1](https://github.com/helixnow/deep-student/commit/f903bd18794722fbab566ae932e146cf54428143))
* standardize snippet container heights using Tailwind spacing units ([5fe902d](https://github.com/helixnow/deep-student/commit/5fe902d0e60991ebe4aa1a80b597963220995833))
* update SiliconFlow website URLs in ApisTab and builtin_vendors ([aa2ad0d](https://github.com/helixnow/deep-student/commit/aa2ad0dcb6325b647d0ffbecd08b2047d5ec41c7))

## [0.9.18](https://github.com/helixnow/deep-student/compare/v0.9.17...v0.9.18) (2026-02-25)


### Features

* add data visualization APIs for OCR and text chunk management ([d1b7ae4](https://github.com/helixnow/deep-student/commit/d1b7ae4b74f5deb9d5cf564e88c72197e1164083))
* enhance backup functionality with ImportProgress struct and refactor auto backup logic ([a33f2d9](https://github.com/helixnow/deep-student/commit/a33f2d9a5db03e2a467a834cf064d17f0efe890c))
* implement block and message actions for enhanced chat functionality ([e68df84](https://github.com/helixnow/deep-student/commit/e68df84be6dfc0bf9fface0ebfda9929fff25d0e))


### Bug Fixes

* correct field references and add missing impl block in debug logger ([13bb819](https://github.com/helixnow/deep-student/commit/13bb8194c7d12c9f7a4083c4dacb352a83a54c81))
* prevent duplicate text input during IME composition and sync skill whitelist after load_skills ([05be6b5](https://github.com/helixnow/deep-student/commit/05be6b53a1e392174058a3f9afc6e51256bbe942))


### Performance Improvements

* optimize view switching with memoization and ref-based state tracking ([2dc59c2](https://github.com/helixnow/deep-student/commit/2dc59c2b6a0cb15d2a274579ac91d3108fb787f6))

## [0.9.17](https://github.com/helixnow/deep-student/compare/v0.9.16...v0.9.17) (2026-02-23)


### Features

* enhance SiliconFlowSection with new OCR model and improve backup functionality ([f94fef3](https://github.com/helixnow/deep-student/commit/f94fef323f4fdf536bdc4bc02a7628b839a7d97b))


### Bug Fixes

* enhance error handling and performance optimizations in Chat V2 ([bbaf9ec](https://github.com/helixnow/deep-student/commit/bbaf9ec19b92ef8ce5bc9ee240b6d39b9fd26392))
* gate desktop_dir/picture_dir with #[cfg(desktop)] for Android build ([512768f](https://github.com/helixnow/deep-student/commit/512768f1e1fd7b3d0e9bbf866a471f71ad438b50))
* **gemini:** add thought_signature support for Gemini 3 tool calling and enforce role alternation ([aa82ff0](https://github.com/helixnow/deep-student/commit/aa82ff0d7fdefa14d54f12b7565db3b0d7069a10))
* **gemini:** force v1beta for Gemini 3 models and convert unprotected functionCalls to text ([cd35419](https://github.com/helixnow/deep-student/commit/cd35419616fb2b92996438ae08e302f0ef78ece1))
* **memory:** enforce atomic fact storage and prevent knowledge/content leakage ([dab0c78](https://github.com/helixnow/deep-student/commit/dab0c78383d79b1f4fe3951b6b4b63e54423c48d))

## [0.9.16](https://github.com/helixnow/deep-student/compare/v0.9.15...v0.9.16) (2026-02-22)


### Features

* **chat-v2:** add disable_tool_whitelist option to bypass skill whitelist restrictions ([830d1eb](https://github.com/helixnow/deep-student/commit/830d1eb815a8e8bd1386064d06aa97a3e6c04d04))
* 题目集导入断点续导（checkpoint resume） ([6ef1333](https://github.com/helixnow/deep-student/commit/6ef1333e92f6977c6f072223e66ae0a7227a4045))


### Bug Fixes

* address verified P0/P1 issues from code audit ([0dca38e](https://github.com/helixnow/deep-student/commit/0dca38e5761c670a4f5d6681f0a50dadb283239a))
* **chat-v2:** ensure active skills content is always passed to backend for synthetic load_skills injection ([0f791c0](https://github.com/helixnow/deep-student/commit/0f791c074fb7fdaf87c7e39a50747df2531beafc))
* **mcp:** audit compliance fixes - timeout alignment, connection state tracking, and DRY refactor ([4fbb093](https://github.com/helixnow/deep-student/commit/4fbb093ef85ea0fdd0e19e43bc44d9316dac0147))
* **mcp:** sanitize tool names for OpenAI API compatibility and improve memory retrieval ranking ([2bf3d9f](https://github.com/helixnow/deep-student/commit/2bf3d9fd34fed8d569dc0b666e7244c5c1e186cb))
* **web-search:** remove engine/force_engine from schema and add silent fallback for unconfigured engines ([e136ef8](https://github.com/helixnow/deep-student/commit/e136ef8206c9bcc3c933cd0a8c635d70f2cfc407))

## [0.9.15](https://github.com/helixnow/deep-student/compare/v0.9.14...v0.9.15) (2026-02-21)


### Features

* **mindmap:** add rich text formatting toolbar and emoji picker, improve node styling and export ([36981fb](https://github.com/helixnow/deep-student/commit/36981fbe1ee5578355128f7d26c69ae106c5cfbf))


### Bug Fixes

* **essay-grading:** replace description Input with textarea for multi-line mode descriptions ([881bd5e](https://github.com/helixnow/deep-student/commit/881bd5e97c72c4cc82b85e1e2ea302d4b70b00fe))

## [0.9.14](https://github.com/helixnow/deep-student/compare/v0.9.13...v0.9.14) (2026-02-20)


### Features

* **chat-v2:** add session branching and group pinned resources support ([82f359c](https://github.com/helixnow/deep-student/commit/82f359cb9ad3ca77cca01a2082f37b5c4ff747ce))
* **chat-v2:** use dedicated chat_title_model for summary generation with fallback chain ([eb5e14d](https://github.com/helixnow/deep-student/commit/eb5e14d425a49606373de786e8dc6c27fded302b))
* **cloud-sync:** add real-time upload/download progress events and workspace database backup support ([8a2b496](https://github.com/helixnow/deep-student/commit/8a2b496ab3b6c84a59327fce896c721d9545c8c4))
* **essay-grading:** refine grading mode rubrics and implement progressive hedging for OCR fallback ([40f2664](https://github.com/helixnow/deep-student/commit/40f2664c44f3be55fab52c54f6ca69737c8c13fb))
* **ocr:** add FreeOCR fallback chain with circuit breaker and streamline grading mode prompts ([6777d50](https://github.com/helixnow/deep-student/commit/6777d501aa9820d599701faea26114e70608209f))
* **settings:** add vendor model batch import and refactor essay grading settings panel ([b282fdb](https://github.com/helixnow/deep-student/commit/b282fdb451db75717f83e6f4614aa20ab8df310c))
* **sync:** add workspace database and VFS blob file-level cloud sync support ([bccce85](https://github.com/helixnow/deep-student/commit/bccce85b2cee4c4a8147364874ee549c05e4ec94))
* **vfs:** filter deleted/inactive resources in index status queries and add question filtering in exam uploader ([1665d05](https://github.com/helixnow/deep-student/commit/1665d0512a5d2fa0bc93c0fb71142cae3adbac08))


### Bug Fixes

* **android:** replace navigator.clipboard with tauri-plugin-clipboard-manager ([d410dc2](https://github.com/helixnow/deep-student/commit/d410dc2eb08b5f3b1cfff06cdec329f3688ade5d))
* **chat-v2:** fix continue message error handling and builtin model badge display logic ([2b20f3a](https://github.com/helixnow/deep-student/commit/2b20f3a705e014a7ba9422b7ea1c1ec4b1827225))
* **chat-v2:** reorder session branching DB writes to satisfy FK constraints and refactor resource picker UI ([185137c](https://github.com/helixnow/deep-student/commit/185137c1bf9177e44bc3fb88acc588c00705a4ed))
* merge duplicate clipboardUtils import in useMindMapClipboard ([fd71294](https://github.com/helixnow/deep-student/commit/fd712942470c2ece3ab6a877d0e8f0ea68df4764))

## [0.9.13](https://github.com/helixnow/deep-student/compare/v0.9.12...v0.9.13) (2026-02-18)


### Features

* add multi-tab support with LRU eviction, fix cross-tab event pollution, and enhance LaTeX rendering ([8af002c](https://github.com/helixnow/deep-student/commit/8af002cc7d29e53092f70d1441be006597cea394))
* enhance tool handling, sleep wake logic, and crypto key backup/restore ([a477bca](https://github.com/helixnow/deep-student/commit/a477bca302fb8d487a5e43a64b56aaad9450651f))
* **indexing:** 一键索引自动对预处理未完成的教材/PDF文件执行OCR ([83560f7](https://github.com/helixnow/deep-student/commit/83560f7968b7957fe70be62e955a48f4565cfdcc))


### Performance Improvements

* **vfs:** optimize index status query with CTE aggregation and add performance indexes ([07c6e5e](https://github.com/helixnow/deep-student/commit/07c6e5ea479bf9b0f888642572693755d4e17530))

## [0.9.12](https://github.com/helixnow/deep-student/compare/v0.9.11...v0.9.12) (2026-02-18)


### Features

* add backup cancellation support and fix attachment base64 detection ([18bbc22](https://github.com/helixnow/deep-student/commit/18bbc223f3f06e6c447f6b6cd2e5de7a00e8932d))

## [0.9.11](https://github.com/helixnow/deep-student/compare/v0.9.10...v0.9.11) (2026-02-17)


### Features

* enhance progress tracking for backup/restore/import operations with detailed error reporting ([9fb24a4](https://github.com/helixnow/deep-student/commit/9fb24a41147ebdb2ee38819f0821ac8e76894bd6))

## [0.9.10](https://github.com/helixnow/deep-student/compare/v0.9.9...v0.9.10) (2026-02-17)


### Features

* mobile dual download links (R2 mirror + GitHub) ([c9c8f6d](https://github.com/helixnow/deep-student/commit/c9c8f6dc583cf01b652a6b0c5378dcbdc0e41125))
* prioritize R2 mirror for auto-update source ([7e479c8](https://github.com/helixnow/deep-student/commit/7e479c8955bbc820afbfa424472a81cd48138185))
* source image crop, search snippets, remove question_parsing_model ([d41f6c0](https://github.com/helixnow/deep-student/commit/d41f6c09ff6c503194264f6da3048397a4e9877f))


### Bug Fixes

* add --remote flag to wrangler r2 commands ([f7068ef](https://github.com/helixnow/deep-student/commit/f7068ef2911443a4325d98a1c7798cdbfd7b8cc2))
* **backup:** configure git user for annotated snapshot tags in bare repo ([6bc2fb4](https://github.com/helixnow/deep-student/commit/6bc2fb4c6d7735623a2e0deaaf7c023b19b7c09d))
* **ci:** prevent dependabot major bumps + precise semver extraction ([b6396bc](https://github.com/helixnow/deep-student/commit/b6396bc73d2a9c7a9d5d61d785d7934e34565bb4))
* critical review fixes for R2 upload in release workflow ([5f616dc](https://github.com/helixnow/deep-student/commit/5f616dc69929005ca8d4a856f64347826501ac1d))
* **release:** disable component-prefixed tags + robust version extraction ([f4bafa4](https://github.com/helixnow/deep-student/commit/f4bafa4822e19881f6c12167d7aa5df60b2cb0d6))
* switch to rclone for R2 upload (native Cloudflare provider) ([d3aebda](https://github.com/helixnow/deep-student/commit/d3aebdab15fc33108c54e1d0ec46e50fdcfb59b6))
* switch to wrangler CLI for R2 upload (bypass S3 TLS issue) ([0272c39](https://github.com/helixnow/deep-student/commit/0272c3963b7d012b3e8500b88f2b8271c8cb3961))
* **updater:** robust version extraction from tag_name for Android ([4be6c1f](https://github.com/helixnow/deep-student/commit/4be6c1fde614fb44b0d9e3a2bad332e86dfacd80))
* use GitHub API for R2 version cleanup (wrangler has no list command) ([41cedb4](https://github.com/helixnow/deep-student/commit/41cedb4c0d68d82e8dd425308194d6c78c8703f1))
* use path-style addressing for R2 S3 compatibility ([c26433d](https://github.com/helixnow/deep-student/commit/c26433db37c04ae5ac7f1e13c542a9c3d5d7dfe1))


### Performance Improvements

* add cache-control headers and proper content-types for R2 uploads ([333d96d](https://github.com/helixnow/deep-student/commit/333d96dd73b903ead76a07182a43c94bda277617))

## [0.9.9](https://github.com/helixnow/deep-student/compare/deep-student-v0.9.8...deep-student-v0.9.9) (2026-02-17)


### Bug Fixes

* **android:** disable ppt-rs default features to avoid openssl-sys ([6a3acc7](https://github.com/helixnow/deep-student/commit/6a3acc7c278c3a839849e6d4b46a24895067c1ca))

## [0.9.8](https://github.com/helixnow/deep-student/compare/deep-student-v0.9.7...deep-student-v0.9.8) (2026-02-17)


### Features

* add academic search tool with arXiv + OpenAlex integration ([1ae5c24](https://github.com/helixnow/deep-student/commit/1ae5c24534afe33addc0980801bde18869b79e4a))
* add Android build to release workflow + bump VERSION_CODE_BASE to 13000 ([54c0d22](https://github.com/helixnow/deep-student/commit/54c0d22407b305c32df90a9848225637f4c9fe4f))
* add attachment pipeline automated test plugin ([371e5c5](https://github.com/helixnow/deep-student/commit/371e5c5a6f830475cffb70f65480c2c17153495b))
* add database maintenance mode + fix Windows file lock (OS error 32) during restore ([7023510](https://github.com/helixnow/deep-student/commit/7023510b76afcb23149ba0271e9c020c102c9608))
* add orphan OCR engine cleanup + improve file save UX + fix test engine selection ([b080582](https://github.com/helixnow/deep-student/commit/b08058212f4cb360ba87bf96dd41721eb772fc37))
* add paper save + citation formatting tools with VFS integration ([176aae2](https://github.com/helixnow/deep-student/commit/176aae2b49fd03b3d6ed0a4c636fa08e644e5aaf))
* cross-platform pdfium fixes + system OCR adapters + platform-specific resource bundling ([ea87e01](https://github.com/helixnow/deep-student/commit/ea87e015a84e1da8c5ed32b9679de0d7298f9db1))
* improve mobile UI layout + migrate template buttons to DsButton ([afd62b4](https://github.com/helixnow/deep-student/commit/afd62b4bb278f8790ff9918e0080e6d8cc36939f))
* integrate release-please for automated release management ([69db429](https://github.com/helixnow/deep-student/commit/69db42973bf69849e730f25a61d80129a3b767ce))
* **tools:** add DOCX document read/write tool executor + Excel/PowerPoint dependencies ([2a7546a](https://github.com/helixnow/deep-student/commit/2a7546a942b55d8bbf163f6e22ea9239d1baf988))
* **tools:** add PPTX/XLSX tool executors with full read/write capabilities ([d3f6bc5](https://github.com/helixnow/deep-student/commit/d3f6bc52d5899a7def675f16adb815bd08536421))


### Bug Fixes

* add empty string clearing for group fields + validate group existence + cleanup vector indices on delete/purge ([754da80](https://github.com/helixnow/deep-student/commit/754da807a666d8cf4fe80a901638aa2f3c66999d))
* add generate-version.mjs to all platform builds + update committed version ([2f0cfec](https://github.com/helixnow/deep-student/commit/2f0cfec870d15e29f1ef2ec4082b13ba2109ddc1))
* add process:default capability + harden semver comparison ([78bff18](https://github.com/helixnow/deep-student/commit/78bff1854e0a2c4b1fb8d3373b986013e2885b09))
* add protoc install for macOS (brew) and Windows (choco) in release builds ([69e67f0](https://github.com/helixnow/deep-student/commit/69e67f0113f99ba9410de90d1ef32966d128b085))
* bump VERSION_CODE_BASE to 10000 + Node 22 + memory fix for release builds ([8143f02](https://github.com/helixnow/deep-student/commit/8143f02c424ddf2c59973fea27c97e15f8837662))
* copy custom Android icons after tauri android init in CI ([f69ab56](https://github.com/helixnow/deep-student/commit/f69ab56cb6a45d9d15247c23ea7a13c4725a52a2))
* **deps:** migrate json_validator to jsonschema 0.42 API ([a044d95](https://github.com/helixnow/deep-student/commit/a044d95869a2b3f714693a67b18792139101aed4))
* downgrade pdfium to 7350 + add diagnostic command + repair stale PDF cache + harden ready_modes validation ([92a317c](https://github.com/helixnow/deep-student/commit/92a317c8d6c6c82019d596a38ee3d6df0fa974c2))
* enable createUpdaterArtifacts for Tauri v2 updater ([6ca2e5c](https://github.com/helixnow/deep-student/commit/6ca2e5c0410fddc07f91e09d7c581113b845cd52))
* harden migration backup validation + auto-backfill PDF processing status + improve test plugin model handling ([1e23842](https://github.com/helixnow/deep-student/commit/1e238422f6def557b8b1b498a156eed8b51a3ed4))
* improve tool call argument parsing + add paper save fallback handling + add purge safety checks ([bf94e37](https://github.com/helixnow/deep-student/commit/bf94e3753fbed6c48450424e286d3da629fde6d2))
* improve tool schema parameter formats to reduce LLM confusion ([2b24b1e](https://github.com/helixnow/deep-student/commit/2b24b1ea7248ac25849f3b3db233b0475059957d))
* mobile updater uses semver comparison instead of string inequality ([612c250](https://github.com/helixnow/deep-student/commit/612c25033d623d1eb4a8aef83fe306ee061491d5))
* platform-aware auto-updater for all platforms ([29651ad](https://github.com/helixnow/deep-student/commit/29651ad3c1d58232d50b452fbb6d0e4740e04d7c))
* release workflow critical fixes ([0c3b404](https://github.com/helixnow/deep-student/commit/0c3b404b599af69b5b4cee7ed7a1b1e4c22ae650))
* remove custom OCR prompts + harden attachment test plugin ([7c3e43d](https://github.com/helixnow/deep-student/commit/7c3e43de723620d35675e75b39ab10d03b709727))
* remove default Tauri drawables + restrict mobile.json to mobile platforms ([ca43bb3](https://github.com/helixnow/deep-student/commit/ca43bb3aa1560e1fc95424cd2d06c93a0ff12993))
* remove Gemini OpenAI compat mode special handling + add OCR diagnostic logging ([5063706](https://github.com/helixnow/deep-student/commit/50637067311e65a5ea173a4e57ddae0db2e3ca0b))
* rename macOS .app.tar.gz with arch suffix to prevent overwrite ([a7936cb](https://github.com/helixnow/deep-student/commit/a7936cb77bb6807481371f20be0f7d05a238ac04))
* resolve TypeScript type errors in attachment audit logging ([499a41b](https://github.com/helixnow/deep-student/commit/499a41b5af3d8a34769a6b77cd9db37c5f22b1db))
* **restore:** 恢复备份写入非活跃插槽，避免 Windows OS error 32 ([af6c11f](https://github.com/helixnow/deep-student/commit/af6c11f89a51f47d88035172f83bf0a9f63f44e5))
* restrict desktop capabilities to desktop platforms + misc improvements ([6772c17](https://github.com/helixnow/deep-student/commit/6772c17932d553c8908acc562a8d2e81eaeac817))
* show 'already up to date' feedback after manual update check ([e7b27fe](https://github.com/helixnow/deep-student/commit/e7b27fe2ccb6c44a3f3f6796f761895ec45e9e98))
* use arduino/setup-protoc, fail-fast false, remove redundant frontend build ([1ddf626](https://github.com/helixnow/deep-student/commit/1ddf6268e583e8a9bbda4afd26458ed28d335f34))

## [Unreleased] | 未发布

---

## [0.9.7] - 2026-02-16

### Fixed | 修复
- 修复 v0.9.6 发布构建产物版本号错误的问题（版本文件未正确 bump）

### Changed | 变更
- 规范 release 流程：版本 bump 必须通过 release-please PR 合并，禁止手动 tag

---

## [0.9.6] - 2026-02-15

### Added | 新增
- 数据库维护模式，支持备份恢复期间自动切换
- 英文 README 及双语导航链接
- 翻译工作台功能及截图文档
- Anki 模板截图文档更新 + 最新 LLM 模型（GLM-5, Seed 2.0, M2.5, GPT-5.2 Pro）

### Fixed | 修复
- 修复恢复备份写入非活跃插槽，避免 Windows OS error 32 文件锁问题

### Changed | 变更
- CI 移除 cargo fmt 检查 + 按钮迁移到 DsButton 组件

---

## [0.9.5] - 2026-02-13

### Added | 新增
- 安全政策文档 (`SECURITY.md`)
- 环境变量示例 (`.env.example`)
- Playwright E2E 测试配置
- CI/CD 流水线配置 (`.github/workflows/ci.yml`)
- 第三方许可证清单 (`THIRD_PARTY_LICENSES.md`)

### Changed | 变更
- 移除贡献者许可协议文档（待议）

### Fixed | 修复
- 修复 `test:e2e` 脚本缺失问题

---

## [0.9.1] - 2026-02-12

### Added | 新增
- ChatAnki 端到端制卡闭环（替代原 CardForge 独立制卡流程）
- Skills 渐进披露架构：工具按需注入，显著减少上下文占用
- 内置技能：`tutor-mode`、`chatanki`、`literature-review`、`research-mode`
- 内置工具组：`knowledge-retrieval`、`canvas-note`、`vfs-memory`、`todo-tools` 等 11 个
- 数据治理面板：集中化备份、同步、审计、迁移管理
- 云同步功能：WebDAV 和 S3 兼容存储支持
- 双槽位数据空间 A/B 切换机制
- 外部搜索引擎：新增智谱 AI 搜索、博查 AI 搜索
- MCP 预置服务器：Context7 文档检索
- 命令面板：支持收藏、自定义快捷键、拼音搜索
- 3D 卡片预览与多风格内置模板（11 种设计风格）
- 多模态精排模型支持
- 子代理工作器（subagent-worker）技能

### Changed | 变更
- 模型分配简化：移除第一模型、深度研究模型、总结生成模型，统一使用对话模型
- 备份设置迁移到数据治理面板
- 底部导航栏改为 5 个直接 Tab（移除"更多"折叠菜单）
- MCP 预置服务器精简为仅 Context7

### Fixed | 修复
- 修复移动端底部导航栏布局
- 修复多个命令面板快捷键冲突

---

## [0.9.0] - 2026-01-31

### Added | 新增
- Chat V2 架构：支持多轮对话、消息编辑、流式响应
- MCP (Model Context Protocol) 工具生态集成
- VFS 统一资源存储系统
- 双槽位数据空间与迁移机制
- AES-256-GCM 安全存储
- 国际化支持 (i18n)
- 深色/浅色主题切换
- PDF/Word/PPT 文档预览
- 知识图谱可视化
- 错题本与 Anki 导出

### Changed | 变更
- 升级 Tauri 至 v2.x
- 重构前端状态管理（Zustand）
- 优化移动端 UI 适配

### Fixed | 修复
- 修复 Android WebView 兼容性问题
- 修复大文件上传内存溢出
- 修复会话切换时的状态泄漏

---

## [0.8.9] - 2024-11-30

### Added | 新增
- 初始公开版本
- 基础聊天功能
- 多模型供应商支持
- 本地优先数据存储

---

[Unreleased]: https://github.com/helixnow/deep-student/compare/v0.9.17...HEAD
[0.9.7]: https://github.com/helixnow/deep-student/compare/v0.9.6...v0.9.7
[0.9.6]: https://github.com/helixnow/deep-student/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/helixnow/deep-student/compare/v0.9.1...v0.9.5
[0.9.1]: https://github.com/helixnow/deep-student/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/helixnow/deep-student/compare/v0.8.9...v0.9.0
[0.8.9]: https://github.com/helixnow/deep-student/releases/tag/v0.8.9

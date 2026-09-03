# Changelog | 更新日志

All notable changes to this project will be documented in this file.

本项目的所有重要变更都将记录在此文件中。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

# 0824 Wave2-C R1 · 扫描员台账 03 — PDF / EPUB 移动 chrome(P7)

- 角色:扫描员-PDF/EPUB移动(第 1 轮,只静态审阅,未运行任何构建/测试)
- 规范依据:`docs/dev/mobile-uiux-unify/README.md` 五条(全局顶栏唯一 / 左键语义 / 右侧≤2 / 禁桌面组件滥用 / 可达可回退)
- 审阅范围:移动 panel tabs、工具条、返回键等 chrome;未评 PDF 解析/渲染/选区算法与 EPUB 解析算法本身

---

## 一、逐页(逐文件)核验表

| 文件 | 规范1 顶栏唯一 | 规范2 左键语义 | 规范3 右侧≤2 & 44px | 规范4 禁桌面组件 | 规范5 可达可回退 | 结论 |
|---|---|---|---|---|---|---|
| `src/features/pdf/components/PdfReader.tsx` | ✅ 经 `useMobileHeader('pdf-reader', …)` 注册(L25-43),页内无自绘顶栏 | ✅ 次级页 `showBackArrow: true`,回 `chat-v2`(L29-30);页内无第二套返回 | ✅ 右侧仅 1 个动作(打开文件,L31-42),带 coarse 44px | ✅ 无 ResizablePanel/宽表/hover-only | ✅ 命令面板+学习资源入口(INVENTORY L17);顶栏返回 | 合规;散点 44px 手贴见违规 V2 |
| `src/features/pdf/components/EnhancedPdfViewer.tsx` | ⚠️ 自身不注册顶栏(正确,单一写者归宿主);移动 panel 自绘一条 header 行(L3777),属内容区全屏子屏,见 O1 | ⚠️ 移动 panel 内返回按钮(L3778)是子屏级返回,非页面级第二套返回,可接受 | ✅ 底部工具条紧凑模式收「更多」(L4056-4140);44px 由 CSS coarse 块机制化(enhanced-pdf.css L1587-1597) | ✅ 侧栏桌面态为自绘 aside 非 ResizablePanel(L3524);移动 ≤640 改全屏子屏(L3775);无 hover-only(coarse 常显,css L1583 注释) | ✅ 返回键协调器逐层关浮层(L1254-1307),带可见性守卫(L1263-1266) | 基本合规;断点自造与散点手贴见 V3/V2 |
| `src/features/pdf/components/TextbookPdfViewer.tsx` | ✅ 纯包装层,无自绘 chrome;顶栏归宿主 `learning-hub` | ✅ 无页内返回 | ✅ 空态唯一按钮带 coarse min-h-11(L249) | ✅ | ✅ 经 TextbookContentView(L838)/FileContentView 挂载,回退由宿主+viewer 内建返回键链承接 | 合规 |
| `src/features/pdf/components/PdfSelectionActions.tsx` | ✅ 复用共享 SelectionToolbar,无自绘顶栏 | ✅ | ✅ 结果面板走底部内联面板非 Dialog(L143-183) | ✅ | ❌ 返回键 handler(L77-83)无可见性/isActive 守卫,见 V1 | 1 个机制性缺口 |
| `src/features/learning-hub/apps/views/EpubPreview.tsx` | ⚠️ 页内自绘一条阅读器工具条(L744-863);<768 隐藏书名与主题分段(css L475-478),仅剩侧栏开关+设置 2 个动作,属内容区工具条非第二条顶栏,可接受(O2) | ✅ 无页内返回按钮;窄屏侧栏是 overlay,返回键/scrim 关闭 | ✅ 移动态工具条 2 动作;44px 由 CSS coarse 块机制化(css L501-525);iOS 16px 防缩放(L515) | ✅ 窄屏侧栏 absolute overlay + scrim(tsx L866-873, css L488-494),非 ResizablePanel;设置走 Popover 宽度钳位(css L480-482) | ✅ 返回键带 `isActive && isNarrow && sidebarOpen` 三重守卫(L150-156);顶栏归 `learning-hub` 注册 | 合规,守卫写法是全仓正面样板 |
| `src/features/learning-hub/apps/views/epubReaderState.ts` | — 纯状态函数,无 chrome | — | — | — | — | 无移动 chrome,不涉五条 |
| `src/features/learning-hub/apps/views/epubReaderModel.ts` | — 纯解析/渲染模型;iframe 内注入 CSS 有 `@media (max-width: 640px)` 正文 padding(L452),属内容排版非 chrome | — | — | — | — | 不涉五条 |
| `src/features/learning-hub/apps/views/UnifiedPreviewToolbar.tsx` | ✅ 内容区底部工具条,非顶栏 | ✅ | ✅ 容器级机制化 44px:`[@media(pointer:coarse)]:[&_button]:min-h-11/min-w-11`(L172);<md 收起重置按钮但菜单内保留等价入口(L206-208, L218) | ✅ | ✅(无自身导航语义) | 合规,机制化写法样板 |
| `src/features/pdf/pdfPageNavigation.ts` | — 纯翻页函数,无 chrome;仅确认被底部工具条 prev/next 消费(EnhancedPdfViewer L3985/L4010) | — | — | — | — | 不涉五条,未动算法 |

---

## 二、返回键 / tabs / 工具条 file:line 索引

### 返回键(androidBackCoordinator)
| 位置 | file:line | 行为 | 守卫 |
|---|---|---|---|
| PDF 浮层链 | `EnhancedPdfViewer.tsx:1254-1307` | 依次关:划词翻译 → 高亮菜单 → 活跃高亮 → 更多菜单 → 缩放菜单 → 侧栏/移动panel → 搜索栏;`BACK_PRIORITY.overlay` | ✅ isConnected + getClientRects + computed visibility(L1263-1266) |
| PDF 划词结果面板 | `PdfSelectionActions.tsx:77-83` | panelOpen 时关面板,返回 true;`BACK_PRIORITY.overlay` | ❌ 无守卫(见 V1) |
| EPUB 窄屏侧栏 | `EpubPreview.tsx:150-156` | 关 sidebar;`BACK_PRIORITY.overlay` | ✅ `isActive && isNarrow && sidebarOpen`(isActive 由 FileContentView.tsx:782 传入) |
| learning-hub 目录层级 | `LearningHubPage.tsx:762-770` | 中屏子文件夹 goUp;`BACK_PRIORITY.view` | ✅ ref 快照 active 判断 |

### 移动 panel tabs
| 位置 | file:line |
|---|---|
| PDF 移动 panel 容器(≤640 全屏子屏) | `EnhancedPdfViewer.tsx:3775-3886` |
| panel header + 子屏返回按钮(CaretLeft) | `EnhancedPdfViewer.tsx:3777-3780` |
| role=tablist 四个分段:目录/缩略图/书签/批注,各带 `[@media(pointer:coarse)]:!min-h-11` | `EnhancedPdfViewer.tsx:3781-3822`(L3787/3797/3806/3816) |
| 桌面侧栏 tabs(对照,同域互斥) | `EnhancedPdfViewer.tsx:3524-3583` |
| panel tab 34px 基础样式被 TSX 内联 coarse 44px 对冲的机制说明 | 测试文件头注释 `pdfMobilePanelTabs.source.test.ts:7-11`;CSS 在 `src/features/pdf/styles/enhanced-pdf.css` |
| EPUB 侧栏 tabs(目录/搜索 2 分段) | `EpubPreview.tsx:881-888` |

### 工具条
| 位置 | file:line |
|---|---|
| PDF 底部工具条(单行,紧凑模式) | `EnhancedPdfViewer.tsx:3889-4141`;紧凑阈值 ResizeObserver,coarse 800px(L597-609) |
| PDF「更多」菜单(紧凑收纳) | `EnhancedPdfViewer.tsx:4056-4140` |
| PDF 移动高亮条(viewer 内底部内联,非 fixed body 层) | `EnhancedPdfViewer.tsx:3337-3376+`;桌面浮动菜单 gated `!isMobileLike`(L3290) |
| PDF 划词工具条挂载 | `EnhancedPdfViewer.tsx:3279-3284`;`PdfSelectionActions.tsx:124-141`(placement="below", viewportBottomInset=132) |
| PDF 工具条 44px/横向滚动兜底 CSS | `enhanced-pdf.css:1587-1617`(coarse 44px)、`1707-1737`(≤480 横向滚动+菜单定位改基准) |
| 轻点显隐底栏 chrome | `EnhancedPdfViewer.tsx:414`(chromeVisible)、`:3217`(chrome-hidden 类) |
| 进度条拖动跳页(slider 语义) | `EnhancedPdfViewer.tsx:4145-4172` |
| EPUB 顶部阅读器工具条 | `EpubPreview.tsx:744-863`;<768 收敛规则 `EpubPreview.css:470-499`;coarse 44px `EpubPreview.css:501-525` |
| EPUB 底部章节导航 footer | `EpubPreview.tsx:977-988` |
| 统一预览工具条(docx/xlsx/pptx/image) | `UnifiedPreviewToolbar.tsx:170-289`;44px 容器规则 L172;max-md:hidden 重置 L218/L282 |

### UnifiedMobileHeader / useMobileHeader 在 PDF/EPUB 页的注册
| 视图 | file:line | 配置 |
|---|---|---|
| `pdf-reader`(独立 PDF 阅读页) | `PdfReader.tsx:25-43` | title + showBackArrow + onMenuClick→chat-v2 + rightActions×1(44px) |
| `learning-hub`(EPUB/教材 PDF 的宿主) | `LearningHubPage.tsx:723-750` | 三屏语义:右屏返回中屏/子屏 chrome 接管(useMobileSubviewChromeHost L719);EnhancedPdfViewer/EpubPreview 本身不写顶栏(单一写者正确) |

---

## 三、违规与机制化建议

### V1(建议优先修)PdfSelectionActions 返回键 handler 缺可见性守卫
- `PdfSelectionActions.tsx:77-83` 在 `panelOpen` 时注册并无条件 `return true`。同文件同一浮层体系里,`EnhancedPdfViewer.tsx:1260-1266` 明确为「保活但不可见的实例(ViewLayerRenderer keep-alive 隐藏层)不得吞掉返回键」加了 isConnected/getClientRects/visibility 三重守卫,EpubPreview 则用 `isActive` prop 解决同一问题。PdfSelectionActions 两者都没有:隐藏保活的 PDF 实例若残留打开的解释/翻译面板,会吞掉当前活跃页面的系统返回键——违反规范 5「可回退」的机制要求。
- 机制化建议:不要在第三处再手抄一遍守卫。在 `@/app/navigation/androidBackCoordinator` 提供 `registerVisibilityGuardedBackHandler(elementRef, fn, priority)`(内置 isConnected/getClientRects/computed visibility 检查),让 EnhancedPdfViewer 与 PdfSelectionActions 共用;PdfSelectionActions 可直接复用宿主 `containerRef`。现有 source test(`pdfSelectionToolbar.source.test.ts:104-107`)只断言 registerBackHandler 存在,修复时应同步钉住守卫存在。

### V2(债务,不再扩散)散点 44px 手贴
- PDF 侧大量内联 `[@media(pointer:coarse)]:!min-h-11` 手贴:`PdfReader.tsx:36/265/273/290`、`EnhancedPdfViewer.tsx:264/279/282/3012/3125/3344-3347/3658/3787/3797/3806/3816`、`TextbookPdfViewer.tsx:249`。对照本仓已有的三种机制化写法——`enhanced-pdf.css:1587` 的 `.ds-btn` coarse 块、`EpubPreview.css:501` 的 `.epub-preview button` 块、`UnifiedPreviewToolbar.tsx:172` 的容器级 `[&_button]` 规则——这些内联串是「类名一丢就静默缩回」的脆弱点(panel tab 34px 基础样式压过 DsButton coarse 规则,全靠 TSX 手贴扛,见测试注释)。
- 机制化建议(本轮不改代码,列给落地轮):把 `.ds-pdf__mobile-panel-tab`、高亮条色板、密码输入框的 coarse 44px 直接落进 `enhanced-pdf.css` 的既有 coarse 块(用等特异性选择器压过 34px 基础规则),TSX 内联串随之删除;`pdfMobilePanelTabs.source.test.ts` 的断言目标从「TSX 含内联串」改为「CSS coarse 块含对应选择器」。符合本轮「不要散点 44px 手贴」要求——不新增手贴,存量收敛到机制。

### V3(低)移动判定断点三处自造/分叉
- `EnhancedPdfViewer.tsx:389-411` 手写 `matchMedia('(max-width: 639.98px)')` + `(pointer: coarse)`;EpubPreview 已被上一轮改为共享 `useIsMobile`(768);App shell 移动切换点 768。<640 是文档化的刻意设计(注释 L390-392,内联子屏形态),不算违规,但 matchMedia 订阅样板代码与守卫逻辑属重复。
- 机制化建议:在 `@/hooks/useBreakpoint` 补 `useViewportBelow(px)` / `useCoarsePointer()` 两个通用 hook,EnhancedPdfViewer 消费之;断点数值(640)保留其设计意图不动。

### V4(低)`MOBILE_BOTTOM_INSET_PX = 132` 魔数
- `PdfSelectionActions.tsx:37`,注释自称「经验值」= 底栏+进度细线+Home Indicator。而 CSS 侧已有同一组派生变量 `--ds-pdf-toolbar-h`/`--ds-pdf-progress-h`/`--ds-pdf-safe-bottom`(`enhanced-pdf.css:1599-1602/1736`)。底栏高度一旦调整,两处会静默分叉(coarse 下 48px 底栏 vs 常规,132 只对其中一种成立)。
- 机制化建议:运行时从 `.ds-pdf-viewer` 读 computed CSS 变量求和,或把常量提为与 CSS 共享的导出常量并加 source test 钉住两侧一致。

### O1(观察,不判违规)PDF 移动 panel 自绘子屏 header
- `EnhancedPdfViewer.tsx:3777-3780` 的 CaretLeft 返回属于内容区全屏子屏的内部返回,系统返回键同样能关它(L1288-1291),且 viewer 被三个宿主复用(pdf-reader / learning-hub tab / 教材视图),无法自己注册全局顶栏。与规范 2「不要在页内再放一套返回」不冲突(那条针对页面级返回)。若未来要彻底统一,可让 learning-hub 宿主走 `useMobileSubviewChrome` 接管,但当前形态可接受。

### O2(观察)EPUB 阅读器工具条是内容区第二条横条
- `EpubPreview.tsx:744` 的 toolbar 在移动端(全局顶栏之下)占 52px。<768 已把书名/主题分段藏掉只剩 2 个动作(css L475-478),无返回/标题重复,不构成「第二条顶栏」。保持现状即可;若后续想省这 52px,同样走宿主 subview chrome 的收编路径。

---

## 四、现有 source test 覆盖了什么(与缺口)

### `src/features/pdf/components/__tests__/pdfMobilePanelTabs.source.test.ts`
已覆盖:
1. 移动 panel 恰好 4 个 tab(目录/缩略图/书签/批注,L25-29 正则排除容器类);
2. 4 个 tab 全部带内联 `[@media(pointer:coarse)]:!min-h-11`(L31-38)——即 V2 所述脆弱点的回归防线;
3. 书签 tab 在移动 panel(`pdf:bookmark.tabLabel`)与桌面侧栏(`aria-selected={sidebarMode === 'bookmarks'}`)双端都接线(L40-45);
4. TextbookPdfViewer 确实包装 EnhancedPdfViewer 且透传 bookmarks(L48-55)。

### `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts`
已覆盖:
1. PdfSelectionActions 挂在 viewer 根内、containerRef/enabled/isMobileLike 三个契约 prop(L24-35);
2. 高亮条与划词工具条是两个独立面(L37-41);
3. 复用共享层:SelectionToolbar/useTextSelection、解释/翻译 Popover、useSaveAsNoteFlow、selectionCardGeneration,并显式禁止平行链路(L44-84);
4. 移动行为:placement="below"、viewportBottomInset 参与定位、结果面板是内联面板非 DsDialog、CSS 用 `--ds-pdf-safe-bottom`(L86-102);
5. 返回键:registerBackHandler + BACK_PRIORITY.overlay 存在(L104-107)。

### `src/features/learning-hub/apps/views/__tests__/previewMobileAdaptation.source.test.ts`(EPUB/统一工具条相关)
已覆盖:
1. UnifiedPreviewToolbar:<md 隐藏缩放/字号重置但菜单等价入口保留、窄屏紧凑页码读数、容器级 coarse 44px 规则(L23-46);
2. EpubPreview:移动判定用共享 `useIsMobile` 非自造 700px;CSS 断点与 md=768 同源(L66-79);
3. Docx/Xlsx/TextFilePreview 的窄屏项(不在本台账范围,列存)。
另:`epubReaderState.test.ts`/`epubReaderModel.test.ts` 覆盖纯函数(进度合并/解析),不属 chrome。

### 覆盖缺口(供落地轮补)
1. **无任何测试钉 EnhancedPdfViewer 返回键的浮层关闭顺序与可见性守卫**(L1254-1307)——这是 PDF 移动回退的核心机制,却零契约;
2. `pdfSelectionToolbar.source.test.ts:104-107` 只断言 handler 存在,**没有断言守卫**——事实上钉住了 V1 的缺陷现状,修 V1 时必须同步改;
3. **无测试钉 PdfReader 的 useMobileHeader 注册形态**(showBackArrow / rightActions 恰 1 个 / onMenuClick 目标),顶栏语义回归无防线;
4. **无测试钉 EpubPreview 返回键的 isActive 守卫**(L150-156)——该守卫是修 V1 的参照样板,本身也应有契约;
5. panel tabs 44px 契约绑定在「TSX 内联串」上,若按 V2 收敛到 CSS 机制,测试断言目标需一并迁移(测试文件头注释已自述此依赖)。

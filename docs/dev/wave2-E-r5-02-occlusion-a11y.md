# Wave2-E R5-02：遮挡预览 a11y 接线（occlusion locale 消费）

- 轮次：0824 Wave2-E 第 5 轮「遮挡 a11y」
- 独占文件：`src/components/anki/ImageOcclusionOverlay.tsx`；
  `src/features/chat/plugins/blocks/ankiCardsBlock.tsx` 仅 `alt=""` 一带
  （`AnkiOcclusionCardPreview`，原 :519-558 区间）
- 约束：只接线不改词条文件（`agent.occlusion.*` 已存在于中英 `anki.json`，
  避免与 QA i18n 抢 `anki.json`）；不改 CriticSummary / 数据模型；
  测试只写不跑；未 commit

## 背景

r1-09 §3.3 / §7 插入点 4、r3-09 §2 复核均记录了两处 a11y 孤儿：

1. `ImageOcclusionOverlay.tsx:123` 硬编码中文
   `` aria-label={`揭开遮挡区域 ${box.clozeIndex}`} ``，
   `agent.occlusion.revealBox`（"揭开遮挡区域 {{index}}"）备而未用；
2. `ankiCardsBlock.tsx` occlusion 预览 `<img alt="">` —— alt="" 语义是
   "装饰图"，但遮挡卡图片是内容主体，读屏用户丢失信息；
   `agent.occlusion.imageAlt`（"图像遮挡卡片"）备而未用。

## 改动内容

### 1. `ImageOcclusionOverlay.tsx`

- 新增 `useTranslation('anki')`（组件此前零 i18n 依赖）；
- 遮挡态按钮 `aria-label` 由硬编码模板串改为
  `t('agent.occlusion.revealBox', { index: box.clozeIndex })`。
- 其余（样式、受控/非受控逻辑、键盘处理、testid）零触碰。
  `revealedBox` / `revealAll` / `hideAll` 等词条对应的 UI 本轮不存在
  （已揭开盒是无 role 的 div，无全揭/全遮按钮），维持备而未用，不越权加功能。

### 2. `ankiCardsBlock.tsx`（仅 `AnkiOcclusionCardPreview`）

- 组件内新增 `const { t } = useTranslation('anki')`（文件已 import
  `useTranslation`，其他组件各自持有实例，互不影响）；
- `<img alt="">` 改为 `alt={t('agent.occlusion.imageAlt')}` ——
  图片从"装饰"升级为具名内容图（role=img 可命名）。
- 占位 div 的 `aria-hidden="true"` 保留（加载中/不可用时无信息可读）；
  CriticSummary、数据模型、其余区间零触碰。

### 3. 测试（只写不跑）

- `src/components/anki/__tests__/ImageOcclusionOverlay.test.tsx`：
  - 组件不再输出硬编码文案，新增 react-i18next mock：
    `agent.occlusion.revealBox` → `揭开遮挡区域 ${index}`（与 zh-CN
    `anki.json` 词条一致），未知 key 回退 key 本身；
  - 全部 8 处 `getByLabelText` / `getAllByLabelText` 改为
    `getByRole('button', { name: … })` / `getAllByRole` 语义查询；
  - 已揭开盒无 role，相关断言维持 testid 不变。
- `tests/vitest/chat-v2/plugins/blocks/AnkiCardsOcclusionPreview.test.tsx`：
  - 既有 react-i18next mock 升级为 dict + `{{var}}` 插值
    （与 `AnkiCriticSummaryBanner.test.tsx` 的既有模式一致），补
    `agent.occlusion.imageAlt` / `agent.occlusion.revealBox` 两词条；
    原来 mock 直接回退 key，无法为多个盒生成可区分的 aria-label；
  - 5 处遮挡盒 label 查询改为 `getByRole('button', { name: … })`；
  - 3 处 `getByTestId('anki-occlusion-image')` 改为
    `getByRole('img', { name: '图像遮挡卡片' })` —— alt 非空后 img 可按
    accessible name 查询，同时钉住 imageAlt 接线不回退成 alt=""。

## 验证口径

- grep `揭开遮挡区域` 在 `src/` 仅剩 locale 词条本身（组件零命中）；
  grep `alt=""` 在两个独占文件零命中。
- 本轮词条消费后，r1-09 §4 孤儿清单中 `agent.occlusion.imageAlt` /
  `revealBox` 两键落地；`agent.occlusion.*` 其余键（title / previewBadge /
  draftHint / imageUnavailable / invalidSpec / revealedBox / revealAll /
  hideAll / issue.*）与 `chatV2.json` occlusion 四键仍为孤儿，
  对应 UI 不在本轮范围。

## 未做的事

- 未跑任何测试 / 类型检查全量流程，未 commit（任务约束）；
- 未动 `anki.json` / `chatV2.json` 词条文件；
- 未处理 `AnkiTemplateCardFace.tsx:154` 的 `alt=""`（独占范围外，
  且模板卡图片语义需单独评估，记录待后续认领）；
- 未给已揭开盒 / 全揭全遮补 UI 或词条消费（`revealedBox` 等继续备而未用）。

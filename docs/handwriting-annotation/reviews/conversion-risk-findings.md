# 转换风险研究 — 2026-11-03

来源：只读Explore agent_5f3c3f9f-f337-45c1-ac2e-23ab5a93fd11。Explore没有写权限，由主agent将返回结论归档。以下为代码研究，不是转换测试通过证明。

## 推荐最小实现

Task9在ink/prepare新增浏览器页渲染函数，接Office bytes+AbortSignal，返回有序PNG/测量尺寸/质量警告。保留React预览加载/缩放/导航。捕获目标必须附着到有非零layout尺寸的离屏staging host，不能display:none或仅detached DOM。

DOCX现有路径：`src/features/learning-hub/apps/views/DocxPreview.tsx:196–235`，docx-preview render后经`sanitizeRenderedDom.ts:64–119`与`sanitizeGeneratedStyles.ts:98–139`净化再附着。现预览ignoreHeight/ignoreLastRenderedPageBreak选项不直接适用于固定页图。独立转换选择保留page几何，按`.docx-preview-wrapper > section.docx-preview`（兼容`.docx-wrapper > section.docx`）顺序逐页截图，不能截滚动viewport。库不承诺浏览器自动重新分页，自建fixture显式分页，并给字体/排版质量警告。

每页捕获前等待document.fonts.ready、每个img.decode、layout帧稳定；超时/取消有界。fonts.ready不证明用户指定字体存在，缺字族可fallback但需质量警告。已有snapdom参考`src/components/practice/paperExport.ts:93–125,230–272`；输出按真实尺寸，不照搬练习卷A4比例。

PPTX：现有`PptxPreview.tsx:312–352,370–380`。最小内存路径是mode='slide'，读slideCount，对每个index调用已安装公开renderSingleSlide(i)，捕获`.pptx-preview-slide-wrapper`。每张等待字体/图片，`.chart-node` SVG ready（库延迟timer初始化chart）；不能只等整个preview首次timer。finally destroy，逐页串行。

## 真实离线夹具/测试

现有JSZip生成最小DOCX/PPTX OOXML：DOCX两页显式break、表格、嵌图和缺字体；PPTX多张可区分slide、嵌图、chart。CT断言页数/顺序/非零尺寸/真实像素，不只mock调用。异常、超时、取消、超限和选页PDF页数比例同测。

测试框架：`playwright-ct.config.ts:9–39`，既有`tests/ct/question-bank/PaperExportHarness.tsx:7–35`及`paperExport.spec.tsx:7–20`。主agent已运行现有真实snapdom/pdfmake CT 1通过，但不代表Office逐页固化通过。

## PDFium与PDF.js

`scripts/download-pdfium.sh:11–15,131–172`固定bblanchon/pdfium-binaries chromium/7350，资源目录src-tauri/resources/pdfium；脚本下载解压没有SHA256校验。Linux.so当前未提供；构建CI下载，Rust loader bundled→system。见`dstu-docs/src/pdfium_utils.rs:44–113,275–301`。

不要为DOCX/PPTX转换安装PDFium/Office。PDF背景优先复用已有React-PDF/PDF.js、worker和打包assets（`EnhancedPdfViewer.tsx:3–4,77–78`、`vite.config.ts:213–229`、`src/utils/pdfConfig.ts:10–17`）；不将此替换视为原生提取/OCR也可用。若后续必须下载native库，先解决来源/完整性核验，不自动运行无校验二进制。

## 结论

可用已有依赖完成，不新增运行时库；上述选择器/ready和实际多页质量仍需主agent真实浏览器验证。实施不得把研究建议直接标为Task0/Task9通过。

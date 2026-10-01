---
title: 合成导入文件
custom_unknown: keep-this-value
---

# F05 引用与兼容保留

[[合成目标页]]、[[note_fixture01|按 ID 引用]]、[[合成目标页#相同标题|章节别名]]、[[尚不存在的页面]]。

[笔记跳转](note://note_fixture01#%E7%9B%B8%E5%90%8C%E6%A0%87%E9%A2%98)

[PDF 第 7 页](pdfref://file_fixture_pdf?page=7)

![合成旧图](notes_assets/_global/note_fixture05/figure-old.png)

[合成附件](notes_assets/_global/note_fixture05/data.csv)

![远程图片，仅存 URL](https://example.invalid/figure.png)

<details data-fixture="unknown-attribute">
<summary>外部 HTML 折叠标题</summary>
<p>这段 HTML 及属性需要原文保留，不能假装已经转换成内建 toggle。</p>
</details>

:::future-widget{kind="synthetic"}
未知扩展的正文，解析不支持时保留。
:::

这是脚注引用[^synthetic]，保留定义不等于承诺当前编辑器支持脚注 UI。

[^synthetic]: 合成脚注原文。

`[[代码内不产生出链]]` 和 `note://note_fixture_missing`。

F05-END

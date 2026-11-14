# L13 导图导入解析依赖

## XML（F7 / F4）

需要公开 `mindmapXml.parse(text): MindmapXmlNode`，最小类型见 `api.ts`。
原语义来自 `roxmltree::Document::parse`（builtin_resource_executor.rs:3252,3437,3822,3944）：
- 返回根元素，保留element/text/other节点顺序、localName、每个属性的namespace URI和原值；无命名空间属性查找不匹配有namespace同名属性。
- 处理实体、CDATA、命名空间、首文本子节点与descendants文本顺序；非法XML抛出roxmltree Display错误，由L13添加OPML/MM等上下文。
- 本 lane 已移植所有格式的树转换逻辑，不能将整段导图解析转交提供方。只缺成熟XML解析边界；请F7提供同源预编译适配或由协调者批准成熟npm库及错误差异裁定，不手写XML解析器。
- 当前 `package.json` 仅有开发依赖jsdom。测试借其构造合法XML树替身，不用于生产，不标作等价引擎。

## 虚拟路径（F3）

需要 `virtualFilePolicy.isVirtualUri(path)`，可直接公开已存在的
`host/platform/storage/unified-file-manager.ts::isVirtualUri`；对应Rust
`dstu-storage/src/unified_file_manager.rs:413-415`。本 lane 不复制 special scheme / Android SAF 判定。
影响 `mindmap_import` 的originalPath回退；最小 `VirtualFilePolicy` 已在api.ts公开。

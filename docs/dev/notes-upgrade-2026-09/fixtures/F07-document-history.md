# F07 完整文档版本档案（合成输入，未实现协议）

这是容纳三份完整 Markdown 快照的测试档案，不直接导入为一篇笔记。`nv_f07_*` 是测试别名，真实测试映射后端返回的 versionId。contentFormat=`markdown-blocks`、formatVersion=1、serializerVersion=`fixture-1` 均为提案字段值。

## v1

- noteId：`note_fixture07`
- versionId：`nv_f07_v1`；parent：null
- title：`实验结论（初版）`
- tags：`["实验", "待复核"]`
- props：`{"reviewed":false,"round":1}`
- assetRefs：`["notes_assets/_global/note_fixture07/figure-v1.png"]`
- source：`editor`

```markdown
<!-- ds:block-id=b_f07_heading -->

# 测量记录

<!-- ds:block-id=b_f07_claim -->

初步结论：样本 A 的读数为 10，尚未校准。

<!-- ds:block-id=b_f07_asset -->

![初版测量图](notes_assets/_global/note_fixture07/figure-v1.png)

<!-- ds:block-id=b_f07_tail -->

V1-FULL-DOCUMENT-END
```

## v2

- noteId：`note_fixture07`
- versionId：`nv_f07_v2`；parent：`nv_f07_v1`
- title：`实验结论（已校准）`
- tags：`["实验", "已复核"]`
- props：`{"reviewed":true,"round":2}`
- assetRefs：`[]`
- source：`ai`

```markdown
<!-- ds:block-id=b_f07_heading -->

# 校准后的测量记录

<!-- ds:block-id=b_f07_claim -->

校准结论：样本 A 的读数为 12，初版读数偏低。

<!-- ds:block-id=b_f07_tail -->

V2-FULL-DOCUMENT-END
```

## v3（仅元数据变化，正文逐字等于 v2）

- noteId：`note_fixture07`
- versionId：`nv_f07_v3`；parent：`nv_f07_v2`
- title：`实验结论（交付）`
- tags：`["实验", "已复核"]`
- props：`{"round":3,"reviewed":true}`
- assetRefs：`[]`
- source：`editor`

```markdown
<!-- ds:block-id=b_f07_heading -->

# 校准后的测量记录

<!-- ds:block-id=b_f07_claim -->

校准结论：样本 A 的读数为 12，初版读数偏低。

<!-- ds:block-id=b_f07_tail -->

V2-FULL-DOCUMENT-END
```

## 固定引用与恢复期望

[拟议历史块引用：初版读数](noteref://note_fixture07?version=nv_f07_v1&block=b_f07_claim)

[拟议历史整页引用](noteref://note_fixture07?version=nv_f07_v1)

恢复 v1 必须得到新的 v4：parent=v3，restoredFrom=v1，文档各字段与 v1 一致。旧图实体在合成测试数据目录中补建；这里故意没有真实图片，因此不能用此文件证明附件恢复通过。

另做属性次序负例：以 v3 的 props 换成 `{"reviewed":true,"round":3}`，逻辑对象相同，不应仅因键顺序变化产生文档版本。

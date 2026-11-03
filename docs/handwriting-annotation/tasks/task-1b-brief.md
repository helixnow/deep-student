# Task1b — 有界语义操作契约与纯状态变换

> 尚未派发；Task1格式验证通过后执行。read this first — exact contract values below.

Repo `/home/xutao/deepstudent/deep-student` branch `feat/handwriting-annotation-chat`。只实现 `vfs/ink/operations.rs`、相应Rust测试和`src/features/ink/types.ts`类型扩展，最多必要mod导出。不得跑测试/build/install、再派agent、commit/push或写UI/数据库。

## 分工与门禁

先写行为测试+可编译最小API，返回NEEDS_RED_VERIFICATION；主agent实际红灯后才实现。正负分批，不能用恒Err证明拒绝行为。对象和几何只使用Task1域类型，不另造平行模型。

## 坐标/操作协议

内部页几何逻辑坐标。工具请求归一化0..1，`coordinate_space: page | render_crop`；新增/更新定位必须存在`based_on_render_id`。纯函数接由后端加载且已验证归属的冻结render mapping，不允许调用方伪造服务端mapping；render查找和revision/source核验在文档服务做。

`InkRenderMapping`：render_id、document_id、revision、page_id、crop: InkRect（逻辑页区域），用于page/render_crop归一化→逻辑转换。最终几何必须完全在页内。

操作使用`op` tag：
- append_blank_page {page_id,width,height,ruling}：page_id由服务生成（工具输入不提供id；纯内部op可用），追加空页。
- add_text/add_rect/add_ellipse/add_arrow/add_region_highlight：目标page_id、受控content几何/样式、内部object_id/created_at由服务生成；author固定Ai。
- update_object：page_id/object_id，受控替换文本/形状content；不支持把stroke变模型点数组、不允许修改作者/created_at/id。
- remove_object：page_id/object_id。

单次1..100项，全批在克隆状态上校验，成功才返回新页状态；中途错误不修改原输入。不提供任意整文档覆盖、HTML/SVG、外部路径、清空整本。

存储层以后接受`expected_revision`/operation_id，在事务内再核对。纯操作函数不生成revision、不直接保存blob、不处理审批；需要返回affected_page_ids和对象变更before/after供对象级AI事务撤销。对对象不存在/ID重复/超页/越界/过时mapping明确结构化错误，不静默跳过。按页变化整批validate_page，批后总页数validate_manifest。

## AI撤销

保存AI事务涉及的对象before/after及append page身份，不以整文档快照覆盖后来修改。撤销时仅当当前对象仍等于该事务after才可还原before或移除新增；对象已被后来人类修改则REVISION_CONFLICT、整批不变；人类后来新增不相关对象保留。append页撤销仅当为空/只含该事务对象才可删除；不能把用户后写内容删掉。幂等/审批归后续文档服务/工具。

## 测试

成功文本/箭头归一化页坐标、裁剪映射手算literal期望；append页；先可编译红灯再实现。后续负向组：空/101项、重复/缺对象、非法style/文本/几何、render mismatch或缺mapping、更新stroke禁止、第二个op失败第一个不生效。AI撤销保留后续人类新增；人类修改同对象/新增到append页时拒绝而不丢失内容。测试不只断言mock调用。

报告 `tasks/task-1b-report.md` 含接口、测试选择器、精确待主agent运行命令/预期红灯、concerns。所有记录统一本目录。

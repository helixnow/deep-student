# F03 表格、公式与围栏

| 名称 | 表达式 | 说明 |
| :--- | :---: | ---: |
| 速度 | $v=s/t$ | 第一行 |
| 分隔符 | a\|b | 转义竖线 |
| 行内代码 | `x + y` | 第三行 |

行内公式 $E = mc^2$ 与正文处在同一段。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

````markdown
# 这是代码里的标题
[[代码里的双链]]
```js
const value = "note://note_fixture_missing";
```
<!-- ds:block-id=b_code_literal -->
````

~~~text
这里有三个反引号 ```，不应关闭波浪线围栏。
~~~

```mermaid
flowchart LR
  A[合成输入] --> B[处理] --> C[合成输出]
```

F03-END：公式或 Mermaid 渲染失败时仍应保留原始源码。

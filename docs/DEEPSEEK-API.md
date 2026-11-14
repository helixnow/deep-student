# Node 版 DeepSeek 应用 API

在 **设置 → 模型服务 → DeepSeek** 填写官方 API Key，然后在同一页的 **应用能力** 管理和测试各项接口。对话能力使用官方 `deepseek-flash` 的 **OpenAI Responses** 协议。第三方中转和手动选择 Chat Completions 的模型仍走原有协议。

| 能力 | 如何使用 |
| --- | --- |
| [联网搜索、图片搜索和读链接](https://api-docs.deepseek.com/zh-cn/guides/web_tools/) | 对话搜索和读链接各有开关；单模型聊天也须允许联网。搜索开启思考时会进行深度搜索，此时同时启用的独立读链接工具由服务端停用。回复可以带可点击的网页引用。 |
| [内容审核](https://api-docs.deepseek.com/zh-cn/guides/safety/) | 开启对话内容审核，DeepSeek 审核通过后显示正文；拒答时显示审核提示。 |
| [对话文件](https://api-docs.deepseek.com/zh-cn/guides/document_parsing/) | 开启对话文件解析后，在单模型聊天中添加 PDF、Word、PPT 等受支持的文件。应用会上传附件，后续对话与重试会复用文件 ID。同一请求最多引用 20 个文件。 |
| [独立 Search / Fetch](https://api-docs.deepseek.com/zh-cn/guides/search/) | Search 开关在聊天的搜索引擎列表中添加或移除 DeepSeek；Fetch 可单独开启。默认复用模型服务里的 Key，也可在「外部搜索」单独填写 Key。 |
| [独立 OCR](https://api-docs.deepseek.com/zh-cn/guides/ocr/) | OCR 开关将 DeepSeek 加入已有 OCR 引擎列表，优先级仍由「模型分配」管理。 |
| [独立 ASR](https://api-docs.deepseek.com/zh-cn/guides/asr/) | ASR 开关将语音输入分配给 `DeepSeek ASR`。输入为 WAV 或 Ogg Opus，单次最多 120 秒、8 MiB。 |
| [独立 TTS](https://api-docs.deepseek.com/zh-cn/guides/tts/) | 选择 `Stella` 或 `Tide`，然后在聊天消息菜单或翻译面板使用朗读。默认仍用系统语音。 |

每行分别显示启用状态和本次打开详情页后的最近一次测试结果。点击「测试」才会请求官方接口，使用固定样例；文件测试上传的文本一小时后过期。测试可能产生工具或模型费用，见[发布公告](https://api-docs.deepseek.com/zh-cn/news/news261113/)。

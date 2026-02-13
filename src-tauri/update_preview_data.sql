-- 更新模板的preview_data_json字段

-- 1. 极简卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Front": "什么是动量守恒定律？",
  "Back": "在没有外力作用的系统中，系统的总动量保持不变",
  "Notes": "这是一个物理概念的补充说明，帮助理解动量守恒。",
  "Tags": ["物理", "力学", "守恒定律"]
}'
WHERE id = 'minimal-card';

-- 2. 编程代码卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Question": "如何在Python中定义函数？",
  "Code": "def function_name(parameters):\n    # 函数体\n    return result",
  "Language": "Python",
  "Notes": "Python函数定义的基本语法",
  "Tags": ["Python", "编程", "函数"]
}'
WHERE id = 'code-card';

-- 3. 填空题卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Text": "牛顿第二定律的公式是 {{c1::F = ma}}，其中m表示{{c2::质量}}，a表示{{c3::加速度}}",
  "Hint": "记住牛顿第二定律的三个要素",
  "Notes": "力、质量和加速度之间的关系",
  "Tags": ["物理", "牛顿定律", "公式"]
}'
WHERE id = 'cloze-card';

-- 4. 选择题卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Question": "下列哪个是牛顿第一定律的内容？",
  "OptionA": "F=ma",
  "OptionB": "作用力与反作用力",
  "OptionC": "惯性定律",
  "OptionD": "万有引力定律",
  "Correct": "C",
  "Explanation": "牛顿第一定律又称惯性定律，表述物体在没有外力作用时保持静止或匀速直线运动状态。",
  "Tags": ["物理", "力学", "基础概念"]
}'
WHERE id = 'choice-card';

-- 5. 多步骤教程卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Title": "如何配置Git环境",
  "Overview": "完成Git的安装和基本配置",
  "Steps": [
    {
      "order": 1,
      "action": "下载并安装Git",
      "details": "从官网下载适合系统的版本"
    },
    {
      "order": 2,
      "action": "配置用户信息",
      "details": "设置全局的用户名和邮箱",
      "code": {
        "language": "bash",
        "code": "git config --global user.name \"Your Name\"\ngit config --global user.email \"your@email.com\""
      }
    },
    {
      "order": 3,
      "action": "生成SSH密钥",
      "details": "创建用于GitHub认证的SSH密钥",
      "warning": "请妥善保管私钥文件，不要分享给他人"
    }
  ],
  "EstimatedTime": "15分钟",
  "Tips": ["建议使用官方安装包", "记住配置的用户名", "SSH密钥要设置正确的权限"],
  "CommonMistakes": ["忘记配置用户信息", "SSH密钥权限设置错误", "用户名包含特殊字符"],
  "Tags": ["Git", "开发工具", "教程"]
}'
WHERE id = 'multi-step-tutorial';

-- 6. 代码调试练习卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Title": "Python列表越界错误",
  "BuggyCode": "my_list = [1, 2, 3]\nprint(my_list[3])",
  "Language": "Python",
  "ErrorType": "IndexError",
  "ErrorMessage": "list index out of range",
  "CorrectCode": "my_list = [1, 2, 3]\nprint(my_list[2])  # 或使用 len() 检查",
  "Explanation": "列表索引从0开始，长度为3的列表最大索引是2",
  "Tags": ["Python", "调试", "列表操作"]
}'
WHERE id = 'code-debugging';

-- 7. 知识图谱卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "CentralConcept": "人工智能",
  "Definition": "通过计算机系统模拟人类智能行为的技术领域",
  "Components": [
    {
      "name": "机器学习",
      "description": "让计算机从数据中学习规律的方法",
      "importance": "high",
      "subComponents": ["监督学习", "无监督学习", "强化学习"]
    },
    {
      "name": "深度学习",
      "description": "基于神经网络的机器学习方法",
      "importance": "high",
      "subComponents": ["卷积神经网络", "循环神经网络", "变换器模型"]
    },
    {
      "name": "自然语言处理",
      "description": "使计算机理解和生成人类语言",
      "importance": "medium",
      "subComponents": ["文本分析", "语音识别", "机器翻译"]
    }
  ],
  "Relationships": [
    {
      "from": "人工智能",
      "type": "包含",
      "to": "机器学习",
      "description": "机器学习是人工智能的核心技术"
    },
    {
      "from": "机器学习",
      "type": "发展为",
      "to": "深度学习",
      "description": "深度学习是机器学习的高级形式"
    },
    {
      "from": "深度学习",
      "type": "应用于",
      "to": "自然语言处理",
      "description": "深度学习技术广泛应用于NLP任务"
    }
  ],
  "Tags": ["人工智能", "概念图", "关系网络"]
}'
WHERE id = 'knowledge-graph';

-- 8. 数据分析对比卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Topic": "机器学习算法对比",
  "Criteria": ["准确率", "训练速度", "可解释性"],
  "ComparisonItems": [
    {
      "name": "决策树",
      "description": "基于树形结构的分类算法",
      "scores": ["85%", "快", "高"],
      "pros": ["易于理解", "训练快速", "不需要数据预处理"],
      "cons": ["容易过拟合", "对噪声敏感", "偏向于特征多的数据"]
    },
    {
      "name": "随机森林",
      "description": "多个决策树的集成学习算法",
      "scores": ["92%", "中", "中"],
      "pros": ["精度高", "抗过拟合", "可处理缺失值"],
      "cons": ["解释性较差", "内存占用大", "训练时间较长"]
    },
    {
      "name": "神经网络",
      "description": "模拟人脑神经元的深度学习算法",
      "scores": ["95%", "慢", "低"],
      "pros": ["精度最高", "适应性强", "可处理复杂模式"],
      "cons": ["黑盒模型", "需要大量数据", "训练时间很长"]
    }
  ],
  "Conclusion": "根据具体需求选择合适的算法",
  "Tags": ["机器学习", "算法", "对比分析"]
}'
WHERE id = 'data-analysis-comparison';

-- 9. 语言学习卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Word": "こんにちは",
  "Translation": "你好 (Hello)",
  "Pronunciation": "kon-ni-chi-wa",
  "Example": "朝、友達に「こんにちは」と言いました。",
  "Grammar": "日常打招呼用语",
  "Context": "用于白天见面时的问候",
  "Tags": ["日语", "问候语", "初级"]
}'
WHERE id = 'language-learning-card';

-- 10. 法律条文卡片
UPDATE custom_anki_templates 
SET preview_data_json = '{
  "Article": "《民法典》第一条",
  "Law": "中华人民共和国民法典",
  "Content": "为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，适应中国特色社会主义发展要求，弘扬社会主义核心价值观，根据宪法，制定本法。",
  "Keywords": ["民事主体", "合法权益", "民事关系"],
  "Interpretation": "确立了民法典的立法目的和价值导向",
  "Tags": ["民法", "法条", "总则"]
}'
WHERE id = 'legal-articles-card';
EOF < /dev/null
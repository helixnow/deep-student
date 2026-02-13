-- 修复选择题卡片的预览数据
UPDATE custom_anki_templates 
SET 
  preview_data_json = '{
    "Front": "下列哪个是牛顿第一定律的内容？",
    "optiona": "F=ma",
    "optionb": "作用力与反作用力",
    "optionc": "惯性定律",
    "optiond": "万有引力定律",
    "correct": "C",
    "explanation": "牛顿第一定律又称惯性定律，表述物体在没有外力作用时保持静止或匀速直线运动状态。选项A是牛顿第二定律，选项B是牛顿第三定律，选项D是万有引力定律。",
    "Tags": ["物理", "力学", "基础概念"]
  }',
  preview_back = '正确答案：C. 惯性定律\n\n解析：牛顿第一定律又称惯性定律，表述物体在没有外力作用时保持静止或匀速直线运动状态。',
  updated_at = datetime('now')
WHERE id = 'choice-card';
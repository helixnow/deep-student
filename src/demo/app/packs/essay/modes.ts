/**
 * 内置批阅模式（与 src-tauri/src/essay_grading/types.rs 的 get_builtin_grading_modes 同步；
 * 演示不发起批改，system_prompt 留空）。
 */
export interface DemoGradingMode {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: { name: string; max_score: number; description: string | null }[];
  total_max_score: number;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

const RAW: Omit<DemoGradingMode, 'system_prompt' | 'is_builtin' | 'created_at' | 'updated_at'>[] = [
  {
    "id": "gaokao",
    "name": "高考作文",
    "description": "按照高考作文评分标准进行批改，总分60分",
    "score_dimensions": [
      {
        "name": "内容",
        "max_score": 20.0,
        "description": "切题、中心、内容充实"
      },
      {
        "name": "表达",
        "max_score": 20.0,
        "description": "文体、结构、语言"
      },
      {
        "name": "发展等级",
        "max_score": 20.0,
        "description": "深刻/丰富/有文采/有创意"
      }
    ],
    "total_max_score": 60.0
  },
  {
    "id": "gaokao_en_short",
    "name": "高考英语小作文",
    "description": "高考英语应用文写作评分模式，总分15分",
    "score_dimensions": [
      {
        "name": "Content & Key Points",
        "max_score": 5.0,
        "description": "要点覆盖、内容充实度"
      },
      {
        "name": "Language Quality",
        "max_score": 5.0,
        "description": "词汇语法准确性与多样性"
      },
      {
        "name": "Format & Register",
        "max_score": 5.0,
        "description": "格式规范、语域得体"
      }
    ],
    "total_max_score": 15.0
  },
  {
    "id": "gaokao_en_long",
    "name": "高考英语大作文",
    "description": "高考英语读后续写评分模式，总分25分",
    "score_dimensions": [
      {
        "name": "Content & Context Coherence",
        "max_score": 10.0,
        "description": "内容创造、情境融洽度、逻辑性"
      },
      {
        "name": "Language Use",
        "max_score": 10.0,
        "description": "词汇多样性、语法准确性与复杂度"
      },
      {
        "name": "Cohesion & Structure",
        "max_score": 5.0,
        "description": "衔接手段、结构清晰度、意义连贯"
      }
    ],
    "total_max_score": 25.0
  },
  {
    "id": "ielts",
    "name": "雅思大作文",
    "description": "IELTS Writing Task 2（议论文）评分模式，总分9分",
    "score_dimensions": [
      {
        "name": "Task Response",
        "max_score": 9.0,
        "description": "Position, ideas, relevance, development"
      },
      {
        "name": "Coherence & Cohesion",
        "max_score": 9.0,
        "description": "Organisation, paragraphing, cohesive devices"
      },
      {
        "name": "Lexical Resource",
        "max_score": 9.0,
        "description": "Vocabulary range, accuracy, collocation"
      },
      {
        "name": "Grammatical Range & Accuracy",
        "max_score": 9.0,
        "description": "Sentence variety, grammar control, punctuation"
      }
    ],
    "total_max_score": 9.0
  },
  {
    "id": "ielts_task1",
    "name": "雅思小作文",
    "description": "IELTS Writing Task 1（Academic/General）评分模式，总分9分",
    "score_dimensions": [
      {
        "name": "Task Achievement",
        "max_score": 9.0,
        "description": "Overview, key features, data accuracy / purpose, tone"
      },
      {
        "name": "Coherence & Cohesion",
        "max_score": 9.0,
        "description": "Organisation, progression, cohesive devices"
      },
      {
        "name": "Lexical Resource",
        "max_score": 9.0,
        "description": "Vocabulary range, accuracy, collocation"
      },
      {
        "name": "Grammatical Range & Accuracy",
        "max_score": 9.0,
        "description": "Sentence variety, grammar control, punctuation"
      }
    ],
    "total_max_score": 9.0
  },
  {
    "id": "kaoyan",
    "name": "考研英语大作文",
    "description": "考研英语（一图画/二图表）Part B 评分模式，总分20分",
    "score_dimensions": [
      {
        "name": "Content & Task Fulfillment",
        "max_score": 8.0,
        "description": "Description + interpretation + commentary"
      },
      {
        "name": "Organization & Coherence",
        "max_score": 5.0,
        "description": "Structure, paragraphing, cohesive devices"
      },
      {
        "name": "Language & Accuracy",
        "max_score": 7.0,
        "description": "Vocabulary range, sentence variety, grammar"
      }
    ],
    "total_max_score": 20.0
  },
  {
    "id": "toefl",
    "name": "托福写作",
    "description": "TOEFL iBT Writing 评分模式（2026新版含Academic Discussion），总分5分",
    "score_dimensions": [
      {
        "name": "Content & Relevance",
        "max_score": 5.0,
        "description": "Topic address, task fulfillment, idea development"
      },
      {
        "name": "Organization & Coherence",
        "max_score": 5.0,
        "description": "Unity, progression, connection of ideas"
      },
      {
        "name": "Language Use",
        "max_score": 5.0,
        "description": "Syntactic variety, vocabulary, accuracy"
      }
    ],
    "total_max_score": 5.0
  },
  {
    "id": "zhongkao",
    "name": "中考作文",
    "description": "按照中考作文评分标准进行批改，总分50分",
    "score_dimensions": [
      {
        "name": "内容",
        "max_score": 20.0,
        "description": "切题、中心、选材、情感"
      },
      {
        "name": "表达",
        "max_score": 20.0,
        "description": "文体、结构、语言"
      },
      {
        "name": "创意",
        "max_score": 10.0,
        "description": "立意、构思、语言特色"
      }
    ],
    "total_max_score": 50.0
  },
  {
    "id": "cet",
    "name": "四六级作文",
    "description": "按照大学英语四六级作文评分标准进行批改，总分15分",
    "score_dimensions": [
      {
        "name": "Content & Relevance",
        "max_score": 5.0,
        "description": "Topic coverage, idea development"
      },
      {
        "name": "Organization",
        "max_score": 5.0,
        "description": "Structure, coherence, transitions"
      },
      {
        "name": "Language",
        "max_score": 5.0,
        "description": "Vocabulary range, grammar accuracy"
      }
    ],
    "total_max_score": 15.0
  },
  {
    "id": "practice",
    "name": "日常练习",
    "description": "宽松友好的批改模式，适合日常写作练习",
    "score_dimensions": [
      {
        "name": "创意与表达",
        "max_score": 40.0,
        "description": "想法、表达"
      },
      {
        "name": "内容完整",
        "max_score": 30.0,
        "description": "主题、论述"
      },
      {
        "name": "语言规范",
        "max_score": 30.0,
        "description": "用词、语句"
      }
    ],
    "total_max_score": 100.0
  }
];

export const DEMO_GRADING_MODES: DemoGradingMode[] = RAW.map((m) => ({
  ...m,
  system_prompt: '',
  is_builtin: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}));

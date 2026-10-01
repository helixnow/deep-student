/** UI registration. Schema-only consumers import ../blockSchemas instead. */
import { generativeUIRegistry } from '../registry';
import { BUILTIN_GENERATIVE_BLOCK_SCHEMAS } from '../blockSchemas';
import { StatCardBlock } from '../components/StatCardBlock';
import { AlertBlock } from '../components/AlertBlock';
import { ListBlock } from '../components/ListBlock';
import { ProgressBlock } from '../components/ProgressBlock';
import { ActionBarBlock } from '../components/ActionBarBlock';
import { TextBlock } from '../components/TextBlock';
import { KeyValueGridBlock } from '../components/KeyValueGridBlock';
import { FlashcardPreviewBlock } from '../components/FlashcardPreviewBlock';
import { ReviewCalendarBlock } from '../components/ReviewCalendarBlock';
import { MistakeAnalysisBlock } from '../components/MistakeAnalysisBlock';
import { MindmapEmbedBlock } from '../components/MindmapEmbedBlock';
import { PaperDigestBlock } from '../components/PaperDigestBlock';
import { ResearchPlanBlock } from '../components/ResearchPlanBlock';
import { ResearchReportBlock } from '../components/ResearchReportBlock';
import { MarkdownBlock } from '../components/MarkdownBlock';
import { ChartBlock } from '../components/ChartBlock';
import { StepsBlock } from '../components/StepsBlock';
import { TableBlock } from '../components/TableBlock';

const components = {
  'stat-card': StatCardBlock,
  'alert': AlertBlock,
  'list': ListBlock,
  'progress': ProgressBlock,
  'action-bar': ActionBarBlock,
  'text': TextBlock,
  'key-value-grid': KeyValueGridBlock,
  'flashcard-preview': FlashcardPreviewBlock,
  'review-calendar': ReviewCalendarBlock,
  'mistake-analysis': MistakeAnalysisBlock,
  'mindmap-embed': MindmapEmbedBlock,
  'paper-digest': PaperDigestBlock,
  'research-plan': ResearchPlanBlock,
  'research-report': ResearchReportBlock,
  'markdown': MarkdownBlock,
  'chart': ChartBlock,
  'steps': StepsBlock,
  'table': TableBlock,
};

for (const config of BUILTIN_GENERATIVE_BLOCK_SCHEMAS) {
  generativeUIRegistry.register({ ...config, component: components[config.type] });
}

export {
  StatCardBlock,
  AlertBlock,
  ListBlock,
  ProgressBlock,
  ActionBarBlock,
  TextBlock,
  KeyValueGridBlock,
  FlashcardPreviewBlock,
  ReviewCalendarBlock,
  MistakeAnalysisBlock,
  MindmapEmbedBlock,
  PaperDigestBlock,
  ResearchPlanBlock,
  ResearchReportBlock,
  MarkdownBlock,
  ChartBlock,
  StepsBlock,
  TableBlock,
};

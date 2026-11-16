/**
 * `studyData`：插件读写应用学习数据的稳定门面（B1）。
 *
 * 公开契约：社区插件 / 工坊作品在清单 `permissions` 里声明 `service:studyData` 后 `inject: ['studyData']` 使用；
 * 声明本身就是用户的授权，门面不再另设权限闸。
 *
 * 约定
 * - 输入输出都是纯 JSON（可以原样交给插件的界面半边），字段 camelCase，时间为 ISO 8601 字符串。
 * - 方法一律返回 Promise。
 * - `get` 找不到时返回 `null`；写操作找不到对象时抛 `STUDY_DATA_NOT_FOUND: …`。
 * - 参数不合法抛 `STUDY_DATA_INVALID: …`；对应的官方功能没有运行（如移动端没有某个模块）抛 `STUDY_DATA_UNAVAILABLE: …`。
 * - 写入没有落库等意外情况抛 `STUDY_DATA_FAILED: …`；官方服务自身的错误（如乐观锁冲突）原样抛出。
 * - 写操作与应用界面走同一条存储路径（同样的全文索引、修订号、变更事件），打开着的界面会自动刷新。
 * - `limit` 缺省 50，上限 200（题库上限 100，超出按上限截断）；`offset` 缺省 0。
 */

// ------------------------------------------------------------------ notes

/** 笔记摘要（不含正文）。 */
export interface StudyNote {
  id: string;
  title: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 带正文的笔记；`content` 是 Markdown。 */
export interface StudyNoteWithContent extends StudyNote {
  content: string;
}

/** 搜索命中：`excerpt` 是正文里命中词附近的一小段纯文本（找不到命中位置时为开头一段）。 */
export interface StudyNoteSearchHit extends StudyNote {
  excerpt: string;
}

export interface StudyNoteListOptions {
  /** 标题 / 正文关键词（全文索引，退回模糊匹配）。 */
  search?: string;
  /** 只列这个资料库文件夹里的笔记（`fld_…`）；与 `search` 互斥。 */
  folderId?: string;
  /** 只要在此时间（ISO 8601）之后修改过的笔记；结果按修改时间倒序。 */
  updatedSince?: string;
  limit?: number;
  offset?: number;
}

export interface StudyNoteCreateInput {
  title: string;
  /** Markdown 正文，缺省为空。 */
  content?: string;
  tags?: string[];
  /** 放进资料库的这个文件夹（`fld_…`）；缺省放在根目录。 */
  folderId?: string;
}

export interface StudyNoteUpdateInput {
  title?: string;
  /** 整体替换正文（Markdown）。 */
  content?: string;
  /** 整体替换标签。 */
  tags?: string[];
  /** 乐观锁：传入读到的 `updatedAt`，期间被别人改过则抛错而不覆盖。 */
  expectedUpdatedAt?: string;
}

export interface StudyNotesApi {
  /** 按修改时间倒序列出笔记（不含正文）。 */
  list(options?: StudyNoteListOptions): Promise<StudyNote[]>;
  /** 读取一篇笔记及正文；不存在或在回收站里返回 null。 */
  get(id: string): Promise<StudyNoteWithContent | null>;
  /** 按关键词搜索笔记标题与正文（全文索引，退回模糊匹配），返回带摘录的命中，按修改时间倒序。 */
  search(query: string, limit?: number): Promise<StudyNoteSearchHit[]>;
  /** 新建笔记。 */
  create(input: StudyNoteCreateInput): Promise<StudyNoteWithContent>;
  /** 修改标题 / 正文 / 标签（只改传入的字段）。 */
  update(id: string, patch: StudyNoteUpdateInput): Promise<StudyNoteWithContent>;
  /** 在正文末尾追加一段 Markdown（与原文之间空一行）；读到写之间被改过时抛错，不会丢失别人的修改。 */
  append(id: string, markdown: string): Promise<StudyNoteWithContent>;
}

// ------------------------------------------------------------------ cards

/** FSRS 卡片状态。 */
export type StudyCardState = 'new' | 'learning' | 'review' | 'relearning';

export interface StudyCardReview {
  /** 已进入复习队列。 */
  enqueued: boolean;
  suspended: boolean;
  /** 现在到期。 */
  due: boolean;
  /** 下次到期时间；未入队为 null。 */
  dueAt: string | null;
  state: StudyCardState | null;
  /** 复习队列里的卡片 id（`review.due` 的 `stateId`）；未入队为 null。 */
  stateId: string | null;
}

/** 卡片库里的一张卡。 */
export interface StudyCard {
  id: string;
  front: string;
  back: string;
  tags: string[];
  /** 制卡模板 id；普通问答卡为 null。 */
  templateId: string | null;
  /** 模板字段（如 `Front` / `Back` / `Text`）。 */
  fields: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  review: StudyCardReview;
}

/** 卡片库筛选：全部 / 到期 / 新卡 / 学习中 / 复习中 / 已暂停 / 未入队。 */
export type StudyCardStatusFilter = 'all' | 'due' | 'new' | 'learning' | 'review' | 'suspended' | 'notEnqueued';

export interface StudyCardListOptions {
  /** 正面 / 背面 / 标签关键词。 */
  search?: string;
  status?: StudyCardStatusFilter;
  /** 只列这个模板的卡。 */
  templateId?: string;
  limit?: number;
  offset?: number;
}

export interface StudyCardCreateInput {
  front: string;
  back: string;
  tags?: string[];
  /** 制卡模板 id；缺省为普通问答卡。 */
  templateId?: string;
  /** 额外的模板字段；`Front` / `Back` 缺省取 `front` / `back`。 */
  fields?: Record<string, string>;
  /** 建好后立刻加入复习队列（默认 true，否则新卡不会出现在到期队列里）。 */
  enqueue?: boolean;
}

export interface StudyCardsApi {
  /** 列出卡片库（与「卡片库」页面同一个查询）。 */
  list(options?: StudyCardListOptions): Promise<StudyCard[]>;
  /** 读取一张卡；不存在返回 null。 */
  get(id: string): Promise<StudyCard | null>;
  /** 在卡片库里新建一张卡（与卡片库「新建卡片」同一条路径），默认同时加入复习队列。 */
  create(input: StudyCardCreateInput): Promise<StudyCard>;
}

// ------------------------------------------------------------------ questions

/** 题目集（题库里的一套题）。 */
export interface StudyQuestionSet {
  id: string;
  title: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StudyQuestionType =
  | 'single_choice' | 'multiple_choice' | 'indefinite_choice' | 'fill_blank' | 'short_answer' | 'essay'
  | 'calculation' | 'proof' | 'true_false' | 'matching' | 'ordering' | 'numeric' | 'other';

export type StudyQuestionDifficulty = 'easy' | 'medium' | 'hard' | 'very_hard';

/** 做题状态：未做 / 练习中 / 已掌握 / 待复习。 */
export type StudyQuestionStatus = 'new' | 'in_progress' | 'mastered' | 'review';

export interface StudyQuestionOption {
  key: string;
  content: string;
}

export interface StudyQuestion {
  id: string;
  /** 所属题目集 id。 */
  setId: string;
  /** 题号（如 `3`、`2(1)`）。 */
  label: string | null;
  type: StudyQuestionType;
  /** 题干（Markdown）。 */
  content: string;
  options: StudyQuestionOption[];
  answer: string | null;
  explanation: string | null;
  difficulty: StudyQuestionDifficulty | null;
  tags: string[];
  status: StudyQuestionStatus;
  attemptCount: number;
  correctCount: number;
  lastAttemptAt: string | null;
  /** 最近一次作答是否正确；未作答为 null。 */
  lastCorrect: boolean | null;
  userNote: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StudyQuestionSetListOptions {
  /** 题目集名称关键词。 */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface StudyQuestionListOptions {
  /** 只列这个题目集；缺省时跨全部题目集。 */
  setId?: string;
  /** 题干 / 答案 / 解析关键词。 */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface StudyQuestionCreateInput {
  /** 放进哪个题目集（`questions.sets()` 的 id）。 */
  setId: string;
  /** 题干（Markdown）。 */
  content: string;
  type?: StudyQuestionType;
  options?: StudyQuestionOption[];
  answer?: string;
  explanation?: string;
  difficulty?: StudyQuestionDifficulty;
  tags?: string[];
  label?: string;
}

export interface StudyQuestionsApi {
  /** 列出题目集。 */
  sets(options?: StudyQuestionSetListOptions): Promise<StudyQuestionSet[]>;
  /** 列出题目：给 `setId` 按题目集顺序；只给 `search` 跨题目集全文搜索；都不给时按题目集逐个列出。 */
  list(options?: StudyQuestionListOptions): Promise<StudyQuestion[]>;
  /** 跨全部题目集全文搜索，按相关度排序。 */
  search(query: string, limit?: number): Promise<StudyQuestion[]>;
  /** 读取一道题；不存在返回 null。 */
  get(id: string): Promise<StudyQuestion | null>;
  /** 在已有题目集里新建一道题（来源记为手动录入）。 */
  create(input: StudyQuestionCreateInput): Promise<StudyQuestion>;
}

// ------------------------------------------------------------------ review

export interface StudyReviewStats {
  /** 复习队列里的卡片总数。 */
  total: number;
  /** 现在到期（含今天还能学的新卡）。 */
  due: number;
  newCount: number;
  learning: number;
  review: number;
  relearning: number;
  suspended: number;
  /** 今天已复习次数。 */
  reviewsToday: number;
  /** 今天还能学的新卡数（受每日上限约束）。 */
  newRemainingToday: number;
  /** 今天还能复习的数量（受每日上限约束）。 */
  reviewsRemainingToday: number;
}

/** 到期队列里的一张卡。 */
export interface StudyDueCard {
  /** 复习队列里的卡片 id。 */
  stateId: string;
  /** 卡片库里的卡片 id（`cards.get`）。 */
  cardId: string;
  front: string;
  back: string;
  state: StudyCardState;
  dueAt: string;
  lastReviewAt: string | null;
  reps: number;
  lapses: number;
}

export interface StudyReviewEnqueueResult {
  /** 新加入队列的数量。 */
  enqueued: number;
  /** 已在队列里或不存在而跳过的数量。 */
  skipped: number;
}

export interface StudyReviewApi {
  /** 复习概况（与复习页面顶部的数字同源）。 */
  stats(): Promise<StudyReviewStats>;
  /** 现在到期的卡片，按到期先后排序（只读，不改变调度）。 */
  due(options?: { limit?: number }): Promise<StudyDueCard[]>;
  /** 把卡片库里的卡加入复习队列（已在队列里的跳过）。 */
  enqueue(cardIds: string[]): Promise<StudyReviewEnqueueResult>;
}

// ------------------------------------------------------------------ todos

export type StudyTodoPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

/** 待办清单。 */
export interface StudyTodoList {
  id: string;
  title: string;
  /** 收件箱（默认清单）。 */
  isDefault: boolean;
}

/** 用户待办（「待办」页面里的一项）。 */
export interface StudyTodo {
  id: string;
  listId: string;
  title: string;
  /** 备注。 */
  note: string | null;
  done: boolean;
  priority: StudyTodoPriority;
  /** 截止日期 `YYYY-MM-DD`。 */
  dueDate: string | null;
  /** 截止时间 `HH:MM`。 */
  dueTime: string | null;
  tags: string[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudyTodoListOptions {
  /** 包含已完成的（默认 false）。 */
  includeDone?: boolean;
  /** 只列这个清单；缺省为全部清单。 */
  listId?: string;
  limit?: number;
}

export interface StudyTodoAddInput {
  title: string;
  note?: string;
  /** 截止日期 `YYYY-MM-DD`。 */
  dueDate?: string;
  /** 截止时间 `HH:MM`（需要同时给 `dueDate`）。 */
  dueTime?: string;
  priority?: StudyTodoPriority;
  tags?: string[];
  /** 放进哪个清单；缺省为收件箱。 */
  listId?: string;
}

export interface StudyTodosApi {
  /** 列出待办清单。 */
  lists(): Promise<StudyTodoList[]>;
  /** 列出待办（默认只含未完成的）。 */
  list(options?: StudyTodoListOptions): Promise<StudyTodo[]>;
  /** 按标题 / 备注搜索待办。 */
  search(query: string, limit?: number): Promise<StudyTodo[]>;
  /** 新建待办。 */
  add(input: StudyTodoAddInput): Promise<StudyTodo>;
  /** 标记完成（已完成的原样返回；重复任务会生成下一次）。 */
  complete(id: string): Promise<StudyTodo>;
}

// ------------------------------------------------------------------ resources

/** 资料库条目类型。 */
export type StudyResourceType =
  | 'folder' | 'note' | 'textbook' | 'exam' | 'translation' | 'essay' | 'image' | 'file' | 'mindmap';

/** 资料库里的一项（文件夹、笔记、教材、文件、题目集、翻译、作文、思维导图…）。 */
export interface StudyResource {
  id: string;
  type: StudyResourceType;
  title: string;
  /** 资料库路径（文件夹层级）。 */
  path: string;
  /** 文件大小（字节）；不适用为 null。 */
  size: number | null;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StudyResourceListOptions {
  /** 列这个文件夹（`fld_…`）的直接子项；缺省为根目录。 */
  folderId?: string;
  /** 只要这种类型；不给 `folderId` 时跨全部文件夹列出该类型。 */
  type?: StudyResourceType;
  limit?: number;
  offset?: number;
}

export interface StudyResourcesApi {
  /** 列出资料库（与资料库页面同一个查询）。 */
  list(options?: StudyResourceListOptions): Promise<StudyResource[]>;
  /** 按名称 / 内容搜索资料库。 */
  search(query: string, limit?: number): Promise<StudyResource[]>;
  /**
   * 读取一项的文本（与资料库「读取内容」同源）：笔记 / 翻译 / 作文 / 思维导图为原文，教材、文件与图片为提取 / 识别出的文字
   * （没有时为 `[文档: 文件名]`），题目集为题目预览。文件夹不能读取。
   */
  readText(id: string): Promise<string>;
}

// ------------------------------------------------------------------ service

/** `studyData` 服务。 */
export interface StudyDataService {
  readonly notes: StudyNotesApi;
  /** 卡片库（记忆卡片）。 */
  readonly cards: StudyCardsApi;
  /** 题库。 */
  readonly questions: StudyQuestionsApi;
  /** 卡片复习（FSRS）。 */
  readonly review: StudyReviewApi;
  /** 用户待办。 */
  readonly todos: StudyTodosApi;
  /** 资料库。 */
  readonly resources: StudyResourcesApi;
}

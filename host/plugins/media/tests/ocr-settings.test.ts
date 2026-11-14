import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import {
  LATEX_OUTPUT_BRIEF, LATEX_OUTPUT_BRIEF_EN, OcrSettingsError, SYSTEM_OCR_CONFIG_ID,
  addOcrEngine, engineInfoList, getAvailableOcrModels, getOcrEngines, getOcrPromptTemplate,
  getOcrThinkingEnabled, inferEngineFromModel, migrateGlmOcrModels, migratePaddleOcrModels,
  parseEngineType, parseOcrMode, removeOcrEngine, setOcrEngineType, systemOcrDisplayName,
  tryParseEngineType, updateOcrEnginePriority, validateModelForEngine, validateOcrModel,
  type OcrModelConfig,
} from '../src/ocr-settings.ts';

function settings(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    store: {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { values.set(key, value); },
    },
  };
}

function model(overrides: Partial<OcrModelConfig> = {}): OcrModelConfig {
  return {
    configId: 'cfg',
    model: 'm',
    engineType: 'generic_vlm',
    name: 'M',
    isFree: false,
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function storedModels(json: string): OcrModelConfig[] {
  return JSON.parse(json) as OcrModelConfig[];
}

it('engine catalogue keeps the Rust order and platform gate', () => {
  expect(engineInfoList(false).map(info => info.engineType)).toEqual([
    'deepseek_ocr', 'paddle_ocr_vl', 'paddle_ocr_vl_v1', 'glm4v_ocr', 'generic_vlm',
  ]);
  expect(engineInfoList(true).map(info => info.engineType)).toEqual([
    'deepseek_ocr', 'paddle_ocr_vl', 'paddle_ocr_vl_v1', 'glm4v_ocr', 'generic_vlm', 'system_ocr',
  ]);
  const paddle = engineInfoList(false).find(info => info.engineType === 'paddle_ocr_vl')!;
  expect(paddle.description).toBe('百度开源 OCR 视觉语言模型 1.5 版，支持 109 种语言，精度 94.5%，完全免费');
  expect(paddle.recommendedModel).toBe('PaddlePaddle/PaddleOCR-VL-1.5');
  expect(paddle.isFree).toBe(true);
  expect(paddle.supportsGrounding).toBe(false);
  const deepseek = engineInfoList(false).find(info => info.engineType === 'deepseek_ocr')!;
  expect(deepseek.supportsGrounding).toBe(true);
  expect(deepseek.isDedicatedOcr).toBe(true);
  expect(engineInfoList(false).find(info => info.engineType === 'glm4v_ocr')!.isDedicatedOcr).toBe(false);

  expect(getOcrEngines('linux').map(info => info.engineType)).not.toContain('system_ocr');
  const mac = getOcrEngines('darwin');
  expect(mac.map(info => info.engineType)).toContain('system_ocr');
  expect(mac.find(info => info.engineType === 'system_ocr')).toEqual({
    engineType: 'system_ocr',
    name: '系统 OCR',
    description: '调用操作系统内置 OCR 引擎，免费离线，无需 API Key',
    recommendedModel: 'system',
    supportsGrounding: false,
    isFree: true,
  });
  expect(systemOcrDisplayName('darwin')).toBe('系统 OCR (macOS Vision)');
  expect(systemOcrDisplayName('win32')).toBe('系统 OCR (Windows OCR)');
  expect(systemOcrDisplayName('linux')).toBe('系统 OCR');
});

it('engine type parsing accepts every Rust alias and falls back to paddle', () => {
  const aliases: Array<[string, string]> = [
    ['deepseek_ocr', 'deepseek_ocr'], ['deepseek-ocr', 'deepseek_ocr'], ['deepseek', 'deepseek_ocr'],
    ['paddle_ocr_vl', 'paddle_ocr_vl'], ['paddleocr-vl', 'paddle_ocr_vl'],
    ['paddleocr_vl', 'paddle_ocr_vl'], ['paddle', 'paddle_ocr_vl'],
    ['paddle_ocr_vl_v1', 'paddle_ocr_vl_v1'], ['paddleocr-vl-v1', 'paddle_ocr_vl_v1'],
    ['paddleocr_vl_v1', 'paddle_ocr_vl_v1'],
    ['glm4v_ocr', 'glm4v_ocr'], ['glm-4.6v', 'glm4v_ocr'], ['glm4v', 'glm4v_ocr'], ['glm-4v', 'glm4v_ocr'],
    ['generic_vlm', 'generic_vlm'], ['generic', 'generic_vlm'], ['vlm', 'generic_vlm'],
    ['system_ocr', 'system_ocr'], ['system', 'system_ocr'], ['native', 'system_ocr'],
    ['PADDLEOCR-VL', 'paddle_ocr_vl'],
  ];
  for (const [input, expected] of aliases) expect(tryParseEngineType(input), input).toBe(expected);
  // `PADDLE-OCR-VL` 小写后是 `paddle-ocr-vl`，不在 Rust 别名表里。
  expect(tryParseEngineType('PADDLE-OCR-VL')).toBeNull();
  expect(tryParseEngineType(' paddle_ocr_vl')).toBeNull();
  expect(tryParseEngineType('unknown')).toBeNull();
  expect(parseEngineType('unknown')).toBe('paddle_ocr_vl');
  expect(parseOcrMode('free')).toBe('free_ocr');
  expect(parseOcrMode('markdown')).toBe('free_ocr');
  expect(parseOcrMode(' FREE_OCR ')).toBe('grounding');
  expect(parseOcrMode('unknown')).toBe('grounding');
});

it('model validation and inference follow the Rust regexes', () => {
  expect(validateModelForEngine('deepseek-ai/DeepSeek-OCR', 'deepseek_ocr')).toBe(true);
  expect(validateModelForEngine('DeepSeek-V3', 'deepseek_ocr')).toBe(false);
  expect(validateModelForEngine('PaddlePaddle/PaddleOCR-VL-1.5', 'paddle_ocr_vl')).toBe(true);
  expect(validateModelForEngine('PaddlePaddle/PaddleOCR-VL', 'paddle_ocr_vl_v1')).toBe(true);
  expect(validateModelForEngine('paddle-vl', 'paddle_ocr_vl')).toBe(false);
  expect(validateModelForEngine('zai-org/GLM-4.6V', 'glm4v_ocr')).toBe(true);
  expect(validateModelForEngine('zai-org/GLM-4.1V', 'glm4v_ocr')).toBe(false);
  expect(validateModelForEngine('GLM-5V', 'glm4v_ocr')).toBe(true);
  expect(validateModelForEngine('GLM-5.1V', 'glm4v_ocr')).toBe(true);
  expect(validateModelForEngine('anything', 'generic_vlm')).toBe(true);
  expect(validateModelForEngine('system', 'system_ocr')).toBe(true);
  expect(validateModelForEngine('', 'system_ocr')).toBe(true);
  expect(validateModelForEngine('system ocr', 'system_ocr')).toBe(false);

  expect(inferEngineFromModel('system')).toBe('system_ocr');
  expect(inferEngineFromModel('zai-org/GLM-4.6V')).toBe('glm4v_ocr');
  expect(inferEngineFromModel('deepseek-ai/DeepSeek-OCR')).toBe('deepseek_ocr');
  expect(inferEngineFromModel('PaddlePaddle/PaddleOCR-VL-1.5')).toBe('paddle_ocr_vl');
  expect(inferEngineFromModel('paddleocr_vl_15')).toBe('paddle_ocr_vl');
  expect(inferEngineFromModel('PaddlePaddle/PaddleOCR-VL')).toBe('paddle_ocr_vl_v1');
  expect(inferEngineFromModel('Qwen/Qwen2.5-VL-7B-Instruct')).toBe('generic_vlm');

  expect(validateOcrModel('deepseek-chat', 'deepseek_ocr')).toEqual({
    isValid: false, recommendedModel: 'deepseek-ai/DeepSeek-OCR',
  });
  expect(validateOcrModel('deepseek-ai/DeepSeek-OCR', 'deepseek_ocr')).toEqual({
    isValid: true, recommendedModel: null,
  });
  // 未知引擎按 `from_str` 回退到 PaddleOCR-VL。
  expect(validateOcrModel('Qwen/Qwen2.5-VL-7B-Instruct', 'unknown')).toEqual({
    isValid: false, recommendedModel: 'PaddlePaddle/PaddleOCR-VL-1.5',
  });
});

it('prompt templates reproduce every adapter', () => {
  expect(getOcrPromptTemplate('deepseek_ocr', 'grounding'))
    .toBe('<|grounding|>Convert the document to markdown.');
  expect(getOcrPromptTemplate('deepseek_ocr', 'free_ocr')).toBe('Free OCR.');
  expect(getOcrPromptTemplate('deepseek_ocr', 'formula')).toBe('Parse the figure.');
  expect(getOcrPromptTemplate('deepseek_ocr', 'table'))
    .toBe('<|grounding|>Convert the document to markdown.');
  expect(getOcrPromptTemplate('deepseek_ocr', 'chart')).toBe('Parse the figure.');

  for (const engine of ['paddle_ocr_vl', 'paddle_ocr_vl_v1']) {
    expect(getOcrPromptTemplate(engine, 'grounding'), engine).toBe('OCR:');
    expect(getOcrPromptTemplate(engine, 'free_ocr'), engine).toBe('OCR:');
    expect(getOcrPromptTemplate(engine, 'formula'), engine).toBe('Formula Recognition:');
    expect(getOcrPromptTemplate(engine, 'table'), engine).toBe('Table Recognition:');
    expect(getOcrPromptTemplate(engine, 'chart'), engine).toBe('Chart Recognition:');
  }

  expect(getOcrPromptTemplate('glm4v_ocr', 'free_ocr'))
    .toBe(`请将图片中的所有文本内容转换为 Markdown 格式，保持原有排版结构。${LATEX_OUTPUT_BRIEF}`);
  expect(getOcrPromptTemplate('glm4v_ocr', 'grounding'))
    .toBe(`请识别图片中的所有文本区域，输出每个区域的文本内容和位置坐标 bbox_2d [x1,y1,x2,y2]。${LATEX_OUTPUT_BRIEF}`);
  expect(getOcrPromptTemplate('glm4v_ocr', 'formula'))
    .toBe(`请提取图片中的所有数学公式，转换为 LaTeX 格式输出。${LATEX_OUTPUT_BRIEF}`);
  expect(getOcrPromptTemplate('glm4v_ocr', 'table')).toBe('请提取图片中的表格，转换为 Markdown 表格格式输出。');
  expect(getOcrPromptTemplate('glm4v_ocr', 'chart')).toBe('请分析图片中的图表，详细描述其内容、数据和趋势。');

  expect(getOcrPromptTemplate('generic_vlm', 'grounding'))
    .toBe('Convert the document to markdown. Preserve the structure and formatting as much as possible. '
      + LATEX_OUTPUT_BRIEF_EN);
  expect(getOcrPromptTemplate('generic_vlm', 'free_ocr'))
    .toBe('Convert the document to markdown. Preserve the structure and formatting as much as possible. '
      + LATEX_OUTPUT_BRIEF_EN);
  expect(getOcrPromptTemplate('generic_vlm', 'formula'))
    .toBe('Extract and convert all mathematical formulas in the image to LaTeX format. '
      + LATEX_OUTPUT_BRIEF_EN);
  expect(getOcrPromptTemplate('generic_vlm', 'table'))
    .toBe('Extract the table from the image and convert it to markdown table format.');
  expect(getOcrPromptTemplate('generic_vlm', 'chart'))
    .toBe('Analyze the chart in the image and describe its content in detail.');
  expect(getOcrPromptTemplate('system_ocr', 'free_ocr')).toBe('');

  // `from_str` 不做 trim：带空白的引擎名回退到 paddle，模式回退到 grounding。
  expect(getOcrPromptTemplate(' deepseek_ocr', 'grounding')).toBe('OCR:');
  expect(getOcrPromptTemplate('glm4v_ocr', 'free_ocr '))
    .toBe(`请识别图片中的所有文本区域，输出每个区域的文本内容和位置坐标 bbox_2d [x1,y1,x2,y2]。${LATEX_OUTPUT_BRIEF}`);
});

it('paddle migration rewrites legacy names but keeps explicit v1 entries', () => {
  const legacy = model({
    model: 'PaddlePaddle/PaddleOCR-VL',
    engineType: 'paddle_ocr_vl',
    name: 'PaddleOCR-VL (PaddleOCR-VL)',
  });
  expect(migratePaddleOcrModels([legacy])).toBe(true);
  expect(legacy.model).toBe('PaddlePaddle/PaddleOCR-VL-1.5');
  expect(legacy.name).toBe('PaddleOCR-VL-1.5 (PaddleOCR-VL-1.5)');

  const explicitV1 = model({
    model: 'PaddlePaddle/PaddleOCR-VL',
    engineType: 'paddle_ocr_vl_v1',
    name: 'PaddleOCR-VL',
  });
  expect(migratePaddleOcrModels([explicitV1])).toBe(false);
  expect(explicitV1.model).toBe('PaddlePaddle/PaddleOCR-VL');

  const alreadyNewer = model({
    model: 'PaddlePaddle/PaddleOCR-VL',
    engineType: 'paddle_ocr_vl',
    name: 'PaddleOCR-VL 1.5',
  });
  expect(migratePaddleOcrModels([alreadyNewer])).toBe(true);
  expect(alreadyNewer.model).toBe('PaddlePaddle/PaddleOCR-VL-1.5');
  expect(alreadyNewer.name).toBe('PaddleOCR-VL 1.5');

  const untouched = model({ model: 'PaddlePaddle/PaddleOCR-VL-1.5', engineType: 'paddle_ocr_vl' });
  expect(migratePaddleOcrModels([untouched])).toBe(false);
});

it('GLM-4.1V migration follows the provider routing', () => {
  const siliconflow = model({
    configId: 'sf', model: 'zai-org/GLM-4.1V-9B-Thinking', engineType: 'glm4v_ocr',
    name: 'GLM-4.1V thinking / glm-4.1v',
  });
  expect(migrateGlmOcrModels([siliconflow], id => id === 'sf', () => false)).toBe(true);
  expect(siliconflow.model).toBe('Qwen/Qwen3-VL-8B-Instruct');
  expect(siliconflow.engineType).toBe('generic_vlm');
  expect(siliconflow.name).toBe('GLM-Qwen3-VL-8B thinking / glm-Qwen3-VL-8B');

  const zhipu = model({
    configId: 'zp', model: 'glm-4.1v', engineType: 'glm4v_ocr', name: 'GLM-4.1V',
  });
  expect(migrateGlmOcrModels([zhipu], () => false, id => id === 'zp')).toBe(true);
  expect(zhipu.model).toBe('glm-4.6v');
  expect(zhipu.engineType).toBe('glm4v_ocr');
  expect(zhipu.name).toBe('GLM-GLM-4.6V');

  const unknownProvider = model({
    configId: 'other', model: 'glm-4.1v', engineType: 'glm4v_ocr', name: 'x',
  });
  expect(migrateGlmOcrModels([unknownProvider], () => false, () => false)).toBe(false);
  expect(unknownProvider.model).toBe('glm-4.1v');
  expect(unknownProvider.name).toBe('x');

  const otherEngine = model({ model: 'glm-4.1v', engineType: 'generic_vlm' });
  expect(migrateGlmOcrModels([otherEngine], () => true, () => true)).toBe(false);
});

it('available models bootstrap the system engine only on supported platforms', async () => {
  const { values, store } = settings();
  const darwin = await getAvailableOcrModels(store, null, 'darwin');
  expect(darwin).toEqual([{
    configId: SYSTEM_OCR_CONFIG_ID,
    model: 'system',
    engineType: 'system_ocr',
    name: '系统 OCR (macOS Vision)',
    isFree: true,
    enabled: true,
    priority: 0,
    description: '调用操作系统内置 OCR 引擎，免费离线，无需 API Key',
    supportsGrounding: false,
  }]);
  expect(storedModels(values.get('ocr.available_models')!)).toEqual([{
    configId: SYSTEM_OCR_CONFIG_ID, model: 'system', engineType: 'system_ocr',
    name: '系统 OCR (macOS Vision)', isFree: true, enabled: true, priority: 0,
  }]);

  const empty = settings();
  expect(await getAvailableOcrModels(empty.store, null, 'linux')).toEqual([]);
  expect(empty.values.has('ocr.available_models')).toBe(false);
});

it('available models migrate, prune and inject in the Rust order', async () => {
  const { values, store } = settings({
    'ocr.available_models': JSON.stringify([
      model({ configId: 'orphan', engineType: 'generic_vlm', priority: 0 }),
      model({ configId: 'keep', engineType: 'paddle_ocr_vl', priority: 1 }),
      model({
        configId: 'zhipu', model: 'GLM-4.1V-9B-Thinking', engineType: 'glm4v_ocr',
        name: 'GLM 4.1V', priority: 2,
      }),
    ]),
  });
  const llm = {
    getApiConfigs: async () => [
      { id: 'keep', baseUrl: 'https://api.example.com/v1', model: 'PaddlePaddle/PaddleOCR-VL-1.5' },
      { id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v' },
    ],
  };
  const models = await getAvailableOcrModels(store, llm, 'darwin');
  expect(models.map(entry => entry.configId)).toEqual(['keep', 'zhipu', SYSTEM_OCR_CONFIG_ID]);
  expect(models.map(entry => entry.priority)).toEqual([0, 1, 2]);
  expect(models[1]).toMatchObject({ model: 'glm-4.6v', engineType: 'glm4v_ocr', name: 'GLM GLM-4.6V' });
  expect(models[1]!.description).toBe('智谱 106B MoE 多模态模型，支持 bbox_2d 坐标输出，题目集导入优先引擎');
  expect(models[2]).toMatchObject({ name: '系统 OCR (macOS Vision)', priority: 2 });

  const saved = storedModels(values.get('ocr.available_models')!);
  expect(saved.map(entry => entry.configId)).toEqual(['keep', 'zhipu', SYSTEM_OCR_CONFIG_ID]);
  expect(saved.map(entry => entry.priority)).toEqual([0, 1, 2]);
});

it('available models prune orphans and discontinued providers but keep exact engine keys', async () => {
  const { values, store } = settings({
    'ocr.available_models': JSON.stringify([
      model({ configId: 'alias', engineType: 'paddle', priority: 0 }),
      model({ configId: 'gone', engineType: 'generic_vlm', priority: 1 }),
      model({ configId: 'sf', engineType: 'glm4v_ocr', priority: 2 }),
    ]),
  });
  const llm = {
    getApiConfigs: async () => [
      { id: 'alias', baseUrl: 'https://api.example.com/v1', model: 'anything' },
      { id: 'sf', baseUrl: 'https://api.siliconflow.cn/v1', model: 'zai-org/GLM-4.6V' },
    ],
  };
  const models = await getAvailableOcrModels(store, llm, 'linux');
  expect(models).toEqual([{
    configId: 'alias',
    model: 'm',
    engineType: 'paddle',
    name: 'M',
    isFree: false,
    description: null,
    supportsGrounding: false,
    enabled: true,
    priority: 0,
  }]);
  expect(storedModels(values.get('ocr.available_models')!).map(entry => entry.configId)).toEqual(['alias']);

  // LLM 读取失败时保留列表（Rust 的 `if let Ok` 分支），但仍执行迁移与系统注入。
  const failure = settings({
    'ocr.available_models': JSON.stringify([model({ configId: 'x', engineType: 'generic_vlm' })]),
  });
  const failed = await getAvailableOcrModels(failure.store, {
    getApiConfigs: async () => { throw new Error('llm offline'); },
  }, 'linux');
  expect(failed.map(entry => entry.configId)).toEqual(['x']);
});

it('add_ocr_engine infers, rejects duplicates and honours discontinued models', async () => {
  const { values, store } = settings({
    'ocr.available_models': JSON.stringify([
      model({ configId: 'old', model: 'PaddlePaddle/PaddleOCR-VL', engineType: 'paddle_ocr_vl', priority: 4 }),
    ]),
  });
  await addOcrEngine(store, null, 'new', 'Qwen/Qwen2.5-VL-7B-Instruct', 'Qwen', null, 'linux');
  let saved = storedModels(values.get('ocr.available_models')!);
  expect(saved[1]).toEqual({
    configId: 'new', model: 'Qwen/Qwen2.5-VL-7B-Instruct', engineType: 'generic_vlm',
    name: 'Qwen', isFree: false, enabled: true, priority: 5,
  });

  await addOcrEngine(store, null, 'paddle', 'PaddlePaddle/PaddleOCR-VL-1.5', 'Paddle', 'paddle', 'linux');
  saved = storedModels(values.get('ocr.available_models')!);
  expect(saved[2]).toMatchObject({ engineType: 'paddle', isFree: true, priority: 6 });

  await expect(addOcrEngine(store, null, 'new', 'x', 'x', null, 'linux')).rejects.toMatchObject({
    kind: 'validation', message: '该模型已在 OCR 引擎列表中',
  });
  await expect(addOcrEngine(store, null, SYSTEM_OCR_CONFIG_ID, 'x', 'x', null, 'linux')).rejects.toMatchObject({
    kind: 'validation', message: '系统 OCR 引擎由系统自动管理，无需手动添加',
  });

  const discontinued = settings();
  await expect(addOcrEngine(discontinued.store, {
    getApiConfigs: async () => [
      { id: 'sf', baseUrl: 'https://api.siliconflow.cn/v1', model: 'zai-org/GLM-4.6V' },
    ],
  }, 'sf', 'zai-org/GLM-4.6V', 'GLM', 'glm4v_ocr', 'linux')).rejects.toMatchObject({
    kind: 'validation',
    message: '模型 zai-org/GLM-4.6V 已被服务商停服（硅基流动已下架 zai-org/GLM-4.6V），无法添加为 OCR 引擎',
  });
  expect(discontinued.values.has('ocr.available_models')).toBe(false);

  // LLM 读取失败时沿用 `if let Ok` 的忽略语义。
  const offline = settings();
  await addOcrEngine(offline.store, {
    getApiConfigs: async () => { throw new Error('offline'); },
  }, 'cfg', 'm', 'M', null, 'linux');
  expect(storedModels(offline.values.get('ocr.available_models')!)[0]!.priority).toBe(1);
});

it('remove_ocr_engine renumbers and rejects the system engine or missing ids', () => {
  const { values, store } = settings({
    'ocr.available_models': JSON.stringify([
      model({ configId: 'a', priority: 0 }),
      model({ configId: 'b', priority: 1 }),
      model({ configId: 'c', priority: 2 }),
    ]),
  });
  removeOcrEngine(store, 'b');
  expect(storedModels(values.get('ocr.available_models')!)).toEqual([
    model({ configId: 'a', priority: 0 }),
    model({ configId: 'c', priority: 1 }),
  ]);
  expect(() => removeOcrEngine(store, SYSTEM_OCR_CONFIG_ID)).toThrowError(
    '系统 OCR 引擎由系统自动管理，无法删除');
  expect(() => removeOcrEngine(store, 'missing')).toThrowError('未找到该 OCR 引擎');

  const broken = settings({ 'ocr.available_models': '{' });
  expect(() => removeOcrEngine(broken.store, 'a')).toThrowError(OcrSettingsError);
  expect(() => removeOcrEngine(broken.store, 'a')).toThrowError(/^解析 OCR 模型配置失败: /);
});

it('update_ocr_engine_priority applies order/enabled and ignores unknown ids', () => {
  const { values, store } = settings({
    'ocr.available_models': JSON.stringify([
      model({ configId: 'a', priority: 0, enabled: true }),
      model({ configId: 'b', priority: 1, enabled: true }),
      model({ configId: 'c', priority: 2, enabled: true }),
    ]),
  });
  updateOcrEnginePriority(store, [
    { configId: 'b', enabled: false },
    { configId: 'missing', enabled: false },
    { configId: 'a', enabled: true },
  ]);
  expect(storedModels(values.get('ocr.available_models')!)).toEqual([
    model({ configId: 'b', priority: 0, enabled: false }),
    model({ configId: 'a', priority: 2, enabled: true }),
    model({ configId: 'c', priority: 2, enabled: true }),
  ]);

  updateOcrEnginePriority(store, []);
  expect(storedModels(values.get('ocr.available_models')!).map(entry => entry.configId))
    .toEqual(['b', 'a', 'c']);
});

it('set_ocr_engine_type validates strictly and stores the canonical id', () => {
  const { values, store } = settings();
  setOcrEngineType(store, 'PaddleOCR-VL');
  expect(values.get('ocr.engine_type')).toBe('paddle_ocr_vl');
  setOcrEngineType(store, 'glm-4.6v');
  expect(values.get('ocr.engine_type')).toBe('glm4v_ocr');
  expect(() => setOcrEngineType(store, 'nope')).toThrowError(
    "Unknown OCR engine type: 'nope'. Valid types: deepseek_ocr, paddle_ocr_vl, paddle_ocr_vl_v1, generic_vlm");
  expect(() => setOcrEngineType(store, ' nope ')).toThrowError(
    "Unknown OCR engine type: ' nope '. Valid types: deepseek_ocr, paddle_ocr_vl, paddle_ocr_vl_v1, generic_vlm");
});

it('OCR thinking flag mirrors the Rust lowercase comparison', () => {
  expect(getOcrThinkingEnabled(settings().store)).toBe(false);
  expect(getOcrThinkingEnabled(settings({ 'ocr.enable_thinking': 'TRUE' }).store)).toBe(true);
  expect(getOcrThinkingEnabled(settings({ 'ocr.enable_thinking': ' true ' }).store)).toBe(false);
  expect(getOcrThinkingEnabled(settings({ 'ocr.enable_thinking': '1' }).store)).toBe(false);
  expect(getOcrThinkingEnabled({ get() { throw new Error('db'); }, save() {} })).toBe(false);
});

it('registers the OCR management commands with AppError mapping', async () => {
  const { values, store } = settings();
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: store, paths: { appDataDir: process.cwd() } },
    app: { platform: 'darwin' },
  });
  try {
    expect(await host.invoke('get_ocr_engines')).toContainEqual({
      engineType: 'system_ocr',
      name: '系统 OCR',
      description: '调用操作系统内置 OCR 引擎，免费离线，无需 API Key',
      recommendedModel: 'system',
      supportsGrounding: false,
      isFree: true,
    });
    expect(await host.invoke('get_ocr_thinking_enabled')).toBe(false);
    values.set('ocr.enable_thinking', 'true');
    expect(await host.invoke('get_ocr_thinking_enabled')).toBe(true);
    expect(await host.invoke('get_ocr_prompt_template', { engineType: 'deepseek_ocr', mode: 'free_ocr' }))
      .toBe('Free OCR.');
    expect(await host.invoke('infer_ocr_engine_from_model', { model: 'zai-org/GLM-4.6V' }))
      .toBe('glm4v_ocr');
    expect(await host.invoke('validate_ocr_model', { model: 'glm-4.1v', engineType: 'glm4v_ocr' }))
      .toEqual({ isValid: false, recommendedModel: 'zai-org/GLM-4.6V' });

    expect(await host.invoke('set_ocr_engine_type', { engineType: 'paddleocr-vl' })).toBe(true);
    expect(values.get('ocr.engine_type')).toBe('paddle_ocr_vl');
    await expect(host.invoke('set_ocr_engine_type', { engineType: 'bad' })).rejects.toEqual({
      error_type: 'Validation',
      message: "Unknown OCR engine type: 'bad'. Valid types: deepseek_ocr, paddle_ocr_vl, paddle_ocr_vl_v1, generic_vlm",
      details: null,
    });

    expect(await host.invoke('get_available_ocr_models')).toEqual([{
      configId: SYSTEM_OCR_CONFIG_ID,
      model: 'system',
      engineType: 'system_ocr',
      name: '系统 OCR (macOS Vision)',
      isFree: true,
      description: '调用操作系统内置 OCR 引擎，免费离线，无需 API Key',
      supportsGrounding: false,
      enabled: true,
      priority: 0,
    }]);
    expect(await host.invoke('add_ocr_engine', {
      configId: 'cfg', model: 'PaddlePaddle/PaddleOCR-VL-1.5', name: 'Paddle',
    })).toBe(true);
    expect(await host.invoke('add_ocr_engine', {
      configId: 'cfg2', model: 'Qwen/Qwen2.5-VL-7B-Instruct', name: 'Qwen', engineType: 'generic_vlm',
    })).toBe(true);
    expect(await host.invoke('update_ocr_engine_priority', { engineList: [
      { configId: 'cfg2', enabled: false },
      { configId: 'cfg', enabled: true },
      { configId: SYSTEM_OCR_CONFIG_ID, enabled: true },
    ] })).toBe(true);
    expect(storedModels(values.get('ocr.available_models')!)).toEqual([
      model({ configId: 'cfg2', model: 'Qwen/Qwen2.5-VL-7B-Instruct', engineType: 'generic_vlm',
        name: 'Qwen', priority: 0, enabled: false }),
      model({ configId: 'cfg', model: 'PaddlePaddle/PaddleOCR-VL-1.5', engineType: 'paddle_ocr_vl',
        name: 'Paddle', isFree: true, priority: 1 }),
      model({ configId: SYSTEM_OCR_CONFIG_ID, model: 'system', engineType: 'system_ocr',
        name: '系统 OCR (macOS Vision)', isFree: true, priority: 2 }),
    ]);
    expect(await host.invoke('remove_ocr_engine', { configId: 'cfg2' })).toBe(true);
    await expect(host.invoke('remove_ocr_engine', { configId: 'missing' })).rejects.toEqual({
      error_type: 'Validation', message: '未找到该 OCR 引擎', details: null,
    });
  } finally { await host.dispose(); }
});

it('maps database failures from the OCR model commands', async () => {
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: {
    get() { throw new Error('db failure'); }, save() { throw new Error('db failure'); },
  }, paths: { appDataDir: process.cwd() } } });
  try {
    await expect(host.invoke('get_available_ocr_models')).rejects.toEqual({
      error_type: 'Database', message: '读取 OCR 模型配置失败: db failure', details: null,
    });
    await expect(host.invoke('add_ocr_engine', {
      configId: 'cfg', model: 'm', name: 'M',
    })).rejects.toEqual({
      error_type: 'Database', message: '读取 OCR 模型配置失败: db failure', details: null,
    });
    await expect(host.invoke('set_ocr_engine_type', { engineType: 'paddle_ocr_vl' })).rejects.toEqual({
      error_type: 'Database', message: '保存 OCR 引擎配置失败: db failure', details: null,
    });
  } finally { await host.dispose(); }
});

it('uses llm@1 configurations for discontinued models when provided', async () => {
  const { store } = settings({
    'ocr.available_models': JSON.stringify([
      model({ configId: 'sf', engineType: 'glm4v_ocr', priority: 0 }),
      model({ configId: 'keep', engineType: 'generic_vlm', priority: 1 }),
    ]),
  });
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: store,
      llm: {
        getApiConfigs: async () => [
          { id: 'sf', baseUrl: 'https://api.siliconflow.cn/v1', model: 'zai-org/GLM-4.6V' },
          { id: 'sf-new', baseUrl: 'https://api.siliconflow.cn/v1', model: 'zai-org/GLM-4.6V' },
          { id: 'keep', baseUrl: 'https://api.example.com/v1', model: 'Qwen/Qwen2.5-VL-7B-Instruct' },
        ],
      },
      paths: { appDataDir: process.cwd() },
    },
    app: { platform: 'linux' },
  });
  try {
    expect(await host.invoke('get_available_ocr_models')).toEqual([{
      configId: 'keep',
      model: 'm',
      engineType: 'generic_vlm',
      name: 'M',
      isFree: false,
      description: '使用通用 VLM 进行 OCR，适合简单文档识别',
      supportsGrounding: false,
      enabled: true,
      priority: 0,
    }]);
    await expect(host.invoke('add_ocr_engine', {
      configId: 'sf-new', model: 'zai-org/GLM-4.6V', name: 'GLM', engineType: 'glm4v_ocr',
    })).rejects.toEqual({
      error_type: 'Validation',
      message: '模型 zai-org/GLM-4.6V 已被服务商停服（硅基流动已下架 zai-org/GLM-4.6V），无法添加为 OCR 引擎',
      details: null,
    });
    await expect(host.invoke('add_ocr_engine', {
      configId: 'keep', model: 'Qwen/Qwen2.5-VL-7B-Instruct', name: 'Qwen',
    })).rejects.toEqual({
      error_type: 'Validation',
      message: '该模型已在 OCR 引擎列表中',
      details: null,
    });
  } finally { await host.dispose(); }
});

it('R1-MD-06 get_available_ocr_models logs the src/cmd/ocr.rs:172,217,239,261 info lines', async () => {
  const { values, store } = settings({
    'ocr.available_models': JSON.stringify([
      { configId: 'p', model: 'PaddlePaddle/PaddleOCR-VL', engineType: 'paddle_ocr_vl', name: 'PaddleOCR-VL', isFree: true, enabled: true, priority: 0 },
      { configId: 'gone', model: 'm', engineType: 'generic_vlm', name: 'Gone', isFree: false, enabled: true, priority: 1 },
      { configId: 'sf46', model: 'zai-org/GLM-4.6V', engineType: 'glm4v_ocr', name: 'GLM', isFree: false, enabled: true, priority: 2 },
    ]),
  });
  const llm = {
    getApiConfigs: async () => [
      { id: 'p', baseUrl: 'https://paddle.example', model: 'PaddlePaddle/PaddleOCR-VL-1.5' },
      { id: 'sf46', baseUrl: 'https://api.siliconflow.cn/v1', model: 'zai-org/GLM-4.6V' },
    ],
  };
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: store, llm, paths: { appDataDir: process.cwd() } },
    app: { platform: 'darwin' },
  });
  const lines: string[] = [];
  const stop = host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.name === 'media.ocr' && message.type === 'info') lines.push(String(message.args[0]));
    },
  });
  try {
    const models = await host.invoke('get_available_ocr_models') as Array<{ configId: string; model: string }>;
    expect(models.map(model => [model.configId, model.model])).toEqual([
      ['p', 'PaddlePaddle/PaddleOCR-VL-1.5'], [SYSTEM_OCR_CONFIG_ID, 'system'],
    ]);
    expect(lines).toEqual([
      '[OCR] 已自动迁移 PaddleOCR-VL 配置到 1.5 版本',
      '[OCR] 已清理 1 个孤儿 OCR 引擎（对应 API 配置已删除）',
      '[OCR] 已清理 1 个已停服的 OCR 引擎（对应模型已下架）',
      '[OCR] 已自动注入系统 OCR 引擎',
    ]);
    expect(JSON.parse(values.get('ocr.available_models')!)).toHaveLength(2);
  } finally {
    stop();
    await host.dispose();
  }
});

it('R1-MD-06 model inference uses the L01 factory (Rust regex \\d is Unicode Nd)', () => {
  expect(inferEngineFromModel('glm-4.\u0665\u0666v')).toBe('glm4v_ocr');
  expect(validateModelForEngine('glm-4.\u0665\u0666v', 'glm4v_ocr')).toBe(true);
});

it('ocr.available_models is decoded like serde_json::from_str::<Vec<OcrModelConfig>> (errors carry serde text and position)', async () => {
  const message = async (json: string) => getAvailableOcrModels(settings({ 'ocr.available_models': json }).store, null, 'linux')
    .then(() => null, (error: unknown) => (error as OcrSettingsError).message);
  // G3 ocr.config.malformed_setting step 1 (Rust A side).
  expect(await message('{not json')).toBe('解析 OCR 模型配置失败: invalid type: map, expected a sequence at line 1 column 0');
  expect(await message('[{"configId":"a","model":"m","engineType":"generic_vlm"}]'))
    .toBe('解析 OCR 模型配置失败: missing field `name` at line 1 column 56');
  expect(await message('[{"configId":"a","configId":"b"}]'))
    .toBe('解析 OCR 模型配置失败: duplicate field `configId` at line 1 column 27');
  expect(await message('[{"configId":"a","model":"m","engineType":"generic_vlm","name":"n","priority":1.5}]'))
    .toBe('解析 OCR 模型配置失败: invalid type: floating point `1.5`, expected u32 at line 1 column 81');
  expect(await message('[1]')).toBe('解析 OCR 模型配置失败: invalid type: integer `1`, expected struct OcrModelConfig at line 1 column 2');
  expect(await message('[] x')).toBe('解析 OCR 模型配置失败: trailing characters at line 1 column 4');
  expect(await message('[["a","m","generic_vlm"]]'))
    .toBe('解析 OCR 模型配置失败: invalid length 3, expected struct OcrModelConfig with 7 elements at line 1 column 24');
  // Unknown fields are ignored and the derive defaults apply; the sequence form is accepted too.
  const models = await getAvailableOcrModels(settings({
    'ocr.available_models': '[{"configId":"a","model":"m","engineType":"generic_vlm","name":"n","extra":[1,{"x":null}]},["b","m2","generic_vlm","n2",true]]',
  }).store, null, 'linux');
  expect(models.map(m => [m.configId, m.isFree, m.enabled, m.priority])).toEqual([['a', false, true, 0], ['b', true, true, 0]]);
});

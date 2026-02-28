import fs from 'fs';
import path from 'path';

const REGISTRY_PATH = path.resolve(process.cwd(), 'scripts', 'model-capability-registry.json');
const RELEASE_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/;

const modelIdSet = new Map();
const errors = [];
const warnings = [];

const addError = (pathKey, message) => {
  errors.push(`[${pathKey}] ${message}`);
};

const addWarning = (pathKey, message) => {
  warnings.push(`[${pathKey}] ${message}`);
};

const ensure = (condition, pathKey, message) => {
  if (!condition) addError(pathKey, message);
};

const ensureArray = (value, pathKey, message) => {
  if (!Array.isArray(value)) {
    addError(pathKey, message);
    return false;
  }
  return true;
};

const ensureObject = (value, pathKey, message) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    addError(pathKey, message);
    return false;
  }
  return true;
};

const ensureString = (value, pathKey, message) => {
  if (typeof value !== 'string') {
    addError(pathKey, message);
    return false;
  }
  return true;
};

const ensureBoolean = (value, pathKey, message) => {
  if (typeof value !== 'boolean') {
    addError(pathKey, message);
    return false;
  }
  return true;
};

const toLower = (value) => String(value).trim().toLowerCase();

let registry;
try {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  registry = JSON.parse(raw);
} catch (error) {
  console.error(`[model-registry] Failed to read or parse ${REGISTRY_PATH}`);
  console.error(error?.message ?? error);
  process.exit(1);
}

ensure(typeof registry === 'object' && registry !== null, 'registry', 'registry document must be an object');
if (!registry) {
  process.exit(1);
}

ensureString(registry.schema_version, 'schema_version', 'schema_version is required');
ensureString(registry.updated_at, 'updated_at', 'updated_at is required');
if (typeof registry.purpose !== 'string') {
  addWarning('purpose', 'purpose is recommended for future extensibility');
}
ensureArray(registry.records, 'records', 'records should be an array');

const statusValues = new Set(['confirmed', 'inferred', 'deprecated', 'unknown']);
const capFields = ['text', 'vision', 'audio', 'video', 'function_calling', 'reasoning', 'coding_agent'];

if (Array.isArray(registry.records)) {
  registry.records.forEach((record, recordIndex) => {
    const recordPath = `records[${recordIndex}]`;
    if (!ensureObject(record, recordPath, 'record must be an object')) return;

    ensureString(record.vendor, `${recordPath}.vendor`, 'vendor is required');
    ensureString(record.series, `${recordPath}.series`, 'series is required');
    if (!ensureArray(record.models, `${recordPath}.models`, 'models should be an array')) return;

    record.models.forEach((model, modelIndex) => {
      const modelPath = `${recordPath}.models[${modelIndex}]`;
      ensureObject(model, modelPath, 'model must be an object');

      ensureString(model.model_id, `${modelPath}.model_id`, 'model_id is required');
      ensureString(model.release_date, `${modelPath}.release_date`, 'release_date is required');
      if (typeof model.release_date === 'string' && !RELEASE_DATE_RE.test(model.release_date)) {
        addWarning(`${modelPath}.release_date`, 'release_date 建议使用 YYYY-MM 或 YYYY-MM-DD');
      }
      ensureString(model.status, `${modelPath}.status`, 'status is required');
      if (!statusValues.has((model.status ?? '').toLowerCase())) {
        addError(`${modelPath}.status`, `invalid status "${model.status}", expect one of: confirmed, inferred, deprecated, unknown`);
      }

      if (ensureObject(model.capabilities, `${modelPath}.capabilities`, 'capabilities is required')) {
        capFields.forEach((field) => {
          ensureBoolean(model.capabilities[field], `${modelPath}.capabilities.${field}`, `${field} should be boolean`);
        });
        ensure(model.capabilities.max_context_tokens === null || Number.isFinite(model.capabilities.max_context_tokens),
          `${modelPath}.capabilities.max_context_tokens`,
          'max_context_tokens should be number | null');
        ensure(model.capabilities.max_output_tokens === null || Number.isFinite(model.capabilities.max_output_tokens),
          `${modelPath}.capabilities.max_output_tokens`,
          'max_output_tokens should be number | null');
      }

      if (ensureObject(model.param_format, `${modelPath}.param_format`, 'param_format is required')) {
        ensureString(model.param_format.family, `${modelPath}.param_format.family`, 'family is required');
        if (ensureArray(model.param_format.required_fields, `${modelPath}.param_format.required_fields`, 'required_fields should be an array')) {
          model.param_format.required_fields.forEach((field, fieldIndex) => {
            ensureString(field, `${modelPath}.param_format.required_fields[${fieldIndex}]`, 'each required field should be string');
          });
        }
        if (ensureArray(model.param_format.optional_fields, `${modelPath}.param_format.optional_fields`, 'optional_fields should be an array')) {
          model.param_format.optional_fields.forEach((field, fieldIndex) => {
            ensureString(field, `${modelPath}.param_format.optional_fields[${fieldIndex}]`, 'each optional field should be string');
          });
        }
      }

      ensureArray(model.quirks, `${modelPath}.quirks`, 'quirks should be an array');
      if (Array.isArray(model.quirks)) {
        model.quirks.forEach((item, qIndex) => {
          ensureString(item, `${modelPath}.quirks[${qIndex}]`, 'each quirk should be string');
        });
      }

      if (typeof model.model_id === 'string') {
        const key = toLower(model.model_id);
        if (modelIdSet.has(key)) {
          addWarning(`${modelPath}.model_id`, `重复模型ID "${model.model_id}"，已有于 ${modelIdSet.get(key)}`);
        } else {
          modelIdSet.set(key, `${recordPath}.models[${modelIndex}]`);
        }
      }
    });
  });
}

if (errors.length > 0) {
  console.error(`[model-registry] 校验失败：共 ${errors.length} 个错误`);
  errors.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}

console.log('[model-registry] 结构校验通过');
if (warnings.length > 0) {
  console.log(`[model-registry] warning: 共 ${warnings.length} 条`);
  warnings.forEach((item) => console.log(`- ${item}`));
}

const modelCount = Array.isArray(registry.records)
  ? registry.records.reduce((sum, item) => sum + (Array.isArray(item.models) ? item.models.length : 0), 0)
  : 0;
console.log(`[model-registry] 已加载供应商系: ${Array.isArray(registry.records) ? registry.records.length : 0}`);
console.log(`[model-registry] 已加载模型条目: ${modelCount}`);
console.log(`[model-registry] schema_version: ${registry.schema_version ?? 'unknown'}`);
console.log(`[model-registry] updated_at: ${registry.updated_at ?? 'unknown'}`);


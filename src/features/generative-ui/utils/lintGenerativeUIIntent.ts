/**
 * 公开意图 linter：报告宪法 / 注册表 / 结构诊断，不抛异常、不改输入。
 * 宿主与 Style Lab 可直接调用。
 */

import '../blocks';
import { generativeUIRegistry } from '../registry';
import { MAX_GENERATIVE_UI_BLOCKS } from '../schema';

export type GenerativeUILintSeverity = 'error' | 'warning';

export interface GenerativeUILintIssue {
  code: string;
  severity: GenerativeUILintSeverity;
  message: string;
  path?: string;
}

export interface LintGenerativeUIIntentResult {
  ok: boolean;
  issues: GenerativeUILintIssue[];
}

export interface LintGenerativeUIIntentOptions {
  actionIds?: string[];
}

const HEX_COLOR = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function issue(
  code: string,
  severity: GenerativeUILintSeverity,
  message: string,
  path?: string,
): GenerativeUILintIssue {
  return path === undefined ? { code, severity, message } : { code, severity, message, path };
}

function collectHexColorIssues(
  value: unknown,
  path: string,
  issues: GenerativeUILintIssue[],
  seen: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    if (HEX_COLOR.test(value)) {
      issues.push(issue('hex-color', 'warning', 'Block props contain a hex color value.', path));
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectHexColorIssues(value[i], `${path}.${i}`, issues, seen);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    collectHexColorIssues(record[key], `${path}.${key}`, issues, seen);
  }
}

function lintGenerativeUIIntentImpl(
  input: unknown,
  options: LintGenerativeUIIntentOptions = {},
): LintGenerativeUIIntentResult {
  const issues: GenerativeUILintIssue[] = [];
  const root = asRecord(input);

  if (!root || (Object.hasOwn(root, 'blocks') && !Array.isArray(root.blocks))) {
    return {
      ok: false,
      issues: [
        issue('invalid-shape', 'error', 'Intent must be an object with a blocks array.'),
      ],
    };
  }

  const blocks = Array.isArray(root.blocks) ? root.blocks : undefined;
  if (blocks === undefined || blocks.length === 0) {
    issues.push(issue('empty-blocks', 'warning', 'Intent has no blocks.', 'blocks'));
  }

  if (blocks !== undefined && blocks.length > MAX_GENERATIVE_UI_BLOCKS) {
    issues.push(
      issue(
        'blocks-truncated',
        'warning',
        `Block count exceeds ${MAX_GENERATIVE_UI_BLOCKS}.`,
        'blocks',
      ),
    );
  }

  const seenIds = new Map<string, number>();
  const allowedActions = Array.isArray(options.actionIds) ? new Set(options.actionIds) : null;

  for (let index = 0; index < (blocks?.length ?? 0); index += 1) {
    const block = blocks![index];
    const record = asRecord(block);
    const type = record && typeof record.type === 'string' ? record.type : undefined;

    if (type === undefined || !generativeUIRegistry.has(type)) {
      issues.push(
        issue(
          'unknown-type',
          'error',
          `Unknown block type ${type === undefined ? '(missing)' : `"${type}"`}.`,
          `blocks.${index}.type`,
        ),
      );
    }

    const id = record && typeof record.id === 'string' ? record.id : undefined;
    if (id !== undefined) {
      if (seenIds.has(id)) {
        issues.push(
          issue('duplicate-id', 'warning', `Duplicate block id "${id}".`, `blocks.${index}.id`),
        );
      } else {
        seenIds.set(id, index);
      }
    }

    const props = record ? record.props : undefined;
    const propsRecord = asRecord(props);

    if (propsRecord) {
      if (Object.hasOwn(propsRecord, 'className')) {
        issues.push(
          issue(
            'forbidden-classname',
            'error',
            'Block props must not include className.',
            `blocks.${index}.props.className`,
          ),
        );
      }
      if (Object.hasOwn(propsRecord, 'fontSize')) {
        issues.push(
          issue(
            'forbidden-fontsize',
            'error',
            'Block props must not include fontSize.',
            `blocks.${index}.props.fontSize`,
          ),
        );
      }
    }

    if (props !== undefined) {
      collectHexColorIssues(props, `blocks.${index}.props`, issues, new WeakSet());
    }

    if (allowedActions && type === 'action-bar') {
      const actions = propsRecord?.actions;
      if (Array.isArray(actions)) {
        for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
          const action = asRecord(actions[actionIndex]);
          const actionId = action && typeof action.id === 'string' ? action.id : undefined;
          if (actionId === undefined || !allowedActions.has(actionId)) {
            issues.push(
              issue(
                'unknown-action',
                'warning',
                actionId === undefined
                  ? 'Action bar entry is missing an id.'
                  : `Unknown action id "${actionId}".`,
                `blocks.${index}.props.actions.${actionIndex}.id`,
              ),
            );
          }
        }
      }
    }
  }

  return {
    ok: issues.every((item) => item.severity !== 'error'),
    issues,
  };
}

/** 报告意图诊断；永不抛出，不改 input。 */
export function lintGenerativeUIIntent(
  input: unknown,
  options?: LintGenerativeUIIntentOptions,
): LintGenerativeUIIntentResult {
  try {
    return lintGenerativeUIIntentImpl(input, options);
  } catch {
    return {
      ok: false,
      issues: [issue('invalid-shape', 'error', 'Intent must be an object with a blocks array.')],
    };
  }
}

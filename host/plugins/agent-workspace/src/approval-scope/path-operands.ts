/**
 * Shell 路径操作数的根目录约束：`validateShellPathOperandsWithinRoot` 需要
 * `std::fs::canonicalize`（符号链接解析），因此留在桌面实现；guard 的纯判定在 `shell-guard.ts`。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, isWithin } from '../runtime-paths.ts';
import { analyzeShellCommand } from './shell-analysis.ts';
import { lexicalNormalizePath } from './shell-guard.ts';
import { utf8Encode } from '../../../../platform/crypto/encoding.ts';

function canonicalizePathWithMissingTail(target: string): string {
  let ancestor = target;
  const tail: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const name = path.basename(ancestor);
    if (name === '' || name === '.' || name === '..') {
      throw new Error(`cannot resolve path operand '${target}'`);
    }
    tail.push(name);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve path operand '${target}'`);
    ancestor = parent;
  }
  let resolved: string;
  try {
    resolved = canonicalPath(ancestor);
  } catch (error) {
    throw new Error(`failed to canonicalize path operand '${target}': ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const component of tail.reverse()) resolved = path.join(resolved, component);
  return lexicalNormalizePath(resolved);
}

/** Enforce the selected runtime root for explicit path operands of a write-capable command. */
export function validateShellPathOperandsWithinRoot(
  root: string,
  cwd: string,
  command: string,
): void {
  const analysis = analyzeShellCommand(command);
  if (!analysis.writeCapable || analysis.pathOperands.length === 0) return;
  let rootCanon: string;
  try {
    rootCanon = canonicalPath(root);
  } catch (error) {
    throw new Error(`failed to canonicalize runtime root: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const operand of analysis.pathOperands) {
    if (operand.startsWith('~') || operand.startsWith('$') || operand.startsWith('%')) {
      throw new Error(`path operand '${operand}' uses a shell expansion that cannot be constrained`);
    }
    if ((globalThis as { process?: { platform?: string } }).process?.platform !== 'win32') {
      const bytes = utf8Encode(operand);
      if (bytes.length >= 3 && bytes[1] === 0x3a && (bytes[2] === 0x2f || bytes[2] === 0x5c)) {
        throw new Error(`foreign absolute path operand '${operand}' cannot be constrained`);
      }
    }
    const candidate = path.isAbsolute(operand) ? operand : path.join(cwd, operand);
    const resolved = canonicalizePathWithMissingTail(candidate);
    if (!isWithin(rootCanon, resolved)) {
      throw new Error(`path operand '${operand}' escapes the selected runtime root`);
    }
  }
}

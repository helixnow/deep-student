import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

/**
 * JSON Schema validator for MCP `Client` instances that works under the release CSP
 * (`script-src 'self'`, no 'unsafe-eval').
 *
 * The SDK defaults to AjvJsonSchemaValidator, whose schema compilation generates code with
 * `new Function`. In release builds that throws EvalError, so `listTools()` rejects for any
 * server whose tools declare an `outputSchema`. @cfworker/json-schema validates by
 * interpretation, without code generation.
 */
export function createCspSafeJsonSchemaValidator(): jsonSchemaValidator {
  return new CfWorkerJsonSchemaValidator();
}

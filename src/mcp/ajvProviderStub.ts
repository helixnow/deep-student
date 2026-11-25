import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

const STUB_ERROR =
  'AjvJsonSchemaValidator is disabled in frontend builds (release CSP forbids unsafe-eval). ' +
  'Pass { jsonSchemaValidator: createCspSafeJsonSchemaValidator() } from src/mcp/cspSafeJsonSchemaValidator instead.';

/**
 * Production bundle stub for `@modelcontextprotocol/sdk`'s default `AjvJsonSchemaValidator`.
 *
 * `@modelcontextprotocol/sdk/client/index.js` statically imports `../validation/ajv-provider.js`,
 * pulling `ajv` + `ajv-formats` + `fast-uri` (~70 KiB gz) into the cold-boot entry chunk even
 * though every frontend MCP client passes `createCspSafeJsonSchemaValidator()` (`@cfworker/json-schema`).
 */
export class AjvJsonSchemaValidator implements jsonSchemaValidator {
  constructor(_ajv?: unknown) {
    throw new Error(STUB_ERROR);
  }

  getValidator(): never {
    throw new Error(STUB_ERROR);
  }
}

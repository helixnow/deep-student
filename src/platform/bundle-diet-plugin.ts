/**
 * Vite bundle-diet resolution plugin shared by desktop (`vite.config.ts`) and WebUI (`web/vite.config.ts`).
 *
 * Handles both bare specifiers and relative imports inside `node_modules` (which standard
 * `resolve.alias` cannot intercept):
 * 1. `@nvq/flowtoken`'s `./DefaultCode.js` -> lightweight zero-dep `FlowTokenDefaultCodeStub.tsx`
 *    (eliminates `@tabler/icons-react` + `react-syntax-highlighter` + `highlight.js`, ~1 MiB gz).
 * 2. `@modelcontextprotocol/sdk`'s `../validation/ajv-provider.js` -> `src/mcp/ajvProviderStub.ts`
 *    (eliminates unused `ajv` + `ajv-formats` + `fast-uri` from cold-boot `main.js`, ~70 KiB gz).
 * 3. `@codemirror/language-data` -> curated `src/components/crepe/codeMirrorLanguages.ts`
 *    (eliminates ~95 obscure legacy modes from Milkdown Crepe, ~400 KiB gz).
 */
import path from 'node:path';
import { normalizePath, type Plugin } from 'vite';

export function bundleDietPlugin(repoRoot: string): Plugin {
  const flowTokenStub = normalizePath(
    path.resolve(repoRoot, 'src/features/chat/components/renderers/FlowTokenDefaultCodeStub.tsx'),
  );
  const ajvStub = normalizePath(
    path.resolve(repoRoot, 'src/mcp/ajvProviderStub.ts'),
  );
  const cmLanguages = normalizePath(
    path.resolve(repoRoot, 'src/components/crepe/codeMirrorLanguages.ts'),
  );

  return {
    name: 'ds-bundle-diet-aliases',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@codemirror/language-data') {
        return cmLanguages;
      }

      if (
        source === '@nvq/flowtoken/dist/components/DefaultCode.js' ||
        source === '@nvq/flowtoken/dist/components/DefaultCode'
      ) {
        return flowTokenStub;
      }

      if (
        source === '@modelcontextprotocol/sdk/validation/ajv' ||
        source === '@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js'
      ) {
        return ajvStub;
      }

      if (!importer || !source.startsWith('.')) {
        return null;
      }

      const cleanImporter = normalizePath(importer.split('?')[0] ?? importer);

      if (
        cleanImporter.includes('/@nvq/flowtoken/dist/components/') &&
        /^\.\/DefaultCode(?:\.js)?$/.test(source)
      ) {
        return flowTokenStub;
      }

      if (
        cleanImporter.includes('/@modelcontextprotocol/sdk/') &&
        /(?:^|\/)validation\/ajv-provider(?:\.js)?$/.test(source)
      ) {
        return ajvStub;
      }

      return null;
    },
  };
}

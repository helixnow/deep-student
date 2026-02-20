import { promises as fs } from 'fs';
import path from 'path';
import { globby } from 'globby';

const ALIAS_IMPORT = `import { copyTextToClipboard } from '@/utils/clipboardUtils';`;
const RELATIVE_IMPORT = `import { copyTextToClipboard } from '../../utils/clipboardUtils';`; // We'll adjust based on path depth if we can't use alias. Wait, Vite supports alias @/. We can just use `import { copyTextToClipboard } from '@/utils/clipboardUtils';`

async function run() {
  const files = await globby(['src/**/*.{ts,tsx}']);
  for (const file of files) {
    if (file === 'src/utils/clipboardUtils.ts') continue;
    let content = await fs.readFile(file, 'utf8');
    if (content.includes('navigator.clipboard.writeText')) {
      content = content.replace(/navigator\.clipboard\.writeText/g, 'copyTextToClipboard');
      
      // We also need to add the import if it's not there
      if (!content.includes('copyTextToClipboard')) {
        continue;
      }
      
      if (!content.includes('@/utils/clipboardUtils')) {
        // Find last import statement
        const importRegex = /^import .+?;?$/gm;
        let match;
        let lastImportIndex = 0;
        while ((match = importRegex.exec(content)) !== null) {
          lastImportIndex = match.index + match[0].length;
        }
        
        if (lastImportIndex > 0) {
          content = content.slice(0, lastImportIndex) + '\n' + ALIAS_IMPORT + content.slice(lastImportIndex);
        } else {
          content = ALIAS_IMPORT + '\n\n' + content;
        }
      }
      
      await fs.writeFile(file, content, 'utf8');
      console.log(`Updated ${file}`);
    }
  }
}

run().catch(console.error);

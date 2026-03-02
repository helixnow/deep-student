#!/usr/bin/env node
/**
 * 检查缺失翻译文本的详细脚本
 * 分析所有翻译键并生成详细报告
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

// 递归获取所有键
function getAllKeys(obj, prefix = '') {
  const keys = [];
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys.push(...getAllKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

// 检查单个翻译文件
function checkTranslationFile(fileName) {
  const zhPath = path.join(rootDir, 'src/locales/zh-CN', fileName);
  const enPath = path.join(rootDir, 'src/locales/en-US', fileName);

  if (!fs.existsSync(zhPath) || !fs.existsSync(enPath)) {
    return null;
  }

  const zhContent = JSON.parse(fs.readFileSync(zhPath, 'utf-8'));
  const enContent = JSON.parse(fs.readFileSync(enPath, 'utf-8'));

  const zhKeys = getAllKeys(zhContent);
  const enKeys = getAllKeys(enContent);

  const zhSet = new Set(zhKeys);
  const enSet = new Set(enKeys);

  const missingInEn = zhKeys.filter(k => !enSet.has(k));
  const missingInZh = enKeys.filter(k => !zhSet.has(k));

  return {
    fileName,
    zhKeys: zhKeys.length,
    enKeys: enKeys.length,
    missingInEn,
    missingInZh,
  };
}

// 主函数
function main() {
  log(colors.cyan, '\n╔════════════════════════════════════════════════════════════╗');
  log(colors.cyan, '║       翻译键缺失详细检查报告                              ║');
  log(colors.cyan, '╚════════════════════════════════════════════════════════════╝\n');

  const localesDir = path.join(rootDir, 'src/locales/zh-CN');
  const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json'));

  let totalMissingInEn = 0;
  let totalMissingInZh = 0;
  const detailedReport = [];

  files.forEach(fileName => {
    const result = checkTranslationFile(fileName);
    if (!result) return;

    const { missingInEn, missingInZh } = result;

    if (missingInEn.length > 0 || missingInZh.length > 0) {
      detailedReport.push(result);
      totalMissingInEn += missingInEn.length;
      totalMissingInZh += missingInZh.length;
    }
  });

  // 打印统计信息
  log(colors.blue, '=== 总体统计 ===\n');
  log(colors.yellow, `问题文件数量: ${detailedReport.length}`);
  log(colors.red, `英文版缺失翻译键总数: ${totalMissingInEn}`);
  log(colors.yellow, `中文版缺失翻译键总数: ${totalMissingInZh}`);

  // 打印详细报告
  log(colors.blue, '\n=== 详细缺失键列表 ===\n');

  detailedReport.forEach(({ fileName, zhKeys, enKeys, missingInEn, missingInZh }) => {
    log(colors.cyan, `\n📄 ${fileName}`);
    log(colors.blue, `   中文键数: ${zhKeys}  |  英文键数: ${enKeys}`);

    if (missingInEn.length > 0) {
      log(colors.red, `   ❌ 英文版缺失 ${missingInEn.length} 个键:`);
      missingInEn.slice(0, 20).forEach(key => {
        console.log(`      - ${key}`);
      });
      if (missingInEn.length > 20) {
        log(colors.yellow, `      ... 还有 ${missingInEn.length - 20} 个键`);
      }
    }

    if (missingInZh.length > 0) {
      log(colors.yellow, `   ⚠️  中文版缺失 ${missingInZh.length} 个键:`);
      missingInZh.slice(0, 20).forEach(key => {
        console.log(`      - ${key}`);
      });
      if (missingInZh.length > 20) {
        log(colors.yellow, `      ... 还有 ${missingInZh.length - 20} 个键`);
      }
    }
  });

  // 生成修复建议
  log(colors.blue, '\n=== 修复建议 ===\n');

  if (totalMissingInEn > 0) {
    log(colors.red, `1. 英文翻译缺失问题（${totalMissingInEn}个键）`);
    console.log('   需要为以下文件添加英文翻译:');
    detailedReport
      .filter(r => r.missingInEn.length > 0)
      .forEach(({ fileName, missingInEn }) => {
        console.log(`   - ${fileName}: ${missingInEn.length} 个缺失键`);
      });
  }

  if (totalMissingInZh > 0) {
    log(colors.yellow, `\n2. 中文翻译缺失问题（${totalMissingInZh}个键）`);
    console.log('   需要为以下文件添加中文翻译:');
    detailedReport
      .filter(r => r.missingInZh.length > 0)
      .forEach(({ fileName, missingInZh }) => {
        console.log(`   - ${fileName}: ${missingInZh.length} 个缺失键`);
      });
  }

  // 保存详细报告到文件
  const reportDir = path.join(rootDir, 'note');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, '翻译键缺失详细报告.md');
  const reportContent = generateMarkdownReport(detailedReport, totalMissingInEn, totalMissingInZh);
  fs.writeFileSync(reportPath, reportContent, 'utf-8');
  log(colors.green, `\n✅ 详细报告已保存到: ${reportPath}`);
}

function generateMarkdownReport(detailedReport, totalMissingInEn, totalMissingInZh) {
  let md = `# 翻译键缺失详细报告\n\n`;
  md += `**生成时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n`;
  md += `## 📊 总体统计\n\n`;
  md += `- **问题文件数量**: ${detailedReport.length}\n`;
  md += `- **英文版缺失翻译键总数**: ${totalMissingInEn}\n`;
  md += `- **中文版缺失翻译键总数**: ${totalMissingInZh}\n\n`;

  md += `## 📋 详细缺失键列表\n\n`;

  detailedReport.forEach(({ fileName, zhKeys, enKeys, missingInEn, missingInZh }) => {
    md += `### ${fileName}\n\n`;
    md += `- 中文键数: ${zhKeys}\n`;
    md += `- 英文键数: ${enKeys}\n\n`;

    if (missingInEn.length > 0) {
      md += `#### ❌ 英文版缺失 ${missingInEn.length} 个键\n\n`;
      md += '```\n';
      missingInEn.forEach(key => {
        md += `${key}\n`;
      });
      md += '```\n\n';
    }

    if (missingInZh.length > 0) {
      md += `#### ⚠️ 中文版缺失 ${missingInZh.length} 个键\n\n`;
      md += '```\n';
      missingInZh.forEach(key => {
        md += `${key}\n`;
      });
      md += '```\n\n';
    }
  });

  md += `## 🔧 修复步骤\n\n`;
  md += `### 1. 修复英文翻译缺失（${totalMissingInEn}个键）\n\n`;
  detailedReport
    .filter(r => r.missingInEn.length > 0)
    .forEach(({ fileName, missingInEn }) => {
      md += `- **${fileName}**: ${missingInEn.length} 个缺失键\n`;
    });

  md += `\n### 2. 修复中文翻译缺失（${totalMissingInZh}个键）\n\n`;
  detailedReport
    .filter(r => r.missingInZh.length > 0)
    .forEach(({ fileName, missingInZh }) => {
      md += `- **${fileName}**: ${missingInZh.length} 个缺失键\n`;
    });

  md += `\n### 3. 修复建议\n\n`;
  md += `1. 优先修复 common.json，这是最核心的翻译文件\n`;
  md += `2. 为缺失的键添加对应的翻译文本\n`;
  md += `3. 确保中英文翻译键完全对应\n`;
  md += `4. 运行 \`npm run check:i18n:missing\` 验证修复结果\n`;

  return md;
}

main();

#!/usr/bin/env node

/**
 * 剪藏功能自动化测试脚本
 * 用于验证剪藏引擎的有效性和准确性
 * 
 * 运行方式：
 *   node scripts/test-clipper.mjs
 *   node scripts/test-clipper.mjs --verbose
 *   node scripts/test-clipper.mjs --category=tech-blog
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

// 测试用例配置
const TEST_CASES = [
  // === 技术博客类 ===
  {
    category: 'tech-blog',
    name: 'Mozilla MDN',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
    expectations: {
      minLength: 1000,
      mustInclude: ['Array', 'JavaScript'],
      shouldHaveTitle: true,
      shouldHaveMetadata: true,
    }
  },
  {
    category: 'tech-blog',
    name: 'GitHub Blog',
    url: 'https://github.blog/news-insights/company-news/github-availability-report-october-2024/',
    expectations: {
      minLength: 500,
      mustInclude: ['GitHub'],
      shouldHaveTitle: true,
    }
  },
  
  // === 新闻媒体类 ===
  {
    category: 'news',
    name: 'Hacker News',
    url: 'https://news.ycombinator.com/item?id=38477259',
    expectations: {
      minLength: 200,
      shouldHaveTitle: true,
      allowFallback: true, // HN可能不好提取
    }
  },
  
  // === 技术文档类 ===
  {
    category: 'documentation',
    name: 'React Documentation',
    url: 'https://react.dev/learn',
    expectations: {
      minLength: 500,
      mustInclude: ['React', 'component'],
      shouldHaveTitle: true,
    }
  },
  
  // === 博客平台类 ===
  {
    category: 'blog-platform',
    name: 'CSS Tricks',
    url: 'https://css-tricks.com/snippets/css/a-guide-to-flexbox/',
    expectations: {
      minLength: 500,
      shouldHaveTitle: true,
      mustInclude: ['flexbox', 'CSS'],
    }
  },
  
  // === 开源项目文档 ===
  {
    category: 'documentation',
    name: 'Node.js Docs',
    url: 'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs',
    expectations: {
      minLength: 500,
      mustInclude: ['Node.js'],
      shouldHaveTitle: true,
    }
  },
  
  // === 错误页面测试 ===
  {
    category: 'error-page',
    name: '404 Page',
    url: 'https://httpbin.org/status/404',
    expectations: {
      shouldFail: true, // 预期失败
      reason: 'Content quality validation should reject 404 pages'
    }
  },
];

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function log(color, ...args) {
  console.log(color + args.join(' ') + colors.reset);
}

// 内容质量验证（复制自clipper.ts）
function validateContent(content, title) {
  if (content.length < 200) {
    return { valid: false, reason: `内容太短: ${content.length} < 200` };
  }

  const lowerContent = content.toLowerCase();
  const lowerTitle = title.toLowerCase();

  // 检测404/403等错误页面
  const errorKeywords = ['404', 'not found', 'access denied', '页面不存在', '访问被拒绝', 'page not found'];
  const errorCount = errorKeywords.filter(kw => lowerContent.includes(kw) || lowerTitle.includes(kw)).length;
  if (errorCount >= 2) {
    return { valid: false, reason: `检测到错误页面 (${errorCount}个错误关键词)` };
  }

  // 检测付费墙
  const paywallKeywords = ['subscribe to continue', 'premium content', 'paywall', '订阅后继续阅读', '付费内容'];
  const paywallCount = paywallKeywords.filter(kw => lowerContent.includes(kw)).length;
  if (paywallCount >= 2) {
    return { valid: false, reason: `检测到付费墙 (${paywallCount}个付费关键词)` };
  }

  return { valid: true };
}

// 使用Readability提取文章
async function extractArticle(html, url) {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.content) {
      return { success: false, error: 'Readability提取失败' };
    }

    return {
      success: true,
      title: article.title || 'Untitled',
      content: article.content,
      textContent: article.textContent || '',
      excerpt: article.excerpt || undefined,
      byline: article.byline || undefined,
      siteName: article.siteName || undefined,
      publishedTime: article.publishedTime || undefined,
      lang: article.lang || undefined,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 获取网页HTML
async function fetchHTML(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }
    });

    if (!response.ok) {
      return { success: false, status: response.status, error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    return { success: true, html, status: response.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 运行单个测试
async function runTest(testCase, verbose = false) {
  const startTime = Date.now();
  log(colors.cyan, `\n▶ 测试: ${testCase.name}`);
  log(colors.gray, `  URL: ${testCase.url}`);

  const result = {
    name: testCase.name,
    category: testCase.category,
    url: testCase.url,
    success: false,
    duration: 0,
    checks: {},
    errors: [],
  };

  try {
    // 1. 获取HTML
    if (verbose) log(colors.gray, '  [1/3] 获取HTML...');
    const fetchResult = await fetchHTML(testCase.url);
    
    if (!fetchResult.success) {
      if (testCase.expectations.shouldFail) {
        result.success = true;
        result.checks.expectedFailure = true;
        log(colors.green, `  ✓ 预期失败: ${fetchResult.error}`);
        return result;
      }
      result.errors.push(`获取失败: ${fetchResult.error}`);
      log(colors.red, `  ✗ 获取HTML失败: ${fetchResult.error}`);
      return result;
    }

    if (verbose) log(colors.gray, `  HTTP ${fetchResult.status}, HTML长度: ${fetchResult.html.length}`);

    // 2. 提取文章
    if (verbose) log(colors.gray, '  [2/3] 提取文章内容...');
    const article = await extractArticle(fetchResult.html, testCase.url);

    if (!article.success) {
      if (testCase.expectations.allowFallback) {
        result.checks.fallbackExpected = true;
        log(colors.yellow, `  ⚠ 提取失败（预期可能失败）: ${article.error}`);
        result.success = true; // 如果允许fallback，不算失败
        return result;
      }
      result.errors.push(`提取失败: ${article.error}`);
      log(colors.red, `  ✗ 提取失败: ${article.error}`);
      return result;
    }

    if (verbose) {
      log(colors.gray, `  标题: ${article.title}`);
      log(colors.gray, `  正文长度: ${article.textContent.length}`);
      if (article.byline) log(colors.gray, `  作者: ${article.byline}`);
      if (article.siteName) log(colors.gray, `  站点: ${article.siteName}`);
    }

    // 3. 验证内容质量
    if (verbose) log(colors.gray, '  [3/3] 验证内容质量...');
    const validation = validateContent(article.textContent, article.title);

    if (!validation.valid) {
      if (testCase.expectations.shouldFail) {
        result.success = true;
        result.checks.expectedValidationFail = true;
        log(colors.green, `  ✓ 预期验证失败: ${validation.reason}`);
        return result;
      }
      result.errors.push(`验证失败: ${validation.reason}`);
      log(colors.red, `  ✗ 验证失败: ${validation.reason}`);
      return result;
    }

    // 4. 检查预期条件
    let allChecksPassed = true;

    // 检查最小长度
    if (testCase.expectations.minLength) {
      const passed = article.textContent.length >= testCase.expectations.minLength;
      result.checks.minLength = passed;
      if (!passed) {
        allChecksPassed = false;
        result.errors.push(`内容长度不足: ${article.textContent.length} < ${testCase.expectations.minLength}`);
        log(colors.red, `  ✗ 内容长度不足: ${article.textContent.length} < ${testCase.expectations.minLength}`);
      } else if (verbose) {
        log(colors.green, `  ✓ 内容长度满足: ${article.textContent.length} >= ${testCase.expectations.minLength}`);
      }
    }

    // 检查必须包含的关键词
    if (testCase.expectations.mustInclude) {
      const lowerContent = article.textContent.toLowerCase();
      for (const keyword of testCase.expectations.mustInclude) {
        const passed = lowerContent.includes(keyword.toLowerCase());
        result.checks[`keyword_${keyword}`] = passed;
        if (!passed) {
          allChecksPassed = false;
          result.errors.push(`缺少关键词: "${keyword}"`);
          log(colors.red, `  ✗ 缺少关键词: "${keyword}"`);
        } else if (verbose) {
          log(colors.green, `  ✓ 包含关键词: "${keyword}"`);
        }
      }
    }

    // 检查标题
    if (testCase.expectations.shouldHaveTitle) {
      const passed = article.title && article.title.length > 0 && article.title !== 'Untitled';
      result.checks.hasTitle = passed;
      if (!passed) {
        allChecksPassed = false;
        result.errors.push('标题为空');
        log(colors.red, '  ✗ 标题为空');
      } else if (verbose) {
        log(colors.green, `  ✓ 标题存在: "${article.title}"`);
      }
    }

    // 检查元数据
    if (testCase.expectations.shouldHaveMetadata) {
      const hasMetadata = article.byline || article.siteName || article.excerpt || article.publishedTime;
      result.checks.hasMetadata = hasMetadata;
      if (!hasMetadata) {
        allChecksPassed = false;
        result.errors.push('缺少元数据');
        log(colors.yellow, '  ⚠ 缺少元数据（byline/siteName/excerpt/publishedTime）');
      } else if (verbose) {
        log(colors.green, '  ✓ 元数据存在');
      }
    }

    result.success = allChecksPassed;
    result.article = {
      title: article.title,
      contentLength: article.textContent.length,
      hasExcerpt: !!article.excerpt,
      hasByline: !!article.byline,
      hasSiteName: !!article.siteName,
      hasPublishedTime: !!article.publishedTime,
    };

    if (result.success) {
      log(colors.green, `  ✓ 测试通过`);
    } else {
      log(colors.yellow, `  ⚠ 部分检查未通过`);
    }

  } catch (err) {
    result.errors.push(`异常: ${err.message}`);
    log(colors.red, `  ✗ 异常: ${err.message}`);
    if (verbose) console.error(err);
  } finally {
    result.duration = Date.now() - startTime;
    if (verbose) log(colors.gray, `  耗时: ${result.duration}ms`);
  }

  return result;
}

// 生成测试报告
function generateReport(results) {
  log(colors.bright + colors.blue, '\n' + '='.repeat(70));
  log(colors.bright + colors.blue, '测试报告');
  log(colors.bright + colors.blue, '='.repeat(70));

  const categories = {};
  results.forEach(r => {
    if (!categories[r.category]) {
      categories[r.category] = { total: 0, passed: 0, failed: 0 };
    }
    categories[r.category].total++;
    if (r.success) categories[r.category].passed++;
    else categories[r.category].failed++;
  });

  // 总体统计
  const totalTests = results.length;
  const passedTests = results.filter(r => r.success).length;
  const failedTests = totalTests - passedTests;
  const successRate = ((passedTests / totalTests) * 100).toFixed(1);

  log(colors.bright, `\n总体统计:`);
  log(colors.gray, `  总测试数: ${totalTests}`);
  log(colors.green, `  通过: ${passedTests}`);
  if (failedTests > 0) {
    log(colors.red, `  失败: ${failedTests}`);
  }
  log(colors.bright, `  成功率: ${successRate}%`);

  const avgDuration = (results.reduce((sum, r) => sum + r.duration, 0) / totalTests).toFixed(0);
  log(colors.gray, `  平均耗时: ${avgDuration}ms`);

  // 分类统计
  log(colors.bright, `\n分类统计:`);
  Object.entries(categories).forEach(([cat, stats]) => {
    const catRate = ((stats.passed / stats.total) * 100).toFixed(0);
    const color = stats.passed === stats.total ? colors.green : (stats.failed > stats.passed ? colors.red : colors.yellow);
    log(color, `  ${cat}: ${stats.passed}/${stats.total} (${catRate}%)`);
  });

  // 失败详情
  const failed = results.filter(r => !r.success && !r.checks.fallbackExpected);
  if (failed.length > 0) {
    log(colors.bright + colors.red, `\n失败详情:`);
    failed.forEach(r => {
      log(colors.red, `\n  ✗ ${r.name}`);
      log(colors.gray, `    URL: ${r.url}`);
      r.errors.forEach(err => log(colors.red, `    - ${err}`));
    });
  }

  // 性能分析
  const sorted = [...results].sort((a, b) => b.duration - a.duration);
  log(colors.bright, `\n性能排名 (最慢的3个):`);
  sorted.slice(0, 3).forEach((r, i) => {
    log(colors.gray, `  ${i + 1}. ${r.name}: ${r.duration}ms`);
  });

  return {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    successRate: parseFloat(successRate),
    avgDuration: parseFloat(avgDuration),
  };
}

// 保存报告
function saveReport(results, summary) {
  const reportDir = path.join(process.cwd(), 'devsec', 'results');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const reportFile = path.join(reportDir, `clipper-test-${timestamp}.json`);

  const report = {
    timestamp: new Date().toISOString(),
    summary,
    results: results.map(r => ({
      name: r.name,
      category: r.category,
      url: r.url,
      success: r.success,
      duration: r.duration,
      checks: r.checks,
      errors: r.errors,
      article: r.article,
    })),
  };

  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  log(colors.blue, `\n报告已保存: ${reportFile}`);
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];

  let testCases = TEST_CASES;
  if (categoryFilter) {
    testCases = TEST_CASES.filter(tc => tc.category === categoryFilter);
    log(colors.yellow, `过滤分类: ${categoryFilter}, 共 ${testCases.length} 个测试`);
  }

  log(colors.bright + colors.blue, '\n剪藏功能自动化测试');
  log(colors.bright + colors.blue, '='.repeat(70));
  log(colors.gray, `开始时间: ${new Date().toLocaleString('zh-CN')}`);
  log(colors.gray, `测试用例数: ${testCases.length}`);
  log(colors.gray, `详细模式: ${verbose ? '开启' : '关闭'}`);

  const results = [];
  
  for (const testCase of testCases) {
    const result = await runTest(testCase, verbose);
    results.push(result);
    
    // 避免请求过快
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const summary = generateReport(results);
  saveReport(results, summary);

  log(colors.bright + colors.blue, '\n' + '='.repeat(70));
  log(colors.bright + colors.blue, '测试完成');
  log(colors.bright + colors.blue, '='.repeat(70) + '\n');

  // 如果有失败，退出码为1
  process.exit(summary.failed > 0 ? 1 : 0);
}

// 运行
main().catch(err => {
  console.error('测试运行失败:', err);
  process.exit(1);
});


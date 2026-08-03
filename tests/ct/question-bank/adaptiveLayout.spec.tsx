import React from 'react';
import { expect, test, type Locator } from '@playwright/experimental-ct-react';
import { QuestionBankListView } from '@/components/QuestionBankListView';
import { ExamSheetUploader } from '@/components/ExamSheetUploader';
import { CsvImportPanel } from '@/components/CsvImportDialog';
import { ExamShell } from './ExamShell';
import { WorkbenchExamShell } from './WorkbenchExamShell';

/**
 * 题目集小窗口自适应回归测试。
 *
 * 复现 2026-07-17 用户反馈：窗口不够大时启动台卡片 / 识别导入 dropzone /
 * 新建编辑器页脚被截断。用真实父链（Tab 栏 + flex-1 overflow-hidden 内容区）
 * 在 1000x560 视口下渲染，断言关键元素都在视口内，并留截图人工复核。
 */

const SHOT_DIR = '/tmp/qbank-ct';
const SMALL = { width: 1000, height: 560 };
const TINY = { width: 820, height: 480 };

async function expectWithinViewport(
  locator: Locator,
  viewport: { width: number; height: number },
  label: string
) {
  await expect(locator, `${label} 应该可见`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} 应该有布局框`).not.toBeNull();
  expect(box!.y, `${label} 顶部不应超出视口 (y=${box!.y})`).toBeGreaterThanOrEqual(0);
  expect(box!.x, `${label} 左侧不应超出视口 (x=${box!.x})`).toBeGreaterThanOrEqual(0);
  expect(
    box!.y + box!.height,
    `${label} 底部不应超出视口 (bottom=${Math.round(box!.y + box!.height)} > ${viewport.height})`
  ).toBeLessThanOrEqual(viewport.height);
  expect(
    box!.x + box!.width,
    `${label} 右侧不应超出视口 (right=${Math.round(box!.x + box!.width)} > ${viewport.width})`
  ).toBeLessThanOrEqual(viewport.width);
}

test.use({ viewport: SMALL });

test('启动台（空状态）在小窗口下三卡完整可见', async ({ mount, page }) => {
  await page.setViewportSize(SMALL);
  const component = await mount(
    <ExamShell>
      <QuestionBankListView
        questions={[]}
        examId="exam_1"
        onCreateQuestion={async () => {}}
        onUploadQuestions={() => {}}
        onUploadFiles={() => {}}
        onCsvImport={() => {}}
        onQuestionClick={() => {}}
      />
    </ExamShell>
  );

  await expectWithinViewport(component.getByText('暂无题目'), SMALL, '空状态标题');
  await expectWithinViewport(component.getByText('新建题目'), SMALL, '新建题目卡');
  await expectWithinViewport(component.getByText('CSV 导入'), SMALL, 'CSV 导入卡');
  await expectWithinViewport(
    component.getByText('也可以把图片或文档直接拖到这里'),
    SMALL,
    '拖放提示'
  );
  await page.screenshot({ path: `${SHOT_DIR}/launcher-1000x560.png`, fullPage: false });
});

test('识别导入在小窗口下 dropzone 与提示完整可见', async ({ mount, page }) => {
  await page.setViewportSize(SMALL);
  const component = await mount(
    <ExamShell>
      <ExamSheetUploader
        sessionId="exam_1"
        sessionName="新题目集"
        onBack={() => {}}
        onManualCreate={() => {}}
      />
    </ExamShell>
  );

  await expectWithinViewport(component.getByText('识别导入').first(), SMALL, '页面标题');
  await expectWithinViewport(component.getByText('点击或拖放文件到这里'), SMALL, 'dropzone 文案');
  await expectWithinViewport(
    component.getByText(/图片将通过 OCR 识别/),
    SMALL,
    '合并提示行'
  );
  await expectWithinViewport(
    component.getByText(/没有文件/),
    SMALL,
    '手动新建回退链接'
  );
  await page.screenshot({ path: `${SHOT_DIR}/uploader-1000x560.png`, fullPage: false });
});

test('新建编辑器在小窗口下保存按钮钉底可见', async ({ mount, page }) => {
  await page.setViewportSize(SMALL);
  const component = await mount(
    <ExamShell>
      <QuestionBankListView
        questions={[]}
        examId="exam_1"
        onCreateQuestion={async () => {}}
        onUploadQuestions={() => {}}
        onUploadFiles={() => {}}
        onCsvImport={() => {}}
        onQuestionClick={() => {}}
      />
    </ExamShell>
  );

  await component.getByText('新建题目').click();
  await expectWithinViewport(component.getByText('题目内容'), SMALL, '题目内容标签');
  await expectWithinViewport(
    component.getByRole('button', { name: /创建题目/ }),
    SMALL,
    '创建题目提交按钮'
  );
  await expectWithinViewport(
    component.getByRole('button', { name: '取消' }),
    SMALL,
    '取消按钮'
  );
  await page.screenshot({ path: `${SHOT_DIR}/editor-1000x560.png`, fullPage: false });
});

test('CSV 内嵌导入在小窗口下页脚按钮完整可见', async ({ mount, page }) => {
  await page.setViewportSize(SMALL);
  const component = await mount(
    <ExamShell>
      <CsvImportPanel examId="exam_1" examName="新题目集" onClose={() => {}} />
    </ExamShell>
  );

  await expectWithinViewport(component.getByText('CSV 导入').first(), SMALL, '页面标题');
  await expectWithinViewport(component.getByText(/拖拽 CSV 文件到此处/), SMALL, 'dropzone 文案');
  await expectWithinViewport(
    component.getByRole('button', { name: '返回' }),
    SMALL,
    '返回按钮'
  );
  await page.screenshot({ path: `${SHOT_DIR}/csv-1000x560.png`, fullPage: false });
});

test('极限矮窗（820x480）下启动台与编辑器仍可用', async ({ mount, page }) => {
  await page.setViewportSize(TINY);
  const component = await mount(
    <ExamShell>
      <QuestionBankListView
        questions={[]}
        examId="exam_1"
        onCreateQuestion={async () => {}}
        onUploadQuestions={() => {}}
        onUploadFiles={() => {}}
        onCsvImport={() => {}}
        onQuestionClick={() => {}}
      />
    </ExamShell>
  );

  await expectWithinViewport(component.getByText('新建题目'), TINY, '新建题目卡');
  await page.screenshot({ path: `${SHOT_DIR}/launcher-820x480.png`, fullPage: false });

  await component.getByText('新建题目').click();
  await expectWithinViewport(
    component.getByRole('button', { name: /创建题目/ }),
    TINY,
    '创建题目提交按钮'
  );
  await page.screenshot({ path: `${SHOT_DIR}/editor-820x480.png`, fullPage: false });
});

// ===== 真实嵌套链（Workbench 浮窗 + ResourceAppWorkspace 网格）复刻 =====

const DESKTOP = { width: 1121, height: 714 };

test('真实链路：启动台在学习桌面浮窗中居中且完整', async ({ mount, page }) => {
  await page.setViewportSize(DESKTOP);
  const component = await mount(
    <WorkbenchExamShell>
      <QuestionBankListView
        questions={[]}
        examId="exam_1"
        onCreateQuestion={async () => {}}
        onUploadQuestions={() => {}}
        onUploadFiles={() => {}}
        onCsvImport={() => {}}
        onQuestionClick={() => {}}
      />
    </WorkbenchExamShell>
  );

  await expectWithinViewport(component.getByText('暂无题目'), DESKTOP, '空状态标题');
  await expectWithinViewport(component.getByText('CSV 导入'), DESKTOP, 'CSV 导入卡');

  const workspace = component.locator('.wb-resource-workspace');
  const workspaceMain = component.locator('.wb-resource-workspace-main');
  const workspaceSidebar = component.locator('.wb-resource-workspace-sidebar');
  const [workspaceBox, mainBox, sidebarBox] = await Promise.all([
    workspace.boundingBox(),
    workspaceMain.boundingBox(),
    workspaceSidebar.boundingBox(),
  ]);
  expect(workspaceBox).not.toBeNull();
  expect(mainBox?.height, '主面板高度必须受浮窗工作区约束，不能继承全局 100vh')
    .toBe(workspaceBox?.height);
  expect(sidebarBox?.height, '侧栏不能被错误的主面板高度撑出浮窗')
    .toBe(workspaceBox?.height);
  await page.screenshot({ path: `${SHOT_DIR}/wb-launcher.png`, fullPage: false });
});

test('真实链路：识别导入在学习桌面浮窗中完整可见', async ({ mount, page }) => {
  await page.setViewportSize(DESKTOP);
  const component = await mount(
    <WorkbenchExamShell>
      <ExamSheetUploader
        sessionId="exam_1"
        sessionName="新题目集"
        onBack={() => {}}
        onManualCreate={() => {}}
      />
    </WorkbenchExamShell>
  );

  await expectWithinViewport(component.getByText('点击或拖放文件到这里'), DESKTOP, 'dropzone 文案');
  await expectWithinViewport(component.getByText(/没有文件/), DESKTOP, '手动新建回退链接');
  await page.screenshot({ path: `${SHOT_DIR}/wb-uploader.png`, fullPage: false });
});

test('真实链路：新建编辑器随学习桌面浮窗缩放且正文可滚动', async ({ mount, page }) => {
  await page.setViewportSize(DESKTOP);
  const component = await mount(
    <WorkbenchExamShell>
      <QuestionBankListView
        questions={[]}
        examId="exam_1"
        onCreateQuestion={async () => {}}
        onUploadQuestions={() => {}}
        onUploadFiles={() => {}}
        onCsvImport={() => {}}
        onQuestionClick={() => {}}
      />
    </WorkbenchExamShell>
  );

  await component.getByText('新建题目').click();

  const editor = component.locator('[data-question-inline-editor]');
  const scrollBody = editor.locator(':scope > div').first();
  const createButton = component.getByRole('button', { name: /创建题目/ });

  await expectWithinViewport(editor, DESKTOP, '新建题目编辑器');
  await expectWithinViewport(createButton, DESKTOP, '创建题目提交按钮');
  await expectWithinViewport(component.getByRole('button', { name: '取消' }), DESKTOP, '取消按钮');

  const scrollMetrics = await scrollBody.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight, '编辑器正文应在矮浮窗中拥有独立滚动区域')
    .toBeGreaterThan(scrollMetrics.clientHeight);

  await scrollBody.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(component.getByText('题目图片', { exact: true })).toBeVisible();
  await expectWithinViewport(createButton, DESKTOP, '滚动后的创建题目提交按钮');
  await page.screenshot({ path: `${SHOT_DIR}/wb-editor.png`, fullPage: false });
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MinimalTemplateEditor, {
  type EditorTabType,
  type MinimalTemplateEditorHandle,
} from '../MinimalTemplateEditor';
import type { CustomAnkiTemplate } from '@/types';

vi.mock('@uiw/react-codemirror', () => ({
  __esModule: true,
  default: React.forwardRef<unknown, { value?: string; onChange?: (v: string) => void; placeholder?: string }>(
    ({ value, onChange, placeholder }, _ref) => (
      <textarea
        data-testid="mock-codemirror"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
      />
    ),
  ),
}));

vi.mock('@/components/SharedPreview', () => ({
  IframePreview: ({ htmlContent }: { htmlContent: string }) => (
    <div data-testid="mock-iframe-preview">{htmlContent}</div>
  ),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
}));

const sampleTemplate: CustomAnkiTemplate = {
  id: 'nomenclature-test',
  name: 'The Nomenclature',
  description: 'Glossary style card',
  author: 'Anki Design',
  version: '1.0.2',
  is_active: true,
  is_built_in: false,
  note_type: 'Basic',
  fields: ['Symbol', 'Name', 'Detail'],
  preview_front: 'λ',
  preview_back: 'Wavelength',
  preview_data_json: JSON.stringify({
    Symbol: 'λ',
    Name: 'Wavelength',
    Detail: 'Distance between crests',
  }),
  front_template: '<div class="sym">{{Symbol}}</div>',
  back_template: '<div class="name">{{Name}}</div><p>{{Detail}}</p>',
  css_style: '.sym { font-weight: bold; }',
  generation_prompt: 'Generate clean glossary cards.',
  field_extraction_rules: {
    Symbol: { field_type: 'Text', is_required: true, default_value: '', description: 'Greek or math symbol' },
    Name: { field_type: 'Text', is_required: true, default_value: '', description: 'Term name' },
    Detail: { field_type: 'Text', is_required: false, default_value: '', description: 'Explanation' },
  },
  created_at: '2026-08-04T00:00:00.000Z',
  updated_at: '2026-11-08T00:00:00.000Z',
};

describe('MinimalTemplateEditor', () => {
  it('renders Basic Info with SettingsGroup structure, read-only version, standard Select, and no double asterisks', () => {
    const { container } = render(
      <MinimalTemplateEditor
        template={sampleTemplate}
        mode="edit"
        externalActiveTab="basic"
        hideSidebar
        hideFooter
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );

    // 居中限宽容器与 SettingsGroup 分组卡片
    expect(container.querySelector('.max-w-4xl')).toBeInTheDocument();
    expect(container.querySelectorAll('section > .rounded-2xl.bg-muted').length).toBeGreaterThanOrEqual(3);

    // 版本号以只读文本呈现，不再是假输入框
    expect(screen.getByText('v1.0.2')).toBeInTheDocument();

    // 不再出现双星号 "* *"
    expect(container.textContent).not.toContain('* *');

    // SelectTrigger 保留 inputShell 边框与底色（不再被洗成 bg-transparent border-transparent）
    const combobox = screen.getByRole('combobox');
    expect(combobox.className).not.toContain('border-transparent');
    expect(combobox.className).not.toContain('bg-transparent');

    // 字段列表正常渲染 3 个字段
    expect(screen.getByDisplayValue('Symbol')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Name')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Detail')).toBeInTheDocument();
  });

  it('supports Template Code split view with compact SegmentedControls and field insertion chips', () => {
    render(
      <MinimalTemplateEditor
        template={sampleTemplate}
        mode="edit"
        externalActiveTab="templates"
        hideSidebar
        hideFooter
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );

    // 代码子 Tab 分段控件与右侧预览正反面分段控件均为标准 radiogroup
    expect(screen.getAllByRole('radiogroup').length).toBe(2);
    expect(screen.getByRole('button', { name: '{{Symbol}}' })).toBeInTheDocument();
    expect(screen.getByTestId('mock-codemirror')).toBeInTheDocument();
    expect(screen.getByTestId('mock-iframe-preview')).toBeInTheDocument();
  });

  it('renders Preview Data with Form/JSON mode switch and live preview side by side', () => {
    render(
      <MinimalTemplateEditor
        template={sampleTemplate}
        mode="edit"
        externalActiveTab="data"
        hideSidebar
        hideFooter
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );

    // 默认表单视图展示字段值，右侧同步展示实时预览
    expect(screen.getByDisplayValue('λ')).toBeInTheDocument();
    expect(screen.getByTestId('mock-iframe-preview')).toBeInTheDocument();

    // 切换到 JSON 源码视图
    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[1]);
    expect(screen.getByTestId('mock-codemirror')).toBeInTheDocument();
  });

  it('renders Extraction Rules and Advanced Settings cleanly and exposes imperative submit/discard handle', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onDirtyChange = vi.fn();
    const editorRef = React.createRef<MinimalTemplateEditorHandle>();

    const Harness = () => {
      const [tab, setTab] = React.useState<EditorTabType>('rules');
      return (
        <>
          <button type="button" onClick={() => setTab('advanced')}>go-advanced</button>
          <button type="button" onClick={() => setTab('basic')}>go-basic</button>
          <MinimalTemplateEditor
            ref={editorRef}
            template={sampleTemplate}
            mode="edit"
            externalActiveTab={tab}
            onExternalTabChange={setTab}
            hideSidebar
            hideFooter
            onDirtyChange={onDirtyChange}
            onSave={onSave}
            onCancel={vi.fn()}
          />
        </>
      );
    };

    render(<Harness />);

    // 提取规则页：3 个字段与标准 Select
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox').length).toBe(3);

    // 切换到高级设置并展开完整提示词预览
    fireEvent.click(screen.getByText('go-advanced'));
    expect(screen.getByDisplayValue('Generate clean glossary cards.')).toBeInTheDocument();

    // 修改名称触发脏状态，验证 discard 与 submit 句柄
    fireEvent.click(screen.getByText('go-basic'));
    const nameInput = screen.getByDisplayValue('The Nomenclature');
    fireEvent.change(nameInput, { target: { value: 'The Nomenclature v2' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    editorRef.current?.submit();
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0][0].name).toBe('The Nomenclature v2');
  });
});

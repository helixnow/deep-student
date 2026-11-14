import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConfigForm } from '../ConfigForm';
import type { PluginConfigSchemaNode } from '../types';

vi.mock('react-i18next', async () => {
  const { i18nMock } = await import('./i18nMock');
  return i18nMock();
});

const schema: PluginConfigSchemaNode = {
  type: 'object',
  dict: {
    enabled: { type: 'boolean', meta: { default: true } },
    mode: {
      type: 'union',
      list: [
        { type: 'const', value: 'fast' },
        { type: 'const', value: 'balanced' },
      ],
      meta: { default: 'balanced' },
    },
    endpoint: { type: 'string', meta: { default: 'https://example.test' } },
    retries: { type: 'number', meta: { default: 3, min: 0, max: 10 } },
    label: { type: 'string', meta: { required: true } },
    tags: { type: 'array' },
  },
};

const baseProps = {
  pluginId: 'community.example',
  schema,
  values: {},
  revision: 4,
  onSave: vi.fn(),
};

describe('ConfigForm', () => {
  it('uses schema descriptions as readable row titles while preserving the technical key', () => {
    render(<ConfigForm {...baseProps} schema={{ type: 'object', dict: {
      autoExport: { type: 'boolean', meta: { description: '启用自动导出' } },
      endpoint: { type: 'string', meta: { description: '导出地址' } },
    } }} />);
    expect(screen.getByRole('switch', { name: '启用自动导出' })).toBeInTheDocument();
    expect(screen.getByLabelText('导出地址')).toBeInTheDocument();
    expect(screen.getByText('autoExport')).toBeInTheDocument();
  });
  it('RF-W35-config-schema-form: renders switches, segmented options, text and number inputs from the schema with defaults', () => {
    render(<ConfigForm {...baseProps} />);

    expect(screen.getByRole('switch', { name: 'enabled' })).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'balanced' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('endpoint')).toHaveValue('https://example.test');
    expect(screen.getByLabelText('retries')).toHaveValue(3);
    expect(screen.getByTestId('plugin-config-revision')).toHaveTextContent('修订号 4');
    expect(screen.getByRole('note')).toHaveTextContent('tags');
  });

  it('saves the merged form values with the revision the Host returned', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfigForm
        {...baseProps}
        values={{ label: 'keep me', unknown: 'preserved' }}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole('switch', { name: 'enabled' }));
    await user.click(screen.getByRole('radio', { name: 'fast' }));
    await user.clear(screen.getByLabelText('endpoint'));
    await user.type(screen.getByLabelText('endpoint'), 'https://changed.test');
    await user.clear(screen.getByLabelText('retries'));
    await user.type(screen.getByLabelText('retries'), '7');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        mode: 'fast',
        endpoint: 'https://changed.test',
        retries: 7,
        label: 'keep me',
        unknown: 'preserved',
      }),
      4,
    );
  });

  it('blocks saving and marks the field when a required string is empty', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<ConfigForm {...baseProps} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/label/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('此项必填')).toBeInTheDocument();
  });

  it('rejects a non-numeric number instead of silently dropping it', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<ConfigForm {...baseProps} values={{ label: 'x', retries: 'oops' }} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText('retries')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('需要是数字')).toBeInTheDocument();
  });

  it('shows a revision conflict with a reload action and keeps the draft editable', async () => {
    const onReload = vi.fn();
    const user = userEvent.setup();
    render(<ConfigForm {...baseProps} values={{ label: 'x' }} conflict message="revision 5" onReload={onReload} />);

    expect(screen.getByTestId('plugin-config-conflict')).toBeInTheDocument();
    expect(screen.getByLabelText('endpoint')).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '重新读取' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('renders Host-side field issues next to the matching field', () => {
    render(
      <ConfigForm
        {...baseProps}
        values={{ label: 'x' }}
        issues={[{ field: 'endpoint', message: 'endpoint is not reachable' }]}
        message="invalid config: endpoint is not reachable"
      />,
    );

    expect(screen.getByText('endpoint is not reachable')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
  });

  it('waits for the Host when saving', () => {
    render(<ConfigForm {...baseProps} values={{ label: 'x' }} saving />);

    expect(screen.getByRole('button', { name: '保存中' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'enabled' })).toBeInTheDocument();
  });

  it('reports the empty configuration state without inventing fields', async () => {
    render(<ConfigForm {...baseProps} schema={null} values={{ arbitrary: 1 }} onSave={vi.fn()} />);

    expect(screen.getByText('该插件没有可编辑的配置项')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('switch')).toBeNull());
  });
});

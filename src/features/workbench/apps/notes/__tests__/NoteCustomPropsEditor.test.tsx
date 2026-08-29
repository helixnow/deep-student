import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  NOTE_PROPS_MAX_COUNT,
  NOTE_PROP_KEY_MAX_CHARS,
  NOTE_PROP_VALUE_MAX_CHARS,
  NoteCustomPropsEditor,
  validateNoteProp,
} from '../NoteCustomPropsEditor';

describe('validateNoteProp', () => {
  it('accepts a plain new key-value pair', () => {
    expect(validateNoteProp('status', 'done', [])).toBeNull();
  });

  it('rejects empty, reserved, duplicate, and oversized keys', () => {
    expect(validateNoteProp('   ', 'x', [])).toBe('empty_key');
    expect(validateNoteProp('Tags', 'x', [])).toBe('reserved_key');
    expect(validateNoteProp('PATH', 'x', [])).toBe('reserved_key');
    expect(validateNoteProp('Status', 'x', ['status'])).toBe('duplicate_key');
    expect(validateNoteProp('k'.repeat(NOTE_PROP_KEY_MAX_CHARS + 1), 'x', [])).toBe('key_too_long');
    expect(validateNoteProp('key', 'v'.repeat(NOTE_PROP_VALUE_MAX_CHARS + 1), [])).toBe('value_too_long');
    expect(validateNoteProp('key\u0007', 'x', [])).toBe('invalid_chars');
  });

  it('enforces the max count only for new keys, not while editing', () => {
    const full = Array.from({ length: NOTE_PROPS_MAX_COUNT }, (_, index) => `k${index}`);
    expect(validateNoteProp('overflow', 'x', full)).toBe('too_many');
    expect(validateNoteProp('k0', 'updated', full, { excludeKey: 'k0' })).toBeNull();
  });
});

describe('NoteCustomPropsEditor', () => {
  it('lists current props and adds a new pair through the inline form', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<NoteCustomPropsEditor value={{ status: 'draft' }} onChange={onChange} />);

    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加属性' }));
    fireEvent.change(screen.getByLabelText('属性名'), { target: { value: 'source' } });
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'lecture 3' } });
    // 添加表单展开后出现确认按钮（与展开入口同名）
    const confirmButtons = screen.getAllByRole('button', { name: '添加属性' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ status: 'draft', source: 'lecture 3' });
    });
  });

  it('blocks reserved keys with an inline error and does not call onChange', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<NoteCustomPropsEditor value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '添加属性' }));
    fireEvent.change(screen.getByLabelText('属性名'), { target: { value: 'tags' } });
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'x' } });
    const confirmButtons = screen.getAllByRole('button', { name: '添加属性' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(await screen.findByRole('alert')).toHaveTextContent('保留字');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('edits an existing value and deletes a property', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<NoteCustomPropsEditor value={{ status: 'draft', due: 'friday' }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑属性 status' }));
    fireEvent.change(screen.getByLabelText('编辑属性 status 的值'), { target: { value: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: '保存属性值' }));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ status: 'done', due: 'friday' });
    });

    fireEvent.click(screen.getByRole('button', { name: '删除属性 due' }));
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({ status: 'draft' });
    });
  });

  it('surfaces backend save failures and keeps the form open', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('属性数量超出上限（最多 32 个）'));
    render(<NoteCustomPropsEditor value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '添加属性' }));
    fireEvent.change(screen.getByLabelText('属性名'), { target: { value: 'status' } });
    const confirmButtons = screen.getAllByRole('button', { name: '添加属性' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(await screen.findByRole('alert')).toHaveTextContent('属性数量超出上限');
    // 表单未收起，用户可以修正后重试
    expect(screen.getByLabelText('属性名')).toBeInTheDocument();
  });

  it('renders read-only without add or edit affordances', () => {
    render(<NoteCustomPropsEditor value={{ status: 'draft' }} readOnly onChange={vi.fn()} />);
    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加属性' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑属性 status' })).toBeNull();
  });
});

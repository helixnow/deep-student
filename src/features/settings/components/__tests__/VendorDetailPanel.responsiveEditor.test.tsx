import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApisTab } from '../ApisTab';
import type { ApiConfig, ModelProfile, VendorConfig } from '@/types';

const breakpointMock = vi.hoisted(() => ({ isXl: false }));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isXl: breakpointMock.isXl }),
}));

vi.mock('../ShadApiEditModal', async () => {
  const { useState } = await import('react');
  return {
    ShadApiEditModal: ({ api: editorApi }: { api: ApiConfig }) => {
      const [name, setName] = useState(editorApi.name);
      return (
        <input
          aria-label="common:api_config_modal.config_name"
          value={name}
          onChange={event => setName(event.target.value)}
        />
      );
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
}));

const vendor: VendorConfig = {
  id: 'vendor-openai',
  name: 'OpenAI',
  providerType: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
};

const profile = {
  id: 'profile-gpt-5',
  vendorId: vendor.id,
  label: 'GPT-5',
  model: 'gpt-5',
  enabled: true,
  status: 'enabled',
  isReasoning: true,
  supportsTools: true,
} as ModelProfile;

const api = {
  id: profile.id,
  name: profile.label,
  model: profile.model,
  apiKey: '',
  baseUrl: vendor.baseUrl,
  enabled: true,
  modelAdapter: 'general',
  isReasoning: true,
  supportsTools: true,
} as ApiConfig;

interface RenderSubjectOptions {
  inlineEditState?: { profileId: string; api: ApiConfig } | null;
  isAddingNewModel?: boolean;
}

function renderSubject(options: RenderSubjectOptions = {}) {
  const callbacks = {
    handleOpenModelEditor: vi.fn(),
    setInlineEditState: vi.fn(),
    handleAddModelInline: vi.fn(),
    handleCancelAddModel: vi.fn(),
  };
  const noop = vi.fn();

  const renderApisTab = (nextOptions: RenderSubjectOptions = options) => (
    <ApisTab
      vendors={[vendor]}
      sortedVendors={[vendor]}
      selectedVendor={vendor}
      selectedVendorId={vendor.id}
      setSelectedVendorId={noop}
      selectedVendorModels={[{ profile, api }]}
      selectedVendorIsSiliconflow={false}
      profileCountByVendor={new Map([[vendor.id, 1]])}
      vendorBusy={false}
      vendorSaving={false}
      isEditingVendor={false}
      vendorFormData={{}}
      setVendorFormData={noop}
      testingApi={null}
      handleOpenVendorModal={noop}
      handleStartEditVendor={noop}
      handleCancelEditVendor={noop}
      handleSaveEditVendor={noop}
      handleDeleteVendor={noop}
      handleSaveVendorBaseUrl={noop}
      handleSaveVendorApiKey={noop}
      handleClearVendorApiKey={noop}
      handleOpenModelEditor={callbacks.handleOpenModelEditor}
      inlineEditState={nextOptions.inlineEditState ?? null}
      setInlineEditState={callbacks.setInlineEditState}
      handleSaveInlineEdit={vi.fn(async () => undefined)}
      isAddingNewModel={nextOptions.isAddingNewModel ?? false}
      handleAddModelInline={callbacks.handleAddModelInline}
      handleCancelAddModel={callbacks.handleCancelAddModel}
      convertProfileToApiConfig={() => api}
      handleToggleModelProfile={noop}
      handleDeleteModelProfile={noop}
      handleToggleFavorite={noop}
      testApiConnection={vi.fn(async () => undefined)}
      handleSiliconFlowConfig={noop}
      handleBatchCreateConfigs={noop}
      handleBatchConfigsCreated={noop}
      onReorderVendors={noop}
    />
  );
  const rendered = render(renderApisTab());

  return {
    ...callbacks,
    rerender: (nextOptions: RenderSubjectOptions = options) => {
      rendered.rerender(renderApisTab(nextOptions));
    },
  };
}

function clickModelEdit() {
  const editButtons = screen.getAllByTitle('common:actions.edit');
  fireEvent.click(editButtons[editButtons.length - 1]);
}

describe('VendorDetailPanel responsive model editor', () => {
  beforeEach(() => {
    breakpointMock.isXl = false;
  });

  it('opens the dialog editor instead of the squeezed inline editor below xl', () => {
    const callbacks = renderSubject();

    clickModelEdit();

    expect(callbacks.handleOpenModelEditor).toHaveBeenCalledWith(vendor, profile);
    expect(callbacks.setInlineEditState).toHaveBeenCalledWith(null);
  });

  it('opens new models in the dialog editor below xl', () => {
    const callbacks = renderSubject();

    fireEvent.click(screen.getByRole('button', { name: 'settings:vendor_panel.add_model_button' }));

    expect(callbacks.handleOpenModelEditor).toHaveBeenCalledWith(vendor);
    expect(callbacks.setInlineEditState).toHaveBeenCalledWith(null);
    expect(callbacks.handleAddModelInline).not.toHaveBeenCalled();
  });

  it('keeps the inline editor on xl and wider screens', () => {
    breakpointMock.isXl = true;
    const callbacks = renderSubject();

    clickModelEdit();

    expect(callbacks.handleOpenModelEditor).not.toHaveBeenCalled();
    expect(callbacks.setInlineEditState).toHaveBeenCalledWith({
      profileId: profile.id,
      api: expect.objectContaining({ model: profile.model }),
    });
  });

  it('keeps new models in the inline editor on xl and wider screens', () => {
    breakpointMock.isXl = true;
    const callbacks = renderSubject();

    fireEvent.click(screen.getByRole('button', { name: 'settings:vendor_panel.add_model_button' }));

    expect(callbacks.handleAddModelInline).toHaveBeenCalledWith(vendor);
    expect(callbacks.handleOpenModelEditor).not.toHaveBeenCalled();
  });

  it('floats an active inline edit below xl without losing unsaved form state', () => {
    breakpointMock.isXl = true;
    const callbacks = renderSubject({
      inlineEditState: { profileId: profile.id, api },
    });
    const nameInput = screen.getByLabelText('common:api_config_modal.config_name');
    fireEvent.change(nameInput, { target: { value: 'Unsaved GPT name' } });

    breakpointMock.isXl = false;
    callbacks.rerender({ inlineEditState: { profileId: profile.id, api } });

    const editorShell = screen.getByTestId(`responsive-inline-model-editor-${profile.id}`);
    expect(editorShell).toHaveClass('fixed');
    expect(editorShell.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByTestId(`responsive-inline-model-editor-surface-${profile.id}`)).toHaveClass('max-w-[672px]');
    expect(screen.getByLabelText('common:api_config_modal.config_name')).toHaveValue('Unsaved GPT name');
    expect(callbacks.handleOpenModelEditor).not.toHaveBeenCalled();
  });

  it('floats an active inline new-model form below xl without remounting it', () => {
    const newModelApi = { ...api, id: 'new-model', name: 'Unsaved new model', model: '' };
    breakpointMock.isXl = true;
    const callbacks = renderSubject({
      inlineEditState: { profileId: newModelApi.id, api: newModelApi },
      isAddingNewModel: true,
    });
    const nameInput = screen.getByLabelText('common:api_config_modal.config_name');
    fireEvent.change(nameInput, { target: { value: 'Edited new model' } });

    breakpointMock.isXl = false;
    callbacks.rerender({
      inlineEditState: { profileId: newModelApi.id, api: newModelApi },
      isAddingNewModel: true,
    });

    const editorShell = screen.getByTestId('responsive-inline-new-model-editor');
    expect(editorShell).toHaveClass('fixed');
    expect(editorShell.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByTestId('responsive-inline-new-model-editor-surface')).toHaveClass('max-w-[672px]');
    expect(screen.getByLabelText('common:api_config_modal.config_name')).toHaveValue('Edited new model');
    expect(callbacks.handleOpenModelEditor).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { VendorApiKeySection } from '@/features/settings';

const vendor = {
  id: 'vendor-1',
  name: 'Vendor',
  providerType: 'openai',
  baseUrl: 'https://example.test/v1',
  headers: {},
};

test('renders API key reveal as an inline input-group control', async ({ mount }) => {
  const component = await mount(
    <div style={{ width: 360, padding: 24 }}>
      <VendorApiKeySection
        vendor={{ ...vendor, apiKey: 'sk-test' }}
        onSave={() => undefined}
        onClear={() => undefined}
      />
    </div>
  );

  const shell = component.locator('[data-api-key-field]');
  const input = shell.locator('input');
  const revealButton = shell.getByRole('button', { name: 'settings:vendor_panel.show_api_key' });

  await expect(shell).toBeVisible();
  await expect(input).toBeVisible();
  await expect(revealButton).toBeVisible();

  const metrics = await shell.evaluate(element => {
    const inputElement = element.querySelector('input');
    const buttonElement = element.querySelector('button');
    if (!inputElement || !buttonElement) {
      throw new Error('Expected API key field to contain input and button');
    }

    const shellStyle = window.getComputedStyle(element);
    const inputStyle = window.getComputedStyle(inputElement);
    const buttonStyle = window.getComputedStyle(buttonElement);
    const shellRect = element.getBoundingClientRect();
    const buttonRect = buttonElement.getBoundingClientRect();

    return {
      buttonPosition: buttonStyle.position,
      inputBorderWidth: inputStyle.borderWidth,
      inputPaddingLeft: inputStyle.paddingLeft,
      inputPaddingRight: inputStyle.paddingRight,
      shellOverflow: shellStyle.overflow,
      shellRadius: shellStyle.borderTopRightRadius,
      shellRight: Math.round(shellRect.right),
      buttonRight: Math.round(buttonRect.right),
    };
  });

  expect(metrics.buttonPosition).not.toBe('absolute');
  expect(metrics.inputBorderWidth).toBe('0px');
  expect(metrics.inputPaddingRight).toBe(metrics.inputPaddingLeft);
  expect(metrics.shellOverflow).toBe('hidden');
  expect(metrics.shellRadius).toBe('12px');
  expect(Math.abs(metrics.buttonRight - metrics.shellRight)).toBeLessThanOrEqual(1);
  await expect(revealButton).toHaveClass(/api-key-field__toggle/);
  await expect(revealButton).not.toHaveClass(/rounded-\[var\(--button-radius\)\]/);
});

test('does not reserve reveal-button padding for masked configured keys', async ({ mount }) => {
  const component = await mount(
    <div style={{ width: 360, padding: 24 }}>
      <VendorApiKeySection
        vendor={{ ...vendor, apiKey: '***' }}
        onSave={() => undefined}
        onClear={() => undefined}
      />
    </div>
  );

  const shell = component.locator('[data-api-key-field]');
  const input = shell.locator('input');

  await expect(shell.getByRole('button', { name: 'settings:vendor_panel.show_api_key' })).toHaveCount(0);
  await expect(input).toBeVisible();

  const padding = await input.evaluate(element => {
    const style = window.getComputedStyle(element);
    return {
      left: style.paddingLeft,
      right: style.paddingRight,
    };
  });
  expect(padding.right).toBe(padding.left);
});

import type { Context } from '../../kernel/api.ts';
import { cloudCommandAccess, registerCloudCredentialCommands } from './cloud-commands.ts';
import { SecretPromptStore, secretPromptCapabilities, submitSecretPrompt } from './secret-prompt.ts';

export function registerCommands(ctx: Context) {
  const access = cloudCommandAccess(ctx);
  const { store, mapped, serial } = access;
  registerCloudCredentialCommands(ctx, access);
  ctx.commands.register('secure_store_is_available', () => serial(() => store.isAvailable()));
  ctx.commands.register('secure_store_get_keystore_protection', () => serial(() => mapped('get_keystore_protection', () => store.keystoreProtectionStatus())));
  ctx.commands.register('secure_store_set_keystore_protection', ({ enabled }) => serial(async () => {
    await mapped('set_keystore_protection', () => store.setKeystoreProtection(enabled as boolean));
    return mapped('get_keystore_protection', () => store.keystoreProtectionStatus());
  }));
  const prompts = new SecretPromptStore();
  ctx.effect(() => () => prompts.dispose());
  ctx.commands.register('secret_prompt_submit', submitSecretPrompt);
  ctx.commands.register('secret_prompt_status', ({ handleId }) => ({ available: prompts.contains(handleId as string), consumerAvailable: false, reasonCode: 'DECRYPTOR_INTEGRATION_UNAVAILABLE' }));
  ctx.commands.register('secret_prompt_discard', ({ handleId }) => prompts.discard(handleId as string));
  ctx.commands.register('secret_prompt_capabilities', secretPromptCapabilities);
}

import type { InvocationContext, PluginDefinition } from '../../plugin-runtime/host.js';
import type { TranslationHost } from '../../plugin-runtime/contracts/translationHost.js';
import type { TranslationRequest } from '../../plugin-runtime/contracts/translation.js';
import { runTranslation } from './engine.js';

export interface TranslationHostFactory {
  create(request: TranslationRequest, context: InvocationContext): TranslationHost;
}

/** Official and user providers go through exactly the same composition API. */
export const translationPlugin: PluginDefinition = {
  manifest: {
    id: 'official.translation', apiVersion: 1,
    provides: ['translation@1'], requires: ['platform.translation@1'],
  },
  activate(context) {
    const platform = context.use<TranslationHostFactory>('platform.translation@1');
    context.provide('translation@1', {
      translate: async (input, invocation) => {
        const request = input as TranslationRequest;
        return runTranslation(request, platform.create(request, invocation));
      },
    });
  },
};

export default translationPlugin;

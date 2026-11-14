import { definePlugin } from '../../kernel/api.ts';
import { AppCommandStateService } from './src/app-state.ts';

export default definePlugin({
  meta: {
    id: 'dstu.integration',
    lane: 'L22-app-commands',
    commands: [],
    provides: ['appCommandState'],
    platforms: ['desktop', 'mobile'],
  },
  inject: ['storage'],
  apply(ctx) {
    new AppCommandStateService(ctx);
  },
});

/**
 * Smoke fixture (⑫): a stand-in for `dstu.anki` whose `apply` throws, loaded through a user profile
 * (`<dataDir>/plugins/user.profile.json`). The profile file itself is valid, so the kernel isolates the
 * failure: `dstu.anki` (and whatever injects its `anki` service) is reported degraded instead of the Host
 * falling back to the official profile.
 */
import { definePlugin } from '../../../kernel/api.ts';

export default definePlugin({
  name: 'dstu.anki',
  meta: { id: 'dstu.anki', lane: 'W12-smoke', provides: ['anki'], commands: [] },
  inject: ['paths', 'storage'],
  apply() {
    throw new Error('W12 smoke: dstu.anki apply failed on purpose');
  },
});

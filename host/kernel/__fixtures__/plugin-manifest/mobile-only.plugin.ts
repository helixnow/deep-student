/** 官方夹具：只声明移动端，桌面 profile 装载时应降级为 UNSUPPORTED_ON_PLATFORM。 */
import { definePlugin } from '../../api.ts';

export default definePlugin({
  meta: { id: 'fixture.manifest-mobile-only', lane: 'W01-test', platforms: ['mobile'] },
  apply() {
    (globalThis as { __w01ManifestApplied?: string[] }).__w01ManifestApplied?.push('fixture.manifest-mobile-only');
  },
});

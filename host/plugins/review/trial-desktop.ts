/** Only the isolated desktop launcher selects this plugin in its own profile. */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createReviewTrialPlugin } from './index.ts';

const review = createReviewTrialPlugin();
export default {
  ...review,
  apply(ctx: Parameters<typeof review.apply>[0], config: void) {
    const data = realpathSync(ctx.app.dataDir);
    const root = dirname(data);
    if (!ctx.app.debug || basename(data) !== 'data' || !basename(root).startsWith('dstu-fsrs7-desktop-')
      || dirname(root) !== realpathSync(tmpdir()) || process.env.DS_HOST_PROFILE !== join(root, 'profile.json')
      || process.env.DS_APP_DATA_DIR !== data) {
      throw new Error('FSRS-7 desktop requires the isolated local trial launcher');
    }
    return review.apply(ctx, config);
  },
};

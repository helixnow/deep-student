import type { Context } from '@deepseek-ai/cordis';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

/** Root assembly supplies feature implementations; the paired plugin retains its real caller. */
export const workshopContributions = createLazyContributionPoint<(ctx: Context) => void>('workshop.assembly');

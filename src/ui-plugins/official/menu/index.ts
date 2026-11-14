import { defineUiPlugin } from '@/ui-sdk';
import { APP_MENU_SLOT, appMenuContributions } from './appMenu';
import { resourceMenuContributions } from './resourceMenu';

/**
 * Application menus (FE-B9): owns `app.menu` and the `resource.contextMenu` rows of the notes workspace tree; the
 * official rows load with the workbench menu bar, the resource library and the notes workspace.
 */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.menu', core: true },
  apply(ctx) {
    ctx.ui.declareSlot(APP_MENU_SLOT);
    ctx.ui.attach(appMenuContributions, (entry) => ctx.ui.contribute('app.menu', entry));
    ctx.ui.attach(resourceMenuContributions, (entry) => ctx.ui.contribute('resource.contextMenu', entry));
  },
}), { order: 80 });

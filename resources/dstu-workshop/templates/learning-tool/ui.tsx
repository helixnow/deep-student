import React from 'react';
import { defineUiPlugin } from '@deepstudent/ui';

function LearningTool({ load }: { load: () => Promise<{ word: string; meaning: string }> }) {
  const [word, setWord] = React.useState<{ word: string; meaning: string } | null>(null);
  React.useEffect(() => {
    let active = true;
    void load().then(value => { if (active) setWord(value); });
    return () => { active = false; };
  }, [load]);
  return <section style={{ color: 'hsl(var(--foreground))' }}><h2>{word?.word ?? '…'}</h2><p>{word?.meaning}</p></section>;
}

export default defineUiPlugin({
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', host: true },
  apply(ctx) {
    ctx.ui.i18n.addBundles({ 'zh-CN': { title: '每日回忆' }, 'en-US': { title: 'Daily recall' } });
    const load = () => ctx.ui.host.__SERVICE__.today() as Promise<{ word: string; meaning: string }>;
    ctx.ui.views.register({ id: 'recall', titleKey: 'title', component: () => <LearningTool load={load} /> });
    ctx.ui.nav.register({ id: 'recall', viewId: 'recall', labelKey: 'title', order: 100 });
  },
});

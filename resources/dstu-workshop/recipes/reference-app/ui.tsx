// Recipe (UI half): a reference app in the learning-tool shape — an app view with a search box, a category filter
// and a list whose rows show a name, a category badge, the formula and a one-line note.
//
// - Build the look from @deepstudent/ui pieces: DsSearchInput, SegmentedControl, DsCard + DsListItem, DsBadge and
//   MathText. They follow the app theme (light/dark, accent) without CSS of your own; Tailwind classes written in a
//   plugin are not compiled, so for spacing use inline styles and colors as hsl(var(--foreground)) etc.
// - MathText renders LaTeX safely (KaTeX, loaded on demand): `tex` is one formula, `text` is prose with $…$ inside.
//   A formula that does not parse shows its source; never put formulas into dangerouslySetInnerHTML yourself.
// - Load the data once from the Host half, filter in the component; show a short line while loading or empty.
import React from 'react';
import { defineUiPlugin, DsBadge, DsCard, DsListItem, DsSearchInput, MathText, SegmentedControl } from '@deepstudent/ui';

interface Formula { id: string; name: string; category: string; tex: string; note: string }
const ALL = '全部';

function FormulaReference({ load }: { load: () => Promise<Formula[]> }) {
  const [formulas, setFormulas] = React.useState<Formula[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState(ALL);
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    load().then(list => { if (active) setFormulas(list); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [load]);

  const categories = React.useMemo(() => [ALL, ...new Set((formulas ?? []).map(item => item.category))], [formulas]);
  const shown = React.useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (formulas ?? []).filter(item => (category === ALL || item.category === category)
      && words.every(word => `${item.name} ${item.category} ${item.note} ${item.tex}`.toLowerCase().includes(word)));
  }, [formulas, query, category]);

  const muted = { margin: 0, padding: '24px 0', textAlign: 'center' as const, fontSize: 14, color: 'hsl(var(--muted-foreground))' };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, margin: '0 auto', padding: 24, color: 'hsl(var(--foreground))' }}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>公式速查</h2>
      <DsSearchInput value={query} onChange={setQuery} placeholder="搜索公式名称、分类或说明" />
      {categories.length > 2 && (
        <SegmentedControl ariaLabel="分类" size="compact" value={category} onValueChange={setCategory}
          options={categories.map(value => ({ value, label: value }))} />
      )}
      <DsCard flush style={{ padding: 4 }}>
        {failed ? <p role="alert" style={muted}>数据没有读出来，请重新打开试试</p>
          : !formulas ? <p style={muted}>正在加载…</p>
            : !shown.length ? <p style={muted}>没有找到「{query.trim()}」相关的公式</p>
              : shown.map(item => (
                <DsListItem key={item.id} title={item.name} trailing={<DsBadge>{item.category}</DsBadge>}
                  description={openId === item.id ? item.note : undefined}
                  selected={openId === item.id} onClick={() => setOpenId(openId === item.id ? null : item.id)}>
                  <MathText tex={item.tex} display />
                </DsListItem>
              ))}
      </DsCard>
      <p style={{ margin: 0, fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>点一条公式查看说明</p>
    </section>
  );
}

export default defineUiPlugin({
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', host: true },
  apply(ctx) {
    ctx.ui.i18n.addBundles({ 'zh-CN': { title: '公式速查' }, 'en-US': { title: 'Formula reference' } });
    const load = () => ctx.ui.host.__SERVICE__.list() as Promise<Formula[]>;
    ctx.ui.views.register({ id: 'formulas', titleKey: 'title', component: () => <FormulaReference load={load} /> });
    ctx.ui.nav.register({ id: 'formulas', viewId: 'formulas', labelKey: 'title', order: 100 });
  },
});

import { useMemo, useState } from 'react';
import { Thumb } from './Inventory';
import { amountText, api, attempt, fmtNum, matches, promptDialog, shareText, toast, useLoad, type Item, type ShoppingItem } from './lib';

export function Shopping() {
  const { data, reload } = useLoad<ShoppingItem[]>('/shopping');
  // Alles, was je im Vorrat war: Daraus kommen die Vorschläge beim Tippen
  const catalog = useLoad<Item[]>('/items/catalog');
  const [text, setText] = useState('');
  const open = (data || []).filter((i) => !i.done);
  const done = (data || []).filter((i) => i.done);
  const hits = useMemo(() => (text.trim() ? (catalog.data || []).filter((i) => matches(i, text)).slice(0, 8) : []), [catalog.data, text]);

  async function add(body: { name: string; item_id?: number }) {
    if (!body.name.trim()) return;
    const r = await attempt(() => api('/shopping', { body }));
    if (r && !r.added) toast('Steht schon auf der Liste');
    setText(''); reload();
  }
  async function toggle(i: ShoppingItem) {
    const r = await attempt(() => api(`/shopping/${i.id}`, { method: 'PATCH', body: { done: !i.done } }));
    if (r?.stocked) toast(`„${i.name}“ ist jetzt im Vorrat`);
    else if (r && i.done && i.stocked_item_id) toast('Wieder aus dem Vorrat genommen');
    reload();
  }
  /** Packungsgröße ändern, z. B. wenn es die Packung jetzt mit 750 statt 500 g gibt */
  async function setPack(i: ShoppingItem) {
    const v = await promptDialog(`Packungsgröße ${i.name}`, { text: 'Wie viel kommt beim Abhaken in den Vorrat?', value: fmtNum(i.package_amount || 0), inputMode: 'decimal', suffix: i.unit || '', ok: 'Übernehmen' });
    if (v === null) return;
    const n = Number(v.replace(',', '.'));
    if (!(n > 0)) return toast('Bitte eine Zahl eingeben');
    await attempt(() => api(`/shopping/${i.id}`, { method: 'PATCH', body: { pack_amount: n } }));
    reload();
  }
  const pack = (i: ShoppingItem) => (i.unit === '%' || !i.package_amount ? '1 Packung' : `${fmtNum(i.package_amount)} ${i.unit}`);
  const row = (i: ShoppingItem) => (
    <label key={i.id} className={'list-row check' + (i.done ? ' done' : '')}>
      <input type="checkbox" checked={!!i.done} onChange={() => toggle(i)} />
      <div className="grow">
        <span>{i.name}{i.amount && <span className="muted"> · {i.amount}</span>}</span>
        {i.item_id && !i.done && (
          <div className="muted">
            {i.unit === '%' ? pack(i) : <button type="button" className="pack-edit" onClick={(e) => { e.preventDefault(); setPack(i); }}>{pack(i)} ✎</button>} · kommt beim Abhaken in den Vorrat
          </div>
        )}
        {!!i.done && i.stocked_item_id && <div className="muted">{pack(i)} im Vorrat ergänzt</div>}
      </div>
      <button className="icon-btn" aria-label="Löschen" onClick={async (e) => { e.preventDefault(); await attempt(() => api(`/shopping/${i.id}`, { method: 'DELETE' })); reload(); }}>✕</button>
    </label>
  );
  return (
    <>
      <form className="row toolbar" onSubmit={(e) => { e.preventDefault(); add({ name: text }); }}>
        <input type="search" placeholder="Was fehlt? Vorrat durchsuchen oder eintippen" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="done" />
        <button className="btn primary">Dazu</button>
      </form>
      {hits.length > 0 && (
        <div className="list suggest">
          {hits.map((i) => (
            <button key={i.id} className="list-row" onClick={() => add({ name: i.name, item_id: i.id })}>
              <Thumb name={i.name} category={i.category} />
              <div className="grow">
                <strong className="ellipsis">{i.name}</strong>
                <div className="muted ellipsis">{[i.brand, i.consumed_at ? 'aufgebraucht' : `noch ${amountText(i)}`].filter(Boolean).join(' · ')}</div>
              </div>
              <span className="plus" aria-hidden>＋</span>
            </button>
          ))}
        </div>
      )}
      {data && !data.length && !text && <p className="empty">Die Einkaufsliste ist leer.</p>}
      {open.length > 0 && (
        <div className="row between section-head">
          <span className="lbl">Offen ({open.length})</span>
          <button className="link" onClick={() => shareText('Einkaufsliste', `Einkaufsliste:\n${open.map((i) => `- ${i.name}${i.amount ? ` (${i.amount})` : i.item_id && i.unit !== '%' && i.package_amount ? ` (${fmtNum(i.package_amount)} ${i.unit})` : ''}`).join('\n')}`)}>Teilen</button>
        </div>
      )}
      <div className="list">{open.map(row)}</div>
      {done.length > 0 && (
        <>
          <div className="row between section-head">
            <span className="lbl">Erledigt ({done.length})</span>
            <button className="link" onClick={async () => { await attempt(() => api('/shopping/clear-done', { body: {} })); reload(); }}>Erledigte löschen</button>
          </div>
          <div className="list">{done.map(row)}</div>
        </>
      )}
    </>
  );
}

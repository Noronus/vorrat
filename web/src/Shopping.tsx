import { useState } from 'react';
import { api, attempt, useLoad, type ShoppingItem } from './lib';

export function Shopping() {
  const { data, reload } = useLoad<ShoppingItem[]>('/shopping');
  const [text, setText] = useState('');
  const open = (data || []).filter((i) => !i.done);
  const done = (data || []).filter((i) => i.done);

  async function add() {
    if (!text.trim()) return;
    await attempt(() => api('/shopping', { body: { name: text } }));
    setText(''); reload();
  }
  const toggle = async (i: ShoppingItem) => { await attempt(() => api(`/shopping/${i.id}`, { method: 'PATCH', body: { done: !i.done } })); reload(); };
  const row = (i: ShoppingItem) => (
    <label key={i.id} className={'list-row check' + (i.done ? ' done' : '')}>
      <input type="checkbox" checked={!!i.done} onChange={() => toggle(i)} />
      <span className="grow">{i.name}{i.amount && <span className="muted"> · {i.amount}</span>}</span>
      <button className="icon-btn" aria-label="Löschen" onClick={async (e) => { e.preventDefault(); await attempt(() => api(`/shopping/${i.id}`, { method: 'DELETE' })); reload(); }}>✕</button>
    </label>
  );
  return (
    <>
      <form className="row toolbar" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input placeholder="Was fehlt?" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="done" />
        <button className="btn primary">Dazu</button>
      </form>
      {data && !data.length && <p className="empty">Die Einkaufsliste ist leer.</p>}
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

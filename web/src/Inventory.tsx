import { useMemo, useState } from 'react';
import { iconFor } from './icons';
import { ItemEditor } from './ItemEditor';
import { amountText, daysUntil, expiry, Sheet, type Item } from './lib';

/** Symbol passend zum Lebensmittel, sonst der Anfangsbuchstabe */
export function Thumb({ name, category, big }: { name: string; category?: string | null; big?: boolean }) {
  const icon = iconFor(name, category);
  return <div className={'thumb' + (icon ? ' emoji' : '') + (big ? ' big' : '')} aria-hidden>{icon || name.trim().slice(0, 1).toUpperCase() || '?'}</div>;
}

export function Inventory({ items, reload, onScan }: { items: Item[] | null; reload: () => void; onScan: () => void }) {
  const [q, setQ] = useState('');
  const [loc, setLoc] = useState<'soon' | null>(null);
  const [edit, setEdit] = useState<Item | null>(null);

  const soonCount = useMemo(() => (items || []).filter((i) => i.expires_on && daysUntil(i.expires_on) <= 5).length, [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items || []).filter((i) =>
      (loc === null || (i.expires_on && daysUntil(i.expires_on) <= 5)) &&
      (!needle || i.name.toLowerCase().includes(needle) || (i.brand || '').toLowerCase().includes(needle)));
  }, [items, q, loc]);

  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Im Vorrat suchen" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips scroll">
          <button className={'chip' + (loc === null ? ' on' : '')} onClick={() => setLoc(null)}>Alles</button>
          {soonCount > 0 && <button className={'chip warn' + (loc === 'soon' ? ' on' : '')} onClick={() => setLoc('soon')}>Läuft ab · {soonCount}</button>}
        </div>
      </div>

      {items && !items.length ? (
        <div className="empty">
          <p>Dein Vorrat ist noch leer.</p>
          <button className="btn primary" onClick={onScan}>Erstes Produkt scannen</button>
        </div>
      ) : (
        <div className="list grid">
          {shown.map((i) => {
            const ex = expiry(i.expires_on);
            const pct = Math.round((i.remaining_amount / (i.package_amount * i.count)) * 100);
            return (
              <button key={i.id} className="list-row item" onClick={() => setEdit(i)}>
                <Thumb name={i.name} category={i.category} />
                <div className="grow">
                  <div className="row between">
                    <strong className="ellipsis">{i.name}</strong>
                    {ex.text && <span className={'badge ' + ex.level}>{ex.text}</span>}
                  </div>
                  <div className="muted ellipsis">{amountText(i)}</div>
                  <div className="bar"><div style={{ width: `${pct}%` }} className={pct <= 25 ? 'low' : ''} /></div>
                </div>
              </button>
            );
          })}
          {items && !shown.length && <p className="muted center">Nichts gefunden.</p>}
        </div>
      )}

      {edit && (
        <Sheet title={edit.name} onClose={() => setEdit(null)}>
          <ItemEditor initial={edit} onDone={() => { setEdit(null); reload(); }} />
        </Sheet>
      )}
    </>
  );
}

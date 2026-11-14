import { useMemo, useState } from 'react';
import { iconFor } from './icons';
import { ItemEditor } from './ItemEditor';
import { amountText, daysUntil, expiry, matches, Sheet, type Item } from './lib';

/** Symbol passend zum Lebensmittel, sonst der Anfangsbuchstabe */
export function Thumb({ name, category, big }: { name: string; category?: string | null; big?: boolean }) {
  const icon = iconFor(name, category);
  // Jedes Lebensmittel bekommt einen festen Farbton, damit die Liste nicht einfarbig wirkt
  let sum = 0;
  for (const c of name) sum = (sum * 31 + c.charCodeAt(0)) % 997;
  const hue = [28, 48, 95, 150, 200, 265, 340][sum % 7];
  return <div className={'thumb' + (icon ? ' emoji' : '') + (big ? ' big' : '')} style={{ '--h': hue } as React.CSSProperties} aria-hidden>{icon || name.trim().slice(0, 1).toUpperCase() || '?'}</div>;
}

export function Inventory({ items, reload, onScan }: { items: Item[] | null; reload: () => void; onScan: () => void }) {
  const [q, setQ] = useState('');
  const [loc, setLoc] = useState<'soon' | 'low' | null>(null);
  const [edit, setEdit] = useState<Item | null>(null);

  const soonCount = useMemo(() => (items || []).filter((i) => i.expires_on && daysUntil(i.expires_on) <= 5).length, [items]);
  const isLow = (i: Item) => i.remaining_amount / (i.package_amount * i.count) <= 0.25;
  const lowCount = useMemo(() => (items || []).filter(isLow).length, [items]);
  const shown = useMemo(() => {
    return (items || []).filter((i) =>
      (loc === null || (loc === 'low' ? isLow(i) : i.expires_on && daysUntil(i.expires_on) <= 5)) &&
      matches(i, q));
  }, [items, q, loc]);

  return (
    <>
      <div className="toolbar">
        <div className="stats">
          <button className={'stat' + (loc === null ? ' on' : '')} aria-pressed={loc === null} onClick={() => setLoc(null)}><b>{items?.length ?? '–'}</b><span>im Vorrat</span></button>
          <button className={'stat soon' + (loc === 'soon' ? ' on' : '') + (soonCount ? '' : ' zero')} aria-pressed={loc === 'soon'} onClick={() => setLoc(loc === 'soon' ? null : 'soon')}><b>{soonCount}</b><span>läuft bald ab</span></button>
          <button className={'stat low' + (loc === 'low' ? ' on' : '') + (lowCount ? '' : ' zero')} aria-pressed={loc === 'low'} onClick={() => setLoc(loc === 'low' ? null : 'low')}><b>{lowCount}</b><span>fast leer</span></button>
        </div>
        <input type="search" placeholder="Im Vorrat suchen" value={q} onChange={(e) => setQ(e.target.value)} />
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

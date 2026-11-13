import { useRef, useState } from 'react';
import { guessUnit } from './icons';
import { Thumb } from './Inventory';
import { addDays, addMonths, api, attempt, Chips, fmtNum, round, Stepper, toast, type Item } from './lib';

const UNITS = [
  { value: 'g', label: 'Gramm' },
  { value: 'ml', label: 'Milliliter' },
  { value: 'Stk', label: 'Stück' },
  { value: '%', label: 'nur Füllstand' },
];

/** Anlegen (ohne id) und Bearbeiten (mit id) eines Vorrats-Eintrags */
export function ItemEditor({ initial, onDone }: { initial: Partial<Item>; onDone: () => void }) {
  const editing = !!initial.id;
  const [name, setName] = useState(initial.name || '');
  const [brand, setBrand] = useState(initial.brand || '');
  const [unit, setUnit] = useState(initial.unit || guessUnit(initial.name || '', initial.category));
  // Solange die Einheit weder vom Produkt noch von Hand kommt, folgt sie dem Namen (Milch -> ml)
  const [unitFixed, setUnitFixed] = useState(!!initial.unit);
  function changeName(v: string) {
    setName(v);
    if (!unitFixed) setUnit(guessUnit(v, initial.category));
  }
  const [pkg, setPkg] = useState(String(initial.package_amount ?? ''));
  const [count, setCount] = useState(initial.count || 1);
  const [expires, setExpires] = useState(initial.expires_on || '');
  const [note, setNote] = useState(initial.note || '');
  const [details, setDetails] = useState(!editing && !initial.name);
  const pkgNum = unit === '%' ? 100 : Math.max(Number(pkg.replace(',', '.')) || 0, 0);
  const full = pkgNum * count;
  const [pct, setPct] = useState(() => {
    const f = (initial.package_amount || 0) * (initial.count || 1);
    return f && initial.remaining_amount != null ? Math.round((initial.remaining_amount / f) * 100) : 100;
  });
  const remaining = (pct / 100) * full;
  const [busy, setBusy] = useState(false);

  /** Eine Packung mehr oder weniger: Angebrochenes bleibt angebrochen, es kommt eine volle dazu bzw. geht eine volle weg */
  function changeCount(n: number) {
    if (pkgNum > 0) setPct(Math.min(100, Math.max(0, ((remaining + (n - count) * pkgNum) / (pkgNum * n)) * 100)));
    setCount(n);
  }

  async function save() {
    if (!name.trim()) return toast('Name fehlt');
    if (unit !== '%' && !pkgNum) return toast('Wie viel ist in einer vollen Packung?');
    setBusy(true);
    const body = {
      name, brand, unit, package_amount: pkgNum, count, remaining_amount: remaining,
      expires_on: expires || null, note,
      barcode: initial.barcode, category: initial.category,
    };
    const res = await attempt(() => (editing ? api(`/items/${initial.id}`, { method: 'PATCH', body }) : api('/items', { body })));
    setBusy(false);
    if (!res) return;
    if (res.consumed) await offerShopping();
    else toast(editing ? 'Gespeichert' : res.merged ? 'Zur vorhandenen Packung addiert' : 'Hinzugefügt');
    onDone();
  }
  async function offerShopping() {
    if (confirm(`„${name}“ ist aufgebraucht. Auf die Einkaufsliste setzen?`)) await attempt(() => api('/shopping', { body: { name } }), 'Auf der Einkaufsliste');
  }
  async function remove() {
    if (!confirm(`„${name}“ aus dem Vorrat löschen?`)) return;
    await attempt(() => api(`/items/${initial.id}`, { method: 'DELETE' }), 'Gelöscht');
    onDone();
  }
  async function usedUp() {
    await attempt(() => api(`/items/${initial.id}`, { method: 'PATCH', body: { remaining_amount: 0 } }));
    await offerShopping();
    onDone();
  }

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {name.trim() && <Thumb name={name} category={initial.category} big />}

      {!editing || details ? (
        <>
          <label>Name<input value={name} onChange={(e) => changeName(e.target.value)} placeholder="z. B. Mehl" autoFocus={!initial.name} /></label>
          <label>Einheit<Chips options={UNITS} value={unit} onChange={(u) => { setUnit(u); setUnitFixed(true); }} /></label>
          {unit !== '%' && (
            <label>Volle Packung ({unit})
              <input inputMode="decimal" value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder={unit === 'Stk' ? 'z. B. 10' : 'z. B. 1000'} />
            </label>
          )}
        </>
      ) : (
        <button type="button" className="link" onClick={() => setDetails(true)}>Name oder Packungsgröße ändern</button>
      )}

      <div className="row between">
        <span className="lbl">Wie viele Packungen hast du?</span>
        <Stepper value={count} onChange={changeCount} />
      </div>

      <div className="field">
        <div className="row between">
          <span className="lbl">Wie viel ist noch da{count > 1 ? ' (alle Packungen zusammen)' : ''}?</span>
          <strong>{unit === '%' ? `${Math.round(pct)} %` : `${fmtNum(remaining)} ${unit}`}</strong>
        </div>
        <Slider value={pct} onChange={(v) => setPct(unit === 'Stk' && full > 0 ? (Math.round((v / 100) * full) / full) * 100 : v)} />
        <div className="chips">
          {[100, 75, 50, 25].map((p) => (
            <button type="button" key={p} className={'chip' + (pct === p ? ' on' : '')} onClick={() => setPct(p)}>{p === 100 ? 'voll' : p === 75 ? '¾' : p === 50 ? '½' : '¼'}</button>
          ))}
          {unit !== '%' && full > 0 && (
            <input className="mini" inputMode="decimal" aria-label={`Rest in ${unit}`} placeholder={unit}
              value={String(round(remaining)).replace('.', ',')}
              onChange={(e) => setPct(Math.min(100, Math.max(0, ((Number(e.target.value.replace(',', '.')) || 0) / full) * 100)))} />
          )}
        </div>
      </div>

      <div className="field">
        <label>Haltbar bis<input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        <div className="chips">
          {([['3 Tage', addDays(3)], ['1 Woche', addDays(7)], ['2 Wochen', addDays(14)], ['1 Monat', addMonths(1)], ['6 Monate', addMonths(6)], ['1 Jahr', addMonths(12)], ['keins', '']] as const).map(([l, v]) => (
            <button type="button" key={l} className={'chip' + (expires === v ? ' on' : '')} onClick={() => setExpires(v)}>{l}</button>
          ))}
        </div>
      </div>

      {(details || !editing) && (
        <>
          <label>Marke (optional)<input value={brand} onChange={(e) => setBrand(e.target.value)} /></label>
          <label>Notiz (optional)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </>
      )}

      <button className="btn primary" disabled={busy}>{editing ? 'Speichern' : 'In den Vorrat'}</button>
      {editing && (
        <div className="row">
          <button type="button" className="btn" onClick={usedUp}>Aufgebraucht</button>
          <button type="button" className="btn danger" onClick={remove}>Löschen</button>
        </div>
      )}
    </form>
  );
}

/**
 * Füllstand-Regler, der beim Scrollen nicht verstellt wird: Er reagiert erst auf ein Antippen
 * oder ein waagerechtes Ziehen. Wischt man senkrecht darüber, scrollt die Seite und der Wert bleibt.
 */
function Slider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; drag: boolean } | null>(null);
  const at = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (x - r.left - 14) / (r.width - 28))) * 100);
  };
  return (
    <div ref={ref} className="slider" role="slider" tabIndex={0} aria-label="Füllstand" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}
      onPointerDown={(e) => { start.current = { x: e.clientX, y: e.clientY, drag: false }; }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dx = Math.abs(e.clientX - s.x), dy = Math.abs(e.clientY - s.y);
        if (!s.drag && dx > 8 && dx > dy) { s.drag = true; e.currentTarget.setPointerCapture(e.pointerId); }
        if (s.drag) onChange(at(e.clientX));
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (s && !s.drag && Math.abs(e.clientX - s.x) < 8 && Math.abs(e.clientY - s.y) < 8) onChange(at(e.clientX));
      }}
      onPointerCancel={() => { start.current = null; }}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0;
        if (d) { e.preventDefault(); onChange(Math.min(100, Math.max(0, value + d))); }
      }}>
      <div className="slider-track"><div style={{ width: `${value}%` }} /></div>
      <div className="slider-thumb" style={{ left: `calc(14px + (100% - 28px) * ${value / 100})` }} />
    </div>
  );
}

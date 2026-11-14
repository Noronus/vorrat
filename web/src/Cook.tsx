import { useCallback, useEffect, useRef, useState } from 'react';
import { addDays, api, attempt, Chips, confirmDialog, fold, niceDate, onSync, scaleRecipe, Sheet, Stepper, toast, useLoad, type AiJob, type PlanEntry, type Recipe } from './lib';

const SLOTS = ['Frühstück', 'Mittag', 'Abend'];

// ---------- gemeinsame Aktionen ----------
async function saveRecipe(r: Recipe): Promise<number | undefined> {
  if (r.id) return r.id;
  const res = await attempt(() => api('/recipes', { body: { ...r, source: 'ai', dedupe: true } }));
  return res?.id;
}
const missing = (r: Recipe) => r.ingredients.filter((i) => i.in_stock === false);
async function addToShopping(list: { name: string; amount?: string }[]) {
  if (!list.length) return toast('Es fehlt nichts');
  const res = await attempt(() => api('/shopping', { body: { items: list } }));
  if (res) toast(res.added ? `${res.added} auf der Einkaufsliste` : 'Stand schon alles drauf');
}

/** Startet einen KI-Auftrag und fragt das Ergebnis ab. Das letzte Ergebnis liegt auf dem Server (geräteübergreifend). */
function useAiJob(kind: 'recipes' | 'plan') {
  const [job, setJob] = useState<AiJob | null>(null);
  const [error, setError] = useState('');
  const timer = useRef(0);
  const poll = useCallback((id: number) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const j = await api<AiJob>(`/ai/jobs/${id}`);
        if (j.status === 'running') return poll(id);
        if (j.status === 'error') { setError(j.error || 'Fehler'); setJob(null); } else setJob(j);
      } catch { poll(id); }
    }, 2500);
  }, []);
  useEffect(() => {
    const latest = () => api<{ job: AiJob | null }>(`/ai/latest?kind=${kind}`).then(({ job }) => { setJob(job); if (job?.status === 'running') poll(job.id); }).catch(() => {});
    latest();
    // Vorschläge, die ein anderes Gerät anfordert, erscheinen auch hier
    const off = onSync((t) => { if (t === 'ai') latest(); });
    return () => { off(); clearTimeout(timer.current); };
  }, [kind, poll]);
  const start = async (params: object) => {
    setError('');
    try {
      const { id } = await api('/ai/jobs', { body: { kind, ...params } });
      setJob({ id, kind, status: 'running', error: null, createdAt: '', params: {}, result: null });
      poll(id);
    } catch (e: any) { setError(e.message); }
  };
  return { job, error, start, running: job?.status === 'running' };
}

// ---------- Rezeptkarte ----------
/** Zutaten je Schritt: von Claude, sonst grob über die Namen im Schritttext (jede Zutat beim ersten Schritt, der sie nennt) */
function stepIngredients(r: Recipe): number[][] {
  if (r.step_ingredients?.length === r.steps.length) return r.step_ingredients.map((l) => l.filter((i) => i >= 0 && i < r.ingredients.length));
  const words = r.ingredients.map((i) => fold(i.name).split(/[^a-z]+/).filter((w) => w.length >= 4));
  const seen = new Set<number>();
  return r.steps.map((s) => {
    const t = fold(s);
    const hit = r.ingredients.map((_, k) => k).filter((k) => !seen.has(k) && words[k].some((w) => t.includes(w)));
    hit.forEach((k) => seen.add(k));
    return hit;
  });
}

/** Abgehakte Zutaten beim Kochen. Bleiben einen Tag lang gespeichert, auch wenn man das Rezept schließt. */
const CHECKS = 'vorrat:checks';
function useChecks(title: string) {
  const read = (): Record<string, { t: number; keys: string[] }> => { try { return JSON.parse(localStorage.getItem(CHECKS) || '{}'); } catch { return {}; } };
  const [keys, setKeys] = useState<Set<string>>(() => {
    const e = read()[title];
    return new Set(e && Date.now() - e.t < 864e5 ? e.keys : []);
  });
  const store = (next: Set<string>) => {
    setKeys(next);
    try {
      const all = read();
      for (const k of Object.keys(all)) if (Date.now() - all[k].t > 864e5) delete all[k];
      if (next.size) all[title] = { t: Date.now(), keys: [...next] }; else delete all[title];
      localStorage.setItem(CHECKS, JSON.stringify(all));
    } catch { /* ohne Speicher nur für diese Ansicht */ }
  };
  const toggle = (k: string) => { const n = new Set(keys); if (n.has(k)) n.delete(k); else n.add(k); store(n); };
  return { keys, toggle, reset: () => store(new Set()) };
}

type Msg = { role: 'user' | 'claude'; text: string };
/** Rückfragen und Änderungswünsche zum Rezept an Claude */
function AskClaude({ recipe, onChange }: { recipe: Recipe; onChange: (r: Recipe) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    const history = msgs;
    setMsgs([...history, { role: 'user', text: message }]);
    setText('');
    setBusy(true);
    const res = await attempt(() => runJob({ kind: 'refine', recipe, message, history }));
    setBusy(false);
    if (!res) { setMsgs(history); setText(message); return; }
    setMsgs([...history, { role: 'user', text: message }, { role: 'claude', text: (res.answer || 'Erledigt.') + (res.changed ? ' (Rezept angepasst)' : '') }]);
    if (res.changed && res.recipe?.title) onChange({ ...res.recipe, id: recipe.id, source: recipe.source });
  }
  return (
    <section className="ask">
      <h4>Claude fragen</h4>
      {msgs.map((m, k) => <p key={k} className={'bubble ' + m.role}>{m.text}</p>)}
      {busy && <div className="progress" />}
      <form className="row" onSubmit={send}>
        <input placeholder="z. B. Geht das ohne Wok? Mach es schärfer." value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} disabled={busy} />
        <button className="btn primary" disabled={busy || !text.trim()}>{busy ? '…' : 'Senden'}</button>
      </form>
    </section>
  );
}

function RecipeCard({ recipe, open: initiallyOpen, actions, onRefine }: {
  recipe: Recipe; open?: boolean;
  /** Bekommt das Rezept mit der eingestellten Portionszahl */
  actions?: (r: Recipe) => React.ReactNode;
  /** Wenn gesetzt, kann man Claude zum Rezept fragen; bekommt das angepasste Rezept */
  onRefine?: (r: Recipe) => void;
}) {
  const [open, setOpen] = useState(!!initiallyOpen);
  const [servings, setServings] = useState(recipe.servings || 2);
  useEffect(() => setServings(recipe.servings || 2), [recipe]);
  const r = scaleRecipe(recipe, servings);
  const checks = useChecks(recipe.title);
  const perStep = stepIngredients(r);
  const added = new Set([...checks.keys].map((k) => Number(k.split('-')[1])));
  const miss = missing(r);
  return (
    <article className="card">
      <button className="card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="grow">
          <h3>{r.title}</h3>
          <div className="muted">
            {[r.time_minutes && `${r.time_minutes} min`, r.servings && `${r.servings} Port.`, miss.length ? `${miss.length} fehlt` : r.ingredients.some((i) => i.in_stock) && 'alles da'].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {r.description && <p>{r.description}</p>}
      {!!r.uses_expiring?.length && <div className="chips">{r.uses_expiring.map((n) => <span key={n} className="badge soon">verbraucht {n}</span>)}</div>}
      {open && (
        <>
          <div className="row between"><span className="lbl">Portionen</span><Stepper value={servings} onChange={setServings} max={20} /></div>
          <h4>Zutaten</h4>
          <ul className="ingredients">
            {r.ingredients.map((i, k) => (
              <li key={k} className={(i.in_stock === false ? 'missing' : '') + (added.has(k) ? ' added' : '')}><span>{i.amount}</span> {i.name}{i.in_stock === false && <em> fehlt</em>}</li>
            ))}
          </ul>
          <div className="row between">
            <h4>Zubereitung</h4>
            {checks.keys.size > 0 && <button type="button" className="link" onClick={checks.reset}>Haken zurücksetzen</button>}
          </div>
          <ol className="steps">
            {r.steps.map((s, k) => {
              const ings = perStep[k] || [];
              const done = ings.length > 0 && ings.every((i) => checks.keys.has(`${k}-${i}`));
              return (
                <li key={k} className={done ? 'done' : ''}>
                  <p>{s}</p>
                  {ings.length > 0 && (
                    <div className="step-ings">
                      {ings.map((i) => {
                        const key = `${k}-${i}`, on = checks.keys.has(key);
                        return (
                          <button type="button" key={i} className={'step-ing' + (on ? ' on' : '')} aria-pressed={on} onClick={() => checks.toggle(key)}>
                            <span className="tick" aria-hidden>{on ? '✓' : ''}</span>
                            {r.ingredients[i].amount && <b>{r.ingredients[i].amount}</b>} {r.ingredients[i].name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {onRefine && <AskClaude recipe={r} onChange={onRefine} />}
        </>
      )}
      {actions && <div className="row wrap"><Cooked recipe={r} onDone={checks.reset} />{actions(r)}</div>}
    </article>
  );
}

function PlanPicker({ recipe, onClose, onDone }: { recipe: Recipe; onClose: () => void; onDone?: () => void }) {
  const [date, setDate] = useState(addDays(0));
  const [slot, setSlot] = useState('Abend');
  async function go() {
    const id = await saveRecipe(recipe);
    if (!id) return;
    await attempt(() => api('/plan', { body: { date, slot, recipe_id: id, title: recipe.title } }), `Eingeplant für ${niceDate(date)}`);
    onDone?.(); onClose();
  }
  return (
    <Sheet title={`„${recipe.title}“ einplanen`} onClose={onClose}>
      <div className="form">
        <Chips options={Array.from({ length: 7 }, (_, i) => ({ value: addDays(i), label: i === 0 ? 'Heute' : i === 1 ? 'Morgen' : niceDate(addDays(i)) }))} value={date} onChange={setDate} />
        <Chips options={SLOTS.map((s) => ({ value: s, label: s }))} value={slot} onChange={setSlot} />
        <button className="btn primary" onClick={go}>Einplanen</button>
      </div>
    </Sheet>
  );
}

/** Foto auf dem Gerät verkleinern (max. 1280 px, JPEG): spart Datenvolumen. Liefert Base64 ohne Präfix. */
async function shrinkPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}

/** Startet einen kurzen KI-Auftrag und wartet auf das Ergebnis. Wirft bei Fehlern. */
async function runJob(body: object): Promise<any> {
  const { id } = await api('/ai/jobs', { body });
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const j = await api<AiJob>(`/ai/jobs/${id}`);
    if (j.status === 'running') continue;
    if (j.status === 'error') throw new Error(j.error || 'Fehler');
    return j.result;
  }
  throw new Error('Das dauert zu lange. Bitte nochmal versuchen.');
}

type Question = { question: string; options: string[] };
/** Lässt Claude 2 bis 3 Rückfragen stellen. Liefert eine leere Liste, wenn das nicht klappt. */
async function fetchQuestions(params: object): Promise<Question[]> {
  try {
    const list: Question[] = (await runJob({ kind: 'questions', ...params }))?.questions || [];
    return list.filter((q) => q.question && q.options?.length).slice(0, 3).map((q) => ({ question: q.question, options: q.options.slice(0, 4) }));
  } catch { return []; }
}

// ---------- Gekocht: Zutaten vom Vorrat abziehen ----------
type Deduction = { item_id: number; name: string; brand: string | null; unit: string; remaining: number; ingredient: string; amount: number };
function Cooked({ recipe, onDone }: { recipe: Recipe; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<(Deduction & { on: boolean; text: string })[] | null>(null);
  async function load() {
    setBusy(true);
    const res = await attempt(() => runJob({ kind: 'cook', recipe: { title: recipe.title, servings: recipe.servings, ingredients: recipe.ingredients } }));
    setBusy(false);
    if (!res) return;
    const d: Deduction[] = res.deductions || [];
    if (!d.length) return toast('Nichts davon steht im Vorrat');
    setList(d.map((x) => ({ ...x, on: true, text: String(x.amount).replace('.', ',') })));
  }
  const change = (k: number, patch: object) => setList(list!.map((x, i) => (i === k ? { ...x, ...patch } : x)));
  async function apply() {
    const deductions = list!.filter((x) => x.on).map((x) => ({ id: x.item_id, amount: Number(x.text.replace(',', '.')) || 0 })).filter((x) => x.amount > 0);
    if (!deductions.length) return setList(null);
    const res = await attempt(() => api('/items/consume', { body: { deductions } }));
    if (!res) return;
    setList(null);
    onDone?.();
    toast(`${res.changed} Vorräte angepasst`);
    if (res.usedUp.length && await confirmDialog('Aufgebraucht', { text: `${res.usedUp.join(', ')} ist jetzt leer. Auf die Einkaufsliste setzen?`, ok: 'Auf die Liste', cancel: 'Nein' }))
      await addToShopping(res.usedUp.map((name: string) => ({ name })));
  }
  return (
    <>
      <button className="btn small primary" disabled={busy} onClick={load}>{busy ? 'Claude rechnet …' : 'Gekocht'}</button>
      {list && (
        <Sheet title="Vom Vorrat abziehen" onClose={() => setList(null)}>
          <p className="muted">Prüfe die Mengen. Was nicht stimmt, änderst du oder nimmst den Haken raus.</p>
          <div className="list">
            {list.map((x, k) => (
              <label key={x.item_id} className="list-row check">
                <input type="checkbox" checked={x.on} onChange={(e) => change(k, { on: e.target.checked })} />
                <span className="grow">
                  <strong>{x.name}</strong>
                  <span className="muted" style={{ display: 'block' }}>für {x.ingredient} · da: {String(Math.round(x.remaining * 10) / 10).replace('.', ',')} {x.unit}</span>
                </span>
                <input className="mini" inputMode="decimal" aria-label={`Menge ${x.name}`} value={x.text} disabled={!x.on} onChange={(e) => change(k, { text: e.target.value })} />
                <span className="muted">{x.unit}</span>
              </label>
            ))}
          </div>
          <button className="btn primary" onClick={apply}>Abziehen</button>
        </Sheet>
      )}
    </>
  );
}

// ---------- Vorschläge ----------
function Suggestions({ aiReady }: { aiReady: boolean }) {
  const { job, error, start, running } = useAiJob('recipes');
  const [wish, setWish] = useState('');
  const [servings, setServings] = useState(() => Number(localStorage.getItem('vorrat:servings')) || 2);
  const [plan, setPlan] = useState<Recipe | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, Recipe>>({});
  const recipes: Recipe[] = (job?.status === 'done' ? job.result?.recipes || [] : []).map((r: Recipe, k: number) => edits[`${job!.id}-${k}`] || r);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const open = openIdx === null ? null : recipes[openIdx] || null;
  const [asking, setAsking] = useState(false);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const busy = running || asking;

  function go(list: { question: string; answer: string }[]) {
    localStorage.setItem('vorrat:servings', String(servings));
    setQuestions(null);
    start({ wish, servings, answers: list });
  }
  /** Erst kurze Rückfragen zum Antippen holen. Klappt das nicht, geht es ohne weiter. */
  async function ask() {
    setAsking(true);
    setAnswers({});
    const qs = await fetchQuestions({ wish, servings });
    setAsking(false);
    if (qs.length) setQuestions(qs); else go([]);
  }

  return (
    <>
      <div className="card hero">
        <div className="hero-head">
          <span aria-hidden>🍳</span>
          <div><h2>Was gibt’s heute?</h2><p className="muted">Claude schaut in deinen Vorrat und schlägt 6 Gerichte vor.</p></div>
        </div>
        <button className="btn primary big" disabled={busy || !aiReady} onClick={ask}>
          {running ? 'Claude sucht 6 Gerichte aus …' : asking ? 'Claude überlegt Rückfragen …' : 'Was kann ich kochen?'}
        </button>
        {busy && <div className="progress" />}
        {!busy && aiReady && <button type="button" className="link" onClick={() => go([])}>Ohne Rückfragen vorschlagen</button>}
        <label className={'btn' + (running || !aiReady ? ' disabled' : '')}>
          Foto von Zutaten machen
          <input type="file" accept="image/*" capture="environment" hidden disabled={running || !aiReady}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const image = await attempt(() => shrinkPhoto(file));
              if (image) start({ wish, servings, image });
            }} />
        </label>
        <div className="row between"><span className="lbl">Portionen</span><Stepper value={servings} onChange={setServings} max={12} /></div>
        <input placeholder="Wunsch (optional): z. B. vegetarisch, schnell, Pasta" value={wish} onChange={(e) => setWish(e.target.value)} maxLength={500} />
        {!aiReady && <p className="muted">Claude ist auf dem Server noch nicht verbunden. Siehe „Mehr“.</p>}
        {error && <p className="error">{error}</p>}
      </div>
      {recipes.length > 0 && (
        <div className="tiles">
          {recipes.map((r, k) => (
            <button key={job!.id + '-' + k} className="tile" onClick={() => setOpenIdx(k)}>
              <span className="tile-emoji" aria-hidden>{r.emoji || '🍽️'}</span>
              <strong>{r.title}</strong>
              <span className="muted">{[r.time_minutes && `${r.time_minutes} min`, missing(r).length ? `${missing(r).length} fehlt` : 'alles da'].filter(Boolean).join(' · ')}</span>
              {!!r.uses_expiring?.length && <span className="badge soon">rettet {r.uses_expiring.length}</span>}
            </button>
          ))}
        </div>
      )}
      {open && (
        <Sheet title={open.title} onClose={() => setOpenIdx(null)} full>
          <RecipeCard recipe={open} open onRefine={(r) => setEdits({ ...edits, [`${job!.id}-${openIdx}`]: r })} actions={(r) => (
            <>
              <button className="btn small" disabled={saved.has(r.title)} onClick={async () => { if (await saveRecipe(r)) { setSaved(new Set(saved).add(r.title)); toast('Rezept gespeichert'); } }}>{saved.has(r.title) ? 'Gespeichert' : 'Speichern'}</button>
              <button className="btn small" onClick={() => setPlan(r)}>Einplanen</button>
              {missing(r).length > 0 && <button className="btn small" onClick={() => addToShopping(missing(r))}>Fehlendes einkaufen</button>}
            </>
          )} />
        </Sheet>
      )}
      {questions && (
        <Sheet title="Kurz gefragt" onClose={() => setQuestions(null)}>
          <div className="form">
            {questions.map((q) => (
              <div className="field" key={q.question}>
                <span className="lbl">{q.question}</span>
                <Chips options={q.options.map((o) => ({ value: o, label: o }))} value={answers[q.question] ?? ''}
                  onChange={(v) => setAnswers({ ...answers, [q.question]: answers[q.question] === v ? '' : v })} />
              </div>
            ))}
            <button className="btn primary" onClick={() => go(questions.filter((q) => answers[q.question]).map((q) => ({ question: q.question, answer: answers[q.question] })))}>6 Vorschläge holen</button>
          </div>
        </Sheet>
      )}
      {plan && <PlanPicker recipe={plan} onClose={() => setPlan(null)} />}
    </>
  );
}

// ---------- Rezepte ----------
function parseIngredients(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^((?:ca\.\s*)?[\d.,/½¼¾]+\s*(?:kg|g|ml|cl|l|EL|TL|Stk\.?|Stück|Prisen?|Dosen?|Bund|Pck\.?|Packung(?:en)?|Zehen?|Scheiben?|Tassen?|Becher)?)\s+(.+)$/i);
    return m ? { amount: m[1].trim(), name: m[2].trim() } : { amount: '', name: line };
  });
}

function RecipeForm({ initial, onDone }: { initial: Recipe | null; onDone: () => void }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [servings, setServings] = useState(initial?.servings || 2);
  const [time, setTime] = useState(String(initial?.time_minutes || ''));
  const [ingredients, setIngredients] = useState((initial?.ingredients || []).map((i) => `${i.amount} ${i.name}`.trim()).join('\n'));
  const [steps, setSteps] = useState((initial?.steps || []).join('\n'));
  async function save() {
    const sameText = initial && ingredients === (initial.ingredients || []).map((i) => `${i.amount} ${i.name}`.trim()).join('\n') && steps === (initial.steps || []).join('\n');
    const body = { title, servings, step_ingredients: sameText ? initial.step_ingredients : null, time_minutes: Number(time) || null, description: initial?.description, ingredients: parseIngredients(ingredients), steps: steps.split('\n').map((s) => s.trim()).filter(Boolean) };
    const ok = await attempt(() => (initial?.id ? api(`/recipes/${initial.id}`, { method: 'PUT', body }) : api('/recipes', { body })), 'Gespeichert');
    if (ok) onDone();
  }
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label>Titel<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
      <div className="row between"><span className="lbl">Portionen</span><Stepper value={servings} onChange={setServings} max={20} /></div>
      <label>Dauer (Minuten)<input inputMode="numeric" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      <label>Zutaten (eine pro Zeile, z. B. „200 g Mehl“)<textarea rows={7} value={ingredients} onChange={(e) => setIngredients(e.target.value)} /></label>
      <label>Zubereitung (ein Schritt pro Zeile)<textarea rows={7} value={steps} onChange={(e) => setSteps(e.target.value)} /></label>
      <button className="btn primary">Speichern</button>
    </form>
  );
}

function Recipes() {
  const { data, reload } = useLoad<Recipe[]>('/recipes');
  const [q, setQ] = useState('');
  const [open, setOpenRaw] = useState<Recipe | null>(null);
  const [changed, setChanged] = useState(false);
  const setOpen = (r: Recipe | null) => { setOpenRaw(r); setChanged(false); };
  const [form, setForm] = useState<Recipe | 'new' | null>(null);
  const [plan, setPlan] = useState<Recipe | null>(null);
  async function update(r: Recipe) {
    if (!await attempt(() => api(`/recipes/${r.id}`, { method: 'PUT', body: r }), 'Gespeichert')) return;
    setOpenRaw(r); setChanged(false); reload();
  }
  const shown = (data || []).filter((r) => r.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="row">
        <input type="search" placeholder="Rezept suchen" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary" onClick={() => setForm('new')}>Neu</button>
      </div>
      {data && !data.length && <p className="empty">Noch keine Rezepte. Speichere einen Vorschlag oder lege eins an.</p>}
      <div className="list">
        {shown.map((r) => (
          <button key={r.id} className="list-row" onClick={() => setOpen(r)}>
            <div className="grow">
              <strong>{r.title}</strong>
              <div className="muted">{[r.time_minutes && `${r.time_minutes} min`, r.servings && `${r.servings} Port.`, `${r.ingredients.length} Zutaten`].filter(Boolean).join(' · ')}</div>
            </div>
            <span>›</span>
          </button>
        ))}
      </div>
      {open && (
        <Sheet title="Rezept" onClose={() => setOpen(null)} full>
          <RecipeCard recipe={open} open onRefine={(r) => { setOpenRaw(r); setChanged(true); }} actions={(r) => (
            <>
              {(changed || r.servings !== open.servings) && <button className="btn small primary" onClick={() => update(r)}>{changed ? 'Änderung speichern' : `Mit ${r.servings} Port. speichern`}</button>}
              <button className="btn small" onClick={() => setPlan(r)}>Einplanen</button>
              <button className="btn small" onClick={() => addToShopping(r.ingredients)}>Zutaten einkaufen</button>
              <button className="btn small" onClick={() => { setForm(open); setOpen(null); }}>Bearbeiten</button>
              <button className="btn small danger" onClick={async () => { if (await confirmDialog('Rezept löschen?', { text: `„${open.title}“ wird endgültig gelöscht.`, ok: 'Löschen', danger: true })) { await attempt(() => api(`/recipes/${open.id}`, { method: 'DELETE' })); setOpen(null); reload(); } }}>Löschen</button>
            </>
          )} />
        </Sheet>
      )}
      {form && (
        <Sheet title={form === 'new' ? 'Neues Rezept' : 'Rezept bearbeiten'} onClose={() => setForm(null)} full>
          <RecipeForm initial={form === 'new' ? null : form} onDone={() => { setForm(null); reload(); }} />
        </Sheet>
      )}
      {plan && <PlanPicker recipe={plan} onClose={() => setPlan(null)} />}
    </>
  );
}

// ---------- Wochenplan ----------
function Plan({ aiReady }: { aiReady: boolean }) {
  const from = addDays(0), to = addDays(13);
  const { data, reload } = useLoad<PlanEntry[]>(`/plan?from=${from}&to=${to}`);
  const recipes = useLoad<Recipe[]>('/recipes');
  const [add, setAdd] = useState<string | null>(null);
  const [addSlot, setAddSlot] = useState('Abend');
  const [addText, setAddText] = useState('');
  const [open, setOpen] = useState<Recipe | null>(null);
  const [auto, setAuto] = useState(false);
  const days = Array.from({ length: 14 }, (_, i) => addDays(i));
  const lastPlanned = (data || []).reduce((m, e) => (e.date > m ? e.date : m), '');
  const visible = days.filter((d, i) => i < 7 || d <= lastPlanned);

  async function addEntry(body: object) {
    await attempt(() => api('/plan', { body: { date: add, slot: addSlot, ...body } }));
    setAdd(null); setAddText(''); reload();
  }
  return (
    <>
      <button className="btn primary" disabled={!aiReady} onClick={() => setAuto(true)}>Woche planen lassen</button>
      {visible.map((d, i) => {
        const entries = (data || []).filter((e) => e.date === d);
        return (
          <section key={d} className="day">
            <div className="row between">
              <h3>{i === 0 ? 'Heute' : i === 1 ? 'Morgen' : niceDate(d)}</h3>
              <button className="icon-btn" aria-label="Gericht hinzufügen" onClick={() => setAdd(d)}>＋</button>
            </div>
            {entries.map((e) => {
              const r = e.recipe_id ? recipes.data?.find((x) => x.id === e.recipe_id) : null;
              return (
                <div key={e.id} className="plan-entry">
                  <button className="grow left" disabled={!r} onClick={() => r && setOpen(r)}>
                    <span className="muted">{e.slot}</span> {e.title}
                  </button>
                  <button className="icon-btn" aria-label="Entfernen" onClick={async () => { await attempt(() => api(`/plan/${e.id}`, { method: 'DELETE' })); reload(); }}>✕</button>
                </div>
              );
            })}
            {!entries.length && <p className="muted">nichts geplant</p>}
          </section>
        );
      })}

      {add && (
        <Sheet title={`Gericht für ${niceDate(add)}`} onClose={() => setAdd(null)}>
          <div className="form">
            <Chips options={SLOTS.map((s) => ({ value: s, label: s }))} value={addSlot} onChange={setAddSlot} />
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (addText.trim()) addEntry({ title: addText }); }}>
              <input placeholder="Freitext, z. B. Reste, Pizza bestellen" value={addText} onChange={(e) => setAddText(e.target.value)} />
              <button className="btn">OK</button>
            </form>
            {!!recipes.data?.length && <span className="lbl">oder aus deinen Rezepten</span>}
            <div className="list">
              {recipes.data?.map((r) => (
                <button key={r.id} className="list-row" onClick={() => addEntry({ recipe_id: r.id, title: r.title })}>{r.title}</button>
              ))}
            </div>
          </div>
        </Sheet>
      )}
      {open && <Sheet title="Rezept" onClose={() => setOpen(null)} full><RecipeCard recipe={open} open actions={(r) => <button className="btn small" onClick={() => addToShopping(r.ingredients)}>Zutaten einkaufen</button>} /></Sheet>}
      {auto && <AutoPlan onClose={() => setAuto(false)} onApplied={() => { reload(); recipes.reload(); }} />}
    </>
  );
}

function AutoPlan({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const { job, error, start, running } = useAiJob('plan');
  const [days, setDays] = useState(5);
  const [slots, setSlots] = useState<string[]>(['Abend']);
  const [servings, setServings] = useState(() => Number(localStorage.getItem('vorrat:servings')) || 2);
  const [wish, setWish] = useState('');
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const entries: { date: string; slot: string; recipe: Recipe }[] = fresh && job?.status === 'done' ? job.result?.entries || [] : [];

  async function apply() {
    setBusy(true);
    for (const e of entries) {
      const id = await saveRecipe(e.recipe);
      if (id) await attempt(() => api('/plan', { body: { date: e.date, slot: e.slot, recipe_id: id, title: e.recipe.title } }));
    }
    setBusy(false);
    toast('Plan übernommen');
    onApplied(); onClose();
  }
  return (
    <Sheet title="Woche planen lassen" onClose={onClose} full>
      {!entries.length ? (
        <div className="form">
          <label>Wie viele Tage?<Chips options={[3, 5, 7].map((n) => ({ value: n, label: `${n} Tage` }))} value={days} onChange={setDays} /></label>
          <label>Mahlzeiten
            <div className="chips">
              {SLOTS.map((s) => (
                <button type="button" key={s} className={'chip' + (slots.includes(s) ? ' on' : '')}
                  onClick={() => setSlots(slots.includes(s) ? slots.filter((x) => x !== s) : [...slots, s])}>{s}</button>
              ))}
            </div>
          </label>
          <div className="row between"><span className="lbl">Portionen</span><Stepper value={servings} onChange={setServings} max={12} /></div>
          <input placeholder="Wunsch (optional)" value={wish} onChange={(e) => setWish(e.target.value)} maxLength={500} />
          <button className="btn primary big" disabled={running || !slots.length} onClick={() => { setFresh(true); start({ days, slots, servings, wish, start: addDays(0) }); }}>
            {running ? 'Claude plant … (bis zu 1 Minute)' : 'Plan erstellen'}
          </button>
          {running && <div className="progress" />}
          {error && <p className="error">{error}</p>}
        </div>
      ) : (
        <>
          {entries.map((e, k) => (
            <div key={k}>
              <div className="lbl">{niceDate(e.date)} · {e.slot}</div>
              <RecipeCard recipe={e.recipe} />
            </div>
          ))}
          <div className="form sticky-actions">
            <button className="btn primary" disabled={busy} onClick={apply}>Plan übernehmen</button>
            <button className="btn" onClick={() => addToShopping(entries.flatMap((e) => missing(e.recipe)))}>Alles Fehlende einkaufen</button>
            <button className="btn" onClick={() => setFresh(false)}>Neu planen</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function Cook() {
  const [tab, setTab] = useState<'ideen' | 'rezepte' | 'plan'>('ideen');
  const ai = useLoad<{ configured: boolean }>('/ai/status');
  const aiReady = ai.data?.configured ?? true;
  return (
    <>
      <div className="segmented">
        {([['ideen', 'Vorschläge'], ['rezepte', 'Rezepte'], ['plan', 'Wochenplan']] as const).map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'ideen' && <Suggestions aiReady={aiReady} />}
      {tab === 'rezepte' && <Recipes />}
      {tab === 'plan' && <Plan aiReady={aiReady} />}
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ItemEditor } from './ItemEditor';
import { amountText, api, expiry, native, Sheet, toast, type Item } from './lib';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

/** Nativer BarcodeDetector (Android-Chrome), sonst WASM-Ersatz (iOS-Safari, Firefox, Desktop) */
async function createDetector(): Promise<{ detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> }> {
  const Native = (window as any).BarcodeDetector;
  if (Native) {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      if (supported.includes('ean_13')) return new Native({ formats: FORMATS });
    } catch { /* weiter zum Ersatz */ }
  }
  const [{ BarcodeDetector, prepareZXingModule }, wasm] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  // WASM vom eigenen Server laden statt vom CDN
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) } });
  return new BarcodeDetector({ formats: FORMATS as any }) as any;
}

type Lookup = { found: boolean; barcode: string; product: any; inStock: Item[] };

export function Scanner({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const paused = useRef(false);
  const track = useRef<MediaStreamTrack | null>(null);
  const [error, setError] = useState('');
  const [torch, setTorch] = useState<boolean | null>(null);
  const [manual, setManual] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [form, setForm] = useState<Partial<Item> | null>(null);
  const [loading, setLoading] = useState(false);
  const handle = useRef<(code: string) => void>(() => {});
  /** Neuere Android-App: Kamera liegt direkt in der Seite statt in einem eigenen Bildschirm */
  const embedded = !!native?.scanStart;
  const box = useRef<HTMLDivElement>(null);
  const sheetOpen = !!(lookup || form);

  handle.current = async (code: string) => {
    if (paused.current) return;
    paused.current = true;
    navigator.vibrate?.(60);
    setLoading(true);
    try {
      const res = await api<Lookup>(`/products/${encodeURIComponent(code)}`);
      if (res.inStock.length) setLookup(res);
      else openForm(res);
    } catch (e: any) {
      toast(e.message);
      paused.current = false;
    }
    setLoading(false);
  };

  function openForm(res: Lookup) {
    setLookup(null);
    if (!res.found) toast('Barcode unbekannt. Einmal eintragen, dann kennt die App ihn.');
    const p = res.product || {};
    setForm({ barcode: res.barcode, name: p.name, brand: p.brand, unit: p.unit || undefined, package_amount: p.package_amount ?? undefined, category: p.category });
  }
  function resume() {
    setForm(null); setLookup(null);
    paused.current = false;
  }
  /** Nach dem Speichern gleich weiter scannen (in der Android-App öffnet das den nativen Scanner) */
  function next() {
    resume();
    if (native && !embedded) native.scan();
  }

  // Eingebettete Kamera: über die freie Fläche legen; ausblenden, solange ein Formular offen ist
  useEffect(() => {
    if (!embedded || sheetOpen) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (r && r.width > 0) native!.scanStart!(r.left, r.top, r.width, r.height);
    };
    place();
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); native!.scanStop!(); };
  }, [embedded, sheetOpen]);

  useEffect(() => {
    if (native) {
      const on = (e: Event) => { const code = (e as CustomEvent).detail; if (code) handle.current(String(code)); };
      window.addEventListener('vorrat:native-scan', on);
      if (embedded) setTorch(false);
      else native.scan();
      return () => window.removeEventListener('vorrat:native-scan', on);
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        track.current = stream.getVideoTracks()[0];
        if ((track.current.getCapabilities?.() as any)?.torch) setTorch(false);
        const detector = await createDetector();
        const tick = async () => {
          if (stopped) return;
          if (!paused.current && v.readyState >= 2) {
            try {
              const found = await detector.detect(v);
              if (found[0]?.rawValue) handle.current(found[0].rawValue);
            } catch { /* einzelnes Bild nicht lesbar */ }
          }
          timer = window.setTimeout(tick, 160);
        };
        tick();
      } catch (e: any) {
        setError(e.message === 'insecure' || !window.isSecureContext
          ? 'Die Kamera geht nur über HTTPS. Öffne die App über ihre https-Adresse.'
          : e.name === 'NotAllowedError' ? 'Kamerazugriff wurde abgelehnt. Erlaube ihn in den Browser-Einstellungen für diese Seite.'
          : 'Kamera konnte nicht gestartet werden.');
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  async function toggleTorch() {
    if (embedded) { if (native!.torch?.(!torch)) setTorch(!torch); return; }
    try {
      await track.current?.applyConstraints({ advanced: [{ torch: !torch } as any] });
      setTorch(!torch);
    } catch { /* nicht unterstützt */ }
  }

  return (
    <div className="scanner">
      {!native && <video ref={video} playsInline muted />}
      {!native && !error && <div className="scan-frame"><div className="scan-line" /></div>}
      {embedded && <div className="scan-native" ref={box}>Kamera startet …</div>}
      <div className="scan-top">
        <button className="icon-btn dark" onClick={onClose} aria-label="Schließen">✕</button>
        <span>{loading ? 'Suche Produkt …' : native && !embedded ? 'Hinzufügen' : 'Barcode ins Feld halten'}</span>
        {torch !== null ? <button className="icon-btn dark" onClick={toggleTorch} aria-label="Licht">{torch ? '🔦' : '💡'}</button> : <span style={{ width: 40 }} />}
      </div>
      <div className="scan-bottom">
        {error && <p className="scan-error">{error}</p>}
        {native && !embedded && <button className="btn primary big" onClick={() => native!.scan()}>Barcode scannen</button>}
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (manual.trim().length >= 6) { handle.current(manual.trim()); setManual(''); } }}>
          <input inputMode="numeric" placeholder="Barcode eintippen" value={manual} onChange={(e) => setManual(e.target.value)} />
          <button className="btn">OK</button>
        </form>
        <button className={native ? 'btn' : 'btn primary'} onClick={() => { paused.current = true; setForm({}); }}>Ohne Barcode eintragen</button>
      </div>

      {lookup && (
        <Sheet title={lookup.product?.name || 'Schon im Vorrat'} onClose={resume}>
          <p className="muted">Das hast du schon. Was möchtest du tun?</p>
          <div className="list">
            {lookup.inStock.map((i) => (
              <button key={i.id} className="list-row" onClick={() => { setLookup(null); setForm(i); }}>
                <div className="grow">
                  <strong>Menge anpassen</strong>
                  <div className="muted">{amountText(i)}{i.expires_on ? ` · ${expiry(i.expires_on).text}` : ''}</div>
                </div>
                <span>›</span>
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => openForm(lookup)}>Neue Packung dazu</button>
        </Sheet>
      )}
      {form && (
        <Sheet title={form.id ? form.name || 'Bearbeiten' : 'Neu im Vorrat'} onClose={resume}>
          <ItemEditor initial={form} onDone={() => { onChanged(); next(); }} />
        </Sheet>
      )}
    </div>
  );
}

import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/figtree';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
  navigator.serviceWorker?.register('/sw.js').catch(() => {});
}

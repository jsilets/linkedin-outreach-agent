import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './theme';
import './styles.css';

// Theme the document before the first render so there is no flash of the wrong
// theme. The bare :root light mirror covers the pre-JS paint; this locks in the
// persisted choice.
initTheme();

const el = document.getElementById('root');
if (!el) throw new Error('Missing #root element.');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

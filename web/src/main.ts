// SPDX-License-Identifier: AGPL-3.0-only
import '@fontsource-variable/inter';
import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { applySavedTheme } from './lib/theme';

applySavedTheme();

mount(App, { target: document.getElementById('app')! });

// Installable app: open the dashboard offline with the last data it showed (see public/sw.js).
// Not under the Vite dev server (it serves /src/*.ts, which the cache must not keep).
if (!document.querySelector('script[src^="/src/"]') && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

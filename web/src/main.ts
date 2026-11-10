// SPDX-License-Identifier: AGPL-3.0-only
import '@fontsource-variable/inter';
import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { applySavedTheme } from './lib/theme';

applySavedTheme();

mount(App, { target: document.getElementById('app')! });

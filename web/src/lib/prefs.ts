// SPDX-License-Identifier: AGPL-3.0-only
// Per-viewer UI preferences in localStorage. Storage can be missing or blocked; defaults always apply.

export function loadPrefs<T extends Record<string, unknown>>(key: string, defaults: T): T {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    const out = { ...defaults };
    for (const k of Object.keys(defaults) as (keyof T)[]) {
      if (typeof saved[k] === typeof defaults[k]) out[k] = saved[k];
    }
    return out;
  } catch {
    return { ...defaults };
  }
}

export function savePrefs(key: string, value: Record<string, unknown>) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

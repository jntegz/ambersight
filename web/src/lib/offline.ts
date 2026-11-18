// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Empties the offline copies of API answers. Works without a controlling service worker (the first
 * load, a hard reload): it asks the registered worker, which also stops copies still being written,
 * and deletes the caches itself in case no worker is running. The shell and assets stay.
 */
export async function clearOfflineCopies() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const worker of [reg?.active, reg?.waiting, reg?.installing]) worker?.postMessage('clear');
  } catch {}
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('ambersight-') && !n.startsWith('ambersight-shell-')).map((n) => caches.delete(n)));
  } catch {}
}

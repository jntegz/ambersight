// SPDX-License-Identifier: AGPL-3.0-only
import { toCsv, type CsvCell } from './csv';

function save(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Saves text as a file through a temporary link. */
export const download = (filename: string, text: string) => save(filename, text, 'text/markdown;charset=utf-8');

export const downloadCsv = (filename: string, rows: CsvCell[][]) => save(filename, toCsv(rows), 'text/csv;charset=utf-8');

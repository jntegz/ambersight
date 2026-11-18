// CSV text for every export in the dashboard. Names in it come from Cloudflare accounts, and the
// file is usually opened in a spreadsheet, which would run a cell starting with "=" as a formula.
// SPDX-License-Identifier: AGPL-3.0-only

export type CsvCell = string | number | null | undefined;

/** Includes the full-width forms, which some spreadsheets read as the plain characters. */
const FORMULA_START = /^\s*[=+\-@\t\r＝＋－＠]/;
/** Text that is only a number, such as "-0.125" from toFixed: no formula can hide in it. */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

export function csvCell(value: CsvCell): string {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  const text = FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const toCsv = (rows: CsvCell[][]) => rows.map((row) => row.map(csvCell).join(',')).join('\n');

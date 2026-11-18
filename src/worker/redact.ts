// Text that leaves the place it was produced: error messages and D1 query text are reduced here
// to what the reader needs, so a secret or a customer's data in them goes no further.
// SPDX-License-Identifier: AGPL-3.0-only

const MAX_ERROR = 300;
/** Runs this long, with letters and digits mixed, are treated as keys or tokens. */
const OPAQUE = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;
/**
 * `name: value`, `name=value` and JSON's `"name":"value"`. A name may end a longer one (client_secret,
 * X-Auth-Key). Every repeat is followed by a character it cannot match, so nothing backtracks.
 */
const NAMED_SECRET = /(?<![A-Za-z0-9])(api[-_ ]?key|auth[-_ ]?key|api[-_ ]?token|access[-_ ]?token|auth[-_ ]?token|token|secret|password|passphrase|cookie|session)\b["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
/** The same for the Authorization header, whose value can start with a scheme word: `Token abc`. */
const AUTH_HEADER = /(?<![A-Za-z0-9])(authorization)\b["']?\s*[:=]\s*("[^"]*"|'[^']*'|(?:[A-Za-z][\w-]*[ \t]+)?[^\s,;]+)/gi;
const EMAIL = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+/g;

/** Replaces e-mail addresses, for text taken from the audit log. */
export const withoutEmails = (s: string) => s.replace(EMAIL, '[email]');

/** What stands in for the person who made a change, in text that named them. */
export const PERSON = '[person]';
/** Actor values that name a kind of caller and not someone: Cloudflare's fallback without an address or token name. */
const GENERIC_ACTORS = ['user', 'account', 'system', 'cloudflare', 'cloudflare_admin', 'unknown'];
/**
 * Words of the audit log itself, which an API token can be named after. Such a name identifies no one,
 * and replacing it would garble the sentence and hide the words the security checks look for.
 */
const AUDIT_WORDS = [
  'admin', 'api', 'binding', 'bindings', 'deploy', 'deploys', 'deployment', 'deployments', 'member', 'members', 'route', 'routes',
  'script', 'scripts', 'secret', 'secrets', 'setting', 'settings', 'token', 'tokens', 'users', 'version', 'versions', 'worker', 'workers',
];
/** Actor values that are left in the text, in lower case. */
export const NOT_NAMES = [...GENERIC_ACTORS, ...AUDIT_WORDS];
const namesSomeone = (actor: string) => actor.length >= 3 && !NOT_NAMES.includes(actor.toLowerCase());
const LETTER_OR_DIGIT = '[\\p{L}\\p{N}]';

/** Text with the actor replaced wherever it stands on its own, so `alice` leaves "malice" alone. */
export function withoutName(text: string, actor: string | null | undefined): string {
  if (!actor || !namesSomeone(actor)) return text;
  const name = actor.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  return text.replace(new RegExp(`(?<!${LETTER_OR_DIGIT})${name}(?!${LETTER_OR_DIGIT})`, 'gu'), () => PERSON);
}

/** Audit-log or deploy text without the person who made the change and without any e-mail address. */
export const withoutPerson = (text: string, actor: string | null | undefined) => withoutEmails(withoutName(text, actor));

/**
 * The one way an error message crosses a boundary (stored scan error, system alert, API response,
 * scan warning). Strips URLs, query strings, credentials and anything shaped like one. Cloudflare's
 * own short messages, such as "Invalid API Token", pass through unchanged.
 */
export function safeError(message: string, max = MAX_ERROR): string {
  const clean = message
    .slice(0, 2_000)
    .replace(/[\r\n\u2028\u2029\t]+/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*[^\s"'<>.,:;!?)\]]/gi, '[url]')
    .replace(/[?&][\w.%~-]+=[^\s&]*(?:&[\w.%~-]+=[^\s&]*)*/g, '[query]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(AUTH_HEADER, '$1=[redacted]')
    .replace(NAMED_SECRET, '$1=[redacted]')
    .replace(/\b(?:amb|gh[pousr]|github_pat|xox[abprs]|sk|whsec)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(OPAQUE, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[redacted]' : m))
    .replace(EMAIL, '[email]')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Longest query text looked at. A literal cut off here counts as unterminated and is still removed. */
const MAX_SQL = 8_000;
const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;
/**
 * After these, a double-quoted word can only be a table. Anywhere else, unless a dot joins it to
 * another name, it may be a value: SQLite reads "x" as a string when no column has that name.
 */
const TABLE_BEFORE = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE']);

/** End of a quoted run starting at `i`. A doubled quote does not end it; running off the end does. As in SQLite, a backslash is an ordinary character. */
function quoteEnd(sql: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] !== quote) j++;
    else if (sql[j + 1] === quote) j += 2;
    else return j + 1;
  }
  return sql.length;
}

/** Whether the next thing after position `i` is a dot. */
function dotFollows(sql: string, i: number): boolean {
  let j = i;
  while (j < sql.length && /\s/.test(sql[j])) j++;
  return sql[j] === '.';
}

/**
 * The shape of a D1 query with every value taken out: strings, numbers, hex and blob literals become
 * `?`, comments go, and lists of values collapse to one `?`. When in doubt it removes more, because
 * the text is only there to recognise the query. Running it twice changes nothing.
 */
export function sqlShape(query: string): string {
  const sql = query.slice(0, MAX_SQL);
  const out: string[] = [];
  /** Whether each open bracket holds values: the list after IN or VALUES, and further VALUES rows. */
  const lists: boolean[] = [];
  let prev = '';
  let rowClosed = false;
  const emit = (text: string, significant = text) => {
    out.push(text);
    prev = significant.toUpperCase();
    if (prev !== ',') rowClosed = false;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      out.push(' ');
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      out.push(' ');
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out.push(' ');
    } else if (c === "'") {
      i = quoteEnd(sql, i, c);
      emit('?');
    } else if (c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? (sql.indexOf(']', i) + 1 || sql.length) : quoteEnd(sql, i, c);
      const inner = sql.slice(i + 1, end - 1);
      const clearlyName = c !== '"' || TABLE_BEFORE.has(prev) || prev === '.' || dotFollows(sql, end);
      if (!clearlyName || !PLAIN_IDENT.test(inner) || lists.at(-1) === true) emit('?');
      else emit(sql.slice(i, end), 'name');
      i = end;
    } else if ((c === 'x' || c === 'X') && sql[i + 1] === "'") {
      i = quoteEnd(sql, i + 1, "'");
      emit('?');
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(?:0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?\.?)/.exec(sql.slice(i, i + 80));
      i += m ? m[0].length : 1;
      // Letters straight after digits are part of the same token: take them too.
      while (i < sql.length && IDENT_PART.test(sql[i])) i++;
      emit('?');
    } else if (c === '?' || c === ':' || c === '@' || c === '$') {
      // A bound parameter holds no value in the text. Numbered ones become plain `?`, named ones stay.
      let j = i + 1;
      while (j < sql.length && IDENT_PART.test(sql[j])) j++;
      if (j === i + 1 && c !== '?') emit(c);
      else emit(c === '?' ? '?' : sql.slice(i, j), '?');
      i = j;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && IDENT_PART.test(sql[j])) j++;
      emit(sql.slice(i, j));
      i = j;
    } else if (c === '(') {
      lists.push(prev === 'IN' || prev === 'VALUES' || (prev === ',' && rowClosed));
      emit(c);
      i++;
    } else if (c === ')') {
      const wasList = lists.pop() === true;
      emit(c);
      rowClosed = wasList;
      i++;
    } else {
      const two = sql.slice(i, i + 2);
      const op = ['<=', '>=', '<>', '!=', '==', '||'].includes(two) ? two : c;
      emit(op);
      i += op.length;
    }
  }
  return out.join('')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)')
    .replace(/\(\?\)(?:\s*,\s*\(\?\))+/g, '(?)')
    .trim();
}

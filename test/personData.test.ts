// Finding and removing one person's identifier across stored data.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/shared/config';
import { mayBeOrdinaryWord, NOT_REACHABLE, type PersonDataStep } from '../src/shared/personData';
import { login } from '../src/worker/auth';
import { setSettings } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import worker, { usageBuffer } from '../src/worker/index';
import { confirmationValid, cursorValid, MAX_ROWS_PER_STEP, personMatcher, personRequest, scrubJson, type PersonRequest } from '../src/worker/personData';
import { createToken } from '../src/worker/tokens';
import { createD1 } from './d1';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = 'correct horse battery';
const ORIGIN = 'https://ambersight.example';
const ANN = 'ann@example.com';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(() => {
  vi.restoreAllMocks();
  usageBuffer.reset();
});

const newEnv = (over: Partial<Env> = {}): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS, ...over });

async function session(env: Env) {
  const r = await login(env, PASS, '1.1.1.1');
  if (!r.ok) throw new Error(r.error);
  return r.cookie.split(';')[0];
}

const post = (env: Env, path: string, body: unknown, headers: Record<string, string>) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', ...headers },
}), env, ctx);

const previewStep = (env: Env, cookie: string, identifier: string, cursor: string | null = null) => post(env, '/api/personal-data/preview', { identifier, cursor }, { Cookie: cookie });

/** Every step of a preview, added up. */
async function preview(env: Env, cookie: string, identifier: string) {
  const counts: Record<string, number> = {};
  let cursor: string | null = null;
  let steps = 0;
  for (;;) {
    const res = await previewStep(env, cookie, identifier, cursor);
    expect(res.status).toBe(200);
    const step = (await res.json()) as PersonDataStep;
    steps++;
    for (const [k, n] of Object.entries(step.counts)) counts[k] = (counts[k] ?? 0) + n;
    if (step.done) return { counts, last: step, steps };
    cursor = step.cursor;
  }
}

const removeStep = (env: Env, cookie: string, identifier: string, confirmation: string, cursor: string | null = null, passphrase = PASS) =>
  post(env, '/api/personal-data/remove', { identifier, passphrase, confirmation, cursor }, { Cookie: cookie });

async function removeAll(env: Env, cookie: string, identifier: string) {
  const { last } = await preview(env, cookie, identifier);
  const counts: Record<string, number> = {};
  const bodies: string[] = [];
  let cursor: string | null = null;
  let steps = 0;
  for (;;) {
    // The passphrase goes with the first step only, as the page sends it.
    const res = await removeStep(env, cookie, identifier, last.confirmation!, cursor, cursor ? '' : PASS);
    const text = await res.text();
    expect(res.status).toBe(200);
    bodies.push(text);
    const step = JSON.parse(text) as PersonDataStep;
    steps++;
    for (const [k, n] of Object.entries(step.counts)) counts[k] = (counts[k] ?? 0) + n;
    if (step.done) return { counts, last: step, steps, bodies };
    cursor = step.cursor;
  }
}

const finding = (env: Env, id: string, message: string, evidence: string) => env.DB.prepare(
  `INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
   VALUES (?1, 'acc1', '*', 'security', 'warning', ?1, ?2, ?3, 'Check it.', 'x', 'x', 'open')`,
).bind(id, message, evidence).run();
const deployment = (env: Env, id: string, author: string | null, message: string | null = null) => env.DB.prepare(
  `INSERT INTO deployments (account, script, id, created_on, author, message) VALUES ('acc1', 'api', ?1, '2026-11-01T00:00:00Z', ?2, ?3)`,
).bind(id, author, message).run();
const one = <T>(env: Env, sql: string) => env.DB.prepare(sql).first<T>();
const audit = (env: Env, id: string, o: { actor?: string; description?: string; product?: string; type?: string; resource?: string }) => env.DB.prepare(
  `INSERT INTO audit_events (account, id, at, actor, action, description, product, resource_type, resource_id) VALUES ('acc1', ?1, '2026-11-01T00:00:00Z', ?2, 'update', ?3, ?4, ?5, ?6)`,
).bind(id, o.actor ?? null, o.description ?? null, o.product ?? null, o.type ?? null, o.resource ?? null).run();
const manyDeployments = (env: Env, total: number) => env.DB.batch(Array.from({ length: total }, (_, i) => env.DB.prepare(
  `INSERT INTO deployments (account, script, id, created_on, author) VALUES ('acc1', 'api', ?1, 'x', ?2)`,
).bind(`d${i}`, ANN)));
const stepOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as PersonDataStep;
};

/** The same person in every place an identifier can be stored. */
async function seed(env: Env) {
  await deployment(env, 'd1', ANN, `shipped by ${ANN}`);
  await deployment(env, 'd2', `jo${ANN}`);
  await env.DB.prepare(
    `INSERT INTO audit_events (account, id, at, actor, action, description, resource_id) VALUES ('acc1', 'a1', '2026-11-01T00:00:00Z', ?1, 'update', ?2, ?1)`,
  ).bind(ANN.toUpperCase(), `Member ${ANN} changed`).run();
  await finding(env, 'f1', `Change by ${ANN}.`, JSON.stringify({ actor: ANN, nested: { list: [ANN, 'kept'] }, count: 3 }));
  await env.DB.prepare(`INSERT INTO admin_events (at, action, target, actor) VALUES ('2026-11-01T00:00:00Z', 'token.created', ?1, 'session 1')`).bind(`${ANN} laptop`).run();
  await env.DB.prepare(`INSERT INTO cf_alerts (account, id, sent, name, description) VALUES ('acc1', 'c1', 'x', 'Alert', ?1)`).bind(`Sent to ${ANN}`).run();
  await env.DB.prepare(`INSERT INTO accounts (id, name, added_at) VALUES ('acc1', ?1, 'x')`).bind(`${ANN}'s Account`).run();
  await env.DB.prepare(`INSERT INTO account_state (account, key, value) VALUES ('acc1', 'last_scan_warnings', ?1)`).bind(JSON.stringify([`Could not read ${ANN}`])).run();
  await env.DB.prepare(`INSERT INTO digest_parts (period, part, sent_at) VALUES ('2026-11-01', ?1, 'x')`).bind(`account:acc1:${ANN}`).run();
  await env.DB.prepare(`INSERT INTO view_cache (account, view, etag, body) VALUES ('acc1', 'timeline-14', 'e', ?1)`).bind(JSON.stringify({ author: ANN })).run();
  await env.DB.prepare(`INSERT INTO workers (account, name, last_seen, tags) VALUES ('acc1', 'api', 'x', ?1)`).bind(JSON.stringify([ANN])).run();
}

describe('what counts as the same identifier', () => {
  const scrub = (id: string, text: string) => personMatcher(id).scrub(text);

  it('matches a whole address in any case, and no longer address', () => {
    expect(scrub(ANN, 'By ANN@Example.com, then.')).toBe('By [removed], then.');
    expect(scrub(ANN, `<${ANN}> and ${ANN}.`)).toBe('<[removed]> and [removed].');
    expect(scrub(ANN, `jo${ANN}`)).toBe(`jo${ANN}`);
    expect(scrub(ANN, `mary.${ANN}`)).toBe(`mary.${ANN}`);
    expect(scrub(ANN, `${ANN}.au`)).toBe(`${ANN}.au`);
    expect(scrub(ANN, `${ANN}-old`)).toBe(`${ANN}-old`);
  });

  it('matches a name only as a name', () => {
    expect(scrub('Ann', "Ann's account, ANN and ann.")).toBe("[removed]'s account, ANN and ann.");
    for (const text of ['Channel', 'JoAnn', 'Anna', 'Ann-Marie', 'Mary-Ann', 'Ann.Lee', 'Ann@example.com', 'Ann_1']) expect(scrub('Ann', text)).toBe(text);
    expect(scrub('Ann Lee', 'by Ann  Lee today, not ann lee')).toBe('by [removed] today, not ann lee');
    expect(scrub('Žofie', 'Žofie a ŽOFIE a žofie')).toBe('[removed] a ŽOFIE a žofie');
    expect(scrub('Will', 'New schedules will be rejected. Will said so.')).toBe('New schedules will be rejected. [removed] said so.');
  });

  it('narrows the search for a name in any script, because a name matches as typed', () => {
    expect(personMatcher('Анна').like).toBe('%Анна%');
    expect(personMatcher('Анна Ли').like).toBe('%Анна%Ли%');
    // An address matches in any case, and LIKE folds only ASCII.
    expect(personMatcher('žofie@example.com').like).toBe('%ofie@example.com%');
  });

  it('knows which input may be an ordinary word', () => {
    expect(mayBeOrdinaryWord('Will')).toBe(true);
    expect(mayBeOrdinaryWord('Will Smith')).toBe(false);
    expect(mayBeOrdinaryWord(ANN)).toBe(false);
  });

  it('takes wildcards and regular expression characters literally', () => {
    expect(scrub('a%n_e', 'a%n_e annie')).toBe('[removed] annie');
    expect(scrub('a.n+', 'a.n+ ann')).toBe('[removed] ann');
    expect(personMatcher('a%n_e').like).toBe('%a\\%n\\_e%');
    expect(personMatcher('Žofie').like).toBe('%Žofie%');
  });

  it('refuses input that would match too much, without repeating it', () => {
    for (const identifier of ['', 'ab', '  a ', '%%%%', '....', 'removed', '[removed]', 'x'.repeat(255), 'two\nlines']) {
      const r = personRequest({ identifier });
      expect('error' in r, identifier).toBe(true);
      if ('error' in r && identifier.length > 2) expect(r.error).not.toContain(identifier);
    }
    for (const cursor of ['nonsense', '12.0', `12.0.1.${'g'.repeat(64)}`, 12]) expect('error' in personRequest({ identifier: ANN, cursor })).toBe(true);
    expect('error' in personRequest({ identifier: 'ann' })).toBe(false);
  });

  it('rewrites JSON values only, so it stays valid and its keys keep working', () => {
    const m = personMatcher(ANN);
    const out = scrubJson(JSON.stringify({ actor: ANN, q: 'say "hi" \\ ok', [ANN]: 1, n: [1, null, { who: `x ${ANN}` }] }), m);
    expect(JSON.parse(out)).toEqual({ actor: '[removed]', q: 'say "hi" \\ ok', [ANN]: 1, n: [1, null, { who: 'x [removed]' }] });
    expect(JSON.parse(scrubJson(JSON.stringify({ member: 'member' }), personMatcher('member')))).toEqual({ member: '[removed]' });
    // An identifier that JSON escapes is still found, and the result still parses.
    const quoted = personMatcher('Ann "Red" Lee');
    expect(JSON.parse(scrubJson(JSON.stringify({ who: 'Ann "Red" Lee' }), quoted))).toEqual({ who: '[removed]' });
    const untouched = '{ "spaced":   "as stored" }';
    expect(scrubJson(untouched, m)).toBe(untouched);
    expect(scrubJson(`not json ${ANN}`, m)).toBe('not json [removed]');
  });
});

describe('the preview', () => {
  it('counts each kind of data and returns no record', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    const { counts, last } = await preview(env, cookie, ANN);
    expect(counts).toMatchObject({ deployments: 1, auditEvents: 1, findings: 1, adminLog: 1, cloudflareAlerts: 1, accountNames: 1, scanNotes: 1, digestDelivery: 1, infrastructure: 1 });
    expect(last.cachedViews).toBe(1);
    expect(JSON.stringify({ counts, last }).toLowerCase()).not.toContain(ANN);
    expect((await one<{ author: string }>(env, `SELECT author FROM deployments WHERE id = 'd1'`))!.author).toBe(ANN);
  });

  it('counts binding names, the workers.dev subdomain and resource IDs, and changes none of them', async () => {
    const env = newEnv();
    const cookie = await session(env);
    const bindings = JSON.stringify([{ type: 'kv_namespace', name: 'Ann' }]);
    await env.DB.prepare(`INSERT INTO workers (account, name, last_seen, bindings) VALUES ('acc1', 'api', 'x', ?1)`).bind(bindings).run();
    await env.DB.prepare(`INSERT INTO account_state (account, key, value) VALUES ('acc1', 'workers_subdomain', 'Ann')`).run();
    await audit(env, 'w', { product: 'workers', type: 'script', resource: 'Ann' });
    expect((await preview(env, cookie, 'Ann')).counts).toEqual({ infrastructure: 3 });
    const { counts } = await removeAll(env, cookie, 'Ann');
    expect(counts).toEqual({});
    expect((await one<{ bindings: string }>(env, 'SELECT bindings FROM workers'))!.bindings).toBe(bindings);
    expect((await one<{ value: string }>(env, `SELECT value FROM account_state WHERE key = 'workers_subdomain'`))!.value).toBe('Ann');
  });

  it('counts passkey names, which may name a person', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await env.DB.prepare(`INSERT INTO passkeys (id, public_key, alg, name, created_at) VALUES ('k1', '{}', -7, ?1, 'x'), ('k2', '{}', -7, 'Office YubiKey', 'x')`)
      .bind("Ann's MacBook").run();
    const { counts } = await preview(env, cookie, 'Ann');
    expect(counts.passkeyNames).toBe(1);
  });

  it('finds a name written in another script, in its exact form', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await deployment(env, 'd1', 'Анна');
    await deployment(env, 'd2', 'анна');
    expect((await preview(env, cookie, 'Анна')).counts).toEqual({ deployments: 1 });
  });

  it('gives no confirmation and writes no log entry until the whole search has run', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await manyDeployments(env, MAX_ROWS_PER_STEP + 5);
    const logged = async () => (await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM admin_events WHERE action = 'personal-data.previewed'`))!.n;
    let step = await stepOf(await previewStep(env, cookie, ANN));
    while (!step.done) {
      expect(step.confirmation).toBeUndefined();
      expect(await logged()).toBe(0);
      step = await stepOf(await previewStep(env, cookie, ANN, step.cursor));
    }
    expect(step.confirmation).toBeTruthy();
    expect(await logged()).toBe(1);
  });

  it('accepts only the cursors it issued, for this session and identifier', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await manyDeployments(env, MAX_ROWS_PER_STEP + 5);
    const { cursor } = await stepOf(await previewStep(env, cookie, ANN));
    const [, , expires, mac] = cursor!.split('.');
    const refused = async (res: Response) => {
      expect(res.status).toBe(400);
      expect(((await res.json()) as PersonDataStep).confirmation).toBeUndefined();
    };
    // The end of the tables, which would have minted a confirmation with nothing walked.
    await refused(await previewStep(env, cookie, ANN, '14.0'));
    await refused(await previewStep(env, cookie, ANN, `14.0.${expires}.${mac}`));
    await refused(await previewStep(env, cookie, ANN, `14.0.${Date.now() + 60_000}.${'0'.repeat(64)}`));
    await refused(await previewStep(env, cookie, 'bob@example.com', cursor));
    await refused(await previewStep(env, await session(env), ANN, cursor));
    expect((await previewStep(env, cookie, ANN.toUpperCase(), cursor)).status).toBe(200);
    expect((await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM admin_events WHERE action = 'personal-data.previewed'`))!.n).toBe(0);
  });

  it('treats wildcards in the input as text', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    const { counts, last } = await preview(env, cookie, 'a%n_@example.com');
    expect(counts).toEqual({});
    expect(last.cachedViews).toBe(0);
  });

  it('names settings by where they are, and does not edit them', async () => {
    const env = newEnv({ DIGEST_TO: `boss@example.com,${ANN}` });
    const cookie = await session(env);
    const config = defaultConfig();
    config.accounts.acc1 = { digestTo: [ANN], label: 'Acme' };
    config.digest.groupRecipients.sales = [ANN];
    const saved = JSON.stringify(config);
    await setSettings(env.DB, { config: saved, admin_notice_to: JSON.stringify([ANN]) }).run();
    const { last } = await preview(env, cookie, ANN);
    expect(last.reported!.map((e) => e.label).sort()).toEqual([
      'Digest recipients of a group', 'Digest recipients of an account',
      'Recipients of a waiting admin notice (cleared once it is delivered)', 'Worker variable DIGEST_TO',
    ]);
    expect(JSON.stringify(last)).not.toContain(ANN);
    const done = await removeAll(env, cookie, ANN);
    // The removal's own notice rewrites the waiting list, which has no mail channel here.
    expect(done.last.reported!.map((e) => e.label)).toEqual(expect.arrayContaining(['Digest recipients of a group', 'Digest recipients of an account', 'Worker variable DIGEST_TO']));
    expect((await one<{ value: string }>(env, `SELECT value FROM settings WHERE key = 'config'`))!.value).toBe(saved);
  });
});

describe('the removal', () => {
  it('replaces the identifier everywhere it may be changed, and keeps the rows', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    const { counts, last } = await removeAll(env, cookie, ANN);
    expect(counts).toMatchObject({ deployments: 1, auditEvents: 1, findings: 1, adminLog: 1, cloudflareAlerts: 1, accountNames: 1, scanNotes: 1, digestDelivery: 1 });
    expect(counts.infrastructure).toBeUndefined();
    expect(last.notReachable.join(' ')).toMatch(/already sent.*recipients.*browsers.*Backups.*Cloudflare/s);

    const d = await one<{ author: string; message: string }>(env, `SELECT author, message FROM deployments WHERE id = 'd1'`);
    expect(d).toEqual({ author: '[removed]', message: 'shipped by [removed]' });
    expect((await one<{ author: string }>(env, `SELECT author FROM deployments WHERE id = 'd2'`))!.author).toBe(`jo${ANN}`);
    const a = await one<{ actor: string; description: string; resource_id: string }>(env, `SELECT actor, description, resource_id FROM audit_events`);
    expect(a).toEqual({ actor: '[removed]', description: 'Member [removed] changed', resource_id: '[removed]' });
    const f = await one<{ id: string; message: string; evidence: string; status: string }>(env, `SELECT id, message, evidence, status FROM findings`);
    expect(f!.id).toBe('f1');
    expect(f!.status).toBe('open');
    expect(f!.message).toBe('Change by [removed].');
    expect(JSON.parse(f!.evidence)).toEqual({ actor: '[removed]', nested: { list: ['[removed]', 'kept'] }, count: 3 });
    expect((await one<{ name: string }>(env, 'SELECT name FROM accounts'))!.name).toBe("[removed]'s Account");
    expect(JSON.parse((await one<{ value: string }>(env, `SELECT value FROM account_state WHERE key = 'last_scan_warnings'`))!.value)).toEqual(['Could not read [removed]']);
    // A delivery record loses the address but still counts as sent.
    const part = await one<{ part: string; sent_at: string }>(env, 'SELECT part, sent_at FROM digest_parts');
    expect(part!.part).toMatch(/^h1:[0-9a-f]{64}$/);
    expect(part!.sent_at).toBe('x');
    // What only identifies something in Cloudflare is counted, not changed.
    expect((await one<{ tags: string }>(env, 'SELECT tags FROM workers'))!.tags).toContain(ANN);
    expect((await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM view_cache'))!.n).toBe(0);
  });

  it('hashes every older delivery record, not only the ones naming this person', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await env.DB.batch(['operators', `account:acc1:${ANN}`, 'group:Sales:bob@example.com'].map((part) =>
      env.DB.prepare(`INSERT INTO digest_parts (period, part, sent_at) VALUES ('2026-11-01', ?1, 'x')`).bind(part)));
    const { counts } = await removeAll(env, cookie, ANN);
    expect(counts.digestDelivery).toBe(1);
    const { results } = await env.DB.prepare('SELECT part, sent_at FROM digest_parts ORDER BY part').all<{ part: string; sent_at: string }>();
    expect(results.map((r) => r.part.replace(/^h1:[0-9a-f]{64}$/, 'hashed'))).toEqual(['hashed', 'hashed', 'operators']);
    expect(results.every((r) => r.sent_at === 'x')).toBe(true);
  });

  it('changes a resource ID only when it identifies a person, so Worker history stays linked', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await audit(env, 'worker', { actor: 'Ann', description: 'Ann deployed', product: 'workers', type: 'script', resource: 'Ann' });
    await audit(env, 'member', { product: 'account', type: 'account.member', resource: 'Ann' });
    await audit(env, 'user', { product: 'Users', type: 'profile', resource: 'Ann' });
    const { counts } = await removeAll(env, cookie, 'Ann');
    expect(counts.auditEvents).toBe(3);
    const rows = (await env.DB.prepare('SELECT id, actor, description, resource_id FROM audit_events ORDER BY id').all()).results;
    expect(rows).toEqual([
      { id: 'member', actor: null, description: null, resource_id: '[removed]' },
      { id: 'user', actor: null, description: null, resource_id: '[removed]' },
      { id: 'worker', actor: '[removed]', description: '[removed] deployed', resource_id: 'Ann' },
    ]);
  });

  it("leaves Ambersight's own wording alone when removing a name", async () => {
    const env = newEnv();
    const cookie = await session(env);
    const change = '"Will changed a route" (audit log)';
    await finding(env, 'f1', `Errors rose. Will it last? Shortly before, ${change}.`, JSON.stringify({ change, actor: 'Will', member: 'Will', _cleanup: 'd1:Will' }));
    await env.DB.prepare(`UPDATE findings SET action = 'Will be rejected. Check it.'`).run();
    await deployment(env, 'd1', null, 'will be Will');
    const { counts } = await removeAll(env, cookie, 'Will');
    expect(counts).toMatchObject({ findings: 1, deployments: 1 });
    const f = await one<{ message: string; action: string; evidence: string }>(env, 'SELECT message, action, evidence FROM findings');
    expect(f!.message).toBe('Errors rose. Will it last? Shortly before, "[removed] changed a route" (audit log).');
    expect(f!.action).toBe('Will be rejected. Check it.');
    expect(JSON.parse(f!.evidence)).toEqual({ change: '"[removed] changed a route" (audit log)', actor: '[removed]', member: '[removed]', _cleanup: 'd1:Will' });
    expect((await one<{ message: string }>(env, `SELECT message FROM deployments WHERE id = 'd1'`))!.message).toBe('will be [removed]');
  });

  it("still replaces an address anywhere in a finding's sentence, but not its advice", async () => {
    const env = newEnv();
    const cookie = await session(env);
    await finding(env, 'f1', `Mail for ${ANN} bounced.`, '{}');
    await env.DB.prepare(`UPDATE findings SET action = ?1`).bind(`Ask ${ANN}.`).run();
    await removeAll(env, cookie, ANN);
    const f = await one<{ message: string; action: string }>(env, 'SELECT message, action FROM findings');
    expect(f).toEqual({ message: 'Mail for [removed] bounced.', action: `Ask ${ANN}.` });
  });

  it('says what can come back', () => {
    const text = NOT_REACHABLE.join(' ');
    expect(text).not.toContain('prevents that');
    expect(text).toMatch(/typed into a new deploy message can still come back/);
    expect(text).toMatch(/Saving the watched accounts/);
  });

  it('checks the passphrase once, and continues on a signed cursor', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await manyDeployments(env, MAX_ROWS_PER_STEP * 2 + 5);
    const { last } = await preview(env, cookie, ANN);
    expect((await removeStep(env, cookie, ANN, last.confirmation!, null, '')).status).toBe(400);
    const first = await stepOf(await removeStep(env, cookie, ANN, last.confirmation!));
    expect(first.done).toBe(false);
    expect(first.cursor).not.toContain(ANN);

    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const second = await stepOf(await post(env, '/api/personal-data/remove', { identifier: ANN, cursor: first.cursor }, { Cookie: cookie }));
    expect(second.counts.deployments).toBe(MAX_ROWS_PER_STEP);
    expect(derive).not.toHaveBeenCalled();

    for (const res of [
      await removeStep(env, cookie, 'bob@example.com', '', second.cursor, ''),
      await removeStep(env, await session(env), ANN, '', second.cursor, ''),
      await removeStep(env, cookie, ANN, '', `${second.cursor!.slice(0, -1)}${second.cursor!.endsWith('0') ? '1' : '0'}`, ''),
    ]) expect(res.status).toBe(400);
    expect((await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deployments WHERE author = '[removed]'`))!.n).toBe(MAX_ROWS_PER_STEP * 2);
  });

  it('keeps a preview cursor from standing in for the passphrase, and lets a cursor expire', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await manyDeployments(env, MAX_ROWS_PER_STEP * 2 + 5);
    const from = await stepOf(await previewStep(env, cookie, ANN));
    expect((await removeStep(env, cookie, ANN, '', from.cursor, '')).status).toBe(400);
    expect((await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deployments WHERE author = '[removed]'`))!.n).toBe(0);

    const { last } = await preview(env, cookie, ANN);
    const step = await stepOf(await removeStep(env, cookie, ANN, last.confirmation!));
    const id = cookie.split('=')[1];
    const req = personRequest({ identifier: ANN, cursor: step.cursor }) as PersonRequest;
    expect(await cursorValid(id, 'remove', req)).toBe(true);
    expect(await cursorValid(id, 'preview', req)).toBe(false);
    expect(await cursorValid(id, 'remove', req, Date.now() + 16 * 60_000)).toBe(false);
    expect(await cursorValid(id, 'remove', req, Date.now() - 60 * 60_000)).toBe(false);
  });

  it('never puts the identifier in the admin log or a response', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    const { bodies } = await removeAll(env, cookie, ANN);
    for (const body of bodies) expect(body.toLowerCase()).not.toContain(ANN);
    const { results } = await env.DB.prepare(`SELECT action, target, actor FROM admin_events WHERE action LIKE 'personal-data.%' ORDER BY id`).all<{ action: string; target: string; actor: string }>();
    expect(results.map((r) => r.action)).toEqual(['personal-data.previewed', 'personal-data.removed']);
    expect(results[1].target).toMatch(/^\d+ stored records changed, cached views cleared$/);
    const everything = JSON.stringify((await env.DB.prepare('SELECT * FROM admin_events').all()).results).toLowerCase();
    expect(everything).not.toContain(ANN);
    const settings = JSON.stringify((await env.DB.prepare('SELECT * FROM settings').all()).results).toLowerCase();
    expect(settings).not.toContain(ANN);
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls]).toLowerCase()).not.toContain(ANN);
  });

  it('keeps the identifier out of error responses', async () => {
    const env = newEnv();
    const cookie = await session(env);
    const secret = 'Ann "Unique" Lee';
    await env.DB.exec('DROP TABLE deployments');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await previewStep(env, cookie, secret);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('Unique');
    expect(JSON.stringify(err.mock.calls)).not.toContain('Unique');
    for (const bad of ['ab', 'x'.repeat(300)]) expect(await (await previewStep(env, cookie, bad)).text()).not.toContain(bad);
  });

  it('changes nothing with a wrong passphrase, and limits the attempts', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    const { last } = await preview(env, cookie, ANN);
    expect((await removeStep(env, cookie, ANN, last.confirmation!, null, 'wrong passphrase')).status).toBe(401);
    expect((await one<{ author: string }>(env, `SELECT author FROM deployments WHERE id = 'd1'`))!.author).toBe(ANN);
    expect((await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM view_cache'))!.n).toBe(1);
    expect((await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM admin_events WHERE action = 'personal-data.removed'`))!.n).toBe(0);
    let status = 0;
    for (let i = 0; i < 6; i++) status = (await removeStep(env, cookie, ANN, last.confirmation!, null, 'wrong passphrase')).status;
    expect(status).toBe(429);
    expect((await removeStep(env, cookie, ANN, last.confirmation!)).status).toBe(429);
  });

  it('needs a preview of the same identifier by the same session', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    const { last } = await preview(env, cookie, ANN);
    expect((await removeStep(env, cookie, 'bob@example.com', last.confirmation!)).status).toBe(400);
    expect((await removeStep(env, cookie, ANN, 'made up')).status).toBe(400);
    expect((await removeStep(env, await session(env), ANN, last.confirmation!)).status).toBe(400);
    expect((await one<{ author: string }>(env, `SELECT author FROM deployments WHERE id = 'd1'`))!.author).toBe(ANN);
    const later = Date.now() + 3 * 3_600_000;
    expect(await confirmationValid(cookie.split('=')[1], ANN, last.confirmation, later)).toBe(false);
    expect(await confirmationValid(cookie.split('=')[1], ANN.toUpperCase(), last.confirmation)).toBe(true);
  });

  it('refuses API tokens and other origins', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    const generation = (await one<{ cred: string }>(env, 'SELECT cred FROM sessions'))!.cred;
    const r = await createToken(env.DB, 'Grafana', { days: 30, generation, accounts: 'all', people: true });
    if ('error' in r) throw new Error(r.error);
    // The token is good: it is these routes that it cannot use.
    expect((await worker.fetch(new Request(`${ORIGIN}/api/overview`, { headers: { Authorization: `Bearer ${r.token}` } }), env, ctx)).status).toBe(200);
    for (const path of ['/api/personal-data/preview', '/api/personal-data/remove']) {
      const viaToken = await post(env, path, { identifier: ANN, passphrase: PASS }, { Authorization: `Bearer ${r.token}` });
      expect(viaToken.status).toBe(401);
      const foreign = await post(env, path, { identifier: ANN, passphrase: PASS }, { Cookie: cookie, Origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      const sameSite = await post(env, path, { identifier: ANN, passphrase: PASS }, { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' });
      expect(sameSite.status).toBe(403);
      expect((await post(env, path, { identifier: ANN }, {})).status).toBe(401);
    }
    expect((await one<{ author: string }>(env, `SELECT author FROM deployments WHERE id = 'd1'`))!.author).toBe(ANN);
  });

  it('is safe to repeat', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await seed(env);
    await removeAll(env, cookie, ANN);
    const before = (await env.DB.prepare('SELECT id, author, message FROM deployments ORDER BY id').all()).results;
    const again = await removeAll(env, cookie, ANN);
    expect(again.counts).toEqual({});
    expect((await env.DB.prepare('SELECT id, author, message FROM deployments ORDER BY id').all()).results).toEqual(before);
    expect((await one<{ evidence: string }>(env, 'SELECT evidence FROM findings'))!.evidence).not.toContain('[[');
  });

  it('works through more than one step and finishes', async () => {
    const env = newEnv();
    const cookie = await session(env);
    const total = MAX_ROWS_PER_STEP * 2 + 30;
    await env.DB.batch(Array.from({ length: total }, (_, i) => env.DB.prepare(
      `INSERT INTO deployments (account, script, id, created_on, author) VALUES ('acc1', 'api', ?1, 'x', ?2)`,
    ).bind(`d${i}`, i % 2 ? ANN : ANN.toUpperCase())));
    const first = (await (await previewStep(env, cookie, ANN)).json()) as PersonDataStep;
    expect(first.done).toBe(false);
    expect(first.cursor).toMatch(/^\d+\.\d+\.\d+\.[0-9a-f]{64}$/);
    expect(first.counts.deployments).toBe(MAX_ROWS_PER_STEP);
    const seen = await preview(env, cookie, ANN);
    expect(seen.counts.deployments).toBe(total);
    expect(seen.steps).toBeGreaterThanOrEqual(3);

    const { counts, steps } = await removeAll(env, cookie, ANN);
    expect(counts.deployments).toBe(total);
    expect(steps).toBeGreaterThanOrEqual(3);
    expect((await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deployments WHERE author = '[removed]'`))!.n).toBe(total);
  });

  it('walks past candidates that are not real matches', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await env.DB.batch([
      ...Array.from({ length: MAX_ROWS_PER_STEP + 5 }, (_, i) => env.DB.prepare(
        `INSERT INTO deployments (account, script, id, created_on, author) VALUES ('acc1', 'api', ?1, 'x', 'channel')`,
      ).bind(`c${i}`)),
      env.DB.prepare(`INSERT INTO deployments (account, script, id, created_on, author) VALUES ('acc1', 'api', 'real', 'x', 'Ann')`),
    ]);
    const { counts } = await preview(env, cookie, 'Ann');
    expect(counts.deployments).toBe(1);
    await removeAll(env, cookie, 'Ann');
    expect((await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deployments WHERE author = 'channel'`))!.n).toBe(MAX_ROWS_PER_STEP + 5);
    expect((await one<{ author: string }>(env, `SELECT author FROM deployments WHERE id = 'real'`))!.author).toBe('[removed]');
  });

  it('leaves a value alone if a scan rewrote it meanwhile, and reads it again', async () => {
    const env = newEnv();
    const cookie = await session(env);
    await deployment(env, 'd1', ANN);
    const { last } = await preview(env, cookie, ANN);
    // Between the read and the write of the first step, the row changes.
    const realBatch = env.DB.batch.bind(env.DB);
    let raced = false;
    env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      if (!raced && statements.some((s) => (s as unknown as { sql?: string }).sql?.startsWith('UPDATE deployments'))) {
        raced = true;
        await env.DB.prepare(`UPDATE deployments SET author = ?1 WHERE id = 'd1'`).bind(`${ANN} (edited)`).run();
      }
      return realBatch(statements);
    }) as typeof env.DB.batch;
    const res = await removeStep(env, cookie, ANN, last.confirmation!);
    const step = (await res.json()) as PersonDataStep;
    expect(step.done).toBe(false);
    expect(step.counts.deployments).toBeUndefined();
    const next = (await (await removeStep(env, cookie, ANN, last.confirmation!, step.cursor)).json()) as PersonDataStep;
    expect(next.counts.deployments).toBe(1);
    expect((await one<{ author: string }>(env, `SELECT author FROM deployments WHERE id = 'd1'`))!.author).toBe('[removed] (edited)');
  });
});

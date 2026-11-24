// API token scopes: which accounts a token reaches, what it reads without the person-linked grant,
// how the cached copies of a view stay apart, and what happens to tokens from before scopes.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/shared/config';
import type { SelfCost } from '../src/shared/types';
import { login } from '../src/worker/auth';
import { configFrom, getSettings, recordUsage, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { bumpRevision } from '../src/worker/history';
import worker, { usageBuffer } from '../src/worker/index';
import { packageFindings } from '../src/worker/packages';
import { listTokens } from '../src/worker/tokens';
import { PERSON_EVIDENCE, plainFinding, PLAIN_EVIDENCE } from '../src/worker/tokenView';
import { createD1 } from './d1';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = 'correct horse battery';
const ORIGIN = 'https://ambersight.example';
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  vi.unstubAllGlobals();
  usageBuffer.reset();
});

/** Every value below names a person or is free text that can. None may reach a token without the grant. */
const PEOPLE = ['author@example.org', 'actor@example.org', 'Jan Novak', 'jan-novak', 'member-id-4711', 'novak-note', 'novak@alerts.example'];
const PERSON_KEYS = ['author', 'actor', 'changedBy', 'member', 'branch', 'repo'];
const REPO = 'jan-novak-gh/private-repo';
/** The repository the Worker was mapped to when its stored lockfile error was written. */
const OLD_REPO = 'jan-novak-old/earlier-repo';
const PACKAGES_UNREADABLE = "Ambersight could not read this Worker's packages.";

const findingId = (account: string, name: string) => `${account}/${name}`;

async function seed(e: Env, account: string) {
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  const db = e.DB;
  const finding = (name: string, script: string, module: string, code: string, message: string, evidence: Record<string, unknown>, action = 'Look at it.') => [
    db.prepare(`INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status) VALUES (?1, ?2, ?3, ?4, 'warning', ?5, ?6, ?7, ?8, ?9, ?9, 'open')`)
      .bind(findingId(account, name), account, script, module, code, message, JSON.stringify(evidence), action, at),
    db.prepare(`INSERT INTO finding_events (account, finding_id, at, kind, severity, check_id, script) VALUES (?1, ?2, ?3, 'opened', 'warning', ?4, ?5)`)
      .bind(account, findingId(account, name), at, `${module}:${code}`, script),
  ];
  const change = '"Jan Novak edited a route" (audit log)';
  await db.batch([
    db.prepare(`INSERT INTO workers (account, name, last_seen, packages_error) VALUES (?1, 'api', ?2, ?3)`).bind(account, at, `No package-lock.json found in ${OLD_REPO}, or GITHUB_TOKEN has no Contents: Read on it.`),
    db.prepare(`INSERT INTO deployments (account, script, id, created_on, author, message, source) VALUES (?1, 'api', 'd1', ?2, 'author@example.org', 'novak-note: hotfix', 'wrangler')`).bind(account, at),
    db.prepare(`INSERT INTO audit_events (account, id, at, actor, action, description, product, resource_type, resource_id) VALUES (?1, 'a1', ?2, 'actor@example.org', 'update', 'Jan Novak edited a route', 'workers', 'script', 'api')`).bind(account, at),
    db.prepare(`INSERT INTO cf_alerts (account, id, sent, alert_type, name, description) VALUES (?1, 'c1', ?2, 'access', 'Access alert', 'Sign-in by novak@alerts.example')`).bind(account, at),
    db.prepare(`INSERT INTO resources (account, kind, id, name, extra) VALUES (?1, 'pages', 'site', 'site', ?2)`).bind(account, JSON.stringify({
      subdomain: null, domains: [], latest: { id: 'p1', createdOn: at, status: 'failure', stage: 'build', environment: 'production', branch: 'jan-novak/fix' },
    })),
    ...finding('member', '*', 'security', 'member-change-1', 'An account member was added.', { action: 'create', actor: 'actor@example.org', member: 'member-id-4711', at }),
    ...finding('anomaly', 'api', 'errors', 'error-rate', `Errors jumped. Shortly before, ${change}.`, { change, changedAt: at, changedBy: 'actor@example.org' }),
    ...finding('binding', 'api', 'runaway', 'spike', 'Requests jumped. Shortly before, binding KV_CACHE was removed.', { change: 'binding KV_CACHE was removed', changedAt: at }),
    ...finding('pages', '*', 'pages', 'deploy-failed-site', 'The latest deploy of Pages project site failed.', { project: 'site', branch: 'jan-novak/fix' }),
    ...finding('packages', 'api', 'packages', 'lockfile-unreadable', `Ambersight could not read this Worker's packages: No package-lock.json found in ${OLD_REPO}.`, { repo: REPO }),
  ]);
}

async function install(db = createD1()) {
  const e: Env = { DB: db, ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS };
  const config = defaultConfig();
  config.modules.packages = true;
  config.packageRepos = { api: { repo: REPO } };
  await e.DB.batch([
    upsertAccount(e.DB, { id: 'acc1', name: 'Alpha' }, new Date('2026-01-01T00:00:00Z')),
    upsertAccount(e.DB, { id: 'acc2', name: "Jan Novak's Account" }, new Date('2026-01-02T00:00:00Z')),
    upsertAccount(e.DB, { id: 'off', name: 'Unticked', enabled: false }, new Date('2026-01-03T00:00:00Z')),
    setSettings(e.DB, { config: JSON.stringify(config) }),
  ]);
  await seed(e, 'acc1');
  await seed(e, 'acc2');
  const r = await login(e, PASS, '1.1.1.1');
  if (!r.ok) throw new Error(r.error);
  return { e, session: r.cookie.split(';')[0] };
}

const asSession = (e: Env, session: string, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: session } }), e, ctx);
const asToken = (e: Env, token: string, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers } }), e, ctx);
const create = (e: Env, session: string, body: Record<string, unknown>) => worker.fetch(new Request(`${ORIGIN}/api/tokens`, {
  method: 'POST', body: JSON.stringify({ name: 'reader', passphrase: PASS, ...body }),
  headers: { Cookie: session, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
}), e, ctx);
async function mint(e: Env, session: string, body: Record<string, unknown>) {
  const res = await create(e, session, body);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const since = () => encodeURIComponent(new Date(Date.now() - 2 * 3_600_000).toISOString());
/** Every route a token can read for one account, as a path that takes `account` as a query value. */
const ACCOUNT_ROUTES = () => ['overview', 'analytics?range=7d', 'workers/api', 'findings?status=open', `changes?since=${since()}`, 'timeline?days=14', 'resources', 'packages', 'self-cost', 'report?days=7'];
const withAccount = (route: string, account: string) => `/api/${route}${route.includes('?') ? '&' : '?'}account=${account}`;
const history = (account: string, name = 'member') => `/api/findings/${encodeURIComponent(findingId(account, name))}/history`;

/** Every string in a JSON value, and separately every key, so nothing can hide in nesting. */
function walk(value: unknown, out: { strings: string[]; keys: string[] } = { strings: [], keys: [] }) {
  if (typeof value === 'string') out.strings.push(value);
  else if (Array.isArray(value)) value.forEach((v) => walk(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.keys.push(k);
      walk(v, out);
    }
  }
  return out;
}

async function expectNoPeople(res: Response, label: string) {
  expect(res.status, label).toBe(200);
  const text = await res.text();
  const isJson = (res.headers.get('Content-Type') ?? '').includes('json');
  const { strings, keys } = isJson ? walk(JSON.parse(text)) : { strings: [text], keys: [] as string[] };
  for (const person of PEOPLE) expect(strings.filter((s) => s.includes(person)), `${label}: ${person}`).toEqual([]);
  for (const key of PERSON_KEYS) expect(keys, `${label}: key ${key}`).not.toContain(key);
}

/** Evidence not written out as keys where a finding is made, and the keys each source adds. */
const DYNAMIC_EVIDENCE: Record<string, string[]> = {
  '...f.evidence': [],
  '...size': ['size', 'keys', 'objects'],
  '...leavesBehind(onlyOf.get(w.name), activity)': ['leavesBehind', 'stillUsed', '_cleanup'],
  '[s.kind]': ['kv', 'd1', 'r2', 'queues'],
};

/** Every evidence key in the Worker's source, and whatever could not be read as one. */
function emittedEvidence() {
  const keys = new Set<string>();
  const unknown: string[] = [];
  const dynamic = (file: string, text: string) => {
    if (Object.hasOwn(DYNAMIC_EVIDENCE, text)) DYNAMIC_EVIDENCE[text].forEach((k) => keys.add(k));
    else unknown.push(`${file}: ${text}`);
  };
  const spread = (file: string, node: ts.Expression, text: string) => {
    if (ts.isParenthesizedExpression(node)) spread(file, node.expression, text);
    else if (ts.isConditionalExpression(node)) [node.whenTrue, node.whenFalse].forEach((side) => spread(file, side, text));
    else if (ts.isObjectLiteralExpression(node)) literal(file, node);
    else dynamic(file, text);
  };
  const literal = (file: string, node: ts.ObjectLiteralExpression) => {
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) spread(file, p.expression, p.getText());
      else if (p.name && ts.isComputedPropertyName(p.name)) dynamic(file, p.name.getText());
      else if (p.name) keys.add((p.name as ts.Identifier).text);
    }
  };
  for (const name of readdirSync('src/worker').filter((f) => f.endsWith('.ts'))) {
    const file = `src/worker/${name}`;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'finding') {
        const evidence = node.arguments[5];
        if (evidence && ts.isObjectLiteralExpression(evidence)) literal(file, evidence);
        else dynamic(file, evidence?.getText() ?? 'finding() without evidence');
      } else if (ts.isPropertyAssignment(node) && node.name.getText() === 'evidence' && ts.isObjectLiteralExpression(node.initializer)) {
        literal(file, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  }
  return { keys, unknown };
}

describe('choosing what a new token reads', () => {
  it('refuses a token with no explicit choice of accounts', async () => {
    const { e, session } = await install();
    for (const accounts of [undefined, [], 'acc1', true, ['all'], ['nope'], ['off'], ['acc1', 'nope'], [7]]) {
      expect((await create(e, session, { accounts })).status, JSON.stringify(accounts)).toBe(400);
    }
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first('n')).toBe(0);
  });

  it('stores the accounts chosen, and person-linked data only when asked for with true', async () => {
    const { e, session } = await install();
    await mint(e, session, { name: 'one', accounts: ['acc1', 'acc1'] });
    await mint(e, session, { name: 'all', accounts: 'all', people: 'yes' });
    await mint(e, session, { name: 'named', accounts: ['acc2'], people: true });
    const list = await listTokens(e);
    expect(list.map((t) => [t.name, t.accounts, t.people, t.olderScope])).toEqual(expect.arrayContaining([
      ['one', ['acc1'], false, false],
      ['all', 'all', false, false],
      ['named', ['acc2'], true, false],
    ]));
  });
});

describe('a token limited to some accounts', () => {
  it('gets the same refusal for another account as for an unknown one, on every route', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    for (const route of ACCOUNT_ROUTES()) {
      expect((await asToken(e, token, withAccount(route, 'acc1'))).status, route).toBe(200);
      const unknown = await asToken(e, token, withAccount(route, 'no-such-account'));
      for (const other of ['acc2', 'off']) {
        const res = await asToken(e, token, withAccount(route, other));
        expect(res.status, `${route} ${other}`).toBe(404);
        expect(await res.clone().text(), `${route} ${other}`).toBe(await unknown.clone().text());
      }
    }
  });

  it('reads its first permitted account when it names none', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc2'] });
    const o = (await (await asToken(e, token, '/api/overview')).json()) as { account: { id: string }; findings: { id: string }[] };
    expect(o.account.id).toBe('acc2');
    expect(o.findings.every((f) => f.id.startsWith('acc2/'))).toBe(true);
    const findings = (await (await asToken(e, token, '/api/findings')).json()) as { id: string }[];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.id.startsWith('acc2/'))).toBe(true);
  });

  it('sees only its accounts in the account list, and not how many others exist', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc2'] });
    expect(((await (await asToken(e, token, '/api/accounts')).json()) as { id: string }[]).map((a) => a.id)).toEqual(['acc2']);
    expect(await (await asToken(e, token, '/api/overview')).json()).not.toHaveProperty('accountCount');
    const all = await mint(e, session, { accounts: 'all' });
    expect(((await (await asToken(e, all, '/api/accounts')).json()) as { id: string }[]).map((a) => a.id)).toEqual(['acc1', 'acc2']);
    expect(await (await asToken(e, all, '/api/overview')).json()).toHaveProperty('accountCount', 2);
  });

  it('reads the history of its own findings by id, and another account\'s reads like no finding at all', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    expect(((await (await asToken(e, token, history('acc1'))).json()) as unknown[]).length).toBe(1);
    const foreign = await asToken(e, token, history('acc2'));
    const missing = await asToken(e, token, history('acc1', 'never-existed'));
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.text()).toBe(await missing.text());
    // The dashboard still reads every account's history.
    expect(((await (await asSession(e, session, history('acc2'))).json()) as unknown[]).length).toBe(1);
  });

  it('gets a clear refusal once none of its accounts is watched', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    await upsertAccount(e.DB, { id: 'acc1', enabled: false }).run();
    for (const path of ['/api/overview', '/api/accounts', '/api/timeline', '/api/findings', history('acc1')]) {
      const res = await asToken(e, token, path);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toEqual({ error: 'This token may not read any account this install watches.', code: 'no_permitted_account' });
    }
  });

  it('gets a 404, not the refusal above, when it names an account and none of its accounts is watched', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    await upsertAccount(e.DB, { id: 'acc1', enabled: false }).run();
    const res = await asToken(e, token, '/api/overview?account=acc1');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'unknown_account' });
  });

  it('treats a stored list it cannot read as no accounts', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    await e.DB.prepare(`UPDATE api_tokens SET accounts = 'not json'`).run();
    expect((await asToken(e, token, '/api/overview')).status).toBe(403);
  });

  it('is not told the install-wide usage, which would show how many accounts are scanned', async () => {
    const { e, session } = await install();
    await e.DB.batch([
      recordUsage(e.DB, new Date(), { cronRuns: 72, apiRequests: 9, subrequests: 8, rowsRead: 7, rowsWritten: 6 }),
      e.DB.prepare(`INSERT INTO account_state (account, key, value) VALUES ('acc1', 'last_scan_at', '2026-11-09T12:00:00Z'), ('acc1', 'last_scan_calls', '12'), ('acc2', 'last_scan_calls', '99')`),
    ]);
    const read = async (res: Response) => (await res.json()) as SelfCost;
    for (const grant of [{ accounts: ['acc1'] }, { accounts: ['acc1'], people: true }, { accounts: ['acc1', 'acc2'] }]) {
      const cost = await read(await asToken(e, await mint(e, session, grant), '/api/self-cost?account=acc1'));
      expect(cost.days, JSON.stringify(grant)).toEqual([]);
      expect(cost.lastScan).toMatchObject({ at: '2026-11-09T12:00:00Z', subrequests: 12 });
      expect(cost.allowances.requestsPerDay).toBeGreaterThan(0);
    }
    const all = await read(await asToken(e, await mint(e, session, { accounts: 'all' }), '/api/self-cost?account=acc1'));
    expect(all.days.map((d) => d.cronRuns)).toEqual([72]);
    expect((await read(await asSession(e, session, '/api/self-cost?account=acc1'))).days.map((d) => d.cronRuns)).toEqual([72]);
  });
});

describe('person-linked data', () => {
  it('reaches no route for a token without the grant', async () => {
    const { e, session } = await install();
    for (const token of [await mint(e, session, { accounts: 'all' }), await mint(e, session, { accounts: ['acc1', 'acc2'] })]) {
      for (const account of ['acc1', 'acc2']) {
        for (const route of ACCOUNT_ROUTES()) await expectNoPeople(await asToken(e, token, withAccount(route, account)), `${route} ${account}`);
        await expectNoPeople(await asToken(e, token, history(account)), `history ${account}`);
      }
      await expectNoPeople(await asToken(e, token, '/api/accounts'), 'accounts');
      await expectNoPeople(await asToken(e, token, '/api/health'), 'health');
    }
  });

  it('is seeded on every route that can carry it, so the walk above has something to find', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: 'all', people: true });
    for (const route of ['overview', 'workers/api', 'findings?status=open', `changes?since=${since()}`, 'timeline?days=14', 'packages']) {
      const text = await (await asToken(e, token, withAccount(route, 'acc1'))).text();
      expect(PEOPLE.some((person) => text.includes(person)), route).toBe(true);
    }
    // The client report is handed to clients, so it never carries it, whoever asks.
    await expectNoPeople(await asToken(e, token, withAccount('report?days=7', 'acc1')), 'report with the grant');
    await expectNoPeople(await asSession(e, session, withAccount('report?days=7', 'acc1')), 'report for a session');
  });

  it('leaves the operational facts in place', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    const timeline = (await (await asToken(e, token, '/api/timeline')).json()) as { kind: string; message?: string; source: string | null }[];
    expect(timeline.map((t) => t.kind).sort()).toEqual(['audit', 'cf-alert', 'deploy', 'pages']);
    expect(timeline.find((t) => t.kind === 'pages')!.message).toBe('production deploy: failed at build');
    expect(timeline.find((t) => t.kind === 'deploy')).not.toHaveProperty('message');
    expect(timeline.find((t) => t.kind === 'cf-alert')!.source).toBe('Access alert');
    const findings = (await (await asToken(e, token, '/api/findings')).json()) as { id: string; message: string; evidence: Record<string, unknown> }[];
    const of = (name: string) => findings.find((f) => f.id === findingId('acc1', name))!;
    expect(of('anomaly').message).toBe('Errors jumped. A change was recorded shortly before.');
    expect(of('anomaly').evidence).not.toHaveProperty('change');
    expect(of('binding').message).toBe('Requests jumped. Shortly before, binding KV_CACHE was removed.');
    expect(of('binding').evidence.change).toBe('binding KV_CACHE was removed');
    expect(of('packages').message).toBe(PACKAGES_UNREADABLE);
    const detail = (await (await asToken(e, token, '/api/workers/api')).json()) as { deploys: object[]; changes: { kind: string }[] };
    expect(detail.deploys).toHaveLength(1);
    expect(detail.changes.map((c) => c.kind)).toContain('audit');
  });

  it('shows the label from Settings for an account, or a neutral name, and never the name from Cloudflare', async () => {
    const { e, session } = await install();
    await upsertAccount(e.DB, { id: 'acc1', name: 'Jan Novak' }).run();
    const config = configFrom(await getSettings(e.DB));
    config.accounts.acc2 = { label: 'Client Two' };
    await e.DB.batch([setSettings(e.DB, { config: JSON.stringify(config) }), bumpRevision(e.DB)]);
    const token = await mint(e, session, { accounts: 'all' });
    const labels = ((await (await asToken(e, token, '/api/accounts')).json()) as { label: string }[]).map((a) => a.label);
    expect(labels).toEqual(['Account acc1', 'Client Two']);
    for (const [account, label] of [['acc1', 'Account acc1'], ['acc2', 'Client Two']]) {
      expect(((await (await asToken(e, token, `/api/overview?account=${account}`)).json()) as { account: { label: string } }).account.label).toBe(label);
      const report = await (await asToken(e, token, `/api/report?account=${account}`)).text();
      expect(report).toContain(label);
      expect(report).not.toContain('Jan Novak');
    }
    const named = await mint(e, session, { accounts: ['acc1'], people: true });
    expect(((await (await asToken(e, named, '/api/accounts')).json()) as { label: string }[])[0].label).toBe('Jan Novak');
  });

  it('never repeats a stored lockfile error, which can name an earlier repository', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    const view = (await (await asToken(e, token, '/api/packages')).json()) as { workers: { error: string | null }[] };
    expect(view.workers.map((w) => w.error)).toEqual([PACKAGES_UNREADABLE]);
    // The finding's sentence is written in packages.ts: this fails if its wording moves away from tokenView.ts.
    const config = defaultConfig();
    config.modules.packages = true;
    config.packageRepos = { api: { repo: REPO } };
    const [found] = packageFindings(config, 'acc1', [], new Map([['api', `No package-lock.json found in ${OLD_REPO}.`]]));
    expect(found.message).toContain(OLD_REPO);
    expect(plainFinding(found).message).toBe(PACKAGES_UNREADABLE);
  });

  it('leaves out evidence it does not know', async () => {
    const { e, session } = await install();
    const evidence = { usedToday: 5, deployedBy: 'Jan Novak', change: 'binding KV_CACHE was removed' };
    await e.DB.prepare('UPDATE findings SET evidence = ?1 WHERE id = ?2').bind(JSON.stringify(evidence), findingId('acc1', 'member')).run();
    const token = await mint(e, session, { accounts: ['acc1'] });
    const findings = (await (await asToken(e, token, '/api/findings')).json()) as { id: string; evidence: Record<string, unknown> }[];
    expect(findings.find((f) => f.id === findingId('acc1', 'member'))!.evidence).toEqual({ usedToday: 5, change: 'binding KV_CACHE was removed' });
  });

  it('has a decision for every evidence key the checks emit', () => {
    const { keys, unknown } = emittedEvidence();
    expect(keys).toContain('usedToday');
    expect(unknown, 'evidence built in a way this test cannot read: add it to DYNAMIC_EVIDENCE').toEqual([]);
    expect([...keys].filter((k) => !PLAIN_EVIDENCE.has(k) && !PERSON_EVIDENCE.has(k)), 'add to PLAIN_EVIDENCE or PERSON_EVIDENCE').toEqual([]);
    expect([...PLAIN_EVIDENCE].filter((k) => !keys.has(k) || PERSON_EVIDENCE.has(k)), 'no check emits these as plain evidence').toEqual([]);
  });

  it('is there for a token with the grant, and for the dashboard', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc2'], people: true });
    for (const read of [(p: string) => asToken(e, token, p), (p: string) => asSession(e, session, p)]) {
      const timeline = await (await read('/api/timeline?account=acc2')).text();
      for (const value of ['author@example.org', 'actor@example.org', 'novak-note', 'novak@alerts.example']) expect(timeline).toContain(value);
      const findings = await (await read('/api/findings?account=acc2')).text();
      for (const value of ['member-id-4711', 'changedBy', REPO]) expect(findings).toContain(value);
      expect(await (await read('/api/accounts')).text()).toContain("Jan Novak's Account");
    }
  });
});

describe('cached copies of a view', () => {
  const rows = async (e: Env) => (await e.DB.prepare('SELECT account, view FROM view_cache ORDER BY account, view').all<{ account: string; view: string }>()).results;
  const settle = () => Promise.allSettled(pending.splice(0));

  it('do not leak between grants, whichever is read first', async () => {
    const { e, session } = await install();
    const plain = await mint(e, session, { accounts: 'all' });
    const people = await mint(e, session, { accounts: 'all', people: true });
    for (const path of ['/api/overview?account=acc1', '/api/timeline?account=acc1', '/api/workers/api?account=acc1', '/api/packages?account=acc1', '/api/accounts']) {
      await asToken(e, people, path);
      await settle();
      await expectNoPeople(await asToken(e, plain, path), `${path} after a token with the grant`);
      await asSession(e, session, path);
      await settle();
      await expectNoPeople(await asToken(e, plain, path), `${path} after the dashboard`);
    }
    await e.DB.prepare('DELETE FROM view_cache').run();
    await asToken(e, plain, '/api/timeline?account=acc1');
    await settle();
    expect(await (await asToken(e, people, '/api/timeline?account=acc1')).text()).toContain('author@example.org');
    expect(await (await asSession(e, session, '/api/timeline?account=acc1')).text()).toContain('author@example.org');
  });

  it('stay a fixed few per account and view, however many tokens there are', async () => {
    const { e, session } = await install();
    const grants = [
      { accounts: 'all' }, { accounts: 'all', people: true },
      { accounts: ['acc1'] }, { accounts: ['acc1'], people: true }, { accounts: ['acc1', 'acc2'] }, { accounts: ['acc2', 'acc1'], people: true },
    ];
    for (const grant of grants) {
      const token = await mint(e, session, grant);
      for (const path of ['/api/overview?account=acc1', '/api/timeline?account=acc1', '/api/analytics?account=acc1', '/api/accounts']) await asToken(e, token, path);
    }
    await asSession(e, session, '/api/overview?account=acc1');
    await settle();
    const found = await rows(e);
    expect(found.filter((r) => r.view.startsWith('overview')).map((r) => r.view)).toEqual([
      'overview', 'overview-token', 'overview-token-limited', 'overview-token-limited-plain', 'overview-token-plain',
    ]);
    expect(found.filter((r) => r.view.endsWith('timeline-14')).map((r) => r.view)).toEqual(['plain-timeline-14', 'timeline-14']);
    expect(found.filter((r) => r.view.startsWith('analytics')).map((r) => r.view)).toEqual(['analytics-30d']);
    expect(found.filter((r) => r.view.startsWith('accounts')).map((r) => r.view)).toEqual(['accounts-token', 'accounts-token-plain']);
  });

  it('cannot be confused by a Worker whose name looks like a variant', async () => {
    const { e, session } = await install();
    await e.DB.batch([
      e.DB.prepare(`INSERT INTO workers (account, name, last_seen) VALUES ('acc1', 'api-plain', '2026-11-09T12:00:00Z')`),
      e.DB.prepare(`INSERT INTO workers (account, name, last_seen) VALUES ('acc1', 'plain-api', '2026-11-09T12:00:00Z')`),
    ]);
    const token = await mint(e, session, { accounts: ['acc1'] });
    for (const name of ['api-plain', 'plain-api']) await asSession(e, session, `/api/workers/${name}?account=acc1`);
    await settle();
    const read = (await (await asToken(e, token, '/api/workers/api?account=acc1')).json()) as { name: string };
    expect(read.name).toBe('api');
  });

  it('have different ETags, and one grant\'s ETag does not validate another\'s copy', async () => {
    const { e, session } = await install();
    const tokens = [
      await mint(e, session, { accounts: 'all' }), await mint(e, session, { accounts: 'all', people: true }),
      await mint(e, session, { accounts: ['acc1'] }), await mint(e, session, { accounts: ['acc1'], people: true }),
    ];
    for (const path of ['/api/overview?account=acc1', '/api/timeline?account=acc1', '/api/analytics?account=acc1', '/api/resources?account=acc1']) {
      const tags = await Promise.all(tokens.map(async (t) => (await asToken(e, t, path)).headers.get('ETag')!));
      expect(new Set(tags).size, path).toBe(tokens.length);
      for (const [i, token] of tokens.entries()) {
        expect((await asToken(e, token, path, { 'If-None-Match': tags[i] })).status, path).toBe(304);
        expect((await asToken(e, token, path, { 'If-None-Match': tags[(i + 1) % tags.length] })).status, path).toBe(200);
      }
    }
    // The account list differs per account grant, so its validator must too.
    const one = await mint(e, session, { accounts: ['acc1'] });
    const two = await mint(e, session, { accounts: ['acc2'] });
    const tag = (await asToken(e, one, '/api/accounts')).headers.get('ETag')!;
    expect((await asToken(e, two, '/api/accounts', { 'If-None-Match': tag })).status).toBe(200);
  });

  describe('for a token limited to some accounts', () => {
    const PATHS = ['/api/overview?account=acc1', '/api/timeline?account=acc1', '/api/analytics?account=acc1', '/api/resources?account=acc1', '/api/packages?account=acc1', '/api/accounts'];
    const tagOf = async (e: Env, token: string, path: string) => (await asToken(e, token, path)).headers.get('ETag')!;

    it('do not show the change counter, and stay the same when only another account changes', async () => {
      const { e, session } = await install();
      const token = await mint(e, session, { accounts: ['acc1'] });
      await e.DB.batch([bumpRevision(e.DB), bumpRevision(e.DB)]);
      for (const path of PATHS) {
        const tag = await tagOf(e, token, path);
        expect(tag, path).toMatch(/^W\/"[0-9a-f]{32}"$/);
        await settle();
        await e.DB.batch([e.DB.prepare(`UPDATE findings SET message = message || ' Again.' WHERE account = 'acc2'`), bumpRevision(e.DB)]);
        const res = await asToken(e, token, path, { 'If-None-Match': tag });
        expect(res.status, path).toBe(304);
        expect(res.headers.get('ETag'), path).toBe(tag);
        expect(await res.text(), path).toBe('');
      }
    });

    it('change when what the token reads changes', async () => {
      const { e, session } = await install();
      const token = await mint(e, session, { accounts: ['acc1'] });
      const path = '/api/overview?account=acc1';
      const tag = await tagOf(e, token, path);
      await settle();
      await e.DB.batch([e.DB.prepare('UPDATE findings SET message = ?1 WHERE id = ?2').bind('Changed.', findingId('acc1', 'pages')), bumpRevision(e.DB)]);
      const res = await asToken(e, token, path, { 'If-None-Match': tag });
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).not.toBe(tag);
      expect(await res.text()).toContain('Changed.');
    });

    it('leave a token for every account with the counter', async () => {
      const { e, session } = await install();
      const token = await mint(e, session, { accounts: 'all' });
      const path = '/api/overview?account=acc1';
      const tag = await tagOf(e, token, path);
      await bumpRevision(e.DB).run();
      expect(await tagOf(e, token, path)).not.toBe(tag);
    });
  });

  it('are sent only by the routes the API documents', async () => {
    const { e, session } = await install();
    const token = await mint(e, session, { accounts: ['acc1'] });
    for (const route of ['findings', `changes?since=${since()}`, 'self-cost', 'report?days=7']) {
      expect((await asToken(e, token, withAccount(route, 'acc1'))).headers.get('ETag'), route).toBeNull();
    }
    expect((await asToken(e, token, history('acc1'))).headers.get('ETag')).toBeNull();
    expect((await asToken(e, token, '/api/health')).headers.get('ETag')).toBeNull();
    expect((await asToken(e, token, '/api/workers/api?account=acc1')).headers.get('ETag')).not.toBeNull();
  });

  it('leave the dashboard as it was: no ETag and the full view', async () => {
    const { e, session } = await install();
    const res = await asSession(e, session, '/api/overview?account=acc2');
    expect(res.headers.get('ETag')).toBeNull();
    const body = (await res.json()) as { accountCount: number; account: { label: string } };
    expect(body.accountCount).toBe(2);
    expect(body.account.label).toBe("Jan Novak's Account");
  });
});

describe('tokens from before scopes', () => {
  const TOKEN = `amb_${'a'.repeat(43)}`;

  async function upgraded() {
    const db = createD1({ stopBefore: '0017' });
    await db.prepare(`INSERT INTO api_tokens (id, name, digest, hint, created_at, expires_at) VALUES ('old', 'Grafana', ?1, 'aaaa', '2026-01-01T00:00:00Z', ?2)`)
      .bind(createHash('sha256').update(TOKEN).digest('hex'), new Date(Date.now() + 86_400_000).toISOString()).run();
    (db as unknown as { migrateFrom: (f: string) => void }).migrateFrom('0017');
    return install(db);
  }

  it('keep every watched account and lose person-linked data', async () => {
    const { e } = await upgraded();
    expect(((await (await asToken(e, TOKEN, '/api/accounts')).json()) as { id: string }[]).map((a) => a.id)).toEqual(['acc1', 'acc2']);
    for (const account of ['acc1', 'acc2']) {
      for (const route of ACCOUNT_ROUTES()) await expectNoPeople(await asToken(e, TOKEN, withAccount(route, account)), `${route} ${account}`);
      expect(((await (await asToken(e, TOKEN, history(account))).json()) as unknown[]).length).toBe(1);
    }
  });

  it('are marked in the list Settings shows', async () => {
    const { e, session } = await upgraded();
    const list = (await (await asSession(e, session, '/api/tokens')).json()) as { name: string; accounts: unknown; people: boolean; olderScope: boolean }[];
    expect(list).toEqual([expect.objectContaining({ name: 'Grafana', accounts: 'all', people: false, olderScope: true })]);
  });
});

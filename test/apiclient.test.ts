// The browser's API client with a fake fetch: which refusals still say something about the session,
// and what may be sent once it has ended. App.svelte, which acts on these, is not exercised here.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const NOT_SIGNED_IN = { error: 'Not signed in.', code: 'not_signed_in' };

/** Every request waits here until the test answers it. */
let sent: { path: string; reply: (r: Response) => void }[];
const sentPaths = () => sent.map((s) => s.path);

/** The next request to `path` that has been sent and not answered. */
async function reply(path: string, res: Response) {
  await vi.waitFor(() => expect(sentPaths()).toContain(path));
  const i = sent.findIndex((s) => s.path === path);
  sent.splice(i, 1)[0].reply(res);
}

/** What is used here. Spelled out because the client needs DOM types, which this project's tsconfig lacks. */
interface Client {
  api: {
    login(passphrase: string): Promise<unknown>;
    logout(): Promise<unknown>;
    session(): Promise<unknown>;
    overview(account?: string): Promise<unknown>;
    findings(status: string): Promise<unknown>;
    acknowledge(id: string): Promise<unknown>;
  };
  ApiError: new (message: string, status: number) => Error;
  closeSession(): void;
  signInCount(): number;
  onSessionEnded(fn: () => void): void;
  onAccountRefused(fn: () => void): void;
}
const CLIENT = new URL('../web/src/lib/api.ts', import.meta.url).href;

/** The module keeps its counters: each test gets a new tab. */
async function newTab() {
  vi.resetModules();
  const client = (await import(/* @vite-ignore */ CLIENT)) as Client;
  const ended = vi.fn();
  const refused = vi.fn();
  client.onSessionEnded(ended);
  client.onAccountRefused(refused);
  async function signIn() {
    const done = client.api.login('passphrase');
    await reply('/api/login', answer({ ok: true }));
    await done;
  }
  return { ...client, ended, refused, signIn };
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', (path: string) => new Promise<Response>((resolve) => { sent.push({ path, reply: resolve }); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('a refusal and the sign-in it belongs to', () => {
  it('ends the session when the request was sent in the current one', async () => {
    const { api, ApiError, ended, signIn } = await newTab();
    await signIn();
    const read = api.overview();
    await reply('/api/overview', answer(NOT_SIGNED_IN, 401));
    const error = await read.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'not_signed_in' });
    expect(ended).toHaveBeenCalledOnce();
  });

  it.each([
    ['not signed in', NOT_SIGNED_IN],
    ['any other refusal', { error: 'Wrong.' }],
  ])('is ignored when the request was sent before the latest sign-in (%s)', async (_label, body) => {
    const { api, ended, signIn } = await newTab();
    const read = api.overview();
    await signIn();
    await reply('/api/overview', answer(body, 401));
    // Pages sign out on status 401, so this one must not carry it.
    await expect(read).rejects.toMatchObject({ status: 0 });
    expect(ended).not.toHaveBeenCalled();
  });

  it('is ignored when the answer is still being read as the sign-in lands', async () => {
    const { api, ended, signIn } = await newTab();
    const read = api.overview();
    let finishBody!: (text: string) => void;
    const slow = new Response(new ReadableStream({
      start(c) { finishBody = (text) => { c.enqueue(new TextEncoder().encode(text)); c.close(); }; },
    }), { status: 401 });
    await reply('/api/overview', slow);
    await signIn();
    finishBody(JSON.stringify(NOT_SIGNED_IN));
    await expect(read).rejects.toMatchObject({ status: 0 });
    expect(ended).not.toHaveBeenCalled();
  });

  it('a late refusal during sign-out leaves the sign-in count, which decides if its result counts', async () => {
    const { api, closeSession, ended, signIn, signInCount } = await newTab();
    await signIn();
    const late = api.overview();
    const before = signInCount();
    closeSession();
    const logout = api.logout();
    await reply('/api/overview', answer(NOT_SIGNED_IN, 401));
    await expect(late).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledOnce();
    await reply('/api/logout', answer({ ok: true }));
    await logout;
    expect(signInCount()).toBe(before);
  });

  it('a wrong passphrase is no sign-in, so it changes nothing', async () => {
    const { api, ended, signInCount } = await newTab();
    const attempt = api.login('wrong');
    await reply('/api/login', answer({ error: 'Wrong passphrase.' }, 401));
    await expect(attempt).rejects.toMatchObject({ status: 401 });
    expect(signInCount()).toBe(0);
    expect(ended).not.toHaveBeenCalled();
  });

  it('an unknown account resets the selection, unless the request is from before the sign-in', async () => {
    const { api, refused, signIn } = await newTab();
    const unknown = () => answer({ error: 'Not watched.', code: 'unknown_account' }, 404);
    const old = api.overview('a');
    await signIn();
    await reply('/api/overview?account=a', unknown());
    await expect(old).rejects.toMatchObject({ status: 404 });
    expect(refused).not.toHaveBeenCalled();
    const current = api.overview('a');
    await reply('/api/overview?account=a', unknown());
    await expect(current).rejects.toMatchObject({ status: 404 });
    expect(refused).toHaveBeenCalledOnce();
  });
});

describe('after the session has ended', () => {
  it('sends nothing that needs a session, so a late page action stores no new offline copy', async () => {
    const { api, closeSession, ended } = await newTab();
    closeSession();
    await expect(api.findings('open')).rejects.toMatchObject({ status: 0 });
    await expect(api.overview()).rejects.toMatchObject({ status: 0 });
    await expect(api.acknowledge('f')).rejects.toMatchObject({ status: 0 });
    expect(sent).toEqual([]);
    expect(ended).not.toHaveBeenCalled();
  });

  it('still sends the sign-out, the session check and the sign-in', async () => {
    const { api, closeSession } = await newTab();
    closeSession();
    void api.logout().catch(() => {});
    void api.session().catch(() => {});
    void api.login('passphrase').catch(() => {});
    expect(sentPaths()).toEqual(['/api/logout', '/api/session', '/api/login']);
    await reply('/api/logout', answer({ ok: true }));
    await reply('/api/session', answer({ authenticated: false }));
    await reply('/api/login', answer({ ok: true }));
  });

  it('a failed sign-in keeps it closed; a successful one opens it', async () => {
    const { api, closeSession, signIn } = await newTab();
    closeSession();
    const attempt = api.login('wrong');
    await reply('/api/login', answer({ error: 'Wrong passphrase.' }, 401));
    await expect(attempt).rejects.toMatchObject({ status: 401 });
    await expect(api.overview()).rejects.toMatchObject({ status: 0 });
    await signIn();
    const read = api.overview();
    await reply('/api/overview', answer({ workers: [] }));
    await expect(read).resolves.toEqual({ workers: [] });
  });
});

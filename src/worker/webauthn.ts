// Passkey (WebAuthn) verification on the server, with no dependency: what a registration or a
// sign-in must show before it counts. The browser's answer must be for this origin and relying
// party, for a challenge the caller accepts, made with the user present and verified (a PIN,
// fingerprint or face, not just a tap), and signed by the passkey's key. Attestation is not
// requested or checked ('none'): Ambersight does not limit which authenticators may be used, so a
// statement about the authenticator's make would change nothing. Signatures are checked with
// WebCrypto; this file only parses and compares.
// SPDX-License-Identifier: AGPL-3.0-only

export class WebAuthnError extends Error {}

const fail = (message: string): never => {
  throw new WebAuthnError(message);
};

// ---- base64url --------------------------------------------------------------------------------

export function b64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Null for anything that is not unpadded base64url, or longer than `max` characters. */
export function b64urlDecode(s: unknown, max = 65_536): Uint8Array | null {
  if (typeof s !== 'string' || s.length > max || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const sha256 = async (data: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- CBOR (RFC 8949), only what WebAuthn uses ------------------------------------------------

export type Cbor = number | Uint8Array | string | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

const MAX_DEPTH = 8;
const MAX_ITEMS = 512;

/**
 * Decodes one CBOR item from `data` at `start` and says where it ends. Definite lengths only, no
 * tags and no floats: WebAuthn's attestation objects and COSE keys need neither, and anything
 * unexpected is refused rather than guessed at.
 */
export function decodeCbor(data: Uint8Array, start = 0): { value: Cbor; end: number } {
  let pos = start;
  let items = 0;
  const need = (n: number) => {
    if (pos + n > data.length) fail('The passkey response is cut short.');
  };
  const uint = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : fail('The passkey response is malformed.');
    need(size);
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + data[pos + i];
    pos += size;
    if (!Number.isSafeInteger(n)) fail('The passkey response is malformed.');
    return n;
  };
  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH || ++items > MAX_ITEMS) fail('The passkey response is too complex.');
    need(1);
    const head = data[pos++];
    const major = head >> 5;
    const info = head & 31;
    if (info === 31) fail('The passkey response is malformed.');
    switch (major) {
      case 0: return uint(info);
      case 1: return -1 - uint(info);
      case 2: {
        const n = uint(info);
        need(n);
        pos += n;
        return data.slice(pos - n, pos);
      }
      case 3: {
        const n = uint(info);
        need(n);
        pos += n;
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data.subarray(pos - n, pos));
      }
      case 4: {
        const n = uint(info);
        if (n > data.length - pos) fail('The passkey response is malformed.');
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = uint(info);
        if (n * 2 > data.length - pos) fail('The passkey response is malformed.');
        const map = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const key = item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') fail('The passkey response is malformed.');
          if (map.has(key)) fail('The passkey response is malformed.');
          map.set(key, item(depth + 1));
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        return fail('The passkey response is malformed.');
      default:
        return fail('The passkey response is malformed.');
    }
  };
  const value = item(0);
  return { value, end: pos };
}

// ---- Authenticator data -----------------------------------------------------------------------

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: Map<Cbor, Cbor>;
}

export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) fail('The passkey response is cut short.');
  const flags = bytes[32];
  const signCount = ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36];
  const out: AuthData = { rpIdHash: bytes.slice(0, 32), flags, signCount };
  let pos = 37;
  if (flags & FLAG_AT) {
    if (bytes.length < pos + 18) fail('The passkey response is cut short.');
    pos += 16; // AAGUID: which make of authenticator. Not used, see above.
    const idLength = (bytes[pos] << 8) + bytes[pos + 1];
    pos += 2;
    if (idLength < 16 || idLength > 1023 || bytes.length < pos + idLength) fail('The passkey response has an invalid credential ID.');
    out.credentialId = bytes.slice(pos, pos + idLength);
    pos += idLength;
    const key = decodeCbor(bytes, pos);
    if (!(key.value instanceof Map)) fail('The passkey response has no public key.');
    out.publicKey = key.value as Map<Cbor, Cbor>;
    pos = key.end;
  }
  if (flags & FLAG_ED) pos = decodeCbor(bytes, pos).end;
  if (pos !== bytes.length) fail('The passkey response is malformed.');
  return out;
}

// ---- Keys -------------------------------------------------------------------------------------

export const ALG_ES256 = -7;
export const ALG_EDDSA = -8;
export const ALG_RS256 = -257;
/** Offered in this order: the shortest keys and signatures first. */
export const ALGORITHMS = [ALG_EDDSA, ALG_ES256, ALG_RS256] as const;
export type Alg = (typeof ALGORITHMS)[number];

export interface StoredKey {
  alg: Alg;
  jwk: JsonWebKey;
}

const bytesOf = (v: Cbor, length?: number): Uint8Array => {
  if (!(v instanceof Uint8Array) || (length !== undefined && v.length !== length)) fail('The passkey has an unsupported public key.');
  return v as Uint8Array;
};

/** The COSE public key from a registration, as a JWK WebCrypto can import. Only P-256, Ed25519 and RSA of 2048 bits or more. */
export function coseToJwk(key: Map<Cbor, Cbor>): StoredKey {
  const kty = key.get(1);
  const alg = key.get(3);
  if (kty === 2 && alg === ALG_ES256 && key.get(-1) === 1) {
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64urlEncode(bytesOf(key.get(-2), 32)), y: b64urlEncode(bytesOf(key.get(-3), 32)) } };
  }
  if (kty === 1 && alg === ALG_EDDSA && key.get(-1) === 6) {
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64urlEncode(bytesOf(key.get(-2), 32)) } };
  }
  if (kty === 3 && alg === ALG_RS256) {
    const n = bytesOf(key.get(-1));
    const e = bytesOf(key.get(-2));
    const bits = (n.length - (n[0] === 0 ? 1 : 0)) * 8;
    if (bits < 2048 || bits > 8192 || e.length > 8) fail('The passkey has an unsupported public key.');
    return { alg, jwk: { kty: 'RSA', n: b64urlEncode(n), e: b64urlEncode(e) } };
  }
  return fail('The passkey uses an algorithm Ambersight does not accept. It accepts Ed25519, ES256 (P-256) and RS256.');
}

async function importKey(k: StoredKey): Promise<{ key: CryptoKey; params: Parameters<SubtleCrypto['verify']>[0] }> {
  if (k.alg === ALG_ES256) {
    return { key: await crypto.subtle.importKey('jwk', k.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']), params: { name: 'ECDSA', hash: 'SHA-256' } };
  }
  if (k.alg === ALG_RS256) {
    return { key: await crypto.subtle.importKey('jwk', k.jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']), params: { name: 'RSASSA-PKCS1-v1_5' } };
  }
  try {
    return { key: await crypto.subtle.importKey('jwk', k.jwk, { name: 'Ed25519' }, false, ['verify']), params: { name: 'Ed25519' } };
  } catch {
    // Older Workers runtimes name it NODE-ED25519.
    const legacy = { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' };
    return { key: await crypto.subtle.importKey('jwk', k.jwk, legacy, false, ['verify']), params: legacy };
  }
}

/** ECDSA signatures arrive DER-encoded; WebCrypto wants r and s, 32 bytes each. Null for anything else. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const out = new Uint8Array(64);
  let pos = 2;
  for (let part = 0; part < 2; part++) {
    if (der[pos] !== 0x02) return null;
    const len = der[pos + 1];
    pos += 2;
    if (len < 1 || len > 33 || pos + len > der.length) return null;
    let int = der.subarray(pos, pos + len);
    pos += len;
    if (int[0] & 0x80) return null; // negative
    if (int.length > 1 && int[0] === 0 && !(int[1] & 0x80)) return null; // not minimal
    if (int[0] === 0 && int.length > 1) int = int.subarray(1);
    if (int.length > 32) return null;
    out.set(int, part * 32 + 32 - int.length);
  }
  return pos === der.length ? out : null;
}

async function verifySignature(k: StoredKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const sig = k.alg === ALG_ES256 ? derToRaw(signature) : signature;
  if (!sig) return false;
  try {
    const { key, params } = await importKey(k);
    return await crypto.subtle.verify(params, key, sig, data);
  } catch {
    return false;
  }
}

// ---- Ceremonies -------------------------------------------------------------------------------

/** Where the answer must come from: the page's origin, and its host as the relying party ID. */
export interface RelyingParty {
  id: string;
  origin: string;
}

export function relyingPartyOf(url: string): RelyingParty {
  const u = new URL(url);
  return { id: u.hostname, origin: u.origin };
}

type ClientData = { type: 'webauthn.create' | 'webauthn.get'; challenge: string; raw: Uint8Array };

/** Reads clientDataJSON far enough to say which challenge it answers, before any key is touched. */
export function readClientData(response: unknown): ClientData {
  const r = (response as { response?: { clientDataJSON?: unknown } } | null)?.response;
  const raw = b64urlDecode(r?.clientDataJSON, 4096) ?? fail('The passkey response is malformed.');
  let parsed: { type?: unknown; challenge?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return fail('The passkey response is malformed.');
  }
  if ((parsed.type !== 'webauthn.create' && parsed.type !== 'webauthn.get') || typeof parsed.challenge !== 'string') fail('The passkey response is malformed.');
  return { type: parsed.type as ClientData['type'], challenge: parsed.challenge as string, raw };
}

function checkClientData(raw: Uint8Array, type: ClientData['type'], rp: RelyingParty, challenge: string) {
  const c = JSON.parse(new TextDecoder().decode(raw)) as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  if (c.type !== type) fail('The passkey response is for a different step.');
  if (c.challenge !== challenge) fail('The passkey response is for a different request.');
  if (c.origin !== rp.origin) fail('The passkey response came from a different site.');
  // A response made inside a frame of another site does not count, even for this origin.
  if (c.crossOrigin === true) fail('The passkey response came from a different site.');
}

async function checkAuthData(a: AuthData, rp: RelyingParty) {
  if (!sameBytes(a.rpIdHash, await sha256(rp.id))) fail('The passkey belongs to a different site.');
  if (!(a.flags & FLAG_UP)) fail('The passkey did not confirm that someone was present.');
  if (!(a.flags & FLAG_UV)) fail('The passkey did not verify you (with a PIN, fingerprint or face). Ambersight requires that.');
}

export interface NewPasskey {
  id: string;
  key: StoredKey;
  signCount: number;
  backedUp: boolean;
  transports: string[];
}

/** Checks the answer to navigator.credentials.create(), in the shape of PublicKeyCredential.toJSON(). */
export async function verifyRegistration(response: unknown, rp: RelyingParty, challenge: string): Promise<NewPasskey> {
  const r = response as { id?: unknown; rawId?: unknown; type?: unknown; response?: { attestationObject?: unknown; transports?: unknown } } | null;
  if (r?.type !== 'public-key') fail('The passkey response is malformed.');
  const client = readClientData(response);
  checkClientData(client.raw, 'webauthn.create', rp, challenge);
  const att = b64urlDecode(r!.response?.attestationObject, 32_768) ?? fail('The passkey response is malformed.');
  const decoded = decodeCbor(att);
  if (decoded.end !== att.length || !(decoded.value instanceof Map)) fail('The passkey response is malformed.');
  const authBytes = (decoded.value as Map<Cbor, Cbor>).get('authData');
  if (!(authBytes instanceof Uint8Array)) fail('The passkey response is malformed.');
  const auth = parseAuthData(authBytes as Uint8Array);
  await checkAuthData(auth, rp);
  if (!auth.credentialId || !auth.publicKey) fail('The passkey response has no credential.');
  const id = b64urlEncode(auth.credentialId!);
  if (r!.rawId !== id || r!.id !== id) fail('The passkey response is malformed.');
  const key = coseToJwk(auth.publicKey!);
  // Refuses a key WebCrypto cannot use now, rather than at the first sign-in.
  await importKey(key).catch(() => fail('The passkey has an unsupported public key.'));
  const transports = Array.isArray(r!.response?.transports)
    ? (r!.response!.transports as unknown[]).filter((t): t is string => typeof t === 'string' && /^[a-z-]{1,16}$/.test(t)).slice(0, 8)
    : [];
  return { id, key, signCount: auth.signCount, backedUp: Boolean(auth.flags & FLAG_BS), transports };
}

export interface Assertion {
  /** The credential ID the browser says it used. Look the key up by it, then call verifyAssertion. */
  id: string;
  userHandle: string | null;
}

/** The parts of a navigator.credentials.get() answer needed to find its passkey. */
export function readAssertion(response: unknown): Assertion {
  const r = response as { id?: unknown; rawId?: unknown; type?: unknown; response?: { userHandle?: unknown } } | null;
  if (r?.type !== 'public-key' || typeof r.id !== 'string' || r.rawId !== r.id || !b64urlDecode(r.id, 1400)) fail('The passkey response is malformed.');
  const handle = r!.response?.userHandle;
  return { id: r!.id as string, userHandle: typeof handle === 'string' && handle ? handle : null };
}

/**
 * Checks the answer to navigator.credentials.get() against the stored key. Returns the new
 * signature counter and backup state. A counter that does not grow, on an authenticator that keeps
 * one, means the key was copied, and the answer is refused.
 */
export async function verifyAssertion(
  response: unknown, rp: RelyingParty, challenge: string, stored: { key: StoredKey; signCount: number },
): Promise<{ signCount: number; backedUp: boolean }> {
  const r = response as { response?: { authenticatorData?: unknown; signature?: unknown } } | null;
  const client = readClientData(response);
  checkClientData(client.raw, 'webauthn.get', rp, challenge);
  const authBytes = b64urlDecode(r?.response?.authenticatorData, 4096) ?? fail('The passkey response is malformed.');
  const signature = b64urlDecode(r?.response?.signature, 2048) ?? fail('The passkey response is malformed.');
  const auth = parseAuthData(authBytes);
  await checkAuthData(auth, rp);
  if (auth.credentialId) fail('The passkey response is malformed.');
  const signed = new Uint8Array(authBytes.length + 32);
  signed.set(authBytes);
  signed.set(await sha256(client.raw), authBytes.length);
  if (!(await verifySignature(stored.key, signature, signed))) fail('The passkey signature does not match.');
  if ((auth.signCount > 0 || stored.signCount > 0) && auth.signCount <= stored.signCount) {
    fail('This passkey\'s counter went backwards, which happens when a key was copied. Remove it in Settings › Security and add it again.');
  }
  return { signCount: auth.signCount, backedUp: Boolean(auth.flags & FLAG_BS) };
}

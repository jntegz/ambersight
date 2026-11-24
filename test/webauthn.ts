// A software passkey for tests: makes real registration and sign-in answers, with real keys and
// signatures, in the JSON shape browsers send (PublicKeyCredential.toJSON()). Each knob turns off
// one thing a real authenticator does, so a test can show the server refuses its absence.
/// <reference types="node" />
// SPDX-License-Identifier: AGPL-3.0-only
import { timingSafeEqual } from 'node:crypto';
import { b64urlDecode, b64urlEncode } from '../src/worker/webauthn';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean };
const view = (x: ArrayBuffer | ArrayBufferView) => (ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x));
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(view(a), view(b));

// ---- A CBOR encoder, enough for attestation objects and COSE keys.
type Enc = number | string | Uint8Array | Enc[] | Map<Enc, Enc>;
const head = (major: number, n: number): number[] => {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65_536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export function cbor(v: Enc): Uint8Array {
  const out: number[] = [];
  const put = (x: Enc) => {
    if (typeof x === 'number') out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(put);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        put(k);
        put(val);
      }
    }
  };
  put(v);
  return Uint8Array.from(out);
}

const sha256 = async (d: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? new TextEncoder().encode(d) : d));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** r||s (64 bytes) to DER, as authenticators send ECDSA signatures. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0] & 0x80 ? concat(Uint8Array.of(0x02, v.length + 1, 0), v) : concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export type TestAlg = -7 | -8 | -257;

export interface Knobs {
  origin?: string;
  rpId?: string;
  type?: string;
  challenge?: string;
  crossOrigin?: boolean;
  userPresent?: boolean;
  userVerified?: boolean;
  backedUp?: boolean;
  /** Corrupts the signature. */
  badSignature?: boolean;
  /** The counter to report on this answer. */
  counter?: number;
  userHandle?: string | null;
}

interface CreationOptions { challenge: string; rp: { id: string }; user: { id: string }; pubKeyCredParams: { alg: number }[] }
interface RequestOptions { challenge: string; rpId: string }

export class SoftPasskey {
  readonly id: string;
  private keys!: CryptoKeyPair;
  private userId = '';
  counter: number;

  private constructor(readonly alg: TestAlg, readonly origin: string, counter: number) {
    this.id = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    this.counter = counter;
  }

  /** `counter` 0 makes a passkey that keeps no counter, like synced passkeys; anything else counts up from it. */
  static async make(origin: string, alg: TestAlg = -7, counter = 0): Promise<SoftPasskey> {
    const p = new SoftPasskey(alg, origin, counter);
    const params =
      alg === -7 ? { name: 'ECDSA', namedCurve: 'P-256' }
      : alg === -8 ? { name: 'Ed25519' }
      : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' };
    p.keys = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
    return p;
  }

  private async cose(): Promise<Uint8Array> {
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey;
    const b = (s?: string) => b64urlDecode(s)!;
    if (this.alg === -7) return cbor(new Map<Enc, Enc>([[1, 2], [3, -7], [-1, 1], [-2, b(jwk.x)], [-3, b(jwk.y)]]));
    if (this.alg === -8) return cbor(new Map<Enc, Enc>([[1, 1], [3, -8], [-1, 6], [-2, b(jwk.x)]]));
    return cbor(new Map<Enc, Enc>([[1, 3], [3, -257], [-1, b(jwk.n)], [-2, b(jwk.e)]]));
  }

  private async authData(rpId: string, k: Knobs, attested?: Uint8Array): Promise<Uint8Array> {
    const flags = (k.userPresent === false ? 0 : 0x01) | (k.userVerified === false ? 0 : 0x04) | (k.backedUp ? 0x18 : 0) | (attested ? 0x40 : 0);
    const c = k.counter ?? this.counter;
    return concat(await sha256(k.rpId ?? rpId), Uint8Array.of(flags, (c >>> 24) & 255, (c >> 16) & 255, (c >> 8) & 255, c & 255), attested ?? new Uint8Array());
  }

  private clientData(type: string, challenge: string, k: Knobs): string {
    return b64urlEncode(new TextEncoder().encode(JSON.stringify({
      type: k.type ?? type, challenge: k.challenge ?? challenge, origin: k.origin ?? this.origin, crossOrigin: k.crossOrigin ?? false,
    })));
  }

  /** Answers navigator.credentials.create() options from the server. */
  async create(options: CreationOptions, k: Knobs = {}) {
    this.userId = options.user.id;
    const credId = b64urlDecode(this.id)!;
    const attested = concat(new Uint8Array(16), Uint8Array.of(credId.length >> 8, credId.length & 255), credId, await this.cose());
    const authData = await this.authData(options.rp.id, k, attested);
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData('webauthn.create', options.challenge, k),
        attestationObject: b64urlEncode(cbor(new Map<Enc, Enc>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
        transports: ['internal', 'hybrid'],
      },
    };
  }

  /** Answers navigator.credentials.get() options from the server. Counts up first, if it keeps a counter. */
  async get(options: RequestOptions, k: Knobs = {}) {
    if (this.counter > 0 && k.counter === undefined) this.counter++;
    const authData = await this.authData(options.rpId, k);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, k);
    const signed = concat(authData, await sha256(b64urlDecode(clientDataJSON)!));
    const algo = this.alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : this.alg === -8 ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5' };
    let sig = new Uint8Array(await crypto.subtle.sign(algo, this.keys.privateKey, signed));
    if (this.alg === -7) sig = new Uint8Array(rawToDer(sig));
    if (k.badSignature) sig[sig.length - 1] ^= 1;
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON,
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(sig),
        userHandle: k.userHandle === undefined ? this.userId : k.userHandle,
      },
    };
  }
}

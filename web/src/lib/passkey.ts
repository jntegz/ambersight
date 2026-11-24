// The browser half of passkeys: turns the server's JSON options into what navigator.credentials
// takes, and the credential it returns into JSON for the server (the shape of
// PublicKeyCredential.toJSON(), written out because not every supported browser has it).
// SPDX-License-Identifier: AGPL-3.0-only

const toBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const toB64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Descriptor = { type: 'public-key'; id: string; transports?: string[] };
export interface CreationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: Descriptor[];
}
export interface RequestOptionsJSON {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: UserVerificationRequirement;
  allowCredentials: Descriptor[];
}

const descriptor = (d: Descriptor): PublicKeyCredentialDescriptor => ({ type: d.type, id: toBytes(d.id), ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}) });

/** Whether this browser can use passkeys at all. */
export const passkeysSupported = () => typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;

/** What a person sees when the browser's passkey prompt fails, in words that say what to do. */
function explain(e: unknown): Error {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError') return new Error('The passkey prompt was closed or timed out. Try again.');
  if (name === 'InvalidStateError') return new Error('This passkey is already registered here.');
  if (name === 'SecurityError') return new Error('Passkeys do not work on this address. Open the dashboard on its own https address.');
  if (name === 'NotSupportedError') return new Error('This device has no passkey that Ambersight accepts.');
  return e instanceof Error ? e : new Error('The passkey did not work. Try again.');
}

export async function createPasskey(o: CreationOptionsJSON): Promise<unknown> {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        ...o,
        challenge: toBytes(o.challenge),
        user: { ...o.user, id: toBytes(o.user.id) },
        excludeCredentials: o.excludeCredentials.map(descriptor),
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw explain(e);
  }
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id, rawId: toB64url(cred.rawId), type: cred.type,
    response: { clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject), transports: r.getTransports?.() ?? [] },
  };
}

export async function usePasskey(o: RequestOptionsJSON): Promise<unknown> {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: { ...o, challenge: toBytes(o.challenge), allowCredentials: o.allowCredentials.map(descriptor) },
    })) as PublicKeyCredential;
  } catch (e) {
    throw explain(e);
  }
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id, rawId: toB64url(cred.rawId), type: cred.type,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle ? toB64url(r.userHandle) : null,
    },
  };
}

/** A name to suggest for a new passkey, from the platform the browser reports. */
export function suggestedName(): string {
  const p = ((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (p.includes('mac')) return 'Mac';
  if (p.includes('win')) return 'Windows';
  if (p.includes('iphone') || p.includes('ipad') || /iphone|ipad/i.test(navigator.userAgent)) return 'iPhone';
  if (p.includes('android') || /android/i.test(navigator.userAgent)) return 'Android';
  if (p.includes('linux')) return 'Linux';
  return 'Passkey';
}

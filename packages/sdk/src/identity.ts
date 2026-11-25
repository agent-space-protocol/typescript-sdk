/**
 * Identity: Ed25519 keys, proofs of identity in `join`, and passes through doors.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** An Ed25519 key pair. `identity` is the public key written as `ed25519:<base64url>`. */
export interface KeyPair {
  identity: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Makes a new key pair. */
export function generateKey(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, identity: identityOf(publicKey) };
}

/** The identity of a public key. */
export function identityOf(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  return `ed25519:${jwk.x}`;
}

/** The public key of an identity, or undefined when it is not an Ed25519 identity. */
export function publicKeyOf(identity: string): KeyObject | undefined {
  const m = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(identity);
  if (!m) return undefined;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: m[1] }, format: "jwk" });
  } catch {
    return undefined;
  }
}

/** Loads a key pair from a PKCS#8 PEM file, making one first when the file does not exist. */
export function loadOrCreateKey(path: string): KeyPair {
  if (!existsSync(path)) {
    const key = generateKey();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, key.privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
    return key;
  }
  const privateKey = createPrivateKey(readFileSync(path, "utf8"));
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, identity: identityOf(publicKey) };
}

/** Signs bytes, returning the unpadded base64url signature. */
export function signBytes(key: KeyPair, data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return sign(null, bytes, key.privateKey).toString("base64url");
}

/** Checks a base64url signature by an identity. */
export function verifyBytes(identity: string, data: Uint8Array | string, signature: string): boolean {
  const pk = publicKeyOf(identity);
  if (!pk) return false;
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  try {
    return verify(null, bytes, pk, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** The text a participant signs in `join`. */
export function proofText(space: string, nonce: string): string {
  return `asp-v0 join ${space} ${nonce}`;
}

/** The proof of identity for `join`. */
export function makeProof(key: KeyPair, space: string, nonce: string): string {
  return signBytes(key, proofText(space, nonce));
}

/** Checks a proof of identity. */
export function checkProof(identity: string, space: string, nonce: string, proof: string): boolean {
  return verifyBytes(identity, proofText(space, nonce), proof);
}

/** What a pass through a door says. */
export interface PassPayload {
  participant: string;
  from: string;
  to: string;
  door: string;
  expires: string;
}

/** Makes a pass, signed by the space's key: `<payload>.<signature>`, both base64url. */
export function makePass(spaceKey: KeyPair, payload: PassPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return `${body.toString("base64url")}.${signBytes(spaceKey, body)}`;
}

/** Reads and checks a pass. Returns its payload when the signature is by `issuer` and it has not expired. */
export function readPass(pass: string, issuer: string): PassPayload | undefined {
  const [body, signature] = pass.split(".");
  if (!body || !signature) return undefined;
  const bytes = Buffer.from(body, "base64url");
  if (!verifyBytes(issuer, bytes, signature)) return undefined;
  try {
    const payload = JSON.parse(bytes.toString("utf8")) as PassPayload;
    if (Date.parse(payload.expires) < Date.now()) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

/** Reads a pass without checking it, to find out who issued it. */
export function peekPass(pass: string): PassPayload | undefined {
  try {
    return JSON.parse(Buffer.from(pass.split(".")[0], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

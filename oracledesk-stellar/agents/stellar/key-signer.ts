/**
 * Pluggable `AgentSigner` abstraction, AES-256-GCM scrypt encrypted keystore,
 * and remote HTTP/mTLS signer provider with secret redaction (#106).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";

const STELLAR_SECRET_REGEX = /\bS[A-Z2-7]{55}\b/g;

/** Scrubs any Stellar `S...` secret seed from log messages or stack traces. */
export function redactStellarSecrets(input: string): string {
  return input.replace(STELLAR_SECRET_REGEX, "S[REDACTED_STELLAR_SECRET]");
}

export interface AgentSigner {
  readonly providerName: string;
  publicKey(): Promise<string>;
  signBytes(payload: Buffer): Promise<Buffer>;
}

/** Development/CI env signer backed by an in-memory `Keypair`. */
export class EnvKeypairSigner implements AgentSigner {
  readonly providerName = "env";
  private readonly kp: Keypair;

  constructor(secretSeed: string) {
    this.kp = Keypair.fromSecret(secretSeed);
  }

  async publicKey(): Promise<string> {
    return this.kp.publicKey();
  }

  async signBytes(payload: Buffer): Promise<Buffer> {
    return Buffer.from(this.kp.sign(payload));
  }

  toJSON(): Record<string, string> {
    return { provider: this.providerName, publicKey: this.kp.publicKey() };
  }
}

export interface EncryptedKeystoreV1 {
  version: 1;
  publicKey: string;
  kdf: "scrypt";
  kdfParams: {
    N: number;
    r: number;
    p: number;
    saltHex: string;
  };
  cipher: "aes-256-gcm";
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
}

export function encryptSecretToKeystore(
  secretSeed: string,
  passphrase: string,
  scryptCostN = 16384,
): EncryptedKeystoreV1 {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("keystore passphrase must be at least 8 characters");
  }
  const kp = Keypair.fromSecret(secretSeed);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: scryptCostN, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretSeed, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  key.fill(0);

  return {
    version: 1,
    publicKey: kp.publicKey(),
    kdf: "scrypt",
    kdfParams: {
      N: scryptCostN,
      r: 8,
      p: 1,
      saltHex: salt.toString("hex"),
    },
    cipher: "aes-256-gcm",
    ivHex: iv.toString("hex"),
    authTagHex: authTag.toString("hex"),
    ciphertextHex: ciphertext.toString("hex"),
  };
}

export function decryptKeystoreSecret(keystore: EncryptedKeystoreV1, passphrase: string): string {
  const salt = Buffer.from(keystore.kdfParams.saltHex, "hex");
  const iv = Buffer.from(keystore.ivHex, "hex");
  const authTag = Buffer.from(keystore.authTagHex, "hex");
  const ciphertext = Buffer.from(keystore.ciphertextHex, "hex");

  const key = scryptSync(passphrase, salt, 32, {
    N: keystore.kdfParams.N,
    r: keystore.kdfParams.r,
    p: keystore.kdfParams.p,
  });

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return plain;
  } finally {
    key.fill(0);
  }
}

export class EncryptedFileKeystoreSigner implements AgentSigner {
  readonly providerName = "file-keystore";
  private readonly inner: EnvKeypairSigner;

  constructor(keystorePath: string, passphrase: string) {
    const parsed = JSON.parse(readFileSync(keystorePath, "utf8")) as EncryptedKeystoreV1;
    const secret = decryptKeystoreSecret(parsed, passphrase);
    this.inner = new EnvKeypairSigner(secret);
  }

  static writeKeystoreFile(
    filePath: string,
    secretSeed: string,
    passphrase: string,
  ): EncryptedKeystoreV1 {
    const ks = encryptSecretToKeystore(secretSeed, passphrase);
    writeFileSync(filePath, JSON.stringify(ks, null, 2), { mode: 0o600 });
    return ks;
  }

  publicKey(): Promise<string> {
    return this.inner.publicKey();
  }

  signBytes(payload: Buffer): Promise<Buffer> {
    return this.inner.signBytes(payload);
  }
}

export class RemoteHttpSigner implements AgentSigner {
  readonly providerName = "remote-http";

  constructor(
    private readonly endpointUrl: string,
    private readonly configuredPublicKey: string,
    private readonly bearerToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async publicKey(): Promise<string> {
    return this.configuredPublicKey;
  }

  async signBytes(payload: Buffer): Promise<Buffer> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.bearerToken) {
      headers.authorization = `Bearer ${this.bearerToken}`;
    }
    const resp = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        publicKey: this.configuredPublicKey,
        payloadHex: payload.toString("hex"),
      }),
    });
    if (!resp.ok) {
      throw new Error(`remote signer returned HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as { signatureHex: string };
    return Buffer.from(body.signatureHex, "hex");
  }
}

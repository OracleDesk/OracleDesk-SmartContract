import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

export interface PassClaims {
  v: 1;
  sub: string;
  scope: `market:${string}` | `agent:${string}`;
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}

export interface SigningKey {
  kid: string;
  secret: string;
  exp?: number;
}

export class PassIssuer {
  private keys: Map<string, SigningKey>;
  private activeKid: string;

  constructor(keysList: SigningKey[]) {
    this.keys = new Map(keysList.map((k) => [k.kid, k]));
    const active = keysList.find((k) => !k.exp || k.exp > Date.now());
    if (!active) throw new Error("No active signing key");
    this.activeKid = active.kid;
  }

  issue(claims: Omit<PassClaims, "v" | "iat" | "jti" | "kid">): string {
    const key = this.keys.get(this.activeKid);
    if (!key) throw new Error("Active key not found");

    const fullClaims: PassClaims = {
      v: 1,
      ...claims,
      iat: Math.floor(Date.now() / 1000),
      jti: randomBytes(16).toString("hex"),
      kid: this.activeKid,
    };

    const header = { alg: "EdDSA", typ: "JWT", kid: this.activeKid };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const claimsB64 = Buffer.from(JSON.stringify(fullClaims)).toString("base64url");
    const message = `${headerB64}.${claimsB64}`;

    const keypair = Keypair.fromSecret(key.secret);
    const sig = keypair.sign(Buffer.from(message));
    const sigB64 = Buffer.from(sig).toString("base64url");

    return `${message}.${sigB64}`;
  }
}

export type PassError = Error & { code: string };

export class PassVerifier {
  private keys: Map<string, SigningKey>;

  constructor(keysList: SigningKey[]) {
    this.keys = new Map(keysList.map((k) => [k.kid, k]));
  }

  verify(token: string, now: number = Date.now()): PassClaims | PassError {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        const err = new Error("Invalid token format") as PassError;
        err.code = "INVALID_FORMAT";
        return err;
      }

      const [headerB64, claimsB64, sigB64] = parts;
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
      const claims: PassClaims = JSON.parse(Buffer.from(claimsB64, "base64url").toString());
      const sig = Buffer.from(sigB64, "base64url");

      if (header.alg !== "EdDSA") {
        const err = new Error("Unsupported algorithm") as PassError;
        err.code = "BAD_ALG";
        return err;
      }

      const kid = header.kid || claims.kid;
      const key = this.keys.get(kid);
      if (!key) {
        const err = new Error("Key not found") as PassError;
        err.code = "UNKNOWN_KEY";
        return err;
      }

      const message = `${headerB64}.${claimsB64}`;
      const keypair = Keypair.fromPublicKey(Keypair.fromSecret(key.secret).publicKey());
      const valid = keypair.verify(Buffer.from(message), sig);
      if (!valid) {
        const err = new Error("Invalid signature") as PassError;
        err.code = "BAD_SIGNATURE";
        return err;
      }

      if (claims.exp * 1000 < now) {
        const err = new Error("Token expired") as PassError;
        err.code = "EXPIRED";
        return err;
      }

      if (claims.v !== 1) {
        const err = new Error("Unsupported token version") as PassError;
        err.code = "BAD_VERSION";
        return err;
      }

      return claims;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      (error as PassError).code = "PARSE_ERROR";
      return error as PassError;
    }
  }
}

export function bundlePrice(count: number, unitPrice: string, cap: string): string {
  const unit = parseFloat(unitPrice);
  const capVal = parseFloat(cap);
  const price = Math.min(count * unit, capVal);
  return price.toFixed(7);
}

export interface BundleChallenge {
  upTo: number;
  price: string;
  marketId: string;
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { redact } from "../../core/redact.js";
import { validateTransaction } from "./policy.js";
import type { AuditEvent, AuditLog, SignerPolicy, StellarSigner } from "./types.js";

const MAX_BODY_BYTES = 1_000_000;

export class MemoryAuditLog implements AuditLog {
  private readonly records: AuditEvent[] = [];

  append(event: AuditEvent): void {
    this.records.push(redact(event));
  }

  entries(): readonly AuditEvent[] {
    return this.records.map((event) => ({ ...event }));
  }
}

export interface PolicyServerOptions {
  signer: StellarSigner;
  policy: SignerPolicy;
  auditLog?: AuditLog;
}

export interface ReferencePolicyServer {
  server: Server;
  auditLog: AuditLog;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds limit");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(redact(body)));
}

export function createReferencePolicyServer({
  signer,
  policy,
  auditLog = new MemoryAuditLog(),
}: PolicyServerOptions): ReferencePolicyServer {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/sign") {
      send(response, 404, { error: "not found" });
      return;
    }

    let txHash: string | undefined;
    try {
      const body = await readJson(request);
      if (
        typeof body.xdr !== "string" ||
        typeof body.networkPassphrase !== "string" ||
        typeof body.address !== "string" ||
        body.submit !== undefined ||
        body.submitUrl !== undefined
      ) {
        throw new Error("request must include xdr, networkPassphrase, and address only");
      }
      const approved = validateTransaction(body.xdr, body.networkPassphrase, policy);
      txHash = approved.transactionHash;
      const signed = await signer.signTransaction(body.xdr, {
        networkPassphrase: body.networkPassphrase,
        address: body.address,
      });
      if (signed.error) throw new Error(signed.error.message);
      auditLog.append({
        timestamp: new Date().toISOString(),
        action: "allow",
        signerAddress: signed.signerAddress ?? signer.address,
        transactionHash: txHash,
      });
      send(response, 200, signed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "signing request rejected";
      auditLog.append({
        timestamp: new Date().toISOString(),
        action: "deny",
        signerAddress: signer.address,
        transactionHash: txHash,
        reason,
      });
      send(response, 403, { error: reason });
    }
  });
  return { server, auditLog };
}

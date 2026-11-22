# OracleDesk Protocol Specification — reasoning-registry Contract

This document specifies the reasoning-registry contract, which stores and verifies reasoning traces (the agent's trading rationale).

## Instance Storage

| Key | Type | Notes |
|-----|------|-------|
| `I[Admin]` | `Address` | Admin address (can register reasoners). |

---

## Persistent Storage

| Key | Type | Notes |
|-----|------|-------|
| `P[Reasoner(id)]` | `Address` | Registered reasoner address at index `id`. |
| `P[ReasonerCount]` | `u64` | Total registered reasoners. |
| `P[TraceEntry(trace_id)]` | `TraceEntry` | Stored trace metadata and hash. |
| `P[TraceData(trace_id)]` | `Bytes` | Trace content (small traces; large ones stored externally). |

**TraceEntry struct:**

```rust
pub struct TraceEntry {
    pub reasoner_id: u64,         // Which reasoner published this
    pub trace_hash: BytesN<32>,   // sha256(content)
    pub content_hash: BytesN<32>, // For external storage verification
    pub published_at: u64,        // Ledger timestamp
}
```

---

## Entrypoints

### `register_reasoner`

Admin: registers a new reasoner (agent) address.

**AUTH-1** `auth(admin)`.

**PRE-1** `reasoner` is a valid address.
**PRE-2** `reasoner` not already registered (or update is allowed; design choice).

**POST-1** New reasoner ID assigned: `id = P[ReasonerCount] + 1`.
**POST-2** `P[Reasoner(id)]` = `reasoner`.
**POST-3** `P[ReasonerCount]` incremented.

**EVT-1** `ReasonerRegistered { reasoner, reasoner_id: id }`.

**ERR-1** `Unauthorized(1)` if not admin.

---

### `publish_trace`

Reasoner publishes a trace (the trading rationale behind a market action).

**AUTH-1** `auth(reasoner)`.

**PRE-1** `reasoner` is registered (lookup `P[Reasoner(*)]` for matching address).
**PRE-2** `content` is non-empty.
**PRE-3** Trace ID is new (not already published).

**POST-1** `trace_hash = sha256(content)`.
**POST-2** `P[TraceEntry(trace_id)]` = `{reasoner_id, trace_hash, content_hash, published_at: now}`.
**POST-3** If `content.len()` <= threshold, `P[TraceData(trace_id)]` = `content`; else external storage reference.
**POST-4** Entry TTL-bumped.

**EVT-1** `TracePublished { reasoner_id, trace_id, trace_hash }`.

**ERR-1** `ReasonerNotFound(2)` if reasoner not registered.
**ERR-2** `InvalidTrace(3)` if content empty.
**ERR-3** `TraceAlreadyPublished(4)` if trace_id already exists.

---

### `verify_trace`

Permissionless: verifies a trace hash against stored content (used by x402 and contracts).

**AUTH-1** None (permissionless).

**PRE-1** `P[TraceEntry(trace_id)]` exists else `TraceNotFound(5)`.

**POST-1** Recomputes `sha256(content)` from stored or external data.
**POST-2** Compares computed hash with `P[TraceEntry(trace_id)].trace_hash`.
**POST-3** Returns `true` if match, `false` otherwise (or errors if content fetch fails).

**EVT-1** None.

**ERR-1** `TraceNotFound(5)` if trace doesn't exist.
**ERR-2** `VerificationFailed(6)` if hash mismatch.

---

### `get_trace`

View: retrieves trace metadata and content (if stored on-chain).

**AUTH-1** None.

**PRE-1** No preconditions.

**POST-1** Returns `TraceEntry` and content (if available), or `None`.

---

## Error Codes (Reasoning Registry)

| Code | Name | Trigger |
|------|------|---------|
| 1 | `Unauthorized` | Caller is not admin (for register_reasoner). |
| 2 | `ReasonerNotFound` | Reasoner not registered. |
| 3 | `InvalidTrace` | Trace content empty or malformed. |
| 4 | `TraceAlreadyPublished` | Trace ID already exists. |
| 5 | `TraceNotFound` | Trace ID does not exist. |
| 6 | `VerificationFailed` | Stored hash doesn't match provided content. |

---

## Invariants

- Traces are immutable once published (no update/delete entrypoint).
- Trace IDs are globally unique and never reused.
- Reasoner IDs are assigned sequentially and never change.

## See Also

- `contracts/reasoning-registry/src/lib.rs` — implementation.
- `x402/trace-api.ts` — x402 payment protocol usage.
- `docs/spec/system.md` — trace publishing workflow (Sequence 2).

# Localization-ready error messages in bindings

## Context

Every contract's `Error` enum (e.g. `contracts/market-core/src/lib.rs`'s
`Error::InvalidCloseTime`, `Error::SlippageExceeded`, etc.) surfaces to a
TypeScript caller as a bare error code/variant name via the generated
bindings (`packages/bindings/*/src/index.ts`). A frontend showing a raw
`Error(Contract, #12)` or `SlippageExceeded` to an end user is not
user-friendly, and there's currently no single place mapping each error
variant, per contract, to a human-readable (and localizable) message.

## What to change

Add a small mapping package (e.g. `packages/error-messages/`) with, per
contract, a `Record<ErrorVariantName, string>` of default (English)
messages, structured so a consumer can swap in translations (e.g. a
`Record<Locale, Record<ErrorVariantName, string>>` or an i18next-compatible
resource shape — implementer's call, document the choice). Wire it as an
optional helper `packages/bindings/*` consumers can use to translate a
thrown contract error into a display string.

## Files to touch

- New `packages/error-messages/` (or wherever decided)
- `docs/frontend-integration.md` (document how to use it)

## Acceptance criteria

- Every `Error` variant across all four contracts has a mapped default
  message (English at minimum).
- Adding a message for a new locale doesn't require touching the generated
  bindings.
- If a contract's `Error` enum changes (variant added/removed), there's a
  test or script that catches a mapping falling out of sync (e.g. a test
  that imports the generated `Error` union type and asserts every variant
  has a mapping).

## How to test

```bash
cd packages/error-messages && npm test
```

## Complexity

`complexity/small`

# Agent safety and readiness limits

The trader task now requires an injected due-diligence verifier and rejects
trades when one is not configured. The market-maker similarly requires an
injected proposal verifier before seeding treasury capital. Both defaults
are intentionally fail-closed: the current agent interfaces do not provide
enough verified information to approve an arbitrary market.

The remaining integration blockers are concrete:

- The generated market-core client can read `Market`, but the resolver client
  exposes no view for the committed price/signers specification. Its public
  `state` view is not the specification itself. A caller cannot verify the
  commitment or determine all resolution paths from that state alone.
- The resolver's Reflector client reads one price at the market close time.
  There is no agent-side historical-price source or documented sampling
  cadence from which to build and validate a volatility series.
- The maker currently stores metadata using `local://` in its runtime task;
  no metadata retrieval/validation interface is wired into the trader.
- No maintained oracle allowlist or signer-set trust policy is configured.
  A contract address or a committed signer list is not evidence of trust.
- The adapter's current `dry-run` path returns a description without RPC
  simulation. The locally available checkout has no installed SDK declaration
  files to establish a safe `simulate()` result type; dependency installation
  and runtime validation were explicitly out of scope.

Consequently, this change does not claim that market due diligence, RPC-backed
simulation, observability/audit export, historical fair-value estimation, or
market-maker integration is complete. A production verifier must be wired to
fresh chain reads, metadata retrieval, resolver configuration, and explicit
trust configuration before trader submissions can be enabled.

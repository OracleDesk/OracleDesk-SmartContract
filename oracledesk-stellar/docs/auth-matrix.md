# Cross-contract authorization matrix

Generated from `tests/auth_matrix/rows.rs`; do not edit by hand.

| Contract | Entrypoint | Class | Detail |
| --- | --- | --- | --- |
| `market-core` | `__constructor` | Permissionless | deployment only |
| `market-core` | `add_collateral` | Signer | Admin |
| `market-core` | `set_collateral_enabled` | Signer | Admin |
| `market-core` | `collateral_params` | View | spec-verified pure read |
| `market-core` | `get_market_collateral` | View | spec-verified pure read |
| `market-core` | `market_collateral_info` | View | spec-verified pure read |
| `market-core` | `locked` | View | spec-verified pure read |
| `market-core` | `propose_admin` | Signer | Admin |
| `market-core` | `accept_admin` | Signer | PendingAdmin |
| `market-core` | `cancel_admin_transfer` | Signer | Admin |
| `market-core` | `set_paused` | Signer | Admin |
| `market-core` | `set_default_fee_bps` | Signer | Admin |
| `market-core` | `propose_resolver` | Signer | Admin |
| `market-core` | `accept_resolver` | Signer | PendingAdmin |
| `market-core` | `propose_treasury` | Signer | Admin |
| `market-core` | `accept_treasury` | Signer | PendingAdmin |
| `market-core` | `set_protocol_fee_share_bps` | Signer | Admin |
| `market-core` | `set_default_breaker` | Signer | Admin |
| `market-core` | `set_default_redeem_horizon` | Signer | Admin |
| `market-core` | `create_market` | Signer | Creator |
| `market-core` | `create_market_with_collateral` | Signer | Creator |
| `market-core` | `buy` | Signer | Trader |
| `market-core` | `buy_v2` | Signer | Trader |
| `market-core` | `sell` | Signer | Trader |
| `market-core` | `sell_v2` | Signer | Trader |
| `market-core` | `resolve` | Permissionless | only the configured resolver contract can satisfy the nested require_auth; no external signer |
| `market-core` | `void_market` | Permissionless | only the configured resolver contract can satisfy the nested require_auth; no external signer |
| `market-core` | `redeem` | Signer | Holder |
| `market-core` | `claim_pool_remainder` | Signer | Holder |
| `market-core` | `redeem_many` | Signer | Holder |
| `market-core` | `claim_pool_remainders` | Signer | Holder |
| `market-core` | `finalize_market` | Permissionless | anyone may finalize after the close horizon |
| `market-core` | `claim_lp_fees` | Signer | Holder |
| `market-core` | `sweep_fees` | Permissionless | anyone may sweep accrued fees to the configured recipient |
| `market-core` | `transfer_position` | Signer | Holder |
| `market-core` | `transfer_lp` | Signer | Holder |
| `market-core` | `get_config` | View | spec-verified pure read |
| `market-core` | `admin` | View | spec-verified pure read |
| `market-core` | `pending_admin` | View | spec-verified pure read |
| `market-core` | `market_count` | View | spec-verified pure read |
| `market-core` | `get_market` | View | spec-verified pure read |
| `market-core` | `get_position` | View | spec-verified pure read |
| `market-core` | `settle_state` | View | spec-verified pure read |
| `market-core` | `redeem_deadline` | View | spec-verified pure read |
| `market-core` | `max_batch` | View | spec-verified pure read |
| `market-core` | `get_price` | View | spec-verified pure read |
| `market-core` | `price_cumulative` | View | spec-verified pure read |
| `market-core` | `observe` | View | spec-verified pure read |
| `market-core` | `twap` | View | spec-verified pure read |
| `market-core` | `quote_buy` | View | spec-verified pure read |
| `market-core` | `quote_sell` | View | spec-verified pure read |
| `market-core` | `breaker_config` | View | spec-verified pure read |
| `market-core` | `breaker_state` | View | spec-verified pure read |
| `market-core` | `would_trip` | View | spec-verified pure read |
| `resolver` | `legacy_spec_hash` | Permissionless | pure hash helper |
| `resolver` | `spec_v2_hash` | Permissionless | pure hash helper |
| `resolver` | `scaled_spec_hash` | Permissionless | pure hash helper |
| `resolver` | `twap_spec_hash` | Permissionless | pure hash helper |
| `resolver` | `__constructor` | Permissionless | deployment only |
| `resolver` | `market_core` | View | spec-verified pure read |
| `resolver` | `rule_kind` | View | spec-verified pure read |
| `resolver` | `admin` | View | spec-verified pure read |
| `resolver` | `pending_admin` | View | spec-verified pure read |
| `resolver` | `accept_market_core_role` | Permissionless | only the configured market-core can satisfy this contract-to-contract check |
| `resolver` | `propose_admin` | Signer | Admin |
| `resolver` | `accept_admin` | Signer | PendingAdmin |
| `resolver` | `cancel_admin_transfer` | Signer | Admin |
| `resolver` | `register_price_spec` | View | spec-verified pure read |
| `resolver` | `register_scaled_price_spec` | View | spec-verified pure read |
| `resolver` | `register_twap_spec` | View | spec-verified pure read |
| `resolver` | `register_signer_spec` | View | spec-verified pure read |
| `resolver` | `register_disputable_spec` | View | spec-verified pure read |
| `resolver` | `register_weighted_key_spec` | View | spec-verified pure read |
| `resolver` | `register_spec_v2` | View | spec-verified pure read |
| `resolver` | `register_committee_spec` | View | spec-verified pure read |
| `resolver` | `register_hybrid_spec` | View | spec-verified pure read |
| `resolver` | `create_committee` | Signer | CommitteeAdmin |
| `resolver` | `propose_rotation` | Signer | CommitteeAdmin |
| `resolver` | `execute_rotation` | Permissionless | the committee delay is the protection, not a signer |
| `resolver` | `cancel_rotation` | Signer | CommitteeAdmin |
| `resolver` | `get_committee` | View | spec-verified pure read |
| `resolver` | `pin_committee_epoch` | View | spec-verified pure read |
| `resolver` | `market_committee_epoch` | View | spec-verified pure read |
| `resolver` | `committee_members_at` | View | spec-verified pure read |
| `resolver` | `open_fallback` | Permissionless | anyone may open a fallback after the deadline |
| `resolver` | `set_evidence_config` | Signer | Admin |
| `resolver` | `evidence_config` | View | spec-verified pure read |
| `resolver` | `evidence_count` | View | spec-verified pure read |
| `resolver` | `evidence_at` | View | spec-verified pure read |
| `resolver` | `cancel_count` | View | spec-verified pure read |
| `resolver` | `guardian_options` | View | spec-verified pure read |
| `resolver` | `cancel_proposal` | Signer | Admin |
| `resolver` | `guardian_void_market` | Signer | Admin |
| `resolver` | `resolve_price` | Permissionless | anyone may submit an oracle price after close |
| `resolver` | `resolve_twap` | Permissionless | anyone may resolve from the recorded TWAP |
| `resolver` | `snapshot_price` | Signer | Signer |
| `resolver` | `snapshot` | View | spec-verified pure read |
| `resolver` | `preview_price` | View | spec-verified pure read |
| `resolver` | `resolution_deadline` | View | spec-verified pure read |
| `resolver` | `expire_market` | Permissionless | clock-driven cleanup |
| `resolver` | `attest` | Signer | Signer |
| `resolver` | `attest_with_evidence` | Signer | Signer |
| `resolver` | `submit_signatures` | Permissionless | signature verification is the authority |
| `resolver` | `current_round` | View | spec-verified pure read |
| `resolver` | `finalize_signers` | Permissionless | anyone may finalise once the threshold is met |
| `resolver` | `dispute` | Signer | Signer |
| `resolver` | `settle_dispute` | Signer | Admin |
| `resolver` | `escalation_attest` | Signer | Signer |
| `resolver` | `expire_dispute` | Permissionless | clock-driven cleanup |
| `resolver` | `claim_dispute_bond` | Permissionless | pays the winning disputer; no admin discretion |
| `resolver` | `state` | View | spec-verified pure read |
| `resolver` | `spec_kind` | View | spec-verified pure read |
| `resolver` | `trade_status` | View | spec-verified pure read |
| `treasury` | `__constructor` | Permissionless | deployment only |
| `treasury` | `get_config` | View | spec-verified pure read |
| `treasury` | `get_global` | View | spec-verified pure read |
| `treasury` | `available_capital` | View | spec-verified pure read |
| `treasury` | `liquid_capital` | View | spec-verified pure read |
| `treasury` | `available_capital_of` | View | spec-verified pure read |
| `treasury` | `token_caps` | View | spec-verified pure read |
| `treasury` | `set_token_caps` | Signer | Admin |
| `treasury` | `capital_breakdown` | View | spec-verified pure read |
| `treasury` | `daily_usage` | View | spec-verified pure read |
| `treasury` | `daily_usage_detail` | View | spec-verified pure read |
| `treasury` | `daily_headroom` | View | spec-verified pure read |
| `treasury` | `agent_daily_usage` | View | spec-verified pure read |
| `treasury` | `get_net_cap` | View | spec-verified pure read |
| `treasury` | `net_exposure` | View | spec-verified pure read |
| `treasury` | `net_position` | View | spec-verified pure read |
| `treasury` | `market_valuation` | View | spec-verified pure read |
| `treasury` | `set_paused` | Permissionless | delegates to pause/unpause, both admin-gated |
| `treasury` | `pause` | Signer | Admin |
| `treasury` | `set_unwinder` | Signer | Admin |
| `treasury` | `unwinder` | View | spec-verified pure read |
| `treasury` | `set_exit_floor` | Signer | Admin |
| `treasury` | `set_default_exit_floor` | Signer | Admin |
| `treasury` | `exit_floor` | View | spec-verified pure read |
| `treasury` | `unwound` | View | spec-verified pure read |
| `treasury` | `propose_op` | Signer | Admin |
| `treasury` | `execute_op` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_op` | Signer | Admin |
| `treasury` | `pending_op` | View | spec-verified pure read |
| `treasury` | `correlation_caps` | View | spec-verified pure read |
| `treasury` | `category_exposure` | View | spec-verified pure read |
| `treasury` | `bucket_exposure` | View | spec-verified pure read |
| `treasury` | `correlation_headroom` | View | spec-verified pure read |
| `treasury` | `pending_correlation_caps` | View | spec-verified pure read |
| `treasury` | `propose_correlation_caps` | Signer | Admin |
| `treasury` | `execute_correlation_caps` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_correlation_caps` | Signer | Admin |
| `treasury` | `unpause` | Signer | Admin |
| `treasury` | `resume_agents` | Signer | Admin |
| `treasury` | `declare_emergency` | Signer | Admin |
| `treasury` | `end_emergency` | Signer | Admin |
| `treasury` | `set_mode` | Signer | Admin |
| `treasury` | `mode` | View | spec-verified pure read |
| `treasury` | `mode_state` | View | spec-verified pure read |
| `treasury` | `allowed` | View | spec-verified pure read |
| `treasury` | `set_agent` | Signer | Admin |
| `treasury` | `execute_agent` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_agent` | Signer | Admin |
| `treasury` | `remove_agent` | Signer | Admin |
| `treasury` | `agent_halt` | Signer | Agent |
| `treasury` | `get_agent` | View | spec-verified pure read |
| `treasury` | `pending_agent` | View | spec-verified pure read |
| `treasury` | `agent_count` | View | spec-verified pure read |
| `treasury` | `agent_at` | View | spec-verified pure read |
| `treasury` | `propose_config` | Signer | Admin |
| `treasury` | `execute_config` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_config` | Signer | Admin |
| `treasury` | `pending_config` | View | spec-verified pure read |
| `treasury` | `config_delay` | View | spec-verified pure read |
| `treasury` | `max_mark_age_ledgers` | View | spec-verified pure read |
| `treasury` | `pending_max_mark_age` | View | spec-verified pure read |
| `treasury` | `set_max_mark_age` | Signer | Admin |
| `treasury` | `execute_max_mark_age` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_max_mark_age` | Signer | Admin |
| `treasury` | `set_config_delay` | Signer | Admin |
| `treasury` | `get_price_policy` | View | spec-verified pure read |
| `treasury` | `set_price_policy` | Signer | Admin |
| `treasury` | `execute_price_policy` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_price_policy` | Signer | Admin |
| `treasury` | `pending_price_policy` | View | spec-verified pure read |
| `treasury` | `get_resolvability_policy` | View | spec-verified pure read |
| `treasury` | `set_resolvability_policy` | Signer | Admin |
| `treasury` | `execute_resolvability_policy` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_resolvability_policy` | Signer | Admin |
| `treasury` | `pending_resolvability_policy` | View | spec-verified pure read |
| `treasury` | `nav` | View | spec-verified pure read |
| `treasury` | `nav_detail` | View | spec-verified pure read |
| `treasury` | `audit_mark` | Permissionless | read-only audit view |
| `treasury` | `refresh_mark` | Permissionless | recomputes a cached valuation |
| `treasury` | `migrate_marks` | Permissionless | migration is bounded by the configured successor |
| `treasury` | `shares_of` | View | spec-verified pure read |
| `treasury` | `total_shares` | View | spec-verified pure read |
| `treasury` | `queue_reserved` | View | spec-verified pure read |
| `treasury` | `withdraw_ticket` | View | spec-verified pure read |
| `treasury` | `queue_bounds` | View | spec-verified pure read |
| `treasury` | `open_market_count` | View | spec-verified pure read |
| `treasury` | `open_market_at` | View | spec-verified pure read |
| `treasury` | `deposit` | Signer | Holder |
| `treasury` | `deposit_token` | Signer | Holder |
| `treasury` | `request_withdraw` | Signer | Holder |
| `treasury` | `claim_withdraw` | Permissionless | pays a previously queued ticket; no admin discretion |
| `treasury` | `emergency_withdraw` | Signer | Holder |
| `treasury` | `trace_policy` | View | spec-verified pure read |
| `treasury` | `propose_trace_policy` | Signer | Admin |
| `treasury` | `execute_trace_policy` | Permissionless | delayed admin proposal is the authority |
| `treasury` | `cancel_trace_policy` | Signer | Admin |
| `treasury` | `agent_create_market` | Signer | Agent |
| `treasury` | `agent_create_market_collateral` | Signer | Agent |
| `treasury` | `agent_create_market_and_reveal` | Signer | Agent |
| `treasury` | `agent_create_market_reveal_v2` | Signer | Agent |
| `treasury` | `agent_buy` | Signer | Agent |
| `treasury` | `agent_buy_v2` | Signer | Agent |
| `treasury` | `agent_sell` | Signer | Agent |
| `treasury` | `agent_sell_v2` | Signer | Agent |
| `treasury` | `close_trade` | Signer | Agent |
| `treasury` | `agent_buy_traced` | Signer | Agent |
| `treasury` | `agent_sell_traced` | Signer | Agent |
| `treasury` | `redeem` | Signer | Agent |
| `treasury` | `claim_pool_remainder` | Signer | Agent |
| `treasury` | `legacy_redeem` | Signer | Agent |
| `treasury` | `legacy_claim_pool_remainder` | Signer | Agent |
| `treasury` | `redeem_many` | Signer | Agent |
| `treasury` | `claim_pool_remainders` | Signer | Agent |
| `treasury` | `agent_claim_lp_fees` | Signer | Agent |
| `treasury` | `collect_market_fees` | Signer | Admin |
| `treasury` | `settle_market` | Signer | Caller |
| `treasury` | `realized` | View | spec-verified pure read |
| `treasury` | `realize` | Permissionless | bookkeeping update after a closed market |
| `treasury` | `market_pnl` | View | spec-verified pure read |
| `treasury` | `window_pnl` | View | spec-verified pure read |
| `treasury` | `drawdown_status` | View | spec-verified pure read |
| `treasury` | `acknowledge_drawdown` | Signer | Admin |
| `treasury` | `reset_pnl_window` | Signer | Admin |
| `treasury` | `set_drawdown_config` | Signer | Admin |
| `treasury` | `get_creation_policy` | View | spec-verified pure read |
| `treasury` | `creation_usage` | View | spec-verified pure read |
| `treasury` | `set_creation_policy` | Signer | Admin |
| `treasury` | `set_yield_venue` | Signer | Admin |
| `treasury` | `allocate_to_yield` | Signer | Admin |
| `treasury` | `recall_from_yield` | Signer | Admin |
| `treasury` | `disable_yield` | Signer | Admin |
| `treasury` | `set_successor` | Signer | Admin |
| `treasury` | `migrate_markets` | Signer | Admin, Agent |
| `treasury` | `unwind_sell` | Signer | Agent |
| `reasoning-registry` | `__constructor` | Permissionless | deployment only |
| `reasoning-registry` | `propose_admin` | Signer | Admin |
| `reasoning-registry` | `accept_admin` | Signer | PendingAdmin |
| `reasoning-registry` | `cancel_admin_transfer` | Signer | Admin |
| `reasoning-registry` | `admin` | View | spec-verified pure read |
| `reasoning-registry` | `pending_admin` | View | spec-verified pure read |
| `reasoning-registry` | `register_agent` | Signer | Admin |
| `reasoning-registry` | `retire_agent` | Signer | Admin |
| `reasoning-registry` | `retire_self` | Signer | Agent |
| `reasoning-registry` | `reactivate_agent` | Signer | Admin |
| `reasoning-registry` | `revoke_agent` | Signer | Admin |
| `reasoning-registry` | `unregister_agent` | Permissionless | legacy self-service path retained for compatibility |
| `reasoning-registry` | `is_registered` | View | spec-verified pure read |
| `reasoning-registry` | `get_agent` | View | spec-verified pure read |
| `reasoning-registry` | `publish_trace` | Signer | Agent |
| `reasoning-registry` | `publish_chained_trace` | Signer | Agent |
| `reasoning-registry` | `agent_chain_head` | View | spec-verified pure read |
| `reasoning-registry` | `agent_trace_at` | View | spec-verified pure read |
| `reasoning-registry` | `get_trace_link` | View | spec-verified pure read |
| `reasoning-registry` | `get_trace_ledger` | View | spec-verified pure read |
| `reasoning-registry` | `register_consumer` | Signer | Admin |
| `reasoning-registry` | `unregister_consumer` | Signer | Admin |
| `reasoning-registry` | `is_consumer` | View | spec-verified pure read |
| `reasoning-registry` | `consume_trace` | Signer | Consumer |
| `reasoning-registry` | `is_consumed` | View | spec-verified pure read |
| `reasoning-registry` | `verify_commitment` | View | spec-verified pure read |
| `reasoning-registry` | `get_trace` | View | spec-verified pure read |
| `reasoning-registry` | `flag_trace` | Signer | Admin |
| `reasoning-registry` | `unflag_trace` | Signer | Admin |
| `reasoning-registry` | `set_availability_reporter` | Signer | Admin |
| `reasoning-registry` | `availability_reporter` | View | spec-verified pure read |
| `reasoning-registry` | `report_unavailable` | Signer | Reporter |
| `reasoning-registry` | `clear_unavailable` | Signer | Reporter |
| `reasoning-registry` | `trace_flags` | View | spec-verified pure read |
| `reasoning-registry` | `get_trace_flag` | View | spec-verified pure read |
| `reasoning-registry` | `trace_verdict` | View | spec-verified pure read |
| `reasoning-registry` | `verify_trace` | View | spec-verified pure read |
| `reasoning-registry` | `trace_count` | View | spec-verified pure read |
| `reasoning-registry` | `market_trace_count` | View | spec-verified pure read |
| `reasoning-registry` | `market_trace_at` | View | spec-verified pure read |
| `reasoning-registry` | `agent_trace_count` | View | spec-verified pure read |
| `reasoning-registry` | `market_action_trace_count` | View | spec-verified pure read |
| `reasoning-registry` | `market_action_trace_at` | View | spec-verified pure read |
| `reasoning-registry` | `traces_by_market` | View | spec-verified pure read |
| `reasoning-registry` | `traces_by_agent` | View | spec-verified pure read |
| `reasoning-registry` | `traces_by_market_action` | View | spec-verified pure read |
| `reasoning-registry` | `publish_trace_batch` | Signer | Agent |
| `reasoning-registry` | `get_batch` | View | spec-verified pure read |
| `reasoning-registry` | `batch_count` | View | spec-verified pure read |
| `reasoning-registry` | `agent_batch_count` | View | spec-verified pure read |
| `reasoning-registry` | `agent_batch_at` | View | spec-verified pure read |
| `reasoning-registry` | `verify_trace_inclusion` | View | spec-verified pure read |
| `reasoning-registry` | `compute_merkle_root` | View | spec-verified pure read |
| `reasoning-registry` | `add_signing_key` | Signer | Agent |
| `reasoning-registry` | `retire_signing_key` | Signer | Agent |
| `reasoning-registry` | `get_signing_keys` | View | spec-verified pure read |
| `reasoning-registry` | `get_key_agent` | View | spec-verified pure read |
| `reasoning-registry` | `signing_key_history_count` | View | spec-verified pure read |
| `reasoning-registry` | `signing_key_history` | View | spec-verified pure read |
| `reasoning-registry` | `publish_trace_signed` | Signer | Agent |
| `reasoning-registry` | `publish_chained_trace_signed` | Signer | Agent |
| `reasoning-registry` | `get_trace_signature` | View | spec-verified pure read |
| `reasoning-registry` | `verify_trace_signature` | View | spec-verified pure read |
| `reasoning-registry` | `revoke_signing_key` | Signer | Agent |
| `reasoning-registry` | `signature_verdict` | View | spec-verified pure read |
| `reasoning-registry` | `key_trace_count` | View | spec-verified pure read |
| `reasoning-registry` | `key_traces` | View | spec-verified pure read |
| `reasoning-registry` | `key_affected_from` | View | spec-verified pure read |
| `reasoning-registry` | `affected_traces` | View | spec-verified pure read |
| `reasoning-registry` | `key_bind_message` | View | spec-verified pure read |
| `reasoning-registry` | `trace_attestation_message` | View | spec-verified pure read |
| `router` | `__constructor` | Permissionless | deployment only |
| `router` | `create_and_reveal` | Signer | Creator |
| `router` | `agent_create_and_reveal` | Signer | Agent |
| `router` | `create_and_reveal_signers` | Signer | Creator |
| `router` | `create_and_reveal_price` | Signer | Creator |
| `router` | `reveal_spec` | Permissionless | the reveal is bound to the commitment hash |
| `router` | `trade_and_publish_trace` | Signer | Trader |
| `router` | `agent_trade_and_publish_trace` | Signer | Agent |
| `router` | `buy_and_publish_trace` | Signer | Trader |
| `router` | `config` | View | spec-verified pure read |
| `timelock` | `__constructor` | Permissionless | deployment only |
| `timelock` | `schedule` | Signer | Proposer |
| `timelock` | `execute` | Signer | Executor |
| `timelock` | `cancel` | Signer | Canceller |
| `timelock` | `emergency` | Signer | Emergency |
| `timelock` | `set_roles` | Signer | Admin |
| `timelock` | `set_delay` | Signer | Admin |
| `timelock` | `set_default_delay` | Signer | Admin |
| `timelock` | `propose_admin` | Signer | Admin |
| `timelock` | `accept_admin` | Signer | PendingAdmin |
| `timelock` | `cancel_admin_transfer` | Signer | Admin |
| `timelock` | `admin` | View | spec-verified pure read |
| `timelock` | `pending_admin` | View | spec-verified pure read |
| `timelock` | `roles` | View | spec-verified pure read |
| `timelock` | `default_delay` | View | spec-verified pure read |
| `timelock` | `delay_for` | View | spec-verified pure read |
| `timelock` | `operation` | View | spec-verified pure read |
| `timelock` | `operation_count` | View | spec-verified pure read |

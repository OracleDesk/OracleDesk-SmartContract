//! Issue #277: a queued withdrawal is paid by `settle_market` in the same
//! transaction, against the real wasm of all contracts (`World`). Every auth
//! is a targeted mock; this crate never uses `mock_all_auths`.

use integration_tests::treasury;
use integration_tests::world::{World, USDC};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, IntoVal,
};

/// The treasury client with exactly one mocked invocation by `who`.
macro_rules! as_user {
    ($w:expr, $who:expr, $fn_name:expr, $args:expr, $sub:expr $(,)?) => {{
        $w.env.set_auths(&[]);
        $w.treasury.mock_auths(&[MockAuth {
            address: $who,
            invoke: &MockAuthInvoke {
                contract: &$w.treasury_id,
                fn_name: $fn_name,
                args: $args,
                sub_invokes: $sub,
            },
        }])
    }};
}

#[test]
fn queued_withdrawal_is_drained_by_settle_market() {
    let w = World::new();
    let alice = Address::generate(&w.env);
    let deposit = 20 * USDC;
    w.mint_to(&alice, deposit);

    // Alice deposits.
    let pull = MockAuthInvoke {
        contract: &w.collateral,
        fn_name: "transfer",
        args: (alice.clone(), w.treasury_id.clone(), deposit).into_val(&w.env),
        sub_invokes: &[],
    };
    let shares = as_user!(
        &w,
        &alice,
        "deposit",
        (alice.clone(), deposit).into_val(&w.env),
        core::slice::from_ref(&pull),
    )
    .deposit(&alice, &deposit);
    assert!(shares > 0);

    // The agent deploys capital into complete sets of the signer market.
    let market = w.signer_market;
    for outcome in [treasury::Outcome::Yes, treasury::Outcome::No] {
        let amount = 2 * USDC;
        as_user!(
            &w,
            &w.agent,
            "agent_buy",
            (w.agent.clone(), market, outcome.clone(), amount, 0_i128).into_val(&w.env),
            &[],
        )
        .agent_buy(&w.agent, &market, &outcome, &amount, &0);
    }

    // The seeded admin withdraws first and takes most of the idle
    // collateral, so only part of Alice's withdrawal can be paid at once.
    let admin_shares = w.treasury.shares_of(&w.admin);
    as_user!(
        &w,
        &w.admin,
        "request_withdraw",
        (w.admin.clone(), admin_shares).into_val(&w.env),
        &[],
    )
    .request_withdraw(&w.admin, &admin_shares);
    let (paid_now, ticket_id) = as_user!(
        &w,
        &alice,
        "request_withdraw",
        (alice.clone(), shares).into_val(&w.env),
        &[],
    )
    .request_withdraw(&alice, &shares);
    assert!(ticket_id > 0, "part of Alice's withdrawal must be queued");
    assert_eq!(w.token.balance(&alice), paid_now);
    let owed_alice = w.treasury.withdraw_ticket(&ticket_id).unwrap().remaining;
    let reserved = w.treasury.queue_reserved();
    let admin_before = w.token.balance(&w.admin);

    // The market resolves; a keeper settles it. The redemption proceeds are
    // paid to the queue inside the same `settle_market` call, pro rata over
    // the head window (both tickets).
    w.resolve_signer_market();
    let keeper = Address::generate(&w.env);
    as_user!(
        &w,
        &keeper,
        "settle_market",
        (keeper.clone(), market).into_val(&w.env),
        &[],
    )
    .settle_market(&keeper, &market);
    w.env.set_auths(&[]);

    let alice_paid = w.token.balance(&alice) - paid_now;
    let admin_paid = w.token.balance(&w.admin) - admin_before;
    assert!(alice_paid > 0, "settle_market must pay the queued ticket");
    assert!(alice_paid <= owed_alice);
    assert_eq!(
        w.treasury.queue_reserved(),
        reserved - alice_paid - admin_paid
    );
    let left = w
        .treasury
        .withdraw_ticket(&ticket_id)
        .map(|t| t.remaining)
        .unwrap_or(0);
    assert_eq!(left, owed_alice - alice_paid);
}

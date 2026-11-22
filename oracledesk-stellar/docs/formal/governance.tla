---------------------------- MODULE governance ----------------------------
(***************************************************************************)
(* Who may change OracleDesk's money-moving configuration, and how:        *)
(*                                                                         *)
(*   1. two-step admin transfer (ADR 0007): propose_admin / accept_admin / *)
(*      cancel_admin_transfer, with a TTL, on market-core, resolver and    *)
(*      the timelock (the registry is the same shape as market-core);      *)
(*   2. authenticated wiring (ADR 0006): market-core propose_resolver /    *)
(*      propose_treasury, then the peer's accept_market_core_role, and     *)
(*      market-core's accept_resolver / accept_treasury;                   *)
(*   3. the governance timelock (ADR 0008): schedule / execute / cancel /  *)
(*      emergency, admin-instant set_roles / set_delay, scheduled          *)
(*      self-calls.                                                        *)
(*                                                                         *)
(* Source of truth: contracts/{market-core,resolver,timelock}/src/lib.rs.  *)
(* See docs/formal/README.md ("Governance model") for the abstraction,     *)
(* the action -> entrypoint table, and the findings.                       *)
(*                                                                         *)
(* Soroban semantics that matter here                                      *)
(*  - An invocation that errors is rolled back entirely: an error is an    *)
(*    action that is not enabled (or, for a cross-contract attempt, one    *)
(*    that records `lastResult = "reverted"` and changes nothing else).    *)
(*  - A contract that is already executing cannot be invoked again         *)
(*    (re-entry is forbidden: the host raises Error(Context,               *)
(*    InvalidAction)). `Invoke` below is the only way to enter a contract. *)
(*  - require_auth on a *contract* address is satisfied only when that     *)
(*    contract is the direct invoker, so a third party cannot authorise    *)
(*    for it. A key address is authorised by whoever holds the key.        *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Keys,               \* operator keys (model values)
    Actors,             \* the keys that may act (a config can restrict it to one
                        \* compromised key; honest keys then stay idle = worst case)
    K1, K2, K3,         \* named keys, all in Keys
    Core, Res, Tre, TL, \* contracts: market-core, resolver, treasury, timelock
    Wrong,              \* a peer that has accept_market_core_role but is wired to
                        \* a different market-core (a misconfigured deploy)
    OtherCore,          \* the other market-core Wrong points at
    Other,              \* any other contract address (emergency targets)
    MaxTime,            \* now saturates here
    AdminTTL,           \* ADMIN_PROPOSAL_TTL_SECS / ADMIN_TRANSFER_TTL
    MinDelay, MaxDelay, \* the timelock's delay bounds
    Grace,              \* EXECUTION_GRACE
    MaxOps,             \* at most this many scheduled operations ever
    \* ---- scenario switches ------------------------------------------------
    AllowAdmin, AllowWiring, AllowTimelock,   \* BOOLEAN: which protocols run
    AdminExpiry,        \* "Code": accept at now <= expires_at (today)
                        \* "Adr" : accept only at now <  expires_at (ADR 0007)
    WIRING_MODE,        \* "Callback" (today) or "PeerAsserts" (proposed)
    TIMELOCK_SELF_ADMIN,\* BOOLEAN: execute also handles scheduled accept_admin and
                        \* set_roles self-calls (today only set_default_delay)
    START_HANDED_OVER,  \* BOOLEAN: the timelock is its own admin from the start
    WatchdogVigilant,   \* BOOLEAN: the honest watchdog cancels any operation a
                        \* compromised key (Actors) scheduled, if it holds the
                        \* canceller role for at least one tick before eta
    AdminSet,           \* contracts whose admin transfer is exercised (subset of {Core, Res, TL})
    Proposable,         \* peers the core admin may propose (liveness config: {Res})
    Mutation            \* "None" or a deliberate bug (docs/formal/README.md)

ASSUME /\ {K1, K2, K3} \subseteq Keys /\ Actors \subseteq Keys
       /\ WIRING_MODE \in {"Callback", "PeerAsserts"}
       /\ AdminExpiry \in {"Code", "Adr"}
       /\ Mutation \in {"None", "accept_no_auth", "execute_ignores_eta",
                        "cancel_skips_removal", "emergency_allows_all"}
       /\ MinDelay >= 1 /\ MinDelay <= MaxDelay

\* ---- fixed topology --------------------------------------------------------
AdminContracts == {Core, Res, TL}   \* contracts with an admin (state); AdminSet picks the ones explored
Peers          == {Res, Tre, Wrong}
WRoles         == {"resolver", "treasury"}
NoPeer         == "none"
NoKey          == "nokey"
\* What can be an admin: keys, and the timelock itself when it can be its own admin.
Principals     == IF TIMELOCK_SELF_ADMIN \/ START_HANDED_OVER THEN Keys \cup {TL} ELSE Keys

\* Which peers can run accept_market_core_role at all, and what market_core()
\* each reports. Treasury has neither entrypoint today (ADR 0006 gap).
HasAccept == [p \in Peers |-> p /= Tre]
PeerCore  == [p \in Peers |-> IF p = Wrong THEN OtherCore ELSE Core]

Max(a, b) == IF a > b THEN a ELSE b
Min(a, b) == IF a < b THEN a ELSE b
Range(s)  == {s[i] : i \in 1..Len(s)}

\* ---- timelock data ---------------------------------------------------------
NoOp == [fn |-> "none"]
\* Scheduled functions. "cfg" stands for any configuration change on a core
\* contract the timelock administers; the others are self-calls.
SelfFns == IF TIMELOCK_SELF_ADMIN
           THEN {"set_default_delay", "set_roles", "accept_admin"}
           ELSE {"set_default_delay"}
SchedFns == {"cfg"} \cup SelfFns
EmFns    == {"set_paused_true", "set_paused_false", "cancel_proposal", "cfg"}
\* The emergency allow-list in timelock `is_emergency_allowed`: set_paused(true)
\* and cancel_proposal, on ANY target address.
EmergencyAllowed(fn) ==
    IF Mutation = "emergency_allows_all" THEN TRUE
    ELSE fn \in {"set_paused_true", "cancel_proposal"}

ViolNames == {"adminUnauth", "adminExpired", "wiringUnconsenting", "wiringStale",
              "execEarly", "execLate", "execCancelled", "cfgUnsafe", "emergOutsideAllow"}

VARIABLES
    now,
    \* ---- two-step admin transfer, per administered contract ----
    admin, pending, pendingExp, pendingBy,
    \* ---- authenticated wiring (market-core) ----
    wiring, pendingWiring, pwAt,
    \* ---- timelock ----
    roles, defaultDelay, ovr, nextId, ops, cancelled,
    \* ---- violation flags, one per safety property (auditing only: never read by
    \* an enabling condition). A flag is set by the action that breaks the
    \* property, so TLC explores no history, and the counterexample trace shows
    \* the action and its arguments. ----
    viol, lastStack, lastResult

vars == << now, admin, pending, pendingExp, pendingBy, wiring, pendingWiring,
           pwAt, roles, defaultDelay, ovr, nextId, ops, cancelled, viol,
           lastStack, lastResult >>

\* ---- the cross-contract call stack ----------------------------------------
\* Soroban forbids invoking a contract that is already executing.
Invoke(stack, c) == c \notin Range(stack)

\* The honest watchdog: the canceller key the system was deployed with.
Watchdog == K2

TypeOK ==
    /\ now \in 0..MaxTime
    /\ admin \in [AdminContracts -> Principals]
    /\ pending \in [AdminContracts -> Principals \cup {NoKey}]
    /\ pendingExp \in [AdminContracts -> 0..(MaxTime + AdminTTL)]
    /\ pendingBy \in [AdminContracts -> Keys \cup {NoKey}]
    /\ wiring \in [WRoles -> Peers \cup {NoPeer}]
    /\ pendingWiring \in [WRoles -> Peers \cup {NoPeer}]
    /\ roles.proposer \in Keys /\ roles.canceller \in Keys
    /\ defaultDelay \in MinDelay..MaxDelay
    /\ nextId \in 1..(MaxOps + 1)
    /\ viol \in [ViolNames -> BOOLEAN]
    /\ lastResult \in {"none", "ok", "reverted"}

Init ==
    /\ now = 0
    /\ admin = [c \in AdminContracts |-> IF c = TL /\ START_HANDED_OVER THEN TL ELSE K3]
    /\ pending = [c \in AdminContracts |-> NoKey]
    /\ pendingExp = [c \in AdminContracts |-> 0]
    /\ pendingBy = [c \in AdminContracts |-> NoKey]
    /\ wiring = [r \in WRoles |-> NoPeer]
    /\ pendingWiring = [r \in WRoles |-> NoPeer]
    /\ pwAt = [r \in WRoles |-> 0]
    /\ roles = [proposer |-> K1, canceller |-> Watchdog, executor |-> "any",
                emergency |-> K2]
    /\ defaultDelay = MinDelay
    /\ ovr = 0
    /\ nextId = 1
    /\ ops = [i \in 1..MaxOps |-> NoOp]
    /\ cancelled = {}
    /\ viol = [p \in ViolNames |-> FALSE]
    /\ lastStack = << >> /\ lastResult = "none"

Flag(name, bad) == viol' = [viol EXCEPT ![name] = viol[name] \/ bad]

(***************************************************************************)
(* Predicates over audit records. Properties (bottom) say "no action ever  *)
(* produced a record one of these rejects".                                *)
(***************************************************************************)

\* admin changes only by the address the then-admin proposed, authorised by it
AdminChangeAuthorised(e) == e.acceptor = e.to /\ e.by = e.from
\* ADR 0007: a proposal is inert once `expires_at <= now`
AdminChangeInTime(e) == e.acceptedAt - e.proposedAt < AdminTTL
\* wiring changes only to a peer wired to this core that initiated the accept
WiringConsented(e) == e.peerCore = e.core /\ e.initiator = e.peer
\* a pending wiring proposal should not outlive the admin TTL
WiringFresh(e) == e.acceptedAt - e.proposedAt <= AdminTTL
ExecutedOnTime(e)       == e.at >= e.eta
ExecutedBeforeExpiry(e) == e.at <= e.exp
\* a configuration change needs the full delay AND a canceller opportunity: at least
\* one tick passed, between schedule and execute, while the honest watchdog held
\* the canceller role
ConfigChangeWatched(e) ==
    e.fn = "cfg" =>
        /\ e.at - e.scheduledAt >= MinDelay
        /\ e.seen


(***************************************************************************)
(* 1. Two-step admin transfer                                              *)
(***************************************************************************)

\* A key is authorised for `c`'s admin role; a contract admin (the timelock)
\* acts only through `Execute`, never as a bare key.
IsAdminKey(c, k) == admin[c] = k /\ k \in Actors

\* propose_admin(new_admin): require_admin, stores PendingAdmin with an expiry.
ProposeAdmin(c, k, n) ==
    /\ AllowAdmin /\ c \in AdminSet /\ IsAdminKey(c, k)
    /\ n \in Principals /\ n /= admin[c]
    /\ pending' = [pending EXCEPT ![c] = n]
    /\ pendingExp' = [pendingExp EXCEPT ![c] = now + AdminTTL]
    /\ pendingBy' = [pendingBy EXCEPT ![c] = k]
    /\ UNCHANGED << now, admin, wiring, pendingWiring, pwAt, roles, defaultDelay,
                    ovr, nextId, ops, cancelled, viol, lastStack, lastResult >>

\* Each contract's own expiry check. market-core, resolver and the registry
\* reject `now > expires_at`; the timelock rejects `now > PendingAdminAt`. All
\* four accept AT expires_at. ADR 0007 says the proposal is inert once
\* `expires_at <= now`. AdminExpiry picks which one the model implements.
NotExpired(c) ==
    IF AdminExpiry = "Code" THEN now <= pendingExp[c] ELSE now < pendingExp[c]

\* The audit record of one accepted transfer, judged by the two properties.
AdminChange(c, k) ==
    [c |-> c, from |-> admin[c], to |-> pending[c], by |-> pendingBy[c],
     acceptor |-> k, proposedAt |-> pendingExp[c] - AdminTTL, acceptedAt |-> now]

\* accept_admin(): the pending admin must authorise (Mutation drops that).
AcceptAdmin(c, k) ==
    /\ AllowAdmin /\ c \in AdminSet /\ k \in Actors
    /\ pending[c] /= NoKey
    /\ NotExpired(c)
    /\ (k = pending[c] \/ Mutation = "accept_no_auth")
    /\ admin' = [admin EXCEPT ![c] = pending[c]]
    /\ pending' = [pending EXCEPT ![c] = NoKey]
    /\ pendingExp' = [pendingExp EXCEPT ![c] = 0]
    /\ pendingBy' = [pendingBy EXCEPT ![c] = NoKey]
    /\ LET e == AdminChange(c, k) IN
       viol' = [viol EXCEPT
                  !["adminUnauth"]  = viol["adminUnauth"]  \/ ~AdminChangeAuthorised(e),
                  !["adminExpired"] = viol["adminExpired"] \/ ~AdminChangeInTime(e)]
    /\ UNCHANGED << now, wiring, pendingWiring, pwAt, roles, defaultDelay, ovr,
                    nextId, ops, cancelled, lastStack, lastResult >>

CancelAdmin(c, k) ==
    /\ AllowAdmin /\ c \in AdminSet /\ IsAdminKey(c, k)
    /\ pending[c] /= NoKey
    /\ pending' = [pending EXCEPT ![c] = NoKey]
    /\ pendingExp' = [pendingExp EXCEPT ![c] = 0]
    /\ pendingBy' = [pendingBy EXCEPT ![c] = NoKey]
    /\ UNCHANGED << now, admin, wiring, pendingWiring, pwAt, roles, defaultDelay,
                    ovr, nextId, ops, cancelled, viol, lastStack, lastResult >>

(***************************************************************************)
(* 2. Authenticated wiring                                                 *)
(***************************************************************************)

\* market-core propose_resolver / propose_treasury: admin only, no expiry, and
\* a second proposal silently overwrites the first.
ProposeWiring(r, p, k) ==
    /\ AllowWiring /\ IsAdminKey(Core, k)
    /\ p \in Proposable
    /\ pendingWiring' = [pendingWiring EXCEPT ![r] = p]
    /\ pwAt' = [pwAt EXCEPT ![r] = now]
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, wiring, roles,
                    defaultDelay, ovr, nextId, ops, cancelled, viol, lastStack,
                    lastResult >>

\* The whole transaction `peer.accept_market_core_role()` as one atomic step.
\* Anyone may trigger it (the entrypoint has no auth of its own); the peer is
\* the direct invoker of market-core, which is what satisfies
\* `pending.require_auth()`.
\*
\* Callback (today): resolver -> market-core.accept_resolver -> resolver.market_core()
\*   The last call re-enters the resolver that is already on the stack, so the
\*   host reverts the whole transaction.
\* PeerAsserts (proposed): the peer first asserts its own market_core() is this
\*   core, then calls market-core, which relies on require_auth alone.
AcceptStack(p) ==
    IF WIRING_MODE = "Callback" THEN << p, Core, p >> ELSE << p, Core >>

AcceptWorks(p, r) ==
    /\ HasAccept[p]
    /\ pendingWiring[r] = p
    /\ IF WIRING_MODE = "Callback"
       THEN Invoke(<< p, Core >>, p)           \* the callback into p
       ELSE PeerCore[p] = Core                 \* the peer's own assertion

PeerAccept(p, r, k) ==
    /\ AllowWiring /\ k \in Actors /\ HasAccept[p]
    /\ \/ /\ AcceptWorks(p, r)
          /\ wiring' = [wiring EXCEPT ![r] = p]
          /\ pendingWiring' = [pendingWiring EXCEPT ![r] = NoPeer]
          /\ pwAt' = [pwAt EXCEPT ![r] = 0]
          /\ LET e == [peer |-> p, initiator |-> p, core |-> Core, peerCore |-> PeerCore[p],
                       proposedAt |-> pwAt[r], acceptedAt |-> now] IN
             viol' = [viol EXCEPT
                        !["wiringUnconsenting"] = viol["wiringUnconsenting"] \/ ~WiringConsented(e),
                        !["wiringStale"]        = viol["wiringStale"]        \/ ~WiringFresh(e)]
          /\ lastStack' = AcceptStack(p) /\ lastResult' = "ok"
       \/ /\ ~AcceptWorks(p, r)
          /\ lastStack' = AcceptStack(p) /\ lastResult' = "reverted"
          /\ UNCHANGED << wiring, pendingWiring, pwAt, viol >>
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, roles,
                    defaultDelay, ovr, nextId, ops, cancelled >>

(***************************************************************************)
(* 3. Governance timelock                                                  *)
(***************************************************************************)

\* effective_delay(target, fn): the larger of the floor and the override.
Delay(fn) == IF fn = "cfg" THEN Max(defaultDelay, ovr) ELSE defaultDelay

\* Arguments an operation can carry. Only set_roles and set_default_delay read
\* them; fixing the rest keeps the state space small.
ArgDomain(fn) ==
    IF fn = "set_roles" THEN [prop : Keys, canc : Keys, delay : {MinDelay}]
    ELSE IF fn = "set_default_delay"
         THEN [prop : {K1}, canc : {K1}, delay : MinDelay..MaxDelay]
         ELSE {[prop |-> K1, canc |-> K1, delay |-> MinDelay]}

\* schedule(target, fn, args): the proposer role must authorise.
Schedule(k, fn, a) ==
    /\ AllowTimelock /\ k \in Actors /\ k = roles.proposer
    /\ fn \in SchedFns /\ nextId <= MaxOps
    /\ a \in ArgDomain(fn)
    /\ LET eta == now + Delay(fn) IN
       ops' = [ops EXCEPT ![nextId] =
                 [fn |-> fn, args |-> a, eta |-> eta, exp |-> eta + Grace,
                  at |-> now, by |-> k, seen |-> FALSE]]
    /\ nextId' = nextId + 1
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, wiring, pendingWiring,
                    pwAt, roles, defaultDelay, ovr, cancelled, viol, lastStack,
                    lastResult >>

\* What a self-call does. Today only set_default_delay is supported; the rest
\* is SelfCallUnsupported, which reverts the transaction (the op stays).
SelfOk(op) ==
    \/ op.fn = "set_default_delay"
    \/ (TIMELOCK_SELF_ADMIN /\ op.fn = "set_roles")
    \/ (TIMELOCK_SELF_ADMIN /\ op.fn = "accept_admin" /\ pending[TL] = TL)

\* The audit record of one execution, judged by the timelock properties.
Execution(i, k) ==
    [id |-> i, fn |-> ops[i].fn, by |-> k, at |-> now, eta |-> ops[i].eta,
     exp |-> ops[i].exp, scheduledAt |-> ops[i].at, seen |-> ops[i].seen]

\* execute(id): the executor role (or anyone if unset) authorises. Atomic: the
\* "remove before invoke" is rolled back with any revert, so an expired or
\* unsupported operation stays in storage.
Execute(i, k) ==
    /\ AllowTimelock /\ k \in Actors
    /\ i \in 1..MaxOps /\ ops[i] /= NoOp
    /\ (roles.executor = "any" \/ k = roles.executor)
    /\ (now >= ops[i].eta \/ Mutation = "execute_ignores_eta")
    /\ now <= ops[i].exp
    /\ (ops[i].fn = "cfg" \/ SelfOk(ops[i]))
    /\ ~(WatchdogVigilant /\ ops[i].seen /\ ops[i].by \in Actors)
    /\ ops' = [ops EXCEPT ![i] = NoOp]
    /\ LET e == Execution(i, k) IN
       viol' = [viol EXCEPT
                  !["execEarly"]     = viol["execEarly"]     \/ ~ExecutedOnTime(e),
                  !["execLate"]      = viol["execLate"]      \/ ~ExecutedBeforeExpiry(e),
                  !["execCancelled"] = viol["execCancelled"] \/ (i \in cancelled),
                  !["cfgUnsafe"]     = viol["cfgUnsafe"]     \/ ~ConfigChangeWatched(e)]
    /\ CASE ops[i].fn = "set_default_delay" ->
              /\ defaultDelay' = ops[i].args.delay
              /\ UNCHANGED << roles, admin, pending >>
         [] ops[i].fn = "set_roles" ->
              /\ roles' = [roles EXCEPT !.proposer = ops[i].args.prop,
                                         !.canceller = ops[i].args.canc]
              /\ UNCHANGED << defaultDelay, admin, pending >>
         [] ops[i].fn = "accept_admin" ->
              /\ admin' = [admin EXCEPT ![TL] = TL]
              /\ pending' = [pending EXCEPT ![TL] = NoKey]
              /\ UNCHANGED << defaultDelay, roles >>
         [] OTHER ->                       \* "cfg": the configuration change itself
              UNCHANGED << defaultDelay, roles, admin, pending >>
    /\ UNCHANGED << now, pendingExp, pendingBy, wiring, pendingWiring, pwAt, ovr,
                    nextId, cancelled, lastStack, lastResult >>

\* cancel(id): the canceller role only. The operation is removed.
Cancel(i, k) ==
    /\ AllowTimelock /\ k \in Actors /\ k = roles.canceller
    /\ i \in 1..MaxOps /\ ops[i] /= NoOp
    /\ ops' = IF Mutation = "cancel_skips_removal" THEN ops
              ELSE [ops EXCEPT ![i] = NoOp]
    /\ cancelled' = cancelled \cup {i}
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, wiring, pendingWiring,
                    pwAt, roles, defaultDelay, ovr, nextId, viol, lastStack,
                    lastResult >>

\* emergency(target, fn, args): skips the delay for the allow-list, on any target.
Emergency(k, t, fn) ==
    /\ AllowTimelock /\ k \in Actors /\ k = roles.emergency
    /\ t \in {Core, Res, Tre, Other} /\ fn \in EmFns
    /\ EmergencyAllowed(fn)
    /\ Flag("emergOutsideAllow", fn \notin {"set_paused_true", "cancel_proposal"})
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, wiring, pendingWiring,
                    pwAt, roles, defaultDelay, ovr, nextId, ops, cancelled, lastStack,
                    lastResult >>

\* The timelock's own admin key. While the timelock is its own admin these are
\* only reachable through scheduled self-calls, never as bare keys.
TLAdminKey(k) == admin[TL] = k /\ k \in Actors

\* set_roles(...): admin-instant.
SetRoles(k, p, c) ==
    /\ AllowTimelock /\ TLAdminKey(k)
    /\ p \in Keys /\ c \in Keys
    /\ roles' = [roles EXCEPT !.proposer = p, !.canceller = c]
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, wiring, pendingWiring,
                    pwAt, defaultDelay, ovr, nextId, ops, cancelled, viol, lastStack,
                    lastResult >>

\* set_delay(target, fn, Some(d) | None): admin-instant; can lower an override.
SetDelay(k, d) ==
    /\ AllowTimelock /\ TLAdminKey(k)
    /\ d \in 0..MaxDelay /\ d /= ovr
    /\ ovr' = d
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, wiring, pendingWiring,
                    pwAt, roles, defaultDelay, nextId, ops, cancelled, viol,
                    lastStack, lastResult >>

\* set_default_delay(lower): admin-instant. Raising needs a scheduled self-call.
LowerDefaultDelay(k, d) ==
    /\ AllowTimelock /\ TLAdminKey(k)
    /\ d \in MinDelay..MaxDelay /\ d < defaultDelay
    /\ defaultDelay' = d
    /\ UNCHANGED << now, admin, pending, pendingExp, pendingBy, wiring, pendingWiring,
                    pwAt, roles, ovr, nextId, ops, cancelled, viol, lastStack,
                    lastResult >>

\* A tick that passes while the watchdog holds the canceller role gives it the
\* opportunity to see (and cancel) every operation pending at that moment.
Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ ops' = [i \in 1..MaxOps |->
                  IF ops[i] = NoOp THEN NoOp
                  ELSE [ops[i] EXCEPT !.seen = ops[i].seen \/ roles.canceller = Watchdog]]
    /\ UNCHANGED << admin, pending, pendingExp, pendingBy, wiring, pendingWiring, pwAt,
                    roles, defaultDelay, ovr, nextId, cancelled, viol,
                    lastStack, lastResult >>

Next ==
    \/ \E c \in AdminContracts, k \in Keys, n \in Principals : ProposeAdmin(c, k, n)
    \/ \E c \in AdminContracts, k \in Keys : AcceptAdmin(c, k)
    \/ \E c \in AdminContracts, k \in Keys : CancelAdmin(c, k)
    \/ \E r \in WRoles, p \in Peers, k \in Keys : ProposeWiring(r, p, k)
    \/ \E p \in Peers, r \in WRoles, k \in Keys : PeerAccept(p, r, k)
    \/ \E k \in Keys, fn \in SchedFns : \E a \in ArgDomain(fn) : Schedule(k, fn, a)
    \/ \E i \in 1..MaxOps, k \in Keys : Execute(i, k)
    \/ \E i \in 1..MaxOps, k \in Keys : Cancel(i, k)
    \/ \E k \in Keys, t \in {Core, Res, Tre, Other}, fn \in EmFns : Emergency(k, t, fn)
    \/ \E k \in Keys, p \in Keys, c \in Keys : SetRoles(k, p, c)
    \/ \E k \in Keys, d \in 0..MaxDelay : SetDelay(k, d)
    \/ \E k \in Keys, d \in MinDelay..MaxDelay : LowerDefaultDelay(k, d)
    \/ Tick

\* Liveness: weak fairness on the honest, state-changing actions only. The
\* attacker's actions (anything by a compromised key) are never fair.
HonestProgress ==
    /\ \A p \in Peers, r \in WRoles :
         WF_vars(\E k \in Keys : PeerAccept(p, r, k))
    /\ WF_vars(Tick)

Spec     == Init /\ [][Next]_vars
LiveSpec == Spec /\ HonestProgress

(***************************************************************************)
(* Properties. Each predicate judges one audit record; the corresponding   *)
(* invariant says "no action ever produced a record it rejects".           *)
(***************************************************************************)

\* ---- two-step admin transfer ----

\* admin changes only through AcceptAdmin, by the address the then-admin
\* proposed, authorised by that address.
NoUnauthorisedAdminChange == ~viol["adminUnauth"]

\* ADR 0007: a proposal is inert once `expires_at <= now`, i.e. an accept needs
\* now < proposedAt + TTL. Expected to FAIL against the code (accept at ==).
NoExpiredAccept == ~viol["adminExpired"]

\* ---- authenticated wiring ----

\* wiring[role] changes only to a peer wired to this market-core that itself
\* initiated the accept.
NoWiringToUnconsentingPeer == ~viol["wiringUnconsenting"]

\* An honest proposal followed by the peer's accept eventually updates wiring.
\* Expected to FAIL under Callback (re-entry), hold under PeerAsserts.
WiringLiveness ==
    [](pendingWiring["resolver"] = Res => <>(wiring["resolver"] = Res))

\* Witness: a proposal made long ago can still be accepted (no expiry). Expected
\* to FAIL in PeerAsserts mode, where acceptance is reachable at all.
StalePendingWiring == ~viol["wiringStale"]

\* ---- timelock ----

NoExecuteBeforeEta       == ~viol["execEarly"]
NoExecuteAfterExpiry     == ~viol["execLate"]

\* a cancelled id never executes
CancelWinsBeforeExecute  == ~viol["execCancelled"]

EmergencyAllowListOnly   == ~viol["emergOutsideAllow"]

\* No single compromised key can change a core contract's configuration
\* without (a) at least MinDelay passing between schedule and execute and
\* (b) the honest watchdog holding the canceller role for a tick in between
\* (so it could cancel). `Actors` is the compromised key; WatchdogVigilant says
\* the watchdog uses that opportunity on everything the compromised key
\* schedules, so a role change the watchdog itself could have cancelled never
\* lands. The residual trust is exactly this: the watchdog stays honest,
\* online, and holds the canceller role.
NoInstantPowerFromSingleKey == ~viol["cfgUnsafe"]

=============================================================================

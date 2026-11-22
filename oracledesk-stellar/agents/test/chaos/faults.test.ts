import assert from "node:assert/strict";
import test from "node:test";
import { FaultPlan } from "../fake-rpc/faults.js";

test("scripted rules fire on the nth matching request for `times` requests", () => {
  const plan = FaultPlan.script([{ method: "sendTransaction", fn: "agent_buy_v2", nth: 2, times: 2, fault: { kind: "try-again-later" } }]);
  const kinds = [1, 2, 3, 4].map(() => plan.next("sendTransaction", "agent_buy_v2").map((f) => f.kind));
  assert.deepEqual(kinds, [[], ["try-again-later"], ["try-again-later"], []]);
  assert.deepEqual(plan.next("sendTransaction", "publish_trace"), [], "other functions do not match");
  assert.equal(plan.history.length, 2);
});

test("a chaos plan is a pure function of its seed and the request sequence", () => {
  const draw = (seed: bigint) => {
    const plan = FaultPlan.chaos(seed, { rate: 0.5 });
    for (let i = 0; i < 200; i++) plan.next(i % 2 ? "sendTransaction" : "simulateTransaction");
    return plan.history.map((f) => `${f.seq}:${f.fault.kind}`);
  };
  assert.deepEqual(draw(42n), draw(42n));
  assert.notDeepEqual(draw(42n), draw(43n));
  const n = draw(42n).length;
  assert.ok(n > 50 && n < 150, `rate 0.5 over 200 requests drew ${n} faults`);
});

test("chaos only touches the methods it is given", () => {
  const plan = FaultPlan.chaos(1n, { rate: 1, methods: ["getTransaction"] });
  assert.deepEqual(plan.next("sendTransaction"), []);
  assert.equal(plan.next("getTransaction").length, 1);
});

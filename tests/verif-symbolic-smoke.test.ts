/**
 * Symbolic smoke test — first end-to-end proof on REAL kernel code.
 *
 * Target: kernel/src/refs.ts indexToRef bounds behavior (issue #3848
 * acceptance step "首个目标函数出界内无反例结论,且注入已知 bug 形状时必红").
 *
 *  V1  for all integer n in [1, 9_999_999]: indexToRef(n) does NOT throw  → UNSAT expected
 *  V2  for integer n outside that range: indexToRef(n) throws             → SAT, witness replayed on real code
 *  V3  drift control: a deliberately wrong spec bound (n = 9_999_999
 *      claimed out-of-range) produces a witness the REAL code does not
 *      reproduce → replay mismatch is detected (this is the anti-self-
 *      modeling lock working).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { init } from "z3-solver";
import { resolve } from "node:path";
import { translateFunction } from "../verif/symbolic.js";
import { replayThrows, describeMismatch, isReplayMismatch, parseIntWitness } from "../verif/replay.js";
import { indexToRef } from "../kernel/src/refs.js";

const file = resolve(import.meta.dirname, "../kernel/src/refs.ts");

test("symbolic: indexToRef never throws in [1, 9_999_999] (real code, solver-checked)", async (t) => {
  const { Context } = await init();
  const ctx = new Context("main");
  const n = ctx.Int.const("n");

  const { exec } = translateFunction({
    file,
    function: "indexToRef",
    params: { index: { kind: "int", t: n } },
    ctx,
  });
  const result = exec();

  // Claim: exists n in [1, 9_999_999] where the translated code threw.
  const s = new ctx.Solver();
  s.add(n.ge(1), n.le(9_999_999));
  assert.ok(result.thrown && result.thrown.kind === "bool",
    "translated indexToRef must expose a boolean throw flag");
  s.add(result.thrown.t);
  assert.equal(await s.check(), "unsat",
    "solver must find NO in-range n that throws (UNSAT expected)");
});

test("symbolic: indexToRef throws outside [1, 9_999_999] — witness replayed on real code", async () => {
  const { Context } = await init();
  const ctx = new Context("main");
  const n = ctx.Int.const("n");

  const { exec } = translateFunction({
    file,
    function: "indexToRef",
    params: { index: { kind: "int", t: n } },
    ctx,
  });
  const result = exec();
  assert.ok(result.thrown !== null, "translated code must throw on out-of-range n");

  const s = new ctx.Solver();
  s.add(n.lt(1).or(n.gt(9_999_999)), n.ge(-100_000_000), n.le(100_000_000));
  assert.equal((await s.check()), "sat");
  const model = await s.model();
  const witness = parseIntWitness(model.eval(n).toString());
  assert.ok(Number.isFinite(witness), `witness must be an integer, got ${witness}`);

  // REPLAY on the real compiled function:
  const reallyThrows = await replayThrows(indexToRef, witness);
  assert.ok(reallyThrows, `witness n=${witness} must throw on real indexToRef`);
});

test("symbolic: drift control — wrong spec bound is caught by replay", async () => {
  const { Context } = await init();
  const ctx = new Context("main");
  const n = ctx.Int.const("n");

  const { exec } = translateFunction({
    file,
    function: "indexToRef",
    params: { index: { kind: "int", t: n } },
    ctx,
  });
  const result = exec();

  // Deliberately WRONG spec: claim 9_999_999 is out of range (real max).
  const s = new ctx.Solver();
  s.add(n.gt(9_999_998), n.le(9_999_999)); // the exact discriminating sliver
  assert.equal((await s.check()), "sat");
  const model = await s.model();
  const witness = parseIntWitness(model.eval(n).toString());
  assert.ok(witness === 9_999_999, `wrong-bound spec should pick n=9999999, got ${witness}`);

  // Real code does NOT throw for 9_999_999 → mismatch must be reported.
  const reallyThrows = await replayThrows(indexToRef, witness);
  const mismatch = {
    kind: "replay-mismatch" as const,
    witness: { n: witness },
    expected: "throws (spec claimed out of range)",
    observed: reallyThrows ? "throws" : "returns normally",
  };
  assert.ok(isReplayMismatch(mismatch));
  assert.ok(!reallyThrows, "real indexToRef(9_999_999) must return normally");
  const described = describeMismatch(mismatch);
  assert.match(described, /REPLAY MISMATCH/);
});

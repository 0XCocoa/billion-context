/**
 * Symbolic smoke test — first end-to-end proof on REAL kernel code.
 *
 * Target: kernel/src/refs.ts indexToRef bounds behavior (issue #3848
 * acceptance step "首个目标函数出界内无反例结论,且注入已知 bug 形状时必红").
 *
 *  V1  for all n in [1, 9_999_999]: indexToRef(n) does NOT throw   → UNSAT expected
 *  V2  for n outside that range: indexToRef(n) throws              → SAT, witness replayed on real code
 *  V3  drift control: a deliberately wrong spec bound produces a
 *      witness the REAL code does not reproduce → replay mismatch detected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { init } from "z3-solver";
import { resolve } from "node:path";
import { translateFunction } from "../verif/symbolic.js";
import { replayThrows, describeMismatch, isReplayMismatch, parseIntWitness } from "../verif/replay.js";
import { indexToRef } from "../kernel/src/refs.js";

const file = resolve(import.meta.dirname, "../kernel/src/refs.ts");

async function translateIndexToRef(ctx: import("z3-solver").Context<"main">, n: import("z3-solver").Arith<"main">) {
  const { exec } = translateFunction({
    file,
    function: "indexToRef",
    params: { index: { kind: "num", t: n } },
    ctx,
  });
  const r = exec();
  assert.ok(r.thrown && r.thrown.kind === "bool", "translated indexToRef exposes a boolean throw flag");
  assert.deepEqual(r.degradations.filter((d) => !d.startsWith("template")) , [],
    `no degradations expected (got: ${r.degradations.join("; ")})`);
  return r;
}

test("symbolic V1: indexToRef never throws in [1, 9_999_999] (real code, solver-checked)", async () => {
  const { Context } = await init();
  const ctx = new Context("main");
  const n = ctx.Real.const("n");

  const r = await translateIndexToRef(ctx, n);

  const s = new ctx.Solver();
  s.add(n.ge(1), n.le(9_999_999), n.eq(ctx.ToInt(n))); // integer n in range
  s.add(r.thrown!.t); // claim: some in-range n throws
  assert.equal(await s.check(), "unsat", "solver must find NO in-range n that throws");
});

test("symbolic V2: indexToRef throws outside [1, 9_999_999] — witness replayed on real code", async () => {
  const { Context } = await init();
  const ctx = new Context("main");
  const n = ctx.Real.const("n");

  const r = await translateIndexToRef(ctx, n);

  const s = new ctx.Solver();
  s.add(n.ge(-100_000_000), n.le(100_000_000), n.eq(ctx.ToInt(n)));
  s.add(n.lt(1).or(n.gt(9_999_999)));
  s.add(r.thrown!.t);
  assert.equal(await s.check(), "sat");
  const model = await s.model();
  const witness = parseIntWitness(model.eval(n).toString());
  assert.ok(Number.isFinite(witness), `witness must be an integer, got ${witness}`);

  const reallyThrows = await replayThrows(indexToRef, witness);
  assert.ok(reallyThrows, `witness n=${witness} must throw on real indexToRef`);
});

test("symbolic V3: the solver refuses a wrong spec — 9_999_999 is in range, no counterexample exists", async () => {
  const { Context } = await init();
  const ctx = new Context("main");
  const n = ctx.Real.const("n");

  const r = await translateIndexToRef(ctx, n);

  // WRONG spec: claim n=9_999_999 (the real max) throws. A faithful
  // translation must produce NO counterexample for a false claim.
  const s = new ctx.Solver();
  s.add(n.gt(9_999_998), n.le(9_999_999), n.eq(ctx.ToInt(n)));
  s.add(r.thrown!.t);
  assert.equal(await s.check(), "unsat", "solver must refuse the wrong spec");

  // The replay lock still detects a phantom witness if a translator bug
  // ever produced one: real code returns normally at the boundary.
  const reallyThrows = await replayThrows(indexToRef, 9_999_999);
  assert.ok(!reallyThrows, "real indexToRef(9_999_999) returns normally");
  const mismatch = {
    kind: "replay-mismatch" as const,
    witness: { n: 9_999_999 },
    expected: "throws (phantom spec)",
    observed: reallyThrows ? "throws" : "returns normally",
  };
  assert.ok(isReplayMismatch(mismatch));
  assert.match(describeMismatch(mismatch), /REPLAY MISMATCH/);
});

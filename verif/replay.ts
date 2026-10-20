/**
 * Counterexample replay — the anti-drift lock of the verification pipeline.
 *
 * A solver witness is only a FINDING if the real compiled kernel code
 * reproduces it. If the translated model and the real code disagree, the
 * replay fails and the translator is wrong — that failure is the signal,
 * never "verification passed anyway".
 */
import type { SymVal } from "./symbolic.js";

export interface ReplayMismatch {
  kind: "replay-mismatch";
  witness: Record<string, unknown>;
  expected: string;
  observed: string;
}

export function isReplayMismatch(x: unknown): x is ReplayMismatch {
  return typeof x === "object" && x !== null && (x as ReplayMismatch).kind === "replay-mismatch";
}

/** Parse z3's s-expression numeric output: "5", "(- 5808901)", "96.0",
 *  "10000000.0", "(/ 1 3)". Reals that are not integral return NaN — the
 *  caller must constrain the witness variable to integers. */
export function parseIntWitness(raw: string): number {
  const t = raw.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  // Real numerals print with a decimal tail ("96.0", "-3.0")
  const real = /^(-?\d+)\.0+$/.exec(t);
  if (real) return Number(real[1]);
  const m = /^\(\s*(-|\+)\s+(\d+)\)$/.exec(t);
  if (m) return m[1] === "-" ? -Number(m[2]) : Number(m[2]);
  return Number.NaN;
}

/** Extract a concrete witness value from a solver model for one variable. */
export function witnessValue(
  model: { eval: (v: never) => { toString(): string } },
  v: never,
  kind: SymVal["kind"] | "int",
): number | string | boolean {
  const s = model.eval(v).toString();
  if (kind === "num" || kind === "int") return parseIntWitness(s);
  if (kind === "bool") return s === "true";
  return s;
}

export async function replayThrows(
  fn: (x: number) => unknown,
  arg: number,
): Promise<boolean> {
  try {
    fn(arg);
    return false;
  } catch {
    return true;
  }
}

export function describeMismatch(m: ReplayMismatch): string {
  return (
    `REPLAY MISMATCH — translator drift or spec error. witness=${JSON.stringify(m.witness)} ` +
    `expected=${m.expected} observed=${m.observed}. ` +
    `The solver model and the real code disagree; fix the translator or the spec.`
  );
}

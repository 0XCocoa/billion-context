/**
 * verif symbolic executor — v2.
 *
 * Translates REAL TypeScript function bodies (from the guarded kernel files)
 * into z3 constraints. The code under verification is the actual source;
 * this file is only the lens. The replay lock (verif/replay.ts + smoke
 * tests) catches any lens distortion.
 *
 * Value model (modeling decisions, all documented in verif/README.md):
 *  - numbers   → z3 Real (exact rationals ≈ JS doubles; boundary divergence
 *                is caught by replay)
 *  - booleans  → z3 Bool
 *  - strings   → z3 Seq (string theory)
 *  - arrays    → bounded slot vectors: { elems: SymVal[N], len: Real }
 *                with N = maxArrayLength (unrolled combinators, push via
 *                ITE store). Sound for found counterexamples; absence
 *                claims hold within the bound only.
 *  - objects   → structural field maps { fields: Map<string, SymVal> }
 *  - unknown/degraded constructs → { kind: "any" } (never silently
 *                trustworthy: harnesses receive the degradation list)
 *
 * Execution model: single-assignment environment; if/else via ITE value
 * merge (no path enumeration); loops unrolled up to K iterations with
 * termination assumptions collected for the solver.
 *
 * Function calls: local functions in the same file are INLINED (depth
 * capped) so harnesses exercise the real helper chain. Calls that cannot
 * be translated degrade to `any`.
 */
import ts from "typescript";
import { readFileSync, accessSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Arith, Bool, Seq, Context } from "z3-solver";

export class TranslationUnsupported extends Error {
  constructor(readonly what: string, readonly file: string, readonly line: number) {
    super(`translation unsupported at ${file}:${line}: ${what}`);
  }
}

export type Z3 = Context<"main">;
export type Num = Arith<"main">;
export type Str = Seq<"main">;

export type SymVal =
  | { kind: "num"; t: Num }
  | { kind: "bool"; t: Bool<"main"> }
  | { kind: "str"; t: Str }
  | { kind: "arr"; elems: SymVal[]; len: Num }
  | { kind: "obj"; fields: Map<string, SymVal> }
  | { kind: "fn"; node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration; env: Frame }
  | { kind: "null" }
  | { kind: "undef" }
  | { kind: "any" };

export interface ExecOut {
  ret: SymVal | null;
  thrown: { kind: "bool"; t: Bool<"main"> } | null;
  /** Solver must receive these for absence claims: unrolled loops that had
   *  not terminated within K iterations produce a completion assumption. */
  assumptions: Bool<"main">[];
  /** Every construct degraded to `any` — harness reports these; a property
   *  whose counterexample depends on an `any` hole is NOT a finding. */
  degradations: string[];
}

export interface InterpreterOptions {
  maxArrayLength?: number; // default 8
  maxLoopIterations?: number; // default 8
  maxInlineDepth?: number; // default 12
  /** Implementations for INJECTED PORTS (public parameter seams like
   *  CompressionCore's `countTokens`). When a call resolves to a parameter
   *  with a port implementation, the hook runs instead of degrading. Ports
   *  are part of the module's public contract — hosts inject their own
   *  token counters — so this is composition, not bug-specific modeling. */
  portImpls?: Record<string, (arg: SymVal) => SymVal>;
}

/* ------------------------------------------------------------------ helpers */

const num = (ctx: Z3, v: number): Num => {
  const t = ctx.Real.val(v);
  numConst.set(t, v);
  return t;
};
let numHoleCounter = 0;

const bool = (ctx: Z3, v: boolean): Bool<"main"> => {
  const t = ctx.Bool.val(v);
  boolConst.set(t, v);
  return t;
};

/** Constant side-channels: z3 expr objects created from JS constants are
 *  tagged so arithmetic/comparisons fold at construction time instead of
 *  bloating the symbolic DAG with trivially-decidable subterms. */
const numConst = new WeakMap<Num, number>();
const strConst = new WeakMap<Str, string>();
const boolConst = new WeakMap<Bool<"main">, boolean>();
const strc = (ctx: Z3, sv: string): Str => {
  const t = ctx.String.val(sv);
  strConst.set(t, sv);
  return t;
};
/** Foldable numeric equality: constant arguments decide immediately. */
const numEq = (ctx: Z3, a: Num, b: Num): Bool<"main"> => {
  const ac = numC(a), bc = numC(b);
  if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
  return a.eq(b);
};

/** Numeric constant lookup with structural fallback: constants created by
 *  harness code via raw ctx.Real.val(n) are recognized by their printed
 *  form so constant folding still applies to them. */
const numC = (t: Num): number | undefined => {
  const hit = numConst.get(t);
  if (hit !== undefined) return hit;
  const str = t.toString();
  if (/^-?\d+\.0+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  if (/^-?\d+\.\d+$/.test(str)) {
    const f = parseFloat(str);
    if (Number.isFinite(f)) return f;
  }
  return undefined;
};

function isNum(v: SymVal | undefined): v is { kind: "num"; t: Num } {
  return v !== undefined && v.kind === "num";
}
function isBool(v: SymVal | undefined): v is { kind: "bool"; t: Bool<"main"> } {
  return v !== undefined && v.kind === "bool";
}
function isStr(v: SymVal | undefined): v is { kind: "str"; t: Str } {
  return v !== undefined && v.kind === "str";
}
function isArr(v: SymVal | undefined): v is Extract<SymVal, { kind: "arr" }> {
  return v !== undefined && v.kind === "arr";
}
function isObj(v: SymVal | undefined): v is Extract<SymVal, { kind: "obj" }> {
  return v !== undefined && v.kind === "obj";
}

/** Truthiness of a symbolic value as a boolean expr (JS coercion rules for
 *  the subset: numbers nonzero, strings nonempty, null/undef false). */
function truthy(ctx: Z3, v: SymVal): Bool<"main"> | null {
  switch (v.kind) {
    case "bool": return v.t;
    case "num": {
      const c = numC(v.t);
      if (c !== undefined) return bool(ctx, c !== 0);
      return v.t.neq(num(ctx, 0));
    }
    case "str": {
      const sv = strConst.get(v.t);
      if (sv !== undefined) return bool(ctx, sv.length > 0);
      return (ctx.ToReal(v.t.length() as never) as Num).neq(num(ctx, 0));
    }
    case "null":
    case "undef": return bool(ctx, false);
    case "arr": return bool(ctx, true); // arrays are always truthy
    case "obj": return bool(ctx, true);
    default: return null;
  }
}

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  if (n === 1) return [[0]];
  const out: number[][] = [];
  const rest = permutations(n - 1);
  for (const p of rest) {
    for (let i = 0; i <= p.length; i++) {
      out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ program */

interface ModuleInfo {
  numbers: Map<string, number>;
  strings: Map<string, string>;
  functions: Map<string, ts.FunctionDeclaration>;
  constArrowFns: Map<string, ts.Expression>;
  constBindings: Map<string, ts.Expression>;
  /** exported names (functions, const arrows, consts) for import resolution */
  exports: Set<string>;
  /** export-from re-exports: export {x} from "./y.js" */
  reexports: Map<string, string>;
}

/** Resolve relative imports of a file recursively and collect exported
 *  callables/consts into a global registry (kernel files import helpers
 *  across files: truncate-tools → truncate/prune/ccr, hide-consumed → refs). */
function loadImportGraph(entry: string): Map<string, ModuleInfo> {
  const modules = new Map<string, ModuleInfo>();
  const queue: string[] = [entry];
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { sf: entrySf, info } = loadModule(file);
    modules.set(file, info);
    for (const stmt of entrySf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // node/external: not symbolized
      const resolved = resolveTsPath(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return modules;
}

function resolveTsPath(fromFile: string, spec: string): string | null {
  const path = join(dirname(fromFile), spec.replace(/\.js$/, ".ts"));
  try {
    accessSync(path);
    return path;
  } catch {
    return null;
  }
}

function loadModule(file: string): { sf: ts.SourceFile; info: ModuleInfo } {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const info: ModuleInfo = {
    numbers: new Map(),
    strings: new Map(),
    functions: new Map(),
    constArrowFns: new Map(),
    constBindings: new Map(),
    exports: new Set(),
    reexports: new Map(),
  };
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      info.functions.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const i = node.initializer;
      if (ts.isNumericLiteral(i)) info.numbers.set(node.name.text, Number(i.text));
      else if (ts.isStringLiteral(i)) info.strings.set(node.name.text, i.text);
      else if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) info.constArrowFns.set(node.name.text, i);
      else info.constBindings.set(node.name.text, i);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  const walkExports = (node: ts.Node): void => {
    const hasExportMod = (n: ts.Node): boolean =>
      !!((n as ts.FunctionDeclaration).modifiers ?? []).some(
        (m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
    if (ts.isFunctionDeclaration(node) && node.name && hasExportMod(node)) {
      info.exports.add(node.name.text);
    }
    if (ts.isVariableStatement(node) && hasExportMod(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) info.exports.add(d.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) info.exports.add(el.name.text);
    }
    ts.forEachChild(node, walkExports);
  };
  walkExports(sf);
  return { sf, info };
}

/* ---------------------------------------------------------------- interpreter */

interface Frame {
  vars: Map<string, SymVal>;
}

interface RunState {
  ret: SymVal | null;
  /** conditional returns: function returns `val` when `cond` — following
   *  statements still execute (they produce the not-cond path's value) */
  pendingRets: { cond: Bool<"main">; val: SymVal }[];
  /** hard unconditional return (dead code after `return`) */
  hardRet: boolean;
  thrown: Bool<"main"> | null;
  assumptions: Bool<"main">[];
  degradations: string[];
  breakCond: Bool<"main"> | null;
  continueCond: Bool<"main"> | null;
}

export interface TranslateInput {
  file: string;
  function: string;
  params: Record<string, SymVal>;
  ctx: Z3;
  options?: InterpreterOptions;
}

export function translateFunction(input: TranslateInput): { exec: () => ExecOut } {
  const { file, function: fnName, params, ctx } = input;

  /** z3 Seq.length() is Int-sorted; our numeric arithmetic is Real. */
  const lenR = (seq: Seq<"main">): Num => ctx.ToReal(seq.length() as never) as Num;
  const N = input.options?.maxArrayLength ?? 8;
  const K = input.options?.maxLoopIterations ?? 8;
  const MAXINLINE = input.options?.maxInlineDepth ?? 12;
  const modules = loadImportGraph(file);
  const info = modules.get(file)!;
  const sf = loadModule(file).sf;
  // identifier → definition in an imported module ("./x.js" exports)
  const importedSymbols = new Map<string, { file: string; info: ModuleInfo }>();
  {
    const entrySf = loadModule(file).sf;
    for (const stmt of entrySf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const resolved = resolveTsPath(file, spec);
      if (!resolved) continue;
      const target = modules.get(resolved);
      if (!target) continue;
      const named = stmt.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) importedSymbols.set(el.name.text, { file: resolved, info: target });
      }
    }
  }

  /** Module whose file's functions we are currently executing (for cross-file inlining).
 *  Top of stack = defining module; entry module is the base. */
  const moduleStack: ModuleInfo[] = [info];
  const curInfo = (): ModuleInfo => moduleStack[moduleStack.length - 1] ?? info;
  const portMemo = new Map<string, SymVal>();

  let numStrCounter = 0;
  /** String(number): an uninterpreted decimal string; only its length matters
   * for stability properties (1..19 digits) and the replay lock validates the
   * witness against the real code. */
  const numToStringStr = (st: RunState): { kind: "str"; t: Str } => {
    const hole = ctx.String.const("__numstr_" + numStrCounter++);
    st.assumptions.push((ctx.ToReal(hole.length() as never) as Num).ge(num(ctx, 1)).and((ctx.ToReal(hole.length() as never) as Num).le(num(ctx, 19))));
    return { kind: "str", t: hole };
  };

  const decl = info.functions.get(fnName);
  if (!decl?.body) throw new Error(`function ${fnName} not found in ${file}`);

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const bad = (node: ts.Node, what: string): never => {
    throw new TranslationUnsupported(what, file, lineOf(node));
  };

  /* ---------------- value constructors ---------------- */

  const arrOf = (elems: SymVal[], len?: Num): Extract<SymVal, { kind: "arr" }> =>
    ({ kind: "arr", elems, len: len ?? num(ctx, elems.length) });

  const mergeVal = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    // undef/null loses to any concrete value: out-of-bounds fallbacks in
    // element-access chains (guarded by length checks in real code) must not
    // poison the merged object. Real out-of-range access throws and is caught
    // by the replay lock.
    if (a.kind === "undef" && b.kind !== "undef") return mergeVal(cond.not(), b, { kind: "undef" }) === null ? { kind: "any" } : b;
    if (b.kind === "undef" && a.kind !== "undef") return a;
    if (a.kind === "null" && b.kind !== "null") return b;
    if (b.kind === "null" && a.kind !== "null") return a;
    if (a.kind !== b.kind) return { kind: "any" };
    switch (a.kind) {
      case "num": {
        const bb = b as Extract<SymVal, { kind: "num" }>;
        const ac = numC(a.t), bc = numC(bb.t);
        if (ac !== undefined && ac === bc) return a; // same constant: no ITE
        return { kind: "num", t: ctx.If(cond, a.t, bb.t) };
      }
      case "bool": return { kind: "bool", t: ctx.If(cond, a.t, (b as Extract<SymVal, { kind: "bool" }>).t) };
      case "str": {
        const bb = b as Extract<SymVal, { kind: "str" }>;
        const ac = strConst.get(a.t), bc = strConst.get(bb.t);
        if (ac !== undefined && ac === bc) return a;
        return { kind: "str", t: ctx.If(cond, a.t, bb.t) };
      }
      case "null": case "undef": return a;
      case "fn": return a; // closures are immutable; identical node survives
      case "arr": {
        const bb = b as Extract<SymVal, { kind: "arr" }>;
        const n = Math.max(a.elems.length, bb.elems.length);
        const elems: SymVal[] = [];
        for (let i = 0; i < n; i++) {
          // missing slots merge as undef (undef loses to concrete values in
          // mergeVal) so growing arrays keep their element structure
          elems.push(mergeVal(cond, a.elems[i] ?? { kind: "undef" }, bb.elems[i] ?? { kind: "undef" }));
        }
        return { kind: "arr", elems, len: ctx.If(cond, a.len, bb.len) };
      }
      case "obj": {
        const bb = b as Extract<SymVal, { kind: "obj" }>;
        const fields = new Map<string, SymVal>();
        for (const key of new Set([...a.fields.keys(), ...bb.fields.keys()])) {
          const va = a.fields.get(key);
          const vb = bb.fields.get(key);
          if (va && vb) fields.set(key, mergeVal(cond, va, vb));
          else if (va) fields.set(key, va);
          else if (vb) fields.set(key, vb);
        }
        return { kind: "obj", fields };
      }
      default: return { kind: "any" };
    }
  };

  const iteVal = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    if (a === b) return a;
    const cs = cond.toString();
    if (cs === "true") return a;
    if (cs === "false") return b;
    return mergeVal(cond, a, b);
  };

  /** JS ?: on symbolic values. */
  const jsOr = (a: SymVal, b: () => SymVal): SymVal => {
    const t = truthy(ctx, a);
    if (t === null) return { kind: "any" };
    const av = a;
    const bv = b();
    // (a || b): if a truthy → a else b
    return iteVal(t, av.kind === "bool" ? { kind: "bool", t: t } : av, bv);
  };
  const jsAnd = (a: SymVal, b: () => SymVal): SymVal => {
    const t = truthy(ctx, a);
    if (t === null) return { kind: "any" };
    return iteVal(t, b(), a.kind === "bool" ? { kind: "bool", t: t } : a);
  };
  /** Constant-folding Boolean combinators: z3's .or/.and do NOT simplify
   * `(or false false)` to `false`, and control-flow checks compare the
   * printed form against "true"/"false" — so every control Bool must be
   * built through these to keep literal chains folded. */
  const orFold = (a: Bool<"main">, b: Bool<"main">): Bool<"main"> => {
    const ab = boolConst.get(a), bb = boolConst.get(b);
    if (ab === true || bb === true) return bool(ctx, true);
    if (ab === false) return b;
    if (bb === false) return a;
    return a.or(b);
  };
  const andFold = (a: Bool<"main">, b: Bool<"main">): Bool<"main"> => {
    const ab = boolConst.get(a), bb = boolConst.get(b);
    if (ab === false || bb === false) return bool(ctx, false);
    if (ab === true) return b;
    if (bb === true) return a;
    return a.and(b);
  };
  const notFold = (a: Bool<"main">): Bool<"main"> => {
    const ab = boolConst.get(a);
    if (ab === true) return bool(ctx, false);
    if (ab === false) return bool(ctx, true);
    return a.not();
  };

  const jsNullish = (a: SymVal, b: () => SymVal): SymVal =>
    iteVal(a.kind === "null" || a.kind === "undef" ? bool(ctx, true) : bool(ctx, false), b(), a);

  /* ---------------- statements ---------------- */

  const runState0 = (): RunState => ({
    ret: null, pendingRets: [], hardRet: false, thrown: null,
    assumptions: [], degradations: [],
    breakCond: null, continueCond: null,
  });

  interface Scope {
    frame: Frame;
    depth: number;
  }

  /** Sequential statement execution with conditional stop semantics:
   * after a possibly-taken break/continue, the REMAINING statements run on a
   * copy under ¬stop — recursively, so nested stops (break-if followed by
   * continue-if in the same block) guard correctly. */
  const execSeq = (stmts: readonly ts.Statement[], frame: Frame, st: RunState, depth: number): void => {
    for (let i = 0; i < stmts.length; i++) {
      execStmt(stmts[i]!, frame, st, depth);
      const bc = st.breakCond;
      const cc = st.continueCond;
      const bcT = bc !== null && bc.toString() !== "false";
      const ccT = cc !== null && cc.toString() !== "false";
      if (bcT || ccT) {
        const stopCond = bc && cc ? orFold(bc as Bool<"main">, cc as Bool<"main">) : ((bc ?? cc) as Bool<"main">);
        if (i + 1 < stmts.length && stopCond.toString() !== "true") {
          const f2: Frame = { vars: new Map(frame.vars) };
          const s2: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
          execSeq(stmts.slice(i + 1), f2, s2, depth);
          mergeBranch(frame, st, notFold(stopCond), f2, s2, null, null);
        }
        break;
      }
      if (st.hardRet) break;
      if (st.thrown !== null && st.thrown.toString() === "true") break;
    }
  };

  const execStmt = (stmt: ts.Statement, frame: Frame, st: RunState, depth: number): void => {
    if (st.hardRet) return;
    if (st.thrown !== null && st.thrown.toString() === "true") return;
    if (st.breakCond !== null && st.breakCond.toString() === "true") return;
    if (st.continueCond !== null && st.continueCond.toString() === "true") return;
    if (ts.isBlock(stmt)) { execSeq(stmt.statements, frame, st, depth); return; }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) { bad(stmt, "non-identifier declaration"); continue; }
        const name = d.name.text;
        const init = d.initializer ? evalExpr(d.initializer, frame, st, depth) : { kind: "undef" as const };
        frame.vars.set(name, init);
      }
      return;
    }
    if (ts.isExpressionStatement(stmt)) {
      evalExpr(stmt.expression, frame, st, depth);
      return;
    }
    if (ts.isReturnStatement(stmt)) {
      if (st.ret === null) {
        st.ret = stmt.expression ? evalExpr(stmt.expression, frame, st, depth) : { kind: "undef" };
        st.hardRet = true;
      } else {
        // a pending conditional return already captured the tail; a second
        // return can only be reached on the not-cond path
        st.pendingRets.push({ cond: bool(ctx, false), val: stmt.expression ? evalExpr(stmt.expression, frame, st, depth) : { kind: "undef" } });
        st.hardRet = true;
      }
      return;
    }
    if (ts.isThrowStatement(stmt)) {
      // The thrown value itself never matters — only the fact.
      st.thrown = bool(ctx, true);
      return;
    }
    if (ts.isIfStatement(stmt)) {
      const c = evalExpr(stmt.expression, frame, st, depth);
      const tb = truthy(ctx, c);
      if (tb === null) { degrade(st, stmt, "if condition degraded"); return; }
      const thenFrame: Frame = { vars: new Map(frame.vars) };
      const thenState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
      execStmt(stmt.thenStatement, thenFrame, thenState, depth);
      let elseFrame: Frame | null = null;
      let elseState: RunState | null = null;
      if (stmt.elseStatement) {
        elseFrame = { vars: new Map(frame.vars) };
        elseState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
        execStmt(stmt.elseStatement, elseFrame, elseState, depth);
      }
      mergeBranch(frame, st, tb, thenFrame, thenState, elseFrame, elseState);
      return;
    }
    if (ts.isForOfStatement(stmt)) {
      // Unroll over bounded array slots.
      const iter = evalExpr(stmt.expression, frame, st, depth);
      if (!isArr(iter)) { degrade(st, stmt, "for-of over non-array"); return; }
      bindForVar(stmt.initializer, { kind: "undef" }, frame);
      // Dead-slot pruning: when the array length is a KNOWN constant, skip
      // slots beyond it entirely — executing dead iterations would pollute
      // live state with out-of-bounds degradations and any-values.
      const lenC = numC(iter.len);
      const slotCeil = lenC !== undefined ? Math.min(iter.elems.length, Math.ceil(lenC)) : iter.elems.length;
      for (let k = 0; k < slotCeil; k++) {
        const guard = andFold(iter.len.gt(num(ctx, k)), st.breakCond ?? bool(ctx, true));
        const elemFrame: Frame = { vars: new Map(frame.vars) };
        const elemState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
        bindForVar(stmt.initializer, iter.elems[k], elemFrame);
        execStmt(stmt.statement, elemFrame, elemState, depth);
        mergeBranch(frame, st, guard, elemFrame, elemState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || (st.thrown !== null && st.thrown.toString() === "true") || (st.breakCond !== null && st.breakCond.toString() === "true")) break;
      }
      // Elements beyond the declared length never execute: nothing needed.
      return;
    }
    if (ts.isForStatement(stmt)) {
      if (stmt.initializer) {
        if (ts.isVariableDeclarationList(stmt.initializer)) {
          for (const d of stmt.initializer.declarations) {
            if (ts.isIdentifier(d.name)) {
              frame.vars.set(d.name.text, d.initializer ? evalExpr(d.initializer, frame, st, depth) : { kind: "undef" });
            }
          }
        } else {
          evalExpr(stmt.initializer, frame, st, depth);
        }
      }
      for (let k = 0; k < K; k++) {
        const c = stmt.condition ? evalExpr(stmt.condition, frame, st, depth) : { kind: "bool" as const, t: bool(ctx, true) };
        const tb = truthy(ctx, c);
        if (tb === null) { degrade(st, stmt, "for condition degraded"); return; }
        // Constant-false condition: the loop provably finished — do NOT
        // execute the body (dead iterations pollute live state).
        if (tb.toString() === "false") {
          st.assumptions.push(bool(ctx, true));
          return;
        }
        const iterFrame: Frame = { vars: new Map(frame.vars) };
        const iterState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
        execStmt(stmt.statement, iterFrame, iterState, depth);
        // continue: still run the increment — handled by running increment
        // on iterFrame after body (continue skips rest of body only).
        if (stmt.incrementor) evalExpr(stmt.incrementor, iterFrame, iterState, depth);
        mergeBranch(frame, st, tb, iterFrame, iterState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || (st.thrown !== null && st.thrown.toString() === "true") || (st.breakCond !== null && st.breakCond.toString() === "true")) return;
      }
      // Loop may need more than K iterations: assume it finished.
      const c = stmt.condition ? evalExpr(stmt.condition, frame, st, depth) : null;
      const tb = c ? truthy(ctx, c) : bool(ctx, true);
      if (tb) st.assumptions.push(notFold(tb as Bool<"main">));
      return;
    }
    if (ts.isWhileStatement(stmt)) {
      for (let k = 0; k < K; k++) {
        const c = evalExpr(stmt.expression, frame, st, depth);
        const tb = truthy(ctx, c);
        if (tb === null) { degrade(st, stmt, "while condition degraded"); return; }
        const iterFrame: Frame = { vars: new Map(frame.vars) };
        const iterState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
        execStmt(stmt.statement, iterFrame, iterState, depth);
        mergeBranch(frame, st, tb, iterFrame, iterState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || (st.thrown !== null && st.thrown.toString() === "true") || (st.breakCond !== null && st.breakCond.toString() === "true")) return;
      }
      const c = evalExpr(stmt.expression, frame, st, depth);
      const tb = truthy(ctx, c);
      if (tb) st.assumptions.push(notFold(tb as Bool<"main">));
      return;
    }
    if (ts.isBreakStatement(stmt)) { st.breakCond = bool(ctx, true); return; }
    if (ts.isContinueStatement(stmt)) { st.continueCond = bool(ctx, true); return; }
    if (ts.isSwitchStatement(stmt)) {
      // Desugar to if-chain over case expressions (guarded code has small switches).
      const disc = evalExpr(stmt.expression, frame, st, depth);
      let matched = bool(ctx, false);
      for (const clause of stmt.caseBlock.clauses) {
        let clauseCond: Bool<"main">;
        if (ts.isCaseClause(clause)) {
          const cv = evalExpr(clause.expression, frame, st, depth);
          const eq = valEq(disc, cv);
          if (!eq) { degrade(st, clause, "case comparison degraded"); continue; }
          clauseCond = orFold(matched, eq);
          matched = clauseCond;
        } else {
          clauseCond = notFold(matched);
          matched = bool(ctx, true);
        }
        const cf: Frame = { vars: new Map(frame.vars) };
        const cs: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
        for (const inner of clause.statements) execStmt(inner, cf, cs, depth);
        mergeBranch(frame, st, clauseCond, cf, cs, null, null);
        if (st.hardRet || (st.thrown !== null && st.thrown.toString() === "true") || (st.breakCond !== null && st.breakCond.toString() === "true")) return;
      }
      return;
    }
    if (ts.isTryStatement(stmt)) {
      const tf: Frame = { vars: new Map(frame.vars) };
      const ts_: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: [...st.assumptions], degradations: [...st.degradations] };
      execStmt(stmt.tryBlock, tf, ts_, depth);
      if (ts_.thrown && stmt.catchClause) {
        ts_.thrown = null; // caught
        if (stmt.catchClause.variableDeclaration?.name && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
          tf.vars.set(stmt.catchClause.variableDeclaration.name.text, { kind: "any" });
        }
        execStmt(stmt.catchClause.block, tf, ts_, depth);
      }
      if (stmt.finallyBlock) execStmt(stmt.finallyBlock, tf, ts_, depth);
      // merge try-path back unconditionally
      for (const [k2, v] of tf.vars) frame.vars.set(k2, v);
      st.ret = ts_.ret ?? st.ret; st.hardRet = st.hardRet || ts_.hardRet; st.thrown = ts_.thrown ?? st.thrown;
      st.breakCond = st.breakCond ? orFold(st.breakCond, ts_.breakCond ?? bool(ctx, false)) : ts_.breakCond;
      st.continueCond = st.continueCond ? orFold(st.continueCond, ts_.continueCond ?? bool(ctx, false)) : ts_.continueCond;
      st.pendingRets.push(...ts_.pendingRets);
      st.assumptions.push(...ts_.assumptions); st.degradations.push(...ts_.degradations);
      return;
    }
    if (ts.isEmptyStatement(stmt)) return;
    bad(stmt, `statement ${ts.SyntaxKind[stmt.kind]}`);
  };

  const bindForVar = (init: ts.ForInitializer, value: SymVal, frame: Frame): void => {
    if (ts.isVariableDeclarationList(init)) {
      for (const d of init.declarations) {
        if (ts.isIdentifier(d.name)) frame.vars.set(d.name.text, value);
        else if (ts.isArrayBindingPattern(d.name)) {
          // minimal: bind first element name to the value, rest undefined
          const el = d.name.elements.find(ts.isBindingElement);
          if (el && ts.isIdentifier(el.name)) frame.vars.set(el.name.text, value);
        }
      }
    }
  };

  const degrade = (st: RunState, node: ts.Node, what: string): void => {
    st.degradations.push(`${what} @${lineOf(node)}`);
  };

  const mergeBranch = (
    frame: Frame,
    st: RunState,
    cond: Bool<"main">,
    thenFrame: Frame, thenState: RunState,
    elseFrame: Frame | null, elseState: RunState | null,
  ): void => {
    // Merge variables: take then-branch value under cond, else current value.
    for (const [name, tv] of thenFrame.vars) {
      const cur = frame.vars.get(name);
      frame.vars.set(name, cur ? iteVal(cond, tv, cur) : tv);
    }
    if (elseFrame) {
      for (const [name, ev] of elseFrame.vars) {
        const cur = frame.vars.get(name);
        frame.vars.set(name, cur ? iteVal(cond.not(), ev, cur) : ev);
      }
    }
    // ret merge: branch returns become PENDING conditional returns — the
    // statements after the if still execute (they produce the other path's
    // value); the final return value folds all pending conditions at the end.
    if (thenState.hardRet || thenState.ret !== null) {
      const tv = thenState.ret ?? { kind: "undef" };
      st.pendingRets.push({ cond, val: tv });
      for (const pr of thenState.pendingRets) st.pendingRets.push({ cond: andFold(cond, pr.cond), val: pr.val });
    }
    if (elseState && (elseState.hardRet || elseState.ret !== null)) {
      const ev = elseState.ret ?? { kind: "undef" };
      st.pendingRets.push({ cond: notFold(cond), val: ev });
      for (const pr of elseState.pendingRets) st.pendingRets.push({ cond: andFold(notFold(cond), pr.cond), val: pr.val });
    }
    const tThrown = thenState.thrown;
    const eThrown = elseState?.thrown ?? null;
    const tB = tThrown ?? bool(ctx, false);
    const eB = eThrown ?? bool(ctx, false);
    const mergedThrow = st.thrown ?? bool(ctx, false);
    st.thrown = orFold(orFold(mergedThrow, andFold(cond, tB)), andFold(notFold(cond), eB));
    const tBrk = thenState.breakCond ?? null;
    const eBrk = elseState?.breakCond ?? null;
    const mergedBrk = st.breakCond ?? bool(ctx, false);
    st.breakCond = orFold(orFold(mergedBrk, tBrk ? andFold(cond, tBrk) : bool(ctx, false)), eBrk ? andFold(notFold(cond), eBrk) : bool(ctx, false));
    const tCnt = thenState.continueCond ?? null;
    const eCnt = elseState?.continueCond ?? null;
    const mergedCnt = st.continueCond ?? bool(ctx, false);
    st.continueCond = orFold(orFold(mergedCnt, tCnt ? andFold(cond, tCnt) : bool(ctx, false)), eCnt ? andFold(notFold(cond), eCnt) : bool(ctx, false));
    const pushAll = <T,>(dst: T[], src: T[]): void => { if (src !== dst) for (const x of src) dst.push(x); };
    pushAll(st.assumptions, thenState.assumptions); if (elseState) pushAll(st.assumptions, elseState.assumptions);
    pushAll(st.degradations, thenState.degradations); if (elseState) pushAll(st.degradations, elseState.degradations);
  };

  const valEq = (a: SymVal, b: SymVal): Bool<"main"> | null => {
    if (isNum(a) && isNum(b)) {
      const ac = numC(a.t), bc = numC(b.t);
      if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
      return a.t.eq(b.t);
    }
    if (isStr(a) && isStr(b)) {
      const ac = strConst.get(a.t), bc = strConst.get(b.t);
      if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
      return a.t.eq(b.t);
    }
    if (isBool(a) && isBool(b)) {
      const ac = boolConst.get(a.t), bc = boolConst.get(b.t);
      if (ac !== undefined && bc !== undefined) return bool(ctx, ac === bc);
      return a.t.eq(b.t);
    }
    if (a.kind === "null" && b.kind === "null") return bool(ctx, true);
    if (a.kind === "undef" && b.kind === "undef") return bool(ctx, true);
    return null;
  };

  /* ---------------- expressions ---------------- */

  const evalExpr = (expr: ts.Expression, frame: Frame, st: RunState, depth: number): SymVal => {
    if (ts.isNewExpression(expr)) return evalNew(expr, frame, st, depth);
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      return { kind: "fn", node: expr, env: frame };
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Math"
    ) {
      const meth = expr.expression.name.text;
      const argVals = expr.arguments.map((a) => evalExpr(a, frame, st, depth));
      return mathCall(meth, argVals, expr, st);
    }
    if (ts.isNumericLiteral(expr)) {
      // Numeric literals become Real; note 0.95 etc are exact rationals here.
      return { kind: "num", t: num(ctx, Number(expr.text.replace(/_/g, ""))) };
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { kind: "str", t: strc(ctx, expr.text) };
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: "bool", t: bool(ctx, true) };
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: "bool", t: bool(ctx, false) };
    if (expr.kind === ts.SyntaxKind.NullKeyword) return { kind: "null" };
    if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: "undef" };
    if (ts.isIdentifier(expr)) {
      const v = frame.vars.get(expr.text);
      if (v) return v;
      const mi = curInfo();
      const c = mi.numbers.get(expr.text) ?? info.numbers.get(expr.text);
      if (c !== undefined) return { kind: "num", t: num(ctx, c) };
      const s = mi.strings.get(expr.text) ?? info.strings.get(expr.text);
      if (s !== undefined) return { kind: "str", t: strc(ctx, s) };
      const arrow = mi.constArrowFns.get(expr.text) ?? info.constArrowFns.get(expr.text);
      if (arrow) return evalExpr(arrow, frame, st, depth);
      const binding = mi.constBindings.get(expr.text) ?? info.constBindings.get(expr.text);
      if (binding) return evalExpr(binding, frame, st, depth);
      const imported = importedSymbols.get(expr.text);
      if (imported) {
        const ic = imported.info.numbers.get(expr.text);
        if (ic !== undefined) return { kind: "num", t: num(ctx, ic) };
        const is = imported.info.strings.get(expr.text);
        if (is !== undefined) return { kind: "str", t: ctx.String.val(is) };
        const ia = imported.info.constArrowFns.get(expr.text);
        if (ia) return evalExpr(ia, frame, st, depth);
        const ib = imported.info.constBindings.get(expr.text);
        if (ib) return evalExpr(ib, frame, st, depth);
      }
      bad(expr, `unbound identifier ${expr.text}`);
    }
    if (ts.isParenthesizedExpression(expr)) return evalExpr(expr.expression, frame, st, depth);
    if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return evalExpr(expr.expression, frame, st, depth);
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      if (expr.operator === ts.SyntaxKind.ExclamationToken) {
        const v = evalExpr(expr.operand, frame, st, depth);
        const t = truthy(ctx, v);
        return t ? { kind: "bool", t: t.not() } : { kind: "any" };
      }
      if (expr.operator === ts.SyntaxKind.MinusToken) {
        const v = evalExpr(expr.operand, frame, st, depth);
        return isNum(v) ? { kind: "num", t: v.t.neg() } : { kind: "any" };
      }
      if (expr.operator === ts.SyntaxKind.PlusToken) return evalExpr(expr.operand, frame, st, depth);
      bad(expr, `prefix ${ts.SyntaxKind[expr.operator]}`);
    }
    if (ts.isBinaryExpression(expr)) return evalBinary(expr, frame, st, depth);
    if (ts.isConditionalExpression(expr)) {
      const c = truthy(ctx, evalExpr(expr.condition, frame, st, depth));
      if (!c) { degrade(st, expr, "ternary condition degraded"); return { kind: "any" }; }
      const a = evalExpr(expr.whenTrue, frame, st, depth);
      const b = evalExpr(expr.whenFalse, frame, st, depth);
      return iteVal(c, a, b);
    }
    if (ts.isTemplateExpression(expr)) {
      const parts: SymVal[] = [{ kind: "str", t: ctx.String.val(expr.head.text) }];
      for (const span of expr.templateSpans) {
        let v = evalExpr(span.expression, frame, st, depth);
        if (isNum(v)) {
          // number→string interpolation: uninterpreted 1-8 digit string.
          // Content-irrelevant for structural properties; replay lock still
          // validates any witness end-to-end.
          const hole = ctx.String.const("__numstr_" + numHoleCounter++);
          st.assumptions.push((ctx.ToReal(hole.length() as never) as Num).ge(num(ctx, 1)).and((ctx.ToReal(hole.length() as never) as Num).le(num(ctx, 8))));
          v = { kind: "str", t: hole };
        }
        parts.push(v);
      }
      return concatAll(parts);
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const elems: SymVal[] = [];
      for (const el of expr.elements) {
        if (ts.isSpreadElement(el)) {
          const v = evalExpr(el.expression, frame, st, depth);
          if (isArr(v)) elems.push(...v.elems);
          else degrade(st, el, "spread of non-array in literal");
        } else {
          elems.push(evalExpr(el, frame, st, depth));
        }
      }
      const count = expr.elements.filter((e) => !ts.isSpreadElement(e)).length
        + expr.elements.filter((e) => ts.isSpreadElement(e)).length; // spread len merged below if needed
      void count;
      // declared length: count of elements (spread assumed full — guarded code
      // builds arrays with concrete sources; replay lock validates)
      let declaredLen: Num = num(ctx, 0);
      for (const el of expr.elements) {
        if (ts.isSpreadElement(el)) {
          const v = evalExpr(el.expression, frame, st, depth);
          declaredLen = isArr(v) ? declaredLen.add(v.len) : declaredLen;
        } else declaredLen = declaredLen.add(num(ctx, 1));
      }
      return arrOf(elems, declaredLen);
    }
    if (ts.isObjectLiteralExpression(expr)) {
      const fields = new Map<string, SymVal>();
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const v = evalExpr(prop.expression, frame, st, depth);
          if (isObj(v)) for (const [k2, v2] of v.fields) fields.set(k2, v2);
          else degrade(st, prop, "object spread of non-object");
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          fields.set(prop.name.text, evalExpr(prop.initializer, frame, st, depth));
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          fields.set(prop.name.text, evalExpr(prop.name, frame, st, depth));
        } else {
          degrade(st, prop, "object literal member");
        }
      }
      return { kind: "obj", fields };
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const obj = evalExpr(expr.expression, frame, st, depth);
      return member(obj, expr.name.text, expr, st);
    }
    if (ts.isElementAccessExpression(expr)) {
      const obj = evalExpr(expr.expression, frame, st, depth);
      const idx = evalExpr(expr.argumentExpression, frame, st, depth);
      return elementAccess(obj, idx, expr, st);
    }
    if (ts.isCallExpression(expr)) return evalCall(expr, frame, st, depth);
    if (expr.kind === ts.SyntaxKind.PostfixUnaryExpression || expr.kind === ts.SyntaxKind.PrefixUnaryExpression) {
      const u = expr as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
      const one = num(ctx, 1);
      const v = evalExpr(u.operand, frame, st, depth);
      if (isNum(v) && ts.isIdentifier(u.operand)) {
        const cv0 = isNum(v) ? numC(v.t) : undefined;
        const nv = cv0 !== undefined
          ? { kind: "num" as const, t: num(ctx, u.operator === ts.SyntaxKind.PlusPlusToken ? cv0 + 1 : cv0 - 1) }
          : { kind: "num" as const, t: u.operator === ts.SyntaxKind.PlusPlusToken ? v.t.add(one) : v.t.sub(one) };
        frame.vars.set(u.operand.text, nv);
        return u.kind === ts.SyntaxKind.PrefixUnaryExpression ? nv : v;
      }
      bad(expr, "update expression on non-number");
    }
    return bad(expr, `expression ${ts.SyntaxKind[expr.kind]}`);
  };

  // (TS2366: `bad` throws; this satisfies the checker without changing behavior.)

  const rootName = (e: ts.PropertyAccessExpression): string | undefined =>
    ts.isIdentifier(e.expression) ? e.expression.text : ts.isPropertyAccessExpression(e.expression) ? rootName(e.expression) : undefined;

  const compoundOpKind = (k: ts.SyntaxKind): ts.BinaryOperatorToken["kind"] | undefined => {
    switch (k) {
      case ts.SyntaxKind.PlusEqualsToken: return ts.SyntaxKind.PlusToken;
      case ts.SyntaxKind.MinusEqualsToken: return ts.SyntaxKind.MinusToken;
      case ts.SyntaxKind.AsteriskEqualsToken: return ts.SyntaxKind.AsteriskToken;
      default: return undefined;
    }
  };

  const concatAll = (parts: SymVal[]): SymVal => {
    const strs: Str[] = [];
    let allConst = true;
    let acc = "";
    for (const p of parts) {
      if (!isStr(p)) return { kind: "any" };
      const sv = strConst.get(p.t);
      if (sv === undefined) allConst = false;
      else acc += sv;
      strs.push(p.t);
    }
    if (strs.length === 0) return { kind: "str", t: strc(ctx, "") };
    if (allConst) return { kind: "str", t: strc(ctx, acc) };
    return { kind: "str", t: strs.reduce((a, b) => a.concat(b)) };
  };

  const member = (obj: SymVal, name: string, at: ts.Node, st: RunState): SymVal => {
    if (isArr(obj)) {
      if (name === "length") return { kind: "num", t: obj.len };
      return { kind: "any" }; // methods are handled at call sites
    }
    if (isStr(obj)) {
      if (name === "length") {
        const sv = strConst.get(obj.t) ?? (obj.t.toString().startsWith('"') ? JSON.parse(obj.t.toString()) : undefined);
        if (sv !== undefined) return { kind: "num", t: num(ctx, sv.length) };
        return { kind: "num", t: lenR(obj.t) };
      }
      return { kind: "any" };
    }
    if (isObj(obj)) {
      // Map/Set .size (property, not method)
      if (name === "size" && (obj.fields.has("__map_entries") || obj.fields.has("__set_values"))) {
        const e = obj.fields.get("__map_entries") ?? obj.fields.get("__set_values");
        if (e && isArr(e)) return { kind: "num", t: e.len };
      }
      const v = obj.fields.get(name);
      return v ?? { kind: "any" };
    }
    if (obj.kind === "null" || obj.kind === "undef") return { kind: "any" };
    return { kind: "any" };
  };

  const elementAccess = (obj: SymVal, idx: SymVal, at: ts.Node, st: RunState): SymVal => {
    if (isArr(obj) && isNum(idx)) {
      const ic = numC(idx.t);
      if (ic !== undefined && Number.isInteger(ic)) {
        return ic >= 0 && ic < obj.elems.length ? obj.elems[ic]! : { kind: "undef" };
      }
      // Chain of If(idx == k, elems[k]) for k < N.
      let acc: SymVal = { kind: "undef" };
      for (let k = obj.elems.length - 1; k >= 0; k--) {
        acc = iteVal(numEq(ctx, idx.t, num(ctx, k)), obj.elems[k], acc);
      }
      return acc;
    }
    if (isObj(obj) && isStr(idx)) {
      // Dynamic key: pick by string equality over known keys.
      let acc: SymVal = { kind: "undef" };
      for (const [key, v] of obj.fields) {
        acc = iteVal(idx.t.eq(ctx.String.val(key)), v, acc);
      }
      return acc;
    }
    return { kind: "any" };
  };

  const ASSIGN_OPS: ts.SyntaxKind[] = [
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ];

  const evalBinary = (expr: ts.BinaryExpression, frame: Frame, st: RunState, depth: number): SymVal => {
    const op = expr.operatorToken.kind;
    // Assignments (x = …, x += …) are BinaryExpressions: they MUST be
    // handled here at the TOP of evalBinary — evalExpr's generic
    // isBinaryExpression dispatch reaches this function for every binary
    // node, and a fallthrough to applyBinop would evaluate but never STORE.
    if (ASSIGN_OPS.includes(op)) {
      const rhs = evalExpr(expr.right, frame, st, depth);
      if (ts.isIdentifier(expr.left)) {
        if (op === ts.SyntaxKind.EqualsToken) {
          frame.vars.set(expr.left.text, rhs);
          return rhs;
        }
        const cur = frame.vars.get(expr.left.text);
        const opKind = compoundOpKind(op);
        if (opKind && cur) {
          const merged = applyBinop(opKind, cur, rhs, expr, st);
          frame.vars.set(expr.left.text, merged);
          return merged;
        }
        bad(expr, "compound assignment");
      }
      if (ts.isPropertyAccessExpression(expr.left)) {
        const base = evalExpr(expr.left.expression, frame, st, depth);
        if (isObj(base)) {
          const fields = new Map(base.fields);
          fields.set(expr.left.name.text, rhs);
          frame.vars.set(rootName(expr.left) ?? "", { kind: "obj", fields });
          return rhs;
        }
      }
      bad(expr, "assignment target");
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = evalExpr(expr.left, frame, st, depth);
      return jsAnd(l, () => evalExpr(expr.right, frame, st, depth));
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = evalExpr(expr.left, frame, st, depth);
      return jsOr(l, () => evalExpr(expr.right, frame, st, depth));
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      const l = evalExpr(expr.left, frame, st, depth);
      return jsNullish(l, () => evalExpr(expr.right, frame, st, depth));
    }
    return applyBinop(op, evalExpr(expr.left, frame, st, depth), evalExpr(expr.right, frame, st, depth), expr, st);
  };

  const applyBinop = (op: ts.SyntaxKind, l: SymVal, r: SymVal, at: ts.Node, st: RunState): SymVal => {
    if (isNum(l) && isNum(r)) {
      const a = l.t, b = r.t;
      const ac = numC(a), bc = numC(b);
      if (ac !== undefined && bc !== undefined) {
        const fold = (): SymVal | null => {
          switch (op) {
            case ts.SyntaxKind.PlusToken: return { kind: "num", t: num(ctx, ac + bc) };
            case ts.SyntaxKind.MinusToken: return { kind: "num", t: num(ctx, ac - bc) };
            case ts.SyntaxKind.AsteriskToken: return { kind: "num", t: num(ctx, ac * bc) };
            case ts.SyntaxKind.SlashToken:
              if (bc !== 0 && Number.isInteger(ac) && Number.isInteger(bc) && ac % bc === 0) return { kind: "num", t: num(ctx, ac / bc) };
              return null;
            case ts.SyntaxKind.PercentToken:
              if (Number.isInteger(ac) && Number.isInteger(bc) && bc !== 0) return { kind: "num", t: num(ctx, ac % bc) };
              return null;
            case ts.SyntaxKind.LessThanToken: return { kind: "bool", t: bool(ctx, ac < bc) };
            case ts.SyntaxKind.LessThanEqualsToken: return { kind: "bool", t: bool(ctx, ac <= bc) };
            case ts.SyntaxKind.GreaterThanToken: return { kind: "bool", t: bool(ctx, ac > bc) };
            case ts.SyntaxKind.GreaterThanEqualsToken: return { kind: "bool", t: bool(ctx, ac >= bc) };
            case ts.SyntaxKind.EqualsEqualsToken:
            case ts.SyntaxKind.EqualsEqualsEqualsToken: return { kind: "bool", t: bool(ctx, ac === bc) };
            case ts.SyntaxKind.ExclamationEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { kind: "bool", t: bool(ctx, ac !== bc) };
            default: return null;
          }
        };
        const f = fold();
        if (f) return f;
      }
      try {
        switch (op) {
          case ts.SyntaxKind.PlusToken: return { kind: "num", t: a.add(b) };
          case ts.SyntaxKind.MinusToken: return { kind: "num", t: a.sub(b) };
          case ts.SyntaxKind.AsteriskToken: return { kind: "num", t: a.mul(b) };
          case ts.SyntaxKind.SlashToken: return { kind: "num", t: a.div(b) };
          case ts.SyntaxKind.PercentToken: return { kind: "num", t: a.mod(b) };
          case ts.SyntaxKind.LessThanToken: return { kind: "bool", t: a.lt(b) };
          case ts.SyntaxKind.LessThanEqualsToken: return { kind: "bool", t: a.le(b) };
          case ts.SyntaxKind.GreaterThanToken: return { kind: "bool", t: a.gt(b) };
          case ts.SyntaxKind.GreaterThanEqualsToken: return { kind: "bool", t: a.ge(b) };
          case ts.SyntaxKind.EqualsEqualsToken:
          case ts.SyntaxKind.EqualsEqualsEqualsToken: return { kind: "bool", t: a.eq(b) };
          case ts.SyntaxKind.ExclamationEqualsToken:
          case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { kind: "bool", t: a.neq(b) };
        }
      } catch (e) {
        console.error("[cast-debug]", ts.SyntaxKind[op], "a=", a.toString().slice(0,160), "b=", b.toString().slice(0,160));
        throw e;
      }
    }
    if (isStr(l) && isStr(r)) {
      const lc = strConst.get(l.t), rc = strConst.get(r.t);
      if (op === ts.SyntaxKind.PlusToken) {
        if (lc !== undefined && rc !== undefined) return { kind: "str", t: strc(ctx, lc + rc) };
        return { kind: "str", t: l.t.concat(r.t) };
      }
      if (lc !== undefined && rc !== undefined) {
        if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) return { kind: "bool", t: bool(ctx, lc === rc) };
        if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return { kind: "bool", t: bool(ctx, lc !== rc) };
      }
      if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) return { kind: "bool", t: l.t.eq(r.t) };
      if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return { kind: "bool", t: l.t.neq(r.t) };
    }
    if (isBool(l) && isBool(r)) {
      if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) return { kind: "bool", t: l.t.eq(r.t) };
      if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return { kind: "bool", t: l.t.neq(r.t) };
    }
    // Mixed equality against null/undefined
    if ((l.kind === "null" || l.kind === "undef") || (r.kind === "null" || r.kind === "undef")) {
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        return { kind: "bool", t: bool(ctx, l.kind === r.kind) };
      }
      if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        return { kind: "bool", t: bool(ctx, l.kind !== r.kind) };
      }
    }
    return { kind: "any" };
  };

  /* ---------------- calls ---------------- */

  const evalCall = (call: ts.CallExpression, frame: Frame, st: RunState, depth: number): SymVal => {
    // Spread arguments: flatten arrays of args (rare in guarded code).
    const argVals: SymVal[] = [];
    for (const a of call.arguments) {
      if (ts.isSpreadElement(a)) {
        const v = evalExpr(a.expression, frame, st, depth);
        if (isArr(v)) argVals.push(...v.elems);
        else degrade(st, a, "spread argument");
      } else {
        argVals.push(evalExpr(a, frame, st, depth));
      }
    }
    const calleeExpr = call.expression;

    // Namespace-qualified builtins ------------------------------------
    if (ts.isPropertyAccessExpression(calleeExpr) && ts.isIdentifier(calleeExpr.expression)) {
      const ns = calleeExpr.expression.text;
      const meth = calleeExpr.name.text;
      if (ns === "Number") {
        if (meth === "isInteger" && isNum(argVals[0])) {
          return { kind: "bool", t: ctx.IsInt(argVals[0].t) };
        }
        if (meth === "isFinite" && isNum(argVals[0])) return { kind: "bool", t: bool(ctx, true) };
        if ((meth === "parseInt" || meth === "parseFloat") && isStr(argVals[0])) {
          return { kind: "num", t: argVals[0].t.toInt() };
        }
      }
      if (ns === "Math") return mathCall(meth, argVals, call, st);
      if (ns === "Array" && meth === "isArray") {
        if (argVals[0].kind === "arr") return { kind: "bool", t: bool(ctx, true) };
        if (argVals[0].kind === "obj" || isStr(argVals[0]) || isNum(argVals[0])) return { kind: "bool", t: bool(ctx, false) };
        degrade(st, call, "Array.isArray on degraded value");
        return { kind: "any" };
      }
      if (ns === "String" && meth === "fromCharCode") return { kind: "str", t: ctx.String.val("") }; // degraded, content-neutral
      if (ns === "JSON") { degrade(st, call, `JSON.${meth}`); return { kind: "any" }; }
      if (ns === "Object" || ns === "Boolean") { degrade(st, call, `${ns}.${meth}`); return { kind: "any" }; }
    }

    // Method calls on values -------------------------------------------
    if (ts.isPropertyAccessExpression(calleeExpr)) {
      const recv = evalExpr(calleeExpr.expression, frame, st, depth);
      const m = calleeExpr.name.text;
      return callMethod(recv, m, argVals, call, st, frame, depth);
    }

    // Plain identifier calls -------------------------------------------
    const name = ts.isIdentifier(calleeExpr) ? calleeExpr.text : undefined;
    if (!name) { degrade(st, call, "indirect call"); return { kind: "any" }; }

    // Builtins with exact translation
    if (name === "Number.isInteger" || name === "Number.isFinite") {
      const a0 = argVals[0];
      if (isNum(a0)) {
        if (name === "Number.isInteger") return { kind: "bool", t: ctx.IsInt(a0.t) };
        return { kind: "bool", t: bool(ctx, true) }; // finite within Real model
      }
      return { kind: "any" };
    }
    if (name === "Number" || name === "String") {
      const a0 = argVals[0];
      if (name === "String") {
        if (isStr(a0)) return a0;
        if (isNum(a0)) return numToStringStr(st);
        return { kind: "any" };
      }
      return isNum(a0) ? a0 : { kind: "any" };
    }
    if (name === "isNaN") {
      const a0 = argVals[0];
      return isNum(a0) ? { kind: "bool", t: bool(ctx, false) } : { kind: "any" };
    }

    // Local closure value call (const arrow / function expression stored in a var)
    const fnVal = frame.vars.get(name);
    if (fnVal && fnVal.kind === "fn") {
      return invokeCallback(fnVal.node, argVals, st, depth, fnVal.env);
    }

    // Port parameter override (public injection seam); memoized on the
    // argument's structural form — port implementations are pure functions.
    if (input.options?.portImpls && name in input.options.portImpls && frame.vars.has(name)) {
      const arg0 = argVals[0] ?? { kind: "undef" };
      const key = arg0.kind === "str" ? `s:${arg0.t.toString()}` : arg0.kind === "num" ? `n:${arg0.t.toString()}` : null;
      if (key !== null) {
        const hit = portMemo.get(`${name}\u0000${key}`);
        if (hit) return hit;
        const r = input.options.portImpls[name]!(arg0);
        portMemo.set(`${name}\u0000${key}`, r);
        return r;
      }

      return input.options.portImpls[name]!(arg0);
    }

    // Local function → INLINE (the no-cheating core: real helper bodies run)
    const entryFn = info.functions.get(name);
    const entryArrow = info.constArrowFns.get(name) as ts.ArrowFunction | undefined;
    const defEntry = importedSymbols.get(name);
    const localFn = curInfo().functions.get(name) ?? defEntry?.info.functions.get(name) ?? entryFn;
    const defArrow = importedSymbols.get(name)?.info.constArrowFns.get(name) as ts.ArrowFunction | undefined;
    const localArrow = curInfo().constArrowFns.get(name) ?? defArrow ?? entryArrow;
    const fnNode = localFn ?? (localArrow as ts.ArrowFunction | undefined);
    if (fnNode) {
      if (depth >= MAXINLINE) { degrade(st, call, `inline depth cap at ${name}`); return { kind: "any" }; }
      return inlineCall(fnNode, argVals, call, st, depth, defEntry?.info);
    }

    degrade(st, call, `call to ${name}`);
    return { kind: "any" };
  };

  const inlineCall = (
    fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    args: SymVal[],
    at: ts.Node,
    st: RunState,
    depth: number,
    defInfo?: ModuleInfo,
  ): SymVal => {
    if (defInfo) moduleStack.push(defInfo);
    try {
    const inner: Frame = { vars: new Map(frame.vars) }; // lexical closure
    const params = ts.isFunctionDeclaration(fn) ? fn.parameters : fn.parameters;
    params.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) {
        inner.vars.set(p.name.text, args[i] ?? (p.initializer ? evalExpr(p.initializer, inner, st, depth + 1) : { kind: "undef" }));
      } else if (ts.isArrayBindingPattern(p.name)) {
        // destructure array param: bind pattern elements to slots
        p.name.elements.forEach((el, j) => {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            inner.vars.set(el.name.text, args[i] && isArr(args[i]) ? args[i].elems[j] : { kind: "undef" });
          }
        });
      }
    });
    const innerState: RunState = runState0();
    const body = ts.isFunctionDeclaration(fn) ? fn.body : fn.body;
    if (!body) return { kind: "any" };
    if (ts.isBlock(body)) {
      execStmt(body, inner, innerState, depth + 1);
    } else {
      // arrow with expression body
      innerState.ret = evalExpr(body, inner, innerState, depth + 1);
    }
    const pushAll2 = <T,>(dst: T[], src: T[]): void => { if (src !== dst) for (const x of src) dst.push(x); };
    pushAll2(st.assumptions, innerState.assumptions);
    pushAll2(st.degradations, innerState.degradations);
    if (innerState.thrown) st.thrown = orFold(st.thrown ?? bool(ctx, false), innerState.thrown);
    // fold conditional returns (pendingRets) LIFO over the unconditional ret
    let out = innerState.ret;
    for (let i = innerState.pendingRets.length - 1; i >= 0; i--) {
      const pr = innerState.pendingRets[i]!;
      out = out === null ? iteVal(pr.cond, pr.val, { kind: "undef" }) : iteVal(pr.cond, pr.val, out);
    }
    return out ?? { kind: "undef" };
    } finally {
      if (defInfo) moduleStack.pop();
    }
  };

  const callMethod = (
    recv: SymVal, m: string, args: SymVal[],
    at: ts.CallExpression, st: RunState, frame: Frame, depth: number,
  ): SymVal => {
    // ---- namespace objects ----
    if (isObj(recv) && m === "call" ) { degrade(st, at, "fn.call"); return { kind: "any" }; }

    // ---- Math ----
    // (Math.x handled at plain-call sites in source; but method form via
    //  identifier "Math" reaches here only through plain calls.)

    // ---- array methods ----
    if (isArr(recv)) {
      switch (m) {
        case "length": return { kind: "num", t: recv.len };
        case "push": {
          const v = args[0];
          if (recv.elems.length < N) {
            // append at the symbolic tail position (arrays built by push)
            const elems = recv.elems.map((e, k) => iteVal(numEq(ctx, recv.len, num(ctx, k)), v, e));
            elems.push(iteVal(numEq(ctx, recv.len, num(ctx, recv.elems.length)), v, { kind: "undef" }));
            const newLen = recv.len.add(num(ctx, 1));
            return rebindArray(recv, { kind: "arr", elems, len: newLen }, at, st, frame);
          }
          degrade(st, at, "push beyond bounded slots");
          return { kind: "any" };
        }
        case "includes": {
          const target = args[0];
          const eqs = recv.elems.map((e) => valEq(e, target));
          if (eqs.some((e) => e === null)) return { kind: "any" };
          let acc = bool(ctx, false);
          for (let k = 0; k < recv.elems.length; k++) {
            acc = acc.or(recv.len.gt(num(ctx, k)).and(eqs[k]!));
          }
          return { kind: "bool", t: acc };
        }
        case "indexOf": {
          const target = args[0];
          const eqs = recv.elems.map((e) => valEq(e, target));
          if (eqs.some((e) => e === null)) return { kind: "any" };
          let acc: Num = num(ctx, -1);
          for (let k = recv.elems.length - 1; k >= 0; k--) {
            acc = ctx.If(recv.len.gt(num(ctx, k)).and(eqs[k]!), num(ctx, k), acc);
          }
          return { kind: "num", t: acc };
        }
        case "map": {
          const cb = at.arguments[0];
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) { degrade(st, at, "map without function literal"); return { kind: "any" }; }
          const elems = recv.elems.map((e, k) => {
            const guarded = iteVal(recv.len.gt(num(ctx, k)), e, { kind: "undef" });
            return invokeCallback(cb, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth);
          });
          return { kind: "arr", elems, len: recv.len };
        }
        case "filter": {
          const cb = at.arguments[0];
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) { degrade(st, at, "filter without function literal"); return { kind: "any" }; }
          // Unrolled two-pass: keep-slot[j] via counting.
          const keep: Bool<"main">[] = recv.elems.map((e, k) => {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, e, { kind: "undef" });
            const r = invokeCallback(cb, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth);
            const t = truthy(ctx, r);
            if (!t) return g.not(); // out-of-length slots never keep
            return g.and(t);
          });
          const outElems: SymVal[] = [];
          for (let j = 0; j < recv.elems.length; j++) {
            // j-th kept element = elems[k] where keep[k] and exactly j keeps before k
            let pick: SymVal = { kind: "undef" };
            for (let k = recv.elems.length - 1; k >= 0; k--) {
              const before = countTrueBelow(keep, k);
              const cond = keep[k]!.and(before.eq(num(ctx, j)));
              pick = iteVal(cond, recv.elems[k], pick);
            }
            outElems.push(pick);
          }
          const newLen = keep.reduce((acc, kk) => ctx.If(kk, acc.add(num(ctx, 1)), acc), num(ctx, 0));
          return { kind: "arr", elems: outElems, len: newLen };
        }
        case "every":
        case "some": {
          const cb = at.arguments[0];
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) { degrade(st, at, `${m} without function literal`); return { kind: "any" }; }
          let acc = bool(ctx, m === "every");
          for (let k = 0; k < recv.elems.length; k++) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            const r = truthy(ctx, invokeCallback(cb, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth));
            if (!r) { degrade(st, at, `${m} callback degraded`); return { kind: "any" }; }
            const effective = g.and(r);
            acc = m === "every" ? acc.and(effective) : acc.or(effective);
          }
          return { kind: "bool", t: acc };
        }
        case "find": {
          const cb = at.arguments[0];
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) { degrade(st, at, "find without function literal"); return { kind: "any" }; }
          let acc: SymVal = { kind: "undef" };
          for (let k = recv.elems.length - 1; k >= 0; k--) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            const r = truthy(ctx, invokeCallback(cb, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth));
            if (!r) { degrade(st, at, "find callback degraded"); return { kind: "any" }; }
            acc = iteVal(g.and(r), recv.elems[k], acc);
          }
          return acc;
        }
        case "findIndex": {
          const cb = at.arguments[0];
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) { degrade(st, at, "findIndex without function literal"); return { kind: "any" }; }
          let acc: Num = num(ctx, -1);
          for (let k = recv.elems.length - 1; k >= 0; k--) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            const r = truthy(ctx, invokeCallback(cb, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth));
            if (!r) { degrade(st, at, "findIndex callback degraded"); return { kind: "any" }; }
            acc = ctx.If(g.and(r), num(ctx, k), acc);
          }
          return { kind: "num", t: acc };
        }
        case "sort": {
          // Rank-based comparator sort, works for any slot count N (O(N²) comparator calls,
          // no permutation enumeration). rank_i = #{j real: cmp(v_i,v_j)<0} + #{j<i real: cmp==0}
          // (stable). Output slot k takes the element whose rank is k. Elements at
          // positions ≥ len are not "real" and keep rank undefined (slot falls through to undef).
          const cb = at.arguments[0];
          const n = recv.elems.length;
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) || !args[0] || args[0].kind !== "fn") {
            degrade(st, at, `sort (n=${n})`);
            return { kind: "any" };
          }
          const cbFn = args[0] as { kind: "fn"; node: ts.ArrowFunction; env: Frame };
          const real = (i: number): Bool<"main"> => recv.len.gt(num(ctx, i)); // i < len
          const ranks: Num[] = [];
          for (let i = 0; i < n; i++) {
            let rank = num(ctx, 0);
            for (let j = 0; j < n; j++) {
              if (i === j) continue;
              const realJ = real(j);
              if (recv.elems[i] === recv.elems[j]) {
                // identical values: comparator returns 0 (deterministic) — tie
                rank = rank.add(ctx.If(realJ.and(bool(ctx, j < i)), num(ctx, 1), num(ctx, 0)) as Num);
                continue;
              }
              const r = invokeCallback(cbFn.node, [recv.elems[i]!, recv.elems[j]!], st, depth, cbFn.env);
              if (!isNum(r)) { degrade(st, at, "sort comparator non-numeric"); return { kind: "any" }; }
              const less = r.t.lt(num(ctx, 0)).and(realJ);
              const tie = r.t.eq(num(ctx, 0)).and(realJ).and(bool(ctx, j < i));
              rank = rank.add(ctx.If(less.or(tie), num(ctx, 1), num(ctx, 0)) as Num);
            }
            ranks.push(rank);
          }
          const elems: SymVal[] = [];
          for (let k = 0; k < n; k++) {
            let slot: SymVal = { kind: "undef" };
            for (let i = 0; i < n; i++) {
              const hit = numEq(ctx, ranks[i]!, num(ctx, k)).and(real(i));
              slot = iteVal(hit, recv.elems[i]!, slot);
            }
            elems.push(slot);
          }
          return { kind: "arr", elems, len: recv.len };
        }
        case "forEach": {
          const cb = at.arguments[0];
          if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) { degrade(st, at, "forEach without function literal"); return { kind: "any" }; }
          for (let k = 0; k < recv.elems.length; k++) {
            const g = recv.len.gt(num(ctx, k));
            const guarded = iteVal(g, recv.elems[k], { kind: "undef" });
            invokeCallback(cb, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth);
          }
          return { kind: "undef" };
        }
        case "slice": {
          const a0 = isNum(args[0]) ? args[0].t : num(ctx, 0);
          const rawEnd = isNum(args[1]) ? args[1].t : recv.len;
          const start = ctx.If(a0.lt(num(ctx, 0)), ctx.If(a0.add(recv.len).ge(num(ctx, 0)), a0.add(recv.len), num(ctx, 0)), a0);
          const end = ctx.If(rawEnd.lt(num(ctx, 0)), ctx.If(rawEnd.add(recv.len).ge(num(ctx, 0)), rawEnd.add(recv.len), num(ctx, 0)), rawEnd);
          const elems: SymVal[] = [];
          for (let j = 0; j < recv.elems.length; j++) {
            const srcIdx = start.add(num(ctx, j));
            let pick: SymVal = { kind: "undef" };
            for (let k = recv.elems.length - 1; k >= 0; k--) {
              pick = iteVal(numEq(ctx, srcIdx, num(ctx, k)).and(end.gt(num(ctx, j))), recv.elems[k], pick);
            }
            elems.push(pick);
          }
          const len = end.sub(start);
          return { kind: "arr", elems, len: ctx.If(len.lt(num(ctx, 0)), num(ctx, 0), len) };
        }
        case "concat": {
          const other = args.find(isArr);
          const elems = [...recv.elems];
          if (other) {
            for (let k = 0; k < other.elems.length; k++) {
              elems.push(iteVal(other.len.gt(num(ctx, k)), other.elems[k], { kind: "undef" }));
            }
          }
          return { kind: "arr", elems, len: other ? recv.len.add(other.len) : recv.len };
        }
        case "join": {
          // Only when every element is a concrete/str; else degrade.
          const parts: SymVal[] = [];
          for (let k = 0; k < recv.elems.length; k++) {
            parts.push(iteVal(recv.len.gt(num(ctx, k + 1)), [...recv.elems.slice(0, k), { kind: "str" as const, t: strArgOrEmpty(args[0]) }].reduce<SymVal>((a, b) => (isStr(a) && isStr(b) ? { kind: "str" as const, t: a.t.concat(b.t) } : { kind: "any" as const }), { kind: "str" as const, t: ctx.String.val("") }), recv.elems[k]));
          }
          if (parts.some((p) => !isStr(p))) { degrade(st, at, "join with degraded parts"); return { kind: "any" }; }
          return parts.reduce<SymVal>((a, b) => (isStr(a) && isStr(b) ? { kind: "str" as const, t: a.t.concat(b.t) } : { kind: "any" as const }), { kind: "str" as const, t: ctx.String.val("") });
        }
        default:
          degrade(st, at, `array method .${m}`);
          return { kind: "any" };
      }
    }

    // ---- string methods ----
    if (isStr(recv)) {
      switch (m) {
        case "length": return { kind: "num", t: lenR(recv.t) };
        case "includes": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "bool", t: bool(ctx, rc.includes(ac)) };
          return { kind: "bool", t: recv.t.contains(a0) };
        }
        case "startsWith": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "bool", t: bool(ctx, rc.startsWith(ac)) };
          return { kind: "bool", t: recv.t.prefixOf(a0) };
        }
        case "endsWith": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "bool", t: bool(ctx, rc.endsWith(ac)) };
          return { kind: "bool", t: recv.t.suffixOf(a0) };
        }
        case "indexOf": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          const rc = strConst.get(recv.t), ac = strConst.get(a0);
          if (rc !== undefined && ac !== undefined) return { kind: "num", t: num(ctx, rc.indexOf(ac)) };
          return { kind: "num", t: recv.t.indexOf(a0) };
        }
        case "slice":
        case "substring": {
          const a0 = isNum(args[0]) ? args[0].t : num(ctx, 0);
          const rawEnd = isNum(args[1]) ? args[1].t : lenR(recv.t);
          const start = ctx.If(a0.lt(num(ctx, 0)), ctx.If(a0.add(lenR(recv.t)).ge(num(ctx, 0)), a0.add(lenR(recv.t)), num(ctx, 0)), a0);
          const end = ctx.If(rawEnd.lt(num(ctx, 0)), ctx.If(rawEnd.add(lenR(recv.t)).ge(num(ctx, 0)), rawEnd.add(lenR(recv.t)), num(ctx, 0)), rawEnd);
          const len = ctx.If(end.sub(start).ge(num(ctx, 0)), end.sub(start), num(ctx, 0));
          // seq.extract is Int-indexed; our numbers are Real.
          st.assumptions.push(ctx.IsInt(start), ctx.IsInt(len));
          return { kind: "str", t: recv.t.extract(ctx.ToInt(start), ctx.ToInt(len)) };
        }
        case "charCodeAt": {
          const a0 = isNum(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          st.assumptions.push(ctx.IsInt(a0));
          return { kind: "num", t: ctx.ToReal(recv.t.at(ctx.ToInt(a0)).toCode() as never) as Num }; // toCode is Int-sorted; numbers are Real
        }
        case "at": {
          const a0 = isNum(args[0]) ? args[0].t : num(ctx, 0);
          const idx = ctx.If(a0.lt(num(ctx, 0)), a0.add(lenR(recv.t)), a0);
          return { kind: "str", t: recv.t.at(ctx.ToInt(idx)) };
        }
        case "trim": return recv; // approximation: content-neutral for our props
        case "toLowerCase": return recv; // approximation: same, see README
        case "toUpperCase": return recv;
        case "replace": {
          const a0 = isStr(args[0]) ? args[0].t : null;
          const a1 = isStr(args[1]) ? args[1].t : null;
          if (a0 && a1) return { kind: "str", t: recv.t.replace(a0, a1) };
          return { kind: "any" };
        }
        case "padStart": {
          // Implemented exactly when the string is a decimal digit string
          // (the ref-tag use). General int→str is a documented gap.
          const w = isNum(args[0]) ? args[0].t : null;
          const pad = isStr(args[1]) ? args[1].t : null;
          if (!w || !pad) return { kind: "any" };
          // len < w ? pad*(w-len) ++ s : s   — construct via extract of pad^N
          let padded = recv.t;
          const reps: Str[] = [];
          for (let i = 0; i < 24; i++) reps.push(pad.power(i + 1));
          // choose the rep whose length equals w - len
          let chosen: Str | null = null;
          for (const rp of reps) {
            const cond = lenR(rp).eq(w.sub(lenR(recv.t)));
            chosen = chosen ? ctx.If(cond, rp, chosen) : rp;
          }
          const need = w.sub(lenR(recv.t)).gt(num(ctx, 0));
          return { kind: "str", t: ctx.If(need, chosen!.concat(recv.t), recv.t) };
        }
        case "split": {
          // Split into at-most-N parts by literal separator (string theory
          // has no split; bounded reconstruction via uninterpreted shells is
          // unsound, so degrade unless the separator case is trivial).
          return { kind: "any" };
        }
        default:
          degrade(st, at, `string method .${m}`);
          return { kind: "any" };
      }
    }

    // ---- Map/Set methods ----
    if (isObj(recv) && (recv.fields.has("__map_entries") || recv.fields.has("__set_values"))) {
      const result = mapSetOp(recv, m, args, at, st);
      if ((m === "add" || m === "set" || m === "delete") && isObj(result) && ts.isPropertyAccessExpression(at.expression)) {
        const root = rootName(at.expression);
        if (root && frame.vars.has(root)) frame.vars.set(root, result);
      }
      return result;
    }

    degrade(st, at, `method .${m} on ${recv.kind}`);
    return { kind: "any" };
  };

  const strArgOrEmpty = (v: SymVal | undefined): Str =>
    v && isStr(v) ? v.t : ctx.String.val("");

  const countTrueBelow = (bs: Bool<"main">[], k: number): Num => {
    let acc = num(ctx, 0);
    for (let j = 0; j < k; j++) acc = ctx.If(bs[j]!, acc.add(num(ctx, 1)), acc);
    return acc;
  };

  const rebindArray = (oldArr: Extract<SymVal, { kind: "arr" }>, newArr: SymVal, at: ts.CallExpression, st: RunState, frame: Frame): SymVal => {
    // push() mutates in place: find the root variable holding this array.
    // Simplification: guarded code uses push on locals in loops; the for
    // unroll copies frames, so rebinding the RECEIVING variable is enough
    // when the receiver expression is an identifier.
    if (ts.isPropertyAccessExpression(at.expression)) {
      const root = rootName(at.expression);
      if (root) { frame.vars.set(root, newArr); return newArr; }
    }
    return newArr;
  };

  /** Invoke an arrow/function-literal argument (callback) concretely. */
  const invokeCallback = (
    cb: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
    args: SymVal[],
    st: RunState,
    depth: number,
    env?: Frame,
  ): SymVal => {
    const inner: Frame = { vars: new Map((env ?? frame).vars) }; // lexical closure
    cb.parameters.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) inner.vars.set(p.name.text, args[i] ?? { kind: "undef" });
      else if (ts.isArrayBindingPattern(p.name)) {
        p.name.elements.forEach((el, j) => {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && isArr(args[i])) {
            inner.vars.set(el.name.text, args[i].elems[j] ?? { kind: "undef" });
          }
        });
      }
    });
    const innerState = runState0();
    if (cb.body && ts.isBlock(cb.body)) execStmt(cb.body, inner, innerState, depth + 1);
    else if (cb.body) innerState.ret = evalExpr(cb.body, inner, innerState, depth + 1);
    const pushAll2 = <T,>(dst: T[], src: T[]): void => { if (src !== dst) for (const x of src) dst.push(x); };
    pushAll2(st.assumptions, innerState.assumptions);
    pushAll2(st.degradations, innerState.degradations);
    if (innerState.thrown) st.thrown = orFold(st.thrown ?? bool(ctx, false), innerState.thrown);
    // fold inner conditional returns (arrow bodies with early returns)
    let ret: SymVal | null = innerState.ret;
    for (let i = innerState.pendingRets.length - 1; i >= 0; i--) {
      const pr = innerState.pendingRets[i]!;
      ret = ret === null ? iteVal(pr.cond, pr.val, { kind: "undef" }) : iteVal(pr.cond, pr.val, ret);
    }
    // Shared-binding write-back: closures mutate captured vars (let cells).
    // Propagate changed values back to the DECLARING frame. Sound when the
    // call site's live frame is the declaration frame (top-level helper calls
    // like applyTo(...)); loop-body callbacks in the guarded subset never
    // write captured vars.
    if (env) {
      for (const [k, v] of inner.vars) {
        const old = env.vars.get(k);
        if (old === undefined || old === v) continue;
        const same =
          (isNum(old) && isNum(v) && old.t.toString() === v.t.toString()) ||
          (isStr(old) && isStr(v) && old.t.toString() === v.t.toString()) ||
          (isBool(old) && isBool(v) && old.t.toString() === v.t.toString()) ||
          (isArr(old) && isArr(v) && old.len.toString() === v.len.toString());
        if (!same) env.vars.set(k, v);
      }
    }
    return ret ?? { kind: "undef" };
  };

  /** Map/Set modeled as obj with special fields (bounded vector + len). */
  const mapSetOp = (recv: Extract<SymVal, { kind: "obj" }>, m: string, args: SymVal[], at: ts.Node, st: RunState): SymVal => {
    const entriesArr = recv.fields.get("__map_entries") ?? recv.fields.get("__set_values");
    if (!isArr(entriesArr)) return { kind: "any" };
    switch (m) {
      case "has": {
        const key = args[0];
        if (recv.fields.has("__map_entries") && isArr(entriesArr)) {
          // entries are {key, value} objs
          const eqs = entriesArr.elems.map((e) => (isObj(e) ? valEq(e.fields.get("key") ?? { kind: "any" }, key) : null));
          if (eqs.some((e) => e === null)) return { kind: "any" };
          let acc = bool(ctx, false);
          for (let k = 0; k < eqs.length; k++) {
            acc = acc.or(entriesArr.len.gt(num(ctx, k)).and(eqs[k]!));
          }
          return { kind: "bool", t: acc };
        }
        const eqs = entriesArr.elems.map((e) => valEq(e, args[0]));
        if (eqs.some((e) => e === null)) return { kind: "any" };
        let acc = bool(ctx, false);
        for (let k = 0; k < eqs.length; k++) {
          acc = acc.or(entriesArr.len.gt(num(ctx, k)).and(eqs[k]!));
        }
        return { kind: "bool", t: acc };
      }
      case "get": {
        const eqs = entriesArr.elems.map((e) => (isObj(e) ? valEq(e.fields.get("key") ?? { kind: "any" }, args[0]) : null));
        if (eqs.some((e) => e === null)) return { kind: "any" };
        let acc: SymVal = { kind: "undef" };
        for (let k = eqs.length - 1; k >= 0; k--) {
          const slotVal = entriesArr.elems[k];
          const got: SymVal = isObj(slotVal) ? slotVal.fields.get("value") ?? { kind: "undef" } : { kind: "undef" };
          acc = iteVal(entriesArr.len.gt(num(ctx, k)).and(eqs[k]!), got, acc);
        }
        return acc;
      }
      case "add":
      case "set": {
        const v = m === "set" && isObj(args[0]) === false
          ? { kind: "obj" as const, fields: new Map([["key", args[0]], ["value", args[1] ?? { kind: "undef" }]]) }
          : args[0];
        const entry = m === "set"
          ? { kind: "obj" as const, fields: new Map([["key", args[0]], ["value", args[1] ?? { kind: "undef" }]]) }
          : args[0];
        void v;
        const elems = entriesArr.elems.map((e, k) => {
          const exists = m === "set"
            ? isObj(e) ? (valEq(e.fields.get("key") ?? { kind: "any" }, args[0]) ?? bool(ctx, false)) : bool(ctx, false)
            : (valEq(e, args[0]) ?? bool(ctx, false));
          return iteVal(exists, entry, e);
        });
        const hadIt = entriesArr.elems.some((e) =>
          m === "set"
            ? isObj(e) && valEq(e.fields.get("key") ?? { kind: "any" }, args[0])
            : valEq(e, args[0]));
        const appendNew = hadIt === null || hadIt === undefined ? false : !hadIt;
        if (appendNew) elems.push(entry);
        const newLen = appendNew ? entriesArr.len.add(num(ctx, 1)) : entriesArr.len;
        const fields = new Map(recv.fields);
        fields.set(recv.fields.has("__map_entries") ? "__map_entries" : "__set_values", { kind: "arr", elems, len: newLen });
        return { kind: "obj", fields };
      }
      case "size": {
        return { kind: "num", t: entriesArr.len };
      }
      default:
        degrade(st, at, `map/set method .${m}`);
        return { kind: "any" };
    }
  };

  // new Map()/new Set()
  const evalNew = (call: ts.NewExpression, frame: Frame, st: RunState, depth: number): SymVal => {
    const name = ts.isIdentifier(call.expression) ? call.expression.text : "";
    if (name === "Map") {
      return { kind: "obj", fields: new Map([["__map_entries", arrOf([])]]) };
    }
    if (name === "Set") {
      return { kind: "obj", fields: new Map([["__set_values", arrOf([])]]) };
    }
    if (name === "Error" || name === "RangeError" || name === "TypeError") {
      return { kind: "obj", fields: new Map([["message", call.arguments?.[0] ? evalExpr(call.arguments[0], frame, st, depth) : { kind: "str", t: ctx.String.val("") }]]) };
    }
    degrade(st, call, `new ${name}`);
    return { kind: "any" };
  };

  const mathCall = (meth: string, args: SymVal[], at: ts.Node, st: RunState): SymVal => {
    const nums = args.map((a) => (isNum(a) ? a.t : null));
    if (nums.some((n) => n === null)) {
      if (meth === "min" || meth === "max") {
        // Math.min(x, y ?? inf) patterns: treat nulls as identity (skip)
        const present = nums.filter((n): n is Num => n !== null);
        if (present.length === 0) return { kind: "any" };
        return { kind: "num", t: present.reduce((a, b) => (meth === "min" ? minOf(a, b) : maxOf(a, b))) };
      }
      degrade(st, at, `Math.${meth} degraded arg`);
      return { kind: "any" };
    }
    const a = nums as Num[];
    switch (meth) {
      case "min": return { kind: "num", t: a.reduce((x, y) => minOf(x, y)) };
      case "max": return { kind: "num", t: a.reduce((x, y) => maxOf(x, y)) };
      case "abs": return { kind: "num", t: ctx.If(a[0].lt(num(ctx, 0)), a[0].neg(), a[0]) };
      case "round": {
        // JS Math.round = floor(x + 0.5)
        return { kind: "num", t: ctx.ToInt(a[0].add(num(ctx, 0.5))) };
      }
      case "floor": return { kind: "num", t: ctx.ToInt(a[0]) };
      case "ceil": {
        const f = ctx.ToInt(a[0]);
        return { kind: "num", t: ctx.If(f.eq(a[0]), f, f.add(num(ctx, 1))) };
      }
      case "trunc": return { kind: "num", t: ctx.If(a[0].ge(num(ctx, 0)), ctx.ToInt(a[0]), ctx.ToInt(a[0]).add(num(ctx, 1))) };
      default:
        degrade(st, at, `Math.${meth}`);
        return { kind: "any" };
    }
  };
  const minOf = (a: Num, b: Num): Num => ctx.If(a.le(b), a, b);
  const maxOf = (a: Num, b: Num): Num => ctx.If(a.ge(b), a, b);

  /* ---------------- run ---------------- */

  const frame: Frame = { vars: new Map(Object.entries(params)) };
  const st = runState0();
  execStmt(decl.body!, frame, st, 0);
  let finalRet = st.ret;
  for (let i = st.pendingRets.length - 1; i >= 0; i--) {
    const pr = st.pendingRets[i]!;
    finalRet = finalRet === null ? iteVal(pr.cond, pr.val, { kind: "undef" }) : iteVal(pr.cond, pr.val, finalRet);
  }
  return {
    exec: () => ({
      ret: finalRet,
      thrown: st.thrown ? { kind: "bool", t: st.thrown } : null,
      assumptions: st.assumptions,
      degradations: st.degradations,
    }),
  };
}

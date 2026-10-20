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
import type { Arith, Bool, Seq, Context, Term } from "./terms.js";

class TranslationUnsupported extends Error {
  constructor(readonly what: string, readonly file: string, readonly line: number) {
    super(`translation unsupported at ${file}:${line}: ${what}`);
  }
}

export type Z3 = Context;
export type Num = Arith;
type Str = Seq;

export type SymVal =
  | { kind: "num"; t: Num }
  | { kind: "bool"; t: Bool<"main"> }
  | { kind: "str"; t: Str }
  // nullUnder: set on obj/arr values that came out of a STRICT branch merge
  // with null/undefined on the other arm — the value is the obj/arr only
  // when nullUnder is FALSE (JS truthiness/field-access must respect it).
  | { kind: "arr"; elems: SymVal[]; len: Num; nullUnder?: Bool<"main"> }
  | { kind: "obj"; fields: Map<string, SymVal>; symFields?: Map<Term, { g: Bool<"main">; v: SymVal }>; nullUnder?: Bool<"main"> }
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
  /** The term context — carries `decls` (symbolic constants created while
   *  translating) so harnesses can emit `(declare-fun ...)` lines. */
  ctx: import("./terms.js").Context;
}

interface InterpreterOptions {
  maxArrayLength?: number; // default 8
  maxLoopIterations?: number; // default 8
  maxInlineDepth?: number; // default 12
  /** Implementations for INJECTED PORTS (public parameter seams like
   *  CompressionCore's `countTokens`). When a call resolves to a parameter
   *  with a port implementation, the hook runs instead of degrading. Ports
   *  are part of the module's public contract — hosts inject their own
   *  token counters — so this is composition, not bug-specific modeling. */
  portImpls?: Record<string, (arg: SymVal, ...rest: SymVal[]) => SymVal>;
}

/* ------------------------------------------------------------------ helpers */

const num = (ctx: Z3, v: number): Num => ctx.Real.val(v);
let numHoleCounter = 0;

const bool = (ctx: Z3, v: boolean): Bool<"main"> => ctx.Bool.val(v);

/** Constant side-channels: z3 expr objects created from JS constants are
 *  tagged so arithmetic/comparisons fold at construction time instead of
 *  bloating the symbolic DAG with trivially-decidable subterms. */
const strConst = {
  get: (t: Str | undefined): string | undefined => (t && typeof t.c === "string" ? t.c : undefined),
};
const numConst = {
  get: (t: Num | undefined): number | undefined => (t && typeof t.c === "number" ? t.c : undefined),
};
const boolConst = {
  get: (t: Bool<"main"> | undefined): boolean | undefined => (t && typeof t.c === "boolean" ? t.c : undefined),
};
const strc = (ctx: Z3, sv: string): Str => ctx.String.val(sv);
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
  const noKids = (t as unknown as { kids?: unknown[] }).kids;
  if (noKids !== undefined && noKids.length > 0) return undefined; // composite — never a literal
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
/** Literal check WITHOUT printing: reads the folded const tag only.
 *  Printing big DAG bools per-statement was exponential (the H2 OOM). */
function constBool(t: Bool<"main"> | null | undefined): boolean | null {
  if (t === null || t === undefined) return null;
  if (t.c === true) return true;
  if (t.c === false) return false;
  const op = (t as unknown as { op?: string }).op;
  if (op === "const" || op === "lit") {
    // non-folded literal — fall back to a SHORT print (no kids)
    const str = (t as unknown as { print(): string }).print ? (t as unknown as { print(): string }).print() : String(t);
    if (str === "true") return true;
    if (str === "false") return false;
  }
  return null;
}


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
    case "arr": {
      const tag = (v as { nullUnder?: Bool<"main"> }).nullUnder;
      if (!tag) return bool(ctx, true); // arrays are truthy
      const tc = boolConst.get(tag);
      return tc === undefined ? tag.not() : bool(ctx, !tc);
    }
    case "obj": {
      const tag = (v as { nullUnder?: Bool<"main"> }).nullUnder;
      if (!tag) return bool(ctx, true);
      const tc = boolConst.get(tag);
      return tc === undefined ? tag.not() : bool(ctx, !tc);
    }
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
  /** shared across branch copies — dedup identical diagnostics */
  seenDeg: Set<string>;
  seenAsum: Set<number>;
  /** hard unconditional return (dead code after `return`) */
  hardRet: boolean;
  thrown: Bool<"main"> | null;
  assumptions: Bool<"main">[];
  degradations: string[];
  breakCond: Bool<"main"> | null;
  continueCond: Bool<"main"> | null;
}

interface TranslateInput {
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
  /** Constant-folding Boolean combinators: z3's .or/.and do NOT simplify
   * `(or false false)` to `false`, and control-flow checks compare the
   * printed form against "true"/"false" — so every control Bool must be
   * built through these to keep literal chains folded. */
  const orFold = (a: Bool<"main"> | null, b: Bool<"main">): Bool<"main"> => {
    if (a === null) return b;
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
  // String(number): memoized per INPUT TERM (same number → same string —
  // stability properties across turns need the function property, a fresh
  // hole per call would fake instability).
  const numStrMemo = new Map<number, { kind: "str"; t: Str }>();
  const numToStringStrFor = (x: Num): { kind: "str"; t: Str } => {
    const key = x.hash();
    const hit = numStrMemo.get(key);
    if (hit) return hit;
    const hole = ctx.String.const("__numstr_" + numStrCounter++);
    const v: { kind: "str"; t: Str } = { kind: "str", t: hole };
    numStrMemo.set(key, v);
    return v;
  };
  const numToStringStr = (st: RunState): { kind: "str"; t: Str } => {
    const hole = ctx.String.const("__numstr_" + numStrCounter++);
    pushAsum(st, (ctx.ToReal(hole.length() as never) as Num).ge(num(ctx, 1)).and((ctx.ToReal(hole.length() as never) as Num).le(num(ctx, 19))));
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

  /** Convert a REAL JSON value (from concrete JSON.parse) into a SymVal. */
  const jsonToSymVal = (v: unknown, depth: number): SymVal => {
    if (v === null) return { kind: "null" };
    if (typeof v === "string") return { kind: "str", t: strc(ctx, v) };
    if (typeof v === "number") return { kind: "num", t: num(ctx, v) };
    if (typeof v === "boolean") return { kind: "bool", t: bool(ctx, v) };
    if (Array.isArray(v)) {
      if (v.length > (input.options?.maxArrayLength ?? 8)) return { kind: "any" };
      return arrOf(v.map((x) => jsonToSymVal(x, depth + 1)));
    }
    if (typeof v === "object") {
      const fields = new Map<string, SymVal>();
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        fields.set(k, jsonToSymVal(val, depth + 1));
      }
      return { kind: "obj", fields };
    }
    return { kind: "undef" };
  };

  // STRICT merge for VARIABLE bindings across branch joins: unlike mergeVal
  // (whose undef/null-loses erasure is only sound for never-read tail slots),
  // this preserves the maybe-null/maybe-undefined distinction via nullUnder —
  // `if (lastTextCore)` must stay a SYMBOLIC condition, not fold true.
  const mergeValStrict = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    const objSide = a.kind === "obj" || a.kind === "arr" ? a : b.kind === "obj" || b.kind === "arr" ? b : null;
    const nullish = b.kind === "null" || b.kind === "undef" ? b : a.kind === "null" || a.kind === "undef" ? a : null;
    if (objSide && nullish) {
      const aIsObj = a === objSide;
      // value is the obj when nullUnder is false:
      //   mergeValStrict(cond, obj, null) → nullUnder = ¬cond
      //   mergeValStrict(cond, null, obj) → nullUnder = cond
      const side = aIsObj ? notFold(cond) : cond;
      const prev = (objSide as { nullUnder?: Bool<"main"> }).nullUnder;
      const tag = prev ? orFold(prev, side) : side;
      return objSide.kind === "obj"
        ? { kind: "obj", fields: objSide.fields, nullUnder: tag }
        : { kind: "arr", elems: objSide.elems, len: objSide.len, nullUnder: tag };
    }
    return mergeVal(cond, a, b);
  };

  const mergeVal = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    // undef/null loses to any concrete value: out-of-bounds fallbacks in
    // element-access chains (guarded by length checks in real code) must not
    // poison the merged object. Real out-of-range access throws and is caught
    // by the replay lock.
    if (a.kind === "undef" && b.kind !== "undef") return mergeVal(cond.not(), b, { kind: "undef" }) === null ? { kind: "any" } : b;
    if (b.kind === "undef" && a.kind !== "undef") return a;
    if (a.kind === "null" && b.kind !== "null") return b;
    if (b.kind === "null" && a.kind !== "null") return a;
    if (a.kind !== b.kind) {
      return { kind: "any" };
    }
    switch (a.kind) {
      case "num": {
        const bb = b as Extract<SymVal, { kind: "num" }>;
        const ac = numC(a.t), bc = numC(bb.t);
        if (ac !== undefined && ac === bc) return a; // same constant: no ITE
        return { kind: "num", t: ctx.If(cond, a.t, bb.t) };
      }
      case "bool": {
        const bb = b as Extract<SymVal, { kind: "bool" }>;
        const ac = boolConst.get(a.t), bc = boolConst.get(bb.t);
        if (ac !== undefined && ac === bc) return a;
        return { kind: "bool", t: ctx.If(cond, a.t, bb.t) };
      }
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
        const la = numC(a.len), lb = numC(bb.len);
        if (la !== undefined && la === lb) return { kind: "arr", elems, len: a.len }; // same length: keep const
        return { kind: "arr", elems, len: ctx.If(cond, a.len, bb.len) };
      }
      case "obj": {
        const bb = b as Extract<SymVal, { kind: "obj" }>;
        const fields = new Map<string, SymVal>();
        for (const key of new Set([...a.fields.keys(), ...bb.fields.keys()])) {
          const va = a.fields.get(key);
          const vb = bb.fields.get(key);
          if (va && vb) fields.set(key, mergeVal(cond, va, vb));
          else if (va) fields.set(key, guardedNeutral(cond, va));
          else if (vb) fields.set(key, guardedNeutral(cond.not(), vb));
        }
        // merge symbolic-key bindings: present on one arm only means the
        // other arm never wrote it → undefined there (guard survives)
        // symFields entries carry their WRITE guard: a binding present on
        // one arm only keeps the path condition in .g (accumulated with
        // andFold) — the read fan tests (key = idx AND g) so a dead-path
        // write never shadows an older binding for the same string key.
        let symFields: Map<Term, { g: Bool<"main">; v: SymVal }> | undefined;
        const sa = a.symFields, sb = bb.symFields;
        if (sa || sb) {
          symFields = new Map<Term, { g: Bool<"main">; v: SymVal }>();
          const seen = new Set<Term>();
          const bothArm = (ga: Bool<"main">, va: SymVal, gb: Bool<"main">, vb: SymVal): { g: Bool<"main">; v: SymVal } => {
            const gT = andFold(cond, ga), gE = andFold(cond.not(), gb);
            const gLive = orFold(gT, gE);
            if (gLive === null) return { g: bool(ctx, false), v: va };
            let v: SymVal;
            if (constBool(gT) === true) v = va;
            else if (constBool(gE) === true) v = vb;
            else v = iteVal(gT, va, iteVal(gE, vb, neutralFor(vb)));
            return { g: gLive, v };
          };
          if (sa) for (const [kt, ea] of sa) {
            seen.add(kt);
            const eb = sb?.get(kt);
            symFields.set(kt, eb ? bothArm(ea.g, ea.v, eb.g, eb.v) : { g: andFold(cond, ea.g)!, v: ea.v });
          }
          if (sb) for (const [kt, eb] of sb) {
            if (seen.has(kt)) continue;
            symFields.set(kt, { g: andFold(cond.not(), eb.g)!, v: eb.v });
          }
        }
        if (process.env.VERIF_SYM_DEBUG && symFields) console.log("[symmerge]", [...symFields.keys()].map((k) => k.op).join(","));
        return { kind: "obj", fields, ...(symFields ? { symFields } : {}) };
      }
      default: return { kind: "any" };
    }
  };

  // A value written under a path condition into a container slot must leave
  // the IN-DOMAIN neutral in the untaken arm: downstream truthiness/membership
  // reads (len>0 etc.) treat neutral as "absent". Without this the undef-loses
  // merge rule silently drops the write's path guard (same failure class as
  // the Set-add phantom-slot bug).
  const guardedNeutral = (cond: Bool<"main">, v: SymVal): SymVal => {
    switch (v.kind) {
      case "str": return { kind: "str", t: ctx.If(cond, v.t, ctx.String.val("")) };
      case "num": return { kind: "num", t: ctx.If(cond, v.t, ctx.Real.val(0)) };
      case "bool": return { kind: "bool", t: ctx.If(cond, v.t, ctx.Bool.val(false)) };
      case "obj": case "arr": return iteStrict(cond, v, { kind: "null" });
      default: return v;
    }
  };

  const neutralFor = (v: SymVal): SymVal => {
    switch (v.kind) {
      case "str": return { kind: "str", t: ctx.String.val("") };
      case "num": return { kind: "num", t: ctx.Real.val(0) };
      case "bool": return { kind: "bool", t: ctx.Bool.val(false) };
      default: return { kind: "null" };
    }
  };

  const iteStrict = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    if (a === b) return a;
    const cb = constBool(cond);
    if (cb === true) return a;
    if (cb === false) return b;
    return mergeValStrict(cond, a, b);
  };

  const iteVal = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    if (a === b) return a;
    const cb = constBool(cond);
    if (cb === true) return a;
    if (cb === false) return b;
    // Equal constants fold to the constant: ite(cond, 1, 1) is 1 in every
    // model. Without this, branch merges lose const tags (two structurally
    // equal Terms are distinct objects) and everything downstream degrades
    // to symbolic — including array lengths that guard loop unrolling.
    if (a.kind === b.kind && a.kind === "num" && b.kind === "num") {
      const ca = numC(a.t), cbd = numC(b.t);
      if (ca !== undefined && ca === cbd) return a;
    }
    if (a.kind === b.kind && a.kind === "str" && b.kind === "str") {
      const ca = strConst.get(a.t), cb2 = strConst.get(b.t);
      if (ca !== undefined && ca === cb2) return a;
    }
    if (a.kind === b.kind && a.kind === "bool" && b.kind === "bool") {
      const ca = boolConst.get(a.t), cb2 = boolConst.get(b.t);
      if (ca !== undefined && ca === cb2) return a;
    }
    if (a.kind === "undef" && b.kind === "undef") return a;
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
    if (t !== null) {
      const bb = b();
      // Prefer exact truthiness when both sides coerce: `(a && b)` in a
      // boolean context is `truthy(a) ∧ truthy(b)`. Operand-identity
      // (`a && b` evaluating to `a` when falsy) is only observable via
      // value-equality/aliasing patterns absent from the guarded subset.
      const tbv = truthy(ctx, bb);
      if (tbv !== null) return { kind: "bool", t: andFold(t, tbv) };
      return iteVal(t, bb, a.kind === "bool" ? { kind: "bool", t: t } : a);
    }
    if (t === null) return { kind: "any" };
    return iteVal(t, b(), a.kind === "bool" ? { kind: "bool", t: t } : a);
  };

  const jsNullish = (a: SymVal, b: () => SymVal): SymVal =>
    iteVal(a.kind === "null" || a.kind === "undef" ? bool(ctx, true) : bool(ctx, false), b(), a);

  /* ---------------- statements ---------------- */

  const runState0 = (): RunState => ({
    ret: null, pendingRets: [], hardRet: false, thrown: null,
    assumptions: [], degradations: [], seenDeg: new Set(), seenAsum: new Set(),
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
      const bcT = bc !== null && constBool(bc) !== false;
      const ccT = cc !== null && constBool(cc) !== false;
      if (bcT || ccT) {
        const stopCond = bc && cc ? orFold(bc as Bool<"main">, cc as Bool<"main">) : ((bc ?? cc) as Bool<"main">);
        if (i + 1 < stmts.length && constBool(stopCond) !== true) {
          const f2: Frame = { vars: new Map(frame.vars) };
          const s2: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
          execSeq(stmts.slice(i + 1), f2, s2, depth);
          mergeBranch(frame, st, notFold(stopCond), f2, s2, null, null);
        }
        break;
      }
      if (st.hardRet) break;
      if (constBool(st.thrown) === true) break;
    }
  };

  let stmtCount = 0;
  const stmtLines = new Map<number, number>();
  const execStmt = (stmt: ts.Statement, frame: Frame, st: RunState, depth: number): void => {
    if (process.env.VERIF_LINE_DEBUG) { const sf = stmt.getSourceFile?.(); if (sf?.fileName?.includes("refs.ts")) console.log("[stmt]", stmt.getStart(sf), ts.SyntaxKind[stmt.kind], "cc:", st.continueCond === null ? "null" : "term"); }
    if (st.hardRet) return;
    if (constBool(st.thrown) === true) return;
    if (constBool(st.breakCond) === true) return;
    if (constBool(st.continueCond) === true) return;
    if (ts.isBlock(stmt)) { execSeq(stmt.statements, frame, st, depth); return; }
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt)) return; // type-level only — erased
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer ? evalExpr(d.initializer, frame, st, depth) : { kind: "undef" as const };
        if (ts.isIdentifier(d.name)) {
          frame.vars.set(d.name.text, init);
        } else if (ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            const propName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            frame.vars.set(el.name.text, member(init, propName, el, st));
          }
        } else if (ts.isArrayBindingPattern(d.name)) {
          const arrV = init.kind === "arr" ? init : { kind: "any" as const };
          if (arrV.kind === "arr") d.name.elements.forEach((el, j) => {
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) return;
            frame.vars.set(el.name.text, elementAccess(arrV, { kind: "num", t: num(ctx, j) }, el, st));
          });
        } else {
          bad(stmt, "non-identifier declaration");
        }
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
      // Dead-branch pruning: a constant condition executes only the live
      // arm, in-frame. Eager both-arm execution would force provably-dead
      // code (e.g. a regex in a never-taken branch) to be translatable.
      const cb = constBool(tb);
      if (cb === true) { execStmt(stmt.thenStatement, frame, st, depth); return; }
      if (cb === false) { if (stmt.elseStatement) execStmt(stmt.elseStatement, frame, st, depth); return; }
      const thenFrame: Frame = { vars: new Map(frame.vars) };
      const thenState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
      execStmt(stmt.thenStatement, thenFrame, thenState, depth);
      let elseFrame: Frame | null = null;
      let elseState: RunState | null = null;
      if (stmt.elseStatement) {
        elseFrame = { vars: new Map(frame.vars) };
        elseState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        execStmt(stmt.elseStatement, elseFrame, elseState, depth);
      }
      mergeBranch(frame, st, tb, thenFrame, thenState, elseFrame, elseState);
      return;
    }
    if (ts.isForOfStatement(stmt)) {
      // Unroll over bounded array slots.
      let iter = evalExpr(stmt.expression, frame, st, depth);
      if (iter.kind === "obj" && iter.fields.has("__set_values")) {
        // for (const k of someSet) — iterate the Set-model's value list
        const vals = iter.fields.get("__set_values")!;
        iter = vals.kind === "arr" ? vals : ({ kind: "arr", elems: [], len: num(ctx, 0) } as SymVal);
      }
      if (!isArr(iter)) { degrade(st, stmt, "for-of over non-array"); return; }
      bindForVar(stmt.initializer, { kind: "undef" }, frame);
      // Dead-slot pruning: when the array length is a KNOWN constant, skip
      // slots beyond it entirely — executing dead iterations would pollute
      // live state with out-of-bounds degradations and any-values.
      const lenC = numC(iter.len);
      const slotCeil = lenC !== undefined ? Math.min(iter.elems.length, Math.ceil(lenC)) : iter.elems.length;
      for (let k = 0; k < slotCeil; k++) {
        const guard = andFold(iter.len.gt(num(ctx, k)), st.breakCond ?? bool(ctx, true));
        const prBefore = st.pendingRets.length;
        const elemFrame: Frame = { vars: new Map(frame.vars) };
        const elemState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        bindForVar(stmt.initializer, iter.elems[k], elemFrame);
        execStmt(stmt.statement, elemFrame, elemState, depth);
        if (process.env.VERIF_SYM_DEBUG) { const mv = frame.vars.get("map"); const br = mv && mv.kind === "obj" ? mv.fields.get("byRaw") : undefined; console.log("[iter-end k=" + k + "] byRaw sym:", br && br.kind === "obj" ? ((br as any).symFields ? [...(br as any).symFields.keys()].length : "none") : String(br?.kind), "fields:", br && br.kind === "obj" ? br.fields.size : "?"); }
        mergeBranch(frame, st, guard, elemFrame, elemState, null, null);
        if (process.env.VERIF_SYM_DEBUG) { const mv = frame.vars.get("map"); const br = mv && mv.kind === "obj" ? mv.fields.get("byRaw") : undefined; console.log("[post-merge k=" + k + "] byRaw sym:", br && br.kind === "obj" ? ((br as any).symFields ? [...(br as any).symFields.keys()].length : "none") : String(br?.kind), "fields:", br && br.kind === "obj" ? br.fields.size : "?"); }
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || constBool(st.thrown) === true || constBool(st.breakCond) === true) break;
        // A conditional return/throw fired under this iteration's guard: a
        // real execution would have left the whole function — treat it as a
        // loop exit (post-loop statements run under ¬exit via rest-on-copy).
        if (st.pendingRets.length > prBefore || (st.thrown !== null && constBool(st.thrown) === undefined)) {
          st.breakCond = orFold(st.breakCond, guard);
          break;
        }
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
        if (constBool(tb) === false) {
          pushAsum(st, bool(ctx, true));
          return;
        }
        const iterFrame: Frame = { vars: new Map(frame.vars) };
        const prBefore = st.pendingRets.length;
        const iterState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        execStmt(stmt.statement, iterFrame, iterState, depth);
        // continue: still run the increment — handled by running increment
        // on iterFrame after body (continue skips rest of body only).
        if (stmt.incrementor) evalExpr(stmt.incrementor, iterFrame, iterState, depth);
        mergeBranch(frame, st, tb, iterFrame, iterState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || constBool(st.thrown) === true || constBool(st.breakCond) === true) return;
        if (st.pendingRets.length > prBefore || (st.thrown !== null && constBool(st.thrown) === undefined)) {
          st.breakCond = orFold(st.breakCond, tb as Bool<"main">);
          return;
        }
      }
      // Loop may need more than K iterations: assume it finished.
      const c = stmt.condition ? evalExpr(stmt.condition, frame, st, depth) : null;
      const tb = c ? truthy(ctx, c) : bool(ctx, true);
      if (tb) pushAsum(st, notFold(tb as Bool<"main">));
      return;
    }
    if (ts.isWhileStatement(stmt)) {
      for (let k = 0; k < K; k++) {
        const c = evalExpr(stmt.expression, frame, st, depth);
        const tb = truthy(ctx, c);
        if (tb === null) { degrade(st, stmt, "while condition degraded"); return; }
        const iterFrame: Frame = { vars: new Map(frame.vars) };
        const prBefore = st.pendingRets.length;
        const iterState: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        execStmt(stmt.statement, iterFrame, iterState, depth);
        mergeBranch(frame, st, tb, iterFrame, iterState, null, null);
        st.continueCond = null; // continue ends only this iteration
        if (st.hardRet || constBool(st.thrown) === true || constBool(st.breakCond) === true) return;
        if (st.pendingRets.length > prBefore || (st.thrown !== null && constBool(st.thrown) === undefined)) {
          st.breakCond = orFold(st.breakCond, tb as Bool<"main">);
          return;
        }
      }
      const c = evalExpr(stmt.expression, frame, st, depth);
      const tb = truthy(ctx, c);
      if (tb) pushAsum(st, notFold(tb as Bool<"main">));
      return;
    }
    if (ts.isBreakStatement(stmt)) { st.breakCond = bool(ctx, true); return; }
    if (ts.isContinueStatement(stmt)) { st.continueCond = bool(ctx, true); return; }
    if (ts.isSwitchStatement(stmt)) {
      // Desugar to if-chain over case expressions (guarded code has small
      // switches), with JS entry semantics: a clause's body runs when the
      // discriminant matches (or `default` is reached with no prior match)
      // AND no earlier entered clause broke out. Dead clauses (entry folds
      // false) are never executed — eager execution of provably-dead bodies
      // wasted terms and forced untranslatable code into the model.
      const disc = evalExpr(stmt.expression, frame, st, depth);
      let matched = bool(ctx, false); // some earlier case compared equal
      let stopped: Bool<"main"> | null = null; // an entered clause broke out
      for (const clause of stmt.caseBlock.clauses) {
        let enter: Bool<"main">;
        if (ts.isCaseClause(clause)) {
          const cv = evalExpr(clause.expression, frame, st, depth);
          const eq = valEq(disc, cv);
          if (eq === null) {
            bad(clause.expression, "case comparison degraded");
            matched = bool(ctx, true); // unconstrained — conservative over-approx
            enter = bool(ctx, true);
          } else {
            matched = orFold(matched, eq);
            enter = eq;
          }
        } else {
          enter = notFold(matched);
        }
        if (stopped) enter = andFold(enter, notFold(stopped));
        const cf: Frame = { vars: new Map(frame.vars) };
        const cs: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
        const enterC = constBool(enter);
        if (enterC === false) continue; // dead clause: never executed
        for (const inner of clause.statements) execStmt(inner, cf, cs, depth);
        // JS semantics: `break` inside a switch exits the SWITCH, not the
        // enclosing loop. The clause's breakCond is consumed here — only
        // return/throw/continue propagate outward.
        const broke = cs.breakCond;
        cs.breakCond = null;
        if (enterC === true) {
          // Live clause: apply in-frame (no ITE wrapper needed).
          for (const [k2, v] of cf.vars) frame.vars.set(k2, v);
          st.ret = cs.ret ?? st.ret; st.hardRet = st.hardRet || cs.hardRet;
          st.thrown = cs.thrown ?? st.thrown;
          st.breakCond = st.breakCond ? orFold(st.breakCond, cs.breakCond ?? bool(ctx, false)) : cs.breakCond;
          st.continueCond = st.continueCond ? orFold(st.continueCond, cs.continueCond ?? bool(ctx, false)) : cs.continueCond;
          st.pendingRets.push(...cs.pendingRets);
          if (constBool(broke) === true) stopped = bool(ctx, true);
          if (st.hardRet || constBool(st.thrown) === true) return;
          continue;
        }
        if (broke) stopped = orFold(stopped ?? bool(ctx, false), andFold(enter, broke));
        mergeBranch(frame, st, enter, cf, cs, null, null);
        if (st.hardRet || constBool(st.thrown) === true) return;
      }
      return;
    }
    if (ts.isTryStatement(stmt)) {
      const tf: Frame = { vars: new Map(frame.vars) };
      const ts_: RunState = { ...st, ret: null, pendingRets: [], hardRet: false, thrown: null, breakCond: null, continueCond: null, assumptions: st.assumptions, degradations: st.degradations };
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
      // shared accumulators — no merge needed
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
          // positional destructuring: `[a, b] = pairArray`
          for (let j = 0; j < d.name.elements.length; j++) {
            const el = d.name.elements[j];
            if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
            const v: SymVal = isArr(value) ? (value.elems[j] ?? { kind: "undef" }) : { kind: "undef" };
            frame.vars.set(el.name.text, v);
          }
        }
      }
    }
  };

  const pushAsum = (st: RunState, t: Bool<"main">): void => {
    if (st.seenAsum === undefined) st.seenAsum = new Set();
    const k = t.hash();
    if (st.seenAsum.has(k)) return;
    st.seenAsum.add(k);
    st.assumptions.push(t);
  };

  const degrade = (st: RunState, node: ts.Node, what: string): void => {
    const key = `${what} @${lineOf(node)}`;
    if (st.seenDeg === undefined) st.seenDeg = new Set();
    if (st.seenDeg.has(key)) return;
    st.seenDeg.add(key);
    st.degradations.push(key);
  };

  const mergeBranch = (
    frame: Frame,
    st: RunState,
    cond: Bool<"main">,
    thenFrame: Frame, thenState: RunState,
    elseFrame: Frame | null, elseState: RunState | null,
  ): void => {

    // Merge variables — a proper three-way merge:
    //   both branches wrote  → ite(cond, thenVal, elseVal)   (pre-branch value is dead)
    //   only then wrote     → ite(cond, thenVal, cur)
    //   only else wrote     → ite(¬cond, elseVal, cur)
    //   neither wrote       → keep cur
    // Sequential two-pass merging (then into frame, then else into the
    // already-merged frame) builds nested ite(¬c, e, ite(c, t, cur)) terms
    // that no constant folding can ever reduce — and worse, when BOTH
    // branches assigned, the stale pre-branch value survives inside the
    // nested term shape. Reference identity distinguishes written names:
    // untouched bindings carry the SAME object reference into branch copies.
    const names = new Set<string>([...thenFrame.vars.keys(), ...(elseFrame ? [...elseFrame.vars.keys()] : [])]);
    for (const name of names) {
      const cur = frame.vars.get(name);
      const tv = thenFrame.vars.get(name);
      const ev = elseFrame ? elseFrame.vars.get(name) : undefined;
      const wroteT = tv !== undefined && tv !== cur;
      const wroteE = ev !== undefined && ev !== cur;
      if (wroteT && wroteE) frame.vars.set(name, iteStrict(cond, tv, ev));
      else if (wroteT) frame.vars.set(name, cur !== undefined ? iteStrict(cond, tv, cur) : tv);
      else if (wroteE) frame.vars.set(name, cur !== undefined ? iteStrict(cond.not(), ev, cur) : ev);
    }
    // ret merge: branch returns become PENDING conditional returns — the
    // statements after the if still execute (they produce the other path's
    // value); the final return value folds all pending conditions at the end.
    if (thenState.hardRet || thenState.ret !== null) {
      const tv = thenState.ret ?? { kind: "undef" };
      st.pendingRets.push({ cond, val: tv });
    }
    // Conditional returns from INSIDE the branch (e.g. `if (x) return` in a
    // loop body) live only in pendingRets — hardRet/ret stay null, so lifting
    // them under the same if would DROP them: the while-loop early-return
    // detection compares pendingRets counts and never fires; the loop then
    // unrolls to exhaustion and the post-loop `throw` poisons the caller.
    for (const pr of thenState.pendingRets) st.pendingRets.push({ cond: andFold(cond, pr.cond), val: pr.val });
    if (elseState && (elseState.hardRet || elseState.ret !== null)) {
      const ev = elseState.ret ?? { kind: "undef" };
      st.pendingRets.push({ cond: notFold(cond), val: ev });
    }
    for (const pr of elseState?.pendingRets ?? []) st.pendingRets.push({ cond: andFold(notFold(cond), pr.cond), val: pr.val });
    // Flags merge — normalize provably-false flags back to null: a
    // const-false TERM is not nullish, and every consumer does
    // `st.flag ?? default`; a lingering false term flips loop guards
    // (for-of iteration k>=1 dying to `andFold(guard, false)`).
    const tThrown = thenState.thrown;
    const eThrown = elseState?.thrown ?? null;
    const tB = tThrown ?? bool(ctx, false);
    const eB = eThrown ?? bool(ctx, false);
    const mergedThrow = st.thrown ?? bool(ctx, false);
    const nt = orFold(orFold(mergedThrow, andFold(cond, tB)), andFold(notFold(cond), eB));
    st.thrown = constBool(nt) === false ? null : nt;
    const tBrk = thenState.breakCond ?? null;
    const eBrk = elseState?.breakCond ?? null;
    const mergedBrk = st.breakCond ?? bool(ctx, false);
    const nb = orFold(orFold(mergedBrk, tBrk ? andFold(cond, tBrk) : bool(ctx, false)), eBrk ? andFold(notFold(cond), eBrk) : bool(ctx, false));
    st.breakCond = constBool(nb) === false ? null : nb;
    const tCnt = thenState.continueCond ?? null;
    const eCnt = elseState?.continueCond ?? null;
    const mergedCnt = st.continueCond ?? bool(ctx, false);
    const nc = orFold(orFold(mergedCnt, tCnt ? andFold(cond, tCnt) : bool(ctx, false)), eCnt ? andFold(notFold(cond), eCnt) : bool(ctx, false));
    st.continueCond = constBool(nc) === false ? null : nc;
    const pushAll = <T,>(dst: T[], src: T[]): void => { if (src !== dst) for (const x of src) dst.push(x); };
    pushAll(st.assumptions, thenState.assumptions); if (elseState) pushAll(st.assumptions, elseState.assumptions);
    // degradations shared (single array across copies)
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
      if (typeof (a.t as { eq?: unknown }).eq !== "function" || typeof (b.t as { eq?: unknown }).eq !== "function") {
        return null;
      }
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
    if (ts.isNewExpression(expr)) {
      return evalNew(expr, frame, st, depth);
    }
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
      if (expr.text === "undefined") return { kind: "undef" };
      bad(expr, `unbound identifier ${expr.text}`);
    }
    if (ts.isParenthesizedExpression(expr)) return evalExpr(expr.expression, frame, st, depth);
    if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return evalExpr(expr.expression, frame, st, depth);
    }
    if (ts.isTypeOfExpression(expr)) {
      const v = evalExpr(expr.expression, frame, st, depth);
      switch (v.kind) {
        case "str": return { kind: "str", t: ctx.String.val("string") };
        case "num": return { kind: "str", t: ctx.String.val("number") };
        case "bool": return { kind: "str", t: ctx.String.val("boolean") };
        case "obj": case "null": return { kind: "str", t: ctx.String.val("object") };
        case "arr": return { kind: "str", t: ctx.String.val("object") };
        case "fn": return { kind: "str", t: ctx.String.val("function") };
        case "undef": return { kind: "str", t: ctx.String.val("undefined") };
        default: degrade(st, expr, "typeof on degraded value"); return { kind: "any" };
      }
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
      const cb = constBool(c);
      if (cb === true) return evalExpr(expr.whenTrue, frame, st, depth);
      if (cb === false) return evalExpr(expr.whenFalse, frame, st, depth);
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
          pushAsum(st, (ctx.ToReal(hole.length() as never) as Num).ge(num(ctx, 1)).and((ctx.ToReal(hole.length() as never) as Num).le(num(ctx, 8))));
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
      let symFields: Map<Term, { g: Bool<"main">; v: SymVal }> | undefined;
      const fields = new Map<string, SymVal>();
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const v = evalExpr(prop.expression, frame, st, depth);
          if (isObj(v)) {
            for (const [k2, v2] of v.fields) fields.set(k2, v2);
            if (v.symFields) symFields = new Map(v.symFields);
          }
          else degrade(st, prop, "object spread of non-object");
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          fields.set(prop.name.text, evalExpr(prop.initializer, frame, st, depth));
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          fields.set(prop.name.text, evalExpr(prop.name, frame, st, depth));
        } else {
          degrade(st, prop, "object literal member");
        }
      }
      return { kind: "obj", fields, ...(symFields ? { symFields } : {}) };
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
    if (ts.isNonNullExpression(expr)) {
      // `x!` non-null assertion — type-level only, value is x
      return evalExpr(expr.expression, frame, st, depth);
    }
    if (ts.isRegularExpressionLiteral(expr)) {
      // /pat/flags — regex-literal carrier; String.replace/test model it.
      return { kind: "obj", fields: new Map([["__regex", { kind: "str", t: ctx.String.val(expr.text) }]]) } as SymVal;
    }
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
    if (ts.isDeleteExpression(expr)) {
      // `delete obj[k]` / `delete obj.k`: the slot reads as undefined
      // afterwards. Modeled as an undef store (missing field ≡ undef).
      const t = expr.expression;
      if (ts.isElementAccessExpression(t)) {
        const base = evalExpr(t.expression, frame, st, depth);
        const idx = evalExpr(t.argumentExpression, frame, st, depth);
        if (isObj(base) && isStr(idx)) {
          const fields = new Map(base.fields);
          for (const key of [...fields.keys()]) {
            fields.set(key, iteVal(idx.t.eq(ctx.String.val(key)), { kind: "undef" }, fields.get(key)!));
          }
          // symbolic-key delete: drop symFields entries whose key matches the
          // index term (structural identity) — the merge machinery then folds
          // the removal into the enclosing path guard.
          let symFields: Map<Term, { g: Bool<"main">; v: SymVal }> | undefined;
          if (base.symFields) {
            symFields = new Map(base.symFields);
            for (const kt of [...symFields.keys()]) {
              if (kt === idx.t || (kt.hash !== undefined && idx.t.hash !== undefined && kt.hash() === idx.t.hash())) {
                symFields.delete(kt);
              }
            }
          }
          const newObj: SymVal = { kind: "obj", fields, ...(symFields ? { symFields } : {}) };
          writeLValue(t.expression, newObj, frame, st, depth);
          return { kind: "bool", t: bool(ctx, true) };
        }
      } else if (ts.isPropertyAccessExpression(t)) {
        const base = evalExpr(t.expression, frame, st, depth);
        if (isObj(base)) {
          const fields = new Map(base.fields);
          fields.set(t.name.text, { kind: "undef" });
          writeLValue(t.expression, { kind: "obj", fields }, frame, st, depth);
          return { kind: "bool", t: bool(ctx, true) };
        }
      }
      return { kind: "bool", t: bool(ctx, true) };
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
      if (!isStr(p)) {
        return { kind: "any" };
      }
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
        const sv = strConst.get(obj.t);
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
      // missing field reads as `undefined` in JS (NOT unknown/any) —
      // `!!message.toolName` on a field-less message must fold to false,
      // not poison the condition
      return v ?? { kind: "undef" };
    }
    if (obj.kind === "null" || obj.kind === "undef") return { kind: "undef" };
    return { kind: "any" };
  };


  const elementAccess = (obj: SymVal, idx: SymVal, at: ts.Node, st: RunState): SymVal => {
    if (isArr(obj) && isNum(idx)) {
      const ic = numC(idx.t);
      if (ic !== undefined && Number.isInteger(ic)) {
        const rv = ic >= 0 && ic < obj.elems.length ? obj.elems[ic]! : { kind: "undef" as const };
        return rv;
      }
      // Chain of If(idx == k, elems[k]) for k < N.
      let acc: SymVal = { kind: "undef" };
      for (let k = obj.elems.length - 1; k >= 0; k--) {
        acc = iteVal(numEq(ctx, idx.t, num(ctx, k)), obj.elems[k], acc);
      }
      return acc;
    }
    if (isObj(obj) && isStr(idx)) {
      // Dynamic key: pick by string equality over known keys — concrete
      // fields first, then symbolic-key bindings (symFields).
      let acc: SymVal = { kind: "undef" };
      for (const [key, v] of obj.fields) {
        acc = iteVal(idx.t.eq(ctx.String.val(key)), v, acc);
      }
      if (obj.symFields) {
        for (const [kt, e] of obj.symFields) {
          acc = iteVal(andFold(idx.t.eq(kt), e.g)!, e.v, acc);
        }
      }
      return acc;
    }
    return { kind: "any" };
  };

  const ASSIGN_OPS: ts.SyntaxKind[] = [
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ];

  /** Recursive lvalue store with value semantics: rebuilding a[i].f = v
   *  through the chain (slot-write the array, then rebind upward). Real JS
   *  uses references — `host = msgs[k]; host.f = v` is visible via msgs[k]
   *  — so chained stores must rewrite every container on the path. */
  const writeLValue = (target: ts.Expression, value: SymVal, frame: Frame, st: RunState, depth: number): boolean => {
    if (ts.isNonNullExpression(target)) return writeLValue(target.expression, value, frame, st, depth);
    if (ts.isIdentifier(target)) { frame.vars.set(target.text, value); return true; }
    if (ts.isPropertyAccessExpression(target)) {
      const base = evalExpr(target.expression, frame, st, depth);
      if (isObj(base)) {
        const fields = new Map(base.fields);
        fields.set(target.name.text, value);
        const newObj = { kind: "obj", fields, ...(base.symFields ? { symFields: new Map(base.symFields) } : {}) } as SymVal;
        // JS reference semantics: the same object is reachable from its
        // containers (`const host = msgs[k]` / find()) — a field write must
        // be visible through every array (and one level of object field)
        // that still holds this exact value. Value-copy alone rebinds only
        // the local alias and the container keeps the stale object.
        for (const [vn, vv] of frame.vars) {
          if (isArr(vv)) {
            let hit = false;
            const elems = vv.elems.map((e) => { if (e === base) { hit = true; return newObj; } return e; });
            if (hit) frame.vars.set(vn, { kind: "arr", elems, len: vv.len } as SymVal);
          } else if (isObj(vv) && vv !== base) {
            let hit = false;
            const nf: Map<string, SymVal> = new Map(vv.fields);
            for (const [fk, fv] of nf) if (fv === base) { nf.set(fk, newObj); hit = true; }
            if (hit) frame.vars.set(vn, { kind: "obj", fields: nf, ...(vv.symFields ? { symFields: new Map(vv.symFields) } : {}) } as SymVal);
          }
        }
        return writeLValue(target.expression, newObj, frame, st, depth);
      }
      return false;
    }
    if (ts.isElementAccessExpression(target)) {
      const base = evalExpr(target.expression, frame, st, depth);
      const idx = evalExpr(target.argumentExpression, frame, st, depth);
      if (isArr(base) && isNum(idx)) {
        const elems = base.elems.map((e, k) => iteVal(numEq(ctx, idx.t, num(ctx, k)), value, e));
        if (base.elems.length < N) {
          elems.push(iteVal(numEq(ctx, idx.t, num(ctx, base.elems.length)), value, { kind: "undef" }));
        }
        // a[i] = v with i ≥ len grows the array to i+1
        const grown = iteVal(idx.t.gt(base.len), { kind: "num", t: idx.t.add(num(ctx, 1)) }, { kind: "num", t: base.len });
        return writeLValue(target.expression, { kind: "arr", elems, len: (grown as { t: Num }).t } as never, frame, st, depth);
      }
      if (process.env.VERIF_SYM_DEBUG) console.log("[elemw-entry]", (base as {kind:string}).kind, (idx as {kind:string}).kind);
      if (isObj(base) && isStr(idx)) {
        // Record write: obj[key] = v. Const keys (the common case — ids,
        // refs) write the field directly. Symbolic keys fan out over the
        // fields that already exist AND record a symFields binding so the
        // write is observable when the key matches nothing present (the
        // solver decides equality).
        const fields = new Map(base.fields);
        const idxC = idx.t.c;
        if (typeof idxC === "string" && idx.t.sort === "String" && (idx.t.kids?.length ?? 0) === 0) {
          fields.set(idxC, value);
        } else {
          for (const key of [...fields.keys()]) {
            fields.set(key, iteVal(idx.t.eq(ctx.String.val(key)), value, fields.get(key)!));
          }
          const symFields = new Map(base.symFields ?? []);
          // same key-TERM: the new write replaces it (last write wins for
          // identical terms); equal-but-distinct terms resolve via the read
          // fan's guard, which falls through dead writes.
          symFields.delete(idx.t);
          symFields.set(idx.t, { g: bool(ctx, true), v: value });
          if (process.env.VERIF_SYM_DEBUG) console.log("[symw]", idx.t.op, (value as {kind:string}).kind, "sf-size", symFields.size);
          return writeLValue(target.expression, { kind: "obj", fields, symFields } as SymVal, frame, st, depth);
        }
        return writeLValue(target.expression, { kind: "obj", fields } as SymVal, frame, st, depth);
      }
      return false;
    }
    return false;
  };

  const evalBinary = (expr: ts.BinaryExpression, frame: Frame, st: RunState, depth: number): SymVal => {
    const op = expr.operatorToken.kind;
    // Assignments (x = …, x += …) are BinaryExpressions: they MUST be
    // handled here at the TOP of evalBinary — evalExpr's generic
    // isBinaryExpression dispatch reaches this function for every binary
    // node, and a fallthrough to applyBinop would evaluate but never STORE.
    if (ASSIGN_OPS.includes(op)) {
      const compound = compoundOpKind(op);
      const rhs = op === ts.SyntaxKind.EqualsToken ? evalExpr(expr.right, frame, st, depth) : null;
      const cur = compound ? evalExpr(expr.left, frame, st, depth) : null;
      const value = compound && cur ? applyBinop(compound, cur, evalExpr(expr.right, frame, st, depth), expr, st) : rhs;
      if (value && writeLValue(expr.left, value, frame, st, depth)) return value;
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
    // Mixed num/str `+` is JS string concatenation — route through the
    // memoized number→string rendering (same number always same string).
    if (op === ts.SyntaxKind.PlusToken && isNum(l) && isStr(r)) {
      const ls = numToStringStrFor(l.t);
      return { kind: "str", t: ls.t.concat(r.t) };
    }
    if (op === ts.SyntaxKind.PlusToken && isStr(l) && isNum(r)) {
      const rs = numToStringStrFor(r.t);
      return { kind: "str", t: l.t.concat(rs.t) };
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

  let reTestN = 0;
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
        if (meth === "isFinite" && !isNum(argVals[0])) return { kind: "bool", t: bool(ctx, false) };
        if (meth === "isInteger" && !isNum(argVals[0])) return { kind: "bool", t: bool(ctx, false) };
        if ((meth === "parseInt" || meth === "parseFloat") && isStr(argVals[0])) {
          return { kind: "num", t: argVals[0].t.toInt() };
        }
      }
      if (ns === "Math") return mathCall(meth, argVals, call, st);
      if (ns === "Array" && meth === "isArray") {
        if (argVals[0].kind === "arr") return { kind: "bool", t: bool(ctx, true) };
        // undefined/null/bool/fn are provably not arrays (JS typeof)
        if (argVals[0].kind !== "any") return { kind: "bool", t: bool(ctx, false) };
        degrade(st, call, "Array.isArray on degraded value");
        return { kind: "any" };
      }
      if (ns === "String" && meth === "fromCharCode") return { kind: "str", t: ctx.String.val("") }; // degraded, content-neutral
      if (ns === "JSON") {
        // JSON.parse of a KNOWN string is pure and deterministic — run the
        // real implementation and convert. Degraded args still degrade.
        if (meth === "parse") {
          const a0 = argVals[0];
          if (isStr(a0)) {
            const lit = strConst.get(a0.t);
            if (lit !== undefined) {
              try { return jsonToSymVal(JSON.parse(lit), depth); } catch { return { kind: "null" }; }
            }
          }
        }
        degrade(st, call, `JSON.${meth}`); return { kind: "any" };
      }
      if (ns === "Object" || ns === "Boolean") { degrade(st, call, `${ns}.${meth}`); return { kind: "any" }; }
    }

    // Method calls on values -------------------------------------------
    if (ts.isPropertyAccessExpression(calleeExpr)) {
      // optional call `x.m?.(…)`: absent method reads as undefined (no throw)
      if (call.questionDotToken !== undefined && !(input.options?.portImpls && ("__method_" + calleeExpr.name.text) in input.options.portImpls)) {
        const r0 = evalExpr(calleeExpr.expression, frame, st, depth);
        if (isObj(r0)) {
          const mv = r0.fields.get(calleeExpr.name.text);
          if (mv === undefined || mv.kind === "undef" || mv.kind === "null") return { kind: "undef" };
        }
      }
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
      return { kind: "bool", t: bool(ctx, false) }; // undefined/null/non-number
    }
    if (name === "Number" || name === "String") {
      const a0 = argVals[0];
      if (name === "String") {
        if (isStr(a0)) return a0;
        if (isNum(a0)) return numToStringStrFor(a0.t);
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

    // Port override (public injection seam); memoized on the argument's
    // structural form — port implementations are pure functions.
    // Frame-bound names (parameters, port-assigned locals) take ports FIRST;
    // imported names take ports only when the test declares them (e.g. hashId
    // uses node:crypto — outside the guarded subset). Ports NEVER shadow
    // module-local real functions (the no-cheating core: real code always
    // runs). Multi-arg ports receive all arguments (single-arg only is
    // memoized; arg0-keyed memo is sound only for unary ports).
    const moduleLocalFn = curInfo().functions.get(name) ?? info.functions.get(name);
    const moduleLocalArrow = curInfo().constArrowFns.get(name) ?? info.constArrowFns.get(name);
    if (input.options?.portImpls && name in input.options.portImpls && !moduleLocalFn && !moduleLocalArrow) {
      const arg0 = argVals[0] ?? { kind: "undef" };
      const key = arg0.kind === "str" ? `s:${String((arg0.t as unknown as { c?: string }).c ?? `h${arg0.t.hash()}`)}` : arg0.kind === "num" ? `n:${String((arg0.t as unknown as { c?: number }).c ?? numC(arg0.t))}` : null;
      if (key !== null && argVals.length === 1) {
        const hit = portMemo.get(`${name}\u0000${key}`);
        if (hit) return hit;
        const r = input.options.portImpls[name]!(arg0);
        portMemo.set(`${name}\u0000${key}`, r);
        return r;
      }
      return input.options.portImpls[name]!(arg0, ...argVals.slice(1));
    }

    // Local function → INLINE (the no-cheating core: real helper bodies run)
    const entryFn = info.functions.get(name);
    const entryArrow = info.constArrowFns.get(name) as ts.ArrowFunction | undefined;
    const defEntry = importedSymbols.get(name);
    const localFn = moduleLocalFn ?? defEntry?.info.functions.get(name) ?? entryFn;
    const defArrow = importedSymbols.get(name)?.info.constArrowFns.get(name) as ts.ArrowFunction | undefined;
    const localArrow = moduleLocalArrow ?? defArrow ?? entryArrow;
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
      const nm = fn.name?.text || "(anon)";
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
    // degradations shared
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

    // Anchored dynamic regex over-approximation: a pattern "^A…" with a
    // known literal head A only matches strings starting with A. On the
    // ¬startsWith side .test is exactly false and .replace is the identity;
    // on the reachable side the result is an unconstrained uninterpreted
    // value (recorded as a degradation only when the guard can hold —
    // replay validates any witness from that side on the real regex).
    const regexAnchor = (patVal: SymVal): string | null => {
      if (!isStr(patVal)) return null;
      const pieces: string[] = [];
      const walk = (t: unknown): void => {
        const tt = t as { op?: string; kids?: unknown[]; c?: unknown; sort?: string };
        if (tt && typeof tt === "object" && Array.isArray(tt.kids)) {
          // concat shapes: app2("str.++", a, b) [facade] or op "str.++"/"concat" kids [a, b]
          const k0 = tt.kids[0] as { op?: unknown; c?: unknown } | undefined;
          const isConcat = tt.op === "concat" || tt.op === "str.++"
            || (tt.op === "app2" && (k0?.op === "str.++" || k0?.c === "str.++"));
          if (isConcat && (tt.kids.length === 2 || tt.kids.length === 3)) {
            for (const k of tt.kids.slice(tt.kids.length === 3 ? 1 : 0)) walk(k);
            return;
          }
        }
        if (tt && typeof tt === "object" && typeof tt.c === "string" && tt.sort === "String") {
          pieces.push(tt.c); return;
        }
        // symbolic piece (or non-const): stops accumulation — the anchor is
        // the const head collected so far (may be empty → null).
      };
      walk(patVal.t);
      if (pieces.length === 0) {
        const whole = strConst.get(patVal.t);
        if (whole === undefined) return null;
        pieces.push(whole);
      }
      if (!pieces[0]!.startsWith("^")) return null;
      const body = pieces.join("").slice(1);
      // Literal head: chars up to the first regex meta (backslash escapes
      // end the head too — their target is regex syntax, not plain text).
      const m = /^((?:\\.|[^[\](){}*+?|^$.\\])*)/.exec(body);
      const head = m?.[1] ?? "";
      return head === "" ? null : head;
    };
    const dynRegexTest = (recv: SymVal, patVal: SymVal, at: ts.Node, st: RunState): SymVal | null => {
      if (!isStr(recv)) return null;
      const anchor = regexAnchor(patVal);
      if (anchor === null || anchor === "") return null;
      const g = recv.t.prefixOf(ctx.String.val(anchor));
      const gb = constBool(g);
      if (gb === false) return { kind: "bool", t: bool(ctx, false) };
      const fresh = ctx.Bool.const(`__re_test_${reTestN++}`);
      if (gb !== true) degrade(st, at, "dynamic regex .test over-approx");
      return { kind: "bool", t: ctx.If(g, fresh, bool(ctx, false)) };
      
    };

    // ---- method ports: "__method_<name>" receives (recv, ...args) ----
    const mport = input.options?.portImpls ? input.options.portImpls["__method_" + m] : undefined;
    if (mport && (isObj(recv) || isArr(recv))) return (mport as (r: SymVal, ...a: SymVal[]) => SymVal)(recv, ...args);

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
            const r = invokeCallback(cb, [guarded, { kind: "num", t: num(ctx, k) }, recv], st, depth);
            return r;
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
        case "entries": {
          // array iterator of [index, value] pairs, bounded to declared slots
          const pairs = recv.elems.map((e, k) => ({ kind: "arr", elems: [{ kind: "num", t: num(ctx, k) }, e], len: num(ctx, 2) }) as SymVal);
          return { kind: "arr", elems: pairs, len: recv.len };
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
          pushAsum(st, ctx.IsInt(start)); pushAsum(st, ctx.IsInt(len));
          return { kind: "str", t: recv.t.extract(ctx.ToInt(start), ctx.ToInt(len)) };
        }
        case "charCodeAt": {
          const a0 = isNum(args[0]) ? args[0].t : null;
          if (!a0) return { kind: "any" };
          pushAsum(st, ctx.IsInt(a0));
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
          // Const string × const regex-literal × const replacement: the
          // operation is a pure deterministic string function — evaluate it
          // concretely (e.g. escapeRegex(TAG_OPEN)).
          const rxC = isObj(args[0]) && args[0].fields.has("__regex") ? strConst.get((args[0].fields.get("__regex")! as { kind: "str"; t: Str }).t) : undefined;
          const repC = isStr(args[1]) ? strConst.get(args[1].t) : undefined;
          const recvC = strConst.get(recv.t);
          if (rxC !== undefined && repC !== undefined && recvC !== undefined) {
            const m = /^\/(.*)\/([a-z]*)$/.exec(rxC);
            if (m) return { kind: "str", t: ctx.String.val(recvC.replace(new RegExp(m[1]!, m[2]), repC)) };
          }
          // Symbolic receiver against the escapeRegex shape (\. specials →
          // "\\$&"): deterministic uninterpreted function of the input.
          if (rxC === "/[.*+?^${}()|[\\]\\\\]/g" && repC === "\\$&" && isStr(recv)) {
            // deterministic uninterpreted escape: same input → same output
            (ctx as unknown as { pendingFnsS1: Set<string> }).pendingFnsS1.add("__esc1");
            return { kind: "str", t: (ctx as unknown as { app1: (f: string, a: never, s: string) => Str }).app1("__esc1", recv.t as never, "String") };
          }
          // dynamic-regex pattern with "" replacement (the render-refs
          // idempotency strip): anchored-prefix over-approximation.
          if (isObj(args[0]) && args[0].fields.has("__regex") && isStr(args[1]) && strConst.get(args[1].t) === "") {
            const patVal = args[0].fields.get("__regex")!;
            const anchor = regexAnchor(patVal);
            if (anchor !== null && anchor !== "" && isStr(recv)) {
              const g = recv.t.prefixOf(ctx.String.val(anchor));
              const gb = constBool(g);
              if (gb === false) return recv;
              // Deterministic FUNCTION of (input, anchor): a per-call-site
              // free const lets the same strip return different values in
              // turn A vs turn B — manufacturing phantom cross-turn flips.
              (ctx as unknown as { pendingFnsS2: Set<string> }).pendingFnsS2.add("__re_rep2");
              const fn = (ctx as unknown as { app2: (f: string, a: never, b: never, s: string) => Str }).app2("__re_rep2", recv.t as never, ctx.String.val(anchor) as never, "String");
              if (gb !== true) degrade(st, at, "dynamic regex .replace over-approx");
              return iteVal(g, { kind: "str", t: fn }, recv);
            }
          }
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
          for (let i = 0; i < 24; i++) reps.push(pad.power(num(ctx, i + 1)));
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

    // ---- Number.prototype.toFixed: uninterpreted, deterministic per input ----
    if (isNum(recv) && m === "toFixed") {
      (ctx as unknown as { pendingFnsR1: Set<string> }).pendingFnsR1.add("__tofix1");
      return { kind: "str", t: (ctx as unknown as { app1: (f: string, a: never, s: string) => Str }).app1("__tofix1", recv.t as never, "String") };
    }

    // ---- dynamic regex carrier: .test(s) ----
    if (isObj(recv) && recv.fields.has("__regex") && m === "test") {
      const r = dynRegexTest(args[0] ?? { kind: "undef" }, recv.fields.get("__regex")!, at, st);
      if (r !== null) return r;
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
    // push() mutates in place. The receiver may be a NESTED property chain
    // (`pending.toolCalls.push(...)`): rebinding only the ROOT variable to
    // the new array CLOBBERS the root (replaces the obj with the arr!). We
    // must rebuild every container along the chain with its child replaced:
    // pending' = {…pending, toolCalls: newArr}.
    const chain: Array<ts.PropertyAccessExpression | ts.ElementAccessExpression> = [];
    let node: ts.Expression = at.expression;
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      chain.unshift(node);
      node = node.expression;
    }
    if (ts.isIdentifier(node)) {
      const root = node.text;
      let rebuilt: SymVal = newArr;
      for (let i = chain.length - 1; i >= 1; i--) {
        const hop = chain[i]!;
        const parentVal = evalExpr(hop.expression, frame, st, 0);
        if (parentVal.kind !== "obj") return newArr; // degrade silently: root rebind only
        const fields = new Map(parentVal.fields);
        if (!ts.isPropertyAccessExpression(hop)) return newArr; // element-middle chains: root rebind only
        fields.set(hop.name.text, rebuilt);
        rebuilt = { kind: "obj", fields };
      }
      frame.vars.set(root, rebuilt);
      return rebuilt;
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
    // degradations shared
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
          (isNum(old) && isNum(v) && old.t.hash() === v.t.hash()) ||
          (isStr(old) && isStr(v) && old.t.hash() === v.t.hash()) ||
          (isBool(old) && isBool(v) && old.t.hash() === v.t.hash()) ||
          (isArr(old) && isArr(v) && old.len.hash() === v.len.hash());
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
        // membership as a (possibly symbolic) predicate — a Term object is
        // always JS-truthy, so `elems.some(...)` could never work here.
        let anyEq = bool(ctx, false);
        for (let k = 0; k < entriesArr.elems.length; k++) {
          const e = entriesArr.elems[k]!;
          const eq = m === "set"
            ? (isObj(e) ? (valEq(e.fields.get("key") ?? { kind: "any" }, args[0]) ?? bool(ctx, false)) : bool(ctx, false))
            : (valEq(e, args[0]) ?? bool(ctx, false));
          anyEq = anyEq.or(entriesArr.len.gt(num(ctx, k)).and(eq));
        }
        // Slot-write at the SYMBOLIC length: a previously executed guarded
        // add may or may not have consumed its slot, so the physical tail
        // position is ambiguous. Writing the entry into slot `len` via per-
        // slot ITEs is correct in every model (a slot past the unchanged
        // length is never observed by length-guarded reads).
        const slotElems = entriesArr.elems.map((e, k) => iteVal(numEq(ctx, entriesArr.len, num(ctx, k)), entry, e));
        if (entriesArr.elems.length < N - 1) {
          slotElems.push(iteVal(numEq(ctx, entriesArr.len, num(ctx, entriesArr.elems.length)), entry, { kind: "undef" }));
        } else {
          degrade(st, at, "map/set add beyond bounded slots");
        }
        elems.length = 0;
        elems.push(...slotElems);
        const newLenV = iteVal(anyEq, { kind: "num", t: entriesArr.len }, { kind: "num", t: entriesArr.len.add(num(ctx, 1)) });
        const newLen: Num = newLenV.kind === "num" ? newLenV.t : entriesArr.len;
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
    if (name === "RegExp") {
      // regex carried as an object; .test/.replace on it use the anchored-
      // prefix over-approximation at the call sites (see callMethod).
      const p0 = call.arguments?.[0];
      return { kind: "obj", fields: new Map([["__regex", p0 ? evalExpr(p0, frame, st, depth) : { kind: "str", t: ctx.String.val("") }]]) };
    }
    if (name === "Error" || name === "RangeError" || name === "TypeError") {
      return { kind: "obj", fields: new Map([["message", call.arguments?.[0] ? evalExpr(call.arguments[0], frame, st, depth) : { kind: "str", t: ctx.String.val("") }]]) };
    }
    // Constructor ports: environment-backed classes (crypto, counters) are
    // injectable exactly like function ports. Sound because ported outputs
    // are unconstrained symbolic values the property never depends on.
    const ctorPort = name && input.options?.portImpls ? input.options.portImpls[name] : undefined;
    if (ctorPort) {
      const args = (call.arguments ?? []).map((a) => evalExpr(a, frame, st, depth));
      return (ctorPort as (...a: SymVal[]) => SymVal)(...args);
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
        // JS Math.round = floor(x + 0.5); stays Real-sorted (numbers are Real)
        return { kind: "num", t: ctx.ToReal(ctx.ToInt(a[0].add(num(ctx, 0.5))) as never) as Num };
      }
      case "floor": return { kind: "num", t: ctx.ToReal(ctx.ToInt(a[0]) as never) as Num };
      case "ceil": {
        const f = ctx.ToReal(ctx.ToInt(a[0]) as never) as Num;
        return { kind: "num", t: ctx.If(f.eq(a[0]), f, f.add(num(ctx, 1))) };
      }
      case "trunc": {
        const tf = ctx.ToReal(ctx.ToInt(a[0]) as never) as Num;
        return { kind: "num", t: ctx.If(a[0].ge(num(ctx, 0)), tf, tf.add(num(ctx, 1))) };
      }
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
  // Bind declared entry params the caller did not pass: run their default
  // initializers (JS semantics — defaults may reference earlier params) or
  // bind undefined. Without this, later params are simply unbound.
  for (const p of decl.parameters) {
    if (!ts.isIdentifier(p.name)) continue;
    if (frame.vars.has(p.name.text)) continue;
    frame.vars.set(p.name.text, p.initializer ? evalExpr(p.initializer, frame, st, 0) : { kind: "undef" });
  }
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
      ctx: input.ctx as import("./terms.js").Context,
    }),
  };
}

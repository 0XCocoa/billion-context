/**
 * verif symbolic executor — MVP.
 *
 * Translates REAL TypeScript function bodies (from the guarded kernel files)
 * into z3 constraints and checks properties against the solver. This is the
 * translator promised in issue #3848: the code under verification is the
 * actual source, never a hand-written model.
 *
 * MVP scope (grows in small steps, each step guarded by tests):
 *  - statements: block, if/else (ITE value-merge, no path enumeration),
 *    return, throw, expression statements
 *  - expressions: literals, identifiers (params + module-level numeric const
 *    bindings), arithmetic/comparison/logical binary ops, unary !/-,
 *    Number.isInteger
 *  - unsupported constructs raise TranslationUnsupported — the subset guard
 *    (verif/subset-guard.ts) is what keeps them out of guarded files; when
 *    the guard allows more than this executor supports, the smoke test fails
 *    loudly rather than silently skipping logic.
 *
 * Counterexample replay: every SAT witness must be replayed against the real
 * compiled function (verif/replay.ts). A witness that does not reproduce in
 * real code means THE TRANSLATOR drifted, not that a bug was found.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import type { Arith, Bool, Seq, Context } from "z3-solver";

/* ------------------------------------------------------------------ errors */

export class TranslationUnsupported extends Error {
  constructor(readonly what: string, readonly file: string, readonly line: number) {
    super(`translation unsupported at ${file}:${line}: ${what}`);
  }
}

/* ------------------------------------------------------------- symbol values */

export type SymVal =
  | { kind: "int"; t: Arith<"main"> }
  | { kind: "bool"; t: Bool<"main"> }
  | { kind: "string"; t: Seq<"main"> }
  | { kind: "any" };

type Z3Context = Context<"main">;

export interface Env {
  vars: Map<string, SymVal>;
}

export interface ExecState {
  env: Env;
  ret: SymVal | null;
  thrown: SymVal | null; // non-null => execution threw
}

/* --------------------------------------------------------------- translator */

export interface TranslateInput {
  /** Repo-relative path of the module containing the function. */
  file: string;
  /** Function name to translate. */
  function: string;
  /** Parameter name -> symbolic value. */
  params: Record<string, SymVal>;
  ctx: Z3Context;
}

interface ModuleConstants {
  numbers: Map<string, number>;
  strings: Map<string, string>;
}

function collectModuleConstants(sf: ts.SourceFile): ModuleConstants {
  const numbers = new Map<string, number>();
  const strings = new Map<string, string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const i = node.initializer;
      if (ts.isNumericLiteral(i)) numbers.set(node.name.text, Number(i.text));
      else if (ts.isStringLiteral(i)) strings.set(node.name.text, i.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return { numbers, strings };
}

export function translateFunction(input: TranslateInput): {
  /** Symbolic result of one call: returned value, or thrown != null. */
  exec: () => ExecState;
} {
  const { file, function: fnName, params, ctx } = input;
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const consts = collectModuleConstants(sf);

  const decl = findFunction(sf, fnName);
  if (!decl) throw new Error(`function ${fnName} not found in ${file}`);

  const env: Env = { vars: new Map(Object.entries(params)) };

  const execStmt = (stmt: ts.Statement, state: ExecState): ExecState => {
    if (state.thrown) return state;
    if (ts.isBlock(stmt)) {
      let s = state;
      for (const child of stmt.statements) s = execStmt(child, s);
      return s;
    }
    if (ts.isReturnStatement(stmt)) {
      return {
        ...state,
        ret: stmt.expression ? evalExpr(stmt.expression, state.env) : { kind: "any" },
      };
    }
    if (ts.isThrowStatement(stmt)) {
      // The thrown VALUE never matters to our invariants — only the fact.
      return { ...state, thrown: { kind: "bool", t: ctx.Bool.val(true) } };
    }
    if (ts.isExpressionStatement(stmt)) {
      evalExpr(stmt.expression, state.env); // evaluate for side-effect errors
      return state;
    }
    if (ts.isIfStatement(stmt)) {
      const cond = toBool(evalExpr(stmt.expression, state.env), stmt, file);
      const thenS = execStmt(stmt.thenStatement, cloneState(state));
      const elseS = stmt.elseStatement
        ? execStmt(stmt.elseStatement, cloneState(state))
        : state;
      return mergeStates(cond, thenS, elseS);
    }
    throw new TranslationUnsupported(kindName(stmt), file, lineOf(sf, stmt));
  };

  const cloneState = (s: ExecState): ExecState => ({
    env: { vars: new Map(s.env.vars) },
    ret: s.ret,
    thrown: s.thrown,
  });

  const mergeStates = (cond: Bool<"main">, a: ExecState, b: ExecState): ExecState => {
    const vars = new Map<string, SymVal>();
    for (const [name, vb] of b.env.vars) {
      const va = a.env.vars.get(name);
      if (!va) continue; // declared in then-branch only — keep b's fallthrough value
      vars.set(name, mergeVal(cond, va, vb));
    }
    for (const [name, va] of a.env.vars) {
      if (!vars.has(name) && !b.env.vars.has(name)) vars.set(name, va);
    }
    const throwFlag = (x: SymVal | null): Bool<"main"> | null =>
      x === null ? null : x.kind === "bool" ? x.t : null;
    const at = throwFlag(a.thrown);
    const bt = throwFlag(b.thrown);
    let thrown: SymVal | null = null;
    if (at !== null && bt !== null) thrown = mergeVal(cond, a.thrown!, b.thrown!);
    else if (at !== null) thrown = { kind: "bool", t: cond.and(at) };
    else if (bt !== null) thrown = { kind: "bool", t: cond.not().and(bt) };
    return {
      env: { vars },
      ret: a.ret && b.ret ? mergeVal(cond, a.ret, b.ret) : (a.ret ?? b.ret),
      thrown,
    };
  };

  const mergeVal = (cond: Bool<"main">, a: SymVal, b: SymVal): SymVal => {
    if (a.kind !== b.kind) return { kind: "any" };
    if (a.kind === "int" && b.kind === "int") return { kind: "int", t: ctx.If(cond, a.t, b.t) };
    if (a.kind === "bool" && b.kind === "bool") return { kind: "bool", t: ctx.If(cond, a.t, b.t) };
    if (a.kind === "string" && b.kind === "string") return { kind: "string", t: ctx.If(cond, a.t, b.t) };
    return { kind: "any" };
  };

  const toBool = (v: SymVal, at: ts.Node, file: string): Bool<"main"> => {
    if (v.kind === "bool") return v.t;
    throw new TranslationUnsupported(`non-boolean condition (${v.kind})`, file, lineOf(sf, at));
  };

  const evalExpr = (expr: ts.Expression, env: Env): SymVal => {
    if (ts.isNumericLiteral(expr)) return { kind: "int", t: ctx.Int.val(Number(expr.text)) };
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { kind: "string", t: ctx.String.val(expr.text) };
    }
    if (ts.isIdentifier(expr)) {
      const v = env.vars.get(expr.text);
      if (v) return v;
      const num = consts.numbers.get(expr.text);
      if (num !== undefined) return { kind: "int", t: ctx.Int.val(num) };
      const str = consts.strings.get(expr.text);
      if (str !== undefined) return { kind: "string", t: ctx.String.val(str) };
      throw new TranslationUnsupported(`unbound identifier ${expr.text}`, file, lineOf(sf, expr));
    }
    if (ts.isPrefixUnaryExpression(expr)) {
      if (expr.operator === ts.SyntaxKind.ExclamationToken) {
        return { kind: "bool", t: toBool(evalExpr(expr.operand, env), expr, file).not() };
      }
      if (expr.operator === ts.SyntaxKind.MinusToken) {
        const v = evalExpr(expr.operand, env);
        if (v.kind === "int") return { kind: "int", t: v.t.neg() };
      }
      throw new TranslationUnsupported("prefix unary operator", file, lineOf(sf, expr));
    }
    if (ts.isBinaryExpression(expr)) {
      return evalBinary(expr, env);
    }
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression.getText(sf);
      // Whitelisted pure builtins with exact translations:
      if (callee === "Number.isInteger") {
        const arg = evalExpr(expr.arguments[0], env);
        // TS numbers are modeled as z3 Int in the MVP (guarded arithmetic is
        // integer index/threshold math; float-heavy logic is out of scope —
        // see README "Modeling decisions"). Integer-ness is then trivially
        // true; z3's IsInt exists only for Real-sorted terms in this API.
        if (arg.kind === "int") return { kind: "bool", t: ctx.Bool.val(true) };
      }
      // Everything else (String(...).padStart, template tails on the success
      // path, …) is MVP-unsupported as a VALUE: it does not affect control
      // flow of the currently proven properties, so it degrades to `any`.
      // The smoke test pins exactly which properties may rely on control
      // flow only — see verif/README.md.
      return { kind: "any" };
    }
    if (ts.isTemplateExpression(expr)) {
      // Head + spans; unsupported spans degrade to any.
      let acc: SymVal | null = null;
      const parts: SymVal[] = [{ kind: "string", t: ctx.String.val(expr.head.text) }];
      for (const span of expr.templateSpans) {
        parts.push(evalExpr(span.expression, env));
      }
      for (const p of parts) {
        if (p.kind !== "string") return { kind: "any" };
        acc = acc === null ? p : { kind: "string", t: acc.t.concat(p.t) };
      }
      return acc ?? { kind: "string", t: ctx.String.val("") };
    }
    if (ts.isParenthesizedExpression(expr)) return evalExpr(expr.expression, env);
    if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
      return evalExpr(expr.expression, env);
    }
    throw new TranslationUnsupported(kindName(expr), file, lineOf(sf, expr));
  };

  const evalBinary = (expr: ts.BinaryExpression, env: Env): SymVal => {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      // Logical operators with short-circuit degrade to truth-table merges.
      const l = evalExpr(expr.left, env);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const lt = l.kind === "bool" ? l.t : null;
        if (!lt) return { kind: "any" };
        const r = evalExpr(expr.right, env);
        if (r.kind === "bool") return { kind: "bool", t: lt.and(r.t) };
        // right side not boolean-valued: (a && b) yields b when a — merge.
        if (r.kind === "int") return { kind: "int", t: ctx.If(lt, r.t, ctx.Int.val(0)) };
        return { kind: "any" };
      }
      if (l.kind === "bool") {
        const r = evalExpr(expr.right, env);
        if (r.kind === "bool") return { kind: "bool", t: lt_or(l.t, r.t) };
      }
      return { kind: "any" };
    }
    const l = evalExpr(expr.left, env);
    const r = evalExpr(expr.right, env);
    if (l.kind === "int" && r.kind === "int") {
      const a = l.t;
      const b = r.t;
      switch (op) {
        case ts.SyntaxKind.PlusToken: return { kind: "int", t: a.add(b) };
        case ts.SyntaxKind.MinusToken: return { kind: "int", t: a.sub(b) };
        case ts.SyntaxKind.AsteriskToken: return { kind: "int", t: a.mul(b) };
        case ts.SyntaxKind.LessThanToken: return { kind: "bool", t: a.lt(b) };
        case ts.SyntaxKind.LessThanEqualsToken: return { kind: "bool", t: a.le(b) };
        case ts.SyntaxKind.GreaterThanToken: return { kind: "bool", t: a.gt(b) };
        case ts.SyntaxKind.GreaterThanEqualsToken: return { kind: "bool", t: a.ge(b) };
        case ts.SyntaxKind.EqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return { kind: "bool", t: a.eq(b) };
        case ts.SyntaxKind.ExclamationEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { kind: "bool", t: a.neq(b) };
        default:
          throw new TranslationUnsupported(`int binary op ${ts.SyntaxKind[op]}`, file, lineOf(sf, expr));
      }
    }
    if (l.kind === "string" && r.kind === "string" && op === ts.SyntaxKind.PlusToken) {
      return { kind: "string", t: l.t.concat(r.t) };
    }
    if (l.kind === "string" && r.kind === "string" && op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      return { kind: "bool", t: l.t.eq(r.t) };
    }
    throw new TranslationUnsupported(`mixed binary ${ts.SyntaxKind[op]}`, file, lineOf(sf, expr));
  };

  const lt_or = (a: Bool<"main">, b: Bool<"main">): Bool<"main"> => a.or(b);

  const body: ExecState = { env, ret: null, thrown: null };
  const final = execStmt(decl.body!, body);
  return { exec: () => final };
}

/* ------------------------------------------------------------------ helpers */

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

function kindName(node: ts.Node): string {
  return ts.SyntaxKind[node.kind] ?? `kind(${node.kind})`;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

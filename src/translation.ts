/**
 * A bounded, deterministic renderer over Z3 ASTs, not a second formula parser.
 * The lexer only frames commands/terms to prevent script injection. Z3 owns
 * type checking, binding, definition expansion, and logical interpretation.
 */
import { createHash } from "node:crypto";
import { Z3_decl_kind as Op, Z3_sort_kind as SortKind } from "z3-solver";
import type { Context, Bool, Expr, Sort } from "z3-solver";
import type { FormulaTranslation } from "./types.js";

export const RENDERER_REVISION = "z3-controlled-english-v1";
export type SymbolGlossary = Record<string, string>;
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const inputDigest = (axioms: string[], conjecture: string): string => digest({ axioms, conjecture });

/** Split SMT-LIB framing, respecting comments, quoted symbols and doubled quotes. */
function forms(source: string): string[] {
  if (source.length > 200_000) throw new Error("SMT input exceeds the 200000-character framing limit");
  const out: string[] = [];
  let start = -1, depth = 0;
  let quote: '"' | '|' | null = null;
  let comment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (comment) { if (c === '\n' || c === '\r') comment = false; continue; }
    if (quote) {
      if (c === quote) {
        if (quote === '"' && source[i + 1] === '"') { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (c === ';' || /\s/.test(c)) {
      if (depth === 0 && start !== -1) { out.push(source.slice(start, i)); start = -1; }
      if (c === ';') comment = true;
      continue;
    }
    if (start === -1) start = i;
    if (c === '"' || c === '|') { quote = c; continue; }
    if (c === '(') {
      if (depth === 0 && start !== i) throw new Error("Missing term separator");
      if (++depth > 128) throw new Error("SMT nesting exceeds 128 levels");
    } else if (c === ')') {
      if (--depth < 0) throw new Error("Unbalanced SMT parentheses");
      if (depth === 0) { out.push(source.slice(start, i + 1)); start = -1; }
    }
  }
  if (quote || depth !== 0) throw new Error("Unterminated SMT term");
  if (start !== -1) out.push(source.slice(start));
  return out;
}

/**
 * Parse one packaged AST, then hand its children directly to rendering and Z3.
 * Declarations precede assertions. Commands affecting solver state are refused.
 * No textual reparse or naming rewrite happens between rendering and solving.
 */
export function parseProblem(ctx: Context, axioms: string[], conjecture: string): { axioms: Bool[]; conjecture: Bool } {
  const declarations: string[] = [], assertions: string[] = [];
  for (const form of forms(axioms.join('\n'))) {
    if (!form.startsWith('(')) throw new Error("Expected SMT declaration or assertion");
    const [head, ...args] = forms(form.slice(1, -1));
    if (head === 'assert') {
      if (args.length !== 1) throw new Error("assert requires exactly one expression");
      assertions.push(args[0]);
    } else if (['declare-const', 'declare-fun', 'declare-sort', 'define-fun', 'define-sort'].includes(head)) {
      if (assertions.length) throw new Error("Put all declarations and definitions before assertions");
      declarations.push(form);
    } else {
      throw new Error(`Unsupported SMT command ${head}; use declarations, definitions and assertions only`);
    }
  }
  const goals = forms(conjecture);
  if (goals.length !== 1) throw new Error("conjecture requires exactly one expression, not an SMT script");
  // An outer AND is a packaging node only. The parser preserves its children;
  // verify shape/count before selecting the goal so no source term can escape.
  const parsed = ctx.ast_from_string(`${declarations.join('\n')}\n(assert (and\n${[...assertions, goals[0]].join('\n')}\n))`);
  if (!ctx.isExpr(parsed) || !ctx.isAnd(parsed) || parsed.numArgs() !== assertions.length + 1) {
    throw new Error("Z3 did not preserve the formal problem boundary");
  }
  const children = parsed.children();
  if (!children.every(c => ctx.isBool(c))) throw new Error("Expected Boolean assertions and conjecture");
  return { axioms: children.slice(0, -1) as Bool[], conjecture: children.at(-1) as Bool };
}

/** Render Boolean/equality first-order logic; all other theories fail closed. */
export function renderProblem(
  ctx: Context, axioms: Bool[], conjecture: Bool, sourceAxioms: string[], sourceConjecture: string,
  glossary: SymbolGlossary = {},
): FormulaTranslation {
  const symbols = new Map<string, {key: string; signature: string; meaning: string | null}>();
  let nodes = 0, variable = 0;
  const symbol = (key: string, signature: string, arity: number): string => {
    if (!/^(?:sort:)?[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error("Only simple symbol names are renderable");
    if (symbols.has(key) && symbols.get(key)!.signature !== signature) throw new Error(`Overloaded symbol ${key} is unsupported`);
    const meaning = Object.hasOwn(glossary, key) ? glossary[key].trim() : null;
    if (meaning && (meaning.length > 500 || /[\r\n\u0000-\u001f]/.test(meaning))) throw new Error(`Invalid meaning for ${key}`);
    if (meaning) {
      const placeholders = [...meaning.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]));
      if (placeholders.some(i => i >= arity) || Array.from({length: arity}, (_, i) => i).some(i => !placeholders.includes(i))) {
        throw new Error(`Meaning for ${key} must mention each argument {0} through {${arity - 1}}`);
      }
      if (/[{}]/.test(meaning.replace(/\{\d+\}/g, ''))) throw new Error(`Invalid placeholder in meaning for ${key}`);
    }
    symbols.set(key, {key, signature, meaning: meaning || null});
    return meaning || key;
  };
  const sortName = (s: Sort): string => {
    if (s.kind() === SortKind.Z3_BOOL_SORT) return "Boolean truth values";
    if (s.kind() !== SortKind.Z3_UNINTERPRETED_SORT) throw new Error(`Unsupported sort ${s.sexpr()}; v1 supports Bool and uninterpreted sorts`);
    return symbol(`sort:${s.name()}`, "sort", 0);
  };
  const render = (e: Expr, bound: string[] = [], depth = 0): string => {
    if (++nodes > 2000 || depth > 64) throw new Error("Rendering exceeds the 2000-node / 64-level limit");
    sortName(e.sort);
    if (ctx.isVar(e)) {
      const name = bound[ctx.getVarIndex(e)];
      if (!name) throw new Error("Unbound variable in AST");
      return name;
    }
    if (ctx.isQuantifier(e)) {
      if (e.is_lambda()) throw new Error("Lambda expressions are unsupported");
      const vars = Array.from({length: e.num_vars()}, (_, i) => ({name: `v${++variable}`, sort: sortName(e.var_sort(i))}));
      const body = render(e.body(), [...vars.map(v => v.name).reverse(), ...bound], depth + 1);
      return `(${e.is_forall() ? 'for every' : 'there exists'} ${vars.map(v => `${v.name} in ${v.sort}`).join(', ')}: ${body})`;
    }
    if (!ctx.isApp(e)) throw new Error("Unsupported AST node");
    const decl = e.decl();
    const args = e.children().map(c => render(c, bound, depth + 1));
    const binary = (word: string): string => {
      if (args.length !== 2) throw new Error("Unexpected binary operator arity");
      return `(${args[0]} ${word} ${args[1]})`;
    };
    switch (decl.kind()) {
      case Op.Z3_OP_TRUE: return "true";
      case Op.Z3_OP_FALSE: return "false";
      case Op.Z3_OP_NOT: return `(not ${args[0]})`;
      case Op.Z3_OP_AND: return args.length ? `(${args.join(' and ')})` : 'true';
      case Op.Z3_OP_OR: return args.length ? `(${args.join(' or ')})` : 'false';
      case Op.Z3_OP_IMPLIES: return `(if ${args[0]}, then ${args[1]})`;
      case Op.Z3_OP_IFF: return binary('if and only if');
      case Op.Z3_OP_EQ: return binary(ctx.isBool(e.arg(0)) ? 'if and only if' : 'equals');
      case Op.Z3_OP_XOR: return binary('or, but not both,');
      case Op.Z3_OP_DISTINCT: return `(all of these are pairwise distinct: ${args.join('; ')})`;
      case Op.Z3_OP_UNINTERPRETED: {
        const key = String(decl.name());
        const signature = `(${Array.from({length: decl.arity()}, (_, i) => decl.domain(i).sexpr()).join(',')}) -> ${decl.range().sexpr()}`;
        const template = symbol(key, signature, args.length);
        if (!symbols.get(key)!.meaning) return `${key}${args.length ? `(${args.join(', ')})` : ''}`;
        return `(${template.replace(/\{(\d+)\}/g, (_, n) => args[Number(n)])})`;
      }
      default: throw new Error(`Unsupported operator ${decl.name()}`);
    }
  };
  const base = {
    revision: RENDERER_REVISION, input_digest: inputDigest(sourceAxioms, sourceConjecture),
    canonical_axioms: axioms.map(a => a.sexpr()), canonical_conjecture: conjecture.sexpr(),
    premise_consistency: "unknown" as const,
  };
  try {
    const assumptions = axioms.map(a => render(a));
    const conclusion = render(conjecture);
    const known = [...symbols.values()].sort((a, b) => a.key.localeCompare(b.key));
    const extra = Object.keys(glossary).filter(k => !symbols.has(k));
    if (extra.length) throw new Error(`Glossary contains unused symbols: ${extra.join(', ')}`);
    return {
      ...base, status: "supported", assumptions, conclusion, symbols: known,
      missing_meanings: known.filter(s => !s.meaning).map(s => s.key),
      generated_gloss: assumptions.length
        ? `If all of the following assumptions hold: ${assumptions.join('; ')}; then ${conclusion}.`
        : `Without additional assumptions, ${conclusion}.`,
    };
  } catch (error) {
    return { ...base, status: "unsupported", reason: error instanceof Error ? error.message : String(error),
      generated_gloss: null, assumptions: [], conclusion: null, symbols: [...symbols.values()], missing_meanings: [] };
  }
}

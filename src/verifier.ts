/**
 * Formal verification backends.
 *
 * Primary: Z3 via z3-solver (official WASM bindings, in-process).
 *   Input: SMT-LIB 2 fragments.
 *   - verify_implication: axioms ∪ {¬conjecture} unsat ⇒ proved;
 *     sat ⇒ refuted with model as counterexample; unknown reported honestly.
 *   - check_consistency: axioms sat ⇒ consistent (model as witness).
 *   - find_counterexample: sat model of axioms ∪ {¬conjecture} (Mace4 role).
 *
 * Optional: Prover9 / Mace4 via child process when the LADR binaries are
 * installed (PROVER9_PATH / MACE4_PATH env, else resolved from PATH).
 * Input: Prover9 syntax. Fails loudly with install guidance when absent.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VerifyResult } from "./types.js";

const execFileP = promisify(execFile);

const Z3_TIMEOUT_MS = Number(process.env.EFH_Z3_TIMEOUT_MS ?? 15000);
const P9_TIMEOUT_S = Number(process.env.EFH_PROVER9_TIMEOUT_S ?? 30);

// ---------------------------------------------------------------------------
// Z3 (lazy singleton — WASM init is heavy, do it on first verification call)
// ---------------------------------------------------------------------------

// z3-solver's types are complex; keep the handle loosely typed at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let z3ctx: Promise<any> | null = null;

async function getZ3(): Promise<any> {
  if (!z3ctx) {
    z3ctx = (async () => {
      const { init } = await import("z3-solver");
      const { Context } = await init();
      return Context("efh");
    })();
  }
  return z3ctx;
}

function modelToString(m: unknown): string {
  const anyM = m as { sexpr?: () => string };
  try {
    if (typeof anyM.sexpr === "function") return anyM.sexpr();
  } catch {
    /* fall through */
  }
  return String(m);
}

/**
 * Core Z3 run: assert the given SMT-LIB statements, check satisfiability.
 * `statements` are raw SMT-LIB 2 lines (declarations + assertions).
 */
async function z3Check(statements: string[]): Promise<VerifyResult> {
  const t0 = Date.now();
  try {
    const ctx = await getZ3();
    const solver = new ctx.Solver();
    try {
      solver.set("timeout", Z3_TIMEOUT_MS);
    } catch {
      /* older API without set(): rely on outer behavior */
    }
    solver.fromString(statements.join("\n"));
    const res: string = await solver.check();
    if (res === "sat") {
      return {
        backend: "z3",
        result: "sat",
        detail: "Satisfiable — model exists",
        model: modelToString(solver.model()),
        elapsed_ms: Date.now() - t0,
      };
    }
    if (res === "unsat") {
      return {
        backend: "z3",
        result: "unsat",
        detail: "Unsatisfiable",
        elapsed_ms: Date.now() - t0,
      };
    }
    return {
      backend: "z3",
      result: "unknown",
      detail: `Z3 returned unknown (timeout ${Z3_TIMEOUT_MS}ms or undecidable fragment). This is NOT a pass.`,
      elapsed_ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      backend: "z3",
      result: "error",
      detail: `Z3 error: ${err instanceof Error ? err.message : String(err)}. Check SMT-LIB syntax.`,
      elapsed_ms: Date.now() - t0,
    };
  }
}

/** axioms ∪ {¬conjecture}: unsat ⇒ proved, sat ⇒ refuted (model = counterexample). */
export async function z3VerifyImplication(
  axioms: string[],
  conjecture: string,
): Promise<VerifyResult> {
  const r = await z3Check([...axioms, `(assert (not ${conjecture}))`]);
  if (r.result === "unsat") {
    return { ...r, result: "proved", detail: "Conjecture follows from axioms (¬conjecture unsat)" };
  }
  if (r.result === "sat") {
    return {
      ...r,
      result: "refuted",
      detail: "Counterexample found — conjecture does NOT follow from axioms",
    };
  }
  return r;
}

/** Satisfiability of the axiom set itself. sat ⇒ consistent (model as witness). */
export async function z3CheckConsistency(statements: string[]): Promise<VerifyResult> {
  const r = await z3Check(statements);
  if (r.result === "sat") return { ...r, detail: "Consistent — model witnesses satisfiability" };
  if (r.result === "unsat") return { ...r, detail: "INCONSISTENT — statements are contradictory" };
  return r;
}

/** Mace4 role: explicit counterexample search for axioms ∪ {¬conjecture}. */
export async function z3FindCounterexample(
  axioms: string[],
  conjecture: string,
): Promise<VerifyResult> {
  const r = await z3Check([...axioms, `(assert (not ${conjecture}))`]);
  if (r.result === "sat") return { ...r, detail: "Counterexample model found" };
  if (r.result === "unsat") {
    return { ...r, detail: "No counterexample exists — conjecture is entailed" };
  }
  return r;
}

// ---------------------------------------------------------------------------
// Prover9 / Mace4 (optional external backend)
// ---------------------------------------------------------------------------

function ladrInput(assumptions: string[], goals: string[]): string {
  return [
    `assign(max_seconds, ${P9_TIMEOUT_S}).`,
    "formulas(assumptions).",
    ...assumptions.map((a) => (a.trim().endsWith(".") ? a.trim() : `${a.trim()}.`)),
    "end_of_list.",
    "formulas(goals).",
    ...goals.map((g) => (g.trim().endsWith(".") ? g.trim() : `${g.trim()}.`)),
    "end_of_list.",
  ].join("\n");
}

async function runLadr(
  binary: string,
  envVar: string,
  input: string,
): Promise<{ stdout: string; code: number }> {
  const bin = process.env[envVar] ?? binary;
  const dir = mkdtempSync(join(tmpdir(), "efh-ladr-"));
  const file = join(dir, "input.in");
  writeFileSync(file, input, "utf-8");
  try {
    const { stdout } = await execFileP(bin, ["-f", file], {
      timeout: (P9_TIMEOUT_S + 5) * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string; message?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        `${binary} binary not found (looked for '${bin}'). Install LADR/Prover9 and/or set ${envVar}, ` +
          `or use backend:"z3" (in-process, no install required).`,
      );
    }
    // Prover9 exits non-zero on SEARCH FAILED etc. — stdout still meaningful.
    return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : -1 };
  }
}

/** Prover9 proof attempt. */
export async function prover9Prove(
  assumptions: string[],
  goals: string[],
): Promise<VerifyResult> {
  const t0 = Date.now();
  try {
    const { stdout } = await runLadr("prover9", "PROVER9_PATH", ladrInput(assumptions, goals));
    if (stdout.includes("THEOREM PROVED")) {
      const proof = stdout.match(/={30,} PROOF =+[\s\S]*?={30,} end of proof =+/)?.[0];
      return {
        backend: "prover9",
        result: "proved",
        detail: "THEOREM PROVED",
        model: proof?.slice(0, 4000),
        elapsed_ms: Date.now() - t0,
      };
    }
    if (stdout.includes("SEARCH FAILED")) {
      return {
        backend: "prover9",
        result: "unknown",
        detail: "SEARCH FAILED — no proof found within limits (not a disproof)",
        elapsed_ms: Date.now() - t0,
      };
    }
    return {
      backend: "prover9",
      result: "unknown",
      detail: `Unrecognized Prover9 output (first 500 chars): ${stdout.slice(0, 500)}`,
      elapsed_ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      backend: "prover9",
      result: "error",
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - t0,
    };
  }
}

/** Mace4 model/counterexample search. */
export async function mace4FindModel(
  assumptions: string[],
  goals: string[],
): Promise<VerifyResult> {
  const t0 = Date.now();
  try {
    const { stdout } = await runLadr("mace4", "MACE4_PATH", ladrInput(assumptions, goals));
    if (stdout.includes("interpretation(")) {
      const interp = stdout.match(/interpretation\([\s\S]*?\]\)\./)?.[0];
      return {
        backend: "mace4",
        result: "sat",
        detail: "Model found (counterexample to goals)",
        model: interp?.slice(0, 4000),
        elapsed_ms: Date.now() - t0,
      };
    }
    return {
      backend: "mace4",
      result: "unknown",
      detail: "No model found within limits",
      elapsed_ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      backend: "mace4",
      result: "error",
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - t0,
    };
  }
}

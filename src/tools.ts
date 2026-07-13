/**
 * MCP tool registrations — the complete efh-core tool surface.
 *
 * Facet design: assert_claim and the verify tools auto-register the
 * "world-model" and "verifier" agent states as they run, so the enforcer's
 * default restriction maps can never drift out of sync with tool outputs
 * (the brittleness that plagued the multi-server stack). The host agent
 * registers itself as "reasoner" via register_agent_state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Embedder } from "./embeddings.js";
import { runFullCycle } from "./enforcer/admm.js";
import {
  saveState,
  seedDefaultRestrictionMaps,
  SessionState,
  type SessionState as TSessionState,
} from "./enforcer/state.js";
import * as store from "./store.js";
import type { CycleReport, RecoveryRecommendation, VerifyResult } from "./types.js";
import {
  mace4FindModel,
  prover9Prove,
  z3CheckConsistency,
  z3FindCounterexample,
  z3VerifyImplication,
} from "./verifier.js";
import { execFile } from "node:child_process";

interface Ctx {
  db: Database.Database;
  state: TSessionState;
  embedder: Embedder;
}

const text = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});

/** Below this, the gloss (what the formalization says) diverges from the claim (what was meant). */
const FIDELITY_MIN = Number(process.env.EFH_FIDELITY_MIN ?? 0.6);

const GLOSS_DESC =
  "Independent English rendering of what the axioms + conjecture LITERALLY say, written " +
  "from the formalization alone (do not copy the claim text). Used to measure formalization " +
  "fidelity: embedding similarity between gloss and claim text. Low fidelity means your " +
  "encoding may not say what the claim says — reformalize rather than argue.";

/** proved→1.0, refuted→0.0, everything else→0.5 (below the 0.7 gate). */
function proofConfidence(r: VerifyResult): number {
  if (r.result === "proved") return 1.0;
  if (r.result === "refuted") return 0.0;
  return 0.5;
}

export function registerTools(server: McpServer, ctx: Ctx): void {
  const { db, embedder } = ctx;
  let state = ctx.state;
  let lastCycle: CycleReport | null = null;

  const persist = () => saveState(db, state);
  const lastRecovery = (): RecoveryRecommendation | undefined =>
    lastCycle?.recovery_recommendation;

  const registerFacet = (agentId: string, facetState: Record<string, unknown>) => {
    state.agent_states[agentId] = facetState;
    state.agent_last_seen[agentId] = Date.now() / 1000;
    persist();
  };

  /**
   * Formalization fidelity: 1 − embedding distance between claim text and the
   * independently written gloss. Never fails the verification — an unmeasured
   * fidelity is reported as such (fail-loud on the measurement, not the proof).
   */
  const measureFidelity = async (
    claimText: string | undefined,
    gloss: string | undefined,
  ): Promise<{ fidelity: number | null; fidelity_warning?: true; fidelity_note?: string }> => {
    if (!claimText) return { fidelity: null };
    if (!gloss) {
      return { fidelity: null, fidelity_note: "no gloss supplied — formalization fidelity unmeasured" };
    }
    try {
      const d = await embedder.distance(claimText, gloss);
      const fidelity = Math.round((1 - d) * 10000) / 10000;
      return fidelity < FIDELITY_MIN
        ? {
            fidelity,
            fidelity_warning: true,
            fidelity_note: `fidelity ${fidelity} < ${FIDELITY_MIN}: the formalization may not say what the claim says — reformalize`,
          }
        : { fidelity };
    } catch (err) {
      return {
        fidelity: null,
        fidelity_note: `fidelity unmeasured: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  // -------------------------------------------------------------------------
  // Claim store
  // -------------------------------------------------------------------------

  server.registerTool(
    "assert_claim",
    {
      title: "Assert claim",
      description:
        "Add an uncommitted claim to the world model with a belief score (0-1). " +
        "Auto-registers the world-model facet with the enforcer. Claims start as " +
        "'asserted'; verify then commit them via the gate.",
      inputSchema: {
        text: z.string().min(1).describe("The claim / proposition"),
        belief: z.number().min(0).max(1).describe("Prior confidence in the claim"),
        source: z.string().optional().describe("Where the claim came from"),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ text: claimText, belief, source, tags }) => {
      const claim = store.assertClaim(db, claimText, belief, source, tags);
      registerFacet("world-model", {
        last_assertion: claimText,
        belief_score: belief,
        inconsistency_flag: false,
      });
      return text({ claim, facet_registered: "world-model" });
    },
  );

  server.registerTool(
    "get_claims",
    {
      title: "Get claims",
      description: "Query claims by status, tag, or substring search.",
      inputSchema: {
        status: z
          .enum(["asserted", "verified", "refuted", "committed", "retracted"])
          .optional(),
        tag: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (opts) => text(store.getClaims(db, opts)),
  );

  server.registerTool(
    "link_claims",
    {
      title: "Link claims",
      description: "Create a provenance edge between two claims.",
      inputSchema: {
        from_id: z.number().int(),
        to_id: z.number().int(),
        relation: z.enum(["supports", "contradicts", "refines", "derived_from"]),
      },
    },
    async ({ from_id, to_id, relation }) => {
      store.linkClaims(db, from_id, to_id, relation);
      return text({ linked: true, from_id, to_id, relation });
    },
  );

  server.registerTool(
    "get_audit_trail",
    {
      title: "Get audit trail",
      description:
        "Full provenance: asserts, verifications, commits and refusals — per claim or global.",
      inputSchema: {
        claim_id: z.number().int().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ claim_id, limit }) => {
      const trail = store.getAuditTrail(db, claim_id, limit ?? 100);
      const links = claim_id !== undefined ? store.getLinks(db, claim_id) : undefined;
      return text({ audit: trail, links });
    },
  );

  // -------------------------------------------------------------------------
  // Formal verification
  // -------------------------------------------------------------------------

  server.registerTool(
    "verify_implication",
    {
      title: "Verify implication",
      description:
        "Prove or refute that a conjecture follows from axioms. backend 'z3' (default, " +
        "in-process): axioms are SMT-LIB 2 lines (declarations + assertions), conjecture is " +
        "one SMT-LIB boolean expression, e.g. axioms: ['(declare-const p Bool)', '(assert p)'], " +
        "conjecture: 'p'. backend 'prover9' (requires LADR installed): Prover9 syntax, axioms " +
        "are assumptions, conjecture is the goal. Result 'unknown' is NOT a pass. " +
        "Auto-registers the verifier facet; pass claim_id to bind the result to a stored claim.",
      inputSchema: {
        axioms: z.array(z.string()),
        conjecture: z.string(),
        backend: z.enum(["z3", "prover9"]).optional(),
        claim_id: z.number().int().optional(),
        gloss: z.string().optional().describe(GLOSS_DESC),
      },
    },
    async ({ axioms, conjecture, backend, claim_id, gloss }) => {
      const result =
        backend === "prover9"
          ? await prover9Prove(axioms, [conjecture])
          : await z3VerifyImplication(axioms, conjecture);
      const pc = proofConfidence(result);
      const contradiction = result.result === "refuted";
      // Semantic channel: when bound to a claim, the proof result IS that claim.
      // Register the claim's text so edge_claim compares like with like
      // (raw SMT vs English would register as spurious disagreement).
      const bound = claim_id !== undefined ? store.getClaim(db, claim_id) : undefined;
      registerFacet("verifier", {
        last_proof_result: bound?.text ?? conjecture,
        proof_confidence: pc,
        contradictions_found: contradiction,
      });
      const fid = await measureFidelity(bound?.text, gloss);
      if (bound && claim_id !== undefined) {
        store.saveFormalization(db, {
          claim_id,
          axioms,
          conjecture,
          backend: result.backend,
          result: result.result,
          proof_confidence: pc,
          fidelity: fid.fidelity,
          gloss: gloss ?? null,
        });
      }
      let claim;
      if (claim_id !== undefined) {
        claim = store.recordVerification(db, claim_id, pc, contradiction, result.detail);
      }
      return text({ ...result, proof_confidence: pc, ...fid, claim });
    },
  );

  server.registerTool(
    "check_consistency",
    {
      title: "Check consistency",
      description:
        "Check whether a set of SMT-LIB 2 statements is jointly satisfiable. " +
        "sat = consistent (model witnesses it); unsat = contradictory. " +
        "Use for axiom-system health checks before trusting downstream proofs.",
      inputSchema: {
        statements: z.array(z.string()).min(1),
      },
    },
    async ({ statements }) => {
      const result = await z3CheckConsistency(statements);
      if (result.result === "unsat") {
        registerFacet("verifier", {
          last_proof_result: "axiom-set consistency",
          proof_confidence: 0.0,
          contradictions_found: true,
        });
      }
      return text(result);
    },
  );

  server.registerTool(
    "find_counterexample",
    {
      title: "Find counterexample",
      description:
        "Search for a model where the axioms hold but the conjecture fails (the Mace4 role). " +
        "backend 'z3' (default, SMT-LIB) or 'mace4' (requires LADR, Prover9 syntax). " +
        "Pass claim_id to bind: counterexample found ⇒ claim refuted; none ⇒ entailed.",
      inputSchema: {
        axioms: z.array(z.string()),
        conjecture: z.string(),
        backend: z.enum(["z3", "mace4"]).optional(),
        claim_id: z.number().int().optional(),
        gloss: z.string().optional().describe(GLOSS_DESC),
      },
    },
    async ({ axioms, conjecture, backend, claim_id, gloss }) => {
      const result =
        backend === "mace4"
          ? await mace4FindModel(axioms, [conjecture])
          : await z3FindCounterexample(axioms, conjecture);
      const found = result.result === "sat" || result.result === "refuted";
      const entailed = result.result === "unsat" || result.result === "proved";
      const pc = found ? 0.0 : entailed ? 1.0 : 0.5;
      // Same like-with-like rule as verify_implication (see comment there).
      const bound = claim_id !== undefined ? store.getClaim(db, claim_id) : undefined;
      registerFacet("verifier", {
        last_proof_result: bound?.text ?? conjecture,
        proof_confidence: pc,
        contradictions_found: found,
      });
      const fid = await measureFidelity(bound?.text, gloss);
      if (bound && claim_id !== undefined) {
        store.saveFormalization(db, {
          claim_id,
          axioms,
          conjecture,
          backend: result.backend,
          result: result.result,
          proof_confidence: pc,
          fidelity: fid.fidelity,
          gloss: gloss ?? null,
        });
      }
      let claim;
      if (claim_id !== undefined) {
        claim = store.recordVerification(db, claim_id, pc, found, result.detail);
      }
      return text({ ...result, counterexample_found: found, ...fid, claim });
    },
  );

  server.registerTool(
    "get_formalizations",
    {
      title: "Get formalizations",
      description:
        "Review the formal encodings behind a claim's verifications: axioms, conjecture, " +
        "backend, result, gloss, and fidelity vs the claim text. The formalization step is " +
        "the weakest link in the loop — audit it before trusting a proof.",
      inputSchema: {
        claim_id: z.number().int(),
      },
    },
    async ({ claim_id }) => text(store.getFormalizations(db, claim_id)),
  );

  // -------------------------------------------------------------------------
  // Consistency enforcer
  // -------------------------------------------------------------------------

  server.registerTool(
    "register_agent_state",
    {
      title: "Register agent state",
      description:
        "Register (or update) an agent's state for consistency checking. The host agent " +
        "should register itself as 'reasoner' with keys: current_hypothesis (string), " +
        "confidence_score (0-1), halt_flag (bool), verified_claim (string, optional). " +
        "External agents may register under any id after set_restriction_map wiring.",
      inputSchema: {
        agent_id: z.string().min(1),
        state: z.record(z.union([z.string(), z.number(), z.boolean()])),
      },
    },
    async ({ agent_id, state: agentState }) => {
      registerFacet(agent_id, agentState);
      return text({
        registered: agent_id,
        agents_active: state.allAgents(),
        keys: Object.keys(agentState),
      });
    },
  );

  server.registerTool(
    "run_admm_cycle",
    {
      title: "Run ADMM cycle",
      description:
        "Run one full ADMM cycle over all registered agent pairs: coboundary norms per edge, " +
        "dual-variable pressure, H¹ obstruction detection, status escalation, recovery " +
        "recommendation. Run every 2-3 substantive tool calls.",
      inputSchema: {},
    },
    async () => {
      const report = await runFullCycle(state, embedder);
      lastCycle = report;
      persist();
      return text(report);
    },
  );

  server.registerTool(
    "get_closure_status",
    {
      title: "Get closure status",
      description:
        "Current coherence regime (KERNEL1 | WEAK | WARNING | TIMEOUT | KERNEL2), per-agent " +
        "pressure, H¹ flag, and the recovery recommendation from the last cycle. " +
        "Commit only on KERNEL1.",
      inputSchema: {},
    },
    async () =>
      text({
        closure_status: state.closure_status,
        needs_action: state.closure_status !== "KERNEL1",
        admm_iterations: state.admm_iterations,
        agents_active: state.allAgents(),
        dual_pressure_per_agent: state.dual_pressure_per_agent,
        h1_obstruction: state.h1_obstruction,
        thresholds: {
          epsilon_primal: state.epsilon_primal,
          dual_warning_threshold: state.dual_warning_threshold,
          dual_decay_rate: state.dual_decay_rate,
        },
        recovery_recommendation: lastRecovery() ?? null,
      }),
  );

  server.registerTool(
    "trigger_recovery",
    {
      title: "Trigger recovery",
      description:
        "Execute a recovery strategy. soft_relax: no structural change, advice only. " +
        "admm_reset: clear dual variables, status → KERNEL1 (fastest; underlying " +
        "inconsistency will re-escalate if unresolved). kernel_retreat: remove the " +
        "highest-pressure agent, reset duals (H¹ obstruction response; re-register corrected " +
        "state after). re_partition: clear target_agent's state + reset duals (ADMM stall " +
        "response). fusion: keep agents, reset duals, immediately run a reintegration cycle.",
      inputSchema: {
        strategy: z.enum(["soft_relax", "admm_reset", "kernel_retreat", "re_partition", "fusion"]),
        target_agent: z.string().optional(),
      },
    },
    async ({ strategy, target_agent }) => {
      store.audit(db, "enforcer", `recovery_${strategy}`, null, { target_agent });
      switch (strategy) {
        case "soft_relax": {
          persist();
          return text({
            strategy,
            structural_change: false,
            advice:
              "Accept approximate solution; continue monitoring; increase verification frequency on key claims.",
            closure_status: state.closure_status,
          });
        }
        case "admm_reset": {
          state.resetAdmm();
          persist();
          return text({ strategy, dual_variables_cleared: true, closure_status: state.closure_status });
        }
        case "kernel_retreat": {
          const pressures = Object.entries(state.dual_pressure_per_agent);
          if (pressures.length === 0) {
            return text({ strategy, error: "No pressure data — run run_admm_cycle first." });
          }
          pressures.sort((a, b) => b[1] - a[1]);
          const [worstAgent, pressure] = pressures[0];
          state.removeAgent(worstAgent);
          state.resetAdmm();
          persist();
          return text({
            strategy,
            removed_agent: worstAgent,
            pressure_at_removal: pressure,
            closure_status: state.closure_status,
            note: "Re-register corrected state for the removed agent, then run a cycle.",
          });
        }
        case "re_partition": {
          if (!target_agent) {
            return text({ strategy, error: "re_partition requires target_agent." });
          }
          if (!(target_agent in state.agent_states)) {
            return text({ strategy, error: `Agent '${target_agent}' is not registered.` });
          }
          delete state.agent_states[target_agent];
          state.resetAdmm();
          persist();
          return text({
            strategy,
            cleared_agent: target_agent,
            closure_status: state.closure_status,
            note: "Re-register the agent with a corrected partition of its state, then run a cycle.",
          });
        }
        case "fusion": {
          state.resetAdmm();
          const report = await runFullCycle(state, embedder);
          lastCycle = report;
          persist();
          return text({ strategy, reintegration_cycle: report });
        }
      }
    },
  );

  server.registerTool(
    "set_restriction_map",
    {
      title: "Set restriction map",
      description:
        "Wire a directed edge's restriction map (how an agent's state keys project onto the " +
        "shared edge space). Both directions of a pair must project onto the SAME to_key names. " +
        "compare: 'hash' (exact-match, default) or 'semantic' (embedding cosine distance, " +
        "graded — requires Ollama unless EFH_SEMANTIC=off).",
      inputSchema: {
        from_agent: z.string().min(1),
        to_agent: z.string().min(1),
        mappings: z.array(
          z.object({
            from_key: z.string(),
            to_key: z.string(),
            weight: z.number().positive().optional(),
            compare: z.enum(["hash", "semantic"]).optional(),
          }),
        ),
      },
    },
    async ({ from_agent, to_agent, mappings }) => {
      state.restriction_maps[`${from_agent}→${to_agent}`] = mappings;
      persist();
      return text({ edge: `${from_agent}→${to_agent}`, mappings });
    },
  );

  server.registerTool(
    "reset_session",
    {
      title: "Reset session",
      description:
        "Reset the enforcer session (agents, edges, duals, status) to a clean slate. " +
        "Claims and audit trail are NOT touched — the world model persists across sessions. " +
        "Run at session start.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true"),
      },
    },
    async ({ confirm }) => {
      if (!confirm) return text({ reset: false, reason: "confirm was not true" });
      state = new SessionState();
      seedDefaultRestrictionMaps(state);
      ctx.state = state;
      lastCycle = null;
      persist();
      store.audit(db, "enforcer", "reset_session", null, null);
      return text({ reset: true, closure_status: state.closure_status });
    },
  );

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  server.registerTool(
    "commit_claim",
    {
      title: "Commit claim (gated)",
      description:
        "Commit a claim to the world model. THE GATE — all three must hold: " +
        "proof_confidence ≥ 0.7 (from a verify call bound to this claim), " +
        "confidence_score ≥ 0.7 (your own, supplied here, recorded in audit), " +
        "closure_status = KERNEL1. A refusal is a normal result with the reason and a " +
        "recovery recommendation — it is the consistency check working.",
      inputSchema: {
        claim_id: z.number().int(),
        confidence_score: z.number().min(0).max(1).describe("The reasoner's own confidence"),
      },
    },
    async ({ claim_id, confidence_score }) => {
      const outcome = store.commitClaim(
        db,
        claim_id,
        confidence_score,
        state.closure_status,
        lastRecovery(),
      );
      return text(outcome);
    },
  );

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  server.registerTool(
    "session_status",
    {
      title: "Session status",
      description:
        "Health check: claim counts, enforcer summary, backend availability " +
        "(Z3, Prover9/Mace4, Ollama embeddings), and configuration.",
      inputSchema: {},
    },
    async () => {
      const counts = db
        .prepare("SELECT status, COUNT(*) AS n FROM claims GROUP BY status")
        .all() as Array<{ status: string; n: number }>;
      const ollama = await embedder.probe();
      const prover9 = await new Promise<boolean>((resolve) => {
        execFile("which", [process.env.PROVER9_PATH ?? "prover9"], (err) => resolve(!err));
      });
      return text({
        claims: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        enforcer: {
          closure_status: state.closure_status,
          admm_iterations: state.admm_iterations,
          agents_active: state.allAgents(),
          h1_obstruction: state.h1_obstruction,
        },
        backends: {
          z3: "in-process (lazy WASM init on first verification call)",
          prover9_available: prover9,
          ollama,
          semantic_channel: (process.env.EFH_SEMANTIC ?? "on").toLowerCase() !== "off" ? "on" : "off",
        },
        commit_min_confidence: Number(process.env.EFH_COMMIT_MIN_CONFIDENCE ?? 0.7),
        fidelity_min: FIDELITY_MIN,
      });
    },
  );
}

/**
 * ADMM-based sheaf Laplacian consistency enforcement — TypeScript port of
 * sheaf-consistency-enforcer's admm.py, mathematics preserved:
 *
 *   1. Local primal update — measure coboundary ‖δFx‖ per edge
 *   2. Sheaf diffusion     — compare projected states via restriction maps
 *   3. Dual update         — leaky-integrator inconsistency memory
 *
 * Early-warning signals (unchanged):
 *   primal residual > epsilon_primal        → WEAK
 *   dual variable > dual_warning_threshold  → WARNING
 *   3-cycle dual sum > 1.5 × threshold      → H¹ obstruction → TIMEOUT
 *   ADMM stall + high dual pressure         → TIMEOUT
 *
 * One extension: a semantic comparison channel. The Python original projects
 * strings via SHA-256 → float, so any two distinct strings land at a
 * quasi-random distance — semantically identical paraphrases register as
 * disagreement. Mappings marked compare:"semantic" instead measure embedding
 * cosine distance in [0,1], giving graded agreement. Hash mode remains the
 * default for exact-match channels and full back-compat.
 */

import type { Embedder } from "../embeddings.js";
import { semanticEnabled } from "../embeddings.js";
import type {
  AgentState,
  CycleReport,
  EdgeReport,
  ProjectedValue,
  RecoveryRecommendation,
  RestrictionMapping,
} from "../types.js";
import type { SessionState } from "./state.js";
import { createHash } from "node:crypto";

const ARROW = "→";

/**
 * Deterministic cross-process string hash → float in [0,1].
 * Mirrors Python: first 4 bytes of SHA-256, big-endian, / 0xFFFFFFFF.
 * (Python's builtin hash() is salted per-process; this is why SHA-256.)
 */
export function stringToFloat(val: string): number {
  const digest = createHash("sha256").update(val, "utf-8").digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/**
 * Project an agent state onto the edge space via a restriction map.
 * Numbers/booleans → scalar (accumulating, weighted). Strings → scalar via
 * SHA-256 (hash mode) or kept as text for semantic comparison. Missing keys
 * contribute nothing (soft constraint).
 */
export function applyRestrictionMap(
  agentState: AgentState,
  restrictionMap: RestrictionMapping[],
  semanticOn: boolean,
): Record<string, ProjectedValue> {
  const projected: Record<string, ProjectedValue> = {};
  for (const m of restrictionMap) {
    const weight = m.weight ?? 1.0;
    const val = agentState[m.from_key];
    if (val === undefined || val === null) continue;

    if (typeof val === "boolean" || typeof val === "number") {
      const numeric = Number(val);
      const prev = projected[m.to_key];
      const base = prev?.kind === "scalar" ? prev.v : 0;
      projected[m.to_key] = { kind: "scalar", v: base + numeric * weight };
    } else if (typeof val === "string") {
      if (m.compare === "semantic" && semanticOn) {
        projected[m.to_key] = { kind: "text", s: val, weight };
      } else {
        const prev = projected[m.to_key];
        const base = prev?.kind === "scalar" ? prev.v : 0;
        projected[m.to_key] = { kind: "scalar", v: base + stringToFloat(val) * weight };
      }
    }
    // other types contribute nothing
  }
  return projected;
}

/**
 * Coboundary norm ‖δFx‖ on one edge: RMS distance over shared projected keys.
 * No shared keys → 0.0 (agents don't constrain each other here — soft
 * constraint semantics, not a false alarm). Scalar pairs use squared
 * difference; text pairs use embedding cosine distance (identical strings
 * shortcut to 0 without a model call); mismatched kinds count as distance 1.
 */
export async function coboundaryNorm(
  fromProj: Record<string, ProjectedValue>,
  toProj: Record<string, ProjectedValue>,
  embedder: Embedder,
): Promise<number> {
  const shared = Object.keys(fromProj).filter((k) => k in toProj);
  if (shared.length === 0) return 0.0;

  let sqSum = 0;
  for (const k of shared) {
    const a = fromProj[k];
    const b = toProj[k];
    if (a.kind === "scalar" && b.kind === "scalar") {
      sqSum += (a.v - b.v) ** 2;
    } else if (a.kind === "text" && b.kind === "text") {
      const w = Math.max(a.weight, b.weight);
      const d = (await embedder.distance(a.s, b.s)) * w;
      sqSum += d ** 2;
    } else {
      sqSum += 1.0; // projection-kind mismatch = full disagreement on this key
    }
  }
  return Math.sqrt(sqSum / shared.length);
}

/** Run one ADMM step on a single directed edge. */
export async function admmStep(
  state: SessionState,
  fromAgent: string,
  toAgent: string,
  embedder: Embedder,
): Promise<EdgeReport> {
  const semanticOn = semanticEnabled();
  const edge = state.getOrCreateEdge(fromAgent, toAgent);

  const fromProj = applyRestrictionMap(
    state.agent_states[fromAgent] ?? {},
    state.getRestrictionMap(fromAgent, toAgent),
    semanticOn,
  );
  const toProj = applyRestrictionMap(
    state.agent_states[toAgent] ?? {},
    state.getRestrictionMap(toAgent, fromAgent),
    semanticOn,
  );

  // Steps 1 + 2: primal update + sheaf diffusion
  const cbNorm = await coboundaryNorm(fromProj, toProj, embedder);
  const prev = edge.last_coboundary;

  edge.primal_residuals.push(cbNorm);
  if (edge.primal_residuals.length > 50) {
    edge.primal_residuals = edge.primal_residuals.slice(-50);
  }
  const dualRes = Math.abs(cbNorm - prev);
  edge.dual_residuals.push(dualRes);
  if (edge.dual_residuals.length > 50) {
    edge.dual_residuals = edge.dual_residuals.slice(-50);
  }

  // Step 3: dual update — leaky integrator accumulates inconsistency memory
  edge.dual_variable = edge.dual_variable * (1.0 - state.dual_decay_rate) + cbNorm;
  edge.last_coboundary = cbNorm;
  edge.iteration += 1;

  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  return {
    edge_id: edge.edge_id,
    coboundary_norm: r4(cbNorm),
    dual_variable: r4(edge.dual_variable),
    primal_residual: r4(cbNorm),
    dual_residual: r4(dualRes),
    converging: edge.converging,
    stalled: edge.stalled,
    pressure: r4(edge.pressure),
  };
}

/**
 * Detect H¹(G;F) ≠ 0 — a 3-agent directed cycle whose accumulated dual
 * variables sum above 1.5 × warning threshold. Indicates a cyclic
 * contradiction that is topologically irresolvable by pairwise adjustment.
 * Only fires after ≥ 3 ADMM iterations (warmup guard).
 */
export function detectH1Obstruction(state: SessionState): [boolean, string] {
  const agents = state.allAgents();
  if (agents.length < 3 || state.admm_iterations < 3) {
    return [false, "Insufficient agents or iterations for cycle detection"];
  }
  const threshold = state.dual_warning_threshold * 1.5;
  let maxCycle = 0;
  let worst: string[] = [];

  for (const a of agents) {
    for (const b of agents) {
      if (b === a) continue;
      for (const c of agents) {
        if (c === a || c === b) continue;
        const e1 = state.edges[`${a}${ARROW}${b}`];
        const e2 = state.edges[`${b}${ARROW}${c}`];
        const e3 = state.edges[`${c}${ARROW}${a}`];
        if (e1 && e2 && e3) {
          const total = e1.dual_variable + e2.dual_variable + e3.dual_variable;
          if (total > maxCycle) {
            maxCycle = total;
            worst = [a, b, c];
          }
        }
      }
    }
  }

  if (maxCycle > threshold && worst.length === 3) {
    return [
      true,
      `Cyclic obstruction ${worst[0]}->${worst[1]}->${worst[2]}->${worst[0]}: ` +
        `accumulated inconsistency ${maxCycle.toFixed(3)} > threshold ${threshold.toFixed(1)}`,
    ];
  }
  return [false, "No cyclic obstruction detected"];
}

function recommendRecovery(
  state: SessionState,
  meanCb: number,
  maxDual: number,
  h1: boolean,
  stalled: boolean,
): RecoveryRecommendation {
  if (state.closure_status === "KERNEL1") {
    return { strategy: "none", reason: "System in Kernel 1 — no action needed" };
  }
  if (h1) {
    return {
      strategy: "kernel_retreat",
      reason:
        "H1 obstruction: global consistency topologically impossible. Remove highest-pressure agent.",
      action: "Call trigger_recovery('kernel_retreat')",
    };
  }
  if (stalled && maxDual > state.dual_warning_threshold * 2) {
    return {
      strategy: "re_partition",
      reason: "ADMM stalled with high dual pressure. Current partition no longer coherent.",
      action: "Call trigger_recovery('re_partition', target_agent='<agent_id>')",
    };
  }
  if (meanCb > state.epsilon_primal * 2) {
    return {
      strategy: "admm_reset",
      reason: "Coboundary norms persistently high. Reset dual variables and retry.",
      action: "Call trigger_recovery('admm_reset')",
    };
  }
  return {
    strategy: "soft_relax",
    reason: "Early warning state. Continue ADMM; increase verification frequency.",
    action: "Call trigger_recovery('soft_relax') or continue monitoring",
  };
}

/** Run one complete ADMM cycle over all registered agent pairs. */
export async function runFullCycle(state: SessionState, embedder: Embedder): Promise<CycleReport> {
  const t0 = Date.now();
  state.admm_iterations += 1;

  const agents = state.allAgents();
  const edgeReports: EdgeReport[] = [];

  for (const eid of Object.keys(state.restriction_maps)) {
    if (!eid.includes(ARROW)) continue;
    const [fromA, toA] = eid.split(ARROW);
    if (agents.includes(fromA) && agents.includes(toA)) {
      edgeReports.push(await admmStep(state, fromA, toA, embedder));
    }
  }

  let meanCb = 0;
  let maxDual = 0;
  let anyStalled = false;
  let anyDiverging = false;

  if (edgeReports.length > 0) {
    meanCb = edgeReports.reduce((s, r) => s + r.coboundary_norm, 0) / edgeReports.length;
    maxDual = Math.max(...edgeReports.map((r) => r.dual_variable));
    anyStalled = edgeReports.some((r) => r.stalled);
    anyDiverging = edgeReports.some((r) => !r.converging);

    state.dual_pressure_per_agent = {};
    for (const r of edgeReports) {
      const e = state.getEdge(r.edge_id);
      if (e) {
        for (const agent of [e.from_agent, e.to_agent]) {
          state.dual_pressure_per_agent[agent] = Math.max(
            state.dual_pressure_per_agent[agent] ?? 0,
            r.dual_variable,
          );
        }
      }
    }
  } else {
    state.dual_pressure_per_agent = {};
  }

  const [h1Found, h1Msg] = detectH1Obstruction(state);
  state.h1_obstruction = h1Found;

  const prevStatus = state.closure_status;
  const warnings: string[] = [];

  if (h1Found) {
    state.updateStatus("TIMEOUT");
    warnings.push(`H1 OBSTRUCTION: ${h1Msg}`);
  } else if (anyStalled && maxDual > state.dual_warning_threshold * 2) {
    state.updateStatus("TIMEOUT");
    warnings.push("ADMM stalled + high dual pressure -> coherence timeout");
  } else if (meanCb > state.epsilon_primal || anyDiverging) {
    if (maxDual > state.dual_warning_threshold) {
      state.updateStatus("WARNING");
      warnings.push(
        `Elevated residuals (${meanCb.toFixed(3)} > ${state.epsilon_primal}) ` +
          `and dual pressure ${maxDual.toFixed(3)} > ${state.dual_warning_threshold}`,
      );
    } else {
      state.updateStatus("WEAK");
      warnings.push(`Elevated residuals (${meanCb.toFixed(3)}) -> weak coherence`);
    }
  } else if (agents.length >= 2 && state.closure_status !== "KERNEL1") {
    // Matches Python: KERNEL1 only via update_status escalation rules —
    // since escalate-only, recovery is the sanctioned de-escalation path.
    // (Python calls update_status(KERNEL1) which is a no-op under priority;
    // preserved here for identical behavior.)
  }

  state.last_cycle_time = Date.now() / 1000;
  const recovery = recommendRecovery(state, meanCb, maxDual, h1Found, anyStalled);
  const r4 = (x: number) => Math.round(x * 10000) / 10000;

  return {
    iteration: state.admm_iterations,
    closure_status: state.closure_status,
    previous_status: prevStatus,
    status_changed: state.closure_status !== prevStatus,
    agents_active: agents,
    edges_evaluated: edgeReports.length,
    mean_coboundary_norm: r4(meanCb),
    max_dual_variable: r4(maxDual),
    dual_pressure_per_agent: Object.fromEntries(
      Object.entries(state.dual_pressure_per_agent).map(([k, v]) => [k, r4(v)]),
    ),
    h1_obstruction: h1Found,
    h1_detail: h1Msg,
    semantic_channel: semanticEnabled() ? "on" : "off (hash fallback)",
    warnings,
    recovery_recommendation: recovery,
    edge_reports: edgeReports,
    cycle_duration_ms: Date.now() - t0,
  };
}

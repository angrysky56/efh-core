/**
 * Enforcer session state — TypeScript port of sheaf-consistency-enforcer's
 * state.py, with defaults rewired to efh-core's internal facets.
 *
 * Semantics preserved: escalate-only status priority, edge dual variables,
 * 50-sample residual windows, stall/convergence detection, JSON persistence
 * (now stored in the SQLite kv table instead of a JSON file).
 *
 * Key structural change vs. the Python original: the default restriction
 * maps no longer hard-code four external MCP server identities. The default
 * agents are internal facets of this server (world-model, verifier) plus the
 * host agent (reasoner), so the maps cannot drift out of sync with the tools
 * that feed them. External agents remain fully supported via
 * set_restriction_map + register_agent_state.
 */

import type Database from "better-sqlite3";
import { kvGet, kvSet } from "../db.js";
import {
  STATUS_PRIORITY,
  type AgentState,
  type ClosureStatus,
  type RestrictionMapping,
} from "../types.js";

const ARROW = "→";
const KV_KEY = "enforcer_state";

export class EdgeState {
  dual_variable = 0.0;
  primal_residuals: number[] = [];
  dual_residuals: number[] = [];
  last_coboundary = 0.0;
  iteration = 0;

  constructor(
    public from_agent: string,
    public to_agent: string,
  ) {}

  get edge_id(): string {
    return `${this.from_agent}${ARROW}${this.to_agent}`;
  }

  /** Dual variable magnitude = buffering pressure on this edge. */
  get pressure(): number {
    return Math.abs(this.dual_variable);
  }

  /** True if primal residuals are non-increasing. */
  get converging(): boolean {
    const r = this.primal_residuals;
    if (r.length < 2) return true;
    return r[r.length - 1] <= r[r.length - 2];
  }

  /** True if residuals stopped improving (early timeout signal). */
  get stalled(): boolean {
    const r = this.primal_residuals;
    if (r.length < 5) return false;
    const window = r.slice(-5);
    return Math.max(...window) - Math.min(...window) < 1e-4;
  }

  toJSON(): Record<string, unknown> {
    return {
      from_agent: this.from_agent,
      to_agent: this.to_agent,
      dual_variable: this.dual_variable,
      primal_residuals: this.primal_residuals,
      dual_residuals: this.dual_residuals,
      last_coboundary: this.last_coboundary,
      iteration: this.iteration,
    };
  }

  static fromJSON(d: Record<string, unknown>): EdgeState {
    const e = new EdgeState(String(d.from_agent), String(d.to_agent));
    e.dual_variable = Number(d.dual_variable ?? 0);
    e.primal_residuals = (d.primal_residuals as number[]) ?? [];
    e.dual_residuals = (d.dual_residuals as number[]) ?? [];
    e.last_coboundary = Number(d.last_coboundary ?? 0);
    e.iteration = Number(d.iteration ?? 0);
    return e;
  }
}

export class SessionState {
  agent_states: Record<string, AgentState> = {};
  agent_last_seen: Record<string, number> = {};
  restriction_maps: Record<string, RestrictionMapping[]> = {};
  edges: Record<string, EdgeState> = {};
  dual_pressure_per_agent: Record<string, number> = {};

  admm_iterations = 0;
  closure_status: ClosureStatus = "KERNEL1";
  h1_obstruction = false;
  last_cycle_time = 0;

  // Thresholds — identical to the Python enforcer's calibrated defaults.
  coherence_window_s = 30.0;
  epsilon_primal = 0.15;
  dual_decay_rate = 0.15;
  dual_warning_threshold = 5.0;
  max_stall_cycles = 10;

  getOrCreateEdge(from_agent: string, to_agent: string): EdgeState {
    const eid = `${from_agent}${ARROW}${to_agent}`;
    if (!this.edges[eid]) this.edges[eid] = new EdgeState(from_agent, to_agent);
    return this.edges[eid];
  }

  getEdge(edge_id: string): EdgeState | undefined {
    return this.edges[edge_id];
  }

  getRestrictionMap(from_agent: string, to_agent: string): RestrictionMapping[] {
    return this.restriction_maps[`${from_agent}${ARROW}${to_agent}`] ?? [];
  }

  allAgents(): string[] {
    return Object.keys(this.agent_states);
  }

  /** Escalate-only status update; de-escalation requires explicit reset/recovery. */
  updateStatus(next: ClosureStatus): void {
    if (STATUS_PRIORITY[next] > STATUS_PRIORITY[this.closure_status]) {
      this.closure_status = next;
    }
  }

  /** Reset ADMM iterations and dual variables — clears inconsistency memory. */
  resetAdmm(): void {
    this.admm_iterations = 0;
    for (const edge of Object.values(this.edges)) {
      edge.dual_variable = 0;
      edge.primal_residuals = [];
      edge.dual_residuals = [];
      edge.iteration = 0;
    }
    this.closure_status = "KERNEL1";
    this.h1_obstruction = false;
  }

  /** Remove an agent and every edge / restriction map that touches it. */
  removeAgent(agent_id: string): boolean {
    if (!(agent_id in this.agent_states)) return false;
    delete this.agent_states[agent_id];
    delete this.agent_last_seen[agent_id];
    for (const eid of Object.keys(this.edges)) {
      if (eid.split(ARROW).includes(agent_id)) delete this.edges[eid];
    }
    for (const eid of Object.keys(this.restriction_maps)) {
      if (eid.split(ARROW).includes(agent_id)) delete this.restriction_maps[eid];
    }
    if (Object.keys(this.agent_states).length === 0) this.closure_status = "KERNEL1";
    return true;
  }

  toJSON(): Record<string, unknown> {
    return {
      agent_states: this.agent_states,
      agent_last_seen: this.agent_last_seen,
      restriction_maps: this.restriction_maps,
      edges: Object.fromEntries(Object.entries(this.edges).map(([k, v]) => [k, v.toJSON()])),
      dual_pressure_per_agent: this.dual_pressure_per_agent,
      admm_iterations: this.admm_iterations,
      closure_status: this.closure_status,
      h1_obstruction: this.h1_obstruction,
      last_cycle_time: this.last_cycle_time,
      coherence_window_s: this.coherence_window_s,
      epsilon_primal: this.epsilon_primal,
      dual_decay_rate: this.dual_decay_rate,
      dual_warning_threshold: this.dual_warning_threshold,
      max_stall_cycles: this.max_stall_cycles,
    };
  }

  static fromJSON(d: Record<string, unknown>): SessionState {
    const s = new SessionState();
    s.agent_states = (d.agent_states as Record<string, AgentState>) ?? {};
    s.agent_last_seen = (d.agent_last_seen as Record<string, number>) ?? {};
    s.restriction_maps = (d.restriction_maps as Record<string, RestrictionMapping[]>) ?? {};
    s.dual_pressure_per_agent = (d.dual_pressure_per_agent as Record<string, number>) ?? {};
    s.admm_iterations = Number(d.admm_iterations ?? 0);
    s.closure_status = (d.closure_status as ClosureStatus) ?? "KERNEL1";
    s.h1_obstruction = Boolean(d.h1_obstruction ?? false);
    s.last_cycle_time = Number(d.last_cycle_time ?? 0);
    s.coherence_window_s = Number(d.coherence_window_s ?? 30.0);
    s.epsilon_primal = Number(d.epsilon_primal ?? 0.15);
    s.dual_decay_rate = Number(d.dual_decay_rate ?? 0.15);
    s.dual_warning_threshold = Number(d.dual_warning_threshold ?? 5.0);
    s.max_stall_cycles = Number(d.max_stall_cycles ?? 10);
    const edges = (d.edges as Record<string, Record<string, unknown>>) ?? {};
    for (const [k, v] of Object.entries(edges)) s.edges[k] = EdgeState.fromJSON(v);
    return s;
  }
}

// ---------------------------------------------------------------------------
// Default restriction maps — internal facets
// ---------------------------------------------------------------------------

/**
 * Shared edge space for all bidirectional pairs (same invariant as the
 * Python original: both directions of an edge MUST project onto the same
 * edge-space key names so coboundary_norm can intersect them):
 *
 *   edge_claim        — the proposition under scrutiny (semantic compare)
 *   edge_confidence   — degree of certainty, float 0-1 (scalar)
 *   edge_inconsistent — contradiction flag (scalar 0/1)
 */
export function seedDefaultRestrictionMaps(s: SessionState): void {
  const sem: RestrictionMapping["compare"] = "semantic";
  const maps: Record<string, RestrictionMapping[]> = {
    // world-model <-> verifier
    [`world-model${ARROW}verifier`]: [
      { from_key: "last_assertion", to_key: "edge_claim", weight: 1.0, compare: sem },
      { from_key: "belief_score", to_key: "edge_confidence", weight: 1.0 },
      { from_key: "inconsistency_flag", to_key: "edge_inconsistent", weight: 1.0 },
    ],
    [`verifier${ARROW}world-model`]: [
      { from_key: "last_proof_result", to_key: "edge_claim", weight: 1.0, compare: sem },
      { from_key: "proof_confidence", to_key: "edge_confidence", weight: 1.0 },
      { from_key: "contradictions_found", to_key: "edge_inconsistent", weight: 1.0 },
    ],
    // verifier <-> reasoner
    [`verifier${ARROW}reasoner`]: [
      { from_key: "last_proof_result", to_key: "edge_claim", weight: 1.0, compare: sem },
      { from_key: "proof_confidence", to_key: "edge_confidence", weight: 1.0 },
      { from_key: "contradictions_found", to_key: "edge_inconsistent", weight: 1.0 },
    ],
    [`reasoner${ARROW}verifier`]: [
      { from_key: "current_hypothesis", to_key: "edge_claim", weight: 1.0, compare: sem },
      { from_key: "confidence_score", to_key: "edge_confidence", weight: 1.0 },
      { from_key: "halt_flag", to_key: "edge_inconsistent", weight: 1.0 },
    ],
    // reasoner <-> world-model
    [`reasoner${ARROW}world-model`]: [
      { from_key: "current_hypothesis", to_key: "edge_claim", weight: 1.0, compare: sem },
      { from_key: "confidence_score", to_key: "edge_confidence", weight: 1.0 },
      { from_key: "halt_flag", to_key: "edge_inconsistent", weight: 1.0 },
    ],
    [`world-model${ARROW}reasoner`]: [
      { from_key: "last_assertion", to_key: "edge_claim", weight: 1.0, compare: sem },
      { from_key: "belief_score", to_key: "edge_confidence", weight: 1.0 },
      { from_key: "inconsistency_flag", to_key: "edge_inconsistent", weight: 1.0 },
    ],
  };
  for (const [k, v] of Object.entries(maps)) {
    if (!s.restriction_maps[k]) s.restriction_maps[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadState(db: Database.Database): SessionState {
  const raw = kvGet(db, KV_KEY);
  let state = new SessionState();
  if (raw) {
    try {
      state = SessionState.fromJSON(JSON.parse(raw) as Record<string, unknown>);
    } catch (err) {
      console.error(`[efh-core] Could not parse persisted enforcer state, starting fresh: ${err}`);
    }
  }
  seedDefaultRestrictionMaps(state);
  return state;
}

export function saveState(db: Database.Database, state: SessionState): void {
  kvSet(db, KV_KEY, JSON.stringify(state.toJSON()));
}

/** Validated, immutable process configuration. The CLI loads .env before importing this module. */
export function readConfig(env: NodeJS.ProcessEnv) {
  const numeric = (name: string, fallback: number, min: number, max: number, integer = false): number => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (raw?.trim() === "" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      // Do not echo configuration values: a misplaced key must not become a diagnostic.
      throw new Error(`${name} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}`);
    }
    return value;
  };
  const choice = <T extends string>(name: string, fallback: T, choices: readonly T[]): T => {
    const value = (env[name] ?? fallback).toLowerCase() as T;
    if (!choices.includes(value)) throw new Error(`${name} must be ${choices.join(" or ")}`);
    return value;
  };
  const provider = choice("EFH_JUDGE_PROVIDER", "typesafe", ["typesafe", "openrouter"] as const);
  return Object.freeze({
    commitMinConfidence: numeric("EFH_COMMIT_MIN_CONFIDENCE", 0.7, 0, 1),
    fidelityMin: numeric("EFH_FIDELITY_MIN", 0.6, 0, 1),
    fidelityGate: choice("EFH_GATE_FIDELITY", "on", ["on", "off"]) === "on",
    judgeEnabled: choice("EFH_JUDGE", "off", ["off", "jev"]) === "jev",
    judgeProvider: provider,
    judgeModel: env.EFH_JUDGE_MODEL ?? (provider === "typesafe" ? "jev-latest" : "~typesafe/jev-latest"),
    judgeBand: numeric("EFH_JUDGE_BAND", 0.15, 0, 1),
    judgeSamples: numeric("EFH_JUDGE_SAMPLES", 5, 1, 15, true),
    judgeMonitor: choice("EFH_JUDGE_MONITOR", "off", ["on", "off"]) === "on",
    semanticEnabled: choice("EFH_SEMANTIC", "on", ["on", "off"]) === "on",
    ollamaHost: env.OLLAMA_HOST ?? "http://localhost:11434",
    embedModel: env.EFH_EMBED_MODEL ?? "nomic-embed-text",
    z3TimeoutMs: numeric("EFH_Z3_TIMEOUT_MS", 15000, 1, 2_147_483_647, true),
    prover9TimeoutS: numeric("EFH_PROVER9_TIMEOUT_S", 30, 1, 2_147_483, true),
  });
}

export const config = readConfig(process.env);

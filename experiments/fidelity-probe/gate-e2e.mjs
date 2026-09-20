/**
 * End-to-end check of the fidelity leg through the real MCP surface.
 *
 * Asserts one claim twice with the SAME axioms and the SAME proof, varying only
 * the gloss: one faithful reading, one that swaps a necessary condition for a
 * sufficient one. Z3 proves both. The gate should commit the first and refuse
 * the second — before the fidelity leg existed, both committed.
 *
 * Needs a judgment key in this shell (EFH_JUDGE=jev plus TYPESAFE_API_KEY or
 * OPENROUTER_API_KEY). Writes to a scratch database, never the real ledger.
 *
 * Run from the repo root:
 *   npm run build && EFH_JUDGE=jev EFH_DB_PATH=/tmp/efh-gate-e2e.sqlite \
 *     node experiments/fidelity-probe/gate-e2e.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
const client = new Client({ name: "gate-e2e", version: "1" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/index.js")], env, stderr: "inherit" }),
);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content?.[0]?.text ?? "tool error");
  return JSON.parse(r.content[0].text);
};

const status = await call("session_status", {});
console.log("gate legs:", status.gate_legs.join(" ∧ "));
console.log("judge:", JSON.stringify(status.backends.judge));

const claimText = "A commit requires a successful proof.";
const axioms = [
  "(declare-const proved Bool)",
  "(declare-const committed Bool)",
  "(assert (=> committed proved))",
];
const conjecture = "(=> committed proved)";
const glosses = [
  ["faithful", "If a claim is committed then it has been proved; proof is required for a commit."],
  ["unfaithful", "If a claim has been proved then it is committed; proof is enough for a commit."],
];

let failures = 0;
for (const [label, gloss] of glosses) {
  const { claim } = await call("assert_claim", { text: claimText, belief: 0.9, source: `gate-e2e:${label}` });
  const v = await call("verify_implication", { axioms, conjecture, claim_id: claim.id, gloss });
  await call("run_admm_cycle", {});
  const commit = await call("commit_claim", {
    claim_id: claim.id,
    reported_confidence: 0.95,
    confidence_source: "verbalized",
  });
  const expected = label === "faithful";
  if (commit.committed !== expected) failures += 1;
  console.log(
    `${commit.committed === expected ? "PASS" : "FAIL"} ${label}: proof=${v.result} ` +
      `fidelity=${v.fidelity} (${v.fidelity_method}, ${v.fidelity_relation ?? "n/a"}) committed=${commit.committed}`,
  );
  if (!commit.committed) console.log(`     ${commit.reason}`);
}
await client.close();
console.log(failures === 0 ? "\nsame proof, different gloss, different outcome" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

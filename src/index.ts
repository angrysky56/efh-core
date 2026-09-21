#!/usr/bin/env node
/**
 * efh-core — consolidated EFH reasoning server.
 *
 * One process replacing the scattered stack: claim/world-model store,
 * formal verification (Z3 in-process, optional Prover9/Mace4), sheaf ADMM
 * consistency enforcement with a semantic channel, and the gated commit rule.
 *
 * Reasoning patterns (the EFH operating loop, via negativa, GoT, ethical
 * triage) live in skills, not here — a server should only hold what needs
 * computation and persistence.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// An MCP host may launch this server with only a minimal environment, so a key
// exported from a shell profile never reaches it. Real environment variables
// always win; a project .env fills what is missing, and a missing or unreadable
// file is ignored.
const envFile = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // An unreadable .env must not stop the server; configuration is reported by session_status.
  }
}

async function main(): Promise<void> {
  // Local modules capture configuration during evaluation. Import them only AFTER
  // .env is loaded; moving loadEnvFile above static imports would not change ESM order.
  const [{ defaultDbPath, openDb }, { Embedder }, { loadState, saveState }, { registerTools }] =
    await Promise.all([
      import("./db.js"), import("./embeddings.js"), import("./enforcer/state.js"), import("./tools.js"),
    ]);
  const dbPath = defaultDbPath();
  const db = openDb(dbPath);
  const state = loadState(db);
  const embedder = new Embedder(db);

  const server = new McpServer({ name: "efh-core", version: "0.3.0" });
  registerTools(server, { db, state, embedder });

  const shutdown = (signal: string) => {
    console.error(`[efh-core] ${signal} — persisting state and shutting down`);
    try {
      saveState(db, state);
      db.close();
    } catch (err) {
      console.error(`[efh-core] shutdown error: ${err}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[efh-core] ready on stdio — db: ${dbPath}`);
}

main().catch((err) => {
  console.error(`[efh-core] fatal: ${err}`);
  process.exit(1);
});

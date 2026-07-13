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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDbPath, openDb } from "./db.js";
import { Embedder } from "./embeddings.js";
import { loadState, saveState } from "./enforcer/state.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
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

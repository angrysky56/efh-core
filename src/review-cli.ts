#!/usr/bin/env node
/** Review exact stored formulas outside the agent-facing MCP approval path. */
import Database from "better-sqlite3";
import {readFileSync} from "node:fs";
import {reviewPacket, recordTranslationReview, translationReviewStatus} from "./translation-review.js";

const usage = "Usage: review-formalization inspect --db PATH --id ID | record --db PATH --file REVIEW.json";
try {
  const [command, ...args] = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--db', '--id', '--file'].includes(args[i]) || !args[i+1] || options.has(args[i])) throw new Error(usage);
    options.set(args[i], args[i+1]);
  }
  const path = options.get('--db');
  if (!path || !['inspect', 'record'].includes(command)) throw new Error(usage);
  // Never default to the user's ledger and never create/migrate a database.
  const db = new Database(path, {readonly: command === 'inspect', fileMustExist: true});
  try {
    if (command === 'inspect') {
      const id = Number(options.get('--id'));
      if (!Number.isSafeInteger(id) || id < 1 || options.has('--file')) throw new Error(usage);
      console.log(JSON.stringify(reviewPacket(db, id), null, 2));
    } else {
      if (!options.get('--file') || options.has('--id')) throw new Error(usage);
      const review = JSON.parse(readFileSync(options.get('--file')!, 'utf8'));
      recordTranslationReview(db, review);
      console.log(JSON.stringify({recorded: true, ...translationReviewStatus(db, review.formalization_id)}, null, 2));
    }
  } finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

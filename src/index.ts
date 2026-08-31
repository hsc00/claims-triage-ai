import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { QueueInputSchema, type QueueInput } from "./schemas.js";
import { createGroqClient } from "./client.js";
import { SecurityAgent } from "./agents/securityAgent.js";
import { TriageAgent } from "./agents/triageAgent.js";
import { GroqRateLimitError } from "./retry.js";
import { Logger, AuditEntry } from "./logger.js";

dotenv.config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY is required in .env");
  process.exit(1);
}

const client = createGroqClient({
  apiKey: GROQ_API_KEY,
  primaryModel: process.env.PRIMARY_MODEL || "qwen/qwen3.8-27b",
  lightweightModel: process.env.LIGHTWEIGHT_MODEL || "qwen/qwen3.6-27b",
});

const securityAgent = new SecurityAgent(
  client,
  process.env.LIGHTWEIGHT_MODEL || "qwen/qwen3.6-27b",
);
const triageAgent = new TriageAgent(
  client,
  process.env.PRIMARY_MODEL || "qwen/qwen3.8-27b",
);

const logger = new Logger();

async function loadQueue() {
  const filePath = path.join(process.cwd(), "data", "live_queue.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);
  return z.array(QueueInputSchema).parse(data);
}

function sideEffectAction(category: string): string {
  if (category === "AUTO_FILED") return "ASSIGNED_TO_WORKFLOW";
  if (category === "ESCALATE_TO_HUMAN") return "NOTIFIED_HUMAN_REVIEW";
  return "BLOCKED_AND_LOGGED";
}

function persistSideEffect(entry: AuditEntry) {
  const sideEffectsPath = path.join(
    process.cwd(),
    "logs",
    "side_effects.jsonl",
  );
  const sideEffect = {
    timestamp: entry.timestamp,
    item_id: entry.item_id,
    action: sideEffectAction(entry.triage_result.category),
    details: {
      workflow: entry.triage_result.assigned_workflow,
      risk_indicators: entry.triage_result.risk_indicators,
    },
  };
  try {
    fs.mkdirSync(path.dirname(sideEffectsPath), { recursive: true });
    const fd = fs.openSync(sideEffectsPath, "a");
    try {
      const line = JSON.stringify(sideEffect) + "\n";
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    console.error(`Failed to persist side effect for ${entry.item_id}:`, error);
  }
}

async function processItem(item: QueueInput): Promise<AuditEntry> {
  const start = Date.now();

  const inputStr = JSON.stringify(item);

  const securityResponse = await securityAgent.evaluate(inputStr);
  const securityResult = securityResponse.result;
  const securityUsage = securityResponse.usage;

  let triageResult;
  let triageUsage;
  let rawTriage;

  if (!securityResult.is_safe) {
    triageResult = {
      category: "REFUSED_INVALID" as const,
      confidence: 1.0,
      reasoning:
        "Security gate flagged this record: " + securityResult.flags.join(", "),
      risk_indicators: securityResult.flags,
      token_usage: securityUsage,
    };
  } else {
    const triageResponse = await triageAgent.evaluate(inputStr);
    triageResult = triageResponse.result;
    triageUsage = triageResponse.usage;
    rawTriage = triageResponse.raw;
  }

  if (securityUsage) {
    securityResult.token_usage = securityUsage;
  }
  if (triageUsage) {
    triageResult.token_usage = triageUsage;
  }
  if (rawTriage) {
    triageResult.raw_response = rawTriage;
  }

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    item_id: item.id,
    security_passed: securityResult.is_safe,
    security_result: securityResult,
    triage_result: triageResult,
    processing_time_ms: Date.now() - start,
  };

  logger.log(entry);
  persistSideEffect(entry);

  return entry;
}

function loadProcessedIds(): Set<string> {
  const sideEffectsPath = path.join(
    process.cwd(),
    "logs",
    "side_effects.jsonl",
  );
  if (!fs.existsSync(sideEffectsPath)) {
    return new Set();
  }
  const lines = fs
    .readFileSync(sideEffectsPath, "utf-8")
    .split("\n")
    .filter(Boolean);
  const ids = new Set<string>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.item_id) {
        ids.add(entry.item_id);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return ids;
}

async function main() {
  console.log("Loading queue inputs...");
  const queue = await loadQueue();
  const processedIds = loadProcessedIds();
  const pending = queue.filter((item) => !processedIds.has(item.id));
  console.log(
    `Total items: ${queue.length}, Already processed: ${queue.length - pending.length}, Pending: ${pending.length}`,
  );

  const results = [];
  for (let i = 0; i < pending.length; i++) {
    console.log(`Processing [${i + 1}/${pending.length}] ${pending[i].id}`);
    const result = await processItem(pending[i]);
    results.push(result);

    if (i < pending.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const summary = logger.summary();

  const resultsPath = path.join(
    process.cwd(),
    "logs",
    `results-${new Date().toISOString().slice(0, 10)}.json`,
  );
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify({ results, summary }, null, 2));

  console.log(`\nResults written to ${resultsPath}`);
}

try {
  await main();
} catch (err) {
  if (err instanceof GroqRateLimitError) {
    console.error(`\nGroq rate limit reached: ${err.message}`);
    if (err.retryAfterMs > 0) {
      const minutes = Math.ceil(err.retryAfterMs / 60_000);
      console.error(
        `Please retry after ${minutes} minute(s), or upgrade your Groq plan for higher limits.`,
      );
    }
  } else {
    console.error(
      "Fatal error:",
      err instanceof Error ? err.message : String(err),
    );
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
  }
  process.exit(1);
}

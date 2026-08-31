import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { createGroqClient } from "./client.js";
import { SecurityAgent } from "./agents/securityAgent.js";
import { TriageAgent } from "./agents/triageAgent.js";
import { GroqRateLimitError } from "./retry.js";

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

const GoldItemSchema = z.object({
  id: z.string(),
  input: z.object({
    claimant_name: z.string(),
    claim_type: z.string(),
    description: z.string(),
    evidence_summary: z.string(),
    jurisdiction: z.string(),
    filed_date: z.string(),
    amount_claimed: z.number(),
  }),
  expected: z.object({
    category: z.enum(["AUTO_FILED", "ESCALATE_TO_HUMAN", "REFUSED_INVALID"]),
    confidence_min: z.number().optional(),
  }),
});

type GoldItem = z.infer<typeof GoldItemSchema>;

interface ItemEvaluation {
  category: "AUTO_FILED" | "ESCALATE_TO_HUMAN" | "REFUSED_INVALID";
  confidence: number;
  tokens: number;
  cost: number;
  securityBlocked: boolean;
}

function estimateCost(
  usage: { prompt_tokens: number; completion_tokens: number },
  model: string,
): number {
  let inputCostPer1M = 0.1;
  let outputCostPer1M = 0.15;
  const lower = model.toLowerCase();
  if (lower.includes("70b")) {
    inputCostPer1M = 0.59;
    outputCostPer1M = 0.79;
  } else if (lower.includes("6b") || lower.includes("6-27b")) {
    inputCostPer1M = 0.08;
    outputCostPer1M = 0.12;
  }
  return (
    (usage.prompt_tokens * inputCostPer1M +
      usage.completion_tokens * outputCostPer1M) /
    1_000_000
  );
}

async function loadGoldSet(): Promise<GoldItem[]> {
  const filePath = path.join(process.cwd(), "data", "eval_gold_set.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);
  return z.array(GoldItemSchema).parse(data);
}

async function evaluateItem(
  inputStr: string,
  securityAgent: SecurityAgent,
  triageAgent: TriageAgent,
  lightweightModel: string,
  primaryModel: string,
): Promise<ItemEvaluation> {
  const securityResponse = await securityAgent.evaluate(inputStr);
  const security = securityResponse.result;

  let category: "AUTO_FILED" | "ESCALATE_TO_HUMAN" | "REFUSED_INVALID";
  let confidence: number;
  let tokens = 0;
  let cost = 0;
  let securityBlocked = false;

  if (!security.is_safe) {
    category = "REFUSED_INVALID";
    confidence = security.confidence;
    securityBlocked = true;
    if (securityResponse.usage) {
      tokens += securityResponse.usage.total_tokens;
      cost += estimateCost(securityResponse.usage, lightweightModel);
    }
  } else {
    const triageResponse = await triageAgent.evaluate(inputStr);
    const triage = triageResponse.result;
    category = triage.category;
    confidence = triage.confidence;
    if (securityResponse.usage) {
      tokens += securityResponse.usage.total_tokens;
      cost += estimateCost(securityResponse.usage, lightweightModel);
    }
    if (triageResponse.usage) {
      tokens += triageResponse.usage.total_tokens;
      cost += estimateCost(triageResponse.usage, primaryModel);
    }
  }

  return { category, confidence, tokens, cost, securityBlocked };
}

interface EvalRunResult {
  accuracy: number;
  correct: number;
  total: number;
  securityBlocks: number;
  totalTokens: number;
  totalCost: number;
}

interface EvalConfig {
  name: string;
  security: SecurityAgent;
  triage: TriageAgent;
  lightweightModel: string;
  primaryModel: string;
  delayMs: number;
}

async function runConfigEvaluation(
  items: GoldItem[],
  config: EvalConfig,
): Promise<EvalRunResult> {
  console.log(`\n=== ${config.name} ===`);

  let correct = 0;
  let total = items.length;
  let securityBlocks = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const item of items) {
    const inputStr = JSON.stringify(item.input);
    const { category, confidence, tokens, cost, securityBlocked } =
      await evaluateItem(
        inputStr,
        config.security,
        config.triage,
        config.lightweightModel,
        config.primaryModel,
      );

    totalTokens += tokens;
    totalCost += cost;
    if (securityBlocked) securityBlocks++;

    const confidenceMin = item.expected.confidence_min ?? 0;
    const match =
      category === item.expected.category && confidence >= confidenceMin;
    if (match) correct++;

    console.log(
      `${match ? "✓" : "✗"} ${item.id}: predicted=${category}, expected=${item.expected.category}`,
    );

    await new Promise((r) => setTimeout(r, config.delayMs));
  }

  const accuracy = correct / total;
  console.log(`\nAccuracy: ${correct}/${total} = ${(accuracy * 100).toFixed(1)}%`);
  console.log(`Security blocks: ${securityBlocks}`);
  console.log(`Total tokens: ${totalTokens}`);
  console.log(`Estimated cost: $${totalCost.toFixed(4)}`);

  return { accuracy, correct, total, securityBlocks, totalTokens, totalCost };
}

async function evaluateConfigA(items: GoldItem[]) {
  const lightweightModel = process.env.LIGHTWEIGHT_MODEL || "qwen/qwen3.6-27b";
  const primaryModel = process.env.PRIMARY_MODEL || "qwen/qwen3.8-27b";

  return runConfigEvaluation(items, {
    name: "Config A: Primary Model + Lightweight Security",
    security: securityAgent,
    triage: triageAgent,
    lightweightModel,
    primaryModel,
    delayMs: 150,
  });
}

async function evaluateConfigB(items: GoldItem[]) {
  const fastSecurity = new SecurityAgent(client, "qwen/qwen3.6-27b");
  const fastTriage = new TriageAgent(client, "qwen/qwen3.6-27b");
  const model = "qwen/qwen3.6-27b";

  return runConfigEvaluation(items, {
    name: "Config B: All-Lightweight",
    security: fastSecurity,
    triage: fastTriage,
    lightweightModel: model,
    primaryModel: model,
    delayMs: 100,
  });
}

async function main() {
  console.log("Loading gold set...");
  const items = await loadGoldSet();
  console.log(`Evaluating ${items.length} items...`);

  const resultsA = await evaluateConfigA(items);
  const resultsB = await evaluateConfigB(items);

  console.log("\n=== Comparison ===");
  console.log(`Config A accuracy: ${(resultsA.accuracy * 100).toFixed(1)}%`);
  console.log(`Config B accuracy: ${(resultsB.accuracy * 100).toFixed(1)}%`);
  console.log(
    `Config A tokens: ${resultsA.totalTokens}, cost: $${resultsA.totalCost.toFixed(4)}`,
  );
  console.log(
    `Config B tokens: ${resultsB.totalTokens}, cost: $${resultsB.totalCost.toFixed(4)}`,
  );

  if (resultsA.accuracy > resultsB.accuracy) {
    console.log("Config A performs better.");
  } else if (resultsB.accuracy > resultsA.accuracy) {
    console.log("Config B performs better.");
  } else {
    console.log("Both configurations perform equally.");
  }
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

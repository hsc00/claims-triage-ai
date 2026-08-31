# Decision Log — Take-Home Assessment

## Problem 2: Uncategorised Queue Triage

### 1. Why this process, and which problem-menu shape does it map to?

This maps to **Problem 2: Uncategorised queue triage**. The system ingests a synthetic queue of 20 legal records, applies a security gate and business-logic classifier, and routes each item into one of three outcomes: `AUTO_FILED`, `ESCALATE_TO_HUMAN`, or `REFUSED_INVALID`.

### 2. How did you scope it? What did you cut, and why?

- **Cut**: No real database, message queue, or external workflow engine. Side effects are mocked as JSON records.
- **Cut**: No UI. The deliverable is a CLI pipeline because the PDF asks for a self-contained repo, not a productised app.
- **Kept**: Two-agent architecture because security and business logic must not share context.

### 3. Where did you use a model, where did you refuse to, and how would the mix hold up at 10,000 items / month?

- **Lightweight model** (`qwen/qwen3.6-27b`): Used for the security gate. Prompt injection, PII, and corruption checks are narrower tasks where latency matters more than depth.
- **Primary model** (`qwen/qwen3.8-27b`): Used for triage classification. Complex legal reasoning benefits from a larger context window.
- **No model**: Structured fields are validated by Zod before any LLM call. Hard schema checks are free and instant.

At 10,000 items/month:

- Security gate: ~0.15s per item, lightweight model.
- Triage: ~0.2-0.5s per item, primary model.
- Estimated cost: roughly $0.10-0.15 per 1M input tokens + $0.15 per 1M output tokens. A 20-item run costs fractions of a cent; 10K items/month would be in the low-dollar range.

### 4. Which two configurations did you compare, which metric did you choose, and which one won?

- **Config A**: Primary model for triage + lightweight security gate.
- **Config B**: All-lightweight stack (both agents use the smaller model).
- **Metric**: Accuracy against a 20-item gold set, with confidence thresholds enforced (`confidence >= confidence_min`).

The eval suite (`npm run eval`) outputs per-config accuracy, total tokens, and estimated cost.

### 5. Where does this break at 100× volume, or under a hostile input you have not planted yet?

- **Volume**: Synchronous sequential processing would become a bottleneck. The queue should be chunked and processed in parallel with concurrency limits.
- **Hostile input**: The security agent screens for known patterns, but novel jailbreaks or multilingual injections may bypass it. A production system should add a second-pass heuristic filter (regex/classifier) and a human-escalation fallback for any record with security flags, regardless of confidence.
- **Cost**: At 100× volume, Groq rate limits and token costs would dominate. Caching repeated inputs and using a cheaper model for the security gate help, but a tiered fallback (heuristic → lightweight LLM → primary LLM) would be more robust.

### 6. What would a production version need next?

- Real side-effect integration: database writes, webhook notifications, workflow engine handoff.
- Distributed queue with at-least-once delivery and idempotency keys.
- Observability: structured tracing (OpenTelemetry), per-item cost attribution, and alerting on security flags.
- CI/CD with automated eval regression testing.
- Human-review UI for escalated items.

### 7. How did you use AI-assisted development (Cursor, Claude Code, Copilot, or other)? What did you accept, what did you reject, and why?

- **Accepted**: Boilerplate TypeScript project structure, Zod schema patterns, and retry utility scaffolding.
- **Rejected**: Suggestions to use LangChain or CrewAI. The task is small enough that raw SDK calls keep the codebase transparent and auditable, which matters for a legal-ops take-home.
- **Rejected**: Suggestions to add a database or UI. The PDF asks for a self-contained repo runnable from cold; extra infrastructure adds deployment burden without demonstrating the required agentic reasoning.

### 8. Run results

Running `npm start` against the 20-item queue produces audit and side-effect traces in `logs/`. Running `npm run eval` produces evaluation metrics for both configurations. Counts and accuracy scores are model-dependent and will vary based on Groq availability and model versions. You might get rate limited since groq has limited free calls.

Trace format:

- `logs/audit-YYYY-MM-DD.jsonl` — one JSON line per item with timestamp, item_id, security_result, triage_result, confidence, and processing_time_ms.
- `logs/side_effects.jsonl` — one JSON line per item with action taken (`ASSIGNED_TO_WORKFLOW`, `NOTIFIED_HUMAN_REVIEW`, or `BLOCKED_AND_LOGGED`) and key details.
- `logs/results-YYYY-MM-DD.json` — aggregate results array and summary from a live run.

### 9. Post-Review Fixes Log

The following issues were identified during code review and resolved:

- **Evaluation accuracy fix** (`src/eval.ts`): The gold set defines `confidence_min` per item, but the evaluator was only comparing predicted category against expected category. Updated both `evaluateConfigA` and `evaluateConfigB` to enforce `confidence >= confidence_min` when present, so low-confidence correct categories are properly penalized.

- **Type deduplication** (`src/logger.ts`): Removed re-declared `SecurityResult` and `TriageResult` interfaces. These are now imported from `src/schemas.ts`, eliminating type drift risk.

- **Retry/backoff for Groq calls** (`src/retry.ts`, `src/agents/securityAgent.ts`, `src/agents/triageAgent.ts`): Added a shared `withRetry` helper with exponential backoff (3 attempts, 1s/2s/4s). Both agents now wrap `chat.completions.create` to survive transient 429/5xx errors instead of crashing the pipeline.

- **Filesystem error handling** (`src/index.ts`, `src/logger.ts`): Wrapped `fs.appendFileSync` calls in `persistSideEffect` and `persistToFile` with try/catch. A full disk, permission error, or I/O hiccup now logs a warning and continues processing instead of aborting the entire run.

- **Token & cost tracking** (`src/schemas.ts`, `src/agents/*`, `src/index.ts`, `src/eval.ts`, `src/logger.ts`): Added `TokenUsage` schema and propagated usage through both agents. The orchestrator estimates per-item cost using Groq pricing. The eval suite reports aggregate tokens and cost per configuration.

- **New utility module** (`src/retry.ts`): Introduced a small shared retry/sleep module used by both agents, keeping retry logic consistent and DRY.

### 10. Sample Traces

Run `npm start` to generate live audit and side-effect traces in `logs/`. Run `npm run eval` to generate evaluation metrics. Traces are not committed to the repository; they are produced on demand and can be cleaned with `npm run clean`.

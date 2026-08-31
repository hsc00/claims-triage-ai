# Sentinel Triage Agent

**This submission addresses Problem 2: Uncategorised queue triage.**

A lightweight, multi-agent Node.js/TypeScript system for automated legal queue triage. It ingests structured legal records, runs a security gate and business-logic classification pipeline via Groq-hosted LLMs, and produces auditable routing decisions with side-effect execution.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure your Groq API key:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and paste your Groq API key.

3. Run the triage pipeline against the synthetic queue:
   ```bash
   npm start
   ```

4. Run the evaluation suite (Config A vs Config B):
   ```bash
   npm run eval
   ```

5. Type-check the project:
   ```bash
   npm run typecheck
   ```

6. Clean previous run artifacts before committing:
   ```bash
   npm run clean
   ```

   This removes `logs/` so the repository can be committed without pre-processed data. Reviewers can run `npm start` fresh.

## Architecture

- **Security Agent** — gatekeeper that screens every input for prompt injection, PII leakage, corruption, and out-of-scope content.
- **Triage Agent** — business-logic classifier that produces `AUTO_FILED`, `ESCALATE_TO_HUMAN`, or `REFUSED_INVALID`.
- **Orchestrator** — validates schema conformance, chains the two agents, writes structured JSONL audit logs, and executes side effects (mock DB + notifications).
- **Evaluation Suite** — replays a gold-set through two configurations and reports accuracy.

## Data Files

- `data/live_queue.json` — 20 synthetic records (valid, adversarial, messy).
- `data/eval_gold_set.json` — 20 ground-truth items for offline evaluation.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | *required* | Groq API key |
| `PRIMARY_MODEL` | `qwen/qwen3.8-27b` | Model for triage reasoning |
| `LIGHTWEIGHT_MODEL` | `qwen/qwen3.6-27b` | Model for security gate |
| `DEBUG_LLM` | `false` | When `true`, prints raw LLM request/response payloads to stdout for debugging |

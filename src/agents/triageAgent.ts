import OpenAI from "openai";
import { TriageResult, TriageResultSchema } from "../schemas.js";
import { withRetry } from "../retry.js";

const TRIAGE_PROMPT = `You are an expert legal claims triage officer. Classify the following legal record and respond with strict JSON only.

Return a JSON object with these fields:
- category: one of "AUTO_FILED", "ESCALATE_TO_HUMAN", "REFUSED_INVALID"
- confidence: number between 0 and 1
- reasoning: string
- assigned_workflow: string or null
- risk_indicators: array of strings

Do not include any text outside the JSON.`;

export class TriageAgent {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async evaluate(input: string): Promise<{
    result: TriageResult;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    raw?: string;
  }> {
      const response = await withRetry(async () => {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: "system", content: TRIAGE_PROMPT },
            { role: "user", content: input },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        });
        return response;
      });

      const raw = response.choices[0]?.message?.content || "{}";
      if (process.env.DEBUG_LLM === "true") {
        console.log(`[TRIAGE RAW] ${raw}`);
      }
      const parsed = JSON.parse(raw);
      const usage = response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens || 0,
            completion_tokens: response.usage.completion_tokens || 0,
            total_tokens: response.usage.total_tokens || 0,
          }
        : undefined;

      return { result: TriageResultSchema.parse(parsed), usage, raw };
  }
}

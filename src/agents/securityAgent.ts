import OpenAI from "openai";
import { SecurityResult, SecurityResultSchema } from "../schemas.js";
import { withRetry } from "../retry.js";

const SECURITY_PROMPT = `You are a security gatekeeper for a legal claims processing system. Analyze the provided claim record and respond with strict JSON only.

Return a JSON object with these fields:
- is_safe: boolean
- flags: array of strings
- confidence: number between 0 and 1
- reasoning: string

Do not include any text outside the JSON.`;

export class SecurityAgent {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async evaluate(input: string): Promise<{
    result: SecurityResult;
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
            { role: "system", content: SECURITY_PROMPT },
            { role: "user", content: input },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        });
        return response;
      });

      const raw = response.choices[0]?.message?.content || "{}";
      if (process.env.DEBUG_LLM === "true") {
        console.log(`[SECURITY RAW] ${raw}`);
      }
      const parsed = JSON.parse(raw);
      const usage = response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens || 0,
            completion_tokens: response.usage.completion_tokens || 0,
            total_tokens: response.usage.total_tokens || 0,
          }
        : undefined;

      return { result: SecurityResultSchema.parse(parsed), usage, raw };
  }
}

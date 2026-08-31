import OpenAI from "openai";

export interface GroqConfig {
  apiKey: string;
  primaryModel: string;
  lightweightModel: string;
}

export function createGroqClient(config: GroqConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
}

import { z } from "zod";

export const QueueInputSchema = z.object({
  id: z.string(),
  claimant_name: z.string(),
  claim_type: z.string(),
  description: z.string(),
  evidence_summary: z.string(),
  jurisdiction: z.string(),
  filed_date: z.string(),
  amount_claimed: z.number(),
  raw_text: z.string().optional(),
});

export type QueueInput = z.infer<typeof QueueInputSchema>;

export const TokenUsageSchema = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const SecurityResultSchema = z.object({
  is_safe: z.boolean(),
  flags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  token_usage: TokenUsageSchema.optional(),
});

export type SecurityResult = z.infer<typeof SecurityResultSchema>;

export const TriageResultSchema = z.object({
  category: z.enum(["AUTO_FILED", "ESCALATE_TO_HUMAN", "REFUSED_INVALID"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  assigned_workflow: z.string().optional().nullable(),
  risk_indicators: z.array(z.string()).optional(),
  token_usage: TokenUsageSchema.optional(),
  raw_response: z.string().optional(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

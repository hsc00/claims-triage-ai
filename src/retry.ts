export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GroqRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number = 0) {
    super(message);
    this.name = "GroqRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { status?: number; code?: string; message?: string };
  return (
    err.status === 429 ||
    err.code === "rate_limit_exceeded" ||
    /rate limit/i.test(err.message || "")
  );
}

function extractRetryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const message = (error as { message?: string }).message || "";
  const match = new RegExp(/try again in (\d+)m(\d+(?:\.\d+)?)s/).exec(message);
  if (match) {
    const minutes = Number.parseInt(match[1], 10);
    const seconds = Number.parseFloat(match[2]);
    return Math.max(0, minutes * 60_000 + seconds * 1000);
  }
  const secondsMatch = new RegExp(/try again in (\d+(?:\.\d+)?)s/).exec(
    message,
  );
  if (secondsMatch) {
    return Math.max(0, Number.parseFloat(secondsMatch[1]) * 1000);
  }
  return 0;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        if (isRateLimitError(error)) {
          const retryAfter = extractRetryAfterMs(error);
          await sleep(retryAfter || 5 * 60_000);
        } else {
          await sleep(baseDelay * 2 ** attempt);
        }
      }
    }
  }

  if (isRateLimitError(lastError)) {
    const retryAfter = extractRetryAfterMs(lastError);
    const message =
      (lastError as { message?: string }).message || "Groq rate limit reached";
    throw new GroqRateLimitError(message, retryAfter);
  }

  throw lastError;
}

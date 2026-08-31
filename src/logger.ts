import fs from "node:fs";
import path from "node:path";
import { SecurityResult, TriageResult } from "./schemas.js";

export interface AuditEntry {
  timestamp: string;
  item_id: string;
  security_passed: boolean;
  security_result: SecurityResult;
  triage_result: TriageResult;
  processing_time_ms: number;
}

export class Logger {
  private readonly logs: AuditEntry[] = [];
  private readonly logPath: string;

  constructor(logDir = "logs") {
    this.logPath = path.join(process.cwd(), logDir);
    if (!fs.existsSync(this.logPath)) {
      fs.mkdirSync(this.logPath, { recursive: true });
    }
  }

  log(entry: AuditEntry) {
    this.logs.push(entry);
    this.printToConsole(entry);
    this.persistToFile(entry);
  }

  private static categoryColor(category: string): string {
    switch (category) {
      case "AUTO_FILED":
        return "\x1b[32m";
      case "ESCALATE_TO_HUMAN":
        return "\x1b[33m";
      default:
        return "\x1b[31m";
    }
  }

  private printToConsole(entry: AuditEntry) {
    const cat = entry.triage_result.category;
    const color = Logger.categoryColor(cat);

    const securityTokens = entry.security_result.token_usage?.total_tokens || 0;
    const triageTokens = entry.triage_result.token_usage?.total_tokens || 0;
    const tokens = securityTokens + triageTokens;

    console.log(
      `${entry.timestamp} | ${entry.item_id} | ${color}${cat}\x1b[0m | conf: ${entry.triage_result.confidence.toFixed(2)} | tokens: ${tokens} | ${entry.triage_result.reasoning}`,
    );
    if (entry.security_result.flags.length > 0) {
      console.log(
        `  Security flags: ${entry.security_result.flags.join(", ")}`,
      );
    }
  }

  private persistToFile(entry: AuditEntry) {
    const filePath = path.join(
      this.logPath,
      `audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    try {
      fs.mkdirSync(this.logPath, { recursive: true });
      const fd = fs.openSync(filePath, "a");
      try {
        const line = JSON.stringify(entry) + "\n";
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      console.error(`Failed to persist audit log for ${entry.item_id}:`, error);
    }
  }

  summary() {
    const counts = this.logs.reduce(
      (acc, log) => {
        acc[log.triage_result.category] =
          (acc[log.triage_result.category] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    console.log("\n=== Triage Summary ===");
    console.log(JSON.stringify(counts, null, 2));
    return counts;
  }

  getLogs() {
    return this.logs;
  }
}

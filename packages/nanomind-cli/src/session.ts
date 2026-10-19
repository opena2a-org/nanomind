/**
 * @nanomind/session — Multi-turn Terminal Session Context
 *
 * Maintains context across multiple user inputs within a single
 * terminal session. Enables follow-up questions like:
 *   "scan this" → results
 *   "fix the first one" → knows which "first one" from previous scan
 *   "explain that check" → knows which check from previous output
 */

export interface SessionContext {
  lastCommand: string | null;
  lastOutput: string | null;
  lastFindings: Finding[];
  lastAgentId: string | null;
  scanResults: ScanResult | null;
  turnCount: number;
  startedAt: number;
}

/** A finding a command printed: its check id, title and severity. */
export interface Finding {
  id: string;
  title: string;
  severity: string;
}

interface ScanResult {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  passed: boolean;
}

export class SessionManager {
  private context: SessionContext;

  constructor() {
    this.context = {
      lastCommand: null,
      lastOutput: null,
      lastFindings: [],
      lastAgentId: null,
      scanResults: null,
      turnCount: 0,
      startedAt: Date.now(),
    };
  }

  /**
   * Record a command and its output. Returns the findings this output lists.
   * When there are some they replace the remembered findings; when there are
   * none the earlier findings stay, so "the first one" keeps naming the first
   * finding of the last command that printed any.
   */
  update(command: string, output: string): Finding[] {
    this.context.lastCommand = command;
    this.context.lastOutput = output;
    this.context.turnCount++;

    // A finding line: a check id in brackets, such as [CRED-001] or
    // [SKILL-SEMANTIC-007], a title, and the severity in parentheses if given.
    const findingMatches = output.matchAll(/\[([A-Z]+(?:-[A-Z]+)*-\d+)]\s+(.+?)(?:\s+\((\w+)\))?$/gm);
    const findings: Finding[] = [];
    for (const match of findingMatches) {
      findings.push({ id: match[1], title: match[2], severity: match[3] || 'medium' });
    }
    if (findings.length > 0) {
      this.context.lastFindings = findings;
    }

    // The agent an "Agent: <id>" line names, as a trust lookup prints it, or
    // a "Your agent <id>" sentence, as a trust explanation does. The id runs
    // as far as it is a plain identifier, so a quoted mention is not one and
    // a sentence's final period is not part of it.
    const agentMatch = output.match(/\b(?:agent:|your agent)\s+([A-Za-z0-9@][\w@:\/+-]*(?:\.[\w@:\/+-]+)*)/i);
    if (agentMatch) {
      this.context.lastAgentId = agentMatch[1];
    }

    // Extract scan summary
    const summaryMatch = output.match(/(\d+)\s+total.*?(\d+)\s+critical.*?(\d+)\s+high/i);
    if (summaryMatch) {
      this.context.scanResults = {
        total: parseInt(summaryMatch[1]),
        critical: parseInt(summaryMatch[2]),
        high: parseInt(summaryMatch[3]),
        medium: 0,
        low: 0,
        passed: parseInt(summaryMatch[2]) === 0,
      };
    }

    return findings;
  }

  /**
   * Resolve references like "the first one", "that check", etc.
   */
  resolveReference(input: string): string {
    const lower = input.toLowerCase();

    // "fix the first one" → fix finding[0]
    if (lower.includes('first') && this.context.lastFindings.length > 0) {
      return input.replace(/the first (one|finding|issue)/i, this.context.lastFindings[0].id);
    }

    // "explain that" → explain last finding
    if ((lower.includes('that check') || lower.includes('that finding')) && this.context.lastFindings.length > 0) {
      return input.replace(/that (check|finding)/i, this.context.lastFindings[0].id);
    }

    // "my agent" → last seen agent ID
    if (lower.includes('my agent') && this.context.lastAgentId) {
      return input.replace(/my agent/i, `agent: ${this.context.lastAgentId}`);
    }

    return input;
  }

  /**
   * Get current session context.
   */
  getContext(): SessionContext {
    return { ...this.context };
  }

  /**
   * Get session duration in seconds.
   */
  getDuration(): number {
    return Math.floor((Date.now() - this.context.startedAt) / 1000);
  }
}

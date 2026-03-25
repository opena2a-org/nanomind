"use strict";
/**
 * @nanomind/session — Multi-turn Terminal Session Context
 *
 * Maintains context across multiple user inputs within a single
 * terminal session. Enables follow-up questions like:
 *   "scan this" → results
 *   "fix the first one" → knows which "first one" from previous scan
 *   "explain that check" → knows which check from previous output
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
class SessionManager {
    context;
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
     * Update context after a command execution.
     */
    update(command, output) {
        this.context.lastCommand = command;
        this.context.lastOutput = output;
        this.context.turnCount++;
        // Extract findings from scan output
        const findingMatches = output.matchAll(/\[([A-Z]+-\d+)]\s+(.+?)(?:\s+\((\w+)\))?$/gm);
        const findings = [];
        for (const match of findingMatches) {
            findings.push({ id: match[1], title: match[2], severity: match[3] || 'medium' });
        }
        if (findings.length > 0) {
            this.context.lastFindings = findings;
        }
        // Extract agent ID
        const agentMatch = output.match(/agent[:\s]+(\S+)/i);
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
    }
    /**
     * Resolve references like "the first one", "that check", etc.
     */
    resolveReference(input) {
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
    getContext() {
        return { ...this.context };
    }
    /**
     * Get session duration in seconds.
     */
    getDuration() {
        return Math.floor((Date.now() - this.context.startedAt) / 1000);
    }
}
exports.SessionManager = SessionManager;

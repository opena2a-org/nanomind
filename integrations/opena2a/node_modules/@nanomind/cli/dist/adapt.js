"use strict";
/**
 * @nanomind/adapt — Skill Level Inference
 *
 * Infers the user's skill level from their command history
 * and adjusts response verbosity accordingly.
 *
 * Beginner: full explanations, step-by-step guidance
 * Intermediate: concise explanations, key context only
 * Expert: terse output, no hand-holding
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillAdapter = void 0;
const EXPERT_SIGNALS = [
    '--ci', '--format json', '--fix', 'attack', '--scenario',
    'grep', 'jq', 'curl', 'docker', 'kubectl',
];
const BEGINNER_SIGNALS = [
    'help', 'what', 'how', 'explain', 'why',
];
class SkillAdapter {
    history = [];
    inferredLevel = 'intermediate';
    /**
     * Record a command execution.
     */
    record(command, success) {
        this.history.push({ command, timestamp: Date.now(), success });
        // Keep last 50 commands
        if (this.history.length > 50) {
            this.history = this.history.slice(-50);
        }
        this.inferredLevel = this.infer();
    }
    /**
     * Get the current inferred skill level.
     */
    getLevel() {
        return this.inferredLevel;
    }
    /**
     * Infer skill level from command history.
     */
    infer() {
        if (this.history.length < 3)
            return 'intermediate';
        const recent = this.history.slice(-20);
        let expertScore = 0;
        let beginnerScore = 0;
        for (const entry of recent) {
            const cmd = entry.command.toLowerCase();
            if (EXPERT_SIGNALS.some(s => cmd.includes(s)))
                expertScore++;
            if (BEGINNER_SIGNALS.some(s => cmd.includes(s)))
                beginnerScore++;
            if (entry.success)
                expertScore += 0.5;
        }
        const ratio = expertScore / (beginnerScore + 1);
        if (ratio > 3)
            return 'expert';
        if (ratio < 0.5)
            return 'beginner';
        return 'intermediate';
    }
    /**
     * Format a response based on skill level.
     */
    formatResponse(full, concise, terse) {
        switch (this.inferredLevel) {
            case 'beginner': return full;
            case 'intermediate': return concise;
            case 'expert': return terse;
        }
    }
}
exports.SkillAdapter = SkillAdapter;

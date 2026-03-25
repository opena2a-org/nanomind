/**
 * @nanomind/teach — Teach Mode (7-step guided security flow)
 *
 * The complete new-user onboarding experience:
 *   1. Scan current directory. Detect project type.
 *   2. Run actual HMA scan. Explain each finding as it appears.
 *   3. Offer auto-fix with rollback.
 *   4. Generate CI/CD artifact (GitHub Actions, GitLab, etc.)
 *   5. Show current ARS if agent is already registered.
 *   6. Explain ATC and what trust level 3 means.
 *   7. Offer to generate build-action YAML for ATC issuance.
 */
export interface TeachContext {
    cliName: string;
    projectDir: string;
    registryUrl: string;
    onCommand: (cmd: string, args: string[]) => Promise<string>;
    onPrompt: (question: string) => Promise<string>;
    onPrint: (msg: string) => void;
}
export declare function runTeachMode(ctx: TeachContext): Promise<void>;

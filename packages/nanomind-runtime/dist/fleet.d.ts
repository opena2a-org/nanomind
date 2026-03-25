/**
 * @nanomind/runtime/fleet — Fleet Gradient Submission
 *
 * After each local fine-tuning pass, submits anonymized gradient updates
 * to the Registry fleet endpoint with differential privacy noise.
 *
 * Privacy guarantees:
 *   - Raw behavioral events NEVER leave the machine
 *   - Gradients are clipped (max L2 norm = 1.0)
 *   - Calibrated Gaussian noise added (epsilon = 1.0, delta = 1e-5)
 *   - Only broad agent category submitted, never agentId
 */
export interface GradientSubmission {
    agentCategory: string;
    gradientVector: number[];
    localLoss: number;
    eventCount: number;
    privacyEpsilon: number;
    modelVersion: string;
    timestamp: string;
}
export interface FleetConfig {
    registryUrl: string;
    agentCategory: string;
    epsilon: number;
    delta: number;
    maxNorm: number;
    enabled: boolean;
}
/**
 * Apply differential privacy to a gradient vector.
 * Uses the Gaussian mechanism with (epsilon, delta)-DP.
 */
export declare function addDifferentialPrivacy(gradient: number[], config?: Partial<FleetConfig>): number[];
/**
 * Submit gradient to the Registry fleet endpoint.
 */
export declare function submitGradient(gradient: number[], eventCount: number, localLoss: number, config?: Partial<FleetConfig>): Promise<boolean>;
/**
 * Verify that gradient has sufficient privacy noise.
 * Used by the server to reject insufficiently private submissions.
 */
export declare function validatePrivacy(epsilon: number): boolean;

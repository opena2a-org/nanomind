"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.addDifferentialPrivacy = addDifferentialPrivacy;
exports.submitGradient = submitGradient;
exports.validatePrivacy = validatePrivacy;
const DEFAULT_CONFIG = {
    registryUrl: 'https://api.oa2a.org',
    agentCategory: 'general',
    epsilon: 1.0,
    delta: 1e-5,
    maxNorm: 1.0,
    enabled: true,
};
/**
 * Apply differential privacy to a gradient vector.
 * Uses the Gaussian mechanism with (epsilon, delta)-DP.
 */
function addDifferentialPrivacy(gradient, config = {}) {
    const { epsilon, delta, maxNorm } = { ...DEFAULT_CONFIG, ...config };
    // Step 1: Clip gradient to max L2 norm
    const clipped = clipGradient(gradient, maxNorm);
    // Step 2: Compute noise scale
    // σ = sensitivity * √(2 ln(1.25/δ)) / ε
    const sensitivity = maxNorm; // After clipping, max contribution = maxNorm
    const noiseScale = sensitivity * Math.sqrt(2 * Math.log(1.25 / delta)) / epsilon;
    // Step 3: Add calibrated Gaussian noise
    return clipped.map(g => g + gaussianNoise(0, noiseScale));
}
/**
 * Clip gradient to max L2 norm.
 */
function clipGradient(gradient, maxNorm) {
    const norm = Math.sqrt(gradient.reduce((sum, g) => sum + g * g, 0));
    if (norm <= maxNorm)
        return [...gradient];
    const scale = maxNorm / norm;
    return gradient.map(g => g * scale);
}
/**
 * Generate Gaussian noise using Box-Muller transform.
 */
function gaussianNoise(mean, stddev) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + stddev * z0;
}
/**
 * Submit gradient to the Registry fleet endpoint.
 */
async function submitGradient(gradient, eventCount, localLoss, config = {}) {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    if (!fullConfig.enabled)
        return false;
    const noisyGradient = addDifferentialPrivacy(gradient, fullConfig);
    const submission = {
        agentCategory: fullConfig.agentCategory,
        gradientVector: noisyGradient,
        localLoss,
        eventCount,
        privacyEpsilon: fullConfig.epsilon,
        modelVersion: '1.0.0',
        timestamp: new Date().toISOString(),
    };
    try {
        const response = await fetch(`${fullConfig.registryUrl}/api/v1/telemetry/behavioral-gradient`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
/**
 * Verify that gradient has sufficient privacy noise.
 * Used by the server to reject insufficiently private submissions.
 */
function validatePrivacy(epsilon) {
    // Reject submissions with epsilon > 2.0 (too little noise)
    return epsilon <= 2.0 && epsilon > 0;
}

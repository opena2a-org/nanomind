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
  agentCategory: string;     // broad category only, never agentId
  gradientVector: number[];  // noisy gradient
  localLoss: number;
  eventCount: number;
  privacyEpsilon: number;
  modelVersion: string;
  timestamp: string;
}

export interface FleetConfig {
  registryUrl: string;
  agentCategory: string;
  epsilon: number;     // privacy budget (default: 1.0)
  delta: number;       // failure probability (default: 1e-5)
  maxNorm: number;     // gradient clipping norm (default: 1.0)
  enabled: boolean;
}

const DEFAULT_CONFIG: FleetConfig = {
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
export function addDifferentialPrivacy(
  gradient: number[],
  config: Partial<FleetConfig> = {},
): number[] {
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
function clipGradient(gradient: number[], maxNorm: number): number[] {
  const norm = Math.sqrt(gradient.reduce((sum, g) => sum + g * g, 0));
  if (norm <= maxNorm) return [...gradient];
  const scale = maxNorm / norm;
  return gradient.map(g => g * scale);
}

/**
 * Generate Gaussian noise using Box-Muller transform.
 */
function gaussianNoise(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stddev * z0;
}

/**
 * Submit gradient to the Registry fleet endpoint.
 */
export async function submitGradient(
  gradient: number[],
  eventCount: number,
  localLoss: number,
  config: Partial<FleetConfig> = {},
): Promise<boolean> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  if (!fullConfig.enabled) return false;

  const noisyGradient = addDifferentialPrivacy(gradient, fullConfig);

  const submission: GradientSubmission = {
    agentCategory: fullConfig.agentCategory,
    gradientVector: noisyGradient,
    localLoss,
    eventCount,
    privacyEpsilon: fullConfig.epsilon,
    modelVersion: '1.0.0',
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(
      `${fullConfig.registryUrl}/api/v1/telemetry/behavioral-gradient`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Verify that gradient has sufficient privacy noise.
 * Used by the server to reject insufficiently private submissions.
 */
export function validatePrivacy(epsilon: number): boolean {
  // Reject submissions with epsilon > 2.0 (too little noise)
  return epsilon <= 2.0 && epsilon > 0;
}

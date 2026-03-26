import type { InferResponse } from './server.js';

/**
 * FabricAdapter: interface for product-specific Intelligence Fabric integration.
 * Each product (HMA, AIM, ARP, BrowserGuard, Secretless) implements this
 * to write their signals to the ASC and read risk summaries.
 */
export interface FabricAdapter {
  /** Product identifier */
  readonly productId: string;

  /**
   * Write product-specific signals to the ASC.
   * @param agentId - The agent UUID
   * @param signals - Product-specific signals (partial ASC update)
   */
  writeASC(agentId: string, signals: Record<string, unknown>): Promise<void>;

  /**
   * Read the risk summary for authorization decisions.
   * @param agentId - The agent UUID
   * @returns Risk summary from ASC cache
   */
  readRiskSummary(agentId: string): Promise<RiskSummary | null>;

  /**
   * Run NanoMind inference via the daemon.
   * @param intent - Intent type (e.g., SCAN_SKILL_INTENT)
   * @param input - Input text to analyze
   * @param context - Agent context for inference
   */
  infer(intent: string, input: string, context?: InferContext): Promise<InferResponse>;
}

export interface RiskSummary {
  agentId: string;
  overallRisk: 'critical' | 'high' | 'medium' | 'low';
  overallRiskScore: number;
  driftScore: number;
  activeAlerts: number;
  atcTrustLevel: number;
  scanVerdict: string;
}

export interface InferContext {
  agentId?: string;
  driftScore?: number;
  declaredPurpose?: string;
}

/**
 * BaseFabricAdapter provides a default implementation that calls the daemon
 * HTTP endpoint and the Registry ASC API.
 */
export class BaseFabricAdapter implements FabricAdapter {
  readonly productId: string;
  private daemonUrl: string;
  private registryUrl: string;

  constructor(productId: string, options?: { daemonUrl?: string; registryUrl?: string }) {
    this.productId = productId;
    this.daemonUrl = options?.daemonUrl ?? 'http://127.0.0.1:47200';
    this.registryUrl = options?.registryUrl ?? 'https://api.oa2a.org';
  }

  async writeASC(agentId: string, signals: Record<string, unknown>): Promise<void> {
    const url = `${this.registryUrl}/internal/asc/${agentId}`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signals),
    });
    if (!resp.ok) {
      throw new Error(`ASC write failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async readRiskSummary(agentId: string): Promise<RiskSummary | null> {
    const url = `${this.registryUrl}/api/v1/asc/${agentId}/risk-summary`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json() as Promise<RiskSummary>;
  }

  async infer(intent: string, input: string, context?: InferContext): Promise<InferResponse> {
    const url = `${this.daemonUrl}/v1/infer`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, input, context }),
    });

    if (resp.status === 503) {
      throw new Error('daemon_unavailable');
    }
    if (resp.status === 429) {
      throw new Error('queue_full');
    }
    if (!resp.ok) {
      throw new Error(`Inference failed: ${resp.status}`);
    }

    return resp.json() as Promise<InferResponse>;
  }
}

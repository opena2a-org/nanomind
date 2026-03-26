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
export declare class BaseFabricAdapter implements FabricAdapter {
    readonly productId: string;
    private daemonUrl;
    private registryUrl;
    constructor(productId: string, options?: {
        daemonUrl?: string;
        registryUrl?: string;
    });
    writeASC(agentId: string, signals: Record<string, unknown>): Promise<void>;
    readRiskSummary(agentId: string): Promise<RiskSummary | null>;
    infer(intent: string, input: string, context?: InferContext): Promise<InferResponse>;
}

/**
 * @nanomind/atc — ATC Intent Handler
 *
 * Thin wrapper around the Registry ATC API. Handles authentication,
 * caching, and plain-English formatting of ATC data.
 *
 * Does NOT use language model inference — uses structured data formatting.
 */
export interface ATCSummary {
    agentId: string;
    trustLevel: number;
    trustScore: number;
    version: string;
    expiresAt: string;
    issuerDid: string;
    signatureCount: number;
    scanSummary: {
        hma: string;
        criticalFindings: number;
        highFindings: number;
    } | null;
}
export interface ATCExplanation {
    agentId: string;
    currentLevel: number;
    currentScore: number;
    factors: ATCFactor[];
    projectedLevel: number;
    projectedScore: number;
    summary: string;
}
export interface ATCFactor {
    name: string;
    status: 'present' | 'missing' | 'partial';
    impact: string;
    fix: string;
}
export interface ATCConfig {
    registryUrl?: string;
    apiKey?: string;
    cacheTTLMs?: number;
}
export declare class ATCIntentHandler {
    private registryUrl;
    private apiKey;
    private cache;
    private cacheTTL;
    constructor(config?: ATCConfig);
    /**
     * TRUST_QUERY intent — get trust level of an agent.
     */
    getTrustLevel(agentId: string): Promise<ATCSummary | null>;
    /**
     * ATC_STATUS intent — explain WHY the trust level is what it is.
     * This is the most important method. Produces plain-English explanation
     * with specific remediation steps.
     */
    explainTrustLevel(agentId: string): Promise<ATCExplanation>;
    /**
     * Fetch ATC from Registry (with caching).
     */
    private fetchATC;
}
export default ATCIntentHandler;

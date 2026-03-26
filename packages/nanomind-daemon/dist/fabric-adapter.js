"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseFabricAdapter = void 0;
/**
 * BaseFabricAdapter provides a default implementation that calls the daemon
 * HTTP endpoint and the Registry ASC API.
 */
class BaseFabricAdapter {
    productId;
    daemonUrl;
    registryUrl;
    constructor(productId, options) {
        this.productId = productId;
        this.daemonUrl = options?.daemonUrl ?? 'http://127.0.0.1:47200';
        this.registryUrl = options?.registryUrl ?? 'https://api.oa2a.org';
    }
    async writeASC(agentId, signals) {
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
    async readRiskSummary(agentId) {
        const url = `${this.registryUrl}/api/v1/asc/${agentId}/risk-summary`;
        const resp = await fetch(url);
        if (!resp.ok)
            return null;
        return resp.json();
    }
    async infer(intent, input, context) {
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
        return resp.json();
    }
}
exports.BaseFabricAdapter = BaseFabricAdapter;

/**
 * NanoMind Adapter Contracts
 *
 * Any CLI tool can implement the CLIAdapter interface to become NanoMind-compatible.
 * Any runtime protection system can implement RuntimeAdapter for behavioral anomaly detection.
 */

// === CLI Adapter (for CLI tools like HMA, secretless-ai, opena2a) ===

export interface CommandManifest {
  commands: CommandEntry[];
  checkRegistry?: CheckEntry[];
}

export interface CommandEntry {
  name: string;
  description: string;
  aliases?: string[];
  args?: string[];
  flags?: string[];
}

export interface CheckEntry {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
}

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface ScanHistoryEntry {
  timestamp: string;
  findings: number;
  score: number;
}

export interface ATCData {
  agentId: string;
  trustLevel: number;
  trustScore: number;
  expiresAt: string;
}

export interface NanoMindCLIAdapter {
  cliName: string;
  cliVersion: string;
  getCommandManifest(): CommandManifest;
  executeCommand(cmd: string): Promise<ExecutionResult>;
  getScanHistory(): ScanHistoryEntry[];
  getCheckRegistry?(): CheckEntry[];
  getATCData?(): ATCData;
}

// === Runtime Adapter (for ARP behavioral twin) ===

export type EventType =
  | 'TOOL_CALL'
  | 'CAPABILITY_CHECK'
  | 'MCP_CALL'
  | 'MEMORY_READ'
  | 'MEMORY_WRITE'
  | 'EXTERNAL_CALL';

export type ARPAction = 'allow' | 'alert' | 'throttle' | 'suspend' | 'kill';

export interface BehavioralEvent {
  agentId: string;
  sessionId: string;
  sequenceNum: number;
  eventType: EventType;
  capability: string;
  toolName: string | null;
  argHash: string;
  timestampDelta: number;
  wallClock: number;
  responseSize: number;
  responseCode: number;
  l0Decision: 'allow' | 'block' | 'alert';
}

export type Unsubscribe = () => void;

export interface NanoMindRuntimeAdapter {
  agentId: string;
  agentCategory: string;
  subscribeToBehavioralEvents(
    handler: (event: BehavioralEvent) => void,
  ): Unsubscribe;
  getATCContentHash(): string;
  onAnomalyDetected(
    handler: (score: number, action: ARPAction) => void,
  ): Unsubscribe;
  isOfflineMode(): boolean;
}

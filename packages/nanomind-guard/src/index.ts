/**
 * @nanomind/guard — Prompt Injection Detection for CLI
 *
 * Protects the NanoMind routing layer from injection attacks via piped input,
 * environment variables, or scanned agent output that attempts to hijack
 * the CLI into executing unintended commands.
 *
 * Runs BEFORE the router on all non-direct input (piped, file, env).
 */

import * as fs from 'node:fs';
import * as tty from 'node:tty';

export type InputSource = 'direct' | 'piped' | 'file' | 'env' | 'agent-output';

export interface GuardResult {
  safe: boolean;
  patterns: DetectedPattern[];
  source: InputSource;
  recommendation: string;
}

export interface DetectedPattern {
  type: InjectionType;
  match: string;
  position: number;
  severity: 'critical' | 'high' | 'medium';
}

export type InjectionType =
  | 'instruction_override'
  | 'role_switching'
  | 'permission_escalation'
  | 'indirect_injection'
  | 'chained_injection'
  | 'encoded_payload';

// Detection patterns with severity
const INJECTION_PATTERNS: Array<{
  pattern: RegExp;
  type: InjectionType;
  severity: 'critical' | 'high' | 'medium';
}> = [
  // Instruction override
  { pattern: /ignore\s+(previous|above|all)\s+(instructions?|prompts?|rules?)/i, type: 'instruction_override', severity: 'critical' },
  { pattern: /disregard\s+(the\s+)?(above|previous|system)/i, type: 'instruction_override', severity: 'critical' },
  { pattern: /new\s+system\s+prompt/i, type: 'instruction_override', severity: 'critical' },
  { pattern: /override\s+(the\s+)?instructions/i, type: 'instruction_override', severity: 'critical' },
  { pattern: /forget\s+(everything|all|what)\s+(you|we)/i, type: 'instruction_override', severity: 'critical' },

  // Role switching
  { pattern: /you\s+are\s+now\s+(a|an|the)/i, type: 'role_switching', severity: 'critical' },
  { pattern: /act\s+as\s+(a|an|if)\b/i, type: 'role_switching', severity: 'high' },
  { pattern: /pretend\s+(you\s+are|to\s+be)/i, type: 'role_switching', severity: 'high' },
  { pattern: /your\s+new\s+role\s+is/i, type: 'role_switching', severity: 'critical' },
  { pattern: /switch\s+to\s+(admin|root|system)\s+mode/i, type: 'role_switching', severity: 'critical' },

  // Permission escalation
  { pattern: /you\s+have\s+been\s+granted/i, type: 'permission_escalation', severity: 'critical' },
  { pattern: /admin\s+mode\s+enabled/i, type: 'permission_escalation', severity: 'critical' },
  { pattern: /safety\s+(disabled|off|removed)/i, type: 'permission_escalation', severity: 'critical' },
  { pattern: /bypass\s+(the\s+)?(security|safety|filter|guard)/i, type: 'permission_escalation', severity: 'critical' },
  { pattern: /sudo\s+mode/i, type: 'permission_escalation', severity: 'high' },

  // Indirect injection (hidden instructions)
  { pattern: /[\u200B-\u200F\u2028-\u202F\uFEFF]/, type: 'indirect_injection', severity: 'high' },
  { pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, type: 'indirect_injection', severity: 'high' },

  // Encoded payloads
  { pattern: /(?:eval|exec|system|spawn)\s*\(\s*(?:atob|Buffer\.from|decodeURI)/i, type: 'encoded_payload', severity: 'critical' },
  { pattern: /base64[_\s]*(?:decode|d)\s*\(/i, type: 'encoded_payload', severity: 'medium' },
];

const SOURCE_LABELS: Record<InputSource, string> = {
  direct: 'direct input',
  piped: 'piped input',
  file: 'file input',
  env: 'environment input',
  'agent-output': 'agent output',
};

/**
 * Screen input for injection attempts.
 * Returns a GuardResult indicating whether the input is safe to process.
 */
export function screenInput(input: string, source: InputSource = 'direct'): GuardResult {
  // Direct input from user typing is always trusted
  if (source === 'direct') {
    return { safe: true, patterns: [], source, recommendation: '' };
  }

  const detected: DetectedPattern[] = [];

  for (const { pattern, type, severity } of INJECTION_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      detected.push({
        type,
        match: match[0],
        position: match.index ?? 0,
        severity,
      });
    }
  }

  const hasCritical = detected.some(d => d.severity === 'critical');
  const hasHigh = detected.some(d => d.severity === 'high');

  let recommendation = '';
  if (hasCritical) {
    recommendation = 'BLOCKED: Critical injection pattern detected. This input appears to contain instructions designed to hijack NanoMind. The command was not executed.';
  } else if (hasHigh) {
    recommendation = `WARNING: Suspicious pattern detected in ${SOURCE_LABELS[source]}. Review the input before proceeding. Use --no-guard to bypass (not recommended).`;
  } else if (detected.length > 0) {
    recommendation = 'NOTICE: Minor suspicious pattern detected. Proceeding with caution.';
  }

  return {
    safe: !hasCritical,
    patterns: detected,
    source,
    recommendation,
  };
}

/**
 * Determine where the input on a file descriptor (stdin by default) comes
 * from: a terminal is 'direct', a regular file redirected to it is 'file',
 * and anything else (a pipe, a socket, a device) is 'piped'.
 */
export function detectInputSource(fd: number = 0): InputSource {
  if (tty.isatty(fd)) return 'direct';
  try {
    if (fs.fstatSync(fd).isFile()) return 'file';
  } catch {
    // A closed descriptor cannot be identified; it is screened as piped.
  }
  return 'piped';
}

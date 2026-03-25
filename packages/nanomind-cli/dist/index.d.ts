#!/usr/bin/env node
/**
 * @nanomind/cli — Unified NanoMind CLI Entry Point
 *
 * When invoked with no args, launches the interactive NanoMind prompt.
 * When invoked with --no-smart, falls through to the underlying CLI tool.
 *
 * This is the entry point that HMA, secretless-ai, and opena2a adapters
 * delegate to when the user runs their CLI with no arguments.
 */
export interface NanoMindSession {
    cliName: string;
    cliVersion: string;
    registryUrl: string;
    onCommand: (cmd: string, args: string[]) => Promise<string>;
}
/**
 * Start an interactive NanoMind session.
 */
export declare function startSession(session: NanoMindSession): Promise<void>;
export default startSession;

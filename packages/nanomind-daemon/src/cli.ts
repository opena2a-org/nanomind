#!/usr/bin/env node

import { NanoMindDaemon, DEFAULT_CONFIG } from './server.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.nanomind');
const PID_FILE = join(STATE_DIR, 'daemon.pid');

const command = process.argv[2] ?? 'help';

async function main(): Promise<void> {
  switch (command) {
    case 'start':
      await startDaemon();
      break;
    case 'stop':
      await stopDaemon();
      break;
    case 'status':
      await showStatus();
      break;
    case 'help':
    default:
      printUsage();
  }
}

async function startDaemon(): Promise<void> {
  // Check if already running
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0); // Check if process exists
      console.error(`Daemon already running (PID ${pid}). Use 'stop' first.`);
      process.exit(1);
    } catch {
      // Stale PID file, clean up
      unlinkSync(PID_FILE);
    }
  }

  const port = parseInt(process.env['NANOMIND_PORT'] ?? String(DEFAULT_CONFIG.httpPort), 10);
  const idleSeconds = parseInt(process.env['MODEL_IDLE_UNLOAD_SECONDS'] ?? String(DEFAULT_CONFIG.idleUnloadSeconds), 10);

  const daemon = new NanoMindDaemon({
    httpPort: port,
    idleUnloadSeconds: idleSeconds,
  });

  daemon.on('started', ({ port }: { port: number }) => {
    // Write PID file
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid));

    console.log(`NanoMind daemon started on http://127.0.0.1:${port}`);
    console.log(`PID: ${process.pid}`);
    console.log(`Model idle unload: ${idleSeconds}s`);
    console.log(`Max concurrent: ${DEFAULT_CONFIG.maxConcurrent}`);
  });

  daemon.on('model_loaded', () => {
    console.log('Model loaded into memory');
  });

  daemon.on('idle_unload', () => {
    console.log('Model unloaded (idle timeout)');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await daemon.stop();
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await daemon.start();
}

async function stopDaemon(): Promise<void> {
  if (!existsSync(PID_FILE)) {
    console.log('Daemon is not running');
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID ${pid})`);
  } catch {
    console.log(`Daemon (PID ${pid}) is not running. Cleaning up PID file.`);
  }

  unlinkSync(PID_FILE);
}

async function showStatus(): Promise<void> {
  const port = parseInt(process.env['NANOMIND_PORT'] ?? String(DEFAULT_CONFIG.httpPort), 10);

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/status`);
    if (resp.ok) {
      const status = await resp.json();
      console.log('NanoMind Daemon Status:');
      console.log(`  Running:      ${status.running}`);
      console.log(`  Port:         ${status.port}`);
      console.log(`  Active tasks: ${status.activeTasks}`);
      console.log(`  Model loaded: ${status.modelLoaded}`);
      console.log(`  Uptime:       ${Math.round(status.uptime / 1000)}s`);
    } else {
      console.log('Daemon returned error:', resp.status);
    }
  } catch {
    // Check PID file
    if (existsSync(PID_FILE)) {
      const pid = readFileSync(PID_FILE, 'utf-8').trim();
      console.log(`Daemon PID file exists (PID ${pid}) but not responding on port ${port}`);
    } else {
      console.log('Daemon is not running');
    }
  }
}

function printUsage(): void {
  console.log(`
NanoMind Daemon - Persistent inference server

Usage:
  nanomind-daemon start     Start the daemon
  nanomind-daemon stop      Stop the daemon
  nanomind-daemon status    Show daemon status
  nanomind-daemon help      Show this message

Environment:
  NANOMIND_PORT               HTTP port (default: 47200)
  MODEL_IDLE_UNLOAD_SECONDS   Unload model after N seconds idle (default: 300)

API:
  POST http://127.0.0.1:47200/v1/infer
    Body: { intent, input, context: { agentId, driftScore, declaredPurpose }, priority }
    Response: { intent, result, confidence, attackClass, evidence, remediation, latencyMs, modelVersion }

  GET  http://127.0.0.1:47200/v1/status
  GET  http://127.0.0.1:47200/health
`.trim());
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_js_1 = require("./server.js");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const STATE_DIR = (0, node_path_1.join)((0, node_os_1.homedir)(), '.nanomind');
const PID_FILE = (0, node_path_1.join)(STATE_DIR, 'daemon.pid');
const PACKAGE_JSON_PATH = (0, node_path_1.join)(__dirname, '..', 'package.json');
const command = process.argv[2] ?? 'help';
if (command === '--version' || command === '-v') {
    const version = JSON.parse((0, node_fs_1.readFileSync)(PACKAGE_JSON_PATH, 'utf-8')).version;
    console.log(version);
    process.exit(0);
}
if (command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
}
async function main() {
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
            printUsage();
            break;
        default:
            console.error(`Unknown command: ${command}`);
            printUsage();
            process.exit(1);
    }
}
async function startDaemon() {
    // Check if already running
    if ((0, node_fs_1.existsSync)(PID_FILE)) {
        const pid = parseInt((0, node_fs_1.readFileSync)(PID_FILE, 'utf-8').trim(), 10);
        try {
            process.kill(pid, 0); // Check if process exists
            console.error(`Daemon already running (PID ${pid}). Use 'stop' first.`);
            process.exit(1);
        }
        catch {
            // Stale PID file, clean up
            (0, node_fs_1.unlinkSync)(PID_FILE);
        }
    }
    const port = parseInt(process.env['NANOMIND_PORT'] ?? String(server_js_1.DEFAULT_CONFIG.httpPort), 10);
    const idleSeconds = parseInt(process.env['MODEL_IDLE_UNLOAD_SECONDS'] ?? String(server_js_1.DEFAULT_CONFIG.idleUnloadSeconds), 10);
    const daemon = new server_js_1.NanoMindDaemon({
        httpPort: port,
        idleUnloadSeconds: idleSeconds,
    });
    daemon.on('started', ({ port }) => {
        // Write PID file
        (0, node_fs_1.mkdirSync)(STATE_DIR, { recursive: true });
        (0, node_fs_1.writeFileSync)(PID_FILE, String(process.pid));
        console.log(`NanoMind daemon started on http://127.0.0.1:${port}`);
        console.log(`PID: ${process.pid}`);
        console.log(`Model idle unload: ${idleSeconds}s`);
        console.log(`Max concurrent: ${server_js_1.DEFAULT_CONFIG.maxConcurrent}`);
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
        if ((0, node_fs_1.existsSync)(PID_FILE))
            (0, node_fs_1.unlinkSync)(PID_FILE);
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await daemon.start();
}
async function stopDaemon() {
    if (!(0, node_fs_1.existsSync)(PID_FILE)) {
        console.log('Daemon is not running');
        return;
    }
    const pid = parseInt((0, node_fs_1.readFileSync)(PID_FILE, 'utf-8').trim(), 10);
    try {
        process.kill(pid, 'SIGTERM');
        console.log(`Sent SIGTERM to daemon (PID ${pid})`);
    }
    catch {
        console.log(`Daemon (PID ${pid}) is not running. Cleaning up PID file.`);
    }
    (0, node_fs_1.rmSync)(PID_FILE, { force: true });
}
async function showStatus() {
    const port = parseInt(process.env['NANOMIND_PORT'] ?? String(server_js_1.DEFAULT_CONFIG.httpPort), 10);
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
        }
        else {
            console.log('Daemon returned error:', resp.status);
        }
    }
    catch {
        // Check PID file
        if ((0, node_fs_1.existsSync)(PID_FILE)) {
            const pid = (0, node_fs_1.readFileSync)(PID_FILE, 'utf-8').trim();
            console.log(`Daemon PID file exists (PID ${pid}) but not responding on port ${port}`);
        }
        else {
            console.log('Daemon is not running');
        }
    }
}
function printUsage() {
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

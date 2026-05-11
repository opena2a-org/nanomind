"""start / stop / restart / status / logs subcommands.

`start` and `stop` wrap launchctl. `status` probes the Unix socket. `logs`
opens the launchd-managed log file in `tail -f` mode.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from . import launchd, paths


def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _healthz_once(timeout_sec: float = 2.0) -> dict | None:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout_sec)
    try:
        sock.connect(paths.SOCK_PATH)
    except OSError:
        return None
    try:
        sock.sendall(b'{"op":"healthz"}\n')
        buf = bytearray()
        deadline = time.monotonic() + timeout_sec
        while b"\n" not in buf and time.monotonic() < deadline:
            try:
                chunk = sock.recv(64 * 1024)
            except socket.timeout:
                break
            if not chunk:
                break
            buf.extend(chunk)
        line, _, _ = buf.partition(b"\n")
        if not line:
            return None
        try:
            return json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
    finally:
        sock.close()


def run_status() -> int:
    """Report whether the agent is loaded and whether the daemon answers."""
    rc, agent_state = launchd.print_state()
    if rc != 0:
        _emit("agent: not loaded")
        _emit("  run `nanomind-analyst install` to install + start the daemon")
        return 1
    _emit("agent: loaded")

    if not Path(paths.SOCK_PATH).exists():
        _emit(f"socket: missing at {paths.SOCK_PATH}")
        _emit("  daemon may still be booting; rerun in a few seconds")
        _emit(f"  or check `nanomind-analyst logs` (tail {paths.log_path()})")
        return 1
    _emit(f"socket: present at {paths.SOCK_PATH}")

    health = _healthz_once()
    if health is None:
        _emit("healthz: no response")
        _emit(f"  check `nanomind-analyst logs` (tail {paths.log_path()})")
        return 1
    if health.get("daemonState") == "ready":
        _emit(
            f"healthz: ready ("
            f"requestsServed={health.get('requestsServed')}, "
            f"uptimeSec={health.get('uptimeSec'):.0f})"
        )
        return 0
    _emit(f"healthz: {health.get('daemonState')!r}")
    probe = health.get("gateProbe") or {}
    if probe:
        _emit(
            f"  gate probe: label={probe.get('label')!r} "
            f"expected={probe.get('expected')!r} "
            f"passed={probe.get('passed')}"
        )
    return 1


def run_start() -> int:
    launchd.kickstart(restart=False)
    _emit("kickstarted; run `nanomind-analyst status` to confirm ready")
    return 0


def run_stop() -> int:
    launchd.stop_service()
    _emit("stop sent; the agent stays loaded but the daemon process exits")
    _emit("  to fully unload, run `nanomind-analyst uninstall`")
    return 0


def run_restart() -> int:
    launchd.kickstart(restart=True)
    _emit("restart sent; run `nanomind-analyst status` to confirm ready")
    return 0


def run_logs(*, follow: bool = True) -> int:
    """Tail the launchd-managed log file.

    Defaults to follow mode (-f). Use --no-follow for a one-shot read.
    """
    log = paths.log_path()
    if not log.exists():
        _emit(f"log file missing: {log}")
        _emit("  the daemon may not have run yet")
        return 1
    cmd = ["/usr/bin/tail"]
    if follow:
        cmd.extend(["-F", "-n", "200"])
    else:
        cmd.extend(["-n", "200"])
    cmd.append(str(log))
    # exec replaces the current process so the user gets `tail`'s exit code
    # and signal handling (Ctrl-C exits cleanly).
    os.execv(cmd[0], cmd)  # noqa: S606 — fixed path, no shell, no injection
    return 0  # unreachable

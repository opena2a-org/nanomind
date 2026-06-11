"""start / stop / restart / status / logs subcommands.

`start` and `stop` wrap launchctl. `status` probes the Unix socket. `logs`
opens the launchd-managed log file in `tail -f` mode.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import time
from pathlib import Path

from . import artifacts, launchd, paths


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


def run_status(*, json_output: bool = False) -> int:
    """Report whether the agent is loaded and whether the daemon answers.

    With json_output=True, emit a single JSON line with camelCase keys
    suitable for parsing by downstream tools (HMA, opena2a-cli, ai-trust).
    Exit codes match the human-formatted mode: 0 when fully ready, 1
    otherwise.
    """
    rc, _agent_state = launchd.print_state()
    if rc != 0:
        if json_output:
            _emit_json({"agent": {"loaded": False}})
        else:
            _emit("agent: not loaded")
            _emit("  run `nanomind-analyst install` to install + start the daemon")
        return 1
    if not json_output:
        _emit("agent: loaded")

    if not Path(paths.SOCK_PATH).exists():
        if json_output:
            _emit_json(
                {
                    "agent": {"loaded": True},
                    "socket": {"path": paths.SOCK_PATH, "present": False},
                }
            )
        else:
            _emit(f"socket: missing at {paths.SOCK_PATH}")
            _emit("  daemon may still be booting; rerun in a few seconds")
            _emit(f"  or check `nanomind-analyst logs` (tail {paths.log_path()})")
        return 1
    if not json_output:
        _emit(f"socket: present at {paths.SOCK_PATH}")

    health = _healthz_once()
    if health is None:
        if json_output:
            _emit_json(
                {
                    "agent": {"loaded": True},
                    "socket": {"path": paths.SOCK_PATH, "present": True},
                    "healthz": {"state": "no-response"},
                }
            )
        else:
            _emit("healthz: no response")
            _emit(f"  check `nanomind-analyst logs` (tail {paths.log_path()})")
        return 1
    if health.get("daemonState") == "ready":
        uptime = health.get("uptimeSec")
        # Artifact drift: a pip upgrade leaves the installed classifier (and
        # the plist's SHA pins) untouched, so a daemon can be "ready" while
        # serving an artifact this wheel no longer ships — e.g. the old
        # threshold-0.65 gate after the 0.1.3 upgrade. Surface it; never
        # leave it silent. Exit code stays 0: the daemon IS serving.
        drifted = artifacts.installed_classifier_drift(paths.classifier_dir())
        threshold = health.get("classifierThreshold")
        if json_output:
            healthz_block: dict = {
                "state": "ready",
                "requestsServed": health.get("requestsServed"),
            }
            if isinstance(uptime, (int, float)):
                healthz_block["uptimeSec"] = uptime
            if isinstance(threshold, (int, float)):
                healthz_block["classifierThreshold"] = threshold
            payload: dict = {
                "agent": {"loaded": True},
                "socket": {"path": paths.SOCK_PATH, "present": True},
                "healthz": healthz_block,
                "artifact": {"classifierMatchesWheel": not drifted},
            }
            if drifted:
                payload["artifact"]["driftedFiles"] = drifted
            _emit_json(payload)
        else:
            uptime_str = f"{uptime:.0f}" if isinstance(uptime, (int, float)) else "?"
            _emit(
                f"healthz: ready ("
                f"requestsServed={health.get('requestsServed')}, "
                f"uptimeSec={uptime_str})"
            )
            if isinstance(threshold, (int, float)):
                _emit(f"gate threshold: {threshold:.2f}")
            if drifted:
                _emit(
                    f"artifact: input-classifier drifted from this wheel "
                    f"({', '.join(drifted)})"
                )
                _emit(
                    "  the running daemon is serving an older artifact "
                    "(possibly an older gate operating point)"
                )
                _emit("  run `nanomind-analyst install` to update it")
        return 0
    if json_output:
        healthz_block = {"state": health.get("daemonState")}
        probe = health.get("gateProbe") or {}
        if probe:
            healthz_block["gateProbe"] = {
                "label": probe.get("label"),
                "expected": probe.get("expected"),
                "passed": probe.get("passed"),
            }
        _emit_json(
            {
                "agent": {"loaded": True},
                "socket": {"path": paths.SOCK_PATH, "present": True},
                "healthz": healthz_block,
            }
        )
        return 1
    _emit(f"healthz: {health.get('daemonState')!r}")
    probe = health.get("gateProbe") or {}
    if probe:
        _emit(
            f"  gate probe: label={probe.get('label')!r} "
            f"expected={probe.get('expected')!r} "
            f"passed={probe.get('passed')}"
        )
    return 1


def _emit_json(payload: dict) -> None:
    _emit(json.dumps(payload))


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

"""Orchestrate the install: platform check -> classifier copy -> NLM fetch ->
plist write -> launchctl bootstrap -> healthz wait.

Each step prints a one-line update to stdout so a human watching the install
sees forward progress (the NLM fetch is the long step, several minutes on a
warm HF cache, longer cold). Errors abort the install but leave already-fetched
state on disk so a re-run picks up where it left off.
"""
from __future__ import annotations

import platform
import socket
import sys
import time
from pathlib import Path

from . import artifacts, launchd, paths


class InstallError(Exception):
    """Raised when the install cannot complete."""


def assert_supported_platform() -> None:
    """v0.1 supports Apple Silicon (Darwin arm64) only.

    Refusing on other platforms gives the user a clear pointer rather than
    failing later when the bf16-MPS daemon can't find a usable accelerator.
    """
    system = platform.system()
    machine = platform.machine()
    if system != "Darwin" or machine != "arm64":
        raise InstallError(
            f"unsupported platform: {system}/{machine}. The NanoMind Analyst "
            f"daemon is Apple Silicon (Darwin arm64) only in v0.1. The NLM is "
            f"bf16 on MPS; fp16 yields 0% accuracy on Qwen3-1.7B. Linux/cloud "
            f"support is tracked at "
            f"https://github.com/opena2a-org/nanomind/issues (label: "
            f"nanomind-analyst, platform-linux)."
        )


def _healthz_probe(timeout_sec: float = 60.0) -> bool:
    """Connect to the daemon's Unix socket and ask for healthz.

    Returns True if the daemon binds the socket and reports `daemonState=ready`
    within the timeout. Cold-boot of the v3 NLM takes ~30s on a warm HF cache;
    60s gives a safety margin.
    """
    import json

    deadline = time.monotonic() + timeout_sec
    last_err: str | None = None
    while time.monotonic() < deadline:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        try:
            sock.connect(paths.SOCK_PATH)
        except (FileNotFoundError, ConnectionRefusedError) as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            sock.close()
            time.sleep(1.0)
            continue
        except OSError as exc:
            last_err = f"OSError: {exc}"
            sock.close()
            time.sleep(1.0)
            continue
        try:
            sock.sendall(b'{"op":"healthz"}\n')
            buf = bytearray()
            while b"\n" not in buf and time.monotonic() < deadline:
                try:
                    chunk = sock.recv(64 * 1024)
                except socket.timeout:
                    chunk = b""
                if not chunk:
                    break
                buf.extend(chunk)
            line, _, _ = buf.partition(b"\n")
            if not line:
                last_err = "empty response"
                continue
            try:
                payload = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                last_err = f"bad json: {exc}"
                continue
            if payload.get("daemonState") == "ready":
                return True
            last_err = f"daemonState={payload.get('daemonState')!r}"
        finally:
            sock.close()
        time.sleep(1.0)
    sys.stderr.write(
        f"healthz did not return ready within {timeout_sec:.0f}s "
        f"(last: {last_err})\n"
    )
    return False


def _emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def run_install(*, skip_healthz_wait: bool = False) -> int:
    """Top-level install flow. Returns exit code (0 on success)."""
    assert_supported_platform()

    paths.app_support_dir().mkdir(parents=True, exist_ok=True)
    paths.logs_dir().mkdir(parents=True, exist_ok=True)

    _emit(f"installing classifier into {paths.classifier_dir()}")
    artifacts.install_classifier(
        source_dir=artifacts.wheel_classifier_source_dir(),
        target_dir=paths.classifier_dir(),
    )

    _emit(
        f"fetching NLM weights (~3.4 GB) from {artifacts.HF_REPO_ID}"
        f"@{artifacts.HF_REVISION[:7]}"
    )
    _emit("  this takes several minutes on first run; the cache speeds reruns")
    artifacts.fetch_nlm(
        target_dir=paths.nlm_dir(),
        progress=lambda p: _emit(f"  {p.stage}: {p.detail}"),
    )

    plist = launchd.write_plist(launchd.build_plist_spec())
    _emit(f"wrote launchd plist to {plist}")

    launchd.bootstrap(plist)
    _emit(f"bootstrapped {paths.LABEL} into gui/{paths.uid()}")

    if skip_healthz_wait:
        _emit("skipping healthz wait (--skip-healthz-wait)")
        return 0

    _emit("waiting for daemon to bind socket and pass healthz probe")
    if _healthz_probe(timeout_sec=60.0):
        _emit(f"daemon ready at {paths.SOCK_PATH}")
        _emit("run `nanomind-analyst status` to verify")
        return 0
    _emit("install completed but daemon did not pass healthz within 60s")
    _emit(f"check `nanomind-analyst logs` (tail {paths.log_path()})")
    return 1


def run_uninstall(*, remove_artifacts: bool = False) -> int:
    """Stop, unload, and remove the plist. Optionally remove artifacts.

    Artifacts (the 3.4 GB NLM) are not removed by default; re-installing then
    skips the multi-minute fetch.
    """
    launchd.bootout()
    plist = paths.plist_path()
    if plist.exists():
        plist.unlink()
    if remove_artifacts:
        import shutil

        if paths.app_support_dir().exists():
            shutil.rmtree(paths.app_support_dir())
    return 0

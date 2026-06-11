"""Orchestrate the install: platform check -> wheel classifier pre-flight
verify -> NLM fetch -> launchctl bootout -> classifier copy -> plist write ->
launchctl bootstrap -> healthz wait.

Each step prints a one-line update to stdout so a human watching the install
sees forward progress (the NLM fetch is the long step, several minutes on a
warm HF cache, longer cold). Errors abort the install but leave already-fetched
state on disk so a re-run picks up where it left off.
"""
from __future__ import annotations

import os
import platform
import socket
import stat
import sys
import time

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


def _assert_socket_owned_by_user(sock_path: str) -> None:
    """Refuse if /tmp/nanomind-guard.sock is a symlink or owned by another UID.

    The default socket lives at /tmp/ on macOS, which is a sticky-bit dir other
    users on the same host can write into. A malicious local user could pre-
    bind the path and answer healthz with attacker-controlled bytes; the
    installer would then report "ready" against an impostor daemon. lstat
    refuses symlinks (so an attacker cannot redirect to their socket via a
    symlink either) and the uid check rejects sockets created by other users.

    The daemon's own _bind_socket (vendored, daemon/nanomind_guard_daemon.py)
    already refuses non-sockets at the path; this is the installer-side
    complement.
    """
    st = os.lstat(sock_path)
    if stat.S_ISLNK(st.st_mode):
        raise InstallError(
            f"refusing to probe {sock_path}: it is a symlink. Another process "
            f"may be attempting to redirect the daemon. Remove it and rerun "
            f"`nanomind-analyst install`."
        )
    if st.st_uid != os.getuid():
        raise InstallError(
            f"refusing to probe {sock_path}: owned by uid {st.st_uid} (we are "
            f"uid {os.getuid()}). Another user on this host has bound the "
            f"socket path. Remove it (or have that user remove it) and rerun "
            f"`nanomind-analyst install`."
        )


def _healthz_probe(timeout_sec: float = 60.0) -> bool:
    """Connect to the daemon's Unix socket and ask for healthz.

    Returns True if the daemon binds the socket and reports `daemonState=ready`
    within the timeout. Cold-boot of the v3 NLM takes ~30s on a warm HF cache;
    60s gives a safety margin. Refuses to connect if the socket is a symlink
    or owned by a different uid — see _assert_socket_owned_by_user.
    """
    import json

    deadline = time.monotonic() + timeout_sec
    last_err: str | None = None
    while time.monotonic() < deadline:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        try:
            # Verify ownership BEFORE connect so we never feed bytes to an
            # attacker-bound socket.
            _assert_socket_owned_by_user(paths.SOCK_PATH)
            sock.connect(paths.SOCK_PATH)
        except FileNotFoundError as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            sock.close()
            time.sleep(1.0)
            continue
        except ConnectionRefusedError as exc:
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

    # Pre-flight: verify the wheel-embedded classifier against the baked SHA
    # pins BEFORE the 3.4 GB fetch. A corrupt or tampered wheel fails in the
    # first second instead of after a multi-minute transfer.
    _emit("verifying wheel-embedded classifier artifacts")
    artifacts.verify_wheel_classifier(artifacts.wheel_classifier_source_dir())

    # Fetch the NLM FIRST. It is the long, interruptible step (multi-minute
    # network transfer), and it must not sit between the two writes that have
    # to stay consistent: the classifier copy and the plist (which bakes the
    # expected classifier SHAs). If the classifier dir were updated before a
    # fetch that then aborts (network drop, Ctrl-C), the next daemon relaunch
    # would verify the NEW artifact against the OLD plist SHA and launchd
    # would crash-loop until install is re-run. Ordering the fetch first
    # keeps the artifact-dir + plist mutation window as small as possible.
    _emit(
        f"fetching NLM weights (~3.4 GB) from {artifacts.HF_REPO_ID}"
        f"@{artifacts.HF_REVISION[:7]}"
    )
    _emit("  this takes several minutes on first run; the cache speeds reruns")
    artifacts.fetch_nlm(
        target_dir=paths.nlm_dir(),
        progress=lambda p: _emit(f"  {p.stage}: {p.detail}"),
    )

    # bootout BEFORE mutating the artifact dir + plist, not after. With the
    # daemon unloaded during the mutation window, an interrupt between the
    # classifier copy and the plist write cannot crash-loop a RUNNING daemon
    # against mismatched SHA pins. (The window is shrunk, not fully closed:
    # the stale on-disk plist would still be loaded at the next GUI login if
    # install is never re-run.) bootout is idempotent on a not-loaded
    # service, and bootstrap below reloads the fresh plist either way —
    # without the bootout, launchctl bootstrap returns rc=17 ("already
    # loaded") and the daemon would keep running with the OLD in-memory
    # plist (old SHA constants, old model dir).
    launchd.bootout()

    # The trade for booting out first: a failure between here and bootstrap
    # leaves the daemon UNLOADED (the old order left a previously-healthy
    # daemon running until the end). That is deliberate — re-bootstrapping
    # the old plist against a half-mutated artifact dir would crash-loop —
    # but the user must be told the daemon is now stopped, not left to
    # discover it.
    try:
        _emit(f"installing classifier into {paths.classifier_dir()}")
        artifacts.install_classifier(
            source_dir=artifacts.wheel_classifier_source_dir(),
            target_dir=paths.classifier_dir(),
        )

        plist = launchd.write_plist(launchd.build_plist_spec())
        _emit(f"wrote launchd plist to {plist}")
    except BaseException:
        sys.stderr.write(
            "install failed after the daemon was unloaded; the daemon is "
            "now STOPPED (not crash-looping). Re-run `nanomind-analyst "
            "install` to restore a consistent artifact + plist and restart "
            "it.\n"
        )
        raise

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

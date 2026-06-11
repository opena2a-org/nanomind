"""Author the launchd plist for the NanoMind Analyst daemon.

The plist is installed as a per-user LaunchAgent at
~/Library/LaunchAgents/org.opena2a.nanomind-analyst.plist and bootstrapped with
`launchctl bootstrap gui/<UID>`. The plist does NOT use sudo, root, or the
system LaunchDaemon directory.

EnvironmentVariables include the SHA256 hashes of the input-classifier
artifacts. The daemon refuses to start without these (joblib.load is pickle =
ACE at deserialization). We bake the hashes into the plist so the daemon sees
them on every relaunch.
"""
from __future__ import annotations

import os
import plistlib
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import artifacts, paths


@dataclass(frozen=True)
class PlistSpec:
    label: str
    program: str  # absolute path to nanomind-analyst-daemon entrypoint
    python_executable: str  # bake the same Python that installed us
    classifier_dir: str
    model_dir: str
    classifier_joblib_sha256: str
    classifier_meta_sha256: str
    log_path: str
    sock_path: str


def build_plist_spec() -> PlistSpec:
    """Resolve a PlistSpec from the current install state.

    Caller invokes this AFTER fetch_nlm + install_classifier so the target
    directories exist.
    """
    return PlistSpec(
        label=paths.LABEL,
        program="nanomind-analyst-daemon",  # resolved via PATH at launch
        python_executable=artifacts.python_executable(),
        classifier_dir=str(paths.classifier_dir()),
        model_dir=str(paths.nlm_dir()),
        classifier_joblib_sha256=artifacts.EXPECTED_CLASSIFIER_JOBLIB_SHA256,
        classifier_meta_sha256=artifacts.EXPECTED_CLASSIFIER_META_SHA256,
        log_path=str(paths.log_path()),
        sock_path=paths.SOCK_PATH,
    )


def render_plist(spec: PlistSpec) -> bytes:
    """Render the launchd plist as XML bytes ready to write to disk."""
    # ProgramArguments resolves the entrypoint via the same Python that the
    # user installed the wheel into. This avoids the "/usr/bin/env python3"
    # PATH ambiguity that bit similar installers in the past.
    program_args = [
        spec.python_executable,
        "-m",
        "nanomind_analyst.daemon.nanomind_guard_daemon",
    ]
    body = {
        "Label": spec.label,
        "ProgramArguments": program_args,
        "RunAtLoad": True,
        # KeepAlive on crash but not on clean exit. A clean exit means the user
        # ran `nanomind-analyst stop` and we should respect that.
        "KeepAlive": {"SuccessfulExit": False, "Crashed": True},
        "StandardOutPath": spec.log_path,
        "StandardErrorPath": spec.log_path,
        "EnvironmentVariables": {
            "NANOMIND_GUARD_SOCK": spec.sock_path,
            "NANOMIND_GUARD_MODEL_DIR": spec.model_dir,
            "NANOMIND_GUARD_CLASSIFIER_DIR": spec.classifier_dir,
            "INPUT_CLASSIFIER_JOBLIB_SHA256": spec.classifier_joblib_sha256,
            "INPUT_CLASSIFIER_META_SHA256": spec.classifier_meta_sha256,
            # PYTHONUNBUFFERED makes the daemon's stdout telemetry lines flush
            # promptly into the launchd-managed log file. Without this, lines
            # buffer for tens of seconds and `logs` looks frozen.
            "PYTHONUNBUFFERED": "1",
        },
        # Use the user's home as working directory. The daemon reads no
        # relative paths, but launchd needs a valid cwd.
        "WorkingDirectory": str(paths.home()),
        # ProcessType=Interactive so launchd doesn't aggressively throttle the
        # bf16-MPS NLM during sleep/wake transitions. Background would suspend
        # in the middle of a 6-second generation.
        "ProcessType": "Interactive",
    }
    return plistlib.dumps(body, fmt=plistlib.FMT_XML)


def write_plist(spec: PlistSpec, *, target: Path | None = None) -> Path:
    """Write the plist to disk and return its path.

    Same-directory temp file + os.replace so launchd (or an interrupt) never
    observes a half-written plist at the canonical path.
    """
    target = target or paths.plist_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_bytes(render_plist(spec))
    os.replace(tmp, target)
    return target


class LaunchctlError(Exception):
    """Raised when a launchctl command fails."""


def _run_launchctl(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Run launchctl and surface its stderr on failure.

    `check=False` so we can produce actionable error messages rather than the
    default CalledProcessError stack trace.
    """
    return subprocess.run(
        ["/bin/launchctl", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def bootstrap(plist: Path) -> None:
    """Load the LaunchAgent into the user's gui session."""
    target = f"gui/{paths.uid()}"
    result = _run_launchctl(["bootstrap", target, str(plist)])
    if result.returncode == 0:
        return
    # bootstrap returns 17 (EEXIST) if the agent is already loaded. Treat that
    # as success — the caller wanted the agent loaded, and it is.
    if result.returncode == 17 or "already loaded" in (result.stderr or ""):
        return
    raise LaunchctlError(
        f"launchctl bootstrap failed (rc={result.returncode}). "
        f"stderr: {result.stderr.strip()}. "
        f"Verify {plist} is well-formed and that you are logged into a GUI "
        f"session (launchd per-user agents require an active console session)."
    )


def bootout() -> None:
    """Unload the LaunchAgent. Idempotent."""
    target = f"gui/{paths.uid()}/{paths.LABEL}"
    result = _run_launchctl(["bootout", target])
    # bootout returns 3 / "Could not find specified service" if it wasn't
    # loaded — that's fine, the caller wanted it unloaded and it is.
    if result.returncode == 0:
        return
    if result.returncode == 3 or "Could not find" in (result.stderr or ""):
        return
    raise LaunchctlError(
        f"launchctl bootout failed (rc={result.returncode}). "
        f"stderr: {result.stderr.strip()}."
    )


def kickstart(*, restart: bool = False) -> None:
    """Start the loaded LaunchAgent. With restart=True, stop first then start."""
    target = f"gui/{paths.uid()}/{paths.LABEL}"
    args = ["kickstart"]
    if restart:
        args.append("-k")
    args.append(target)
    result = _run_launchctl(args)
    if result.returncode == 0:
        return
    raise LaunchctlError(
        f"launchctl kickstart failed (rc={result.returncode}). "
        f"stderr: {result.stderr.strip()}. "
        f"Is the agent loaded? Run `nanomind-analyst install` first."
    )


def stop_service() -> None:
    """Send SIGTERM to the daemon. The agent stays loaded; KeepAlive=Crashed
    means it does NOT auto-restart on a clean exit. Use bootout() to fully
    unload."""
    target = f"gui/{paths.uid()}/{paths.LABEL}"
    result = _run_launchctl(["stop", paths.LABEL])
    if result.returncode == 0:
        return
    # `launchctl stop` is best-effort. If the service isn't running, fine.
    if "Could not find" in (result.stderr or ""):
        return
    raise LaunchctlError(
        f"launchctl stop failed (rc={result.returncode}). "
        f"stderr: {result.stderr.strip()}. target={target}"
    )


def print_state() -> tuple[int, str]:
    """Return (returncode, stdout) of `launchctl print gui/<UID>/<label>`.

    Used by `nanomind-analyst status` to report whether the agent is loaded.
    """
    target = f"gui/{paths.uid()}/{paths.LABEL}"
    result = _run_launchctl(["print", target])
    return (result.returncode, result.stdout or result.stderr or "")

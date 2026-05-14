"""NanoMind Analyst daemon - serves the Qwen3-1.7B Analyst NLM behind the
input-classifier gate over a Unix socket.

Vendored from opena2a-org/nanomind-training/serving (private repo) at the
v3.0.0 release. The serving daemon and the input-classifier predictor are
copied verbatim except for import paths (changed to package-relative) and the
removal of a sys.path hack that the private repo needed for editable installs.
"""
from __future__ import annotations

import os
import sys

_DIRECT_INVOCATION_HELP = (
    "nanomind-analyst-daemon is the launchd-managed daemon binary; do not\n"
    "run it directly. To control the daemon, use the nanomind-analyst CLI:\n"
    "\n"
    "  nanomind-analyst install    # set up launchd and start the daemon\n"
    "  nanomind-analyst start      # start the loaded LaunchAgent\n"
    "  nanomind-analyst status     # report daemon health\n"
    "  nanomind-analyst logs       # tail the launchd-managed log\n"
)


def guarded_daemon_main() -> int:
    """Console-script entrypoint for `nanomind-analyst-daemon`.

    Launchd invokes the daemon via `python -m
    nanomind_analyst.daemon.nanomind_guard_daemon` (see the rendered plist),
    so this entrypoint exists only to give pip-installed users a sensible
    response when they run the binary by hand:

      * Linux/Intel  - clear platform refusal, exit 2.
      * macOS arm64 without launchd env vars set - direct-invocation refusal
        with pointers to the user-facing CLI, exit 1.
      * --help / -h / --version - honored before any platform / env checks.

    The launchd EnvironmentVariables include INPUT_CLASSIFIER_JOBLIB_SHA256
    and INPUT_CLASSIFIER_META_SHA256; their absence is the signal that we
    are NOT being invoked by launchd.
    """
    from .. import __version__, install

    argv = sys.argv[1:]
    if any(a in ("--help", "-h") for a in argv):
        sys.stdout.write(_DIRECT_INVOCATION_HELP)
        return 0
    if "--version" in argv or "-V" in argv:
        sys.stdout.write(f"nanomind-analyst-daemon {__version__}\n")
        return 0

    try:
        install.assert_supported_platform()
    except install.InstallError as exc:
        sys.stderr.write(f"FATAL: {exc}\n")
        return 2

    if not os.environ.get("INPUT_CLASSIFIER_JOBLIB_SHA256") or not os.environ.get(
        "INPUT_CLASSIFIER_META_SHA256"
    ):
        sys.stderr.write(_DIRECT_INVOCATION_HELP)
        return 1

    from .nanomind_guard_daemon import main as _daemon_main

    return _daemon_main(sys.argv[1:])

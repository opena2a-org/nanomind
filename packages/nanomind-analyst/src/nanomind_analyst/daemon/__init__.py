"""NanoMind Analyst daemon — serves the Qwen3-1.7B Analyst NLM behind the
input-classifier gate over a Unix socket.

Vendored from opena2a-org/nanomind-training/serving (private repo) at the
v3.0.0 release. The serving daemon and the input-classifier predictor are
copied verbatim except for import paths (changed to package-relative) and the
removal of a sys.path hack that the private repo needed for editable installs.
"""
from __future__ import annotations

import sys


def guarded_daemon_main() -> int:
    """Wrap nanomind_guard_daemon.main with a Darwin-arm64 platform check.

    The `nanomind-analyst-daemon` console_script lands here so that a user who
    pip-installed the wheel on Linux or Intel macOS and runs the daemon
    directly gets a clear refusal message instead of a cryptic torch/MPS
    stacktrace deep in NLM loading.
    """
    from .. import install

    try:
        install.assert_supported_platform()
    except install.InstallError as exc:
        sys.stderr.write(f"FATAL: {exc}\n")
        return 2

    from .nanomind_guard_daemon import main as _daemon_main

    return _daemon_main(sys.argv[1:])

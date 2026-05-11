"""Filesystem paths the installer uses.

All paths live under the user's home; no root, no /opt. The launchd plist is
installed as a per-user LaunchAgent, not a system LaunchDaemon, so that the
user can install/uninstall without sudo.
"""
from __future__ import annotations

import os
from pathlib import Path

LABEL = "org.opena2a.nanomind-analyst"
SOCK_PATH = "/tmp/nanomind-guard.sock"


def home() -> Path:
    return Path.home()


def app_support_dir() -> Path:
    """`~/Library/Application Support/nanomind-analyst/`"""
    return home() / "Library" / "Application Support" / "nanomind-analyst"


def artifacts_dir() -> Path:
    """Where fetched NLM weights live."""
    return app_support_dir() / "artifacts"


def nlm_dir() -> Path:
    """Directory containing safetensors + tokenizer for the Analyst NLM."""
    return artifacts_dir() / "nanomind-security-analyst"


def classifier_dir() -> Path:
    """Directory containing the input-classifier-v1 joblib + meta.json."""
    return artifacts_dir() / "input-classifier-v1"


def launch_agents_dir() -> Path:
    return home() / "Library" / "LaunchAgents"


def plist_path() -> Path:
    return launch_agents_dir() / f"{LABEL}.plist"


def logs_dir() -> Path:
    return home() / "Library" / "Logs"


def log_path() -> Path:
    return logs_dir() / "nanomind-analyst.log"


def uid() -> int:
    return os.getuid()

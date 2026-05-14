"""Installer for the NanoMind Analyst daemon.

The daemon serves the v3.0.0 Qwen3-1.7B Analyst NLM behind an input-classifier
gate over a Unix socket. This package writes the launchd plist, fetches and
verifies the model artifacts, and manages the daemon lifecycle.

Apple Silicon (Darwin arm64) only in v0.1. The daemon is bf16 on MPS; fp16
yields 0% accuracy on Qwen3-1.7B.
"""
from importlib.metadata import PackageNotFoundError, version as _pkg_version

try:
    __version__ = _pkg_version("nanomind-analyst")
except PackageNotFoundError:
    # Source checkout before any install / dist-info exists.
    __version__ = "0+unknown"

__all__ = ["__version__"]

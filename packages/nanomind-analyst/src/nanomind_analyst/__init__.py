"""Installer for the NanoMind Analyst daemon.

The daemon serves the v3.0.0 Qwen3-1.7B Analyst NLM behind an input-classifier
gate over a Unix socket. This package writes the launchd plist, fetches and
verifies the model artifacts, and manages the daemon lifecycle.

Apple Silicon (Darwin arm64) only in v0.1. The daemon is bf16 on MPS; fp16
yields 0% accuracy on Qwen3-1.7B.
"""
__version__ = "0.1.0"

__all__ = ["__version__"]

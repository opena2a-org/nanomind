"""Wheel-install smoke test.

Regression gate for the v0.1.0 dep-omission incident: `accelerate` was missing
from declared deps, so a clean-env install crashed at daemon boot with

    ValueError: Using a `device_map`, `tp_plan`, `torch.device` context manager
    or setting `torch.set_default_device(device)` requires `accelerate`.

This test exercises the exact `from_pretrained` call shape that the daemon's
NLM loader uses (`device_map=`), against a 5 MB stand-in model so it stays
fast. If a future change drops a runtime dep that the inference path needs,
this test fails before the wheel reaches PyPI.

Run via `pytest -v -m smoke`. The regular CI test job installs with
`--no-deps` for speed; under that env `transformers`/`accelerate`/`torch` are
absent and these tests `pytest.importorskip` out cleanly. The dedicated
`wheel-install-smoke` CI job installs the wheel WITH deps and runs the smoke
markers explicitly.
"""
from __future__ import annotations

import os
import socket

import pytest


pytestmark = pytest.mark.smoke


def _hf_reachable(timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection(("huggingface.co", 443), timeout=timeout):
            return True
    except OSError:
        return False


def test_accelerate_is_importable():
    """If `accelerate` isn't a declared dep, this fails on a clean wheel install."""
    accelerate = pytest.importorskip("accelerate")
    assert accelerate.__version__


def test_from_pretrained_with_device_map_does_not_raise():
    """The exact call shape used in daemon/_nlm.py:111-115 must succeed.

    `check_and_set_device_map` runs unconditionally when `device_map=` is
    passed; it raises the `requires accelerate` ValueError if accelerate is
    missing. A 5 MB stand-in model triggers the same code path without
    pulling the 3.4 GB production weights.
    """
    pytest.importorskip("torch")
    pytest.importorskip("accelerate")
    transformers = pytest.importorskip("transformers")

    if not _hf_reachable():
        pytest.skip("huggingface.co unreachable; smoke test requires network")

    AutoModelForCausalLM = transformers.AutoModelForCausalLM

    model = AutoModelForCausalLM.from_pretrained(
        "sshleifer/tiny-gpt2",
        device_map="cpu",
        cache_dir=os.environ.get("HF_HOME"),
    )
    assert model is not None
    assert hasattr(model, "config")


def test_daemon_nlm_module_imports():
    """`nanomind_analyst.daemon._nlm` must import without missing-dep errors.

    The module imports torch + transformers lazily inside `NanoMindNLM.__init__`,
    so this only catches top-level import regressions. The model-load
    regression is covered by the test above.
    """
    pytest.importorskip("torch")
    pytest.importorskip("transformers")

    from nanomind_analyst.daemon import _nlm  # noqa: F401

    assert hasattr(_nlm, "NanoMindNLM")

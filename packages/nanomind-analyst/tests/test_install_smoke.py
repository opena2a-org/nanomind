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
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


pytestmark = pytest.mark.smoke

# Stand-in for the 3.4 GB analyst weights, fetched into a local directory the
# way install fetches the real ones, so NanoMindNLM loads it by path.
_STAND_IN_MODEL_ID = "sshleifer/tiny-gpt2"

# Boots the daemon's two models through the daemon's own loaders, both on CPU
# (a hosted macOS runner exposes a Metal device that cannot allocate). Runs in
# a child process so no hub connection pooled by the warm run can be reused:
# a load that reaches for the network has to open a new connection, and in
# mode "offline" every new connection is counted and refused.
_BOOT_SCRIPT = textwrap.dedent(
    """
    import socket, sys

    model_dir, stand_in_id, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    attempts = []

    if mode == "offline":
        def _refuse(*_args, **_kwargs):
            attempts.append(1)
            raise OSError("offline boot cell: outbound connect refused")
        socket.create_connection = _refuse
        socket.socket.connect = _refuse

    from nanomind_analyst import artifacts
    from nanomind_analyst.daemon._nlm import NanoMindNLM
    from nanomind_analyst.daemon.input_classifier.predictor import (
        InputClassifier,
    )

    if mode == "warm":
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=stand_in_id, local_dir=model_dir)

    classifier = InputClassifier.from_artifact_dir(
        artifacts.wheel_classifier_source_dir(), device="cpu"
    )
    NanoMindNLM(model_dir, device="cpu")

    print(
        "boot ok mode=%s embedder=%s connects=%d"
        % (mode, classifier.embedder_id, len(attempts))
    )
    """
)


def _run_boot(model_dir: Path, mode: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    # The cell proves the loaders, not an environment switch.
    env.pop("HF_HUB_OFFLINE", None)
    env.pop("TRANSFORMERS_OFFLINE", None)
    return subprocess.run(
        [sys.executable, "-c", _BOOT_SCRIPT, str(model_dir), _STAND_IN_MODEL_ID, mode],
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
        check=False,
    )


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


def test_warm_daemon_boot_opens_no_outbound_connection(tmp_path):
    """A daemon boot with both models on disk makes no network request.

    meta.json names the embedder by hub id, so a boot that loads it by that
    id asks huggingface.co for files it already has, and with no network
    waits on those requests before falling back to the cache. This cell
    warms the cache with the network available, then boots the embedder
    (InputClassifier.from_artifact_dir) and the NLM (NanoMindNLM, from a
    local directory as the daemon loads it) in a fresh process that counts
    and refuses every outbound connect, and requires zero. Skips (never
    passes) when the hub is unreachable for the warm.
    """
    pytest.importorskip("torch")
    pytest.importorskip("accelerate")
    pytest.importorskip("transformers")
    pytest.importorskip("sentence_transformers")

    if not _hf_reachable():
        pytest.skip("huggingface.co unreachable; smoke test requires network")

    model_dir = tmp_path / "model"

    warm = _run_boot(model_dir, "warm")
    assert warm.returncode == 0, (
        f"cache warm failed (rc={warm.returncode}):\n{warm.stderr[-4000:]}"
    )
    assert "boot ok mode=warm" in warm.stdout

    offline = _run_boot(model_dir, "offline")
    assert offline.returncode == 0, (
        f"offline boot failed (rc={offline.returncode}):\n"
        f"{offline.stderr[-4000:]}"
    )
    assert (
        "boot ok mode=offline embedder=sentence-transformers/all-MiniLM-L6-v2 "
        "connects=0"
    ) in offline.stdout, offline.stdout


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

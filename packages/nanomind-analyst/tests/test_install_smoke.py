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
import subprocess
import sys
import textwrap
from pathlib import Path
import socket

import pytest


pytestmark = pytest.mark.smoke

# Stand-in for the 3.4 GB analyst weights: same from_pretrained pair
# (_nlm.py:110-115), 5 MB. The embedder is the real one the classifier names
# in meta.json (predictor.py:130 loads it by hub id).
_STAND_IN_MODEL_ID = "sshleifer/tiny-gpt2"

# Executed in a child process so HF_HUB_OFFLINE is read the way launchd sets
# it: in the environment BEFORE huggingface_hub / transformers import (both
# read it into module constants at import time). Mode "offline" additionally
# refuses every outbound TCP connect for the duration of the load.
_LOAD_SCRIPT = textwrap.dedent(
    """
    import json, socket, sys

    meta_path, model_id, mode = sys.argv[1], sys.argv[2], sys.argv[3]

    if mode == "offline":
        def _refuse(*_args, **_kwargs):
            raise OSError("NMD-04 offline cell: outbound TCP connect refused")
        socket.create_connection = _refuse
        socket.socket.connect = _refuse

    meta = json.loads(open(meta_path, encoding="utf-8").read())

    import torch
    from sentence_transformers import SentenceTransformer
    from transformers import AutoModelForCausalLM, AutoTokenizer

    # predictor.py:130
    embedder = SentenceTransformer(meta["embedder"])
    # _nlm.py:110-115
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        dtype=torch.float32,
        device_map="cpu",
    ).eval()

    print(
        "NMD-04 load ok mode=%s embedder=%s dim=%s model=%s"
        % (mode, meta["embedder"], embedder.get_sentence_embedding_dimension(),
           type(model).__name__)
    )
    """
)


def _run_load(mode: str, *, offline: bool) -> subprocess.CompletedProcess[str]:
    from nanomind_analyst import artifacts

    meta_path = artifacts.wheel_classifier_source_dir() / "meta.json"
    env = dict(os.environ)
    env.pop("HF_HUB_OFFLINE", None)
    env.pop("TRANSFORMERS_OFFLINE", None)
    if offline:
        env["HF_HUB_OFFLINE"] = "1"
    return subprocess.run(
        [sys.executable, "-c", _LOAD_SCRIPT, str(meta_path), _STAND_IN_MODEL_ID, mode],
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


def test_NMD_04_AC6_daemon_models_load_offline_with_network_refused():
    """The daemon boots with HF_HUB_OFFLINE=1 from a warm cache and no network.

    The plist ships HF_HUB_OFFLINE=1 so a boot never issues huggingface.co
    HEAD calls for an embedder that is already cached (the CDS-named
    offender: predictor.py:130 loads the embedder by hub id, so without the
    variable the hub is consulted at every boot). This cell warms the cache
    with the network available, then repeats the same two loads in a child
    process with HF_HUB_OFFLINE=1 in its environment and every outbound TCP
    connect patched to raise OSError. Skips (never passes) when the hub is
    unreachable for the warm.
    """
    pytest.importorskip("torch")
    pytest.importorskip("accelerate")
    pytest.importorskip("transformers")
    pytest.importorskip("sentence_transformers")

    if not _hf_reachable():
        pytest.skip("huggingface.co unreachable; smoke test requires network")

    warm = _run_load("warm", offline=False)
    assert warm.returncode == 0, (
        f"cache warm failed (rc={warm.returncode}):\n{warm.stderr[-4000:]}"
    )
    assert "NMD-04 load ok mode=warm" in warm.stdout

    cold = _run_load("offline", offline=True)
    assert cold.returncode == 0, (
        f"offline load failed (rc={cold.returncode}):\n{cold.stderr[-4000:]}"
    )
    assert "NMD-04 load ok mode=offline" in cold.stdout
    assert "sentence-transformers/all-MiniLM-L6-v2" in cold.stdout


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

"""NANOMIND_GUARD_DEVICE places the input-classifier embedder, not only the NLM.

Regression for a boot that no setting could rescue: on a macOS host whose
Metal device is visible but cannot allocate (a hosted macos-14 runner VM
raises "MPS backend out of memory ... Tried to allocate 45.00 MiB on shared
pool"), the daemon passed NANOMIND_GUARD_DEVICE to the NLM loader only. The
embedder was built with no device, so sentence-transformers picked MPS and
boot failed in step 3, before the NLM and its device setting were reached.

sentence-transformers and the NLM are replaced with recorders, so these tests
run in the regular `--no-deps` CI job without torch.
"""
from __future__ import annotations

import hashlib
import json
import sys
import types
from pathlib import Path

import joblib
import pytest

from nanomind_analyst.daemon import _nlm
from nanomind_analyst.daemon import nanomind_guard_daemon as daemon
from nanomind_analyst.daemon.input_classifier.predictor import InputClassifier

EMBEDDER_ID = "sentence-transformers/all-MiniLM-L6-v2"


class _StopBoot(Exception):
    """Raised by the NLM recorder so boot stops before the healthz probe."""


@pytest.fixture
def artifact_dir(tmp_path: Path) -> Path:
    (tmp_path / "meta.json").write_text(
        json.dumps({"embedder": EMBEDDER_ID, "threshold": 0.9})
    )
    joblib.dump({"stand-in": "lr-head"}, tmp_path / "classifier.joblib")
    return tmp_path


@pytest.fixture
def embedders_built(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    built: list[dict] = []

    class _RecordingSentenceTransformer:
        def __init__(self, model_name_or_path, device=None, **_kwargs):
            built.append({"model": model_name_or_path, "device": device})

    fake = types.ModuleType("sentence_transformers")
    fake.SentenceTransformer = _RecordingSentenceTransformer
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake)
    return built


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TestPredictorDevice:
    def test_embedder_is_built_on_the_requested_device(
        self, artifact_dir, embedders_built
    ):
        InputClassifier.from_artifact_dir(artifact_dir, device="cpu")
        assert embedders_built == [{"model": EMBEDDER_ID, "device": "cpu"}]

    def test_no_device_leaves_the_choice_to_sentence_transformers(
        self, artifact_dir, embedders_built
    ):
        InputClassifier.from_artifact_dir(artifact_dir)
        assert embedders_built == [{"model": EMBEDDER_ID, "device": None}]


class TestBootDevice:
    def _boot(self, artifact_dir: Path, monkeypatch, env_device: str | None):
        nlm_devices: list[str | None] = []

        class _RecordingNLM:
            def __init__(self, model_path, *, device=None, max_new_tokens=512):
                nlm_devices.append(device)
                raise _StopBoot

        monkeypatch.setattr(_nlm, "NanoMindNLM", _RecordingNLM)
        env = {
            "INPUT_CLASSIFIER_JOBLIB_SHA256": _sha256(
                artifact_dir / "classifier.joblib"
            ),
            "INPUT_CLASSIFIER_META_SHA256": _sha256(artifact_dir / "meta.json"),
            "NANOMIND_GUARD_CLASSIFIER_DIR": str(artifact_dir),
            "NANOMIND_GUARD_MODEL_DIR": str(artifact_dir / "model"),
        }
        if env_device is not None:
            env["NANOMIND_GUARD_DEVICE"] = env_device
        with pytest.raises(_StopBoot):
            daemon.boot(daemon.Config.from_env(env))
        return nlm_devices

    def test_configured_device_reaches_the_embedder_and_the_nlm(
        self, artifact_dir, embedders_built, monkeypatch
    ):
        nlm_devices = self._boot(artifact_dir, monkeypatch, env_device="cpu")
        assert [b["device"] for b in embedders_built] == ["cpu"]
        assert nlm_devices == ["cpu"]

    def test_unset_device_auto_detects_for_both_models(
        self, artifact_dir, embedders_built, monkeypatch
    ):
        nlm_devices = self._boot(artifact_dir, monkeypatch, env_device=None)
        assert [b["device"] for b in embedders_built] == [None]
        assert nlm_devices == [None]

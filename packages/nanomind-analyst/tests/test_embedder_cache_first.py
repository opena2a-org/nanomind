"""The input-classifier embedder loads from the local cache before the hub.

meta.json names the embedder by hub id, and the predictor built it that way,
so sentence-transformers asked huggingface.co for its files on every daemon
boot even when they were cached. With no network the boot waited on those
requests before it fell back to the cache. The predictor now builds the
embedder with local_files_only=True and goes to the hub only when that raises
OSError, which is what a cache miss (the first boot on a machine) raises.

sentence-transformers is replaced with a recorder, so these tests run in the
regular `--no-deps` CI job without torch. tests/test_install_smoke.py boots
the real models with every outbound connect refused.

The cache-only load is network-free only from sentence-transformers 3.4.1 on,
so the last class here checks the minimum version the package declares.
"""
from __future__ import annotations

import json
import sys
import types
from importlib.metadata import requires
from pathlib import Path

import joblib
import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

from nanomind_analyst.daemon.input_classifier.predictor import InputClassifier

EMBEDDER_ID = "sentence-transformers/all-MiniLM-L6-v2"

# The message sentence-transformers raises when local_files_only=True finds
# nothing in the cache.
CACHE_MISS = (
    "We couldn't connect to 'https://huggingface.co' to load the files, and "
    "couldn't find them in the cached files."
)


@pytest.fixture
def artifact_dir(tmp_path: Path) -> Path:
    (tmp_path / "meta.json").write_text(
        json.dumps({"embedder": EMBEDDER_ID, "threshold": 0.9})
    )
    joblib.dump({"stand-in": "lr-head"}, tmp_path / "classifier.joblib")
    return tmp_path


@pytest.fixture
def library(monkeypatch: pytest.MonkeyPatch) -> types.SimpleNamespace:
    """A sentence_transformers stand-in whose cache state each test sets."""
    lib = types.SimpleNamespace(cached=True, local_error=None, built=[])

    class _RecordingSentenceTransformer:
        def __init__(
            self,
            model_name_or_path,
            device=None,
            local_files_only=False,
            **_kwargs,
        ):
            lib.built.append(
                {
                    "model": model_name_or_path,
                    "device": device,
                    "localFilesOnly": local_files_only,
                    "instance": self,
                }
            )
            if local_files_only:
                if lib.local_error is not None:
                    raise lib.local_error
                if not lib.cached:
                    raise OSError(CACHE_MISS)

    fake = types.ModuleType("sentence_transformers")
    fake.SentenceTransformer = _RecordingSentenceTransformer
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake)
    return lib


def _calls(lib: types.SimpleNamespace) -> list[dict]:
    return [
        {k: v for k, v in call.items() if k != "instance"} for call in lib.built
    ]


class TestEmbedderCacheFirst:
    def test_cached_embedder_is_built_from_the_cache_only(
        self, artifact_dir, library
    ):
        classifier = InputClassifier.from_artifact_dir(artifact_dir, device="cpu")

        assert _calls(library) == [
            {"model": EMBEDDER_ID, "device": "cpu", "localFilesOnly": True}
        ]
        assert classifier.embedder is library.built[0]["instance"]
        assert classifier.embedder_id == EMBEDDER_ID

    def test_cache_miss_falls_back_to_the_hub_once_on_the_same_device(
        self, artifact_dir, library
    ):
        library.cached = False

        classifier = InputClassifier.from_artifact_dir(artifact_dir, device="cpu")

        assert _calls(library) == [
            {"model": EMBEDDER_ID, "device": "cpu", "localFilesOnly": True},
            {"model": EMBEDDER_ID, "device": "cpu", "localFilesOnly": False},
        ]
        assert classifier.embedder is library.built[1]["instance"]

    def test_unset_device_is_passed_through_on_both_attempts(
        self, artifact_dir, library
    ):
        library.cached = False

        InputClassifier.from_artifact_dir(artifact_dir)

        assert [call["device"] for call in library.built] == [None, None]

    def test_an_error_other_than_a_cache_miss_is_raised_without_a_hub_retry(
        self, artifact_dir, library
    ):
        library.local_error = RuntimeError(
            "MPS backend out of memory (MPS allocated: 0 bytes)"
        )

        with pytest.raises(RuntimeError, match="MPS backend out of memory"):
            InputClassifier.from_artifact_dir(artifact_dir)

        assert len(library.built) == 1


class TestDeclaredSentenceTransformersMinimum:
    """The declared minimum admits no sentence-transformers release whose
    cache-only load still looks up the model card on huggingface.co.

    sentence-transformers 3.0.0 to 3.4.0 accept local_files_only but still
    ask huggingface.co for the model's metadata on every load, so a warm boot
    on one of them makes a network request. 3.4.1 is the first release that
    skips that lookup. The minimum removes that lookup, not every hub
    request: with some transformers releases a warm boot still makes one.
    """

    @pytest.fixture
    def declared(self):
        found = [
            req
            for req in map(Requirement, requires("nanomind-analyst") or [])
            if canonicalize_name(req.name) == "sentence-transformers"
        ]
        assert len(found) == 1, found
        return found[0].specifier

    @pytest.mark.parametrize(
        "version", ["3.0.0", "3.0.1", "3.1.1", "3.2.1", "3.3.1", "3.4.0"]
    )
    def test_a_release_that_asks_the_hub_on_a_cache_only_load_is_excluded(
        self, declared, version
    ):
        assert not declared.contains(version)

    def test_the_first_release_that_skips_the_lookup_is_admitted(self, declared):
        assert declared.contains("3.4.1")

"""Artifact fetcher tests.

These run offline. The HF downloader is injected; no network calls. The
classifier copy test uses the real bundled wheel data so a mistaken edit to
the SHA constants or the embedded files is caught here.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from nanomind_analyst import artifacts


def _write(path: Path, content: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return hashlib.sha256(content).hexdigest()


class TestFetchNlm:
    def test_writes_required_files_and_verifies_shas(self, tmp_path, monkeypatch):
        """A fake downloader writes files whose SHAs match the constants."""

        # Build payloads whose SHAs we'll force the constants to expect.
        safetensors = b"safetensors-bytes" * 1024
        tokenizer = b"tokenizer-bytes" * 64
        expected_safetensors = hashlib.sha256(safetensors).hexdigest()
        expected_tokenizer = hashlib.sha256(tokenizer).hexdigest()

        monkeypatch.setattr(
            artifacts, "EXPECTED_NLM_SAFETENSORS_SHA256", expected_safetensors
        )
        monkeypatch.setattr(
            artifacts, "EXPECTED_NLM_TOKENIZER_SHA256", expected_tokenizer
        )

        def fake_downloader(*, repo_id, revision, local_dir, allow_patterns):
            target = Path(local_dir)
            target.mkdir(parents=True, exist_ok=True)
            (target / "model.safetensors").write_bytes(safetensors)
            (target / "tokenizer.json").write_bytes(tokenizer)
            for f in artifacts.NLM_REQUIRED_FILES:
                if not (target / f).exists():
                    (target / f).write_bytes(b"{}")
            return str(target)

        progress_events = []
        artifacts.fetch_nlm(
            target_dir=tmp_path / "nlm",
            progress=progress_events.append,
            hf_downloader=fake_downloader,
        )

        assert (tmp_path / "nlm" / "model.safetensors").exists()
        assert (tmp_path / "nlm" / "tokenizer.json").exists()
        assert any(p.stage == "fetching" for p in progress_events)
        assert any(
            p.stage == "verifying" and "model.safetensors" in p.detail
            for p in progress_events
        )

    def test_safetensors_sha_mismatch_refuses(self, tmp_path, monkeypatch):
        """A tampered model.safetensors raises ArtifactError naming the file."""
        monkeypatch.setattr(
            artifacts,
            "EXPECTED_NLM_SAFETENSORS_SHA256",
            "0" * 64,
        )
        monkeypatch.setattr(
            artifacts,
            "EXPECTED_NLM_TOKENIZER_SHA256",
            hashlib.sha256(b"tok").hexdigest(),
        )

        def fake_downloader(*, repo_id, revision, local_dir, allow_patterns):
            target = Path(local_dir)
            target.mkdir(parents=True, exist_ok=True)
            (target / "model.safetensors").write_bytes(b"tampered")
            (target / "tokenizer.json").write_bytes(b"tok")
            for f in artifacts.NLM_REQUIRED_FILES:
                if not (target / f).exists():
                    (target / f).write_bytes(b"{}")
            return str(target)

        with pytest.raises(artifacts.ArtifactError) as exc:
            artifacts.fetch_nlm(
                target_dir=tmp_path / "nlm",
                hf_downloader=fake_downloader,
            )
        msg = str(exc.value)
        assert "SHA256 mismatch" in msg
        assert "model.safetensors" in msg

    def test_missing_required_file_after_fetch_raises(
        self, tmp_path, monkeypatch
    ):
        """A downloader that fails to produce a required file is caught."""
        safetensors = b"x"
        tokenizer = b"y"
        monkeypatch.setattr(
            artifacts,
            "EXPECTED_NLM_SAFETENSORS_SHA256",
            hashlib.sha256(safetensors).hexdigest(),
        )
        monkeypatch.setattr(
            artifacts,
            "EXPECTED_NLM_TOKENIZER_SHA256",
            hashlib.sha256(tokenizer).hexdigest(),
        )

        def fake_downloader(*, repo_id, revision, local_dir, allow_patterns):
            target = Path(local_dir)
            target.mkdir(parents=True, exist_ok=True)
            (target / "model.safetensors").write_bytes(safetensors)
            (target / "tokenizer.json").write_bytes(tokenizer)
            # deliberately skip config.json
            return str(target)

        with pytest.raises(artifacts.ArtifactError) as exc:
            artifacts.fetch_nlm(
                target_dir=tmp_path / "nlm",
                hf_downloader=fake_downloader,
            )
        assert "config.json" in str(exc.value)


class TestInstallClassifier:
    def test_wheel_embedded_files_match_baked_shas(self):
        """The bundled classifier.joblib + meta.json must match the SHAs the
        daemon will verify at boot. If a file edit drifts from the constants,
        catch it here, not in the daemon's refuse-to-start path."""
        src = artifacts.wheel_classifier_source_dir()
        assert (src / "classifier.joblib").exists()
        assert (src / "meta.json").exists()

        joblib_sha = hashlib.sha256(
            (src / "classifier.joblib").read_bytes()
        ).hexdigest()
        meta_sha = hashlib.sha256(
            (src / "meta.json").read_bytes()
        ).hexdigest()
        assert joblib_sha == artifacts.EXPECTED_CLASSIFIER_JOBLIB_SHA256
        assert meta_sha == artifacts.EXPECTED_CLASSIFIER_META_SHA256

    def test_copies_to_target(self, tmp_path):
        artifacts.install_classifier(
            source_dir=artifacts.wheel_classifier_source_dir(),
            target_dir=tmp_path / "classifier",
        )
        assert (tmp_path / "classifier" / "classifier.joblib").exists()
        assert (tmp_path / "classifier" / "meta.json").exists()

    def test_refuses_tampered_source(self, tmp_path):
        """install_classifier verifies source SHAs BEFORE copying; a tampered
        wheel cannot ship a poisoned pickle through this path."""
        src = tmp_path / "tampered"
        src.mkdir()
        (src / "classifier.joblib").write_bytes(b"poison")
        (src / "meta.json").write_bytes(b"{}")
        with pytest.raises(artifacts.ArtifactError) as exc:
            artifacts.install_classifier(
                source_dir=src,
                target_dir=tmp_path / "out",
            )
        assert "SHA256 mismatch" in str(exc.value)
        # And nothing was copied.
        assert not (tmp_path / "out" / "classifier.joblib").exists()

"""Daemon boot-time artifact integrity verify.

`verify_artifact_integrity` SHA-checks the artifacts and refuses a symlink
sitting at the artifact path (defense in depth, mirroring the installer-side
lstat reject in `artifacts._verify`). Regression for the 2026-06-11 round-3
review finding (MEDIUM-1): the daemon boot verify was the remaining unchecked
read. NOTE: this rejects a symlink present AT VERIFY TIME; it does not close
the check-to-load TOCTOU (joblib.load reopens the path by name), so these
tests assert the static check-time behaviour only.
"""
from __future__ import annotations

import hashlib
import os
from types import SimpleNamespace

import pytest

from nanomind_analyst.daemon.nanomind_guard_daemon import (
    IntegrityError,
    verify_artifact_integrity,
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _cfg(artifact_dir, joblib_sha: str, meta_sha: str) -> SimpleNamespace:
    return SimpleNamespace(
        classifier_dir=str(artifact_dir),
        classifier_joblib_sha256=joblib_sha,
        classifier_meta_sha256=meta_sha,
    )


def _write_artifacts(artifact_dir, joblib_bytes: bytes, meta_bytes: bytes):
    (artifact_dir / "classifier.joblib").write_bytes(joblib_bytes)
    (artifact_dir / "meta.json").write_bytes(meta_bytes)


def test_passes_on_matching_real_files(tmp_path):
    joblib_bytes, meta_bytes = b"joblib-content", b'{"meta": true}'
    _write_artifacts(tmp_path, joblib_bytes, meta_bytes)
    cfg = _cfg(tmp_path, _sha256(joblib_bytes), _sha256(meta_bytes))
    # Should not raise.
    verify_artifact_integrity(cfg)


def test_rejects_missing_artifact(tmp_path):
    cfg = _cfg(tmp_path, _sha256(b"x"), _sha256(b"y"))
    with pytest.raises(IntegrityError, match="missing"):
        verify_artifact_integrity(cfg)


def test_rejects_sha_mismatch(tmp_path):
    joblib_bytes, meta_bytes = b"joblib-content", b'{"meta": true}'
    _write_artifacts(tmp_path, joblib_bytes, meta_bytes)
    cfg = _cfg(tmp_path, _sha256(b"tampered"), _sha256(meta_bytes))
    with pytest.raises(IntegrityError, match="SHA256 mismatch"):
        verify_artifact_integrity(cfg)


def test_rejects_symlink_at_classifier_path(tmp_path):
    """A symlink at classifier.joblib must be refused even if it points at
    content whose SHA matches — rejection must be because it is a symlink,
    not because the hash differs."""
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()

    joblib_bytes, meta_bytes = b"joblib-content", b'{"meta": true}'
    # Real target the symlink resolves to, with a matching SHA.
    (real_dir / "classifier.joblib").write_bytes(joblib_bytes)
    (artifact_dir / "meta.json").write_bytes(meta_bytes)
    os.symlink(real_dir / "classifier.joblib", artifact_dir / "classifier.joblib")

    cfg = _cfg(artifact_dir, _sha256(joblib_bytes), _sha256(meta_bytes))
    with pytest.raises(IntegrityError, match="symlink"):
        verify_artifact_integrity(cfg)


def test_rejects_symlink_at_meta_path(tmp_path):
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()

    joblib_bytes, meta_bytes = b"joblib-content", b'{"meta": true}'
    (artifact_dir / "classifier.joblib").write_bytes(joblib_bytes)
    (real_dir / "meta.json").write_bytes(meta_bytes)
    os.symlink(real_dir / "meta.json", artifact_dir / "meta.json")

    cfg = _cfg(artifact_dir, _sha256(joblib_bytes), _sha256(meta_bytes))
    with pytest.raises(IntegrityError, match="symlink"):
        verify_artifact_integrity(cfg)

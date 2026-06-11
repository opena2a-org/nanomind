"""Fetch and verify the Analyst NLM artifacts from Hugging Face.

The trust chain for v0.1:

  PyPI Trusted Publishing -> GHA OIDC -> wheel build
    -> bakes EXPECTED_*_SHA256 constants below at build time
    -> wheel ships with classifier.joblib + meta.json embedded as package data
    -> daemon at runtime verifies fetched NLM weights against EXPECTED_*_SHA256

The wheel manifest is authoritative. Hugging Face is reduced to a CDN; if HF
serves tampered bytes, the SHA check refuses to install. The daemon then does
a second verify before joblib.load() runs (joblib uses pickle = ACE at
deserialization).

The pinned revision is the v3.0.0 release of opena2a/nanomind-security-analyst.
Bumping it requires recomputing EXPECTED_NLM_*_SHA256 from the live HF tree.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

HF_REPO_ID = "opena2a/nanomind-security-analyst"

# Pinned to the v3.0.0 release commit (model card: nanomind/MODEL_CARD links
# this exact commit). Bumping it requires recomputing the SHA constants below.
HF_REVISION = "13bc3112ec9666a37f301b83d3e8bce53da4e3c5"

# SHA256 of model.safetensors as published on Hugging Face at HF_REVISION.
# Source: https://huggingface.co/api/models/opena2a/nanomind-security-analyst
#         /tree/main -> file=model.safetensors -> lfs.oid
EXPECTED_NLM_SAFETENSORS_SHA256 = (
    "53cb9441e370b097f556a200efb483dc8fb977a4a57ed79aaae1b99c71426da0"
)

# SHA256 of tokenizer.json (also LFS at HF_REVISION).
EXPECTED_NLM_TOKENIZER_SHA256 = (
    "be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506"
)

# SHA256 of the input-classifier-v1 artifacts. These files are shipped INSIDE
# the wheel (under nanomind_analyst/data/input-classifier-v1/) and copied into
# the user's Application Support dir during install. The daemon verifies them
# at boot before joblib.load() runs.
EXPECTED_CLASSIFIER_JOBLIB_SHA256 = (
    "a9a699cf2adc1768d2d8777fdb2f9c5ce16fd087ead060ba9e2944a5bd5f9db6"
)
# meta.json carries the gate operating point. 0.1.3 ships threshold 0.90
# (CDS-029: 0.65 false-bypassed 30% of external prose attacks for ~0 FPR
# benefit) + thresholdHistory; mirrors nanomind-training
# training/artifacts/input-classifier-v1/meta.json. With the artifact at
# 0.90 the INPUT_CLASSIFIER_THRESHOLD plist override becomes unnecessary.
EXPECTED_CLASSIFIER_META_SHA256 = (
    "69cb4033e9c4373693ebf5fbd04dc00ff2aae81090938f48a2b8a1bb9c8871a4"
)

# These are the NLM files the daemon actually needs. Anything else fetched by
# snapshot_download is fine but not required.
NLM_REQUIRED_FILES = (
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "model.safetensors.index.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
)


class ArtifactError(Exception):
    """Raised when artifact fetch or verification fails."""


@dataclass
class FetchProgress:
    """Reports progress during fetch. The CLI prints these; tests assert on them."""

    stage: str  # "fetching" | "verifying" | "installing-classifier" | "done"
    detail: str = ""


ProgressCallback = Callable[[FetchProgress], None]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify(path: Path, expected: str, *, name: str) -> None:
    if not path.exists():
        raise ArtifactError(f"{name} missing after fetch: {path}")
    # Defense in depth: reject symlinks at the artifact path. snapshot_download
    # with local_dir_use_symlinks=False should never produce one, but if some
    # future HF library version regresses, or if a hostile process slipped a
    # symlink under target_dir between fetch and verify, we want SHA verify to
    # read the file at this path, not whatever the symlink resolves to.
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        raise ArtifactError(
            f"{name} is a symlink ({path}); refusing to verify or load. The "
            f"snapshot_download call requested local_dir_use_symlinks=False; "
            f"the presence of a symlink here may indicate a tampered fetch."
        )
    actual = _sha256_file(path)
    if actual != expected:
        raise ArtifactError(
            f"SHA256 mismatch on {name}: expected {expected}, got {actual}. "
            f"Refusing to install. The Hugging Face artifact at {HF_REPO_ID}"
            f"@{HF_REVISION[:7]} may have been retagged, or the wheel was "
            f"built against a different revision. File: {path}"
        )


def fetch_nlm(
    *,
    target_dir: Path,
    progress: ProgressCallback | None = None,
    hf_downloader: Callable[..., str] | None = None,
) -> None:
    """Download NLM artifacts from Hugging Face into target_dir.

    `hf_downloader` is injected for tests; default is
    huggingface_hub.snapshot_download.
    """
    if progress is not None:
        progress(
            FetchProgress(
                stage="fetching",
                detail=f"{HF_REPO_ID}@{HF_REVISION[:7]} -> {target_dir}",
            )
        )

    target_dir.mkdir(parents=True, exist_ok=True)

    downloader = hf_downloader
    if downloader is None:
        # Imported lazily so tests that inject a fake downloader don't pay the
        # huggingface_hub import cost.
        from huggingface_hub import snapshot_download as downloader  # type: ignore[no-redef]

    # local_dir_use_symlinks=False makes snapshot_download write real files
    # into target_dir, not symlinks into ~/.cache/huggingface. We want SHA
    # verify to read the bytes actually present at the install location, not
    # follow a symlink the user (or an attacker on the cache dir) could swap
    # under our feet between verify and the daemon's joblib.load.
    downloader(
        repo_id=HF_REPO_ID,
        revision=HF_REVISION,
        local_dir=str(target_dir),
        allow_patterns=list(NLM_REQUIRED_FILES),
        local_dir_use_symlinks=False,
    )

    if progress is not None:
        progress(FetchProgress(stage="verifying", detail="model.safetensors"))
    _verify(
        target_dir / "model.safetensors",
        EXPECTED_NLM_SAFETENSORS_SHA256,
        name="NLM model.safetensors",
    )

    if progress is not None:
        progress(FetchProgress(stage="verifying", detail="tokenizer.json"))
    _verify(
        target_dir / "tokenizer.json",
        EXPECTED_NLM_TOKENIZER_SHA256,
        name="NLM tokenizer.json",
    )

    for fname in NLM_REQUIRED_FILES:
        if not (target_dir / fname).exists():
            raise ArtifactError(
                f"required NLM file missing after fetch: {fname}. Check the "
                f"Hugging Face revision {HF_REVISION[:7]} or your network."
            )


def install_classifier(
    *,
    source_dir: Path,
    target_dir: Path,
    progress: ProgressCallback | None = None,
) -> None:
    """Copy the wheel-embedded input-classifier-v1 files into target_dir.

    Verifies SHA against EXPECTED_CLASSIFIER_*_SHA256 BEFORE copying, so a
    tampered wheel cannot ship a poisoned pickle through this path. The
    daemon will re-verify at boot before joblib.load() runs.
    """
    if progress is not None:
        progress(
            FetchProgress(
                stage="installing-classifier",
                detail=f"{source_dir} -> {target_dir}",
            )
        )

    _verify(
        source_dir / "classifier.joblib",
        EXPECTED_CLASSIFIER_JOBLIB_SHA256,
        name="input-classifier-v1 classifier.joblib (in wheel)",
    )
    _verify(
        source_dir / "meta.json",
        EXPECTED_CLASSIFIER_META_SHA256,
        name="input-classifier-v1 meta.json (in wheel)",
    )

    target_dir.mkdir(parents=True, exist_ok=True)
    for fname in ("classifier.joblib", "meta.json"):
        shutil.copy2(source_dir / fname, target_dir / fname)


def installed_classifier_drift(target_dir: Path) -> list[str]:
    """Names of installed classifier files whose SHA differs from this wheel's pins.

    A pip upgrade does NOT touch the installed artifact dir or the plist —
    only `nanomind-analyst install` does — so after an upgrade that changed
    an artifact pin (e.g. the 0.1.3 meta.json threshold 0.65 -> 0.90), the
    running daemon keeps serving the OLD operating point indefinitely and
    nothing fails. `status` calls this to surface that drift instead of
    leaving it silent. Missing files are reported as drifted too.
    """
    drifted: list[str] = []
    for fname, expected in (
        ("classifier.joblib", EXPECTED_CLASSIFIER_JOBLIB_SHA256),
        ("meta.json", EXPECTED_CLASSIFIER_META_SHA256),
    ):
        path = target_dir / fname
        try:
            if _sha256_file(path) != expected:
                drifted.append(fname)
        except OSError:
            drifted.append(fname)
    return drifted


def wheel_classifier_source_dir() -> Path:
    """Locate the input-classifier-v1 directory shipped inside the wheel."""
    # Resolves to <site-packages>/nanomind_analyst/data/input-classifier-v1/
    here = Path(__file__).resolve().parent
    return here / "data" / "input-classifier-v1"


def python_executable() -> str:
    """The interpreter that launched the installer.

    Baked into the launchd plist so the daemon runs under the same Python the
    user installed `nanomind-analyst` into (no `/usr/bin/env python3` ambiguity).
    """
    return sys.executable

"""
Input-classifier gate for NanoMind v3.1 (Option D).

Loaded by train/eval scripts and the NanoMind-Guard serving daemon. Encapsulates
the full decision: byte-level pre-filter (stego/BIDI markers force pass-through)
+ sentence-transformer embedding + sklearn LogisticRegression head.

Predictions:
  0 = security-artifact   -> route to NLM as normal
  1 = off-topic           -> bypass NLM, emit constant attackClass=none

Usage:

    from training.input_classifier.predictor import InputClassifier
    pred = InputClassifier.from_artifact_dir("training/artifacts/input-classifier-v1")
    label, proba, reason = pred.predict_one(text)
    # label: "security-artifact" | "off-topic"
    # proba: float in [0, 1] = P(off-topic) from the LR head
    # reason: "stego-prefilter" | "bidi-prefilter" | "lr"

The pre-filter is fail-OPEN to security-artifact: any input containing
zero-width / variation-selector / tag / BIDI-override Unicode is forced to
security-artifact regardless of the embedder's view, because the visible text
of a steganographic README looks off-topic but the bytes carry a payload.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib

# Unicode codepoint ranges where presence is a strong signal of payload-hiding.
# Sources: AIIS-001 (Unicode tag steganography), CVE-2021-42574 (Trojan Source BIDI),
# OpenA2A AIIS catalog v1.0, OWASP Unicode-confusable cheatsheet.
STEGO_RANGES: tuple[tuple[int, int], ...] = (
    (0x00AD, 0x00AD),  # SOFT HYPHEN (invisible, payload-hiding in keyword obfuscation)
    (0x034F, 0x034F),  # COMBINING GRAPHEME JOINER (invisible)
    (0x115F, 0x1160),  # Hangul fillers (invisible, used in spoofing)
    (0x17B4, 0x17B5),  # Khmer inherent vowels (invisible)
    (0x180B, 0x180F),  # Mongolian variation selectors + Mongolian vowel separator U+180E
    (0x200B, 0x200F),  # ZWSP, ZWNJ, ZWJ, LRM, RLM
    (0x2028, 0x2029),  # Line/paragraph separator (JSON/JS injection vector)
    (0x202A, 0x202E),  # BIDI embedding/overrides (Trojan Source CVE-2021-42574)
    (0x2060, 0x2064),  # Word joiner / invisible ops
    (0x2066, 0x2069),  # BIDI isolates (Trojan Source 2.0)
    (0x206A, 0x206F),  # Deprecated formatting chars
    (0x3164, 0x3164),  # HANGUL FILLER (invisible)
    (0xFE00, 0xFE0F),  # Variation selectors
    (0xFEFF, 0xFEFF),  # BOM
    (0xFFA0, 0xFFA0),  # HALFWIDTH HANGUL FILLER (invisible)
    (0xFFF9, 0xFFFC),  # Interlinear annotation chars + object replacement
    (0xE0000, 0xE007F),  # Tag characters (UTC-tag stego, AIIS-001)
    (0xE0100, 0xE01EF),  # Variation selectors supplement
)


def has_stego_markers(text: str) -> tuple[bool, str | None]:
    """Return (True, reason) if text contains any stego-marker codepoint."""
    for ch in text:
        cp = ord(ch)
        for lo, hi in STEGO_RANGES:
            if lo <= cp <= hi:
                if 0x202A <= cp <= 0x202E or 0x2066 <= cp <= 0x2069:
                    return True, "bidi-prefilter"
                return True, "stego-prefilter"
    return False, None


# Greedy match — capture to the LAST </artifact> so that an attacker cannot
# truncate the payload with a literal "</artifact>" inside the body.
ARTIFACT_RE = re.compile(r"<artifact>(.*)</artifact>", re.DOTALL)
NESTED_OPEN_RE = re.compile(r"<artifact>")


def extract_artifact(text: str) -> tuple[str, str | None]:
    """
    Pull <artifact>...</artifact> body if present; else return (text, None).

    Returns (extracted_text, anomaly_reason). anomaly_reason is set to
    "malformed-wrapper" when the wrapper is opened but never closed, or
    "nested-wrapper" when more than one <artifact> open tag is present
    (potential truncation attack). Callers should treat either anomaly as
    a strong "do not bypass" signal.
    """
    m = ARTIFACT_RE.search(text)
    if m:
        body = m.group(1).strip()
        # Detect nested <artifact> opens INSIDE the captured body — sign that
        # the input has multiple wrappers, possibly an attempt to trick a
        # consumer with an inner stub.
        if NESTED_OPEN_RE.search(body):
            return body, "nested-wrapper"
        return body, None
    if "<artifact>" in text and "</artifact>" not in text:
        return text.strip(), "malformed-wrapper"
    return text.strip(), None


@dataclass
class Prediction:
    label: str
    proba_off_topic: float
    reason: str
    bypass_nlm: bool


class InputClassifier:
    LABEL_NAMES: tuple[str, str] = ("security-artifact", "off-topic")

    def __init__(self, embedder, lr_head, threshold: float, embedder_id: str) -> None:
        self.embedder = embedder
        self.lr_head = lr_head
        self.threshold = float(threshold)
        self.embedder_id = embedder_id

    @classmethod
    def from_artifact_dir(cls, artifact_dir: str | Path) -> "InputClassifier":
        artifact_dir = Path(artifact_dir)
        meta = json.loads((artifact_dir / "meta.json").read_text())
        lr_head = joblib.load(artifact_dir / "classifier.joblib")
        # Lazy import — sentence-transformers is heavy.
        from sentence_transformers import SentenceTransformer

        embedder = SentenceTransformer(meta["embedder"])
        # Operator override via env var, with hard floor at 0.5.
        # A threshold below 0.5 would mean "predict off-topic on any input
        # the LR head is uncertain about," which makes the gate bypass-on-
        # uncertainty — exactly the silent-FN failure mode this gate exists
        # to prevent. Reject rather than silently clamp.
        env_thr = os.getenv("INPUT_CLASSIFIER_THRESHOLD")
        if env_thr is not None:
            try:
                env_thr_f = float(env_thr)
            except ValueError as exc:
                raise ValueError(
                    f"INPUT_CLASSIFIER_THRESHOLD must be a float, got {env_thr!r}"
                ) from exc
            if env_thr_f < 0.5 or env_thr_f >= 1.0:
                raise ValueError(
                    f"INPUT_CLASSIFIER_THRESHOLD must be in [0.5, 1.0); got {env_thr_f}. "
                    "Lower thresholds bypass the NLM on uncertain inputs and create silent FNs."
                )
            threshold = env_thr_f
        else:
            threshold = float(meta["threshold"])
        return cls(
            embedder=embedder,
            lr_head=lr_head,
            threshold=threshold,
            embedder_id=meta["embedder"],
        )

    def _classify_extracted(self, text: str, anomaly: str | None) -> Prediction | None:
        """Apply rule-based pre-checks; return Prediction or None for embedder pass."""
        if not text or not text.strip():
            return Prediction(
                label="security-artifact",
                proba_off_topic=0.0,
                reason="empty-input",
                bypass_nlm=False,
            )
        if anomaly:
            return Prediction(
                label="security-artifact",
                proba_off_topic=0.0,
                reason=anomaly,
                bypass_nlm=False,
            )
        had_marker, reason = has_stego_markers(text)
        if had_marker:
            return Prediction(
                label="security-artifact",
                proba_off_topic=0.0,
                reason=reason,  # type: ignore[arg-type]
                bypass_nlm=False,
            )
        return None

    def predict_one(self, text: str) -> Prediction:
        body, anomaly = extract_artifact(text)
        decided = self._classify_extracted(body, anomaly)
        if decided is not None:
            return decided
        emb = self.embedder.encode(
            [body],
            batch_size=1,
            show_progress_bar=False,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        proba = float(self.lr_head.predict_proba(emb)[0, 1])
        bypass = proba >= self.threshold
        label = self.LABEL_NAMES[1 if bypass else 0]
        return Prediction(
            label=label,
            proba_off_topic=proba,
            reason="lr",
            bypass_nlm=bypass,
        )

    def predict_batch(self, texts: list[str]) -> list[Prediction]:
        decisions: list[Prediction | None] = [None] * len(texts)
        embed_idx: list[int] = []
        embed_inputs: list[str] = []
        for i, raw in enumerate(texts):
            body, anomaly = extract_artifact(raw)
            decided = self._classify_extracted(body, anomaly)
            if decided is not None:
                decisions[i] = decided
            else:
                embed_idx.append(i)
                embed_inputs.append(body)

        if embed_inputs:
            emb = self.embedder.encode(
                embed_inputs,
                batch_size=32,
                show_progress_bar=False,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
            proba = self.lr_head.predict_proba(emb)[:, 1]
            for j, i in enumerate(embed_idx):
                p = float(proba[j])
                bypass = p >= self.threshold
                decisions[i] = Prediction(
                    label=self.LABEL_NAMES[1 if bypass else 0],
                    proba_off_topic=p,
                    reason="lr",
                    bypass_nlm=bypass,
                )
        # Defense in depth: if any slot remains None we have a logic bug;
        # raise rather than silently truncate the output (which would let a
        # caller index by position and read the wrong sample's verdict).
        if any(d is None for d in decisions):
            missing = [i for i, d in enumerate(decisions) if d is None]
            raise RuntimeError(f"InputClassifier.predict_batch produced no decision for indices {missing}")
        return [d for d in decisions]  # type: ignore[misc]

    def to_telemetry(self, p: Prediction) -> dict[str, Any]:
        """Daemon-friendly serialization for structured logs."""
        return {
            "label": p.label,
            "probaOffTopic": p.proba_off_topic,
            "reason": p.reason,
            "bypassNlm": p.bypass_nlm,
            "threshold": self.threshold,
            "embedder": self.embedder_id,
        }

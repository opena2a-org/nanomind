"""NLM wrapper for the NanoMind-Guard daemon.

Loads NanoMind v3.0.0-beta (Qwen3-1.7B SFT, bf16 on Apple MPS) and exposes a
single `classify(text)` call that returns the daemon's structured response
fields. The caller wraps the body in the v3 prompt template (system message +
`<artifact>` user turn). Output parsing follows training/compressm/eval.py.

bf16 on MPS is REQUIRED. fp16 yields 0% accuracy on Qwen3-1.7B (known issue,
see feedback_eval_qwen3_bf16_mps.md and the v3 model card).
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# v3 instruct training samples are framed with this exact system prompt; see
# training/data/instruct-v3/eval.jsonl. The user turn wraps the artifact body
# in <artifact>...</artifact> with the leading directive sentence.
SYSTEM_PROMPT = (
    "You are NanoMind, a security analysis model specialized in AI agent "
    "security. You analyze artifacts, configurations, and behaviors from AI "
    "agent systems. You provide structured security assessments with "
    "reasoning. Your domain is strictly AI agent security within the "
    "OpenA2A ecosystem."
)
USER_DIRECTIVE = "Analyze this AI agent artifact for security threats."

_CLASSIFICATION_RE = re.compile(r"classification:\s*(\w+)", re.IGNORECASE)
_ATTACK_CLASS_RE = re.compile(r"attackClass:\s*(.+?)(?:\n|$)", re.IGNORECASE)
_CONFIDENCE_RE = re.compile(r"confidence:\s*([0-9]*\.?[0-9]+)", re.IGNORECASE)
_SEVERITY_RE = re.compile(r"severity:\s*(\w+)", re.IGNORECASE)
_SECTION_RE = re.compile(
    r"^##\s+(Analysis|Verdict|Evidence|Remediation)\s*$\n(.*?)(?=^##\s+|\Z)",
    re.MULTILINE | re.DOTALL,
)


@dataclass
class NlmOutput:
    predicted_attack_class: str | None
    confidence: float | None
    classification: str | None
    severity: str | None
    sections: dict[str, str]
    raw: str
    token_count: int
    latency_ms: float


def parse_nlm_output(text: str, *, token_count: int, latency_ms: float) -> NlmOutput:
    """Parse the v3 NLM's structured output into typed fields."""
    cls_match = _CLASSIFICATION_RE.search(text)
    ac_match = _ATTACK_CLASS_RE.search(text)
    conf_match = _CONFIDENCE_RE.search(text)
    sev_match = _SEVERITY_RE.search(text)

    confidence: float | None
    if conf_match is None:
        confidence = None
    else:
        try:
            confidence = float(conf_match.group(1))
        except ValueError:
            confidence = None

    sections = {
        m.group(1).lower(): m.group(2).strip() for m in _SECTION_RE.finditer(text)
    }

    return NlmOutput(
        predicted_attack_class=ac_match.group(1).strip() if ac_match else None,
        confidence=confidence,
        classification=cls_match.group(1).lower() if cls_match else None,
        severity=sev_match.group(1).lower() if sev_match else None,
        sections=sections,
        raw=text,
        token_count=token_count,
        latency_ms=latency_ms,
    )


class NanoMindNLM:
    """Wrapper around the v3.0.0-beta Qwen3-1.7B SFT model on bf16 MPS."""

    def __init__(
        self,
        model_path: str | Path,
        *,
        device: str | None = None,
        max_new_tokens: int = 512,
    ) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        if device is None:
            device = "mps" if torch.backends.mps.is_available() else "cpu"
        if device == "mps":
            dtype = torch.bfloat16
        elif device == "cuda":
            dtype = torch.bfloat16
        else:
            dtype = torch.float32

        self.model_path = str(model_path)
        self.device = device
        self.max_new_tokens = int(max_new_tokens)
        self._tokenizer = AutoTokenizer.from_pretrained(self.model_path)
        self._model = AutoModelForCausalLM.from_pretrained(
            self.model_path,
            dtype=dtype,
            device_map=device,
        ).eval()
        self._torch = torch

    def classify(self, text: str) -> NlmOutput:
        """Run the NLM on `text` (the artifact body) and parse the output."""
        prompt = self._render_prompt(text)
        inputs = self._tokenizer(prompt, return_tensors="pt").to(self.device)
        input_len = inputs["input_ids"].shape[1]

        t0 = time.perf_counter()
        with self._torch.no_grad():
            outputs = self._model.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=False,
                temperature=1.0,
            )
        latency_ms = (time.perf_counter() - t0) * 1000.0

        generated_ids = outputs[0][input_len:]
        generated_text = self._tokenizer.decode(
            generated_ids, skip_special_tokens=True
        )
        return parse_nlm_output(
            generated_text,
            token_count=int(generated_ids.shape[0]),
            latency_ms=latency_ms,
        )

    def _render_prompt(self, body: str) -> str:
        user_content = f"{USER_DIRECTIVE}\n\n<artifact>\n{body}\n</artifact>"
        return (
            f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n"
            f"<|im_start|>user\n{user_content}<|im_end|>\n"
            f"<|im_start|>assistant\n"
        )


def nlm_output_to_response(out: NlmOutput) -> dict[str, Any]:
    """Project an NlmOutput into the daemon's response schema."""
    response: dict[str, Any] = {
        "predictedAttackClass": out.predicted_attack_class,
        "confidence": out.confidence,
        "classification": out.classification,
        "nlmLatencyMs": round(out.latency_ms, 3),
        "nlmTokenCount": out.token_count,
    }
    if out.severity is not None:
        response["severity"] = out.severity
    for name in ("analysis", "verdict", "evidence", "remediation"):
        if name in out.sections:
            response[name] = out.sections[name]
    return response

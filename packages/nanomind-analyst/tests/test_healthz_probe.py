"""Boot/healthz gate probe must be threshold-independent.

Regression for the 2026-06-10 launchd crash loop: the probe asserted the
bypass LABEL for "# README\n\nProject Setup", which encodes the gate's
operating point. Raising the threshold to 0.90 (CDS-029) made the gate
correctly decline to BYPASS that input — the embedder was healthy, but boot
refused to bind and launchd looped. The probe now asserts the LR head ranks
the input as more-likely-off-topic (proba_off_topic >= 0.5), which catches a
wedged embedder without coupling boot to the deployed threshold.
"""
from __future__ import annotations

import time
from types import SimpleNamespace

from nanomind_analyst.daemon.input_classifier.predictor import Prediction
from nanomind_analyst.daemon.nanomind_guard_daemon import (
    HEALTHZ_PROBE_INPUT,
    HEALTHZ_PROBE_MIN_PROBA,
    handle_healthz,
)


def _state_with_probe(pred: Prediction | Exception) -> SimpleNamespace:
    class _Gate:
        threshold = 0.90
        embedder_id = "sentence-transformers/all-MiniLM-L6-v2"

        def predict_one(self, text: str) -> Prediction:
            assert text == HEALTHZ_PROBE_INPUT
            if isinstance(pred, Exception):
                raise pred
            return pred

    return SimpleNamespace(
        classifier=_Gate(),
        nlm=None,
        cfg=SimpleNamespace(model_dir="/m", classifier_dir="/c"),
        boot_ts=time.time(),
        requests_served=0,
    )


def _probe(label: str, proba: float, bypass: bool) -> Prediction:
    return Prediction(
        label=label, proba_off_topic=proba, reason="lr", bypass_nlm=bypass
    )


class TestProbeThresholdIndependence:
    def test_ready_when_head_ranks_off_topic_even_without_bypass(self):
        """At threshold 0.90 the probe input scores ~0.7: no bypass, but the
        embedder is healthy. Boot must report ready (the crash-loop case)."""
        resp = handle_healthz(_state_with_probe(
            _probe("security-artifact", 0.72, bypass=False)
        ))
        assert resp["ok"] is True
        assert resp["daemonState"] == "ready"
        assert resp["gateProbe"]["passed"] is True
        assert resp["gateProbe"]["probaOffTopic"] == 0.72

    def test_ready_when_probe_bypasses(self):
        resp = handle_healthz(_state_with_probe(
            _probe("off-topic", 0.97, bypass=True)
        ))
        assert resp["ok"] is True

    def test_degraded_when_head_ranks_security_artifact(self):
        """A wedged embedder / scrambled head ranking README as
        security-leaning is a real failure: degraded."""
        resp = handle_healthz(_state_with_probe(
            _probe("security-artifact", 0.12, bypass=False)
        ))
        assert resp["ok"] is False
        assert resp["daemonState"] == "degraded"
        assert resp["gateProbe"]["passed"] is False

    def test_degraded_when_probe_raises(self):
        resp = handle_healthz(_state_with_probe(RuntimeError("embedder OOM")))
        assert resp["ok"] is False
        assert resp["gateProbe"]["label"] is None
        assert resp["gateProbe"]["probaOffTopic"] is None

    def test_probe_fields_are_self_describing(self):
        resp = handle_healthz(_state_with_probe(
            _probe("security-artifact", 0.72, bypass=False)
        ))
        probe = resp["gateProbe"]
        assert probe["minProbaOffTopic"] == HEALTHZ_PROBE_MIN_PROBA
        # Back-compat: older clients render `expected` verbatim.
        assert str(HEALTHZ_PROBE_MIN_PROBA) in probe["expected"]

"""The healthz reply states the socket protocol version, and readers check it.

The daemon's `classify`/`healthz` op set is protocol version 1. A healthz
reply that carries no `protocolVersion` comes from a daemon that predates the
field and is read as version 1, so an old daemon and a new client still
interoperate. A reply that announces a version this client does not know is
never reported as ready: `status` and the install probe degrade instead.
"""
from __future__ import annotations

import json
import secrets
import socket
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from nanomind_analyst import artifacts, install, launchd, lifecycle, paths, protocol
from nanomind_analyst.daemon.input_classifier.predictor import Prediction
from nanomind_analyst.daemon.nanomind_guard_daemon import handle_healthz


def _daemon_state(pred: Prediction | Exception) -> SimpleNamespace:
    class _Gate:
        threshold = 0.90
        embedder_id = "sentence-transformers/all-MiniLM-L6-v2"

        def predict_one(self, text: str) -> Prediction:
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


def _pred(proba: float) -> Prediction:
    return Prediction(
        label="off-topic", proba_off_topic=proba, reason="lr", bypass_nlm=True
    )


class TestDaemonAnnouncesVersion:
    def test_ready_reply_carries_protocol_version_1(self):
        resp = handle_healthz(_daemon_state(_pred(0.97)))
        assert resp["daemonState"] == "ready"
        assert resp["protocolVersion"] == 1
        assert protocol.PROTOCOL_VERSION == 1

    def test_degraded_reply_carries_protocol_version(self):
        resp = handle_healthz(_daemon_state(_pred(0.12)))
        assert resp["daemonState"] == "degraded"
        assert resp["protocolVersion"] == 1

    def test_reply_carries_version_when_probe_raises(self):
        resp = handle_healthz(_daemon_state(RuntimeError("embedder OOM")))
        assert resp["protocolVersion"] == 1

    def test_daemon_speaks_a_version_its_own_readers_accept(self):
        resp = handle_healthz(_daemon_state(_pred(0.97)))
        assert protocol.healthz_is_ready(resp) is True


class TestReaderInterpretsVersion:
    def test_absent_field_is_pre_versioned_v1(self):
        reply = {"ok": True, "daemonState": "ready"}
        assert protocol.reply_protocol_version(reply) == 1
        assert protocol.healthz_is_ready(reply) is True

    def test_known_version_is_accepted(self):
        reply = {"daemonState": "ready", "protocolVersion": 1}
        assert protocol.reply_protocol_version(reply) == 1
        assert protocol.healthz_is_ready(reply) is True

    @pytest.mark.parametrize("value", [2, 0, -1, "1", 1.5, None, True, [1], {}])
    def test_unrecognised_version_is_never_ready(self, value):
        reply = {"daemonState": "ready", "protocolVersion": value}
        assert protocol.reply_protocol_version(reply) is None
        assert protocol.healthz_is_ready(reply) is False

    def test_known_version_still_needs_ready_state(self):
        reply = {"daemonState": "degraded", "protocolVersion": 1}
        assert protocol.healthz_is_ready(reply) is False

    def test_non_object_reply_is_never_ready(self):
        assert protocol.reply_protocol_version([1]) is None
        assert protocol.healthz_is_ready("ready") is False


@pytest.fixture
def fake_daemon(monkeypatch):
    """Answer every healthz connection on a short /tmp socket with `body`.

    `start(body)` returns the list of requests served, one per connection.
    A `bytes` body is sent as-is; anything else as one JSON line.
    Darwin's sun_path is 104 bytes; pytest's tmp_path is too deep for AF_UNIX.
    """
    sock_path = Path(f"/tmp/nm-analyst-pv-{secrets.token_hex(4)}.sock")
    monkeypatch.setattr(paths, "SOCK_PATH", str(sock_path))
    monkeypatch.setattr(artifacts, "installed_classifier_drift", lambda d: [])
    monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(sock_path))
    server.listen(4)
    server.settimeout(0.2)
    stop = threading.Event()
    reply: dict = {}
    served: list[bytes] = []

    def serve():
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except (socket.timeout, OSError):
                continue
            with conn:
                served.append(conn.recv(4096))
                body = reply["body"]
                if not isinstance(body, bytes):
                    body = json.dumps(body).encode() + b"\n"
                conn.sendall(body)

    t = threading.Thread(target=serve, daemon=True)

    def start(body) -> list[bytes]:
        reply["body"] = body
        t.start()
        return served

    yield start
    stop.set()
    t.join(timeout=2.0)
    server.close()
    if sock_path.exists():
        sock_path.unlink()


READY_V1 = {"ok": True, "daemonState": "ready", "requestsServed": 3, "uptimeSec": 9.0}


class TestStatusReadsVersion:
    def test_pre_versioned_daemon_is_ready(self, fake_daemon, capsys):
        fake_daemon(READY_V1)
        assert lifecycle.run_status(json_output=True) == 0
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"]["state"] == "ready"
        assert "protocolVersion" not in payload["healthz"]

    def test_v1_daemon_is_ready(self, fake_daemon, capsys):
        fake_daemon({**READY_V1, "protocolVersion": 1})
        assert lifecycle.run_status(json_output=True) == 0
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"]["state"] == "ready"

    def test_unrecognised_version_degrades_json(self, fake_daemon, capsys):
        fake_daemon({**READY_V1, "protocolVersion": 2})
        assert lifecycle.run_status(json_output=True) == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"]["state"] == "degraded"
        assert payload["healthz"]["protocolVersion"] == 2

    def test_unrecognised_version_degrades_human(self, fake_daemon, capsys):
        fake_daemon({**READY_V1, "protocolVersion": 2})
        assert lifecycle.run_status() == 1
        out = capsys.readouterr().out
        assert "healthz: 'degraded'" in out
        assert "healthz: ready" not in out
        assert "protocolVersion=2" in out
        assert "`nanomind-analyst install`" in out

    def test_non_object_reply_degrades_json(self, fake_daemon, capsys):
        fake_daemon([1])
        assert lifecycle.run_status(json_output=True) == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"]["state"] == "degraded"
        assert payload["healthz"]["protocolVersion"] is None

    def test_non_object_reply_degrades_human(self, fake_daemon, capsys):
        fake_daemon([1])
        assert lifecycle.run_status() == 1
        out = capsys.readouterr().out
        assert "healthz: 'degraded'" in out
        assert "not a JSON object" in out
        assert "`nanomind-analyst install`" in out

    def test_non_object_gate_probe_is_not_read(self, fake_daemon, capsys):
        fake_daemon({"daemonState": "degraded", "protocolVersion": 1, "gateProbe": [1]})
        assert lifecycle.run_status(json_output=True) == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"] == {"state": "degraded"}
        assert lifecycle.run_status() == 1
        assert "gate probe" not in capsys.readouterr().out


class TestInstallProbeReadsVersion:
    def test_pre_versioned_daemon_passes(self, fake_daemon):
        fake_daemon(READY_V1)
        assert install._healthz_probe(timeout_sec=3.0) is True

    def test_v1_daemon_passes(self, fake_daemon):
        fake_daemon({**READY_V1, "protocolVersion": 1})
        assert install._healthz_probe(timeout_sec=3.0) is True

    def test_unrecognised_version_fails(self, fake_daemon, capsys):
        fake_daemon({**READY_V1, "protocolVersion": 2})
        assert install._healthz_probe(timeout_sec=1.5) is False
        assert "protocolVersion=2" in capsys.readouterr().err

    def test_unrecognised_version_fails_on_first_reply(self, fake_daemon, capsys):
        """The announced version cannot change between polls, so the wait
        stops at the first such reply instead of polling out the timeout."""
        served = fake_daemon({**READY_V1, "protocolVersion": 2})
        started = time.monotonic()
        assert install._healthz_probe(timeout_sec=10.0) is False
        assert time.monotonic() - started < 3.0
        assert len(served) == 1
        err = capsys.readouterr().err
        assert "protocolVersion=2" in err
        assert "did not return ready within" not in err

    @pytest.mark.parametrize("body", [["ready"], [1]], ids=["list-of-str", "list-of-int"])
    def test_non_object_reply_fails_on_first_reply(self, fake_daemon, capsys, body):
        """No later poll can turn a non-object reply into one this client
        reads, so the wait stops at the first such reply."""
        served = fake_daemon(body)
        started = time.monotonic()
        assert install._healthz_probe(timeout_sec=10.0) is False
        assert time.monotonic() - started < 3.0
        assert len(served) == 1
        err = capsys.readouterr().err
        assert "not a JSON object" in err
        assert "did not return ready within" not in err

    @pytest.mark.parametrize(
        "body",
        [{**READY_V1, "daemonState": "starting", "protocolVersion": 1}],
        ids=["v1-not-ready"],
    )
    def test_other_not_ready_replies_keep_polling(self, fake_daemon, capsys, body):
        served = fake_daemon(body)
        assert install._healthz_probe(timeout_sec=2.2) is False
        assert len(served) >= 2
        assert "did not return ready within" in capsys.readouterr().err


class TestInstallProbeStopsOnTime:
    """Every retry pause is bounded by the deadline, so the wait ends at
    `timeout_sec` instead of up to a second after it."""

    TIMEOUT = 1.5
    # A full one-second pause after the poll at ~1.0s ends the wait at ~2.0s.
    LATEST = TIMEOUT + 0.3

    @pytest.mark.parametrize(
        "body",
        [
            {"daemonState": "loading", "protocolVersion": 1},
            b"not json\n",
            b"\n",
        ],
        ids=["not-ready", "non-json", "empty"],
    )
    def test_reply_retries_end_at_the_timeout(self, fake_daemon, capsys, body):
        served = fake_daemon(body)
        started = time.monotonic()
        assert install._healthz_probe(timeout_sec=self.TIMEOUT) is False
        assert time.monotonic() - started < self.LATEST
        # Polls at ~0s and ~1s, then the bounded pause ends the wait: retries
        # are paced, never a tight reconnect loop.
        assert len(served) <= 3
        assert "did not return ready within" in capsys.readouterr().err

    def test_connect_retries_end_at_the_timeout(self, monkeypatch, capsys):
        sock_path = f"/tmp/nm-analyst-pv-{secrets.token_hex(4)}.sock"
        monkeypatch.setattr(paths, "SOCK_PATH", sock_path)
        started = time.monotonic()
        assert install._healthz_probe(timeout_sec=self.TIMEOUT) is False
        assert time.monotonic() - started < self.LATEST
        assert "FileNotFoundError" in capsys.readouterr().err

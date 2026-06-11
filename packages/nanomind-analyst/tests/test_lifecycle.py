"""Lifecycle (start/stop/status/logs) tests with stubbed launchctl + socket."""
from __future__ import annotations

import json
import secrets
import socket
from pathlib import Path

import pytest

from nanomind_analyst import artifacts, launchd, lifecycle, paths


@pytest.fixture
def no_drift(monkeypatch):
    """Stub the artifact-drift probe to 'matches wheel' for determinism —
    the real probe hashes whatever lives in the machine's Application
    Support dir, which is not test state."""
    monkeypatch.setattr(artifacts, "installed_classifier_drift", lambda d: [])


@pytest.fixture
def fake_sock(monkeypatch):
    """Bind a Unix socket at a short /tmp/ path and patch SOCK_PATH to it.

    Darwin's sun_path is 104 bytes; pytest's tmp_path is too deep for AF_UNIX.
    We bind under /tmp/ with a random suffix and clean up explicitly.
    """
    sock_path = Path(f"/tmp/nm-analyst-test-{secrets.token_hex(4)}.sock")
    monkeypatch.setattr(paths, "SOCK_PATH", str(sock_path))

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(sock_path))
    server.listen(1)
    server.settimeout(2.0)

    yield server, sock_path

    server.close()
    if sock_path.exists():
        sock_path.unlink()


class TestStatus:
    def test_agent_not_loaded(self, monkeypatch, capsys):
        monkeypatch.setattr(launchd, "print_state", lambda: (1, "not found"))
        rc = lifecycle.run_status()
        assert rc == 1
        out = capsys.readouterr().out
        assert "agent: not loaded" in out

    def test_agent_loaded_but_socket_missing(self, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        monkeypatch.setattr(paths, "SOCK_PATH", str(tmp_path / "missing.sock"))
        rc = lifecycle.run_status()
        assert rc == 1
        out = capsys.readouterr().out
        assert "agent: loaded" in out
        assert "socket: missing" in out

    def test_agent_loaded_socket_ready(
        self, monkeypatch, capsys, fake_sock, no_drift
    ):
        server, sock_path = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))

        # Accept one connection in a background thread and respond ready.
        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(
                    json.dumps(
                        {
                            "ok": True,
                            "daemonState": "ready",
                            "requestsServed": 42,
                            "uptimeSec": 100.0,
                        }
                    ).encode()
                    + b"\n"
                )

        t = threading.Thread(target=respond, daemon=True)
        t.start()

        rc = lifecycle.run_status()
        t.join(timeout=3.0)
        assert rc == 0
        out = capsys.readouterr().out
        assert "healthz: ready" in out
        assert "requestsServed=42" in out

    def test_agent_loaded_socket_ready_missing_uptime(
        self, monkeypatch, capsys, fake_sock, no_drift
    ):
        """A healthz response missing uptimeSec must not crash status. Regression
        for the TypeError-on-:f-of-None bug."""
        server, _ = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))

        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(
                    json.dumps(
                        {"ok": True, "daemonState": "ready", "requestsServed": 7}
                    ).encode()
                    + b"\n"
                )

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        rc = lifecycle.run_status()
        t.join(timeout=3.0)
        assert rc == 0
        out = capsys.readouterr().out
        assert "healthz: ready" in out
        assert "uptimeSec=?" in out  # graceful unknown

    def test_agent_loaded_socket_degraded(
        self, monkeypatch, capsys, fake_sock, no_drift
    ):
        server, _ = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))

        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(
                    json.dumps(
                        {
                            "ok": False,
                            "daemonState": "degraded",
                            "gateProbe": {
                                "label": None,
                                "expected": "off-topic",
                                "passed": False,
                            },
                        }
                    ).encode()
                    + b"\n"
                )

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        rc = lifecycle.run_status()
        t.join(timeout=3.0)
        assert rc == 1
        out = capsys.readouterr().out
        assert "healthz: 'degraded'" in out
        assert "gate probe" in out


class TestStatusJson:
    """JSON-output mode for `nanomind-analyst status --json`.

    Contract: emit a single JSON line with camelCase keys; exit codes match
    the human-formatted mode (0 ready, 1 anything else). Downstream tools
    (HMA, opena2a-cli, ai-trust) parse this instead of regexing human text.
    """

    def test_agent_not_loaded_json(self, monkeypatch, capsys):
        monkeypatch.setattr(launchd, "print_state", lambda: (1, "not found"))
        rc = lifecycle.run_status(json_output=True)
        assert rc == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload == {"agent": {"loaded": False}}

    def test_socket_missing_json(self, monkeypatch, capsys, tmp_path, no_drift):
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        sock_path = str(tmp_path / "missing.sock")
        monkeypatch.setattr(paths, "SOCK_PATH", sock_path)
        rc = lifecycle.run_status(json_output=True)
        assert rc == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload == {
            "agent": {"loaded": True},
            "socket": {"path": sock_path, "present": False},
            "artifact": {"classifierMatchesWheel": True},
        }

    def test_socket_missing_json_reports_drift(
        self, monkeypatch, capsys, tmp_path
    ):
        """Drift must be probed on the failure paths too — a drifted artifact
        can fail the daemon's boot-time SHA verify, and a crash-looping
        daemon presents exactly as 'socket missing'."""
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        monkeypatch.setattr(paths, "SOCK_PATH", str(tmp_path / "missing.sock"))
        monkeypatch.setattr(
            artifacts, "installed_classifier_drift", lambda d: ["meta.json"]
        )
        rc = lifecycle.run_status(json_output=True)
        assert rc == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["artifact"] == {
            "classifierMatchesWheel": False,
            "driftedFiles": ["meta.json"],
        }

    def test_socket_missing_human_reports_drift(
        self, monkeypatch, capsys, tmp_path
    ):
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        monkeypatch.setattr(paths, "SOCK_PATH", str(tmp_path / "missing.sock"))
        monkeypatch.setattr(
            artifacts, "installed_classifier_drift", lambda d: ["meta.json"]
        )
        rc = lifecycle.run_status()
        assert rc == 1
        out = capsys.readouterr().out
        assert "socket: missing" in out
        assert "drifted from this wheel" in out
        assert "boot-time SHA verify" in out
        assert "nanomind-analyst install" in out

    def test_ready_json(self, monkeypatch, capsys, fake_sock, no_drift):
        server, sock_path = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))

        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(
                    json.dumps(
                        {
                            "ok": True,
                            "daemonState": "ready",
                            "requestsServed": 42,
                            "uptimeSec": 100.5,
                        }
                    ).encode()
                    + b"\n"
                )

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 0
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload == {
            "agent": {"loaded": True},
            "socket": {"path": str(sock_path), "present": True},
            "healthz": {
                "state": "ready",
                "requestsServed": 42,
                "uptimeSec": 100.5,
            },
            "artifact": {"classifierMatchesWheel": True},
        }

    def test_ready_json_omits_uptime_when_missing(
        self, monkeypatch, capsys, fake_sock, no_drift
    ):
        """If the daemon's healthz payload lacks uptimeSec, the JSON form
        omits the key rather than emitting null or a sentinel."""
        server, sock_path = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))

        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(
                    json.dumps(
                        {"ok": True, "daemonState": "ready", "requestsServed": 7}
                    ).encode()
                    + b"\n"
                )

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 0
        payload = json.loads(capsys.readouterr().out.strip())
        assert "uptimeSec" not in payload["healthz"]
        assert payload["healthz"]["requestsServed"] == 7

    def _ready_with(self, server, body: dict):
        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(json.dumps(body).encode() + b"\n")

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        return t

    def test_ready_surfaces_classifier_threshold(
        self, monkeypatch, capsys, fake_sock, no_drift
    ):
        """The live gate operating point must be visible from status — the
        0.65-vs-0.90 drift class is invisible without it."""
        server, _ = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        t = self._ready_with(
            server,
            {
                "ok": True,
                "daemonState": "ready",
                "requestsServed": 1,
                "uptimeSec": 5.0,
                "classifierThreshold": 0.9,
            },
        )
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 0
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"]["classifierThreshold"] == 0.9

    def test_ready_reports_artifact_drift(self, monkeypatch, capsys, fake_sock):
        """pip upgrade without `nanomind-analyst install` leaves the old
        artifact (old operating point) running. status must say so, with
        exit code still 0 (the daemon IS serving)."""
        server, _ = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        monkeypatch.setattr(
            artifacts, "installed_classifier_drift", lambda d: ["meta.json"]
        )
        t = self._ready_with(
            server, {"ok": True, "daemonState": "ready", "requestsServed": 1}
        )
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 0
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["artifact"] == {
            "classifierMatchesWheel": False,
            "driftedFiles": ["meta.json"],
        }

    def test_ready_reports_artifact_drift_human(
        self, monkeypatch, capsys, fake_sock
    ):
        server, _ = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        monkeypatch.setattr(
            artifacts, "installed_classifier_drift", lambda d: ["meta.json"]
        )
        t = self._ready_with(
            server,
            {
                "ok": True,
                "daemonState": "ready",
                "requestsServed": 1,
                "uptimeSec": 5.0,
                "classifierThreshold": 0.65,
            },
        )
        rc = lifecycle.run_status()
        t.join(timeout=3.0)
        assert rc == 0
        out = capsys.readouterr().out
        assert "gate threshold: 0.65" in out
        assert "drifted from this wheel" in out
        assert "nanomind-analyst install" in out


    def test_no_response_json(self, monkeypatch, capsys, fake_sock, no_drift):
        """Socket exists but the daemon does not answer healthz."""
        server, sock_path = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))

        # Accept the connection but send nothing, so _healthz_once times out
        # and returns None.
        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                # send nothing

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload == {
            "agent": {"loaded": True},
            "socket": {"path": str(sock_path), "present": True},
            "healthz": {"state": "no-response"},
            "artifact": {"classifierMatchesWheel": True},
        }

    def test_degraded_json_includes_gate_probe(
        self, monkeypatch, capsys, fake_sock, no_drift
    ):
        server, sock_path = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))

        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                conn.sendall(
                    json.dumps(
                        {
                            "ok": False,
                            "daemonState": "degraded",
                            "gateProbe": {
                                "label": None,
                                "expected": "off-topic",
                                "passed": False,
                            },
                        }
                    ).encode()
                    + b"\n"
                )

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"]["state"] == "degraded"
        assert payload["healthz"]["gateProbe"] == {
            "label": None,
            "expected": "off-topic",
            "passed": False,
        }
        # Degraded is an rc=1 path; it carries the artifact block like the
        # other failure paths.
        assert payload["artifact"] == {"classifierMatchesWheel": True}

    def test_degraded_json_reports_drift(self, monkeypatch, capsys, fake_sock):
        """A drifted artifact (old operating point) can be why the gate
        probe is failing — the degraded path must surface it too."""
        server, _ = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        monkeypatch.setattr(
            artifacts, "installed_classifier_drift", lambda d: ["meta.json"]
        )
        t = self._ready_with(
            server,
            {"ok": False, "daemonState": "degraded", "gateProbe": {}},
        )
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["artifact"] == {
            "classifierMatchesWheel": False,
            "driftedFiles": ["meta.json"],
        }

    def test_no_response_json_reports_drift(self, monkeypatch, capsys, fake_sock):
        """healthz no-response is the other dead-daemon presentation; drift
        must be surfaced there too."""
        server, _ = fake_sock
        monkeypatch.setattr(launchd, "print_state", lambda: (0, "loaded"))
        monkeypatch.setattr(
            artifacts, "installed_classifier_drift", lambda d: ["meta.json"]
        )

        import threading

        def respond():
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                # send nothing

        t = threading.Thread(target=respond, daemon=True)
        t.start()
        rc = lifecycle.run_status(json_output=True)
        t.join(timeout=3.0)
        assert rc == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert payload["healthz"] == {"state": "no-response"}
        assert payload["artifact"] == {
            "classifierMatchesWheel": False,
            "driftedFiles": ["meta.json"],
        }


class TestInstalledClassifierDrift:
    def test_matching_artifact_reports_no_drift(self, tmp_path):
        src = artifacts.wheel_classifier_source_dir()
        import shutil

        for fname in ("classifier.joblib", "meta.json"):
            shutil.copy2(src / fname, tmp_path / fname)
        assert artifacts.installed_classifier_drift(tmp_path) == []

    def test_stale_meta_reports_drift(self, tmp_path):
        src = artifacts.wheel_classifier_source_dir()
        import shutil

        shutil.copy2(src / "classifier.joblib", tmp_path / "classifier.joblib")
        (tmp_path / "meta.json").write_text('{"threshold": 0.65}')
        assert artifacts.installed_classifier_drift(tmp_path) == ["meta.json"]

    def test_missing_files_report_drift(self, tmp_path):
        assert artifacts.installed_classifier_drift(tmp_path) == [
            "classifier.joblib",
            "meta.json",
        ]


class TestStartStopRestart:
    def test_start_calls_kickstart(self, monkeypatch, capsys):
        called = {}
        monkeypatch.setattr(
            launchd,
            "kickstart",
            lambda *, restart=False: called.setdefault("restart", restart),
        )
        rc = lifecycle.run_start()
        assert rc == 0
        assert called["restart"] is False

    def test_restart_calls_kickstart_with_k(self, monkeypatch):
        called = {}
        monkeypatch.setattr(
            launchd,
            "kickstart",
            lambda *, restart=False: called.setdefault("restart", restart),
        )
        rc = lifecycle.run_restart()
        assert rc == 0
        assert called["restart"] is True

    def test_stop_calls_stop_service(self, monkeypatch, capsys):
        called = {"count": 0}
        monkeypatch.setattr(
            launchd, "stop_service", lambda: called.__setitem__("count", 1)
        )
        rc = lifecycle.run_stop()
        assert rc == 0
        assert called["count"] == 1
        assert "stop sent" in capsys.readouterr().out


class TestLogs:
    def test_logs_missing_file(self, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(paths, "log_path", lambda: tmp_path / "missing.log")
        rc = lifecycle.run_logs(follow=True)
        assert rc == 1
        assert "log file missing" in capsys.readouterr().out

    def test_logs_present_file_execs_tail(self, monkeypatch, tmp_path):
        log = tmp_path / "log.txt"
        log.write_text("hello\n")
        monkeypatch.setattr(paths, "log_path", lambda: log)

        execed: list[tuple[str, list[str]]] = []

        def fake_execv(path, argv):
            execed.append((path, argv))
            # Don't actually exec; raise SystemExit to mimic.
            raise SystemExit(0)

        monkeypatch.setattr("os.execv", fake_execv)
        with pytest.raises(SystemExit):
            lifecycle.run_logs(follow=False)
        assert execed[0][0] == "/usr/bin/tail"
        assert str(log) in execed[0][1]
        assert "-F" not in execed[0][1]  # follow=False
        assert "-n" in execed[0][1]

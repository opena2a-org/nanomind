"""Lifecycle (start/stop/status/logs) tests with stubbed launchctl + socket."""
from __future__ import annotations

import json
import os
import secrets
import socket
from pathlib import Path

import pytest

from nanomind_analyst import launchd, lifecycle, paths


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
        self, monkeypatch, capsys, fake_sock
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

    def test_agent_loaded_socket_degraded(
        self, monkeypatch, capsys, fake_sock
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

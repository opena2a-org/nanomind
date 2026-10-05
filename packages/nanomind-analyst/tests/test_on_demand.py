"""On-demand daemon: the default install does not keep a 1.7B model resident.

Covers the three install cells (on-demand starts the daemon once and waits on
the probe; `--skip-healthz-wait` neither starts nor probes; `--resident`
loads at login), the plist each mode renders, and the daemon's idle-exit
window that releases the model when nothing has asked for it.
"""
from __future__ import annotations

import plistlib
import shutil
import socket
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from nanomind_analyst import artifacts, cli, install, launchd, paths
from nanomind_analyst.daemon import nanomind_guard_daemon as daemon


def _spec(*, resident: bool = False) -> launchd.PlistSpec:
    return launchd.PlistSpec(
        label=paths.LABEL,
        program="nanomind-analyst-daemon",
        python_executable="/usr/bin/python3",
        classifier_dir="/c",
        model_dir="/m",
        classifier_joblib_sha256="a" * 64,
        classifier_meta_sha256="b" * 64,
        log_path="/l",
        sock_path="/tmp/nanomind-guard.sock",
        resident=resident,
    )


class TestPlistModes:
    def test_default_plist_does_not_launch_at_load(self):
        body = plistlib.loads(launchd.render_plist(_spec()))
        assert body["RunAtLoad"] is False
        # launchd.plist(5): KeepAlive.SuccessfulExit implies RunAtLoad true,
        # so an on-demand plist must not carry it.
        assert "SuccessfulExit" not in body["KeepAlive"]
        assert body["KeepAlive"]["Crashed"] is True
        # The daemon's own default idle window applies.
        assert "NANOMIND_GUARD_IDLE_EXIT_SEC" not in body["EnvironmentVariables"]

    def test_resident_plist_launches_at_load_and_never_idles_out(self):
        body = plistlib.loads(launchd.render_plist(_spec(resident=True)))
        assert body["RunAtLoad"] is True
        assert body["KeepAlive"] == {"SuccessfulExit": False, "Crashed": True}
        assert body["EnvironmentVariables"]["NANOMIND_GUARD_IDLE_EXIT_SEC"] == "0"

    def test_build_plist_spec_defaults_to_on_demand(self, tmp_path, monkeypatch):
        monkeypatch.setattr(paths, "home", lambda: tmp_path)
        assert launchd.build_plist_spec().resident is False
        assert launchd.build_plist_spec(resident=True).resident is True


@pytest.fixture
def stubbed_install(tmp_path, monkeypatch):
    """Run install with the fetch, launchctl and healthz probe stubbed."""
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(paths, "home", lambda: fake_home)
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")

    def stub_fetch_nlm(*, target_dir, progress=None, hf_downloader=None):
        target_dir.mkdir(parents=True, exist_ok=True)
        for fname in artifacts.NLM_REQUIRED_FILES:
            (target_dir / fname).write_bytes(b"stub")

    monkeypatch.setattr(artifacts, "fetch_nlm", stub_fetch_nlm)

    rec = SimpleNamespace(launchctl=[], probes=0, probe_result=True)

    class FakeResult:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(args, **kw):
        rec.launchctl.append(args[1:])
        return FakeResult()

    def fake_probe(timeout_sec=60.0):
        rec.probes += 1
        return rec.probe_result

    monkeypatch.setattr("subprocess.run", fake_run)
    monkeypatch.setattr(install, "_healthz_probe", fake_probe)
    rec.plist = lambda: plistlib.loads(paths.plist_path().read_bytes())
    rec.verbs = lambda: [c[0] for c in rec.launchctl]
    return rec


class TestInstallModes:
    def test_on_demand_install_starts_daemon_once_and_waits(
        self, stubbed_install, capsys
    ):
        rc = install.run_install()
        assert rc == 0
        assert stubbed_install.plist()["RunAtLoad"] is False
        verbs = stubbed_install.verbs()
        assert verbs.index("bootstrap") < verbs.index("kickstart")
        kick = next(c for c in stubbed_install.launchctl if c[0] == "kickstart")
        # The same kickstart `nanomind-analyst start` uses: no -k restart.
        assert kick == ["kickstart", f"gui/{paths.uid()}/{paths.LABEL}"]
        assert stubbed_install.probes == 1
        out = capsys.readouterr().out
        assert "daemon ready at" in out
        assert "s on this machine" in out

    def test_on_demand_install_exits_nonzero_when_probe_fails(
        self, stubbed_install
    ):
        stubbed_install.probe_result = False
        assert install.run_install() == 1

    def test_skip_healthz_wait_neither_starts_nor_probes(self, stubbed_install):
        rc = install.run_install(skip_healthz_wait=True)
        assert rc == 0
        assert stubbed_install.plist()["RunAtLoad"] is False
        assert "kickstart" not in stubbed_install.verbs()
        assert stubbed_install.probes == 0

    def test_resident_install_loads_at_login_and_waits(self, stubbed_install):
        rc = install.run_install(resident=True)
        assert rc == 0
        assert stubbed_install.plist()["RunAtLoad"] is True
        # RunAtLoad already started it at bootstrap; no second start.
        assert "kickstart" not in stubbed_install.verbs()
        assert stubbed_install.probes == 1


class TestInstallCli:
    def test_resident_flag_routes(self, monkeypatch):
        seen = {}

        def fake_install(*, skip_healthz_wait=False, resident=False):
            seen["resident"] = resident
            return 0

        monkeypatch.setattr(cli.install, "run_install", fake_install)
        assert cli.main(["install"]) == 0
        assert seen["resident"] is False
        assert cli.main(["install", "--resident"]) == 0
        assert seen["resident"] is True

    def test_help_states_resident_effect_before_plist_key(self, capsys):
        with pytest.raises(SystemExit):
            cli.main(["install", "--help"])
        out = " ".join(capsys.readouterr().out.split())
        assert "--resident" in out
        assert "--on-demand" not in out
        effect = out.index("Keep the analyst running")
        assert effect < out.index("RunAtLoad")


@pytest.fixture
def short_sock():
    # AF_UNIX paths are capped near 104 bytes on macOS; pytest's tmp_path can
    # exceed that, so bind under a short mkdtemp directory instead.
    d = tempfile.mkdtemp(prefix="nm")
    yield str(Path(d) / "g.sock")
    shutil.rmtree(d, ignore_errors=True)


def _start_serve(sock_path: str, idle: str | None, monkeypatch):
    env = {
        "INPUT_CLASSIFIER_JOBLIB_SHA256": "a" * 64,
        "INPUT_CLASSIFIER_META_SHA256": "b" * 64,
        "NANOMIND_GUARD_SOCK": sock_path,
    }
    if idle is not None:
        env["NANOMIND_GUARD_IDLE_EXIT_SEC"] = idle
    cfg = daemon.Config.from_env(env)
    monkeypatch.setattr(daemon, "dispatch", lambda state, line: {"ok": True})
    stop = threading.Event()
    ready = threading.Event()
    t = threading.Thread(
        target=daemon.serve,
        args=(SimpleNamespace(cfg=cfg),),
        kwargs={
            "stop_event": stop,
            "install_signal_handlers": False,
            "ready_callback": ready.set,
        },
        daemon=True,
    )
    t.start()
    assert ready.wait(5.0)
    return t, stop


def _request(sock_path: str) -> None:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2.0)
    try:
        s.connect(sock_path)
        s.sendall(b'{"op":"healthz"}\n')
        s.recv(1024)
    finally:
        s.close()


class TestIdleExit:
    def test_default_window_is_900_seconds(self):
        cfg = daemon.Config.from_env(
            {
                "INPUT_CLASSIFIER_JOBLIB_SHA256": "a" * 64,
                "INPUT_CLASSIFIER_META_SHA256": "b" * 64,
            }
        )
        assert cfg.idle_exit_sec == 900.0

    def test_non_numeric_window_is_a_config_error(self):
        with pytest.raises(daemon.ConfigError):
            daemon.Config.from_env(
                {
                    "INPUT_CLASSIFIER_JOBLIB_SHA256": "a" * 64,
                    "INPUT_CLASSIFIER_META_SHA256": "b" * 64,
                    "NANOMIND_GUARD_IDLE_EXIT_SEC": "soon",
                }
            )

    def test_daemon_exits_on_its_own_after_window(self, short_sock, monkeypatch):
        t, stop = _start_serve(short_sock, "0.5", monkeypatch)
        try:
            t.join(5.0)
            assert not t.is_alive()
            assert not Path(short_sock).exists()
        finally:
            stop.set()

    def test_requests_keep_the_daemon_alive(self, short_sock, monkeypatch):
        t, stop = _start_serve(short_sock, "2.0", monkeypatch)
        try:
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                _request(short_sock)
                time.sleep(0.2)
            assert t.is_alive()
            t.join(6.0)
            assert not t.is_alive()
        finally:
            stop.set()

    def test_zero_window_keeps_daemon_running(self, short_sock, monkeypatch):
        t, stop = _start_serve(short_sock, "0", monkeypatch)
        try:
            t.join(1.0)
            assert t.is_alive()
        finally:
            stop.set()
            t.join(5.0)
        assert not t.is_alive()

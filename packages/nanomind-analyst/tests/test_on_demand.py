"""0.1.4: the guard daemon is on-demand by default (NMD-04).

The plist template renders an on-demand mode (RunAtLoad false) as the default
and a resident mode behind `nanomind-analyst install --resident`; the accept
loop exits on its own after NANOMIND_GUARD_IDLE_EXIT_SEC seconds without a
request (default 900, 0 disables); the installer waits for healthz only in
resident mode; and the plist carries HF_HUB_OFFLINE=1 so a boot never
consults huggingface.co for an embedder that is already cached.

Everything here runs over fakes: no launchd, no model, no network. serve() is
driven in a background thread with a sub-two-second window.
"""
from __future__ import annotations

import argparse
import json
import plistlib
import secrets
import socket
import threading
import time
import tomllib
from pathlib import Path
from types import SimpleNamespace

import pytest

from nanomind_analyst import artifacts, cli, install, launchd, paths
from nanomind_analyst.daemon import nanomind_guard_daemon as daemon
from nanomind_analyst.daemon.input_classifier.predictor import Prediction

PKG_ROOT = Path(__file__).resolve().parent.parent

# Every key render_plist wrote at 0.1.3, with the value it wrote for _spec().
# AC1: these must still be written, unchanged, in both modes.
_BASE_KEYS_FOR_SPEC = {
    "Label": "org.opena2a.nanomind-analyst",
    "ProgramArguments": [
        "/usr/bin/python3",
        "-m",
        "nanomind_analyst.daemon.nanomind_guard_daemon",
    ],
    "StandardOutPath": "/tmp/nm-log.txt",
    "StandardErrorPath": "/tmp/nm-log.txt",
    "ProcessType": "Interactive",
}
_BASE_ENV_FOR_SPEC = {
    "NANOMIND_GUARD_SOCK": "/tmp/nanomind-guard.sock",
    "NANOMIND_GUARD_MODEL_DIR": "/tmp/model",
    "NANOMIND_GUARD_CLASSIFIER_DIR": "/tmp/classifier",
    "INPUT_CLASSIFIER_JOBLIB_SHA256": "a" * 64,
    "INPUT_CLASSIFIER_META_SHA256": "b" * 64,
    "PYTHONUNBUFFERED": "1",
}


def _spec(**overrides) -> launchd.PlistSpec:
    fields = dict(
        label="org.opena2a.nanomind-analyst",
        program="nanomind-analyst-daemon",
        python_executable="/usr/bin/python3",
        classifier_dir="/tmp/classifier",
        model_dir="/tmp/model",
        classifier_joblib_sha256="a" * 64,
        classifier_meta_sha256="b" * 64,
        log_path="/tmp/nm-log.txt",
        sock_path="/tmp/nanomind-guard.sock",
    )
    fields.update(overrides)
    return launchd.PlistSpec(**fields)


def _render(**overrides) -> dict:
    return plistlib.loads(launchd.render_plist(_spec(**overrides)))


# ---------------------------------------------------------------------------
# AC1: two modes from one PlistSpec field; on-demand is the default
# ---------------------------------------------------------------------------


class TestAC1PlistModes:
    def test_NMD_04_AC1_on_demand_spec_renders_run_at_load_false(self):
        assert _render(resident=False)["RunAtLoad"] is False

    def test_NMD_04_AC1_resident_spec_renders_run_at_load_true(self):
        assert _render(resident=True)["RunAtLoad"] is True

    def test_NMD_04_AC1_spec_without_mode_is_on_demand(self):
        """A PlistSpec built without naming the mode (every 0.1.3 call site)
        is on-demand."""
        spec = _spec()
        assert spec.resident is False
        assert _render()["RunAtLoad"] is False

    def test_NMD_04_AC1_build_plist_spec_default_is_on_demand(self):
        spec = launchd.build_plist_spec()
        assert spec.resident is False
        assert plistlib.loads(launchd.render_plist(spec))["RunAtLoad"] is False

    def test_NMD_04_AC1_build_plist_spec_resident_opt_in(self):
        spec = launchd.build_plist_spec(resident=True)
        assert spec.resident is True
        assert plistlib.loads(launchd.render_plist(spec))["RunAtLoad"] is True

    @pytest.mark.parametrize("resident", [False, True])
    def test_NMD_04_AC1_keep_alive_never_restarts_a_clean_exit(self, resident):
        """A clean idle exit must not be restarted by launchd in either mode."""
        body = _render(resident=resident)
        assert body["KeepAlive"] == {"SuccessfulExit": False, "Crashed": True}

    @pytest.mark.parametrize("resident", [False, True])
    def test_NMD_04_AC1_base_keys_still_written_with_same_values(self, resident):
        body = _render(resident=resident)
        for key, value in _BASE_KEYS_FOR_SPEC.items():
            assert body[key] == value, key
        assert body["WorkingDirectory"] == str(paths.home())
        env = body["EnvironmentVariables"]
        for key, value in _BASE_ENV_FOR_SPEC.items():
            assert env[key] == value, key


# ---------------------------------------------------------------------------
# AC2: the resident opt-in end to end (CLI -> run_install -> plist on disk)
# ---------------------------------------------------------------------------


@pytest.fixture
def install_env(tmp_path, monkeypatch):
    """Redirect paths to tmp, stub the fetch + launchctl, keep the real plist
    writer so the on-disk plist can be read back. Yields the plist path."""
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

    class FakeResult:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr("subprocess.run", lambda *a, **kw: FakeResult())
    return fake_home / "Library" / "LaunchAgents" / f"{paths.LABEL}.plist"


class TestAC2ResidentOptIn:
    def _capture_run_install(self, monkeypatch):
        called: dict = {}

        def fake_run_install(*, skip_healthz_wait=False, resident=False):
            called["skip_healthz_wait"] = skip_healthz_wait
            called["resident"] = resident
            return 0

        monkeypatch.setattr(cli.install, "run_install", fake_run_install)
        return called

    def test_NMD_04_AC2_cli_install_resident_reaches_run_install_true(
        self, monkeypatch
    ):
        called = self._capture_run_install(monkeypatch)
        assert cli.main(["install", "--resident"]) == 0
        assert called["resident"] is True

    def test_NMD_04_AC2_cli_plain_install_reaches_run_install_false(
        self, monkeypatch
    ):
        called = self._capture_run_install(monkeypatch)
        assert cli.main(["install"]) == 0
        assert called["resident"] is False
        assert called["skip_healthz_wait"] is False

    def test_NMD_04_AC2_install_help_lists_resident_flag(self):
        parser = cli.build_parser()
        sub = next(
            a for a in parser._actions if isinstance(a, argparse._SubParsersAction)
        )
        help_text = sub.choices["install"].format_help()
        assert "--resident" in help_text

    def test_NMD_04_AC2_run_install_resident_writes_run_at_load_true(
        self, install_env, monkeypatch
    ):
        monkeypatch.setattr(install, "_healthz_probe", lambda timeout_sec=60.0: True)
        assert install.run_install(resident=True) == 0
        body = plistlib.loads(install_env.read_bytes())
        assert body["RunAtLoad"] is True

    def test_NMD_04_AC2_run_install_default_writes_run_at_load_false(
        self, install_env, monkeypatch
    ):
        def never(timeout_sec=60.0):  # pragma: no cover - must not be reached
            raise AssertionError("_healthz_probe must not run in on-demand mode")

        monkeypatch.setattr(install, "_healthz_probe", never)
        assert install.run_install() == 0
        body = plistlib.loads(install_env.read_bytes())
        assert body["RunAtLoad"] is False


# ---------------------------------------------------------------------------
# AC3: the idle-exit window in Config and in serve()
# ---------------------------------------------------------------------------

_VALID_ENV = {
    "INPUT_CLASSIFIER_JOBLIB_SHA256": "a" * 64,
    "INPUT_CLASSIFIER_META_SHA256": "b" * 64,
}

ACCEPT_POLL_SEC = 0.25  # server.settimeout(0.25) in serve()
# Thread scheduling slack on top of the contract's "window + poll" bound.
_SLACK_SEC = 0.5


class _Gate:
    threshold = 0.90
    embedder_id = "sentence-transformers/all-MiniLM-L6-v2"

    def predict_one(self, text: str) -> Prediction:
        return Prediction(
            label="off-topic", proba_off_topic=0.97, reason="lr", bypass_nlm=True
        )


def _fake_state(sock_path: str, idle_exit_sec: float) -> SimpleNamespace:
    return SimpleNamespace(
        classifier=_Gate(),
        nlm=None,
        cfg=SimpleNamespace(
            sock_path=sock_path,
            model_dir="/m",
            classifier_dir="/c",
            max_bytes=daemon.DEFAULT_MAX_BYTES,
            conn_timeout_sec=2.0,
            idle_exit_sec=idle_exit_sec,
        ),
        boot_ts=time.time(),
        requests_served=0,
    )


class _ServeThread:
    """Run serve() in a background thread; record when it returns."""

    def __init__(self, idle_exit_sec: float) -> None:
        # Darwin's sun_path is 104 bytes; pytest's tmp_path is too deep.
        self.sock_path = f"/tmp/nm-idle-{secrets.token_hex(4)}.sock"
        self.state = _fake_state(self.sock_path, idle_exit_sec)
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.ready_at: float | None = None
        self.returned_at: float | None = None
        self.error: BaseException | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _on_ready(self) -> None:
        self.ready_at = time.monotonic()
        self.ready.set()

    def _run(self) -> None:
        try:
            daemon.serve(
                self.state,
                ready_callback=self._on_ready,
                stop_event=self.stop_event,
                install_signal_handlers=False,
            )
        except BaseException as exc:  # noqa: BLE001 - surfaced by the test
            self.error = exc
        finally:
            self.returned_at = time.monotonic()

    def start(self) -> "_ServeThread":
        self.thread.start()
        assert self.ready.wait(5.0), "serve() never reached the ready point"
        return self

    def healthz(self) -> dict:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as c:
            c.settimeout(2.0)
            c.connect(self.sock_path)
            c.sendall(b'{"op":"healthz"}\n')
            buf = b""
            while b"\n" not in buf:
                chunk = c.recv(65536)
                if not chunk:
                    break
                buf += chunk
        return json.loads(buf.partition(b"\n")[0])

    def finish(self) -> None:
        self.stop_event.set()
        self.thread.join(5.0)
        assert not self.thread.is_alive(), "serve() did not return"
        assert self.error is None, self.error


@pytest.fixture
def serve_thread():
    threads: list[_ServeThread] = []

    def factory(idle_exit_sec: float) -> _ServeThread:
        t = _ServeThread(idle_exit_sec)
        threads.append(t)
        return t

    yield factory
    for t in threads:
        t.finish()
        assert not Path(t.sock_path).exists(), "finally block must unlink the socket"


class TestAC3IdleExit:
    def test_NMD_04_AC3_from_env_default_is_900_when_absent(self):
        cfg = daemon.Config.from_env(dict(_VALID_ENV))
        assert cfg.idle_exit_sec == 900
        assert daemon.DEFAULT_IDLE_EXIT_SEC == 900

    def test_NMD_04_AC3_from_env_reads_numeric_window(self):
        env = dict(_VALID_ENV, NANOMIND_GUARD_IDLE_EXIT_SEC="42")
        assert daemon.Config.from_env(env).idle_exit_sec == 42.0
        env = dict(_VALID_ENV, NANOMIND_GUARD_IDLE_EXIT_SEC="0")
        assert daemon.Config.from_env(env).idle_exit_sec == 0

    def test_NMD_04_AC3_serve_returns_after_idle_window_with_no_client(
        self, serve_thread
    ):
        window = 1.0
        t = serve_thread(window).start()
        t.thread.join(window + ACCEPT_POLL_SEC + _SLACK_SEC)
        assert not t.thread.is_alive(), "serve() did not exit on idle"
        assert t.error is None, t.error
        elapsed = t.returned_at - t.ready_at
        assert elapsed >= window - 0.05, f"returned early: {elapsed:.3f}s"
        assert elapsed <= window + ACCEPT_POLL_SEC + _SLACK_SEC
        assert not Path(t.sock_path).exists()

    def test_NMD_04_AC3_one_request_resets_the_window(self, serve_thread):
        window = 1.0
        t = serve_thread(window).start()
        time.sleep(0.4)
        sent_at = time.monotonic()
        assert t.healthz()["daemonState"] == "ready"
        # Not before: one full window after the request the loop is still up.
        t.thread.join(window - 0.3)
        assert t.thread.is_alive(), "serve() exited before a full window elapsed"
        # And then it returns within window + accept poll of the request.
        t.thread.join(0.3 + ACCEPT_POLL_SEC + _SLACK_SEC)
        assert not t.thread.is_alive(), "serve() did not exit after the reset window"
        assert t.error is None, t.error
        since_request = t.returned_at - sent_at
        assert since_request >= window - 0.05, f"returned early: {since_request:.3f}s"
        assert since_request <= window + ACCEPT_POLL_SEC + _SLACK_SEC

    def test_NMD_04_AC3_zero_disables_the_idle_exit(self, serve_thread):
        t = serve_thread(0).start()
        t.thread.join(1.0)
        assert t.thread.is_alive(), "window 0 must keep serving"
        assert t.healthz()["daemonState"] == "ready"
        t.stop_event.set()
        t.thread.join(5.0)
        assert not t.thread.is_alive()


# ---------------------------------------------------------------------------
# AC4: an unreadable window refuses to start; the plist states the window
# ---------------------------------------------------------------------------


class TestAC4UnreadableWindow:
    @pytest.mark.parametrize("bad", ["abc", "-1", "", "nan", "15m"])
    def test_NMD_04_AC4_from_env_refuses_non_numeric_or_negative(self, bad):
        env = dict(_VALID_ENV, NANOMIND_GUARD_IDLE_EXIT_SEC=bad)
        with pytest.raises(daemon.ConfigError) as exc:
            daemon.Config.from_env(env)
        assert "NANOMIND_GUARD_IDLE_EXIT_SEC" in str(exc.value)

    @pytest.mark.parametrize("bad", ["abc", "-1"])
    def test_NMD_04_AC4_main_exits_2_with_fatal_naming_the_variable(
        self, monkeypatch, capsys, bad
    ):
        for k, v in _VALID_ENV.items():
            monkeypatch.setenv(k, v)
        monkeypatch.setenv("NANOMIND_GUARD_IDLE_EXIT_SEC", bad)
        booted = []
        monkeypatch.setattr(daemon, "boot", lambda cfg: booted.append(cfg))
        rc = daemon.main([])
        assert rc == 2
        err = capsys.readouterr().err
        fatal = [ln for ln in err.splitlines() if ln.startswith("FATAL:")]
        assert fatal, err
        assert any("NANOMIND_GUARD_IDLE_EXIT_SEC" in ln for ln in fatal)
        assert booted == []

    def test_NMD_04_AC4_plist_env_states_900_for_on_demand(self):
        env = _render(resident=False)["EnvironmentVariables"]
        assert env["NANOMIND_GUARD_IDLE_EXIT_SEC"] == "900"

    def test_NMD_04_AC4_plist_env_states_0_for_resident(self):
        env = _render(resident=True)["EnvironmentVariables"]
        assert env["NANOMIND_GUARD_IDLE_EXIT_SEC"] == "0"

    def test_NMD_04_AC4_plist_default_matches_daemon_default(self):
        """The window the host runs under is the daemon's own default."""
        env = _render(resident=False)["EnvironmentVariables"]
        assert float(env["NANOMIND_GUARD_IDLE_EXIT_SEC"]) == daemon.DEFAULT_IDLE_EXIT_SEC


# ---------------------------------------------------------------------------
# AC5: the healthz wait runs only in resident mode
# ---------------------------------------------------------------------------


@pytest.fixture
def stubbed_flow(tmp_path, monkeypatch):
    """Stub every side effect of run_install except the post-bootstrap branch;
    return the list of _healthz_probe calls."""
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(paths, "home", lambda: fake_home)
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setattr(
        artifacts,
        "fetch_nlm",
        lambda *, target_dir, progress=None, hf_downloader=None: None,
    )
    monkeypatch.setattr(
        artifacts,
        "install_classifier",
        lambda *, source_dir, target_dir, progress=None: None,
    )
    monkeypatch.setattr(launchd, "write_plist", lambda spec, *, target=None: tmp_path / "fake.plist")
    monkeypatch.setattr(launchd, "bootout", lambda: None)
    monkeypatch.setattr(launchd, "bootstrap", lambda plist: None)

    probe_calls: list[float] = []
    verdict = {"ready": True}

    def fake_probe(timeout_sec=60.0):
        probe_calls.append(timeout_sec)
        return verdict["ready"]

    monkeypatch.setattr(install, "_healthz_probe", fake_probe)
    return probe_calls, verdict


class TestAC5HealthzWaitOnlyWhenResident:
    def test_NMD_04_AC5_resident_ready_returns_0_after_probe(
        self, stubbed_flow, capsys
    ):
        probe_calls, _ = stubbed_flow
        assert install.run_install(resident=True) == 0
        assert probe_calls == [60.0]
        out = capsys.readouterr().out
        assert "daemon ready at" in out

    def test_NMD_04_AC5_resident_timeout_returns_1_with_base_line(
        self, stubbed_flow, capsys
    ):
        probe_calls, verdict = stubbed_flow
        verdict["ready"] = False
        assert install.run_install(resident=True) == 1
        assert probe_calls == [60.0]
        out = capsys.readouterr().out
        assert "did not pass healthz within 60s" in out

    def test_NMD_04_AC5_on_demand_never_probes_and_names_start(
        self, stubbed_flow, capsys
    ):
        probe_calls, _ = stubbed_flow
        assert install.run_install(resident=False) == 0
        assert probe_calls == []
        out = capsys.readouterr().out
        assert "on demand" in out
        assert "`nanomind-analyst start`" in out
        assert "waiting for daemon" not in out

    def test_NMD_04_AC5_on_demand_is_the_default(self, stubbed_flow):
        probe_calls, _ = stubbed_flow
        assert install.run_install() == 0
        assert probe_calls == []

    def test_NMD_04_AC5_skip_healthz_wait_still_skips_in_resident_mode(
        self, stubbed_flow, capsys
    ):
        probe_calls, _ = stubbed_flow
        assert install.run_install(resident=True, skip_healthz_wait=True) == 0
        assert probe_calls == []
        assert "skipping healthz wait" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# AC6 (plist half): HF_HUB_OFFLINE=1 in both modes. The offline boot cell is
# the smoke-marked test in tests/test_install_smoke.py.
# ---------------------------------------------------------------------------


class TestAC6PlistOffline:
    @pytest.mark.parametrize("resident", [False, True])
    def test_NMD_04_AC6_plist_env_carries_hf_hub_offline_1(self, resident):
        env = _render(resident=resident)["EnvironmentVariables"]
        assert env["HF_HUB_OFFLINE"] == "1"


# ---------------------------------------------------------------------------
# AC7: version, CHANGELOG and README agree on the change
# ---------------------------------------------------------------------------


class TestAC7PackageRecord:
    def test_NMD_04_AC7_pyproject_version_is_0_1_4(self):
        data = tomllib.loads((PKG_ROOT / "pyproject.toml").read_text())
        assert data["project"]["version"] == "0.1.4"

    def test_NMD_04_AC7_changelog_has_0_1_4_section_above_0_1_3(self):
        text = (PKG_ROOT / "CHANGELOG.md").read_text()
        new = text.index("## 0.1.4")
        old = text.index("## 0.1.3")
        assert new < old
        section = text[new:old]
        assert "RunAtLoad" in section
        assert "false" in section and "on-demand" in section
        assert "--resident" in section
        assert "NANOMIND_GUARD_IDLE_EXIT_SEC" in section
        assert "900" in section
        assert "`0` disables" in section
        assert "healthz" in section and "resident" in section
        assert "HF_HUB_OFFLINE=1" in section

    def test_NMD_04_AC7_readme_no_longer_says_the_process_stays_warm(self):
        text = (PKG_ROOT / "README.md").read_text()
        assert "stays warm" not in text
        assert "on demand" in text
        assert "idle" in text

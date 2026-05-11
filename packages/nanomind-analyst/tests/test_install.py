"""Install-flow tests.

The install flow makes launchctl + filesystem changes. Tests stub launchctl,
redirect paths to a temp directory, and inject the artifact fetcher so no
network is required. Platform guard is exercised directly.
"""
from __future__ import annotations

import plistlib
from pathlib import Path

import pytest

from nanomind_analyst import artifacts, install, launchd, paths


class TestPlatformGuard:
    def test_refuses_linux(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Linux")
        monkeypatch.setattr("platform.machine", lambda: "x86_64")
        with pytest.raises(install.InstallError) as exc:
            install.assert_supported_platform()
        msg = str(exc.value)
        assert "Darwin arm64" in msg
        assert "v0.1" in msg

    def test_refuses_intel_mac(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Darwin")
        monkeypatch.setattr("platform.machine", lambda: "x86_64")
        with pytest.raises(install.InstallError):
            install.assert_supported_platform()

    def test_accepts_apple_silicon(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Darwin")
        monkeypatch.setattr("platform.machine", lambda: "arm64")
        install.assert_supported_platform()  # does not raise


class TestPlistAuthoring:
    def test_render_plist_contains_required_keys(self, tmp_path):
        spec = launchd.PlistSpec(
            label="org.opena2a.nanomind-analyst",
            program="nanomind-analyst-daemon",
            python_executable="/usr/bin/python3",
            classifier_dir=str(tmp_path / "classifier"),
            model_dir=str(tmp_path / "model"),
            classifier_joblib_sha256="a" * 64,
            classifier_meta_sha256="b" * 64,
            log_path=str(tmp_path / "log.txt"),
            sock_path="/tmp/nanomind-guard.sock",
        )
        plist_bytes = launchd.render_plist(spec)
        body = plistlib.loads(plist_bytes)
        assert body["Label"] == "org.opena2a.nanomind-analyst"
        assert body["ProgramArguments"][0] == "/usr/bin/python3"
        assert body["ProgramArguments"][1:] == [
            "-m",
            "nanomind_analyst.daemon.nanomind_guard_daemon",
        ]
        assert body["RunAtLoad"] is True
        # KeepAlive on crash, not on clean exit.
        assert body["KeepAlive"]["SuccessfulExit"] is False
        assert body["KeepAlive"]["Crashed"] is True
        env = body["EnvironmentVariables"]
        assert env["NANOMIND_GUARD_SOCK"] == "/tmp/nanomind-guard.sock"
        assert env["INPUT_CLASSIFIER_JOBLIB_SHA256"] == "a" * 64
        assert env["INPUT_CLASSIFIER_META_SHA256"] == "b" * 64
        assert env["PYTHONUNBUFFERED"] == "1"
        # ProcessType=Interactive so launchd doesn't throttle mid-generation.
        assert body["ProcessType"] == "Interactive"

    def test_write_plist_round_trips_to_disk(self, tmp_path, monkeypatch):
        target = tmp_path / "LaunchAgents" / "org.opena2a.nanomind-analyst.plist"
        spec = launchd.PlistSpec(
            label="org.opena2a.nanomind-analyst",
            program="nanomind-analyst-daemon",
            python_executable="/usr/bin/python3",
            classifier_dir="/tmp/classifier",
            model_dir="/tmp/model",
            classifier_joblib_sha256="c" * 64,
            classifier_meta_sha256="d" * 64,
            log_path="/tmp/log.txt",
            sock_path="/tmp/sock",
        )
        written = launchd.write_plist(spec, target=target)
        assert written == target
        assert target.exists()
        body = plistlib.loads(target.read_bytes())
        assert body["EnvironmentVariables"]["INPUT_CLASSIFIER_JOBLIB_SHA256"] == "c" * 64


class TestLaunchctlBootstrap:
    def test_bootstrap_success(self, monkeypatch, tmp_path):
        called = []

        class FakeResult:
            def __init__(self):
                self.returncode = 0
                self.stdout = ""
                self.stderr = ""

        def fake_run(args, **kw):
            called.append(args)
            return FakeResult()

        monkeypatch.setattr("subprocess.run", fake_run)
        launchd.bootstrap(tmp_path / "plist")
        assert called == [
            ["/bin/launchctl", "bootstrap", f"gui/{paths.uid()}", str(tmp_path / "plist")]
        ]

    def test_bootstrap_already_loaded_is_ok(self, monkeypatch, tmp_path):
        """rc=17 (EEXIST) means already loaded; treat as success."""

        class FakeResult:
            returncode = 17
            stdout = ""
            stderr = "service already loaded"

        monkeypatch.setattr("subprocess.run", lambda *a, **kw: FakeResult())
        launchd.bootstrap(tmp_path / "plist")  # does not raise

    def test_bootstrap_other_failure_raises_with_context(
        self, monkeypatch, tmp_path
    ):
        class FakeResult:
            returncode = 5
            stdout = ""
            stderr = "Path had bad ownership"

        monkeypatch.setattr("subprocess.run", lambda *a, **kw: FakeResult())
        with pytest.raises(launchd.LaunchctlError) as exc:
            launchd.bootstrap(tmp_path / "plist")
        assert "Path had bad ownership" in str(exc.value)

    def test_bootout_missing_service_is_ok(self, monkeypatch):
        class FakeResult:
            returncode = 3
            stdout = ""
            stderr = "Could not find specified service"

        monkeypatch.setattr("subprocess.run", lambda *a, **kw: FakeResult())
        launchd.bootout()  # does not raise


class TestInstallFlow:
    def test_install_writes_plist_and_bootstraps(
        self, tmp_path, monkeypatch
    ):
        """End-to-end install with a fake HF downloader, redirected paths,
        and a stubbed launchctl. Verifies the plist lands on disk and the
        launchctl bootstrap call carries the expected args."""

        # Redirect filesystem layout.
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(paths, "home", lambda: fake_home)

        # Force Apple Silicon.
        monkeypatch.setattr("platform.system", lambda: "Darwin")
        monkeypatch.setattr("platform.machine", lambda: "arm64")

        # Stub the HF downloader to produce files with the right SHAs.
        safetensors = b"weights" * 1024
        tokenizer = b"tok" * 1024
        import hashlib

        monkeypatch.setattr(
            artifacts,
            "EXPECTED_NLM_SAFETENSORS_SHA256",
            hashlib.sha256(safetensors).hexdigest(),
        )
        monkeypatch.setattr(
            artifacts,
            "EXPECTED_NLM_TOKENIZER_SHA256",
            hashlib.sha256(tokenizer).hexdigest(),
        )

        def fake_downloader(*, repo_id, revision, local_dir, allow_patterns):
            target = Path(local_dir)
            target.mkdir(parents=True, exist_ok=True)
            (target / "model.safetensors").write_bytes(safetensors)
            (target / "tokenizer.json").write_bytes(tokenizer)
            for f in artifacts.NLM_REQUIRED_FILES:
                if not (target / f).exists():
                    (target / f).write_bytes(b"{}")
            return str(target)

        monkeypatch.setattr(
            "huggingface_hub.snapshot_download", fake_downloader
        )

        # Stub launchctl.
        launchctl_calls: list[list[str]] = []

        class FakeResult:
            def __init__(self, rc=0, stderr=""):
                self.returncode = rc
                self.stdout = ""
                self.stderr = stderr

        def fake_run(args, **kw):
            launchctl_calls.append(args)
            return FakeResult()

        monkeypatch.setattr("subprocess.run", fake_run)

        exit_code = install.run_install(skip_healthz_wait=True)
        assert exit_code == 0

        # Plist landed at the expected path.
        plist = fake_home / "Library" / "LaunchAgents" / f"{paths.LABEL}.plist"
        assert plist.exists()

        # launchctl bootstrap was called.
        bootstrap_call = next(
            c for c in launchctl_calls if "bootstrap" in c
        )
        assert "bootstrap" in bootstrap_call
        assert str(plist) in bootstrap_call

        # Classifier was copied with correct SHAs.
        clf = fake_home / "Library" / "Application Support" / "nanomind-analyst" / "artifacts" / "input-classifier-v1"
        assert (clf / "classifier.joblib").exists()
        assert (clf / "meta.json").exists()

    def test_install_refuses_unsupported_platform(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Linux")
        monkeypatch.setattr("platform.machine", lambda: "x86_64")
        with pytest.raises(install.InstallError):
            install.run_install(skip_healthz_wait=True)

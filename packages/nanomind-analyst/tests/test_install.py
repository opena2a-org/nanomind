"""Install-flow tests.

The install flow makes launchctl + filesystem changes. Tests stub launchctl,
redirect paths to a temp directory, and inject the artifact fetcher so no
network is required. Platform guard is exercised directly.
"""
from __future__ import annotations

import plistlib

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
        """End-to-end install with the artifact fetcher stubbed, redirected
        paths, and a stubbed launchctl. Verifies the plist lands on disk
        and the launchctl bootstrap call carries the expected args.

        We monkeypatch `artifacts.fetch_nlm` at the package level rather
        than `huggingface_hub.snapshot_download` directly. That keeps this
        test independent of huggingface_hub's import graph (httpx, tqdm,
        etc.) which can vary across environments — the HF interaction is
        already covered in test_artifacts.py with the injected downloader.
        """

        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(paths, "home", lambda: fake_home)

        monkeypatch.setattr("platform.system", lambda: "Darwin")
        monkeypatch.setattr("platform.machine", lambda: "arm64")

        fetch_calls = []

        def stub_fetch_nlm(*, target_dir, progress=None, hf_downloader=None):
            fetch_calls.append(target_dir)
            target_dir.mkdir(parents=True, exist_ok=True)
            for fname in artifacts.NLM_REQUIRED_FILES:
                (target_dir / fname).write_bytes(b"stub")

        monkeypatch.setattr(artifacts, "fetch_nlm", stub_fetch_nlm)

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

        assert len(fetch_calls) == 1
        assert fetch_calls[0] == paths.nlm_dir()

        plist = fake_home / "Library" / "LaunchAgents" / f"{paths.LABEL}.plist"
        assert plist.exists()

        bootstrap_call = next(c for c in launchctl_calls if "bootstrap" in c)
        assert "bootstrap" in bootstrap_call
        assert str(plist) in bootstrap_call

        clf = (
            fake_home
            / "Library"
            / "Application Support"
            / "nanomind-analyst"
            / "artifacts"
            / "input-classifier-v1"
        )
        assert (clf / "classifier.joblib").exists()
        assert (clf / "meta.json").exists()

    def test_install_refuses_unsupported_platform(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Linux")
        monkeypatch.setattr("platform.machine", lambda: "x86_64")
        with pytest.raises(install.InstallError):
            install.run_install(skip_healthz_wait=True)

    def test_install_calls_bootout_before_bootstrap(
        self, tmp_path, monkeypatch
    ):
        """Reinstalls/upgrades must reload the plist; bootstrap rc=17 must not
        silently leave the OLD plist in active state. Regression test for the
        bootout-then-bootstrap fix."""
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(paths, "home", lambda: fake_home)
        monkeypatch.setattr("platform.system", lambda: "Darwin")
        monkeypatch.setattr("platform.machine", lambda: "arm64")
        monkeypatch.setattr(
            artifacts,
            "fetch_nlm",
            lambda *, target_dir, progress=None, hf_downloader=None: target_dir.mkdir(
                parents=True, exist_ok=True
            )
            or [
                (target_dir / f).write_bytes(b"x") for f in artifacts.NLM_REQUIRED_FILES
            ],
        )

        call_order: list[str] = []

        def fake_run(args, **kw):
            class R:
                returncode = 0
                stdout = ""
                stderr = ""

            if "bootout" in args:
                call_order.append("bootout")
            elif "bootstrap" in args:
                call_order.append("bootstrap")
            return R()

        monkeypatch.setattr("subprocess.run", fake_run)
        install.run_install(skip_healthz_wait=True)

        # bootout must precede bootstrap; otherwise upgrades silently keep
        # the previously-loaded plist with stale env vars.
        bootout_idx = call_order.index("bootout")
        bootstrap_idx = call_order.index("bootstrap")
        assert bootout_idx < bootstrap_idx

    def test_install_boots_out_before_mutating_artifact_and_plist(
        self, tmp_path, monkeypatch
    ):
        """The daemon must be unloaded BEFORE the classifier copy and plist
        write, so an interrupt inside that mutation window cannot crash-loop
        a running daemon against mismatched SHA pins."""
        monkeypatch.setattr("platform.system", lambda: "Darwin")
        monkeypatch.setattr("platform.machine", lambda: "arm64")
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(paths, "home", lambda: fake_home)

        order: list[str] = []
        monkeypatch.setattr(
            artifacts,
            "fetch_nlm",
            lambda *, target_dir, progress=None, hf_downloader=None: order.append(
                "fetch_nlm"
            ),
        )
        monkeypatch.setattr(
            artifacts,
            "install_classifier",
            lambda *, source_dir, target_dir, progress=None: order.append(
                "install_classifier"
            ),
        )
        fake_plist = tmp_path / "fake.plist"

        def fake_write_plist(spec, *, target=None):
            order.append("write_plist")
            return fake_plist

        monkeypatch.setattr(launchd, "write_plist", fake_write_plist)
        monkeypatch.setattr(launchd, "bootout", lambda: order.append("bootout"))
        monkeypatch.setattr(
            launchd, "bootstrap", lambda plist: order.append("bootstrap")
        )

        rc = install.run_install(skip_healthz_wait=True)
        assert rc == 0
        assert order == [
            "fetch_nlm",
            "bootout",
            "install_classifier",
            "write_plist",
            "bootstrap",
        ]

    def test_install_leaves_no_temp_files(self, tmp_path, monkeypatch):
        """Atomic temp+os.replace writes must not strand .tmp files."""
        fake_home = tmp_path / "home"
        fake_home.mkdir()
        monkeypatch.setattr(paths, "home", lambda: fake_home)
        monkeypatch.setattr("platform.system", lambda: "Darwin")
        monkeypatch.setattr("platform.machine", lambda: "arm64")
        monkeypatch.setattr(
            artifacts,
            "fetch_nlm",
            lambda *, target_dir, progress=None, hf_downloader=None: target_dir.mkdir(
                parents=True, exist_ok=True
            )
            or [
                (target_dir / f).write_bytes(b"x")
                for f in artifacts.NLM_REQUIRED_FILES
            ],
        )

        class R:
            returncode = 0
            stdout = ""
            stderr = ""

        monkeypatch.setattr("subprocess.run", lambda *a, **kw: R())
        rc = install.run_install(skip_healthz_wait=True)
        assert rc == 0
        leftovers = list(fake_home.rglob("*.tmp"))
        assert leftovers == []


class TestHealthzProbeSocketGuard:
    """The installer's healthz probe must refuse attacker-bound sockets.

    /tmp on macOS is sticky-bit; a different local user can create
    /tmp/nanomind-guard.sock before our daemon binds. Connecting and trusting
    the response would let that attacker impersonate the daemon.
    """

    def test_refuses_symlink(self, tmp_path, monkeypatch):
        target = tmp_path / "target"
        target.write_bytes(b"")
        link = tmp_path / "link"
        link.symlink_to(target)
        with pytest.raises(install.InstallError) as exc:
            install._assert_socket_owned_by_user(str(link))
        assert "symlink" in str(exc.value)

    def test_refuses_foreign_uid(self, tmp_path, monkeypatch):
        sock_path = tmp_path / "foreign.sock"
        sock_path.write_bytes(b"")

        import os as _os
        real_getuid = _os.getuid

        class FakeStat:
            st_mode = 0o140700  # S_IFSOCK | rwx------
            st_uid = real_getuid() + 1  # someone else

        monkeypatch.setattr(install.os, "lstat", lambda p: FakeStat())
        with pytest.raises(install.InstallError) as exc:
            install._assert_socket_owned_by_user(str(sock_path))
        assert "owned by uid" in str(exc.value)

    def test_accepts_own_socket(self, tmp_path, monkeypatch):
        sock_path = tmp_path / "mine.sock"
        sock_path.write_bytes(b"")
        # Real lstat works since we own tmp_path. Should not raise.
        install._assert_socket_owned_by_user(str(sock_path))

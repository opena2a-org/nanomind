"""`nanomind-analyst-daemon` console-script entrypoint hygiene tests.

Regression tests for the v0.1.1 P1s surfaced by the release-test fresh-user
walkthrough: the entrypoint emitted a `FATAL: INPUT_CLASSIFIER_JOBLIB_SHA256
... second RCE path ...` message with exit code 0 when invoked directly by a
user, swallowed `--help` / `-h` / `--version`, and leaked internal hardening
language into user-visible output. Launchd is the only legitimate invoker.
"""
from __future__ import annotations

import pytest

from nanomind_analyst.daemon import guarded_daemon_main


@pytest.fixture
def darwin_arm64(monkeypatch):
    """Pretend we are on the only supported platform."""
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")


@pytest.fixture
def no_launchd_env(monkeypatch):
    """Ensure the launchd-set SHA256 env vars are NOT present."""
    monkeypatch.delenv("INPUT_CLASSIFIER_JOBLIB_SHA256", raising=False)
    monkeypatch.delenv("INPUT_CLASSIFIER_META_SHA256", raising=False)


class TestHelpAndVersionFlags:
    @pytest.mark.parametrize("flag", ["--help", "-h"])
    def test_help_flag_exits_zero(self, monkeypatch, capsys, flag):
        monkeypatch.setattr("sys.argv", ["nanomind-analyst-daemon", flag])
        rc = guarded_daemon_main()
        assert rc == 0
        out = capsys.readouterr().out
        assert "do not run it directly" in out.lower() or "do not\nrun it directly" in out.lower()
        assert "nanomind-analyst install" in out

    @pytest.mark.parametrize("flag", ["--version", "-V"])
    def test_version_flag_exits_zero_and_prints_version(
        self, monkeypatch, capsys, flag
    ):
        monkeypatch.setattr("sys.argv", ["nanomind-analyst-daemon", flag])
        rc = guarded_daemon_main()
        assert rc == 0
        out = capsys.readouterr().out
        assert out.startswith("nanomind-analyst-daemon ")


class TestDirectInvocationOnSupportedPlatform:
    def test_missing_env_vars_exits_nonzero(
        self, monkeypatch, capsys, darwin_arm64, no_launchd_env
    ):
        """Regression: previously exited 0 on FATAL; `set -e` orchestrators
        could not detect a failed daemon launch."""
        monkeypatch.setattr("sys.argv", ["nanomind-analyst-daemon"])
        rc = guarded_daemon_main()
        assert rc != 0, "direct invocation without launchd env must exit non-zero"

    def test_missing_env_vars_message_is_user_facing(
        self, monkeypatch, capsys, darwin_arm64, no_launchd_env
    ):
        monkeypatch.setattr("sys.argv", ["nanomind-analyst-daemon"])
        guarded_daemon_main()
        err = capsys.readouterr().err
        # Tell the user what to do instead.
        assert "nanomind-analyst install" in err
        assert "nanomind-analyst start" in err

    def test_no_internal_hardening_language_leaks(
        self, monkeypatch, capsys, darwin_arm64, no_launchd_env
    ):
        """Regression: prior FATAL message contained 'second RCE path' and
        'mode 0444 root-owned'. Those are deployment-runbook concerns and
        must never appear in user-visible CLI output, both because they are
        unactionable for the user AND because an external observer (CVE
        filer, security blog) reads them as evidence of an unpatched RCE."""
        monkeypatch.setattr("sys.argv", ["nanomind-analyst-daemon"])
        guarded_daemon_main()
        combined = capsys.readouterr()
        bad_phrases = [
            "rce",
            "0444",
            "root-owned",
            "deployment image",
            "baked into",
            "INPUT_CLASSIFIER_JOBLIB_SHA256",
            "INPUT_CLASSIFIER_META_SHA256",
        ]
        for phrase in bad_phrases:
            assert phrase.lower() not in combined.out.lower()
            assert phrase.lower() not in combined.err.lower(), (
                f"internal hardening phrase {phrase!r} must not appear in "
                f"user-visible output"
            )


class TestUnsupportedPlatformPath:
    def test_linux_intel_refused_with_exit_2(self, monkeypatch, capsys):
        """The 0.1.0 platform-guard behavior is preserved: a Linux/Intel user
        who pip-installs the wheel and runs the daemon binary gets a clear
        platform refusal with exit 2 (not 1, not 0)."""
        monkeypatch.setattr("platform.system", lambda: "Linux")
        monkeypatch.setattr("platform.machine", lambda: "x86_64")
        monkeypatch.setattr("sys.argv", ["nanomind-analyst-daemon"])
        rc = guarded_daemon_main()
        assert rc == 2
        err = capsys.readouterr().err
        assert "Darwin arm64" in err or "platform" in err.lower()

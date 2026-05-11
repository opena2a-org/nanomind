"""CLI argparse smoke tests.

Subcommands are routed through cli.main; tests stub out the install/lifecycle
calls so we exercise the parser, not the orchestration. Orchestration is
covered in test_install.py + test_lifecycle.py.
"""
from __future__ import annotations

import pytest

from nanomind_analyst import cli


class TestParser:
    def test_version_flag_exits_zero(self, capsys):
        with pytest.raises(SystemExit) as exc:
            cli.main(["--version"])
        assert exc.value.code == 0
        captured = capsys.readouterr()
        assert "nanomind-analyst" in captured.out

    def test_no_args_prints_help_and_exits_nonzero(self, capsys):
        with pytest.raises(SystemExit) as exc:
            cli.main([])
        assert exc.value.code == 2  # argparse "required argument missing"

    def test_install_subcommand_routes(self, monkeypatch):
        called = {}
        monkeypatch.setattr(
            cli.install,
            "run_install",
            lambda *, skip_healthz_wait=False: called.setdefault(
                "skip_healthz_wait", skip_healthz_wait
            )
            or 0,
        )
        rc = cli.main(["install"])
        assert rc == 0
        assert called["skip_healthz_wait"] is False

    def test_install_skip_healthz_passes_flag(self, monkeypatch):
        called = {}
        monkeypatch.setattr(
            cli.install,
            "run_install",
            lambda *, skip_healthz_wait=False: called.setdefault(
                "skip_healthz_wait", skip_healthz_wait
            )
            or 0,
        )
        cli.main(["install", "--skip-healthz-wait"])
        assert called["skip_healthz_wait"] is True

    def test_uninstall_remove_artifacts_flag(self, monkeypatch):
        called = {}
        monkeypatch.setattr(
            cli.install,
            "run_uninstall",
            lambda *, remove_artifacts=False: called.setdefault(
                "remove_artifacts", remove_artifacts
            )
            or 0,
        )
        cli.main(["uninstall", "--remove-artifacts"])
        assert called["remove_artifacts"] is True

    def test_status_routes(self, monkeypatch):
        monkeypatch.setattr(cli.lifecycle, "run_status", lambda: 0)
        assert cli.main(["status"]) == 0

    def test_start_stop_restart_route(self, monkeypatch):
        for cmd, fn_name in [("start", "run_start"), ("stop", "run_stop"), ("restart", "run_restart")]:
            monkeypatch.setattr(cli.lifecycle, fn_name, lambda: 0)
            assert cli.main([cmd]) == 0

    def test_logs_no_follow_flag(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(
            cli.lifecycle,
            "run_logs",
            lambda *, follow=True: seen.setdefault("follow", follow) or 0,
        )
        cli.main(["logs", "--no-follow"])
        assert seen["follow"] is False

    def test_install_error_returns_2_not_1(self, monkeypatch, capsys):
        def fake_install(*, skip_healthz_wait=False):
            raise cli.install.InstallError("unsupported platform foo/bar")

        monkeypatch.setattr(cli.install, "run_install", fake_install)
        rc = cli.main(["install"])
        assert rc == 2
        err = capsys.readouterr().err
        assert "unsupported platform" in err

    def test_unexpected_exception_returns_1(self, monkeypatch, capsys):
        def fake_install(*, skip_healthz_wait=False):
            raise RuntimeError("boom")

        monkeypatch.setattr(cli.install, "run_install", fake_install)
        rc = cli.main(["install"])
        assert rc == 1
        err = capsys.readouterr().err
        assert "RuntimeError" in err
        assert "boom" in err

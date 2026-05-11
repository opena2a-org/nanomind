"""Command-line entrypoint for `nanomind-analyst`.

Subcommands:
  install      Fetch artifacts, write the plist, bootstrap the daemon, wait for healthz.
  uninstall    Stop and unload the daemon. Removes the plist; keeps artifacts by default.
  start        Kickstart the loaded LaunchAgent.
  stop         Send the daemon SIGTERM. The agent stays loaded.
  restart      Stop then start.
  status       Report whether the agent is loaded and healthz returns ready.
  logs         Tail the launchd-managed log file.
  version      Print the package version.
"""
from __future__ import annotations

import argparse
import sys

from . import __version__, install, lifecycle


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nanomind-analyst",
        description=(
            "Installer for the NanoMind Analyst daemon (Qwen3-1.7B security "
            "analyst NLM behind an input-classifier gate). Apple Silicon only "
            "in v0.1."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"nanomind-analyst {__version__}",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    p_install = subparsers.add_parser(
        "install",
        help="Fetch artifacts, write the plist, bootstrap the daemon, wait for healthz.",
    )
    p_install.add_argument(
        "--skip-healthz-wait",
        action="store_true",
        help="Skip the post-bootstrap healthz probe (CI / scripting use).",
    )

    p_uninstall = subparsers.add_parser(
        "uninstall",
        help="Stop and unload the daemon. Removes the plist; keeps artifacts by default.",
    )
    p_uninstall.add_argument(
        "--remove-artifacts",
        action="store_true",
        help="Also delete the ~3.4 GB NLM weights from Application Support.",
    )

    subparsers.add_parser(
        "start", help="Kickstart the loaded LaunchAgent."
    )
    subparsers.add_parser(
        "stop",
        help="Send the daemon SIGTERM. The agent stays loaded.",
    )
    subparsers.add_parser("restart", help="Stop then start.")
    subparsers.add_parser(
        "status",
        help="Report whether the agent is loaded and healthz returns ready.",
    )
    p_logs = subparsers.add_parser(
        "logs", help="Tail the launchd-managed log file."
    )
    p_logs.add_argument(
        "--no-follow",
        action="store_true",
        help="Print the last 200 lines and exit instead of tailing.",
    )
    subparsers.add_parser("version", help="Print the package version.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "install":
            return install.run_install(
                skip_healthz_wait=args.skip_healthz_wait
            )
        if args.command == "uninstall":
            return install.run_uninstall(
                remove_artifacts=args.remove_artifacts
            )
        if args.command == "start":
            return lifecycle.run_start()
        if args.command == "stop":
            return lifecycle.run_stop()
        if args.command == "restart":
            return lifecycle.run_restart()
        if args.command == "status":
            return lifecycle.run_status()
        if args.command == "logs":
            return lifecycle.run_logs(follow=not args.no_follow)
        if args.command == "version":
            print(f"nanomind-analyst {__version__}")
            return 0
    except install.InstallError as exc:
        sys.stderr.write(f"install error: {exc}\n")
        return 2
    except Exception as exc:  # noqa: BLE001 — top-level handler
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        return 1

    parser.print_help(sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

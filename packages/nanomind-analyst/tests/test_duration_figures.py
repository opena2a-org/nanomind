"""Every duration the package states is a value the code runs with.

How long the daemon takes to boot or to answer depends on the machine, so the
package states no such time: `install` and the daemon report what they
measured. The durations it does state are configured: how long `install` waits
for a started daemon to pass healthz, how long an on-demand daemon stays up
with no request, and how long one `status` probe waits. A figure that is none
of these reads as a measurement that nothing in the package records. This test
censuses every duration figure in the README, the changelog and the package
source, including one wrapped across two lines, and holds each to one of those
configured values. A duration with no number ("a few" seconds, "several"
minutes) makes the same claim with less to check, so the census refuses those
outright.
"""
from __future__ import annotations

import inspect
import re
from pathlib import Path

from nanomind_analyst import install, lifecycle
from nanomind_analyst.daemon.nanomind_guard_daemon import DEFAULT_IDLE_EXIT_SEC

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
CENSUS = (
    PACKAGE_ROOT / "README.md",
    PACKAGE_ROOT / "CHANGELOG.md",
    *sorted((PACKAGE_ROOT / "src" / "nanomind_analyst").rglob("*.py")),
)

DURATION = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)(?:\s+|-)?"
    r"(ms|milliseconds?|s|secs?|seconds?|mins?|minutes?|hours?)\b",
    re.IGNORECASE,
)

# A quantity word in place of a number: how long something takes, stated so
# that no reader can check it. "that many seconds" refers to a configured
# value and is not one.
UNNUMBERED_DURATION = re.compile(
    r"\b(?:several|(?:a\s+)?few|(?:a\s+)?couple\s+of|tens\s+of|hundreds\s+of|"
    r"(?<!that\s)many|multi-?|first)\s*"
    r"(?:ms|milliseconds?|secs?|seconds?|mins?|minutes?|hours?)\b",
    re.IGNORECASE,
)


def _seconds(amount: str, unit: str) -> float:
    unit = unit.lower()
    if unit == "ms" or unit.startswith("milli"):
        scale = 0.001
    elif unit.startswith("min"):
        scale = 60
    elif unit.startswith("hour"):
        scale = 3600
    else:
        scale = 1
    return float(amount.replace(",", "")) * scale


def _default(function, parameter: str) -> float:
    return inspect.signature(function).parameters[parameter].default


def test_every_duration_figure_is_a_configured_value():
    configured = {
        install.HEALTHZ_WAIT_SEC,
        DEFAULT_IDLE_EXIT_SEC,
        _default(lifecycle._healthz, "timeout_sec"),
    }
    unsourced = []
    for path in CENSUS:
        text = path.read_text(encoding="utf-8")
        for match in DURATION.finditer(text):
            if _seconds(*match.groups()) in configured:
                continue
            lineno = text.count("\n", 0, match.start()) + 1
            where = path.relative_to(PACKAGE_ROOT)
            unsourced.append(f"{where}:{lineno}: {match.group(0)!r}")
    assert unsourced == []


def test_no_duration_is_stated_without_a_number():
    unnumbered = []
    for path in CENSUS:
        text = path.read_text(encoding="utf-8")
        for match in UNNUMBERED_DURATION.finditer(text):
            lineno = text.count("\n", 0, match.start()) + 1
            where = path.relative_to(PACKAGE_ROOT)
            unnumbered.append(f"{where}:{lineno}: {match.group(0)!r}")
    assert unnumbered == []


def test_the_healthz_probe_waits_the_configured_window_by_default():
    assert _default(install._healthz_probe, "timeout_sec") == install.HEALTHZ_WAIT_SEC

"""The README lists the install steps in the order `install` runs them.

`nanomind-analyst install` verifies the classifier bundled in the wheel
before the NLM fetch and copies it into place after the fetch. A README list
that puts the copy ahead of the fetch tells a reader that an interrupted
fetch has already replaced the installed classifier, which it has not. This
test runs the install flow with each documented step stubbed, records the
order the steps run in, and holds the numbered list under "The install
step:" to that order.
"""
from __future__ import annotations

import re
from pathlib import Path

from nanomind_analyst import artifacts, install, launchd, paths

README = Path(__file__).resolve().parent.parent / "README.md"

# How each README step opens, keyed by the install step it describes.
STEP_OPENINGS = {
    "platform": "Verifies platform",
    "verify-classifier": "Verifies the input-classifier-v1 artifacts",
    "fetch-nlm": "Fetches the Analyst NLM",
    "copy-classifier": "Copies the input-classifier-v1 artifacts",
    "write-plist": "Writes a launchd plist",
    "bootstrap": "Bootstraps the LaunchAgent",
    "start-and-wait": "Starts the daemon once",
}


def _readme_steps() -> list[str]:
    text = README.read_text(encoding="utf-8")
    _, found, after = text.partition("The install step:\n")
    assert found, "README has no 'The install step:' list"
    block = after.lstrip("\n").split("\n\n", 1)[0]
    steps = []
    for item in re.findall(r"^\d+\.\s+(.*)$", block, re.MULTILINE):
        names = [
            name
            for name, opening in STEP_OPENINGS.items()
            if item.startswith(opening)
        ]
        # An item that names no known step stays as its text, so the
        # assertion below shows it.
        steps.append(names[0] if len(names) == 1 else item)
    return steps


def _run_order(tmp_path, monkeypatch) -> list[str]:
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(paths, "home", lambda: fake_home)

    order: list[str] = []

    def record(name):
        def step(*args, **kwargs):
            order.append(name)

        return step

    def write_plist(spec, *, target=None):
        order.append("write-plist")
        return tmp_path / "fake.plist"

    def healthz_probe(**kwargs):
        order.append("start-and-wait")
        return True

    monkeypatch.setattr(
        install, "assert_supported_platform", record("platform")
    )
    monkeypatch.setattr(
        artifacts, "verify_wheel_classifier", record("verify-classifier")
    )
    monkeypatch.setattr(artifacts, "fetch_nlm", record("fetch-nlm"))
    monkeypatch.setattr(
        artifacts, "install_classifier", record("copy-classifier")
    )
    monkeypatch.setattr(launchd, "bootout", lambda: None)
    monkeypatch.setattr(launchd, "write_plist", write_plist)
    monkeypatch.setattr(launchd, "bootstrap", record("bootstrap"))
    monkeypatch.setattr(launchd, "kickstart", record("start-and-wait"))
    monkeypatch.setattr(install, "_healthz_probe", healthz_probe)

    assert install.run_install() == 0
    # The README states starting the daemon and waiting for healthz as one
    # step, so consecutive records of the same step collapse into one.
    return [n for i, n in enumerate(order) if i == 0 or order[i - 1] != n]


def test_readme_lists_install_steps_in_run_order(tmp_path, monkeypatch):
    assert _readme_steps() == _run_order(tmp_path, monkeypatch)

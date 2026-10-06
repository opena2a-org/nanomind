"""The package catches built-in TimeoutError, not the socket.timeout alias.

socket.timeout has been an alias of TimeoutError since Python 3.10 and the
package requires 3.11, so the alias only hides which exception is caught.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SOURCES = sorted(
    p
    for d in ("src", "tests")
    for p in (PACKAGE_ROOT / d).rglob("*.py")
)


def _socket_timeout_lines(path: Path) -> list[int]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
        and node.attr == "timeout"
        and isinstance(node.value, ast.Name)
        and node.value.id == "socket"
    ]


def test_sources_found():
    assert any(p.name == "install.py" for p in SOURCES)


@pytest.mark.parametrize(
    "path", SOURCES, ids=lambda p: str(p.relative_to(PACKAGE_ROOT))
)
def test_no_socket_timeout_alias(path):
    assert _socket_timeout_lines(path) == [], (
        f"{path.relative_to(PACKAGE_ROOT)} uses socket.timeout; "
        f"catch TimeoutError instead"
    )

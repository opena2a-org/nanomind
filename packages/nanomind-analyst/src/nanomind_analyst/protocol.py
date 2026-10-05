"""Version of the guard daemon's socket protocol.

The daemon answers one JSON object per line on its Unix socket. Version 1 is
the `classify` and `healthz` op set as it was served before the daemon stated
a version, so a `healthz` reply without `protocolVersion` is a version-1
reply. The daemon states the version in its `healthz` reply only.

Readers accept the versions they know and degrade on anything else: a reply
that announces an unrecognised version is never reported as ready.
"""
from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = 1
# A healthz reply that predates the field speaks this version.
PRE_VERSIONED_PROTOCOL_VERSION = 1
SUPPORTED_PROTOCOL_VERSIONS = frozenset({1})


def reply_protocol_version(reply: Any) -> int | None:
    """Return the protocol version a healthz reply speaks.

    A reply without `protocolVersion` is version 1. Returns None when this
    reader does not recognise the version, including a non-integer value.
    """
    if not isinstance(reply, dict):
        return None
    if "protocolVersion" not in reply:
        return PRE_VERSIONED_PROTOCOL_VERSION
    value = reply["protocolVersion"]
    # bool is an int subclass: JSON `true` must not read as version 1.
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value in SUPPORTED_PROTOCOL_VERSIONS else None


def healthz_is_ready(reply: Any) -> bool:
    """True only for a ready reply in a protocol version this reader knows."""
    return (
        reply_protocol_version(reply) is not None
        and reply.get("daemonState") == "ready"
    )

"""NanoMind-Guard serving daemon (Phase 2b).

A long-lived process that loads the input-classifier gate + NanoMind v3.0.0-beta
NLM and serves classification requests over a Unix socket using JSON-Lines.

Per request:
    1. Run the gate (rule-based pre-filter -> sentence-transformer + LR head).
    2. If `bypass_nlm` is True: return the constant off-topic response.
    3. Else: invoke the NLM (bf16 on MPS) and return its structured output.

Fail-CLOSED on classifier exception: route to the NLM. Bypassing on classifier
failure would silently emit `none` -- the exact failure mode this gate exists
to prevent.

Boot order:
    1. Resolve config (env vars, paths).
    2. Verify SHA256 of classifier.joblib + meta.json against expected hashes
       BEFORE joblib.load() runs (joblib uses pickle = arbitrary code execution
       at deserialization).
    3. Construct InputClassifier (downloads embedder if cache cold).
    4. Construct NanoMindNLM (loads ~3.4 GB bf16 weights).
    5. Run gate probe ("# README\n\nProject Setup" -> off-topic). Refuse to
       bind on probe failure.
    6. Bind socket, accept connections serially.

See briefs/nanomind-guard-daemon.md for the wire protocol and decisions.
"""
from __future__ import annotations

import contextlib
import dataclasses
import datetime as _dt
import hashlib
import json
import logging
import os
import re
import secrets
import signal
import socket
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable

from ._nlm import nlm_output_to_response
from .input_classifier.predictor import InputClassifier


def _default_app_support_dir() -> Path:
    """Resolve `~/Library/Application Support/nanomind-analyst/artifacts/`.

    Matches the path the installer wrote artifacts into. Overridable via
    NANOMIND_GUARD_MODEL_DIR / NANOMIND_GUARD_CLASSIFIER_DIR in Config.
    """
    return (
        Path.home()
        / "Library"
        / "Application Support"
        / "nanomind-analyst"
        / "artifacts"
    )


DEFAULT_SOCK_PATH = "/tmp/nanomind-guard.sock"
DEFAULT_MODEL_DIR = str(_default_app_support_dir() / "nanomind-security-analyst")
DEFAULT_CLASSIFIER_DIR = str(_default_app_support_dir() / "input-classifier-v1")
DEFAULT_MAX_BYTES = 1 * 1024 * 1024  # 1 MB
DEFAULT_WARN_BYTES = 100 * 1024  # 100 KB
DEFAULT_MAX_NEW_TOKENS = 512
HEALTHZ_PROBE_INPUT = "# README\n\nProject Setup"
HEALTHZ_EXPECTED_LABEL = "off-topic"
RECV_CHUNK = 64 * 1024  # 64 KB recv chunks; loop until we have a full line
ENVELOPE_OVERHEAD = 4096  # JSON wrapper around `text` field
DEFAULT_CONN_TIMEOUT_SEC = 5.0  # slowloris cutoff for accepted connections
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

log = logging.getLogger("nanomind_guard")


# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Config:
    sock_path: str
    model_dir: str
    classifier_dir: str
    classifier_joblib_sha256: str
    classifier_meta_sha256: str
    max_bytes: int
    warn_bytes: int
    max_new_tokens: int
    conn_timeout_sec: float
    device: str | None  # None -> NLM auto-detects

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        e = env if env is not None else os.environ
        joblib_sha = e.get("INPUT_CLASSIFIER_JOBLIB_SHA256", "").strip().lower()
        meta_sha = e.get("INPUT_CLASSIFIER_META_SHA256", "").strip().lower()
        if not joblib_sha or not meta_sha:
            # joblib.load() deserializes pickle. A daemon that loads an
            # unverified pickle is one filesystem misconfiguration away from
            # arbitrary code execution. Refuse to start rather than degrade
            # silently.
            raise ConfigError(
                "INPUT_CLASSIFIER_JOBLIB_SHA256 and INPUT_CLASSIFIER_META_SHA256 "
                "must be set. Compute with: shasum -a 256 "
                "<classifier_dir>/{classifier.joblib,meta.json}. The expected "
                "values should be baked into the deployment image. Also set "
                "the artifact dir to mode 0444 root-owned to close the second "
                "RCE path."
            )
        for name, value in (
            ("INPUT_CLASSIFIER_JOBLIB_SHA256", joblib_sha),
            ("INPUT_CLASSIFIER_META_SHA256", meta_sha),
        ):
            if not SHA256_HEX_RE.match(value):
                raise ConfigError(
                    f"{name} must be exactly 64 lowercase hex characters; "
                    f"got {len(value)} chars. Recompute with shasum -a 256."
                )
        return cls(
            sock_path=e.get("NANOMIND_GUARD_SOCK", DEFAULT_SOCK_PATH),
            model_dir=e.get("NANOMIND_GUARD_MODEL_DIR", DEFAULT_MODEL_DIR),
            classifier_dir=e.get(
                "NANOMIND_GUARD_CLASSIFIER_DIR", DEFAULT_CLASSIFIER_DIR
            ),
            classifier_joblib_sha256=joblib_sha,
            classifier_meta_sha256=meta_sha,
            max_bytes=int(e.get("NANOMIND_GUARD_MAX_BYTES", DEFAULT_MAX_BYTES)),
            warn_bytes=int(e.get("NANOMIND_GUARD_WARN_BYTES", DEFAULT_WARN_BYTES)),
            max_new_tokens=int(
                e.get("NANOMIND_GUARD_MAX_NEW_TOKENS", DEFAULT_MAX_NEW_TOKENS)
            ),
            conn_timeout_sec=float(
                e.get("NANOMIND_GUARD_CONN_TIMEOUT_SEC", DEFAULT_CONN_TIMEOUT_SEC)
            ),
            device=e.get("NANOMIND_GUARD_DEVICE") or None,
        )


class ConfigError(Exception):
    """Raised when the daemon cannot start due to invalid configuration."""


class IntegrityError(Exception):
    """Raised when an artifact SHA256 does not match the expected value."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_artifact_integrity(cfg: Config) -> None:
    """Check classifier.joblib + meta.json hashes BEFORE joblib.load runs."""
    artifact_dir = Path(cfg.classifier_dir)
    targets = (
        ("classifier.joblib", cfg.classifier_joblib_sha256),
        ("meta.json", cfg.classifier_meta_sha256),
    )
    for fname, expected in targets:
        path = artifact_dir / fname
        if not path.exists():
            raise IntegrityError(
                f"classifier artifact missing: {path}. "
                f"Set NANOMIND_GUARD_CLASSIFIER_DIR or restore the artifact."
            )
        actual = sha256_file(path)
        if actual != expected:
            raise IntegrityError(
                f"SHA256 mismatch on {path}: expected {expected}, got {actual}. "
                f"Refusing to load. The artifact may have been tampered with "
                f"or a stale image is deployed; verify the artifact and the "
                f"baked hash agree."
            )


# ----------------------------------------------------------------------------
# State
# ----------------------------------------------------------------------------


class DaemonState:
    """Holds the loaded gate + NLM and the request counter."""

    def __init__(
        self,
        *,
        classifier: InputClassifier,
        nlm: Any,  # NanoMindNLM-like (has .classify(text) -> NlmOutput)
        cfg: Config,
        boot_ts: float,
    ) -> None:
        self.classifier = classifier
        self.nlm = nlm
        self.cfg = cfg
        self.boot_ts = boot_ts
        self.requests_served = 0


# ----------------------------------------------------------------------------
# Telemetry
# ----------------------------------------------------------------------------


def _ts() -> str:
    return _dt.datetime.now(tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def emit_telemetry(line: dict[str, Any]) -> None:
    """Write one structured JSON-Lines record to stdout. One line per request."""
    line.setdefault("ts", _ts())
    sys.stdout.write(json.dumps(line, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def new_request_id() -> str:
    # 128-bit ids; collision-free at any realistic request volume.
    return secrets.token_hex(16)


# ----------------------------------------------------------------------------
# Request handling
# ----------------------------------------------------------------------------


def _bypass_response(
    pred, *, gate_latency_ms: float, threshold: float
) -> dict[str, Any]:
    return {
        "ok": True,
        "predictedAttackClass": "none",
        "confidence": None,
        "classification": "benign",
        "source": "input-classifier-gate",
        "gateLabel": pred.label,
        "gateReason": pred.reason,
        "gateProbaOffTopic": pred.proba_off_topic,
        "gateThreshold": threshold,
        "gateLatencyMs": round(gate_latency_ms, 3),
        "nlmInvoked": False,
        "nlmLatencyMs": None,
        "nlmTokenCount": None,
    }


def _nlm_response(
    nlm_out,
    *,
    pred,
    gate_latency_ms: float,
    threshold: float,
    source: str = "nlm",
    gate_label: str | None = None,
    gate_reason: str | None = None,
    gate_proba: float | None = None,
) -> dict[str, Any]:
    body = nlm_output_to_response(nlm_out)
    body["ok"] = True
    body["source"] = source
    body["gateLabel"] = gate_label if gate_label is not None else pred.label
    body["gateReason"] = gate_reason if gate_reason is not None else pred.reason
    body["gateProbaOffTopic"] = (
        gate_proba if pred is None else pred.proba_off_topic
    )
    body["gateThreshold"] = threshold
    body["gateLatencyMs"] = round(gate_latency_ms, 3)
    body["nlmInvoked"] = True
    return body


def handle_classify(
    state: DaemonState, text: str, *, request_id: str
) -> dict[str, Any]:
    """Per-request: gate, then NLM if not bypassed. Fail-CLOSED on gate error."""
    cfg = state.cfg
    text_bytes = len(text.encode("utf-8"))
    if text_bytes > cfg.max_bytes:
        emit_telemetry(
            {
                "event": "classify",
                "requestId": request_id,
                "ok": False,
                "error": "ERR_INPUT_TOO_LARGE",
                "textBytes": text_bytes,
            }
        )
        return _error("ERR_INPUT_TOO_LARGE", f"input is {text_bytes} bytes; max is {cfg.max_bytes}")
    if not text or not text.strip():
        emit_telemetry(
            {
                "event": "classify",
                "requestId": request_id,
                "ok": False,
                "error": "ERR_EMPTY_INPUT",
                "textBytes": text_bytes,
            }
        )
        return _error("ERR_EMPTY_INPUT", "text is empty or whitespace-only")
    if text_bytes > cfg.warn_bytes:
        log.warning(
            "large input: %d bytes (warn at %d)", text_bytes, cfg.warn_bytes
        )

    threshold = state.classifier.threshold
    t_total = time.perf_counter()

    # ---- Gate ----
    gate_exception: str | None = None
    pred = None
    t_gate = time.perf_counter()
    try:
        pred = state.classifier.predict_one(text)
    except Exception as exc:
        gate_exception = type(exc).__name__
        log.exception("input-classifier failure (request_id=%s)", request_id)
    gate_latency_ms = (time.perf_counter() - t_gate) * 1000.0

    # ---- Bypass path ----
    if pred is not None and pred.bypass_nlm:
        response = _bypass_response(
            pred, gate_latency_ms=gate_latency_ms, threshold=threshold
        )
        total_ms = (time.perf_counter() - t_total) * 1000.0
        emit_telemetry(
            {
                "event": "classify",
                "requestId": request_id,
                "ok": True,
                "textBytes": text_bytes,
                "gateLabel": pred.label,
                "gateReason": pred.reason,
                "gateProbaOffTopic": pred.proba_off_topic,
                "gateThreshold": threshold,
                "gateLatencyMs": round(gate_latency_ms, 3),
                "nlmInvoked": False,
                "nlmLatencyMs": None,
                "totalLatencyMs": round(total_ms, 3),
            }
        )
        return response

    # ---- NLM path (pass-through OR fail-CLOSED) ----
    try:
        nlm_out = state.nlm.classify(text)
    except Exception:
        # Last-resort: NLM itself failed. Surface as ERR_INTERNAL with a
        # request id; do NOT fall through to a bypass response. The caller
        # must see the failure rather than a silent benign verdict.
        log.exception("NLM classify() failed (request_id=%s)", request_id)
        emit_telemetry(
            {
                "event": "classify",
                "requestId": request_id,
                "ok": False,
                "error": "ERR_INTERNAL",
                "textBytes": text_bytes,
                "gateException": gate_exception,
                "gateLatencyMs": round(gate_latency_ms, 3),
                "nlmInvoked": True,
            }
        )
        return _error(
            "ERR_INTERNAL",
            f"nlm classification failed (requestId={request_id})",
        )

    if gate_exception is not None:
        # Fail-CLOSED: classifier raised, NLM ran. Mark the response so
        # operators can grep telemetry for these.
        response = _nlm_response(
            nlm_out,
            pred=None,
            gate_latency_ms=gate_latency_ms,
            threshold=threshold,
            source="nlm",
            gate_label="classifier-error",
            gate_reason="classifier-exception",
            gate_proba=None,
        )
    else:
        response = _nlm_response(
            nlm_out,
            pred=pred,
            gate_latency_ms=gate_latency_ms,
            threshold=threshold,
        )

    total_ms = (time.perf_counter() - t_total) * 1000.0
    telem: dict[str, Any] = {
        "event": "classify",
        "requestId": request_id,
        "ok": True,
        "textBytes": text_bytes,
        "gateLabel": response["gateLabel"],
        "gateReason": response["gateReason"],
        "gateProbaOffTopic": response["gateProbaOffTopic"],
        "gateThreshold": threshold,
        "gateLatencyMs": round(gate_latency_ms, 3),
        "nlmInvoked": True,
        "nlmLatencyMs": response.get("nlmLatencyMs"),
        "nlmTokenCount": response.get("nlmTokenCount"),
        "totalLatencyMs": round(total_ms, 3),
    }
    if gate_exception is not None:
        telem["gateException"] = gate_exception
    emit_telemetry(telem)
    return response


def handle_healthz(state: DaemonState) -> dict[str, Any]:
    """Probe the gate to catch 'embedder failed to load' early."""
    probe_pred = None
    probe_passed = False
    try:
        probe_pred = state.classifier.predict_one(HEALTHZ_PROBE_INPUT)
        probe_passed = probe_pred.label == HEALTHZ_EXPECTED_LABEL
    except Exception as exc:
        log.exception("healthz gate probe failed: %s", exc)

    return {
        "ok": probe_passed,
        "daemonState": "ready" if probe_passed else "degraded",
        "gateProbe": {
            "input": HEALTHZ_PROBE_INPUT,
            "label": probe_pred.label if probe_pred is not None else None,
            "expected": HEALTHZ_EXPECTED_LABEL,
            "passed": probe_passed,
        },
        "uptimeSec": round(time.time() - state.boot_ts, 3),
        "requestsServed": state.requests_served,
        "modelPath": state.cfg.model_dir,
        "classifierPath": state.cfg.classifier_dir,
        "classifierThreshold": state.classifier.threshold,
        "embedder": state.classifier.embedder_id,
    }


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": code, "message": message}


def dispatch(state: DaemonState, raw_line: bytes) -> dict[str, Any]:
    """Parse one request line and route to the right op handler."""
    request_id = new_request_id()
    try:
        payload = json.loads(raw_line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        emit_telemetry(
            {
                "event": "request",
                "requestId": request_id,
                "ok": False,
                "error": "ERR_BAD_REQUEST",
                "detail": str(exc)[:200],
            }
        )
        return _error("ERR_BAD_REQUEST", "request must be a single JSON object")

    if not isinstance(payload, dict):
        emit_telemetry(
            {
                "event": "request",
                "requestId": request_id,
                "ok": False,
                "error": "ERR_BAD_REQUEST",
                "detail": "payload is not an object",
            }
        )
        return _error("ERR_BAD_REQUEST", "request must be a JSON object")

    op = payload.get("op", "classify")
    if op == "healthz":
        response = handle_healthz(state)
        return response

    if op != "classify":
        emit_telemetry(
            {
                "event": "request",
                "requestId": request_id,
                "ok": False,
                "error": "ERR_UNKNOWN_OP",
                "op": str(op)[:64],
            }
        )
        return _error("ERR_UNKNOWN_OP", f"unknown op: {op!r}")

    text = payload.get("text")
    if not isinstance(text, str):
        emit_telemetry(
            {
                "event": "request",
                "requestId": request_id,
                "ok": False,
                "error": "ERR_BAD_REQUEST",
                "detail": "missing or non-string `text`",
            }
        )
        return _error("ERR_BAD_REQUEST", "request must include string field `text`")

    state.requests_served += 1
    return handle_classify(state, text, request_id=request_id)


# ----------------------------------------------------------------------------
# Socket server
# ----------------------------------------------------------------------------


def _read_one_line(conn: socket.socket, *, hard_cap: int) -> bytes | None:
    """Read until a newline OR connection close. Bounded by `hard_cap` bytes.

    Returns the line WITHOUT the terminating newline. Returns None if the
    peer closed without sending data. Raises ValueError if `hard_cap` is
    exceeded before a newline arrives.
    """
    buf = bytearray()
    while True:
        chunk = conn.recv(RECV_CHUNK)
        if not chunk:
            if not buf:
                return None
            return bytes(buf)
        buf.extend(chunk)
        nl = buf.find(b"\n")
        if nl >= 0:
            return bytes(buf[:nl])
        if len(buf) > hard_cap:
            raise ValueError(
                f"request exceeded {hard_cap} bytes without a newline"
            )


def _bind_socket(path: str) -> socket.socket:
    sock_path = Path(path)
    if sock_path.exists():
        # Remove stale socket from a prior run. We do NOT touch any other file
        # type at this path -- if it's a regular file or directory, refuse.
        if sock_path.is_socket():
            sock_path.unlink()
        else:
            raise OSError(
                f"refusing to overwrite non-socket at {path}: "
                f"please remove it manually"
            )
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Tighten umask before bind so the socket node is created with 0600 from
    # the start. There is otherwise a race window between bind() and chmod()
    # in which a local unprivileged user could connect on the looser perms.
    prev_umask = os.umask(0o177)
    try:
        server.bind(path)
    finally:
        os.umask(prev_umask)
    # Defense in depth: also chmod after bind in case the platform ignored the
    # umask for socket nodes (macOS historically applies umask; Linux varies).
    os.chmod(path, 0o600)
    server.listen(16)
    return server


def serve(
    state: DaemonState,
    *,
    ready_callback: Callable[[], None] | None = None,
    stop_event: "threading.Event | None" = None,
    install_signal_handlers: bool = True,
) -> None:
    """Bind the socket and accept connections one at a time (serial).

    `stop_event` lets tests trigger a clean shutdown without sending signals.
    `install_signal_handlers=False` lets tests run `serve` in a background
    thread (signal handlers can only be installed from the main thread).
    """
    cfg = state.cfg
    server = _bind_socket(cfg.sock_path)
    server.settimeout(0.25)  # poll for stop_event between accepts
    log.info("listening on %s", cfg.sock_path)
    hard_cap = cfg.max_bytes + ENVELOPE_OVERHEAD

    stopping = False

    def _stop(_signum, _frame) -> None:  # pragma: no cover (signal path)
        nonlocal stopping
        stopping = True
        log.info("signal received; shutting down")

    if install_signal_handlers:
        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)

    if ready_callback is not None:
        ready_callback()

    def _should_stop() -> bool:
        return stopping or (stop_event is not None and stop_event.is_set())

    try:
        while not _should_stop():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                if _should_stop():
                    break
                raise
            with conn:
                # Slowloris cutoff: a peer that opens a connection and never
                # finishes sending (or never reads our reply) would otherwise
                # tie up the serial worker forever, since every other request
                # waits behind it.
                conn.settimeout(cfg.conn_timeout_sec)
                try:
                    line = _read_one_line(conn, hard_cap=hard_cap)
                except socket.timeout:
                    response = _error(
                        "ERR_TIMEOUT",
                        f"peer did not send a complete request within "
                        f"{cfg.conn_timeout_sec}s",
                    )
                except ValueError as exc:
                    response = _error("ERR_INPUT_TOO_LARGE", str(exc))
                else:
                    if line is None:
                        continue  # peer closed without sending
                    response = dispatch(state, line)
                try:
                    conn.sendall(json.dumps(response).encode("utf-8") + b"\n")
                except (BrokenPipeError, ConnectionResetError, socket.timeout) as exc:
                    log.warning(
                        "send failed (%s): %s", type(exc).__name__, exc
                    )
    finally:
        with contextlib.suppress(OSError):
            server.close()
        with contextlib.suppress(OSError):
            os.unlink(cfg.sock_path)


# ----------------------------------------------------------------------------
# Boot
# ----------------------------------------------------------------------------


def boot(cfg: Config) -> DaemonState:
    """Verify integrity, load the gate + NLM, run the healthz probe."""
    boot_ts = time.time()
    log.info("verifying classifier artifact integrity")
    verify_artifact_integrity(cfg)

    log.info(
        "loading input-classifier from %s (joblib SHA256 verified)",
        cfg.classifier_dir,
    )
    try:
        classifier = InputClassifier.from_artifact_dir(cfg.classifier_dir)
    except ValueError as exc:
        # Predictor raises ValueError on bad INPUT_CLASSIFIER_THRESHOLD. Map
        # to ConfigError so the process exits 2 (bad config) instead of 1
        # (crash); process managers must not classify a bad-config exit as a
        # crash loop.
        raise ConfigError(f"classifier configuration invalid: {exc}") from exc
    log.info(
        "classifier loaded: embedder=%s threshold=%.3f",
        classifier.embedder_id,
        classifier.threshold,
    )

    log.info("loading NanoMind v3 NLM from %s (this takes a few seconds)",
             cfg.model_dir)
    # Lazy import: torch + transformers are heavy and we want config errors
    # to surface before the import cost is paid.
    from ._nlm import NanoMindNLM

    nlm = NanoMindNLM(
        cfg.model_dir,
        device=cfg.device,
        max_new_tokens=cfg.max_new_tokens,
    )

    state = DaemonState(
        classifier=classifier, nlm=nlm, cfg=cfg, boot_ts=boot_ts
    )

    # Probe the gate before binding the socket. If the embedder is wedged
    # (HF cache missing, OOM, version skew), we want the daemon to exit
    # non-zero rather than serve degraded responses.
    probe_resp = handle_healthz(state)
    if not probe_resp["ok"]:
        raise RuntimeError(
            f"healthz probe failed at boot: {probe_resp['gateProbe']}. "
            f"Refusing to bind socket. Verify the embedder loaded and the "
            f"classifier matches the gate-eval fixtures."
        )

    log.info(
        "boot ok in %.2fs (uptime starts now)",
        time.time() - boot_ts,
    )
    return state


def _setup_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("NANOMIND_GUARD_LOG_LEVEL", "INFO").upper(),
        # Logs go to stderr; telemetry JSON-Lines goes to stdout. Keep them
        # separate so log shipping pipelines can parse one without choking
        # on the other.
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main(argv: list[str] | None = None) -> int:
    _ = argv  # reserved for future CLI flags; env-driven for now
    _setup_logging()
    try:
        cfg = Config.from_env()
    except ConfigError as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 2
    try:
        state = boot(cfg)
    except (IntegrityError, ConfigError) as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"FATAL: boot failed: {exc}", file=sys.stderr)
        traceback.print_exc()
        return 1
    try:
        serve(state)
    except Exception as exc:
        log.exception("serve loop crashed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

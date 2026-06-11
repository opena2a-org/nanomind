# Changelog

## 0.1.3

Gate operating point: the wheel-embedded input-classifier meta.json now
ships threshold **0.90** (CDS-029) with a `thresholdHistory` audit trail,
mirroring the canonical artifact in nanomind-training.

- At 0.65 the gate false-bypassed 30% of external prose attacks (deployed
  recall 65.6% vs the NLM's 94.5% ceiling) for ~0 FPR benefit; 0.90 is the
  lowest threshold with zero attack false-bypass on the Phase B clean
  corpus. See nanomind-training `reports/nanomind-phase-c-gate-fix.md`.
- `EXPECTED_CLASSIFIER_META_SHA256` re-pinned to the new meta.json. The
  expected SHAs are baked into the launchd plist at `nanomind-analyst
  install` time, so an existing install stays self-consistent until you
  re-run `install` — run `nanomind-analyst install` after upgrading to
  pick up the new artifact.
- Deployments that set `INPUT_CLASSIFIER_THRESHOLD=0.90` as a plist env
  override can drop the override after reinstall; the artifact now
  carries the operating point. Upgrade the pip package FIRST, then run
  `nanomind-analyst install` — running `install` from an old wheel
  regenerates the plist from that wheel's constants and would silently
  restore the 0.65 artifact (and wipe the override).
- `nanomind-analyst status` now reports the live gate threshold and
  warns when the installed classifier artifact differs from the wheel's
  pinned SHAs (the post-upgrade-before-reinstall state), instead of
  leaving the old operating point silently in place. `status --json`
  gains `healthz.classifierThreshold` and an `artifact` block
  (`classifierMatchesWheel`, `driftedFiles`). The drift probe also runs
  on the failure paths (socket missing, healthz no-response) — a drifted
  artifact can fail the daemon's boot-time SHA verify, so drift is most
  explanatory exactly when the daemon is down.
- `install` now verifies the wheel-embedded classifier against the baked
  SHA pins as a pre-flight, BEFORE the 3.4 GB NLM fetch — a corrupt or
  tampered wheel fails in the first second instead of after a
  multi-minute transfer.
- `install` now fetches the NLM weights BEFORE touching the classifier
  artifact dir and the plist, boots the daemon out BEFORE that mutation
  window (so an interrupt between the classifier copy and the plist
  write cannot crash-loop a running daemon against mismatched SHA pins),
  and lands both the classifier files and the plist via same-directory
  temp file + `os.replace` so no reader ever observes a half-written
  file. The window is shrunk, not fully closed: if install is
  interrupted between the copy and the plist write and never re-run, the
  stale on-disk plist is still loaded at the next GUI login and will
  refuse the new artifact until `nanomind-analyst install` completes.

P1 fix: the boot/healthz gate probe is now threshold-independent.

- The probe asserted the bypass LABEL for `# README\n\nProject Setup`, which
  encodes the gate's 0.65 operating point. Deploying the CDS-029 threshold
  (`INPUT_CLASSIFIER_THRESHOLD=0.90`, zero attack false-bypass on the Phase B
  clean corpus) made the gate correctly decline to bypass that input — the
  daemon then refused to bind and launchd crash-looped, so the threshold fix
  was undeployable.
- The probe now asserts the LR head ranks the input as more-likely-off-topic
  (`proba_off_topic >= 0.5`), which still catches a wedged embedder or
  scrambled head without coupling boot to the deployed threshold.
- `healthz.gateProbe` gains `probaOffTopic` and `minProbaOffTopic`;
  `expected` carries the new contract as a human-readable string so older
  clients render sensibly. Regression tests in `tests/test_healthz_probe.py`.

## 0.1.2

Bug-fix release for 3 P1 / 3 P2 issues surfaced by a fresh-user release test on the 0.1.1 wheel. 0.1.1 was never published to PyPI; users on 0.1.0 should skip directly to 0.1.2.

P1 fixes:

- `nanomind-analyst --version` and `nanomind-analyst version` now read the installed package version via `importlib.metadata`, so they always match the actual wheel. Previously `__init__.py` carried a hard-coded `__version__` string that was missed by the 0.1.1 bump and would have reported `0.1.0` from a 0.1.1 install. Any downstream tool doing string-match version detection (HMA, opena2a-cli, ai-trust) is unblocked.
- `nanomind-analyst-daemon`, when invoked directly by a user (rather than by launchd), now emits a clear, user-facing refusal pointing at the public CLI (`nanomind-analyst install / start / status / logs`) and exits non-zero. Previously the binary's internal pre-flight could emit a `FATAL` about missing classifier env vars while exiting 0; a `set -e` orchestrator could not detect the failure.
- The same direct-invocation path no longer leaks internal hardening notes ("second RCE path", "mode 0444 root-owned") to the user terminal. Those phrases stay inside the deployment runbook where they belong.
- `nanomind-analyst-daemon --help` / `-h` / `--version` / `-V` are now honored before any platform / env-var check, matching universal CLI expectations.

P2 fixes:

- `nanomind-analyst status --json` emits a single-line JSON object with camelCase keys (`agent.loaded`, `socket.path`, `socket.present`, `healthz.state`, `healthz.requestsServed`, `healthz.uptimeSec`, `healthz.gateProbe`). Exit codes unchanged from the human-formatted mode (0 ready, 1 anything else). Lets HMA / opena2a-cli / ai-trust probe daemon readiness without regexing the human output.
- `--version` (and the new `-V` short flag) is now registered on every subparser. `nanomind-analyst status --version`, `nanomind-analyst logs --version`, etc. all work. `-v` is intentionally NOT bound; it is reserved for a future `--verbose`.

## 0.1.1

- Fix: declare `accelerate>=0.26` as a runtime dependency. `transformers` raises a `ValueError` in `check_and_set_device_map` when `device_map=` is passed to `from_pretrained` without `accelerate` installed, and the NLM loader at `src/nanomind_analyst/daemon/_nlm.py` passes `device_map=device`. On clean envs without `accelerate` already present transitively, the daemon crashed at boot with `requires accelerate. You can install it with pip install accelerate`, so `healthz` never bound and the installer reported `LaunchctlError`.
- CI hardening: new `wheel-install-smoke` job in `ci-nanomind-analyst.yml` builds the wheel, installs it into a fresh venv with **no `--no-deps` shortcut**, and exercises `AutoModelForCausalLM.from_pretrained(..., device_map="cpu")` against a 5 MB stand-in model (`sshleifer/tiny-gpt2`). This is the regression gate for any future missing-runtime-dep regression on the inference path. The release workflow blocks on the same smoke before PyPI publish.

## 0.1.0

Initial release.

- CLI: `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`.
- Vendors the NanoMind-Guard daemon serving the v3.0.0 Qwen3-1.7B Analyst NLM behind the v1 input-classifier gate.
- Fetches NLM weights from `opena2a/nanomind-security-analyst` at the pinned v3.0.0 commit and verifies SHA256 against wheel-baked constants. Uses `local_dir_use_symlinks=False` so the verify reads bytes at the install location, not a swappable cache symlink.
- Bundles the input-classifier-v1 artifacts (~5 KB) inside the wheel; daemon re-verifies SHA256 at every boot before `joblib.load()` runs.
- Per-user launchd LaunchAgent at `~/Library/LaunchAgents/org.opena2a.nanomind-analyst.plist`. No root, no `sudo`. `install` calls `bootout` then `bootstrap` so upgrades reload the new plist rather than silently keeping the old in-memory definition.
- Installer's healthz probe refuses to connect to `/tmp/nanomind-guard.sock` when the path is a symlink or owned by a different uid (defense against same-host socket squatting).
- `nanomind-analyst-daemon` entrypoint is wrapped with a Darwin-arm64 platform check so a direct invocation on Linux/Intel fails with a clear message instead of a torch/MPS stacktrace.
- Release workflow refuses to publish if the tag's commit is not an ancestor of `origin/main`, and if `pyproject.toml` version does not match the tag suffix.
- Apple Silicon (Darwin arm64) only. Linux/cloud daemon support is tracked separately; the NLM is bf16-MPS and fp16 yields 0% accuracy on Qwen3-1.7B.

### Known limitations

- The daemon's default socket lives at `/tmp/nanomind-guard.sock`. On a multi-user macOS host, a different local user can prevent the daemon from binding by pre-creating the path (sticky-bit `/tmp` blocks the daemon's `unlink`). Migrating the default to a per-user path requires coordinated changes in `hackmyagent`'s IPC client; tracked separately.
- `uninstall --remove-artifacts` clears the user's Application Support dir but does not clear the Hugging Face cache at `~/.cache/huggingface/`. Symlinks are off (the install copies real files), so disk-space recovery requires both removals.
- GHA workflow steps reference upstream actions by tag (`actions/checkout@v4`, `pypa/gh-action-pypi-publish@release/v1`). Pinning to commit SHAs is a follow-up.

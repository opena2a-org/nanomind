"""NanoMind Analyst daemon — serves the Qwen3-1.7B Analyst NLM behind the
input-classifier gate over a Unix socket.

Vendored from opena2a-org/nanomind-training/serving (private repo) at the
v3.0.0 release. The serving daemon and the input-classifier predictor are
copied verbatim except for import paths (changed to package-relative) and the
removal of a sys.path hack that the private repo needed for editable installs.
"""

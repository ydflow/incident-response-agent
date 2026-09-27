# Evaluation-only case answers

Ground Truth is committed at `evaluation/expected_cases.json` for repeatable
evaluation. Only test code reads it. The incident Fixture Loader is restricted
to `incident_agent/fixtures/INC-xxx/` and rejects answer-key fields. The
workflow acceptance harness registers only the four evidence tools; the live
demo uses a temporary working directory and exposes no general file tool.
The Dockerfile copies only `incident_agent/fixtures/` into the runner image.

This is an incident-Agent Tool boundary, not a filesystem permission boundary
for MiniClaw's general admin-home Agent. Admin home can mount the entire
repository as `/workspace/project` or run on the host, so a general file or
shell tool in that context could read a committed answer file. Deploy the
incident Agent with its scoped tool allowlist and without a repository mount;
do not pass this file or `docs/incident-case-matrix.md` to its Prompt,
retrieval, workspace, or Tool results.

`generate_fixtures.py` rebuilds only INC-002 through INC-012 from fixed values.
The generated files under `incident_agent/fixtures/` contain observable data,
not answer keys. Evaluation code may read the expected cases separately.

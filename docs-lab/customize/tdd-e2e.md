# TDD e2e extension

> Add a test-first gate to your changes: a `tdd-driven` schema whose changes end with real evidence, and a lint command CI can trust.

The `tdd-e2e` extension is an extension package: a schema plus a set of scripts, installed into your project by one command. It changes what a change produces (a test ledger and an evidence file), and it adds a judgment command that decides whether a change may ship.

Nothing here changes the OpenSpec CLI or the installed skill templates. Everything lands in `openspec/`.

## What it gives you

- The `tdd-driven` schema: `proposal → specs → tests → design → tasks → evidence`. Two new artifacts:
  - **tests**: a ledger mapping every spec scenario to executable test cases, with a red/green status column.
  - **evidence**: the closing artifact — the ledger back-filled from real test runs, plus an e2e summary. It is only created after implementation is complete.
- **`e2e-gate.mjs`**: runs your e2e command and records the result as a run bundle under the change's `evidence/runs/`.
- **`e2e-lint.mjs --gate`**: the one authoritative judgment. It re-runs your e2e command, checks the run bundle matches the final candidate, reconciles the ledger against the spec scenarios, and prints one aggregate: `PASS`, `EXEMPT`, `NOT_APPLICABLE` (exit 0), or `FAIL` (exit 1).
- **`e2e-lint.mjs --archive-gate --change <name> --execute`**: managed archive. It judges, re-checks the snapshot, verifies the spec deltas are synced, then moves the change to `archive/` with no half-states.

## Install

Run the installer from your project root:

```console
$ node extensions/tdd-e2e/scripts/install.mjs --project .

schema: 已安装到 openspec/schemas/tdd-driven/
scripts: 已安装到 openspec/tdd-e2e/（e2e-gate.mjs、e2e-lint.mjs、lib/，覆盖式更新）
```

It copies the schema to `openspec/schemas/tdd-driven/` and the scripts to `openspec/tdd-e2e/`. Re-running it is safe: identical content is skipped, and the installer never touches `openspec/config.yaml`. It prints a suggested `guidance:` block for config.yaml — pasting it is your call, because config is human-curated.

Point changes at the schema per change (`.openspec.yaml`: `schema: tdd-driven`), or make it the project default by setting `schema: tdd-driven` in `openspec/config.yaml`. See [Schemas](schemas.md) for how schemas are chosen.

## Configure the e2e command

The extension reads `tdd-e2e.config.json` from your project root:

```json
{
  "command": "corepack pnpm test:e2e",
  "enforce": "tdd-driven-only",
  "allowlist": [],
  "include": [],
  "collect": ["dist/**"],
  "produces": ["dist/app.js"]
}
```

| Field | What it does |
|---|---|
| `command` | The e2e command, run as a shell string. First trusted source. |
| `enforce` | `tdd-driven-only` (only tdd-driven changes) or `all-changes` (every change gets the test gate) |
| `allowlist` | Trusted exemption records; see [Exemptions](#exemptions) |
| `include` | Extra untracked paths to hash into the input fingerprint |
| `collect` | Globs whose matches become the deliverables manifest after a green run |
| `produces` | Files that must exist for the release contract to pass |

If `command` is empty, the discovery chain falls back to `package.json`'s `scripts["test:e2e"]`, then to the change-level `x-tdd-e2e.command` key — which is a **local hint only**: CI never executes change-level commands. All three empty and no exemption: the gate fails closed.

## Wire it into CI

The single entry point for CI is the gate:

```yaml
- name: Install tdd-e2e
  run: node extensions/tdd-e2e/scripts/install.mjs --project .
- name: e2e gate
  run: node openspec/tdd-e2e/e2e-lint.mjs --gate --json
```

Run `e2e-gate.mjs --rerun` in CI and you've bypassed the judgment: the gate is the only command that checks the run bundle against the final candidate, reconciles the ledger, and publishes the aggregate. Wire its result into required checks; a missing, cancelled, or unreadable gate is never a pass. Archiving goes through `--archive-gate --execute`, never a raw move.

A docs-only diff is exempt from the rerun — but the decision happens inside the gate (`SKIP-EXEC`, never `PASS`), so don't skip the gate job itself with a CI path filter. Mixed docs-and-code changes always rerun.

## Exemptions

A change can declare `x-tdd-e2e.skip: true` with a `skip_reason`. Locally, `e2e-gate.mjs` records that as skipped. That is a hint, not a pass: only `e2e-lint.mjs --gate` can grant `EXEMPT`, and only when the declaration matches a trusted authorization record in `allowlist`:

```json
{
  "allowlist": [
    "{\"change\":\"c1\",\"snapshot\":\"<planning-surface sha256>\",\"scope\":[\"src/**\"],\"approver\":\"alice\"}"
  ]
}
```

Each record carries four parts: the change's identity, the reviewed snapshot hash (recomputed from the change's `specs/`, `tests/`, and `.openspec.yaml` — edit any of them and the authorization goes stale), the scope the exemption covers, and the approver. Globs only filter candidates; they never authorize.

## Known limits

- The traceability is planning-level: every scenario is reconciled, and the e2e run's exit code covers the whole. Nothing verifies that each named test case really executed.
- Store mode (changes living in a store repo, code in project repos) needs wiring across both repos; without it the gate degrades to local advice.
- The schema is a static fork of spec-driven: fixes to the built-in schema's instructions do not propagate into it.

The full contract — the decision table, the four lifecycle events, the trust model for command discovery — lives in the extension's own README at `extensions/tdd-e2e/README.md`.

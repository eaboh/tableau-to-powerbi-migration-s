# Copilot instructions, tableau-to-pbi-migration

> This file exists so agent runtimes that auto-load **`.github/copilot-instructions.md`** (VS Code
> Copilot) pick up the same conventions as runtimes that auto-load **`/AGENTS.md`** (Copilot CLI).
> **`/AGENTS.md` at the repo root is the source of truth — read it.** Only the session-start step is
> duplicated here, because it has to fire before anything else.

## Session start, do this first (before any other work)

**Linux contributor-only sessions:** follow the offline-work exception in `AGENTS.md`; Windows sessions must run the command below.

```
powershell -ExecutionPolicy Bypass -File scripts/preflight.ps1 -Update -CheckUpstream
```

**Only after an actual unsigned/ExecutionPolicy startup refusal**, follow
[preflight cannot start](../docs/operator-runbook.md#preflight-cannot-start).
If recovery is allowed, retry the **exact originating command and arguments**; this session-start
call retains `-Update -CheckUpstream`. Do not run policy diagnostics first.

Nonzero preflight requires native findings and a human decision; engine-readiness findings may be
accepted as unused only on the simple route. Authorization, credentials, privacy, custody,
unsaved-state and authoring-tool safeguards remain mandatory; never bypass structural refusals.
Migration-start preflight is **plain**; no tooling upgrades mid-migration.
Setup details live in [runbook §1.1](../docs/operator-runbook.md#11-tooling).

## Everything else

Read [`/AGENTS.md`](../AGENTS.md): explicit single/batch and modernization/1:1 intake → scoped
assessment (optional for single) → harvest/local parse + provenance → Tableau oracle → semantic
builder when needed → report builder → advisory independent comparison. Resume the same run and
persist human decisions. The default requires no engine bundle/package gate; advanced routes retain
their existing authorities. Supplied PBIPs/connection examples stay read-only; no inferred consent.
Contributor process lives in [CONTRIBUTING.md](../CONTRIBUTING.md); navigate with
[docs/INDEX.md](../docs/INDEX.md).

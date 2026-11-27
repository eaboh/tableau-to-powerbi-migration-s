# Start with one workbook

You have **one** Tableau workbook, optionally an existing PBIP. Default simple/v1
prepares the source and hands off to builders; it does not require an estate sweep,
conversion engine or package. Local parsing/provenance needs no Tableau PAT.

## Default simple start

Complete [Windows setup and session preflight](operator-runbook.md#start-here) first.
Do not update tools mid-migration. Offline Linux contributor parsing/tests are not
live Tableau/Desktop acceptance.

```powershell
t2p start --mode single --style one-to-one --numeric none `
    --local '<private-workbook.twbx>' --assessment skip `
    --session-id '<real-session-UUID>'
t2p status --run '<printed-absolute-run>' --json
```

Use `.twb` or `.twbx`; supplied inputs stay read-only. Choose `--style one-to-one|modernize`
and `--numeric none|required` explicitly. `--assessment skip|run` is explicit for single:
local inputs have no server assessment, so choosing run produces a finding rather than
invented evidence. Modernization requires a human-approved `--design` before report work.
For an authenticated workbook, substitute `--workbook <exact-LUID>` (optionally scoped by
`--project <exact-name-or-LUID>`); configure PAT securely in environment/ignored `.env`,
never arguments. Batch projects use the [runbook](operator-runbook.md#simple-route--intake-to-advisory-comparison).

The front door allocates once (repo-local `_runs/`, or explicit `--runs-parent`), prepares
source/spec/provenance and published dependencies, attempts Oracle when authenticated,
and returns native human/task actions. Local source reference absence is retained: choose
an offered `--decision reference:UNIT=continue` only when authorizing that limitation.
Supplying arbitrary screenshots does not clear the local authenticated-reference absence.
This does not turn screenshots or source parsing into independent numeric/visual proof.

One workbook gets one report/unit. Use the printed private
`assessment/briefs/UNIT/migration-brief.md` (`simple-brief/v1`) and working
`deliverables/UNIT` in every task. The dispatcher invokes semantic builder only when
needed, report builder, then read-only independent advisory comparison; Python never
invokes agents. No bundle/package, START_READY or COMPLETE prerequisite applies.

- Existing report: `--pbip WORKBOOK_KEY=<existing.pbip>` is explicit per workbook;
  no supplied PBIP means greenfield. Originals and existing authored destinations
  are never overwritten.
- `--connection-example <PBIP>` inspects actual M/TMDL connections read-only, not
  a visual template. `--target WORKBOOK_KEY:server=value` (also `warehouse`, `database`,
  `schema`) is a semantic-owner mapping, not an automatic rewrite.
- Resume **the same absolute run** with `t2p start --resume <absolute-run>`.
  Reuse choices, mappings, selected environment and successful sources. Apply offered
  `--decision ID=retry|replace|skip|continue|accept`; never silently restart or widen scope.
- Save real task results under that run and resume with
  `--record UNIT:semantic|report|comparison=<run-owned-result.json>`.
  [Result schema and layer-owned artifact paths](../scripts/README.md#simple-mappings-decisions-and-task-records).
- Without warm model cache, report work requires explicit
  `--decision cache:UNIT=continue` and disclosed unverified data. Authorization,
  credentials/sign-in/modal dialogs, custody/private outputs and unsaved-state
  safeguards still stop work; continuation cannot bypass them.

Comparison is advisory: retain findings, repair via the owning builder, or explicitly
accept/skip with limitations, never fake a pass. Source preparation/portable tests do not
prove Desktop data, persistence or Tableau fidelity. Deployment needs separate approval.

## Explicit advanced/manual alternative

The repository-manual conversion workflow below was exercised on **our reference estate**
on 2026-09-04 with no `TABLEAU_SERVER_URL` or PAT. That historical evidence is not acceptance
of the new simple route. Its engine/package reference contracts and folder conventions
apply only when this advanced/manual route is selected.

## Choose the route first

The following choices belong to the explicitly selected advanced/manual alternative.

1. **Respect the requested write/output boundary.** If the request says local output and no toolkit
   repository changes, use an external working/output root and leave supplied inputs unchanged.
   The `migrations/` layout below is not permission to write into the repository.
2. **If the installed `tableau-migration` skill is the selected orchestrator, follow that route.**
   Use its `scripts\new_run.py` allocator for a fresh short external run and its optional D7
   `reference_images.py --mode export` acquisition. Do not silently switch to the repository layout
   or copy another engine.
3. **The commands below are the explicitly selected repository-manual alternative**, for a
   repository-managed unit and later promotion. Use `scripts\work_dirs.py` to allocate the run, as
   shown below; its existing `--runs-parent <short-parent>` option provides a short external run
   root when needed. Never hand-invent or reuse a run number.
4. **The acquisition manifests are not interchangeable.** The installed helper's
   `out\reference_images\manifest.json` records coverage/confidence, not the repository reader's
   `dashboards[].states[]` capabilities contract. Its exit 0, filename or `named` confidence is
   not repository reference readiness. At a repository handoff, supply evidence the existing
   reader accepts or report the gap; there is no implied manifest adapter.

The authoritative [conversion, dispatch, and fidelity boundaries](reference-readiness.md#conversion-dispatch-and-fidelity-boundaries)
apply at the handoff. The following is the repository-manual sequence, not an override of the
selected installed-skill route.

---

## 0. Before anything — the two prerequisites that cost real time

> ⚠️ **The data source must ALREADY be connected in Power BI Desktop, signed in, under the account
> you will run as.** An agent cannot see or set Desktop's saved data-source connections, and it
> cannot fill a sign-in dialog. If the connection is not there, the agent burns an hour failing to
> authenticate and then has to stop and ask you anyway. Open Desktop, connect to the database or
> warehouse the dashboard reads, and confirm it refreshes — *before* you start.

Get the environment green with the direct preflight command, without a signing-policy pre-check:

```
git clone <this repo>
cd tableau-to-pbi-migration
uv sync --all-extras
powershell -ExecutionPolicy Bypass -File scripts/preflight.ps1 -Update -CheckUpstream
```

**Only after an actual unsigned/ExecutionPolicy startup refusal**, follow
[preflight cannot start](operator-runbook.md#preflight-cannot-start).
If recovery is allowed, retry the **exact originating command and arguments**; this setup call
retains both `-Update -CheckUpstream` for session start.

Advanced preflight is the contract — it prints an install hint beside anything missing and exits non-zero.
Beyond the Fabric skills, the Power BI Desktop bridge and the `powerbi-report-author` CLI, the one
extra dependency people miss is `pythonnet`, which loads the ADOMD client Desktop already ships
(preflight's `adomd_client` check). Open models with `python scripts/open_desktop.py <pbip>`; it
finds the installed Desktop itself and prints the PID.

`uv sync --all-extras` matters more than it looks: without the extras, `parse_tableau.py` cannot
import `lxml` and several scripts fail on a fresh clone.

---

## 1. Drop the workbook in

```
migrations/workbooks/<your-slug>/
    source/<your-workbook>.twbx      <- .twb or .twbx, either is fine
    reference/                       <- screenshots go here (step 2)
```

`source/` and `reference/` are **git-ignored**, so a workbook holding customer data never lands in a
commit.

## 2. Drop the screenshots in

One PNG per dashboard page, in `migrations/workbooks/<your-slug>/reference/`:

```
reference/tableau-<exact dashboard name>.png
```

Three rules, all of them load-bearing:

| Rule | Why |
|---|---|
| The name must start with **`tableau-`** and end in **`.png`** | Anything else is not read. A `.jpg` or a plain `overview.png` is now reported by name with the reason, but it is still not used. |
| The rest of the name is the **exact** Tableau dashboard name | It is matched case-insensitively, spaces and all — **not** slugified. `tableau-Sales Overview.png` matches the dashboard `Sales Overview`; `tableau-sales-overview.png` does **not**. An unrepresentable, different or ambiguous name remains an identity gap; `--manual-object-type dashboard` declares kind only, not identity. |
| Full page, legible, one per page | It is candidate evidence, subject to the manifest's attribution, integrity and grade checks, not automatic fidelity ground truth. Anything below 64 px on either edge is rejected as illegible. |

Small files are fine — a simple dashboard PNG is often under 20 KB, and that is not a problem.

## 3. What you get, and what you do not

An adopted screenshot is recorded as **layout + text** evidence by default. Only an accepted,
current-source, per-object record can meet the default reference bar; adoption alone is not
readiness or fidelity sign-off. If you personally captured full-resolution evidence with filters
pinned, `--manual-validation-grade` records **your assertion**, not independent verification of its
depicted revision/state. Do not add it merely to make the gate green. Read the accepted capabilities
and ceiling in the manifest/readiness result, not the directory name.

## 4. The command sequence

Windows PowerShell, from the repo root, through the uv-managed environment. Replace the placeholders
and allocate once; reuse the returned paths for this run:

```powershell
$run = uv run --frozen python scripts\work_dirs.py "<slug>" --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Run allocation failed" }
```

For a short external run, add `--runs-parent <short-parent>` to that allocation command. Use the
printed paths; do not rename or move the allocated run.

Run these four commands separately and inspect each exit code. Acquisition may also happen earlier
while source access is available; it is not a dependency of step 2.

```powershell
uv run --frozen python scripts\parse_tableau.py "migrations\workbooks\<slug>\source\<workbook>.twbx" `
    -o "migrations\workbooks\<slug>\migration-spec.json"

uv run --frozen python scripts\run_estate.py --input "migrations\workbooks\<slug>\source" --output $run.bundle

uv run --frozen python scripts\capture_tableau_reference.py "migrations\workbooks\<slug>"

uv run --frozen python scripts\check_reference_readiness.py $run.bundle `
    --source "migrations\workbooks\<slug>\source\<workbook>.twbx" `
    --reference "migrations\workbooks\<slug>\reference"
```

All four can exit **0** with usable evidence and successful conversion. Judge each operation by its
own exit code, never by printed success text or another operation's result.

- **Step 1** writes the normalized `migration-spec.json`. Run it *before* step 3 — that is where the
  dashboard/worksheet names come from.
- **Step 2** runs the deterministic conversion engine over the single workbook and produces the
  PBIP bundle plus a per-workbook handover slice. Missing images do not prevent this step; unrelated
  engine failures still need attention.
- **Step 3** optionally captures/adopts available images and writes `reference/manifest.json`. Every file it did **not**
  adopt is named in the output with the reason. Exit 1 with `REJECTED, not missing` means your file is
  there and unusable, not absent. An existing manifest can short-circuit to exit 0: use `--force`
  after changing the source or recapturing, then rerun readiness. Neither that exit nor an empty
  `--structural-only` capture manifest clears readiness or authorizes model-only data access.
- **Step 4** checks the **reference prerequisite for agentic fidelity work**, using the exact
  source and reference paths above. Exit 1 or 3 is not a pass: resolve the evidence finding before
  that dispatch, not before the already-completed engine emission. Default reference `READY` is
  not final package `START_READY` or a fidelity verdict.

## 5. Prepare the agent handoff

After the requested reference bar and the applicable dispatch prerequisites are met, pick
**`tableau-migrator`** in Copilot CLI or VS Code, or name it in chat. Substitute the actual allocated
bundle path and the accepted evidence grade; package dispatch remains subject to the pending-consumer
boundary linked above.

```
@tableau-migrator migrate migrations/workbooks/<slug> — bundle is at <allocated bundle path>,
reference screenshots are in migrations/workbooks/<slug>/reference (accepted manifest grade: <grade>).
```

Write the four answers it needs into `migrations/workbooks/<slug>/migration-brief.md` first — scope,
autonomy, fidelity bar (faithful re-creation vs. modernise), and what to do at a wall. It is
stateless and cannot infer them, and the file survives a closed terminal.

---

## What to expect

These are historical advanced reference-run expectations, not measurements of the simple route.

- **~1.5 hours minimum** for a simple report, most of it not model time — Desktop opens, refreshes and
  validation passes dominate.
- **Roughly $50–100 of model spend** for a medium-complexity report; more for a complex one.
- This is an **accelerator, not a one-shot conversion.** It gets you a loading model and a bound
  report to review and correct; it does not hand you a finished dashboard.

## Two limits worth knowing up front

1. **A Power BI Desktop dialog still needs a human.** Read-only observation/collection
   may preserve its details privately; never dismiss, approve, enter credentials or resume
   past it automatically. Follow the Desktop-debugging skill; leave the dialog open.
2. **Power Query M has no validation path equivalent to TMDL.** Generated M that is subtly wrong is
   not self-detectable yet, so a data-shaping step deserves a human read even when every gate is
   green.

Migration bug escalation uses the migration-feedback skill: private evidence and a
public-safe issue payload, never publish customer material automatically.

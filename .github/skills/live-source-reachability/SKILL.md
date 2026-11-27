---
name: live-source-reachability
description: Establish live-source proof through the shipped Power BI artifact, or stage basic model connections and table definitions for a required human refresh. Use before builders start on live sources, on Desktop dialogs, or when sign-off needs real-data evidence.
---

# Live-source reachability

Use this before any builder starts on a workbook/datasource with live database sources. Prove that
the **Power BI artifact you will ship** can reach its source. A Python, SQL client or Tableau-only
check does not use Power BI Desktop's credential store, so it proves nothing here.

Load this skill **before dispatching builders**. Normally establish proof first through the run
order below. The explicit [staged model fallback](#staged-model-fallback--human-refresh-required)
is the exception: basic model preparation may precede proof, but report authoring waits for the
human refresh and saved-data checks. START_READY can admit `live_unproven`; it is not data proof.
There is no write-time enforcement. Automated refresh uses the existing
[`pbip-model-refresh` procedure](../pbip-model-refresh/SKILL.md#automatic-callers---automatic-source-scope-780),
with its Desktop, bridge and client-library prerequisites; do not create a second refresh route.

## Staged model fallback — human refresh required

Offer **build basic model, then human Refresh and Save** when live connectivity is unproven,
the model does not exist yet, or automatic-source qualification is unavailable or refuses.
Do not require a successful connection merely to prepare the model.

1. **Record the human's choice before preparation.** For `simple/v1`, persist the choice in the
   same run's decisions and private brief. For advanced work, retain the existing
   `fallback_authorization: model_only_unvalidated` and model-only scope; package START_READY
   and custody requirements still apply. This is not permission to change scope or a gate verdict.
2. **Dispatch only the semantic builder for offline preparation.** Create or repair basic
   connections, literal parameters, table/column definitions and source-navigation M from the
   supplied spec and explicitly mapped targets, in the run-owned working tree. Supplied connection
   examples remain read-only. Do not execute M, query a source, trigger Refresh, fabricate rows or
   invent missing schema. Return missing definitions to the human instead.
3. **Stop as soon as basic connections and table definitions are in place.** Hand over the exact
   working `.pbip` path, source identities, named canary tables and any static findings.
   Ask the human to review the connections and queries, open that project in Power BI Desktop,
   resolve any authentication/approval prompts themselves, then click **Refresh** and **Save**.
   Refresh executes the model's current M, including custom SQL; disclose this in the handoff.
   End the turn and wait. Do not launch an operator-only refresh command on the human's behalf,
   approve a dialog, or substitute an automatic retry for this required human refresh.
4. **Verify after the human reports Refresh and Save finished.** Use the existing
   `pbip-model-refresh` read-only `--verify-only --pid <pid> --canaries <table> [<table> ...]`
   procedure on the same working model. Check the binding, positive named canaries covering every
   live source, and persisted-cache/cold-reopen evidence under that skill. Human confirmation alone
   is not data proof; a canary read alone is not proof of a fresh persisted refresh. Record the
   human refresh separately from native check outcomes; never relabel it `DATA_OK + PERSISTED`.
5. **Resume only after those checks succeed.** Finish the semantic build, then hand off to report
   authoring only within the commissioned scope. Advanced model-only scope does not automatically
   expand to report work. Failed, empty, unavailable or wrong-model checks keep the handoff pending.
   A subsequent source/connection change requires another human Refresh and Save before handoff.

The prepared model stays **UNVALIDATED — HUMAN REFRESH REQUIRED** until verified. A dialog remains
a human stop even in this fallback. Preserve actual failures and limitations; no automatic-source
refusal is turned into a pass. Independent fidelity comparison and advanced COMPLETE evidence
requirements below remain unchanged.

## Run order

1. **Classify the sources (read-only, no network).**

   ```powershell
   python scripts\preflight_source_credentials.py --spec <spec>
   ```

   For `simple/v1`, add `--route simple` to print the staged-model guidance instead of the
   advanced pre-build directive. This changes guidance only: live sources still return nonzero,
   classification opens no connection, and the staged fallback still needs a recorded human choice.
   The flag requires `--spec`; bundle and service checks retain their advanced behavior.

   Any live database source needs steps 2 to 5. No live source: record that and stop here.

2. **Check the emitted artifact before opening Desktop.**

   ```powershell
   python scripts\check_bundle_sources.py <bundle> --spec <spec>
   ```

   Non-zero means a static finding or unavailable input, not a credential diagnosis. Route
   `M_PARAM_UNDEFINED` / `M_PARAM_EMPTY` (undefined/blank M parameters) and `SOURCE_COLLAPSED`
   (declared endpoints missing from the model) to the model owner first. Exit 0 is structural only.

3. **Open the shipped working copy in Desktop.** That is `<bundle>/pbip/`, or `<package>/fabric/`
   when you were handed a package. Never the pristine `<bundle>/reports/` baseline.

4. **Refresh it with named canaries** through the existing automatic-source procedure:

   ```powershell
   python .github\skills\pbip-model-refresh\scripts\refresh_pbip_model.py --pid <pid> --canaries <table> [<table> ...] --automatic-source-scope <expected-sources.json>
   ```

   - Pick named canaries covering the live sources. Each must return rows on the held model binding.
   - Expected identities come from a **trusted engine-emission snapshot, never the live model**.
     Follow the existing skill's derivation procedure. There is no bundled expected-sources producer;
     unavailable trusted input is a stop, never permission to fabricate a matching file.
   - Every agent-directed refresh uses `--automatic-source-scope` or explicitly delegates to that
     existing procedure. It fails closed on custom SQL, unsupported M, mismatched identities or
     unreadable metadata. Never drop the flag or switch refresh routes to evade a refusal.
   - A refresh without `--automatic-source-scope` remains operator-only execution of all current M,
     including custom SQL. No new consent flag or ceremony is introduced.

5. **A dialog is a human stop.** Any sign-in, permission or other Desktop dialog ends the attempt.
   The refresh refuses to act while a dialog is open.
   - Ask the human **once**, naming the source and what Desktop showed. Never type, paste or store
     credentials, and never click through a prompt.
   - Autopilot does not override this. End the turn and wait.
   - Structural refusals do **not** prove missing credentials. Inspect the reported scope/model
     finding; retain wrong-model checks and do not enter credentials or automate approval.
   - Only after the human resolves a dialog or the owner corrects the finding, repeat step 4.
     An unchanged credential/permission refusal is final, not a transient retry.

## Record the outcome

| Outcome | Meaning | Next |
|---|---|---|
| Exit 0, `DATA_OK + PERSISTED` | Power BI reached the source through the shipped model and every canary returned rows. | Continue; keep the output for sign-off. |
| A dialog finding | Needs a human; the structural stop alone does not classify the dialog. | Ask once (step 5). |
| `UI_PREFLIGHT_REFUSED` | Source scope, readiness or model identity was not established; not proof of missing credentials. | Stop; route the reported cause without bypassing qualification. |
| `NO_DATA` (a canary returned zero rows) | The refresh ran but a canary is empty. | Check the canary choice and source filters. Not proof. |
| `DATA_CHECK_FAILED`, `ERROR`, `ERROR ADOMD_UNAVAILABLE`, `TIMEOUT`, `COMPLETION_UNKNOWN`, `NOT_PERSISTED`, `WRONG_MODEL` | No real-data proof. | Stop; correct the cause and binding before a new attempt. |

- Write the outcome into the unit's handover and `limitations_encountered`. An unproven live source
  is a disclosed limitation, never a silent pass.
- **COMPLETE needs real-data proof.** `check_unit.py` reports COMPLETE for a live source only with a
  same-run PASS `data-evidence` row: full refresh, persisted, and named canaries that returned rows.
  Independent `@pbi-migration-validator` shipped-artifact fidelity sign-off remains mandatory;
  data proof alone is not a Tableau match or COMPLETE.
- **Advanced model-only work** is allowed only when the brief says
  `fallback_authorization: model_only_unvalidated` with model-only scope. Use the staged fallback
  above and require human Refresh and Save once the basic model exists. The result stays
  unvalidated and cannot serve a report as validated data before verification.

## Old run trees

Historical write-deny remnants are handled only by the
[disarm recovery instructions](../../../docs/operator-runbook.md#414-an-old-run-folder-refuses-writes-after-the-credential-gate-was-retired).
Old markers and audit logs confer no current authority.

# Tableau Migration Operations canvas

Workspace-scoped Copilot SDK canvas: `t2pbi-migration-ops`.

## Use

1. Reload extensions after installing/changing this directory. Ask Copilot to open
   **Tableau Migration Operations** (canvas ID above; no open input).
2. For a new environment, use **Batch creation → Assess the environment** and manually hand
   off the API-only assessment. No run or workbook download is required beforehand.
   Otherwise select an existing run, then **Refresh evidence**. The canvas discovers the repository's
   `_runs` directories. Register runs allocated under an external runs parent in **Run history**.
3. Inspect assessment state, fixed output paths, workbook tiers/complexity, datasource dependencies,
   recorded phases, diagnostic findings and generated/package inventory.
4. Open **Batch creation**, select work items and approve a batch for a subsequent stage. Numeric comparison requires an
   explicit choice. Assessment batches cover the whole run, without unit selection.
5. In **Batch tracks**, copy the dispatcher request and send it to Copilot. **Queuing does not
   execute anything.** The dispatcher calls `get_dispatch`, claims via `update_batch` using its
   real session ID, follows [the runtime contract](../../../AGENTS.md), then records progress.
6. **Export progress CSV** at any stage. Choose all runs or the selected run.

### API assessment → artifact investigation → new conversion waves

All three stages are **approved manual dispatcher handoffs**. Queuing, downloading a handoff
or reading `get_dispatch` starts no process, network collection or migration.

1. **Assess the environment** (`queue_assessment`, label + gap policy) works with no selected
   run. The root dispatcher runs `python -B scripts\start_migration.py --assess-only
   --session-id <real-UUID>` on the configured site. This site-wide route accepts no project,
   workbook or storage-decision selector. It allocates a new **assessment** run, collects
   read-only API/survey metadata, attempts Admin Insights and generates the existing offline
   report; it stops before artifact downloads/harvest, reference capture, packaging and conversion.
   Claim the track, attach that actual assessment run, inspect coverage and record evidence.
   API structural scores can understate actual artifact requirements. Only one unfinished
   API assessment request is accepted per workspace; finish/cancel before another.
2. Select **1–100 exact assessed workbook rows** in the existing inventory or planning filters.
   Choose **Download & investigate assessed wave**. `queue_wave` validates current saved keys
   exactly; names, engine rows, duplicate IDs, empty/unknown selections and >100 are refused,
   never silently widened or truncated. The root dispatcher uses the existing expert
   `harvest_estate_assets.py --out <new-private-ignored-output> --db
   <assessment-run>\assessment\estate.db`, with one `--workbook-id <LUID>` per frozen item.
   Required published datasource providers are included even across projects. No limit,
   workbook-only, skip-download or output-guard bypass is commissioned.
   Inspect `parse-sweep.json`, `parse-sweep.md`, `parse-sweep-totals.json`; **exit 0 means
   parsers attempted, not parse success**. Record download/parser failures and additional
   requirements in the transition note and private evidence reference. Investigation is not
   conversion; it retains the parent assessment identity and does not go to the migrator.
3. Use the same selection and choose **Prepare NEW conversion wave**, explicit numeric scope
   and group size 1–100. `queue_wave` creates one conversion track per workbook, organized
   into one or multiple groups of at most the selected size. Each singleton uses a separate
   actual execution run: the existing front door supports one exact `--workbook`, not a list.
   Groups organize manual sequencing only; they neither launch parallel work nor certify it.
   **Every conversion allocates a NEW run and repeats survey, assessment and downloads.**
   No checkpoint reuse, harvested-output relocation or resumability is promised. Read the
   investigation findings and resolve requirements first. The dispatcher issues briefs and
   hands prepared packages to `@tableau-migrator` only at the normal readiness barrier.

Frozen IDs, immutable `parentAssessmentRun`, conversion `groupId`, actual attached `run`,
owner session, stage notes and evidence references persist privately in the existing v1
tracking format. Older records without workflow metadata remain readable and retain legacy
behavior. Parent assessment and execution runs are never interchangeable: attaching the parent
to a conversion or sharing a new workflow execution run between allocation requests is refused.
Attachment checks intact run identity, **not exact source-scope certification**; the dispatcher
must verify site/LUID scope. A track cannot finish before its required allocated run is linked.
Unfinished overlapping wave stages are rejected atomically; investigation and conversion are
separate stages. Notes/evidence do not mechanically enforce requirement resolution.

**Continue conversion in existing prepared run (advanced)** retains the old queue route.
**Review existing assessment** inspects existing evidence only; it does not recollect or invoke
the migrator. Fresh API recollection uses a separate assessment request/new assessment run.
Credential/dialog and toolkit-gate stops, normal intake, provider ordering, current briefs,
independent fidelity validation and explicit deployment consent remain unchanged.

Progress/history CSV now includes workflow, parent assessment, execution run and group columns,
including not-yet-attached requests. Selected-parent exports include related conversion events;
all-run exports emit each event once. Finished stages remain operator-reported, not COMPLETE.

### One-off conversion without assessment

Open **Batch creation → One-off conversion**, enter a dashboard URL or an exact project
name/LUID, and approve a batch with explicit numeric scope and gap policy. This form does not
require an assessment, selected run, inventory selection or refresh. It records a private source
request, not a fabricated workbook identity or run.

Copy its dispatcher request from **Batch tracks**. The dispatcher claims the track with its
real session ID, resolves the source, then follows the existing workflow:

- **Project:** one `scripts/start_migration.py --project <exact-name-or-LUID>` invocation for
  that scope. No pre-existing assessment is required; the front door's scoped checks still apply.
- **Dashboard URL:** the dispatcher manually resolves the exact workbook/site first.
  `start_migration.py` has no URL flag. Supported published workbooks use `--workbook <LUID>`;
  public/local acquisition follows [Start with one workbook](../../../docs/start-with-one-workbook.md).
  This repository-owned canvas explicitly uses that guide's **repository-manual** route, whose
  allocator writes the repository-native `run.json`. The installed skill's separate allocator
  layout is not supported for linkage here. If that different route was already selected, stop
  and ask before switching. Never fall back to a site-wide sweep.

Once the route allocates its real run, the owning dispatcher calls `attach_batch_run` or uses
**Link allocated run** in the running/blocked track. The canvas checks intact run identity,
registers it, saves an observation and records the association in history. This does not independently
certify that the run matches the source; the dispatcher still owns exact-scope verification.
An attached run cannot be replaced. A source track cannot finish before linking a real run and
providing evidence. Credential stops, intake, current briefs, readiness and independent validation
remain mandatory. No lookup, allocation, conversion or authentication happens in the canvas.

### Assessment planning summary

The planning page opens with a mockup-inspired, unfiltered assessment dashboard:
workbook/project/provider counts, published datasource inventory and lifetime-view
coverage, recommendation shares, the existing structural complexity bands, and a
adjustable Top N lifetime-usage chart. Its slider defaults to 20 (or the known
workbook count when smaller), and extends from 1 to all known-usage workbooks,
including confirmed zeros. Bars, cumulative share and expandable chart values
update immediately. The choice survives same-run evidence refreshes, clamps to
available data, and resets on run switch; it does not change wave filters or CSV
scope. The slider is disabled for missing/all-zero usage or a single workbook.
Its cumulative line uses all known workbook usage as
the denominator, not only the displayed bars. Unknown usage coverage is explicit;
an endpoint callout shows the selected Top N's achieved coverage and updates with
the slider. Hover or keyboard-focus the marker for covered/total lifetime views
and unknown-workbook coverage. The callout stays within the chart, including at 100%.
this is not usage history. Chart legends and expandable usage values provide text
equivalents. Evidence quality and a collapsible limitations panel retain collection
caveats. Detailed project, datasource, complexity, workbook, view and published
datasource-inventory sections start collapsed. Group shortcuts and workbook
drilldowns still open their target section. The richer filtered
wave planner, CSV exports and manual batch selection remain unchanged. No mockup
sample values, new complexity cutoffs or unavailable flow counts are introduced.

Open **Assessment → Planning summary** after selecting and refreshing a run. The subpage
summarizes that assessment by project, referenced published datasource, and complexity band;
it never combines overlapping runs into an estate total. Each rollup shows workbook counts,
proposed tiers, structural score totals/maxima and sizing caveats. Provider rollups show
distinct LUID-linked consumers separately from unique-name candidates and unresolved references.
Project/provider LUIDs remain separate even when names match; name-only groups are provisional.
Referenced providers are not a full inventory of embedded or unreferenced datasources.

Complexity bands are zero, 1–39, 40+, and unavailable. Scores use the producer's structural
weights (sheets 1, dashboards 2, calculations 1, LODs 5, table calculations 5), not effort days.
The producer's 40 threshold is a planning signal, not automatic migration approval.
Primary structure-listing failure invalidates all scores; missing workbook structure invalidates
that workbook's score. Other listing failures retain observed scores with coverage warnings.
Zero is never a guarantee of simple work. Published-datasource calculations can understate sizing.
Missing metadata and old snapshots retain unknown flags; refresh for enriched evidence.

Drill into any project, provider or complexity band, then filter workbooks by name/project/LUID
or proposed tier. Project, datasource, complexity and workbook sections can each be collapsed
using their heading (mouse, Enter or Space). They start expanded; drilling into a group reopens
workbook details automatically. Details are paged at 50 workbooks. **Use filtered workbooks in batch** transfers
all filtered assessment LUIDs to **Batch creation**, not just the visible page. More than 100
requires narrowing the filter; nothing is silently truncated or automatically queued.
Numeric comparison and batch approval remain explicit.

**Export assessment summary CSV** downloads a separate selected-run planning export with
`assessment_summary`, `project_summary`, `datasource_summary`, and `complexity_summary` rows.
It preserves group identity, counts, coverage warnings, observation time, source and
`NOT_CHECKED` certification. Existing **Export progress CSV** remains unchanged.

Directly below that CSV button in **Understand the estate**, **Export assessment report HTML**
downloads a self-contained private offline report (`export_assessment_html`). It uses the same
whole selected saved assessment scope—not current filters—with the same planning markup,
styles, KPIs, charts, Top-N usage slider and coverage callout, evidence quality,
unknowns, project/provider/complexity drilldowns and workbook/view/provider tables. A saved available
assessment is required; missing/unassessable evidence is refused, while an actually observed
zero-workbook assessment remains valid. The CSV button is preserved.
Open the downloaded file directly in a modern browser, including `file://`, without a server.
Filters, attribute menus, inclusive UTC date sliders, charts, sorting, local pagination,
collapsible sections and filtered workbook/view CSV downloads work locally using the same
first-party planning modules as the canvas. Original canvas filters are not transferred;
whole-assessment rollups remain unfiltered. No evidence is refreshed by offline interactions.
The export excludes live collection, refresh, workflow launch, batch selection/handoff, agent
controls, server-side summary CSV and recursive HTML export. The original canvas export buttons
remain unchanged.
The HTML safely serializes source strings and embeds a fixed browser-only module bundle;
a nonce-based CSP blocks other scripts, network connections, external assets and form submissions.
It omits absolute run/storage/output paths and raw producer diagnostic text (issue count retained);
names/LUIDs and intended private assessment metadata remain sensitive. It redacts complete fields
containing path-like labels or explicit credentials rather than preserving those strings.
It performs no collection and never certifies readiness or completion. Browser regressions open the actual HTML with
network requests denied and verify local interactions and CSV downloads.

#### Saved-evidence estate explorer

The workbook drill-down now combines project, referenced provider, complexity band, proposed
destination, lifetime usage/minimum views, last-modified date range (inclusive UTC days), and a
planning-signal filter. Signals include subscriptions/alerts/custom views, user-dependent
calculations, understated complexity and missing structure. Sort by lifetime usage, modification
date, complexity, size or name; unknown values sort last. Rows also show size, sheet/dashboard
counts and deliberate-use counts. Rollups above remain whole-assessment totals, while the
filtered metrics describe only candidate workbooks. A missing value is never zero.

Open **Filter menu** above the charts to find an attribute by name. Existing controls now live
there once (including sort), rather than duplicating filters beside the table. New per-attribute
menus cover workbook name/LUID, creation date, size, sheet/dashboard/calculation/LOD/table-calculation
counts, subscription/alert/custom-view counts, and user-dependent/understated flags. The two flag
shortcuts previously in Planning signal now have dedicated yes/no/unknown menus. Text filters
offer case-insensitive contains/equality; dates and numbers offer inclusive one- or two-sided
ranges, known or unknown. Invalid ranges show an error and yield no exportable candidates.
Menu search only hides controls, never clears active filters; the active-filter count includes
hidden controls. Reset clears all attribute filters, chart selections and group drill-downs.
All filters use saved workbook evidence; optional view rows follow their parent workbook.

Eight **Filtered candidate headlines** update with every filter, slider, chart or drill-down:
workbooks and estate percentage, observed lifetime views and share of known estate usage,
distinct project groups, observed LUID-linked provider groups (candidate groups separately),
structural score total/max, reported dashboards with sheet/calculation totals, size, and
deliberate-use workbooks with access/sizing flags. Figures cover all candidates, not one page.
Numeric sums disclose known/unknown coverage; no known values yields Unknown, not zero.
Provider groups are not dependency edges; candidate groups can overlap linked groups.
Whole-assessment baseline cards and project/provider/complexity rollup tables remain unfiltered
and are labelled separately. None of these figures proves migration readiness or usage history.

**Tableau views by lifetime usage** reads the fixed saved `assessment/raw/views.json` inventory.
It preserves view and parent-workbook LUIDs, supports search and sorting, and follows the
workbook filters. Views whose parents are not in the assessed workbook inventory are explicitly
unmatched and appear only when no workbook filter/drill-down is active. The REST inventory does
not reliably distinguish dashboards from worksheets: this table deliberately says **views**.
There is no usage history or last-viewed date in this evidence. Last modified is neither last
used nor last refreshed. No network request, Admin Insights collection or authentication is added.

**Published datasource inventory** reads the fixed saved `assessment/raw/datasources.json`.
It includes providers without observed dependency edges, plus modification date, connection
type and certification/extract flags when available. Search and sort this catalog; exact
project/provider dropdown filters also apply to it. Other workbook filters do not filter the
catalog. Consumer counts are observed exact-LUID edges from the supplied survey only; that
survey can be much narrower than the assessment. Zero observed consumers never means unused,
and absence of an edge never proves a workbook is provider-free.

Both optional raw inventories have separate evidence-output statuses. Missing, malformed,
oversized or linked optional files produce explicit warnings and unavailable inventories without
discarding the valid workbook assessment. REST numeric-string view counts are normalized;
missing/invalid optional metadata stays unknown. Old saved snapshots remain readable; use
**Refresh evidence** to project additional fields from existing assessment files.

**Export filtered workbooks & views CSV** exports all matching workbook and view rows, not just
the current page, with source, identities, per-workbook provider bindings (confirmed versus
name-only candidates), filter settings, observation time, limitations and
`NOT_CHECKED`. View search/sort affect view export rows only, not workbook candidate selection.
CSV formula protection is shared with the existing exports. Batch transfer uses the exact same
filtered workbook LUIDs (maximum 100), never view IDs, and still requires explicit batch approval.
Neither filters nor tiers automatically assign migration waves, retire content or start migration.

#### Visual wave planner

The planning page also presents clickable workbook-count bars for lifetime-usage buckets,
complexity bands, the ten largest project groups, and last-modified month/year periods.
Charts use **all filtered candidate workbooks**, not the current table page. Click a bar to
intersect the relevant filters; the table, filtered CSV and batch candidates follow the same
selection. Top-project groups use existing LUID/provisional keys; the remaining workbook count
is informational, never a fabricated selectable project. The reset button clears all workbook
filters and drill-downs. Maximum lifetime views complements the existing minimum filter.

Separate **Modified from / through** sliders select inclusive UTC days and synchronize with
the exact date fields. Their domain stays fixed to the whole selected assessment so filtering
does not move the handles' scale. Crossing handles clamps the paired boundary. Initial slider
positions do not impose date bounds; **Clear date range (include unknown)** restores that state.
Missing dates remain explicit, and sliders are disabled when no dates or only one distinct day
are available. Arrow/Home/End keys provide native keyboard operation.

The scatter plot compares structural complexity with **lifetime** views using log(1 + value)
axes, preserving genuine zeros. Tooltips and the workbook table expose original values and IDs.
Points with missing usage or score are omitted with an explicit count, and points may overlap.
Neither the scatter nor modification-period bars provide usage history, predict effort or
automatically recommend/authorize a migration wave. The charts are local DOM/SVG with no charting
dependency, inline scripts/styles, external requests or source collection.

Pending source requests and their histories appear in **all-run CSV exports**, with an empty
run field and unknown assessment rather than invented counts. After linkage, their source metadata
and events appear under the actual run. A selected-run export excludes unlinked requests.

The canvas does not start conversion subprocesses, authenticate, open Desktop, dispatch autonomous
agents or deploy artifacts. An approved batch is a manual handoff, not a scheduler. Existing scope,
front-door allocation, intake, exact unit identity, current v2 briefs, provider ordering, package-cohort
START_READY **and exit 0**, independent validation, and separate deployment consent remain mandatory.
Use the repository's task-tool `tableau-migrator` dispatch, not an inline replacement.

## Meaning of progress

### Agent activity

Open **Agent activity** with a selected run to inspect its linked sessions and dispatched
subagents without first running an assessment. Session anchors are read from `run.json`:
`session_id`, `copilot_session_id`, and `attribution.session_id`, `root_session_id` or `roots[]`.
All explicit session anchors are deduplicated and retained. Agent-only anchors are displayed
as unknown unless found within an explicitly linked session; no global session search occurs.
Run allocation identity is checked before any session records are opened.

The optional **local Copilot events adapter** reads only
`<copilot-home>/session-state/<session-UUID>/events.jsonl`. It projects identity, lifecycle
states, timestamps and parent relationships, never prompts, tool arguments, results or transcripts.
Missing logs, other host layouts, mismatched identities and refused evidence show **unknown**
with a reason. No SDK host APIs, session database assumptions or foreground automation are used.
The canvas and SDK glue remain host-neutral; this adapter's availability is host-dependent.

States are **recorded**, not proof of current process liveness. `assistant.turn_start/end`,
`session.shutdown/resume`, and `subagent.started/completed/failed` drive status. More than
two minutes without an agent event produces a stale warning, never an inferred completion.
Mode-selection events do not create dispatched agents. Parent links require an unambiguous
tool-call/caller join; missing, contradictory or cyclic links remain unknown. Session shutdown
does not fabricate successful child completion. A completed subagent is not a completed migration.
All activity in a linked session is shown and may cover other runs or unrelated work.

Activity refreshes on entry and every 30 seconds while its page and document are visible;
disable the checkbox to stop polling or use **Refresh agent activity** manually.
Manual and timed refreshes share one in-flight guard. Switching runs clears old rows; late
responses cannot overwrite the new run. Failed reads clear the rows and show an explicit error.
**Export agent activity CSV** exports exactly the last displayed observation, including unknown
anchors, scope warnings and `NOT_CHECKED`. It does not silently trigger another observation.

Reads are transient and read-only; manifests, event logs and private tracking snapshots are
not modified. Every poll reparses the current log (no stale cross-poll cache). Limits are
16 explicit anchors, a total 256 MiB read budget per observation and 16 MiB per event line;
over-limit sessions show unknown rather than a partial tree. Incomplete final appends are
flagged and ignored; malformed complete events refuse the session. Large logs can make refresh
slower; overlapping requests for the same run share the read.

- Refresh runs `python -B scripts/run_status.py --run <absolute-run> --json` with a two-minute
  local diagnostic timeout. Exit 1/2 is retained, not converted into a successful verdict.
  Run children are read only when that reader establishes intact run identity.
- Assessment reads the producer's fixed `assessment/assessment.json` schema. States are
  **inventory observed**, **degraded**, **incomplete**, **missing**, **unassessable** or **not observed**.
  These do not assert process liveness. Output presence does not assert output validity.
- Name-only, unique assessment-to-engine matches are explicitly **candidates, not identity proof**.
  Ambiguous matches are not joined. Source LUIDs, run paths and selection keys are retained.
  Assessment and engine rows keep separate stable keys; existing batch progress stays on its
  original row when assessment arrives. Historical selections remain visible if evidence disappears.
  An unfinished batch conservatively blocks its name-only counterpart even if current evidence
  disappears; this prevents duplicate work without asserting a confirmed identity mapping.
  Select either the assessment or engine row for a workbook, not both within the same batch.
- Generated copies, package presence, integrity observations and **stored** gate records do not
  certify readiness/fidelity. Current certification is always `NOT_CHECKED` here.
- Batch states: `queued -> running -> blocked/finished/cancelled`; blocked may resume or cancel;
  queued may cancel; finished/cancelled are terminal. Claim is exclusive to the real session ID
  supplied by the dispatcher. Finished requires an evidence reference. A stage can be retried by
  creating a new batch after the previous batch is terminal.
- A finished track is **operator-reported batch-stage completion**, not certified `COMPLETE`.
  The canvas does not independently execute/revalidate the cited evidence.
- Refresh is selected-run only. Other snapshots retain their observation times. An all-run export
  does **not** silently refresh the estate or claim that old snapshots are current.

## CSV

One Excel-friendly UTF-8 CSV contains `run_summary`, `work_item`, `source_request`, and `batch_event` records.
Every row names its run, export time, evidence observation time, assessment state, diagnostic exit,
and non-certification. Work items include assessment scope, mapping confidence, generated/package
observations and per-stage reported progress. Batch events preserve session, status, timestamps,
numeric scope, policy, notes and evidence references. Runs never refreshed are exported as unknown,
not omitted or zero-complete. Formula-like cells are prefixed to prevent spreadsheet execution.

Exports contain private local run names, paths and operator notes. Treat downloads as customer
material; do not commit or publish them.

## Storage and SDK actions

Code lives only in this workspace's `.github/extensions/t2pbi-migration-ops/`.
No SDK package installation or `package.json` is needed; Copilot resolves the SDK.

Private state is stored in
`<copilot-home>/extension-data/t2pbi-migration-ops/<workspace-realpath-sha256>/tracking.json`.
Copilot home uses nonempty `COPILOT_HOME` exactly as supplied, otherwise `~/.copilot`.
State includes versioned snapshots, explicit external-run registrations and append-only batch
event histories. Different workspaces have separate identities. Reads validate the format; corrupt
or unrecognized state is reported without overwriting it. Writes use same-directory unique temp
files and rename under an exclusive cross-process directory lock. A busy lock fails after two
seconds; after a crash, inspect it and confirm no writer is active before manually removing
`write.lock`. No automatic stale-lock breaking or data migration is attempted.
The optional validated `source` discriminator permits unallocated one-off source tracks.
Optional `workflow` metadata also permits `run: null` for API assessment and singleton new
conversion tracks until attachment; investigation retains its parent assessment run.
Attached tracks have real absolute run paths. Existing run-only records remain valid without migration.

Actions (all use JSON object inputs):

| Action | Input |
|---|---|
| `get_state` | `{}` or `{run}`; returns run summaries, all batches, selected snapshot/rows and derived `assessmentSummary` |
| `get_agent_activity` | `{run}`; transient run-linked session/subagent observation plus matching `csv` download; no assessment required |
| `register_run` | `{run}` absolute existing local directory |
| `refresh_run` | `{run}` registered/discovered directory |
| `queue_batch` | `{run,label,stage,keys,numeric,policy}`; keys from `get_state`; empty for assessment |
| `queue_source_batch` | `{label,source:{kind,value},numeric,policy}`; kind `dashboard_url` or `project`; no run/assessment required |
| `queue_assessment` | `{label,policy}`; site-wide API metadata only; no existing run required |
| `queue_wave` | `{run,label,stage,keys,numeric,policy,batchSize}`; stage `investigation` or `conversion`, 1–100 exact assessed keys; integer conversion group size 1–100 |
| `attach_batch_run` | `{id,run,sessionId}`; running/blocked source, API assessment or new-conversion track, real owning session, actual allocated absolute run |
| `get_dispatch` | `{id}`; returns batch, dependencies and mandatory dispatcher instructions |
| `update_batch` | `{id,status,sessionId,note,evidence}`; real owner session; evidence required to finish |
| `export_csv` | `{}` for all known runs, or `{run}`; returns filename/content/record count |
| `export_assessment_csv` | `{run}` with a saved snapshot; returns selected-assessment planning CSV filename/content/record count |
| `export_assessment_html` | `{run}` with an available saved assessment; returns private standalone HTML filename/content/workbook count |

Stages: `assessment`, `investigation`, `conversion`, `packaging`, `semantic`, `report`, `validation`, `promotion`.
`queue_batch` retains legacy stages; `investigation` uses `queue_wave` exclusively.
Numeric scope: `none|required` (no default). Policy: `stop|degrade` (neither bypasses gates).
Overlapping unfinished batches at the same run/item/stage are refused.
Unfinished one-off source duplicates are refused by normalized kind/value, even after linkage.
Because a linked source track covers the whole conversion scope, overlapping run conversion
batches are refused until it is terminal. Credentials embedded in dashboard URLs are rejected;
normal Tableau view routes, fragments and share parameters are retained.
Trusted-ticket source URLs and credential parameters (including camel-case names) are rejected;
use the ordinary credential-free dashboard URL instead.

The browser and SDK actions call the same validated service. Each panel owns an ephemeral loopback
HTTP server. Reopening the same panel reuses its server and reloads durable state. HTTP requests
enforce same-origin/Host checks, a per-panel header token, JSON/body limits and no artifact file
serving. No credentials or private state are placed in URLs. Closing an instance stops only its
own server; merely hiding a presentation does not destroy its state.

## Validation

From the repository root:

```powershell
node --check .github\extensions\t2pbi-migration-ops\extension.mjs
node --test --test-timeout=30000 .github\extensions\t2pbi-migration-ops\tests\*.test.mjs
python -B .github\extensions\t2pbi-migration-ops\tests\browser_smoke.py
```

Tests use synthetic local runs/private stores and do not launch migrations or contact Tableau.
The browser regression uses the existing Python Playwright package and installed Microsoft Edge;
it covers one-off URL/project approval starting with no registered runs, run linkage, progress
updates, existing inventory batches, external-run registration, CSV download and page reload.
Planning regressions cover rollup identity/coverage, structural failures, old snapshots,
101-workbook pagination, exact batch limits, drill-down transfer and separate planning CSV.
Workflow regressions cover API assessment before run allocation, exact scoped investigation,
atomic conversion grouping, distinct run attachment, parent/event identity, legacy records,
and safely serialized offline HTML with unavailable-evidence refusal. Edge covers HTML download/button
placement and opens the actual export via `file://` in a separate offline context with requests
denied. It checks matching planning KPIs/SVG markup/styles, collapsible defaults, Top-N coverage,
filters, attributes, charts, dates, drilldowns, pagination, sorting, local CSV, hostile labels,
metadata redaction and zero attempted external requests, alongside the existing forms and monitor regression.
Runtime validation requires extension reload, capability discovery, open, action invocation and
same-instance reopen through the Copilot host.

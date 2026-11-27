# Agent navigation index

Desktop observation authority and its source-proof boundary:
[`desktop-observer-simplification.md`](desktop-observer-simplification.md) (slice 1).

Map of maps for agent-facing knowledge. Start here, then open the matching index or direct file.

## Start here for a migration unit

1. `python scripts/start_migration.py --mode single --style one-to-one --numeric none --workbook <exact-LUID> --assessment skip`
   (or installed `t2p start` with the same flags) — the default **simple/v1** route.
   Choose `single|batch`, `one-to-one|modernize`, and `none|required` explicitly;
   single chooses `--assessment skip|run`, batch assesses the exact project-scoped selection.
   [Runbook intake and recovery](operator-runbook.md#simple-route--intake-to-advisory-comparison)
   covers local inputs, explicit PBIP/connection mappings, native findings and same-run resume.
2. Follow returned human/task actions: scoped assessment when commissioned → source
   harvest, local parse/provenance and dependencies → Oracle → semantic builder only
   when needed → report builder → independent **advisory** comparison. The dispatcher
   invokes task tools; Python never invokes agents. Each selected workbook gets one
   report/unit, a private `simple-brief/v1` brief under
   `assessment/briefs/UNIT/migration-brief.md`, and working `deliverables/UNIT`.
3. `python scripts/t2p.py status --run <absolute-run> --json` — read-only observations;
   `human_actions`, stages and `route` expose the next action, not readiness or fidelity.
   Resume the **same absolute run** with `start --resume`; retain successful sources,
   commissioned choices, mappings and environment selection. Native absences/errors
   need explicit human decisions; safety, credentials/dialogs, custody, private-output
   and unsaved-state safeguards are not bypassable. No engine bundle, package,
   START_READY or COMPLETE prerequisite belongs to this simple route. Disclose
   unverified data/fidelity and obtain separate approval before deployment.
4. Load the applicable skill for live-source proof, refresh/persistence, Desktop
   observation or AI metadata. Offline Linux checks are not live PAT/Desktop acceptance.
   For unproven live sources, offer the
   [staged model fallback](../.github/skills/live-source-reachability/SKILL.md#staged-model-fallback--human-refresh-required):
   prepare basic connections/tables offline, stop for human Refresh and Save, then verify the same
   model's canaries and persistence before report authoring.

## Explicit advanced package route

Select `python scripts/start_migration.py --advanced [...]` or `t2p start --advanced [...]`
for the existing five-stage survey/assessment/harvest/Oracle/conversion route.
`t2p assess` remains a separate advanced assessment-only route, including existing
survey/Admin Insights evidence. The following package/check/promote authorities are
unchanged; do not apply them to a simple-route advisory handoff.

1. `python scripts/check_reference_readiness.py <package> [...]` — **after deterministic emission, `package_unit.py` packaging and applicable binding, before agentic dispatch**. The final Phase-1 package-only verdict is **`START_READY / 0`** only when boundary, current S1/S2, issued v2 brief, source, canonical data access, reference policy and fresh binding inspection all pass. Bind separately with `set_data_folder.py --package <absolute-package>`; supply a shared provider and consumer in **ONE final check**, never a consumer alone. Established findings exit 1; `CANNOT_ESTABLISH` exits 3; neither permits dispatch. Ordinary `<bundle>` targets retain reference-only `READY`/engine-earned `NOT_APPLICABLE`, never package START_READY. Reference grades and `limitations_encountered` remain unchanged; BOUND stays UNVALIDATED. See [final START_READY](reference-readiness.md#final-package-start_ready-562-622) and the authoritative [conversion, dispatch, and fidelity boundaries](reference-readiness.md#conversion-dispatch-and-fidelity-boundaries).
2. `python scripts/check_unit.py <unit-or-bundle> --scope <model|report|integration|all>` — diagnostics. **Sole COMPLETE authority:** `python scripts/check_unit.py <package> --scope all --receipt-sha256 <H>`, with exact caller-supplied lowercase 64-hex H, no prefix or token discovery. Tokenless all-scope stays non-success; layers never COMPLETE. Current v2 numeric `none` waives comparison only; required/unknown remains `CANNOT_ESTABLISH(NUMERIC)`. [Evidence, exact disclosures and current-snapshot limits](../scripts/README.md#phase-2-complete--one-caller-pinned-current-snapshot-check); direct gates isolate findings.
3. `python scripts/read_handover.py <bundle> --workbook <name>` — residual work queue and engine-block reason.
4. Live database sources: load the `live-source-reachability` skill **before builders start**. Normally it delegates proof to `pbip-model-refresh`'s existing automatic-source procedure on the shipped working copy with named canaries. Its explicitly selected model-only staged fallback allows basic offline preparation first, then requires human Refresh and Save and verification; it does not waive package entry or scope. Any sign-in or other dialog is a human stop. START_READY can admit `live_unproven`; a live unit reaches COMPLETE only with `check_unit`'s same-run PASS `data-evidence` row and independent fidelity sign-off.
5. Load the right skill before acting: `live-source-reachability` for live-source proof and
   credential stops, `pbip-model-refresh` for cache/refresh, and
   `powerbi-ai-readiness` for Copilot/Q&A metadata.
6. `python scripts/promote_unit.py --package <package> --slug <slug> --receipt-sha256 <H>` — **the last hop** from the checked package, forwarding identical caller H to the public all-scope checker and preserving its result/disclosures. A stored token is observation, never future authority. `--force` conflicts with H before effects; force alone prints/records exactly **PROMOTED unchecked; Phase-2 COMPLETE was not established.** Content, resolved containment, external-data, host-path, model-reference and transaction guards remain non-forceable. Shared/report-free shipment mechanics do not become COMPLETE-supported classes. Exits: 0 promoted / 1 gate refusal / 2 CANNOT_ASSESS / 3 content refusal / 4 promotion failure / 5 external-data refusal / 6 host-path refusal / 64 usage. [Phase-3 mechanics](migration-phases.md#phase-3--ship); promotion is not deployment, durable persistence or receiving-machine proof.

After a machine-wide Power BI sign-in, rerun the skill's refresh for each live unit that stopped on a dialog. Run trees made before the credential gate was retired may still deny writes; [runbook §4.14](operator-runbook.md#414-an-old-run-folder-refuses-writes-after-the-credential-gate-was-retired) removes that.

Every other script is advanced or internal; tiers live in the [script capability inventory](agent-capability-wiring.md#script-capability-inventory).

## Inclusion rule

Eligible files: tracked Markdown knowledge/navigation files, `.github/pbi.kb/**/*.json` visual fixtures. Each appears once below or in explicit exclusions; CI's navigation-index gate enforces this.

## Indexed maps and direct entries

| Task | Path | Read when... |
|---|---|---|
| Start or route session | [`AGENTS.md`](../AGENTS.md) | Customer runtime: simple intake → private brief → task-tool builders → advisory comparison; explicit advanced package route. |
| Understand toolkit | [`README.md`](../README.md) | Project purpose and quick start. |
| Contribute safely | [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Issue-to-plan-review-to-PR lifecycle, status labels, mechanical exception and validation expectations. |
| Triage incoming issues | [`.github/workflows/issue-intake.md`](../.github/workflows/issue-intake.md) | Template review, cloud/local routing and plan/readiness-gated Copilot assignment; setup in CONTRIBUTING. |
| Open a focused PR | [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) | Behavioral/mechanical paths, plan-review evidence, validation exits and exact blind-reviewed head SHA. |
| Use VS Code Copilot | [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) | VS Code entry instructions. |
| Inspect operations canvas | [`.github/extensions/t2pbi-migration-ops/README.md`](../.github/extensions/t2pbi-migration-ops/README.md) | Existing manual assessment/wave tracking canvas; queuing does not execute work or supersede the current default route. |
| Script reference | [`scripts/README.md`](../scripts/README.md) | Simple start/resume and task records; advanced and internal script inventory. `test_repo_layout.py` owns completeness. |
| Capture migration feedback | [`.github/skills/migration-feedback/SKILL.md`](../.github/skills/migration-feedback/SKILL.md) | Explicit workbook/datasource or script/feature escalation: private evidence, controlled fictitious reproduction, engine/local/external/cannot-establish route; stops at `issue-payload.json`. |
| Author PBIR visuals | [`.github/pbi.kb/visual-cookbook.md`](../.github/pbi.kb/visual-cookbook.md) | Map of visual files with confidence tiers and Tableau idioms. |
| Inspect examples | [`examples/README.md`](../examples/README.md) | Map of example migrations, provenance, screenshots, and evidence files. |
| Browse showcase | [`docs/showcase/README.md`](../docs/showcase/README.md) | Map of rendered showcase outputs and variants. |
| Use upstream repros | [`fixtures/upstream-repros/README.md`](../fixtures/upstream-repros/README.md) | Map of fixtures, upstream issues, and pinned engine behavior. |
| Navigate migrations | [`migrations/README.md`](../migrations/README.md) | Map of workbook vs datasource migration folders. |
| Understand run directory layout | [`_runs/README.md`](../_runs/README.md) | Map of canonical run directory stages, lifecycle, and self-contained package isolation. |
| Check third-party notices | [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) | License/notice questions. |
| Handle conduct | [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Conduct/community questions. |
| Handle security reports | [`SECURITY.md`](../SECURITY.md) | Security disclosure routing. |
| Find migration guidance | [`docs/agent-architecture.md`](../docs/agent-architecture.md) | Root sessions, subagents, skill visibility. |
| Operate delegated agents | [`docs/agent-operations.md`](../docs/agent-operations.md) | Authority and evidence for monitoring claims, host V8-heap/Desktop RAM budgets and post-crash file forensics. |
| Find migration guidance | [`docs/agent-capability-wiring.md`](../docs/agent-capability-wiring.md) | Registry of shipped capabilities that must be visible to agents, and every script's core/advanced/internal tier. |
| Find migration guidance | [`docs/ai-instructions-authoring-guide.md`](../docs/ai-instructions-authoring-guide.md) | AI-instruction authoring redirect. |
| Find migration guidance | [`docs/capabilities-and-limitations.md`](../docs/capabilities-and-limitations.md) | Automation capability boundaries. |
| Review the unified CLI consensus | [`docs/cli-consensus/consensus.md`](cli-consensus/consensus.md) | Four independent designs plus one red-team report, synthesized into a narrow `t2p start`/`status` pilot, authority boundaries, path contract, deferrals and blind-run acceptance (Refs #734). |
| Review the CLI pilot plan | [`docs/t2p-pilot-plan.md`](t2p-pilot-plan.md) | Docs-only doctor/start/status plan; presence/source-only doctor, initially unknown_until_harvest, existing post-harvest/pre-conversion gate, no #751 dependency (Refs #749). |
| Find migration guidance | [`docs/customer-text-exposure.md`](../docs/customer-text-exposure.md) | Customer text/privacy exposure. |
| Find migration guidance | [`docs/data-source-credentials.md`](../docs/data-source-credentials.md) | Tableau/database/warehouse credentials. |
| Find migration guidance | [`docs/deterministic-tier-integration.md`](../docs/deterministic-tier-integration.md) | Engine and handoff integration. |
| Review Desktop observer consolidation | [`docs/desktop-observer-simplification.md`](desktop-observer-simplification.md) | Architecture census, observer alternatives and unverified deletion hypotheses; preserves real-row proof (Refs #741). |
| Find migration guidance | [`docs/dry-run-findings-2026-08-11.md`](../docs/dry-run-findings-2026-08-11.md) | Durable F00x dry-run findings. |
| Find migration guidance | [`docs/engine-gap-harvest.md`](../docs/engine-gap-harvest.md) | Attribute and classify the `reports/` vs `pbip/` delta into engine-gap evidence — provenance delegated to the `--tamper` gate's own adjudicator. |
| Find migration guidance | [`docs/migration-phases.md`](../docs/migration-phases.md) | Default simple handoff shape and explicit advanced three-phase pipeline; one unchanged run per invocation, not per workbook. |
| Find migration guidance | [`docs/migration-programme.md`](../docs/migration-programme.md) | Programme phases and operating model. |
| Find migration guidance | [`docs/migration-spec.md`](../docs/migration-spec.md) | `migration-spec.json` contract. |
| Find migration guidance | [`docs/operator-runbook.md`](../docs/operator-runbook.md) | Manual pipeline operation, the failure playbook, and §4.12 **Windows/PowerShell misreads** — `NativeCommandError` on a command that exited 0, long-path `Remove-Item`, `Start-Process -ArgumentList` mangling a multi-word `--workbook`, and `requests`+certifi failing TLS where the toolkit's `urllib` + Windows certificate store succeeds. |
| Test the offline deployment rehearsal | [`docs/offline-mock-harness.md`](offline-mock-harness.md) | Offline Tableau-to-Fabric mock harness and fidelity boundary. |
| Run the test suite | [`docs/parallel-test-loop.md`](parallel-test-loop.md) | Fast parallel loop vs the serial pre-PR gate. |
| Find migration guidance | [`docs/reference-capture.md`](../docs/reference-capture.md) | Tableau reference capture and evidence grading. |
| Find migration guidance | [`docs/reference-readiness.md`](../docs/reference-readiness.md) | Post-emission reference prerequisite for agentic work: completeness, evidence and grade; conversion/dispatch/fidelity boundaries. |
| Start ONE workbook | [`docs/start-with-one-workbook.md`](../docs/start-with-one-workbook.md) | Default local simple preparation without PAT, disclosed reference gaps and explicit same-run decisions; historical advanced manual conversion remains separate. |
| Find migration guidance | [`docs/review-remediation-plan.md`](../docs/review-remediation-plan.md) | Route validation/review findings. |
| Improve review throughput | [`docs/review-throughput-postmortem.md`](../docs/review-throughput-postmortem.md) | Dated review-round costs, causes and counterexamples; live review contract in `CONTRIBUTING.md`. |
| Find migration guidance | [`docs/tableau-dax-translation-guide.md`](../docs/tableau-dax-translation-guide.md) | Translate Tableau calcs/LODs/table calcs. |
| Find migration guidance | [`docs/tableau-map-to-azuremaps.md`](../docs/tableau-map-to-azuremaps.md) | Translate Tableau maps to Azure Maps. |
| Find migration guidance | [`docs/windows-path-limits.md`](../docs/windows-path-limits.md) | Windows MAX_PATH ceilings a shipped bundle must respect, how to DELETE a tree that is already over one (`\\?\` prefix plus a chmod handler, because git objects are read-only), and §6 the **measured `subst` fallback** for opening an over-ceiling PBIP in Desktop — temporary, same-user, never canonical, waives no path gate. |
| Find migration guidance | [`docs/upstream-issue-gate.md`](../docs/upstream-issue-gate.md) | Route engine issues upstream vs local. |
| Invoke subagent | [`.github/agents/dry-run-operator.agent.md`](../.github/agents/dry-run-operator.agent.md) | Full customer-shaped pipeline dry-run persona; read-only against the toolkit. |
| Invoke subagent | [`.github/agents/pbi-migration-validator.agent.md`](../.github/agents/pbi-migration-validator.agent.md) | Read-only fidelity validator persona. |
| Invoke subagent | [`.github/agents/pbi-report-builder.agent.md`](../.github/agents/pbi-report-builder.agent.md) | PBIR/report repair persona. |
| Invoke subagent | [`.github/agents/pbi-semantic-builder.agent.md`](../.github/agents/pbi-semantic-builder.agent.md) | TMDL/DAX/model repair persona. |
| Invoke subagent | [`.github/agents/tableau-migrator.agent.md`](../.github/agents/tableau-migrator.agent.md) | Workbook/datasource migration worker persona. |
| Use fixture | [`fixtures/large-refresh/README.md`](../fixtures/large-refresh/README.md) | Large refresh/cache behavior fixture. |
| Use fixture | [`tests/fixtures/check-gates-dirty/README.md`](../tests/fixtures/check-gates-dirty/README.md) | Dirty gate golden-output fixture. |
| Use fixture | [`tests/fixtures/connection-fidelity/README.md`](../tests/fixtures/connection-fidelity/README.md) | Silent live-source-to-flat-file downgrade fixture (issue #328). |
| Use fixture | [`tests/fixtures/datasource-field-parameter-page/README.md`](../tests/fixtures/datasource-field-parameter-page/README.md) | A standalone datasource that emits a real self-service page with visuals — the fail-open control for any kind-aware PBIP path-ceiling envelope. |

## Explicit exclusions
| Task | Path | Exclusion reason |
|---|---|---|
| Exclude self | [`docs/INDEX.md`](../docs/INDEX.md) | This registry would not help choose a next file. |
| Exclude test skill | [`.github/skills/sentinel-probe/SKILL.md`](../.github/skills/sentinel-probe/SKILL.md) | Test-only subagent skill-visibility sentinel. |

### PBIR visual files
Reason: indexed by `.github/pbi.kb/visual-cookbook.md`; it adds confidence tiers and Tableau idiom mapping.
Base: `.github/pbi.kb/visuals/`
```text
actionButton.md
actionButton.visual.json
areaChart.md
areaChart.visual.json
azureMap.md
card.md
card.visual.json
decompositionTreeVisual.md
decompositionTreeVisual.visual.json
donutChart.md
donutChart.visual.json
error-bars.md
error-bars.visual.json
forecast.md
funnel.md
funnel.visual.json
heatMap.md
heatMap.visual.json
hundredPercentStackedAreaChart.md
hundredPercentStackedAreaChart.visual.json
hundredPercentStackedColumnChart.md
hundredPercentStackedColumnChart.visual.json
keyDriversVisual.md
keyDriversVisual.visual.json
kpi.md
kpi.visual.json
lineClusteredColumnComboChart.md
lineClusteredColumnComboChart.visual.json
lineStackedColumnComboChart.md
lineStackedColumnComboChart.visual.json
multiRowCard.md
multiRowCard.visual.json
pieChart.md
pieChart.visual.json
reference-lines.md
reference-lines.visual.json
ribbonChart.md
ribbonChart.visual.json
shape.md
shape.visual.json
shapeMap.md
shapeMap.visual.json
smallmultiples.md
smallmultiples.visual.json
stackedAreaChart.md
stackedAreaChart.visual.json
step-line.md
table-cond-format.md
table-cond-format.visual.json
table-databars.md
table-databars.visual.json
textSlicer.md
treemap.md
treemap.visual.json
waterfallChart.md
waterfallChart.visual.json
zoom-slider.md
zoom-slider.visual.json
```

### Example evidence files
Reason: `examples/README.md` carries provenance, artifact context, screenshots, and nested evidence links.
Base: ``
```text
examples/electricity-per-capita/fabric/DISPOSITIONS.md
examples/fast-fashion-impact/fabric/DISPOSITIONS.md
examples/fast-fashion-impact/fabric/RELATIONSHIPS.md
examples/health-tracker/ai-instructions.md
examples/interactive-resume/fabric/DISPOSITIONS.md
examples/price-of-prosperity/fabric/DISPOSITIONS.md
examples/quadruple-axis-charts/report_build/PAGE-PLAN.md
examples/superstore-sales-performance/_brief/report-spec.md
examples/wind-energy-utilization/ai-instructions.md
```

### Showcase variants
Reason: `docs/showcase/README.md` carries showcase narrative, rendered images, and variant routing.
Base: ``
```text
docs/showcase/README-afterbefore.md
```

### Upstream repro notes
Reason: `fixtures/upstream-repros/README.md` carries issue mapping and pinned engine behavior.
Base: ``
```text
fixtures/upstream-repros/issue-166-custom-sql-disambiguation/README.md
fixtures/upstream-repros/issue-168-case-one-bad-branch/README.md
fixtures/upstream-repros/issue-171-measure-names-parameter/README.md
fixtures/upstream-repros/issue-194-long-pbir-path/README.md
fixtures/upstream-repros/issue-424-automatic-mark-discrete-date/README.md
```

### Migration folder READMEs
Reason: `migrations/README.md` routes workbook vs datasource migration folders.
Base: ``
```text
migrations/datasources/README.md
migrations/workbooks/README.md
```

### Repo-local skill docs
Reason: `AGENTS.md` indexes repo-local skills; the start-here block names when to invoke the per-layer skills.
Base: ``
```text
.github/skills/live-source-reachability/SKILL.md
.github/skills/pbip-model-refresh/SKILL.md
.github/skills/powerbi-ai-readiness/SKILL.md
.github/skills/powerbi-desktop-debugging/SKILL.md
```
The `scripts/t2p.py` facade is documented in
[`scripts/README.md`](../scripts/README.md#narrow-t2ppy-pilot-refs-749--773).
Default start uses simple/v1; explicit advanced commands preserve their existing authorities.
The historical [pilot plan](t2p-pilot-plan.md) describes the earlier advanced start,
not the current default. No facade command replaces dispatcher task tools or establishes fidelity.

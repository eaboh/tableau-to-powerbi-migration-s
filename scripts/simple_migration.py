"""
purpose: prepare one private, resumable Tableau-to-builder run without conversion or package gates.
usage:   python -B scripts/start_migration.py --mode single --style one-to-one
             --numeric none --workbook LUID --assessment skip
         python -B scripts/start_migration.py --resume ABSOLUTE_RUN [--decision ID=CHOICE]

Returns human/task-tool actions, not readiness, fidelity, completion or deployment certification.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
from typing import Any, Callable, Iterator

import harvest_estate_assets as harvest
import unit_ids
import work_dirs
from bundle_corpus import is_reparse_entry
from tableau_env import contains_credential, diagnose_env, engine_child_env, env_redactor
from tableau_oracle_manifest import read_manifest

ROOT = Path(__file__).resolve().parents[1]
ROUTE = "simple/v1"
CHOICES = ("retry", "replace", "skip", "continue", "accept")
AUTHOR_STAGES = ("semantic", "report", "comparison")


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Backend intake; t2p keeps a matching self-contained surface for installed help."""
    parser.add_argument("--mode", choices=("single", "batch"), help="explicit single or per-workbook batch")
    parser.add_argument("--style", choices=("one-to-one", "modernize"), help="explicit fidelity/design intent")
    parser.add_argument("--numeric", choices=("none", "required"), help="explicit numeric comparison scope")
    parser.add_argument("--workbook", action="append", help="selected exact workbook LUID or scoped name")
    parser.add_argument("--local", type=Path, action="append", help="local Tableau workbook, copied read-only")
    parser.add_argument("--assessment", choices=("run", "skip"), help="single may skip; batch assesses scope")
    parser.add_argument("--resume", type=Path, help="same absolute run, never a new allocation")
    parser.add_argument("--pbip", action="append", help="explicit WORKBOOK_KEY=existing.pbip mapping")
    parser.add_argument("--connection-example", type=Path, help="read-only PBIP with example M/TMDL connections")
    parser.add_argument("--target", action="append", help="explicit WORKBOOK_KEY:connection_field=target")
    parser.add_argument("--design", type=Path, help="human-approved modernization design")
    parser.add_argument("--decision", action="append", help="FINDING_ID=retry|replace|skip|continue|accept")
    parser.add_argument("--replacement", action="append", help="FINDING_ID=private replacement evidence path")
    parser.add_argument("--record", action="append", help="UNIT_ID:semantic|report|comparison=private task result JSON")
    parser.add_argument("--refresh-strategy", choices=("uia", "operator"), default=None)


def build_parser() -> argparse.ArgumentParser:
    """Standalone backend parser, sharing the installed facade's intake surface."""
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--project", help="one exact project; no implicit child projects")
    parser.add_argument("--env", type=Path)
    parser.add_argument("--runs-parent", type=Path)
    parser.add_argument("--session-id")
    parser.add_argument("--assess-only", action="store_true")
    parser.add_argument("--advanced", action="store_true", help="explicit legacy conversion (handled by front door)")
    add_arguments(parser)
    return parser


def _pairs(values: list[str] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values or []:
        key, separator, target = value.partition("=")
        if not separator or not key or not target or key in result or contains_credential(value):
            raise ValueError("invalid_or_duplicate_mapping; secrets must never be supplied in arguments")
        result[key] = target
    return result


def _read(path: Path) -> dict:
    _safe_path(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("object_required")
    return value


def _safe_path(path: Path) -> None:
    for component in (*reversed(path.absolute().parents), path.absolute()):
        if os.path.lexists(component) and is_reparse_entry(component.lstat()):
            raise ValueError("reparse_input_or_output_refused")


def _save(root: Path, state: dict) -> None:
    temporary = root / "run.json.tmp"
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(state, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    temporary.replace(root / "run.json")


@contextmanager
def _lock(root: Path) -> Iterator[None]:
    lock = root / "simple-route.lock"
    with lock.open("x", encoding="ascii") as stream:
        stream.write(str(os.getpid()))
    try:
        yield
    finally:
        lock.unlink()


def action(identifier: str, reason: str, *, choices: tuple[str, ...] = CHOICES, **fields: Any) -> dict:
    """An explicit human choice, not a rewritten native verdict."""
    return {"id": identifier, "kind": "human", "reason": reason, "choices": list(choices), **fields}


def _decision(state: dict, identifier: str) -> str | None:
    rows = [row for row in state["decisions"] if row["id"] == identifier]
    return rows[-1]["choice"] if rows else None


def _finding(state: dict, identifier: str, reason: str, *, mandatory: bool = False) -> dict | None:
    if mandatory:
        return action(identifier, reason, choices=("retry",), mandatory=True)
    choice = _decision(state, identifier)
    if choice in {"skip", "continue", "accept"}:
        limitation = f"{identifier}: {reason}; human chose {choice}; evidence remains unverified"
        if limitation not in state["limitations"]:
            state["limitations"].append(limitation)
        return None
    return action(identifier, reason)


def _child(command: list[str], environment: dict[str, str]) -> int:
    """Native child diagnostics remain private in the run, never copied into a JSON response."""
    with Path(environment["T2P_SIMPLE_LOG"]).open("x", encoding="utf-8") as log:
        return subprocess.run(command, env=environment, cwd=ROOT, stdout=log, stderr=log, check=False).returncode


def _native_safety_stop(name: str, artifact: Path, code: int) -> bool:
    if name not in {"assessment", "assessment_report"} and not name.startswith("reference:"):
        return False
    if not artifact.is_file():
        return name != "assessment_report" and code != 0
    if name == "assessment":
        return any(row.get("status") in {401, 403} for row in _read(artifact).get("listing_errors", []))
    if name.startswith("reference:"):
        native = read_manifest(artifact)
        if native.get("credential_blocked", 0):
            return True
        return any(
            leg.get("status") in {"source_credential", "session_lost", "credential_reflected"}
            or re.match(r"^(?:HTTP\s+)?(?:401|403)\b", leg.get("error", ""))
            for view in native.get("views", [])
            for key in ("data", "image", "svg", "pdf")
            if isinstance(leg := view.get(key), dict)
        )
    return False


# The stage composition is intentionally local rather than a new workflow/receipt framework.
# pylint: disable=too-many-arguments,too-many-positional-arguments,too-many-return-statements,too-many-locals,too-many-branches
def _stage(
    root: Path,
    state: dict,
    name: str,
    command: list[str],
    environment: dict[str, str],
    artifact: Path,
    runner: Callable[[list[str], dict[str, str]], int],
) -> dict | None:
    previous = state["stages"].get(name)
    choice = _decision(state, name)
    _safe_path(artifact)
    if previous and previous.get("mandatory_stop") and choice not in {"retry", "replace"}:
        return action(
            name, "mandatory_safety_stop_requires_manual_remediation", choices=("retry", "replace"), mandatory=True
        )
    if choice == "replace":
        replacement = state["replacements"].get(name)
        if replacement and Path(replacement).is_file() and not Path(replacement).is_symlink():
            state["stages"][name] = {
                "state": "replacement",
                "native_exit_code": previous.get("native_exit_code") if previous else None,
                "artifact": replacement,
            }
            state["limitations"].append(f"{name}: supplied replacement, not native success or validation")
            return None
        return action(name, "replacement_evidence_required")
    if previous is not None and choice != "retry":
        if previous["state"] in {"ok", "replacement"}:
            recorded = Path(previous["artifact"])
            _safe_path(recorded)
            if recorded.is_file() and (name != "assessment_report" or recorded == artifact):
                return None
            if not recorded.is_file():
                return _finding(state, name, "successful_stage_artifact_missing")
        else:
            return _finding(state, name, "native_stage_findings")
    if choice == "skip":
        state["stages"].setdefault(name, {"state": "skipped", "native_exit_code": None, "artifact": None})
        return _finding(state, name, "stage_skipped")
    if artifact.exists():
        if previous and choice == "retry" and "--out" in command:
            attempt = len(previous.get("attempts", [])) + 2
            destination = artifact.parent / f"attempt-{attempt}"
            command = list(command)
            command[command.index("--out") + 1] = str(destination)
            artifact = destination / artifact.name
            if destination.exists():
                return action(name, "existing_retry_destination_preserved; manually_remediate")
        else:
            return action(name, "existing_evidence_preserved; supply replacement or manually remediate")
    scratch = root / "scratch"
    scratch.mkdir(exist_ok=True)
    log_stem = name.replace(":", "-")
    attempt = 1 + len(list(scratch.glob(f"{log_stem}-*.log")))
    log = scratch / f"{log_stem}-{attempt}.log"
    code = runner(command, {**environment, "T2P_SIMPLE_LOG": str(log)})
    state["stages"][name] = {
        "state": "ok" if code == 0 and artifact.is_file() else "findings",
        "native_exit_code": code,
        "artifact": str(artifact),
        "diagnostic_log": str(log),
        "attempts": [
            *previous.get("attempts", []),
            {key: value for key, value in previous.items() if key != "attempts"},
        ]
        if previous
        else [],
    }
    if _native_safety_stop(name, artifact, code):
        state["stages"][name]["mandatory_stop"] = True
    # Consume a retry: future resumes must not replay it automatically.
    if choice == "retry":
        state["decisions"].append({"id": name, "choice": "attempted"})
    _save(root, state)
    if state["stages"][name].get("mandatory_stop"):
        return action(
            name,
            "authorization_or_unclassified_native_failure; inspect_private_diagnostic_log",
            choices=("retry", "replace"),
            mandatory=True,
            diagnostic_log=str(log),
        )
    return None if state["stages"][name]["state"] == "ok" else _finding(state, name, "native_stage_findings")


# pylint: enable=too-many-arguments,too-many-positional-arguments,too-many-return-statements,too-many-locals,too-many-branches
def _intake(args: argparse.Namespace, state: dict) -> list[dict]:
    choices = state["intake"]
    for key in ("mode", "style", "numeric", "assessment", "refresh_strategy", "project", "design"):
        value = getattr(args, key)
        value = str(value.expanduser().absolute()) if isinstance(value, Path) else value
        if value is not None:
            selection_pending = not state.get("selection", {}).get("selection_complete")
            if (
                key in choices
                and choices[key] != value
                and key != "design"
                and not (key == "project" and selection_pending and "sources" not in state["stages"])
            ):
                raise ValueError("resume_intake_change_refused; keep the same commissioned scope")
            choices[key] = value
    for key in ("workbook", "local"):
        value = getattr(args, key)
        if value:
            selected = [str(item.expanduser().absolute()) if isinstance(item, Path) else item for item in value]
            if (
                key in choices
                and choices[key] != selected
                and (state.get("selection", {}).get("selection_complete") or "sources" in state["stages"])
            ):
                raise ValueError("resume_scope_change_refused")
            choices[key] = selected
    choices.setdefault("refresh_strategy", "uia")
    missing = [
        action(f"intake:{key}", "explicit_intake_choice_required", choices=options)
        for key, options in (
            ("mode", ("single", "batch")),
            ("style", ("one-to-one", "modernize")),
            ("numeric", ("none", "required")),
        )
        if key not in choices
    ]
    if choices.get("mode") == "batch":
        if choices.get("assessment") == "skip":
            raise ValueError("batch_requires_scoped_assessment")
        choices.setdefault("assessment", "run")
    elif choices.get("mode") == "single":
        if "assessment" not in choices:
            missing.append(action("intake:assessment", "single_assessment_choice_required", choices=("run", "skip")))
        if len(choices.get("workbook", [])) + len(choices.get("local", [])) > 1:
            raise ValueError("single_requires_exactly_one_workbook")
    if not choices.get("workbook") and not choices.get("local") and not choices.get("project"):
        missing.append(action("intake:scope", "select_exact_workbook_or_project", choices=()))
    return missing


def _active_mappings(state: dict, field: str) -> dict:
    prefix = "mapping" if field == "pbips" else "target"
    return {key: value for key, value in state[field].items() if _decision(state, f"{prefix}:{key}") != "skip"}


def _apply_inputs(args: argparse.Namespace, state: dict) -> None:
    for field, values in (("pbips", args.pbip), ("targets", args.target), ("replacements", args.replacement)):
        for key, value in _pairs(values).items():
            if field in {"pbips", "replacements"}:
                value = str(Path(value).expanduser().absolute())
            if key in state[field] and state[field][key] != value and field != "replacements":
                identity = key.rpartition(":")[0] if field == "targets" else key
                if any("working" in row and identity in {row["key"], row.get("luid")} for row in state["units"]):
                    raise ValueError("existing_authored_mapping_change_refused")
            state[field][key] = value
    for key in state["targets"]:
        identity, separator, field = key.rpartition(":")
        if not identity or not separator or field not in {"server", "warehouse", "database", "schema"}:
            raise ValueError("target_requires_workbook_key_and_supported_connection_field")
    if args.connection_example:
        example = str(args.connection_example.expanduser().absolute())
        previous = state.get("connection_example")
        if previous not in {None, example} and (
            "connection_inspection" in state or any("working" in row for row in state["units"])
        ):
            raise ValueError("connection_example_change_refused")
        if previous not in {None, example} and previous not in state.get("connection_example_history", []):
            state.setdefault("connection_example_history", []).append(previous)
        state["connection_example"] = example
    for identifier, choice in _pairs(args.decision).items():
        if choice not in CHOICES:
            raise ValueError("unsupported_human_decision")
        state["decisions"].append({"id": identifier, "choice": choice})


def _record_results(args: argparse.Namespace, root: Path, state: dict) -> None:
    for key, path in _pairs(args.record).items():
        identity, separator, stage = key.partition(":")
        if not separator or stage not in AUTHOR_STAGES or identity not in {u["id"] for u in state["units"]}:
            raise ValueError("record_requires_existing_unit_and_authoring_stage")
        evidence = Path(path).expanduser().absolute()
        if not evidence.is_relative_to(root) or evidence.is_symlink():
            raise ValueError("task_result_requires_private_run_owned_file")
        result = _read(evidence)
        if result.get("state") not in {"authored", "findings", "failed", "compared"}:
            raise ValueError("native_task_result_state_required")
        code = result.get("native_exit_code")
        if code is not None and (not isinstance(code, int) or isinstance(code, bool)):
            raise ValueError("native_exit_code_required")
        previous = state["stages"].get(key)
        state["stages"][key] = {
            "state": result["state"],
            "native_exit_code": code,
            "artifact": str(evidence),
            "attempts": [
                *previous.get("attempts", []),
                {field: value for field, value in previous.items() if field != "attempts"},
            ]
            if previous
            else [],
        }
        if result.get("mandatory_stop"):
            state["stages"][key]["mandatory_stop"] = True
        unit = next(row for row in state["units"] if row["id"] == identity)
        if "working" not in unit:
            raise ValueError("authoring_result_before_working_handoff_refused")
        _record_artifacts(root, unit, stage, result.get("artifacts", {}))
        if _decision(state, key) == "retry":
            state["decisions"].append({"id": key, "choice": "attempted"})


def _record_artifacts(root: Path, unit: dict, stage: str, updates: dict) -> None:
    allowed = {"semantic_model", "project_file"} if stage == "semantic" else {"report", "project_file"}
    if stage == "comparison" and updates:
        raise ValueError("validator_cannot_author_artifacts")
    if not isinstance(updates, dict) or not set(updates) <= allowed:
        raise ValueError("task_artifact_layer_ownership_refused")
    for role, value in updates.items():
        if not isinstance(value, str) or Path(value).is_absolute():
            raise ValueError("task_artifact_requires_run_relative_path")
        artifact = Path(os.path.abspath(root / value))
        _safe_path(artifact)
        working_root = Path(unit["working"]["root"])
        if not artifact.is_relative_to(working_root) or not artifact.exists():
            raise ValueError("task_artifact_requires_existing_run_owned_path")
        unit["working"][role] = str(artifact)
    if updates:
        unit_ids.set_unit_artifacts(root, unit["id"], updates)


def _brief(root: Path, state: dict, unit: dict) -> Path:
    folder = root / "assessment" / "briefs" / unit["id"]
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "migration-brief.md"
    reference = state["stages"].get(f"reference:{unit['id']}")
    reference_evidence = None
    if reference and reference.get("artifact") and Path(reference["artifact"]).is_file():
        _safe_path(Path(reference["artifact"]))
        reference_evidence = read_manifest(Path(reference["artifact"]))
    brief = {
        "route": ROUTE,
        "run": str(root),
        "unit": unit["id"],
        "intake": state["intake"],
        "source": unit,
        "connections": {
            "example": state.get("connection_example"),
            "inspection": state.get("connection_inspection"),
            "targets": {
                key: value
                for key, value in _active_mappings(state, "targets").items()
                if key.rpartition(":")[0] in {unit["key"], unit.get("luid")}
            },
            "owner": "pbi-semantic-builder",
        },
        "oracle": reference,
        "reference_grades_and_capabilities": reference_evidence,
        "accepted_limitations": state["limitations"],
        "decisions": state["decisions"],
        "comparison": "independent, advisory; preserve discrepancies, never self-issue COMPLETE",
        "custody": "author only run-owned working paths; inputs/examples read-only",
    }
    # This is intake/evidence navigation, not an authority receipt.
    text = (
        f"---\nschema_version: simple-brief/v1\nunit: {unit['id']}\nroute: {ROUTE}\n---\n\n"
        "# Private builder brief\n\n```json\n" + json.dumps(brief, indent=2, ensure_ascii=False) + "\n```\n"
    )
    path.write_text(text, encoding="utf-8")
    return path


def _builder_actions(root: Path, state: dict) -> list[dict]:
    # pylint: disable=too-many-branches
    actions: list[dict] = []
    for unit in state["units"]:
        if unit.get("skipped"):
            continue
        brief = _brief(root, state, unit)
        for stage, owner in (
            ("semantic", "pbi-semantic-builder"),
            ("report", "pbi-report-builder"),
            ("comparison", "pbi-migration-validator"),
        ):
            if stage == "semantic" and not unit["model_work_needed"]:
                continue
            key = f"{unit['id']}:{stage}"
            outcome = state["stages"].get(key)
            choice = _decision(state, key)
            if outcome and outcome.get("mandatory_stop"):
                actions.append(action(key, "mandatory_safety_stop_requires_manual_remediation", choices=("retry",)))
                break
            completed = (
                outcome and outcome["state"] in {"authored", "compared"} and outcome["native_exit_code"] in {0, None}
            )
            artifact = unit["working"].get("semantic_model" if stage == "semantic" else "report")
            completed = completed and choice != "retry"
            if completed and stage != "comparison" and (not artifact or not Path(artifact).is_dir()):
                finding = _finding(state, key, "authored_result_has_no_existing_owned_artifact")
                if finding:
                    actions.append(finding)
                    break
            if completed:
                continue
            if choice in {"accept", "continue", "skip"}:
                _finding(state, key, "authoring_or_comparison_not_verified")
                continue
            if outcome and choice != "retry":
                actions.append(action(key, "native_builder_findings; route discrepancies to owning layer"))
                break
            if stage == "report" and state["intake"]["style"] == "modernize" and not state["intake"].get("design"):
                actions.append(action(key, "modernization_requires_human_approved_design", choices=("replace", "skip")))
                break
            if stage == "report":
                model = unit["working"].get("semantic_model")
                cache = Path(model) / ".pbi" / "cache.abf" if model else None
                if cache is None or not cache.is_file():
                    finding = _finding(
                        state,
                        f"cache:{unit['id']}",
                        "no_warm_cache; explicit_human_acceptance_required_for_offline_report_authoring",
                    )
                    if finding:
                        actions.append(finding)
                        break
            actions.append(
                {
                    "id": key,
                    "kind": "task",
                    "owner": owner,
                    "run": str(root),
                    "unit": unit["id"],
                    "brief": str(brief),
                    "working": unit["working"],
                    "reason": "advisory_independent_comparison" if stage == "comparison" else "author_owned_layer",
                }
            )
            break
    return actions


def _prepare_working(root: Path, state: dict) -> None:
    # pylint: disable=too-many-branches
    import simple_pbip  # pylint: disable=import-outside-toplevel

    if state.get("connection_example") and "connection_inspection" not in state:
        state["connection_inspection"] = simple_pbip.inspect_connections(Path(state["connection_example"]))
    pbips = _active_mappings(state, "pbips")
    targets = _active_mappings(state, "targets")
    for key in state["pbips"].keys() - pbips.keys():
        _finding(state, f"mapping:{key}", "supplied_mapping_not_applied")
    for key in state["targets"].keys() - targets.keys():
        _finding(state, f"target:{key}", "supplied_target_not_applied")
    known = {row["key"] for row in state["units"]} | {row.get("luid") for row in state["units"]}
    if any(key not in known for key in pbips) or any(key.rpartition(":")[0] not in known for key in targets):
        raise ValueError("mapping_does_not_match_selected_workbook_identity")
    for unit in state["units"]:
        aliases = {unit["key"], unit.get("luid")}
        if len({path for key, path in pbips.items() if key in aliases}) > 1:
            raise ValueError("conflicting_workbook_PBIP_mappings")
        for field in ("server", "warehouse", "database", "schema"):
            if (
                len(
                    {
                        value
                        for key, value in targets.items()
                        if key.rpartition(":")[0] in aliases and key.rpartition(":")[2] == field
                    }
                )
                > 1
            ):
                raise ValueError("conflicting_connection_targets")
        if "working" in unit:
            if Path(unit["working"]["root"]) != root / "deliverables" / unit["id"]:
                raise ValueError("working_tree_custody_mismatch")
            for role in ("root", *unit_ids.ARTIFACT_ROLES):
                if unit["working"].get(role):
                    _safe_path(Path(unit["working"][role]))
            unit["model_work_needed"] = (
                unit["model_work_needed"]
                or bool(state.get("connection_example"))
                or any(key.rpartition(":")[0] in aliases for key in targets)
            )
            continue
        destination = root / "deliverables" / unit["id"]
        supplied = pbips.get(unit["key"]) or pbips.get(unit.get("luid"))
        if supplied:
            unit["working"] = simple_pbip.copy_pbip(Path(supplied), destination)
        else:
            if destination.exists():
                raise ValueError("existing_authored_destination_preserved")
            destination.mkdir(parents=True)
            unit["working"] = {"root": str(destination), "project_file": None, "report": None, "semantic_model": None}
        unit["model_work_needed"] = (
            not (unit["working"].get("semantic_model") and Path(unit["working"]["semantic_model"]).is_dir())
            or bool(state.get("connection_example"))
            or any(key.rpartition(":")[0] in aliases for key in targets)
        )
        artifacts = {}
        for role in unit_ids.ARTIFACT_ROLES:
            value = unit["working"].get(role)
            if value:
                artifacts[role] = (destination / Path(value)).relative_to(root).as_posix()
        if artifacts:
            unit_ids.set_unit_artifacts(root, unit["id"], artifacts)
        _save(root, state)


def _execute(
    args: argparse.Namespace,
    root: Path,
    state: dict,
    runner: Callable[[list[str], dict[str, str]], int],
) -> list[dict]:
    # pylint: disable=too-many-locals,too-many-return-statements,too-many-branches,too-many-statements
    actions = _intake(args, state)
    _apply_inputs(args, state)
    _record_results(args, root, state)
    _save(root, state)
    if actions:
        return actions
    intake = state["intake"]
    env, diagnostic = diagnose_env(args.env, explicit=args.env != ROOT / ".env")
    remote = not intake.get("local")
    if remote and diagnostic["status"] != "READY_TO_ATTEMPT":
        return [
            action(
                "configuration",
                "Can the human configure the Tableau PAT securely in environment/ignored .env?",
                choices=("retry",),
                mandatory=True,
                diagnostic=diagnostic,
            )
        ]
    child_env = engine_child_env(env)
    import prepare_tableau_source  # pylint: disable=import-outside-toplevel

    selection = state.get("selection")
    if selection is None or (
        not selection.get("selection_complete")
        and any((_decision(state, "selection") == "retry", args.workbook, args.project, args.local))
    ):
        selection = prepare_tableau_source.resolve_selection(
            env,
            project=intake.get("project"),
            workbooks=intake.get("workbook"),
            local_sources=[Path(path) for path in intake.get("local", [])],
        )
        state["selection"] = selection
        state["stages"]["selection"] = {
            "state": selection["state"],
            "native_exit_code": selection.get("native_exit_code"),
            "artifact": None,
        }
        raw_units = [row for row in selection.get("units", []) if row["kind"] == "workbook"]
        requests = [
            unit_ids.UnitRequest(
                key=row["key"],
                kind="workbook",
                name=row["name"],
                luid=row.get("luid"),
                project_luid=row.get("project_luid"),
                project_name=row.get("project_name"),
            )
            for row in raw_units
        ]
        allocated = unit_ids.allocate_unit_ids(root, requests)
        existing = {row["key"]: row for row in state["units"]}
        state["units"] = [
            {**existing.get(row["key"], {}), **row, "id": allocated[index]["id"]} for index, row in enumerate(raw_units)
        ]
        _save(root, state)
    if not selection.get("selection_complete"):
        return selection.get("actions") or [action("selection", "exact_source_selection_required", choices=("retry",))]
    if not state["units"]:
        actions.append(action("sources", "no_selected_workbooks; supply sources or manually remediate"))
    if intake["mode"] == "single" and len(state["units"]) != 1:
        actions.append(action("selection", "single_requires_one_exact_workbook", choices=()))
    if actions:
        return actions
    if intake["assessment"] == "run":
        assessment = root / "assessment" / "assessment.json"
        command = [
            sys.executable,
            "-B",
            str(ROOT / "scripts" / "assess_estate.py"),
            "--env",
            str(args.env),
            "--out",
            str(root / "assessment"),
        ]
        if intake.get("project"):
            command.extend(["--project", intake["project"]])
        for unit in state["units"]:
            if unit.get("luid"):
                command.extend(["--workbook", unit["luid"]])
        if not remote:
            finding = _finding(state, "assessment", "local_inputs_have_no_server_assessment; choose skip or continue")
        else:
            finding = _stage(root, state, "assessment", command, child_env, assessment, runner)
        if finding:
            return [finding]
        if state["stages"].get("assessment", {}).get("artifact"):
            assessment = Path(state["stages"]["assessment"]["artifact"])
        if assessment.is_file():
            report = assessment.parent / "assessment-report.html"
            finding = _stage(
                root,
                state,
                "assessment_report",
                [
                    sys.executable,
                    "-B",
                    str(ROOT / "scripts" / "assessment_report.py"),
                    "--run",
                    str(assessment.parent),
                    "--without-survey",
                ],
                child_env,
                report,
                runner,
            )
            if finding:
                return [finding]
    else:
        state["stages"].setdefault("assessment", {"state": "skipped", "native_exit_code": None, "artifact": None})
    previous = state["stages"].get("sources", {})
    native_actions = previous.get("actions", [])
    identifiers = {
        "sources",
        *(item["id"] for item in native_actions),
        *(f"source:{row['id']}" for row in state["units"]),
    }
    retry = any(_decision(state, key) == "retry" for key in identifiers)
    replace = any(_decision(state, key) == "replace" for key in identifiers)
    skip = [row["key"] for row in state["units"] if _decision(state, f"source:{row['id']}") == "skip"]
    skip.extend(
        item["source_key"]
        for item in native_actions
        if item.get("source_key") and _decision(state, item["id"]) == "skip"
    )
    continued = any(_decision(state, key) in {"continue", "accept"} for key in identifiers)
    source_choice_changed = bool(set(_pairs(args.decision)) & identifiers or args.replacement)
    if not previous or retry or (source_choice_changed and any((replace, skip, continued))):
        replacements = {key: Path(path) for key, path in state["replacements"].items()}
        for item in native_actions:
            if item.get("replacement_key") and item["id"] in replacements:
                replacements[item["replacement_key"]] = replacements.pop(item["id"])
        prepared = prepare_tableau_source.prepare_sources(
            root,
            env,
            project=intake.get("project"),
            workbooks=intake.get("workbook"),
            local_sources=[Path(path) for path in intake.get("local", [])],
            selection=selection,
            retry=retry,
            replacements=replacements,
            skip=skip,
            continue_with_limitations=continued,
        )
        state["stages"]["sources"] = prepared
        for key in identifiers:
            if _decision(state, key) == "retry":
                state["decisions"].append({"id": key, "choice": "attempted"})
        by_key = {row["key"]: row for row in prepared.get("units", []) if row["kind"] == "workbook"}
        state["units"] = [
            {
                **row,
                **by_key.get(row["key"], {}),
                "id": row["id"],
                **(
                    {"working": row["working"], "model_work_needed": row["model_work_needed"]}
                    if "working" in row
                    else {}
                ),
            }
            for row in state["units"]
        ]
        _save(root, state)
    prepared = state["stages"]["sources"]
    for finding in prepared.get("actions", []):
        identifier = finding.get("id", "sources")
        mandatory = finding.get("mandatory") or finding.get("mandatory_stop")
        if mandatory or _finding(state, identifier, finding.get("reason", "source_preparation_incomplete")):
            actions.append(finding)
    for unit in state["units"]:
        unit["skipped"] = unit.get("state") == "skipped" or unit["key"] in skip
        if not unit["skipped"] and unit.get("state") not in {"prepared", "limited", "ok"}:
            finding = _finding(state, f"source:{unit['id']}", "source_spec_missing_or_incomplete")
            if finding:
                actions.append(finding)
    if actions:
        return actions
    pbips = _active_mappings(state, "pbips")
    if pbips:
        for unit in state["units"]:
            if not (pbips.get(unit["key"]) or pbips.get(unit.get("luid"))):
                finding = _finding(state, f"mapping:{unit['id']}", "supply_explicit_PBIP_mapping_or_choose_greenfield")
                if finding:
                    actions.append(finding)
    if actions:
        return actions
    state["limitations"] = list(
        dict.fromkeys(
            [
                *state["limitations"],
                "Optional engine survey/admin-insight evidence not collected on the simple route",
                "Desktop rendering, refresh, persistence and numeric/visual fidelity "
                "are not established by preparation",
            ]
        )
    )
    for unit in state["units"]:
        if unit.get("skipped"):
            continue
        name = f"reference:{unit['id']}"
        if not unit.get("luid"):
            finding = _finding(state, name, "local_source_has_no_authenticated_Tableau_reference")
        else:
            destination = root / "oracle" / unit["id"]
            finding = _stage(
                root,
                state,
                name,
                [
                    sys.executable,
                    "-B",
                    str(ROOT / "scripts" / "capture_tableau_oracle.py"),
                    "--env",
                    str(args.env),
                    "--out",
                    str(destination),
                    "--workbook-id",
                    unit["luid"],
                ],
                child_env,
                destination / "oracle-manifest.json",
                runner,
            )
        if finding:
            actions.append(finding)
    if actions:
        return actions
    _prepare_working(root, state)
    return _builder_actions(root, state)


def main(
    argv: list[str] | None = None,
    *,
    observer: Callable[[dict], None] | None = None,
    runner: Callable[[list[str], dict[str, str]], int] = _child,
) -> int:
    """Allocate or resume exactly one private run and return the next native actions."""
    args = build_parser().parse_args(argv)
    root: Path | None = None
    try:
        if args.resume:
            root = args.resume.expanduser().absolute()
            state = _read(root / "run.json")
            if not args.resume.is_absolute() or work_dirs.check_run_location(state, root).state != "intact":
                raise ValueError("resume_requires_intact_absolute_run")
            if state.get("route") != ROUTE:
                raise ValueError("simple_resume_cannot_reuse_advanced_run")
            if args.env is not None and str(args.env.expanduser().absolute()) != state["env"]:
                raise ValueError("resume_environment_selection_change_refused")
            args.env = Path(state["env"])
        else:
            args.env = (args.env or ROOT / ".env").expanduser().absolute()
            if args.session_id:
                uuid.UUID(args.session_id)
            candidate = work_dirs.runs_root(args.runs_parent) / "000-simple"
            if harvest.refuse_unignored_output(
                candidate,
                None,
                artifacts=(
                    "run.json",
                    "assets/source.json",
                    "deliverables/report.pbip",
                    "assessment/briefs/unit/migration-brief.md",
                    "oracle/oracle-manifest.json",
                ),
            ):
                raise ValueError("private_output_guard_refused")
            attribution = {"session_id": args.session_id, "status": "recorded" if args.session_id else "unknown"}
            state = {
                "route": ROUTE,
                "intake": {},
                "stages": {},
                "decisions": [],
                "limitations": [],
                "units": [],
                "pbips": {},
                "targets": {},
                "replacements": {},
                "attribution": attribution,
                "env": str(args.env),
            }
            run = work_dirs.allocate_run(args.project or "tableau", repo_root=args.runs_parent, extra_manifest=state)
            root = run.root.absolute()
            state = _read(root / "run.json")
        if observer:
            observer({"event": "allocated", "run": str(root), "output_guard": "passed"})
        _safe_path(root)
        if harvest.refuse_unignored_output(root, None, artifacts=("run.json", "deliverables/report.pbip")):
            raise ValueError("private_output_guard_refused")
        with _lock(root):
            actions = _execute(args, root, state, runner)
            state["actions"] = actions
            _save(root, state)
        result = {
            "route": ROUTE,
            "run": str(root),
            "actions": actions,
            "stages": state["stages"],
            "limitations": state["limitations"],
            "certification": "NOT_CHECKED",
        }
        if observer:
            observer({"event": "simple", **result})
        print(json.dumps(result, ensure_ascii=False))
        return 3 if any(item["kind"] == "human" for item in actions) else 0
    except (OSError, ValueError, RuntimeError, unit_ids.UnitIdError) as exc:
        result = {
            "route": ROUTE,
            "run": str(root) if root else None,
            "actions": [
                action("safety", f"operation_refused:{type(exc).__name__}", choices=("retry",), mandatory=True)
            ],
            "certification": "NOT_CHECKED",
        }
        print(json.dumps(result))
        redact = env_redactor(dict(os.environ))
        print(f"Simple route refused: {type(exc).__name__}: {redact(str(exc))}", file=sys.stderr)
        if observer:
            observer({"event": "simple", **result})
        return 1


def status_observations(root: Path, state: dict) -> dict:
    """Read-only projection; never resume, allocate, certify or generate a brief."""
    actions = state.get("actions", [])
    units = []
    for row in state.get("units", []):
        unit_actions = [item for item in actions if item.get("unit") == row["id"]]
        units.append(
            {
                "id": row["id"],
                "name": row["name"],
                "kind": "workbook",
                "scope": "selected",
                "stage": unit_actions[0]["id"].partition(":")[2] if unit_actions else "human_or_recorded",
                "working_package": row.get("working", {}).get("root"),
                "generated_working_copy": "supplied_copy"
                if row.get("working", {}).get("project_file")
                else "greenfield",
                "handover": "simple_private_brief",
                "occurrences": [],
                "package": None,
                "current_certification": "NOT_CHECKED",
            }
        )
    next_action = {
        "kind": actions[0]["kind"] if actions else "human",
        "owner": actions[0].get("owner", "dispatcher") if actions else "dispatcher",
        "headline": actions[0].get("reason", "review_action")
        if actions
        else "Review recorded authoring and limitations",
        "gate": None,
        "command": None,
        "affected_units": [item["unit"] for item in actions if item.get("unit")],
    }
    return {
        "route": ROUTE,
        "run_recorded_status": "active",
        "inventory_scope": "selected_workbooks",
        "scope_denominator": len(units),
        "canonical_subdirs": {
            name: "present" if (root / name).is_dir() else "missing" for name in work_dirs.CANONICAL_SUBDIRS
        },
        "child_evidence": {name: stage.get("state") for name, stage in state.get("stages", {}).items()},
        "units": units,
        "findings": [],
        "unscoped_packages": [],
        "recorded_phases": [],
        "next_action": next_action,
        "human_actions": actions,
        "limitations": state.get("limitations", []),
        "current_certification": "NOT_CHECKED",
    }

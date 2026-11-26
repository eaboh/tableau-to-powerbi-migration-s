"""Thin, resumable Tableau source preparation; never invokes the conversion engine.

``prepare_sources`` writes private source/spec/provenance receipts under the caller's
run. A failed stage is retried only with ``retry=True``. Successful artifacts are
never overwritten; replacement inputs get a separate folder. These receipts prove
source preparation, not assessment, source connectivity, or migration fidelity.
"""

# Native parser, transport and filesystem exceptions are persisted at stage boundaries.
# pylint: disable=broad-exception-caught

from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from capture_tableau_oracle import DEFAULT_REST_API_VERSION, RetryPolicy, SiteCredentials, TableauSession
from harvest_estate_assets import refuse_unignored_output
from parse_tableau import parse_workbook
from stamp_tableau_provenance import fingerprint
from tableau_env import pat_secret, redact, server_url
from tableau_inventory import list_inventory, select_project, select_workbook


class PreparationError(RuntimeError):
    """A native preparation failure with a human-owned recovery route."""

    def __init__(self, message: str, *, mandatory: bool = False, native_exit_code: int = 1) -> None:
        super().__init__(message)
        self.mandatory = mandatory
        self.native_exit_code = native_exit_code


def _key(kind: str, identity: str) -> str:
    component = (
        identity
        if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identity)
        else hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
    )
    return f"{kind}-{component}"


def _json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _private(path: Path, root: Path) -> None:
    if not path.resolve().is_relative_to(root):
        raise PreparationError("Run-owned output escapes the run folder; choose a private run.", mandatory=True)
    if refuse_unignored_output(
        path, None, artifacts=("source.twb", "migration-spec.json", "provenance.json", "receipt.json")
    ):
        raise PreparationError("Output is not git-ignored; choose a private ignored run folder.", mandatory=True)


def _failure(exc: Exception, env: dict[str, str], *, session: TableauSession | None = None) -> dict:
    detail = redact(str(exc), pat_secret(env), env.get("TABLEAU_PAT_NAME", ""))
    if session:
        detail = session.redact_text(detail)
    status = getattr(exc, "native_exit_code", 1)
    mandatory = getattr(exc, "mandatory", False)
    match = re.search(r"HTTP\s+(\d+)", detail)
    if match:
        status = int(match.group(1))
        mandatory = mandatory or status in (401, 403)
    finding = {
        "kind": type(exc).__name__,
        "detail": detail,
        "native_exit_code": status,
        "mandatory": mandatory,
        "actions": ["human_secure_configuration", "retry_after_human_resolution"]
        if mandatory
        else ["retry", "replacement", "skip", "continue_with_limitations"],
    }
    if hasattr(exc, "candidates"):
        candidates = json.dumps(getattr(exc, "candidates"), ensure_ascii=False)
        if session:
            candidates = session.redact_text(candidates)
        finding["candidates"] = json.loads(redact(candidates, pat_secret(env), env.get("TABLEAU_PAT_NAME", "")))
    if hasattr(exc, "replacement_key"):
        finding["replacement_key"] = getattr(exc, "replacement_key")
    return finding


def _session(env: dict[str, str]) -> TableauSession:
    if not server_url(env) or not env.get("TABLEAU_PAT_NAME") or not pat_secret(env) or "TABLEAU_SITE" not in env:
        raise PreparationError(
            "A human must configure TABLEAU_SERVER_URL, TABLEAU_SITE (empty for the default site), "
            "TABLEAU_PAT_NAME and TABLEAU_PAT_SECRET in the ignored environment file or process environment. "
            "Never put credentials in command arguments or receipts.",
            mandatory=True,
        )
    parts = urlsplit(server_url(env))
    if parts.scheme != "https" or not parts.hostname:
        raise PreparationError("Configure a secure HTTPS Tableau server URL.", mandatory=True)
    if parts.username or parts.password or parts.query or parts.fragment:
        raise PreparationError(
            "Configure a secure HTTPS Tableau server URL without credentials or query.", mandatory=True
        )
    return TableauSession(
        SiteCredentials(
            base=server_url(env),
            site=env["TABLEAU_SITE"],
            pat_name=env["TABLEAU_PAT_NAME"],
            pat_secret=pat_secret(env),
            version=env.get("TABLEAU_REST_API_VERSION", DEFAULT_REST_API_VERSION),
        ),
        RetryPolicy(max_attempts=1, budget_sec=60),
    )


def _sign_in(session: TableauSession) -> None:
    try:
        session.sign_in()
    except Exception as exc:
        raise PreparationError(session.redact_text(str(exc)), mandatory=True) from exc


def _inventory(session: TableauSession, collection: str) -> list[dict]:
    rows = list_inventory(session, collection)
    if session.reflected_credential(json.dumps(rows).encode("utf-8")):
        raise PreparationError("Inventory reflected an authenticating credential; nothing saved.", mandatory=True)
    return rows


def _download(session: TableauSession, kind: str, luid: str, folder: Path) -> Path:
    endpoint = f"/sites/{quote(str(session.site_id), safe='')}/{kind}s/{quote(luid, safe='')}/content"
    status, raw, _ = session.raw_get(endpoint + "?includeExtract=true")
    if status != 200:
        detail = session.redact_text(raw.decode("utf-8", errors="replace"))
        raise PreparationError(
            f"Download {kind} -> HTTP {status}: {detail[:800]}",
            mandatory=status in (401, 403),
            native_exit_code=status or 1,
        )
    if session.reflected_credential(raw):
        raise PreparationError("Download reflected an authenticating credential; nothing saved.", mandatory=True)
    suffix = ".twb" if kind == "workbook" else ".tds"
    if raw.startswith(b"PK"):
        suffix += "x"
    path = folder / ("source" + suffix)
    if path.exists():
        raise PreparationError("Unreceipted source already exists; use a new run or replacement input.")
    path.write_bytes(raw)
    return path


def _record(kind: str, identity: str, name: str, project: dict | None = None, *, local: Path | None = None) -> dict:
    project = project or {}
    return {
        "key": _key(kind, identity),
        "kind": kind,
        "luid": None if local else identity,
        "name": name,
        "project_luid": project.get("id"),
        "project_name": project.get("name"),
        "local_source": str(local) if local else None,
        "source": None,
        "spec": None,
        "provenance": None,
        "state": "pending",
        "native_exit_code": None,
        "limitations": [],
        "actions": [],
        "findings": [],
        "dependencies": [],
    }


def _prepare_asset(  # pylint: disable=too-many-arguments,too-many-locals,too-many-branches,too-many-statements
    unit: dict,
    root: Path,
    env: dict[str, str],
    session: TableauSession | None,
    *,
    retry: bool,
    replacement: Path | None = None,
) -> dict | None:
    folder = root / "assets" / "tableau" / unit["key"]
    if replacement:
        replacement = replacement.resolve()
        # Replacements never overwrite a successful download or hand-authored spec.
        identity = str(replacement) + ":" + hashlib.sha256(replacement.read_bytes()).hexdigest()
        folder /= "replacement-" + hashlib.sha256(identity.encode()).hexdigest()[:24]
        for key in ("source", "spec", "provenance"):
            unit[key] = None
        unit["dependency_refs"] = []
        unit["dependencies"] = []
        unit["dependencies_complete"] = False
        unit["local_source"] = str(replacement)
        unit["state"] = "pending"
        unit["limitations"].append("Source replaced by explicitly commissioned local input.")
    _private(folder, root)
    folder.mkdir(parents=True, exist_ok=True)
    receipt = folder / "receipt.json"
    if receipt.exists():
        if not receipt.resolve().is_relative_to(root):
            raise PreparationError("Source receipt escapes the private run.", mandatory=True)
        saved = json.loads(receipt.read_text(encoding="utf-8"))
        if saved.get("key") != unit["key"]:
            raise PreparationError("Source receipt belongs to another identity; choose a new run.")
        for field in ("source", "spec", "provenance", "dependency_refs"):
            if not unit.get(field) and saved.get(field):
                unit[field] = saved[field]
        if unit["state"] == "pending" and saved["state"] == "needs_action":
            unit.update(
                state=saved["state"],
                findings=saved["findings"],
                actions=saved["actions"],
                native_exit_code=saved["native_exit_code"],
            )
    if unit["state"] == "needs_action" and not retry and not replacement:
        return None
    try:
        if not unit["source"]:
            local = Path(unit["local_source"]) if unit.get("local_source") else None
            if local:
                allowed = (".twb", ".twbx") if unit["kind"] == "workbook" else (".tds", ".tdsx")
                if local.suffix.lower() not in allowed:
                    raise PreparationError("Unsupported local source type; choose a Tableau workbook/datasource.")
                source = folder / ("source" + local.suffix.lower())
                if source.exists():
                    raise PreparationError("Unreceipted source already exists; use a new run or replacement.")
                shutil.copyfile(local, source)
            else:
                if session is None:
                    raise PreparationError("Tableau PAT session is required for this download.", mandatory=True)
                source = _download(session, unit["kind"], unit["luid"], folder)
            unit["source"] = str(source)
            _json(receipt, unit)
        source = Path(unit["source"])
        if not source.resolve().is_relative_to(root):
            raise PreparationError("Prepared source escapes the private run.", mandatory=True)
        _private(source.parent, root)
        if not source.is_file():
            raise PreparationError("Previously prepared source is missing; supply a replacement or a new run.")
        if not unit["provenance"]:
            provenance = folder / "provenance.json"
            if provenance.exists():
                raise PreparationError("Unreceipted provenance already exists; use a new run.")
            record = fingerprint(source)
            record.update(
                {
                    "provider": "local" if unit.get("local_source") else "tableau_rest_download",
                    "local_source": unit.get("local_source"),
                    "luid": unit["luid"] if not unit.get("local_source") else None,
                    "selected_luid": unit["luid"],
                    "site_luid": session.site_id if session and not unit.get("local_source") else None,
                    "server": server_url(env) if not unit.get("local_source") else None,
                    "identity_authority": "selected_rest_luid" if not unit.get("local_source") else "local_file_only",
                }
            )
            _json(provenance, record)
            unit["provenance"] = str(provenance)
            _json(receipt, unit)
        if not unit["spec"]:
            spec_path = folder / "migration-spec.json"
            if spec_path.exists():
                raise PreparationError("Unreceipted spec already exists; use a new run.")
            spec = parse_workbook(source)
            _json(spec_path, spec)
            unit["spec"] = str(spec_path)
            unit["dependency_refs"] = (
                [
                    ds["published_datasource"]
                    for ds in spec.get("data_sources", [])
                    if ds.get("published_datasource") is not None
                ]
                if unit["kind"] == "workbook"
                else []
            )
            unit["limitations"].extend(spec.get("limitations_encountered", []))
            _json(receipt, unit)
        elif not Path(unit["spec"]).is_file():
            raise PreparationError("Previously prepared spec is missing; do not overwrite authored work.")
        unit.update(state="prepared", native_exit_code=0, actions=[])
    except Exception as exc:  # Parser/native source failures must remain actionable receipts.
        finding = _failure(exc, env, session=session)
        unit["findings"].append(finding)
        unit.update(state="needs_action", native_exit_code=finding["native_exit_code"], actions=finding["actions"])
    _json(receipt, unit)
    return unit


def _resolve_dependency(ref: dict, rows: list[dict], env: dict[str, str]) -> dict:
    configured = urlsplit(server_url(env))
    derived = urlsplit(ref.get("derived_from") or "")
    if derived.netloc and (derived.hostname, derived.port) != (configured.hostname, configured.port):
        raise PreparationError("Published dependency belongs to another server; supply its approved local export.")
    if ref.get("site") is not None and ref["site"] != env.get("TABLEAU_SITE"):
        raise PreparationError("Published dependency belongs to another site; supply its approved local export.")
    segments = [unquote(part) for part in derived.path.split("/") if part]
    if len(segments) >= 3 and segments[0] == "t" and segments[2] == "datasources":
        if segments[1] != env.get("TABLEAU_SITE"):
            raise PreparationError("Published dependency URL identifies another site; supply its local export.")
    identity = ref.get("id")
    candidates = [row for row in rows if identity and str(row.get("id", "")).lower() == str(identity).lower()]
    if not candidates:
        field = "contentUrl" if ref.get("name_source") == "derived-from" else None
        candidates = [
            row
            for row in rows
            if identity
            and (row.get(field) == identity if field else identity in (row.get("name"), row.get("contentUrl")))
        ]
    if len(candidates) != 1:
        choices = [
            {"luid": row.get("id"), "name": row.get("name"), "project": row.get("project")} for row in candidates
        ]
        raise PreparationError(
            "Published dependency is unresolved or ambiguous; choose a LUID/local replacement. "
            + json.dumps({"reference": ref, "candidates": choices}, ensure_ascii=False)
        )
    return candidates[0]


def _reference_key(ref: dict) -> str:
    return _key("published", json.dumps(ref, sort_keys=True, ensure_ascii=False))


def _finish(result: dict, path: Path) -> dict:
    units = result["units"]
    blockers = [unit for unit in units if unit["state"] not in ("prepared", "skipped", "limited")]
    limited = any(unit["state"] in ("skipped", "limited") for unit in units)
    result["state"] = "needs_action" if result["findings"] or blockers else ("limited" if limited else "ready")
    result["native_exit_code"] = 1 if result["state"] == "needs_action" else (3 if limited else 0)
    result["actions"] = _actions(result)
    result["limitations"] = [item for unit in units for item in unit["limitations"]]
    result["manifest"] = str(path)
    _json(path, result)
    return result


def _actions(result: dict) -> list[dict]:
    rows = [(None, finding) for finding in result["findings"]]
    rows.extend(
        (unit["key"], unit["findings"][-1])
        for unit in result["units"]
        if unit["state"] == "needs_action" and unit["findings"]
    )
    ready_specs = {unit["key"] for unit in result["units"] if unit.get("spec")}
    return [
        {
            "id": "sources",
            "source_key": key,
            "kind": "human",
            "reason": "secure_human_remediation_required" if finding["mandatory"] else "source_preparation_incomplete",
            "mandatory": finding["mandatory"],
            "native_exit_code": finding["native_exit_code"],
            "replacement_key": finding.get("replacement_key", key),
            "choices": ["retry"]
            if finding["mandatory"]
            else ["retry", "replace", "skip", *(["continue"] if key in ready_specs else [])],
            "candidates": finding.get("candidates", []),
        }
        for key, finding in rows
    ]


def _check_artifacts(result: dict, root: Path, env: dict[str, str]) -> None:
    for unit in result["units"]:
        if unit["state"] != "prepared":
            continue
        for field in ("source", "spec", "provenance"):
            path = Path(unit[field]) if unit.get(field) else None
            if path is None or not path.is_file() or not path.resolve().is_relative_to(root):
                finding = _failure(
                    PreparationError(
                        f"Prepared {field} is missing or outside the run; supply a replacement or a new run.",
                        mandatory=path is not None and not path.resolve().is_relative_to(root),
                    ),
                    env,
                )
                unit["findings"].append(finding)
                unit.update(
                    state="needs_action", native_exit_code=finding["native_exit_code"], actions=finding["actions"]
                )
                break


def resolve_selection(  # pylint: disable=too-many-locals
    env: dict[str, str],
    *,
    project: str | None = None,
    workbooks: list[str] | None = None,
    local_sources: list[Path] | None = None,
) -> dict:
    """Resolve the exact scope without downloads, parsing, assessment, or output writes.

    The caller may persist this result, run its scoped assessment, then pass it
    to ``prepare_sources(selection=...)`` without selecting a different estate.
    """
    result = {
        "units": [],
        "findings": [],
        "actions": [],
        "limitations": [],
        "selection": {
            "project": project,
            "workbooks": list(workbooks or []),
            "local_sources": [str(Path(p).resolve()) for p in local_sources or []],
        },
        "selection_complete": False,
    }
    session = None
    try:
        for local in local_sources or []:
            source = Path(local).resolve()
            unit = _record("workbook", str(source), source.stem, local=source)
            if not any(existing["key"] == unit["key"] for existing in result["units"]):
                result["units"].append(unit)
        if workbooks or project is not None or not local_sources:
            session = _session(env)
            _sign_in(session)
            projects = _inventory(session, "projects")
            inventory = _inventory(session, "workbooks")
            chosen_project = select_project(projects, project) if project is not None else None
            project_id = chosen_project["id"] if chosen_project else None
            chosen = (
                [select_workbook(inventory, selector, project_id=project_id) for selector in workbooks]
                if workbooks
                else [row for row in inventory if not project_id or (row.get("project") or {}).get("id") == project_id]
            )
            for row in chosen:
                unit = _record("workbook", row["id"], row.get("name", ""), row.get("project"))
                if not any(existing["key"] == unit["key"] for existing in result["units"]):
                    result["units"].append(unit)
            if not chosen:
                raise PreparationError("No workbooks matched the commissioned Server scope.")
        result["selection_complete"] = True
    except Exception as exc:
        result["findings"].append(_failure(exc, env, session=session))
    finally:
        if session:
            try:
                session.sign_out()
            except Exception as exc:
                result["findings"].append(_failure(exc, env, session=session))
    result["actions"] = _actions(result)
    result["state"] = "needs_action" if result["findings"] else "resolved"
    result["native_exit_code"] = 1 if result["findings"] else 0
    return result


# pylint: disable-next=too-many-arguments,too-many-locals,too-many-branches
def prepare_sources(  # pylint: disable=too-many-statements,too-many-nested-blocks
    run_dir: Path,
    env: dict[str, str],
    *,
    project: str | None = None,
    workbooks: list[str] | None = None,
    local_sources: list[Path] | None = None,
    retry: bool = False,
    replacements: dict[str, Path] | None = None,
    skip: list[str] | None = None,
    continue_with_limitations: bool = False,
    selection: dict | None = None,
) -> dict:
    """Select only commissioned workbooks, parse sources, and prepare published dependencies.

    Names are exact, scoped by exact project; LUIDs win over names. Omitting
    workbooks selects that project's workbooks (or the site's). Supplying locals
    alone never signs in. Failed stages require an explicit retry; access/auth
    and privacy stops cannot be skipped or continued.
    """
    root = Path(run_dir).resolve()
    manifest = root / "source-preparation.json"
    result = {"units": [], "findings": [], "actions": [], "limitations": []}
    if refuse_unignored_output(
        Path(run_dir), None, artifacts=("source-preparation.json", "assets/tableau/probe/source.twb")
    ):
        result["findings"].append(
            _failure(
                PreparationError(
                    "Run output is not private/git-ignored; choose an ignored run folder.", mandatory=True
                ),
                env,
            )
        )
        return {**result, "state": "needs_action", "native_exit_code": 2, "actions": _actions(result), "manifest": None}
    root.mkdir(parents=True, exist_ok=True)
    if not manifest.resolve().is_relative_to(root):
        result["findings"].append(
            _failure(PreparationError("Preparation manifest escapes the private run.", mandatory=True), env)
        )
        return {**result, "state": "needs_action", "native_exit_code": 2, "actions": _actions(result), "manifest": None}
    selectors = {
        "project": project,
        "workbooks": list(workbooks or []),
        "local_sources": [str(Path(p).resolve()) for p in local_sources or []],
    }
    if manifest.exists():
        result = json.loads(manifest.read_text(encoding="utf-8"))
        if result.get("selection") != selectors:
            raise PreparationError("Run selection changed; allocate a new run rather than widen this scope.")
        _check_artifacts(result, root, env)
        if not retry and not replacements and not skip and not continue_with_limitations:
            return _finish(result, manifest)
        if result["findings"] and not retry:
            return result
        result.setdefault("previous_findings", []).extend(result["findings"])
        result["findings"] = []
    elif selection is not None:
        if selection.get("selection") != selectors or not selection.get("selection_complete"):
            raise PreparationError("Resolved selection does not match the commissioned scope.")
        result = json.loads(json.dumps(selection))
    result["selection"] = selectors
    session = None
    datasources = None
    try:
        if not result.get("selection_complete"):
            resolved = resolve_selection(env, project=project, workbooks=workbooks, local_sources=local_sources)
            old_units = {unit["key"]: unit for unit in result["units"]}
            result.update(resolved)
            result["units"] = [old_units.get(unit["key"], unit) for unit in resolved["units"]]
            if result["findings"]:
                return _finish(result, manifest)
        for unit in result["units"]:
            mandatory = unit["state"] == "needs_action" and unit["findings"] and unit["findings"][-1]["mandatory"]
            if unit["key"] in (skip or []) and not mandatory:
                unit.update(state="skipped", actions=[], native_exit_code=3)
                unit["limitations"].append("Explicitly skipped source; not prepared or migrated.")
                continue
            if unit["state"] == "skipped":
                continue
            if unit["state"] == "needs_action" and not retry and (mandatory or unit["key"] not in (replacements or {})):
                if continue_with_limitations and not mandatory and unit["spec"]:
                    unit.update(state="limited", actions=[], native_exit_code=3)
                    unit["limitations"].append("Explicit continuation with unresolved source preparation findings.")
                continue
            replacement = (replacements or {}).get(unit["key"])
            if not unit["source"] and not unit.get("local_source") and not replacement and session is None:
                session = _session(env)
                _sign_in(session)
            _prepare_asset(unit, root, env, session, retry=retry, replacement=replacement)
            if unit["state"] != "prepared":
                if unit["findings"][-1]["mandatory"]:
                    break
                continue
            if unit["kind"] != "workbook":
                continue
            try:
                if unit.get("dependencies_complete") and all(
                    any(item["key"] == key and item["state"] == "prepared" for item in result["units"])
                    for key in unit["dependencies"]
                ):
                    continue
                for ref in unit.get("dependency_refs", []):
                    reference_key = _reference_key(ref)
                    local_dependency = (replacements or {}).get(reference_key)
                    if local_dependency:
                        row = {"id": reference_key, "name": ref.get("id") or "Published datasource"}
                    else:
                        try:
                            if session is None:
                                session = _session(env)
                                _sign_in(session)
                            if datasources is None:
                                datasources = _inventory(session, "datasources")
                            row = _resolve_dependency(ref, datasources, env)
                        except Exception as exc:
                            exc.replacement_key = reference_key
                            raise
                    dependency_key = _key("datasource", row["id"])
                    dependency = next((item for item in result["units"] if item["key"] == dependency_key), None)
                    if dependency is None:
                        dependency = _record(
                            "datasource",
                            row["id"],
                            row.get("name", ""),
                            row.get("project"),
                            local=Path(local_dependency).resolve() if local_dependency else None,
                        )
                        result["units"].append(dependency)
                    if dependency_key not in unit["dependencies"]:
                        unit["dependencies"].append(dependency_key)
                    if dependency["project_luid"] != unit["project_luid"]:
                        disclosure = f"Required published datasource {dependency_key} is outside the workbook project."
                        if disclosure not in unit["limitations"]:
                            unit["limitations"].append(disclosure)
                    _prepare_asset(
                        dependency,
                        root,
                        env,
                        session,
                        retry=retry,
                        replacement=(replacements or {}).get(dependency_key),
                    )
                    if dependency["state"] != "prepared":
                        mandatory_dependency = dependency["findings"][-1]["mandatory"]
                        raise PreparationError(
                            f"Required published datasource {dependency_key} was not prepared; "
                            "see its native findings.",
                            mandatory=mandatory_dependency,
                            native_exit_code=dependency["native_exit_code"],
                        )
                unit["dependencies_complete"] = True
            except Exception as exc:
                finding = _failure(exc, env, session=session)
                unit["findings"].append(finding)
                unit.update(
                    state="needs_action", native_exit_code=finding["native_exit_code"], actions=finding["actions"]
                )
                if finding["mandatory"]:
                    break
        if not result["units"]:
            raise PreparationError("No source inputs were selected.")
    except Exception as exc:
        result["findings"].append(_failure(exc, env, session=session))
    finally:
        if session:
            try:
                session.sign_out()
            except Exception as exc:
                result["findings"].append(_failure(exc, env, session=session))
    return _finish(result, manifest)

"""purpose: reuse attributed assessment planning evidence without reusing validation authority.
usage: called by start_migration.py --assessment-run ABSOLUTE_RUN.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any

ARTIFACTS = (
    "assessment.json",
    "estate.db",
    "raw/workbooks.json",
    "raw/datasources.json",
    "raw/projects.json",
)
POLICIES = ("current", "acknowledge", "refresh")


class ReuseError(ValueError):
    """Saved planning evidence or current source identity cannot be established."""


def physical_root(path: Path) -> Path:
    """Require an explicit absolute physical location, never latest or symlink aliases."""
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise ReuseError("assessment run must be an absolute physical path")
    return path


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReuseError(f"saved assessment JSON is unavailable: {type(exc).__name__}") from exc


def _companions(path: Path) -> bool:
    return any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal"))


def _capture(source: Path, target: Path) -> str:
    """Stream stable source bytes into private custody without writing to the old run."""
    if source.resolve() != source or source.is_symlink() or not source.is_file():
        raise ReuseError("saved assessment artifact is not a physical file")
    before = source.stat()
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    created = False
    try:
        with source.open("rb") as reader, target.open("xb") as writer:
            created = True
            while chunk := reader.read(1024 * 1024):
                digest.update(chunk)
                writer.write(chunk)
        after = source.stat()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise ReuseError("saved assessment changed during capture")
    except (OSError, ReuseError):
        if created:
            target.unlink(missing_ok=True)
        raise
    return digest.hexdigest()


def _index(rows: Any, key: str) -> dict[str, dict]:
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ReuseError("assessment inventory is invalid")
    ids = [row.get(key) for row in rows]
    if any(not isinstance(luid, str) or not luid.strip() for luid in ids):
        raise ReuseError("assessment inventory identity is unavailable")
    if len({luid.casefold() for luid in ids}) != len(ids):
        raise ReuseError("assessment inventory contains duplicate identities")
    return dict(zip(ids, rows))


# Cross-artifact identity joins stay together in this bounded validation.
# pylint: disable=too-many-locals,too-many-branches,too-many-statements
def capture(source_run: Path, destination: Path, env: dict[str, str]) -> dict:
    """Capture fixed planning artifacts and validate their server/site and completeness."""
    source_run = physical_root(source_run)
    if source_run == destination.parent.parent:
        raise ReuseError("assessment cannot reuse its own new run")
    _capture(source_run / "run.json", destination / "snapshot-run.json")
    manifest = _json(destination / "snapshot-run.json")
    from work_dirs import check_run_location  # pylint: disable=import-outside-toplevel

    if not check_run_location(manifest, source_run).is_intact:
        raise ReuseError("saved assessment run location is moved or unverifiable")
    scope = manifest.get("scope") if isinstance(manifest, dict) else None
    if not isinstance(scope, dict) or (
        scope.get("server") != env["TABLEAU_SERVER_URL"] or scope.get("site") != env.get("TABLEAU_SITE", "")
    ):
        raise ReuseError("saved assessment server/site does not match the selected Tableau environment")
    original = source_run / "assessment"
    if _companions(original / "estate.db"):
        raise ReuseError("saved assessment SQLite transaction is not quiescent")
    initial = {name: (original / name).stat() for name in ARTIFACTS}
    hashes = {name: _capture(original / name, destination / name) for name in ARTIFACTS}
    for name, before in initial.items():
        after = (original / name).stat()
        if (before.st_ino, before.st_mtime_ns, before.st_ctime_ns, before.st_size) != (
            after.st_ino,
            after.st_mtime_ns,
            after.st_ctime_ns,
            after.st_size,
        ):
            raise ReuseError("saved assessment changed across artifact capture")
    if _companions(original / "estate.db"):
        raise ReuseError("saved assessment SQLite transaction changed during capture")
    document = _json(destination / "assessment.json")
    workbooks = _index(_json(destination / "raw/workbooks.json"), "id")
    datasources = _index(_json(destination / "raw/datasources.json"), "id")
    projects = _index(_json(destination / "raw/projects.json"), "id")
    if not isinstance(document, dict) or document.get("degraded_primary") is not False:
        raise ReuseError("saved assessment primary completeness is unavailable")
    assessment_rows = _index(document.get("workbooks"), "luid")
    try:
        with closing(
            sqlite3.connect(f"{(destination / 'estate.db').as_uri()}?mode=ro&immutable=1", uri=True)
        ) as connection:
            if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ReuseError("saved assessment database integrity is invalid")
            runs = connection.execute(
                "SELECT assessed_at, degraded_primary, workbooks_total FROM assessment_run"
            ).fetchall()
            rows = connection.execute("SELECT luid, name, project_luid, updated_at FROM workbook").fetchall()
            errors = connection.execute("SELECT listing, severity FROM listing_error").fetchall()
            if (
                len(runs) != 1
                or runs[0][1] != 0
                or runs[0][2] != len(rows)
                or not isinstance(runs[0][0], str)
                or not runs[0][0]
            ):
                raise ReuseError("saved assessment database completeness is invalid")
            if document.get("assessed_at", runs[0][0]) != runs[0][0]:
                raise ReuseError("saved assessment capture time contradicts the database")
            if set(assessment_rows) != {row[0] for row in rows} or set(workbooks) != set(assessment_rows):
                raise ReuseError("saved assessment workbook identities do not reconcile")
            for luid, name, project, revision in rows:
                raw = workbooks[luid]
                if (
                    raw.get("name") != name
                    or (raw.get("project") or {}).get("id") != project
                    or raw.get("updatedAt") != revision
                ):
                    raise ReuseError("saved assessment workbook catalog contradicts its raw evidence")
            provider_rows = connection.execute("SELECT luid, name, project_luid FROM datasource").fetchall()
            if set(datasources) != {row[0] for row in provider_rows}:
                raise ReuseError("saved datasource identities do not reconcile")
            for luid, name, project in provider_rows:
                raw = datasources[luid]
                if raw.get("name") != name or (raw.get("project") or {}).get("id") != project:
                    raise ReuseError("saved datasource catalog contradicts its raw evidence")
            project_rows = connection.execute("SELECT luid, name, parent_luid FROM project").fetchall()
            if set(projects) != {row[0] for row in project_rows} or any(
                projects[luid].get("name") != name or (projects[luid].get("parentProjectId") or "") != (parent or "")
                for luid, name, parent in project_rows
            ):
                raise ReuseError("saved project catalog contradicts its raw evidence")
    except sqlite3.Error as exc:
        raise ReuseError(f"saved assessment database is unavailable: {type(exc).__name__}") from exc
    return {
        "source_run": str(source_run),
        "original_capture_at": runs[0][0],
        "artifact_sha256": hashes,
        "listing_errors": [{"listing": listing, "severity": severity} for listing, severity in errors],
        "workbooks": workbooks,
        "datasources": datasources,
        "projects": projects,
    }


def _live(site: Any, collection: str, item: str) -> dict[str, dict]:
    rows, error = site.paged(f"/sites/{site.site_id}/{collection}", collection, item)
    if error:
        raise ReuseError("current Tableau inventory is incomplete; assessment freshness is unknown")
    return _index(rows, "id")


# Current identity and revision checks are one bounded acquisition pass.
# pylint: disable=too-many-locals,too-many-branches,too-many-arguments
def check_sources(
    snapshot: dict,
    env: dict[str, str],
    selected: list[str],
    expected: set[tuple[str, str]],
    *,
    project: str | None,
    survey: dict,
    database: Path,
    project_membership: bool = True,
) -> list[dict]:
    """Verify selected membership/dependency identity, then observe revision freshness."""
    from assess_estate import Site  # pylint: disable=import-outside-toplevel

    dependencies: set[tuple[str, str]] = set()
    survey_rows = _index(survey.get("workbooks"), "luid")
    for luid in selected:
        row = survey_rows.get(luid)
        if row is None or row.get("dependencies_unknown") is not False:
            raise ReuseError("current selected dependency identity is unknown")
        edges = row.get("published_dependencies")
        if not isinstance(edges, list):
            raise ReuseError("current selected dependency identity is unknown")
        for edge in edges:
            if not isinstance(edge, dict) or edge.get("status") != "resolved" or not edge.get("luid"):
                raise ReuseError("current selected published dependency is unresolved")
            dependencies.add((luid, edge["luid"]))
    try:
        with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro&immutable=1", uri=True)) as connection:
            prior = {
                (workbook, provider)
                for workbook, provider in connection.execute("SELECT workbook_luid, datasource_luid FROM dependency")
                if workbook in selected
            }
    except sqlite3.Error as exc:
        raise ReuseError(f"saved dependency catalog is unavailable: {type(exc).__name__}") from exc
    if dependencies != prior:
        raise ReuseError("selected dependencies changed; explicitly refresh assessment or revise scope")
    site = Site(env)
    observations = []
    try:
        site.sign_in()
        live_workbooks = _live(site, "workbooks", "workbook")
        live_datasources = (
            _live(site, "datasources", "datasource")
            if project_membership or any(kind == "datasource" for kind, _ in expected)
            else {}
        )
        if project is None and project_membership:
            if set(live_workbooks) != set(selected):
                raise ReuseError("selected site workbook membership changed; explicitly refresh assessment")
            if set(live_datasources) != {luid for kind, luid in expected if kind == "datasource"}:
                raise ReuseError("selected site datasource membership changed; explicitly refresh assessment")
        if project:
            live_projects = _live(site, "projects", "project")
            saved_project = snapshot["projects"].get(project)
            if saved_project is None or live_projects.get(project, {}).get("name") != saved_project.get("name"):
                raise ReuseError("selected project identity changed or is unavailable")
            if project_membership and {
                luid for luid, row in live_workbooks.items() if (row.get("project") or {}).get("id") == project
            } != set(selected):
                raise ReuseError("selected project membership changed; explicitly refresh assessment")
            if project_membership:
                current_providers = {
                    luid for luid, row in live_datasources.items() if (row.get("project") or {}).get("id") == project
                } | {provider for _, provider in dependencies}
                if current_providers != {luid for kind, luid in expected if kind == "datasource"}:
                    raise ReuseError("selected project datasource membership changed; explicitly refresh assessment")
        for kind, luid in sorted(expected):
            previous = snapshot["workbooks" if kind == "workbook" else "datasources"].get(luid)
            current = (live_workbooks if kind == "workbook" else live_datasources).get(luid)
            if (
                previous is None
                or current is None
                or current.get("name") != previous.get("name")
                or (current.get("project") or {}).get("id") != (previous.get("project") or {}).get("id")
            ):
                raise ReuseError("selected source identity changed or is unavailable; explicitly refresh assessment")
            old, new = previous.get("updatedAt"), current.get("updatedAt")
            state = (
                "unknown"
                if any(not isinstance(value, str) or not value for value in (old, new))
                else ("current" if old == new else "stale")
            )
            observations.append(
                {
                    "kind": kind,
                    "luid": luid,
                    "captured_revision": site.scrub_text(old) if isinstance(old, str) else None,
                    "current_revision": site.scrub_text(new) if isinstance(new, str) else None,
                    "state": state,
                }
            )
    finally:
        site.sign_out()
    return observations


def publish(snapshot: dict, captured: Path, destination: Path, observations: list[dict], policy: str) -> dict:
    """Publish attributed historical planning files, never old validation or source downloads."""
    if policy not in ("current", "acknowledge") or not observations:
        raise ReuseError("assessment reuse publication policy is invalid")
    if policy == "current" and any(row["state"] != "current" for row in observations):
        raise ReuseError("historical planning requires explicit acknowledgement")
    receipt = {
        "schema": "assessment-reuse/1",
        "source_run": snapshot["source_run"],
        "original_capture_at": snapshot["original_capture_at"],
        "reused_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "policy": policy,
        "outcome": "current" if all(row["state"] == "current" for row in observations) else "acknowledged_historical",
        "artifact_sha256": snapshot["artifact_sha256"],
        "listing_errors": snapshot["listing_errors"],
        "sources": observations,
        "authority": "historical_planning_only",
        "unselected_rows": "historical_not_freshness_checked",
        "validation_reused": False,
    }
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "assessment-reuse.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    for name in ARTIFACTS:
        target = destination / name
        if target.exists():
            raise ReuseError("assessment reuse cannot overwrite existing new-run evidence")
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = _capture(captured / name, target)
        if digest != snapshot["artifact_sha256"][name]:
            target.unlink(missing_ok=True)
            raise ReuseError("captured assessment bytes changed before publication")
    return receipt

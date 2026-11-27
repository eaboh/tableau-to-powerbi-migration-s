"""Complete Tableau inventories and exact, ambiguity-refusing scope selection.

REST uses the caller's authenticated hardened transport. Metadata uses Tableau's documented
workbooksConnection(first, after), optionally scoped by Workbook_Filter.luidWithin.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib.parse import urlencode


class InventoryError(ValueError):
    """The complete inventory cannot be established."""


class SelectionError(ValueError):
    """The selector does not identify exactly one object."""

    def __init__(self, message: str, *, candidates: list[dict] | None = None):
        super().__init__(message)
        self.candidates = candidates or []


class MetadataError(ValueError):
    """The complete Metadata API answer cannot be established."""


def _count(value: Any) -> int:
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]{1,19}", str(value)):
        raise InventoryError("invalid inventory pagination metadata")
    result = int(value)
    if result > 2**63 - 1:
        raise InventoryError("invalid inventory pagination metadata")
    return result


def collect_inventory(
    fetch: Callable[[str], dict], path: str, collection: str, item: str, *, page_size: int = 1000
) -> tuple[list[dict], dict[str, int]]:
    """Return all rows plus final pagination facts; an error never returns a prefix."""
    rows: list[dict] = []
    seen: set[str] = set()
    expected: tuple[int, int] | None = None
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        payload = fetch(f"{path}{sep}{urlencode({'pageSize': page_size, 'pageNumber': page})}")
        if not isinstance(payload, dict) or not isinstance(payload.get(collection), dict):
            raise InventoryError("invalid inventory response")
        # Tableau spells an empty collection as {}.
        more = payload[collection].get(item, [])
        if isinstance(more, dict):
            more = [more] if more else []
        if not isinstance(more, list) or any(
            not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip() for row in more
        ):
            raise InventoryError("invalid inventory pagination rows")
        pagination = payload.get("pagination")
        if not isinstance(pagination, dict) or any(
            key not in pagination for key in ("pageNumber", "pageSize", "totalAvailable")
        ):
            raise InventoryError("invalid inventory pagination metadata")
        counts = {key: _count(pagination[key]) for key in ("pageNumber", "pageSize", "totalAvailable")}
        if expected is None:
            expected = (counts["totalAvailable"], counts["pageSize"])
            page_size = counts["pageSize"]
        if (
            counts["pageNumber"] != page
            or page_size <= 0
            or (counts["totalAvailable"], counts["pageSize"]) != expected
            or len(more) != min(page_size, max(0, counts["totalAvailable"] - len(rows)))
        ):
            raise InventoryError("inconsistent inventory pagination")
        identities = {row["id"].casefold() for row in more}
        if len(identities) != len(more) or seen & identities:
            raise InventoryError("repeated identities in inventory pagination")
        seen.update(identities)
        rows.extend(more)
        if len(rows) == counts["totalAvailable"]:
            return rows, counts
        if not more:
            raise InventoryError("inventory pagination made no forward progress")
        page += 1


def list_inventory(session: Any, collection: str, item: str | None = None, *, path: str | None = None) -> list[dict]:
    """List via session.get_json, retaining Tableau's original REST row shape."""
    return collect_inventory(
        session.get_json, path or f"/sites/{session.site_id}/{collection}", collection, item or collection[:-1]
    )[0]


def list_projects(session: Any) -> list[dict]:
    """Return the complete REST project inventory."""
    return list_inventory(session, "projects", "project")


def list_workbooks(session: Any) -> list[dict]:
    """Return the complete REST workbook inventory."""
    return list_inventory(session, "workbooks", "workbook")


def list_datasources(session: Any) -> list[dict]:
    """Return the complete REST published-datasource inventory."""
    return list_inventory(session, "datasources", "datasource")


def _select(rows: list[dict], selector: str, kind: str) -> dict:
    matches = [row for row in rows if row["id"].casefold() == selector.casefold()]
    if not matches:
        matches = [row for row in rows if row.get("name") == selector]
    if len(matches) != 1:
        raise SelectionError(f"{kind} selector is {'ambiguous' if matches else 'not found'}", candidates=matches)
    return matches[0]


def select_project(projects: list[dict], selector: str) -> dict:
    """Resolve an exact project LUID first, otherwise an unambiguous exact name."""
    return _select(projects, selector, "project")


def select_workbook(workbooks: list[dict], selector: str, *, project_id: str | None = None) -> dict:
    """Resolve one workbook within the optional exact project LUID."""
    rows = (
        workbooks
        if project_id is None
        else [row for row in workbooks if (row.get("project") or {}).get("id", "").casefold() == project_id.casefold()]
    )
    return _select(rows, selector, "workbook")


def select_scope(
    projects: list[dict], workbooks: list[dict], *, project: str | None = None, workbook: str | list[str] | None = None
) -> tuple[list[dict], list[dict]]:
    """Return exact selected projects and the deduplicated workbook selector union."""
    selected_projects = [select_project(projects, project)] if project is not None else projects
    project_id = selected_projects[0]["id"] if project is not None else None
    selected_workbooks = (
        list(
            {
                row["id"]: row
                for token in ([workbook] if isinstance(workbook, str) else workbook)
                for row in [select_workbook(workbooks, token, project_id=project_id)]
            }.values()
        )
        if workbook is not None
        else [
            row
            for row in workbooks
            if project_id is None or (row.get("project") or {}).get("id", "").casefold() == project_id.casefold()
        ]
    )
    if workbook is not None and project is None:
        ids = {(row.get("project") or {}).get("id") for row in selected_workbooks}
        selected_projects = [row for row in projects if row["id"] in ids]
    return selected_projects, selected_workbooks


# Keep cursor state and fail-closed protocol guards together: neither may yield a partial prefix.
def collect_metadata_workbooks(  # pylint: disable=too-many-locals,too-many-branches
    fetch: Callable[[str], dict], fields: str, *, workbook_luids: list[str] | None = None
) -> list[dict]:
    """Follow cursor pages, refusing errors, missing pages, repeats, and cursor cycles."""
    if workbook_luids == []:
        return []
    after = None
    cursors: set[str] = set()
    seen: set[str] = set()
    rows: list[dict] = []
    while True:
        arguments = ["first: 1000"]
        if after is not None:
            arguments.append(f"after: {json.dumps(after)}")
        if workbook_luids is not None:
            arguments.append(f"filter: {{ luidWithin: {json.dumps(workbook_luids)} }}")
        query = (
            "{ workbooksConnection("
            + ", ".join(arguments)
            + ") { nodes { luid "
            + fields
            + " } pageInfo { hasNextPage endCursor } } }"
        )
        payload = fetch(query)
        if not isinstance(payload, dict):
            raise MetadataError(f"metadata api response was {type(payload).__name__}, not an object; response refused")
        errors = payload.get("errors")
        if errors is not None and (not isinstance(errors, list) or errors):
            detail = (
                f"{len(errors)} graphql error(s)"
                if isinstance(errors, list)
                else f"`errors` was {type(errors).__name__}, not a list"
            )
            raise MetadataError(f"metadata api returned {detail}; response refused")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise MetadataError(f"metadata api `data` was {type(data).__name__}, not an object; response refused")
        connection = data.get("workbooksConnection") if isinstance(data, dict) else None
        if not isinstance(connection, dict):
            raise MetadataError("metadata api workbook connection missing; response refused")
        more, info = connection.get("nodes"), connection.get("pageInfo")
        if not isinstance(more, list):
            raise MetadataError(f"metadata api `workbooks` was {type(more).__name__}, not a list; response refused")
        for row in more:
            if not isinstance(row, dict):
                raise MetadataError(f"a workbook node was {type(row).__name__}, not an object; response refused")
        if (
            not isinstance(more, list)
            or not isinstance(info, dict)
            or not isinstance(info.get("hasNextPage"), bool)
            or "endCursor" not in info
            or any(
                not isinstance(row, dict) or not isinstance(row.get("luid"), str) or not row["luid"].strip()
                for row in more
            )
        ):
            raise MetadataError("metadata api workbook page malformed; response refused")
        identities = {row["luid"].casefold() for row in more}
        if len(identities) != len(more) or seen & identities:
            raise MetadataError("metadata api repeated workbook identities; response refused")
        if workbook_luids is not None and not identities <= {luid.casefold() for luid in workbook_luids}:
            raise MetadataError("metadata api returned an unrelated workbook; response refused")
        seen.update(identities)
        rows.extend(more)
        if not info["hasNextPage"]:
            return rows
        after = info["endCursor"]
        if not more or not isinstance(after, str) or not after or after in cursors:
            raise MetadataError("metadata api pagination made no forward progress; response refused")
        cursors.add(after)

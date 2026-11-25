"""purpose: bounded cursor pagination for Tableau Metadata API connection queries.
usage: from tableau_metadata import collect_connection, MetadataIncomplete

The caller owns authentication, transport, retries and response decoding. This module never
returns a partial collection as complete. Nested connection pages must be complete too.
"""

from __future__ import annotations

import json
from typing import Any, Callable

PAGE_SIZE = 1000
MAX_PAGES = 10000


class MetadataIncomplete(ValueError):
    """A Metadata connection could not be acquired completely."""


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _connection(value: Any) -> tuple[list[dict], int, bool, str | None]:
    if not isinstance(value, dict):
        raise MetadataIncomplete("metadata connection is unavailable")
    nodes, total, page = value.get("nodes"), value.get("totalCount"), value.get("pageInfo")
    if not isinstance(nodes, list) or len(nodes) > PAGE_SIZE or any(not isinstance(node, dict) for node in nodes):
        raise MetadataIncomplete("invalid metadata connection nodes")
    if not _count(total) or not isinstance(page, dict) or not isinstance(page.get("hasNextPage"), bool):
        raise MetadataIncomplete("invalid metadata connection page")
    cursor = page.get("endCursor")
    if cursor is not None and (not isinstance(cursor, str) or not cursor):
        raise MetadataIncomplete("invalid metadata connection cursor")
    if page["hasNextPage"] and (not nodes or cursor is None):
        raise MetadataIncomplete("metadata connection made no progress")
    return nodes, total, page["hasNextPage"], cursor


def _normalize(node: dict, nested: dict[str, dict]) -> dict:
    normalized = dict(node)
    for key, children in nested.items():
        nodes, total, more, _cursor = _connection(node.get(key))
        if more or total != len(nodes):
            raise MetadataIncomplete("nested metadata connection is incomplete")
        _identities(nodes)
        normalized[key] = [_normalize(child, children) for child in nodes]
    return normalized


def _identities(nodes: list[dict]) -> set[str]:
    ids = [node.get("id") for node in nodes]
    if any(not isinstance(identity, str) or not identity for identity in ids):
        raise MetadataIncomplete("metadata node identity is unavailable")
    identities = set(ids)
    if len(identities) != len(ids):
        raise MetadataIncomplete("repeated metadata connection identity")
    return identities


# pylint: disable=too-many-locals
def collect_connection(
    fetch: Callable[[str], dict],
    collection: str,
    fields: str,
    *,
    nested: dict[str, dict] | None = None,
) -> list[dict]:
    """Return all nodes, validating cursor progress, identities and stable totalCount.

    Tableau documents first/after and nodes/pageInfo/totalCount on its connection fields.
    Duplicate identities are refused within one connection, not across different parents.
    Nested overflow is reported explicitly instead of silently trusting a truncated list.
    """
    rows: list[dict] = []
    seen: set[str] = set()
    cursors: set[str] = set()
    cursor: str | None = None
    expected: int | None = None
    for _page in range(MAX_PAGES):
        query = (
            "{ "
            + collection
            + ": "
            + collection
            + "Connection(first: "
            + str(PAGE_SIZE)
            + ", after: "
            + json.dumps(cursor)
            + ") { nodes { "
            + fields
            + " } totalCount pageInfo { hasNextPage endCursor } } }"
        )
        payload = fetch(query)
        if not isinstance(payload, dict):
            raise MetadataIncomplete("invalid metadata response envelope")
        if payload.get("errors") not in (None, []):
            raise MetadataIncomplete("Metadata API returned errors; response refused")
        data = payload.get("data")
        nodes, total, more, next_cursor = _connection(data.get(collection) if isinstance(data, dict) else None)
        if expected is None:
            expected = total
        if total != expected or len(rows) + len(nodes) > total:
            raise MetadataIncomplete("inconsistent metadata connection count")
        identities = _identities(nodes)
        if seen & identities:
            raise MetadataIncomplete("repeated metadata connection identity")
        seen.update(identities)
        rows.extend(_normalize(node, nested or {}) for node in nodes)
        if not more:
            if len(rows) != total:
                raise MetadataIncomplete("metadata connection ended before totalCount")
            return rows
        if len(rows) >= total or next_cursor in cursors:
            raise MetadataIncomplete("inconsistent metadata connection cursor")
        cursors.add(next_cursor)
        cursor = next_cursor
    raise MetadataIncomplete("metadata connection exceeded the page limit")

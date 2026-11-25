"""Independent page fixtures for complete Metadata acquisition."""

# Mocks preserve production signatures and exercise internal acquisition seams.
# pylint: disable=wrong-import-position,protected-access,too-few-public-methods,unused-argument
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from tableau_metadata import MetadataIncomplete, collect_connection  # noqa: E402
import assess_estate  # noqa: E402
import tableau_lineage  # noqa: E402
import tableau_view_types  # noqa: E402
from capture_tableau_oracle import _list_inventory  # noqa: E402
from stamp_tableau_provenance import TableauLookup, _inventory_completeness  # noqa: E402


def page(nodes, total, more=False, cursor=None, collection="workbooks"):
    """Encode an independently specified GraphQL connection response."""
    return {
        "data": {
            collection: {
                "nodes": nodes,
                "totalCount": total,
                "pageInfo": {"hasNextPage": more, "endCursor": cursor},
            }
        }
    }


@pytest.mark.parametrize("total", [999, 1000, 1001, 2501])
def test_collects_final_page_and_passes_returned_cursor(total):
    """Server-capped pages must preserve the final identity and cursor chain."""
    expected = [{"id": f"workbook-{index}"} for index in range(total)]
    pages = [
        page(expected[start : start + 500], total, start + 500 < total, f"cursor-{start + 500}")
        for start in range(0, total, 500)
    ]
    queries = []

    def fetch(query):
        queries.append(query)
        return pages[len(queries) - 1]

    assert collect_connection(fetch, "workbooks", "id") == expected
    assert "after: null" in queries[0]
    if len(queries) > 1:
        assert 'after: "cursor-500"' in queries[1]


@pytest.mark.parametrize(
    "second",
    [
        {"errors": [{"message": "private server text"}], "data": {"workbooks": []}},
        page([{"id": "a"}], 2),
        page([{"id": "b"}], 3),
        page([], 2, True, "next"),
        page([{"id": "b"}], 2, True, None),
        page([], 2),
    ],
)
def test_intermediate_failure_never_returns_partial_success(second):
    """Incomplete page chains must not earn complete acquisition."""
    responses = iter([page([{"id": "a"}], 2, True, "first"), second])
    with pytest.raises(MetadataIncomplete):
        collect_connection(lambda _query: next(responses), "workbooks", "id")


def test_repeated_cursor_is_refused_before_another_request():
    """A repeated cursor cannot extend an acquisition indefinitely."""
    responses = iter([page([{"id": "a"}], 3, True, "same"), page([{"id": "b"}], 3, True, "same")])
    with pytest.raises(MetadataIncomplete, match="cursor"):
        collect_connection(lambda _query: next(responses), "workbooks", "id")


def test_nested_overflow_is_not_silently_normalized():
    """A truncated nested connection must remain explicitly incomplete."""
    nested = page([{"id": "sheet-1"}], 2, True, "sheet-next")["data"]["workbooks"]
    with pytest.raises(MetadataIncomplete, match="nested"):
        collect_connection(
            lambda _query: page([{"id": "workbook-1", "sheets": nested}], 1),
            "workbooks",
            "id",
            nested={"sheets": {}},
        )


def test_same_child_identity_under_different_parents_is_legitimate():
    """Identity uniqueness is local to each connection, not the entire graph."""
    nested = page([{"id": "shared"}], 1)["data"]["workbooks"]
    rows = [{"id": "a", "sheets": nested}, {"id": "b", "sheets": nested}]
    assert collect_connection(lambda _query: page(rows, 2), "workbooks", "id", nested={"sheets": {}}) == [
        {"id": "a", "sheets": [{"id": "shared"}]},
        {"id": "b", "sheets": [{"id": "shared"}]},
    ]


def test_page_budget_is_enforced(monkeypatch):
    """A valid but unbounded chain must stop at the fixed acquisition budget."""
    monkeypatch.setattr("tableau_metadata.MAX_PAGES", 1)
    with pytest.raises(MetadataIncomplete, match="page limit"):
        collect_connection(lambda _query: page([{"id": "a"}], 2, True, "next"), "workbooks", "id")


@pytest.mark.parametrize("collector", ["view_types", "structure", "lineage"])
def test_production_collectors_reach_workbook_2501(monkeypatch, collector):
    """Each real collector must retain an identity beyond two full root pages."""

    def nested(nodes):
        return page(nodes, len(nodes))["data"]["workbooks"]

    calls = []

    def fetch(query):
        calls.append(query)
        collection = "publishedDatasources" if query.startswith("{ publishedDatasources:") else "workbooks"
        if collector == "structure" and collection == "publishedDatasources":
            return page([], 0, collection=collection)
        cursor = re.search(r'after: "cursor-(\d+)"', query)
        start = int(cursor.group(1)) if cursor else 0
        nodes = []
        for index in range(start, min(start + 1000, 2501)):
            nodes.append(
                {
                    "id": f"object-{index}",
                    "luid": f"{index:08x}-1111-4111-8111-aaaaaaaaaaaa",
                    "name": f"Workbook {index}",
                    "projectName": "Selected project",
                    "sheets": nested([]),
                    "dashboards": nested(
                        [{"id": f"dashboard-{index}", "luid": f"{index:08x}-1111-4111-8111-aaaaaaaaaaaa"}]
                    ),
                    "embeddedDatasources": nested([]),
                    "downstreamWorkbooks": nested([]),
                }
            )
        return page(nodes, 2501, start + 1000 < 2501, f"cursor-{start + 1000}", collection=collection)

    if collector == "view_types":

        class Session:
            """Metadata transport retaining the production request signature."""

            def _request(self, _method, _path, *, body=None, api=None, accept=None, authed=True, deadline=None):
                assert api == "metadata"
                return 200, json.dumps(fetch(body["query"])).encode(), {}

        result, error = tableau_view_types.view_types(Session())
        assert error is None
        assert result["000009c4-1111-4111-8111-aaaaaaaaaaaa"] == "dashboard"
    elif collector == "structure":

        class Site:
            """Assessment transport returning independently specified pages."""

            def graphql(self, query):
                """Supply the next synthetic Metadata response."""
                return fetch(query), None

        result, errors = assess_estate._pass2_structure(Site())
        assert not errors
        result = result["workbooks"]
        assert result[-1]["id"] == "object-2500"
    else:
        monkeypatch.setattr(tableau_lineage, "_post_json", lambda _url, payload, **_kwargs: fetch(payload["query"]))
        result = tableau_lineage.fetch_lineage(
            tableau_lineage.TableauSession("https://tableau.invalid", "token", "site")
        )
        assert result[-1]["id"] == "object-2500"
    assert len(result) == 2501
    assert len(calls) == (4 if collector == "structure" else 3)


def test_provenance_follows_server_capped_pages():
    """Provenance must reconcile server-capped pages through the final identity."""

    calls = []

    class Lookup:
        """Supply REST inventory pages without live authentication."""

        _workbook_luids = staticmethod(TableauLookup._workbook_luids)

        def _workbook_page(self, number):
            calls.append(number)
            start = (number - 1) * 500
            rows = [{"id": f"workbook-{index}"} for index in range(start, min(start + 500, 2501))]
            return rows, _inventory_completeness(
                len(rows), {"pageNumber": number, "pageSize": 500, "totalAvailable": 2501}
            )

    rows, completeness = TableauLookup._workbook_inventory(Lookup())
    assert len(rows) == 2501 and rows[-1]["id"] == "workbook-2500"
    assert completeness.status == "complete"
    assert calls == [1, 2, 3, 4, 5, 6]


@pytest.mark.parametrize("collector", ["assessment", "capture"])
def test_rest_collectors_follow_server_capped_pages(collector):
    """Assessment and capture must honor actual server page sizes."""

    responses = iter(
        {
            "workbooks": {"workbook": [{"id": f"workbook-{index}"} for index in range(start, min(start + 500, 2501))]},
            "pagination": {"pageNumber": number, "pageSize": 500, "totalAvailable": 2501},
        }
        for number, start in enumerate(range(0, 2501, 500), 1)
    )
    if collector == "capture":

        class Session:
            """Capture transport supplying the fixed REST page chain."""

            site_id = "site"

            def get_json(self, _path):
                """Supply the next independently specified inventory response."""
                return next(responses)

        rows = _list_inventory(Session(), "workbooks", "workbook")
    else:
        site = assess_estate.Site.__new__(assess_estate.Site)
        site._request_json = lambda _method, _path: (next(responses), None)
        rows, error = site.paged("/sites/site/workbooks", "workbooks", "workbook")
        assert error is None
    assert len(rows) == 2501
    assert rows[-1]["id"] == "workbook-2500"

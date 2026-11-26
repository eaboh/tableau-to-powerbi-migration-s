"""Complete inventories, exact selections and bounded assessment enrichment (mocked only)."""

from urllib.parse import parse_qs, urlsplit

import pytest

import assess_estate
import stamp_tableau_provenance as provenance
import tableau_inventory as inventory
import tableau_view_types


@pytest.mark.parametrize(
    "collection,item",
    [
        ("projects", "project"),
        ("workbooks", "workbook"),
        ("views", "view"),
        ("datasources", "datasource"),
    ],
)
@pytest.mark.parametrize("size", [1000, 137])
def test_complete_rest_inventory_over_1000_with_negotiated_page_size(collection, item, size):
    calls = []

    class Session:
        site_id = "site"

        def get_json(self, path):
            query = parse_qs(urlsplit(path).query)
            page = int(query["pageNumber"][0])
            calls.append(query)
            start = (page - 1) * size
            return {
                collection: {
                    item: [{"id": f"id-{i}", "name": f"Item {i}"} for i in range(start, min(start + size, 1207))]
                },
                "pagination": {"pageNumber": str(page), "pageSize": str(size), "totalAvailable": "1207"},
            }

    rows = inventory.list_inventory(Session(), collection, item)
    assert len(rows) == 1207 and rows[-1]["id"] == "id-1206"
    assert calls[0]["pageSize"] == ["1000"]
    assert all(call["pageSize"] == [str(size)] for call in calls[1:])


@pytest.mark.parametrize(
    "fault",
    [
        "missing-pagination",
        "missing-page",
        "short",
        "repeat",
        "case-repeat",
        "total",
        "size",
        "wrong-number",
        "missing-id",
        "duplicate-id",
        "bool-count",
        "transport",
    ],
)
def test_rest_never_returns_a_partial_prefix(fault):
    def fetch(path):
        page = int(parse_qs(urlsplit(path).query)["pageNumber"][0])
        document = {
            "workbooks": {"workbook": [{"id": f"{page}-a"}, {"id": f"{page}-b"}]},
            "pagination": {"pageNumber": page, "pageSize": 2, "totalAvailable": 4},
        }
        if page == 2:
            rows = document["workbooks"]["workbook"]
            if fault == "missing-pagination":
                del document["pagination"]
            elif fault == "missing-page":
                del document["workbooks"]
            elif fault == "short":
                rows.pop()
            elif fault in {"repeat", "case-repeat"}:
                rows[0]["id"] = "1-a" if fault == "repeat" else "1-A"
            elif fault in {"total", "size", "wrong-number", "bool-count"}:
                key, value = {
                    "total": ("totalAvailable", 5),
                    "size": ("pageSize", 1),
                    "wrong-number": ("pageNumber", 1),
                    "bool-count": ("pageNumber", True),
                }[fault]
                document["pagination"][key] = value
            elif fault == "missing-id":
                rows[0].pop("id")
            elif fault == "duplicate-id":
                rows[1]["id"] = rows[0]["id"]
            else:
                raise RuntimeError("private server details")
        return document

    with pytest.raises((inventory.InventoryError, RuntimeError)):
        inventory.collect_inventory(fetch, "/workbooks", "workbooks", "workbook")


def test_selection_exact_luid_first_and_names_in_exact_project():
    projects = [{"id": "p1", "name": "Finance"}, {"id": "p2", "name": "Finance"}]
    workbooks = [
        {"id": "w1", "name": "Sales", "project": {"id": "p1"}},
        {"id": "w2", "name": "Sales", "project": {"id": "p2"}},
        {"id": "w3", "name": "w1", "project": {"id": "p1"}},
    ]
    with pytest.raises(inventory.SelectionError, match="ambiguous") as error:
        inventory.select_project(projects, "Finance")
    assert error.value.candidates == projects
    assert inventory.select_workbook(workbooks, "W1")["id"] == "w1"
    assert inventory.select_scope(projects, workbooks, project="p2", workbook="Sales")[1] == [workbooks[1]]
    with pytest.raises(inventory.SelectionError, match="ambiguous"):
        inventory.select_workbook(workbooks, "Sales")
    with pytest.raises(inventory.SelectionError, match="not found"):
        inventory.select_workbook(workbooks, "w2", project_id="p1")
    assert [row["id"] for row in inventory.select_scope(projects, workbooks, workbook=["w1", "w3", "w1"])[1]] == [
        "w1",
        "w3",
    ]


def _connection(nodes, *, next_page=False, cursor=None):
    return {
        "data": {
            "workbooksConnection": {
                "nodes": nodes,
                "pageInfo": {"hasNextPage": next_page, "endCursor": cursor},
            }
        }
    }


def test_metadata_connection_over_1000_and_later_page_typing():
    calls = []
    first = [{"luid": f"wb-{i}", "dashboards": [], "sheets": []} for i in range(1000)]
    later = [{"luid": "wb-1000", "dashboards": [{"luid": "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"}], "sheets": []}]
    pages = [_connection(first, next_page=True, cursor="page-2"), _connection(later)]

    def fetch(query):
        calls.append(query)
        return pages.pop(0)

    rows = inventory.collect_metadata_workbooks(fetch, "dashboards { luid } sheets { luid }")
    mapping, refusal = tableau_view_types.parse_payload({"data": {"workbooks": rows}})
    assert refusal is None and len(rows) == 1001 and len(mapping) == 1
    assert "workbooksConnection(first: 1000)" in calls[0]
    assert 'after: "page-2"' in calls[1]
    assert all("pageInfo { hasNextPage endCursor }" in call for call in calls)


@pytest.mark.parametrize(
    "fault", ["repeat", "cycle", "empty", "missing-info", "missing-connection", "errors", "unrelated"]
)
def test_metadata_refuses_incomplete_or_inconsistent_pages(fault):
    pages = [_connection([{"luid": "w1"}], next_page=True, cursor="c1")]
    if fault == "repeat":
        pages.append(_connection([{"luid": "w1"}]))
    elif fault == "cycle":
        pages.append(_connection([{"luid": "w2"}], next_page=True, cursor="c1"))
    elif fault == "empty":
        pages.append(_connection([], next_page=True, cursor="c2"))
    elif fault == "missing-info":
        pages.append({"data": {"workbooksConnection": {"nodes": [{"luid": "w2"}]}}})
    elif fault == "missing-connection":
        pages.append({"data": {"workbooks": [{"luid": "w2"}]}})
    elif fault == "errors":
        pages.append({"errors": [{"message": "private server error"}], **_connection([{"luid": "w2"}])})
    else:
        pages.append(_connection([{"luid": "unrelated"}]))
    with pytest.raises(inventory.MetadataError) as error:
        inventory.collect_metadata_workbooks(lambda query: pages.pop(0), "name", workbook_luids=["w1", "w2"])
    assert "private" not in str(error.value)


def test_assessment_scope_precedes_structure_permissions_checkpoint_and_scoring(monkeypatch):
    projects = [{"id": "p1", "name": "Finance"}, {"id": "p2", "name": "Other"}]
    workbooks = [
        {"id": "w1", "name": "Sales", "project": {"id": "p1"}},
        {"id": "w2", "name": "Sales", "project": {"id": "p2"}},
    ]
    views = [{"id": "v1", "workbook": {"id": "w1"}}, {"id": "v2", "workbook": {"id": "w2"}}]
    calls = []

    class Site:
        @staticmethod
        def scrub_text(text):
            return text

        def paged(self, path, collection, item):
            del item
            rows = {"projects": projects, "workbooks": workbooks, "views": views}
            return rows.get(collection, []), None

        def graphql(self, query):
            calls.append(query)
            assert 'luidWithin: ["w1"]' in query and '"w2"' not in query
            return _connection([{"luid": "w1", "name": "Sales", "sheets": [{}, {}]}]), None

        def get_checked(self, path):
            calls.append(path)
            assert "w2" not in path and "p2" not in path
            return {"permissions": {"granteeCapabilities": []}}, None

        site_id = "site"

    monkeypatch.setattr(assess_estate, "server_ceiling", lambda site: None)
    checkpoints = []
    raw = assess_estate.collect(Site(), None, checkpoints.append, project="p1", workbook=["w1"])
    assert checkpoints[0]["workbooks"] == [workbooks[0]]
    assert raw["views"] == [views[0]]
    assembled = assess_estate.assemble(raw, 0.99)
    assert len(assembled["workbooks"]) == 1 and assembled["workbooks"][0]["sheets"] == 2
    assert "Optional evidence" in assess_estate.render_report(assembled, raw, 0.99)


def test_assessment_duplicate_names_join_only_luid():
    raw = {
        key: [] for key in ("views", "datasources", "groups", "permissions", "subscriptions", "alerts", "custom_views")
    }
    raw.update(
        {
            "workbooks": [{"id": "w1", "name": "Sales"}, {"id": "w2", "name": "Sales"}],
            "structure": {},
            "structure_by_luid": {"w1": {"sheets": [{}]}, "w2": {"sheets": [{}, {}, {}]}},
        }
    )
    rows = assess_estate.assemble(raw, 0.99)["workbooks"]
    assert {row["luid"]: row["sheets"] for row in rows} == {"w1": 1, "w2": 3}


def test_provenance_dependency_search_completes_all_negotiated_pages():
    lookup = provenance.TableauLookup(
        {
            "TABLEAU_SERVER_URL": "https://tableau.example",
            "TABLEAU_SITE": "test",
            "TABLEAU_PAT_NAME": "fixture",
            "TABLEAU_PAT_SECRET": "fixture-secret",
        }
    )
    lookup.site_id = "site"
    calls = []

    def fetch(path):
        calls.append(path)
        query = parse_qs(urlsplit(path).query)
        page = int(query["pageNumber"][0])
        assert query["filter"] == ["contentUrl:eq:shared"]
        return {
            "datasources": {
                "datasource": [
                    {"id": f"ds-{i}", "contentUrl": "shared"} for i in range((page - 1) * 137, min(page * 137, 1201))
                ]
            },
            "pagination": {"pageNumber": page, "pageSize": 137, "totalAvailable": 1201},
        }

    lookup._dependency_json = fetch
    acquisition = {}
    result = lookup._query_published_dependency("shared", acquisition)
    assert result == {"state": "ambiguous", "candidate_count": 1201}
    assert acquisition["catalog"]["returned_count"] == 1201
    assert len(calls) == 9 and "pageSize=137" in calls[-1]

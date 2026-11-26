"""Independent saved-assessment custody, selected freshness and policy controls."""

# These controls exercise the private filesystem seam and production signatures.
# pylint: disable=protected-access,wrong-import-position,too-few-public-methods
import copy
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import assess_estate
import assessment_reuse as reuse
import work_dirs
from tableau_env import redact

ENV = {
    "TABLEAU_SERVER_URL": "https://tableau.invalid",
    "TABLEAU_SITE": "fixture",
    "TABLEAU_PAT_NAME": "fixture-pat",
    "TABLEAU_PAT_SECRET": "synthetic-test-secret",
}
REVISION = "2026-01-01T00:00:00Z"


@pytest.fixture(name="saved_assessment")
def _saved_assessment(tmp_path, monkeypatch):
    """A real assessment-shaped DB and raw inventory with a broader unrelated workload."""
    run = work_dirs.allocate_run(
        "saved",
        repo_root=tmp_path / "prior",
        extra_manifest={"scope": {"server": ENV["TABLEAU_SERVER_URL"], "site": ENV["TABLEAU_SITE"]}},
    )
    projects = [{"id": "p", "name": "Finance"}, {"id": "outside", "name": "Outside"}]
    workbooks = [
        {"id": "w", "name": "Sales", "project": {"id": "p"}, "updatedAt": REVISION},
        {"id": "other", "name": "Unrelated", "project": {"id": "outside"}, "updatedAt": REVISION},
    ]
    datasources = [{"id": "d", "name": "Ledger", "project": {"id": "outside"}, "updatedAt": REVISION}]
    with sqlite3.connect(run.assessment / "estate.db") as conn:
        conn.executescript(assess_estate.SCHEMA)
        conn.executemany(
            "INSERT INTO workbook(luid,name,project_luid,updated_at) VALUES(?,?,?,?)",
            [(row["id"], row["name"], row["project"]["id"], REVISION) for row in workbooks],
        )
        conn.executemany("INSERT INTO project(luid,name) VALUES(?,?)", [(row["id"], row["name"]) for row in projects])
        conn.execute("INSERT INTO datasource(luid,name,project_luid) VALUES('d','Ledger','outside')")
        conn.execute("INSERT INTO dependency(workbook_luid,datasource_luid) VALUES('w','d')")
        conn.execute("INSERT INTO assessment_run VALUES(?,0,0,2,0)", (REVISION,))
    document = {"degraded_primary": False, "workbooks": [{"luid": row["id"]} for row in workbooks]}
    (run.assessment / "assessment.json").write_text(json.dumps(document), encoding="utf-8")
    (run.assessment / "raw").mkdir()
    for key, rows in (("workbooks", workbooks), ("datasources", datasources), ("projects", projects)):
        (run.assessment / "raw" / f"{key}.json").write_text(json.dumps(rows), encoding="utf-8")
    # These must never become evidence in the new migration.
    (run.assessment / "admin_insights.json").write_text('{"private":"not reusable"}', encoding="utf-8")
    (run.oracle / "oracle-manifest.json").write_text('{"validation":"old"}', encoding="utf-8")
    live = copy.deepcopy({"workbooks": workbooks, "datasources": datasources, "projects": projects})
    calls = []

    class Site:
        """PAT inventory with no scoring, Metadata, grant or group calls."""

        site_id = "fixture"

        def __init__(self, env):
            assert env == ENV

        def sign_in(self):
            """Begin the synthetic PAT session."""
            calls.append("signin")

        def sign_out(self):
            """Record PAT session cleanup."""
            calls.append("signout")

        def paged(self, path, collection, item):
            """Return the independently specified live inventory."""
            calls.append((path, collection, item))
            return live[collection], None

        def scrub_text(self, text):
            """Apply the production credential redactor to current source diagnostics."""
            return redact(text, ENV["TABLEAU_PAT_NAME"], ENV["TABLEAU_PAT_SECRET"])

    monkeypatch.setattr(assess_estate, "Site", Site)
    survey = {
        "workbooks": [
            {
                "luid": "w",
                "dependencies_unknown": False,
                "published_dependencies": [{"luid": "d", "status": "resolved"}],
            }
        ]
    }
    return run, live, calls, survey


def _check(snapshot, captured, survey):
    return reuse.check_sources(
        snapshot,
        ENV,
        ["w"],
        {("workbook", "w"), ("datasource", "d")},
        project="p",
        survey=survey,
        database=captured / "estate.db",
    )


def test_two_reuses_preserve_source_and_never_copy_validation(saved_assessment, tmp_path):
    """Independent runs reuse stable planning bytes but acquire no prior validation authority."""
    run, live, calls, survey = saved_assessment
    original = {path.relative_to(run.root): path.read_bytes() for path in run.root.rglob("*") if path.is_file()}
    live["workbooks"][1]["updatedAt"] = "unrelated-new-revision"
    for number in (1, 2):
        new = tmp_path / f"new-{number}"
        captured = new / "scratch" / "assessment-snapshot"
        snapshot = reuse.capture(run.root, captured, ENV)
        observations = _check(snapshot, captured, survey)
        receipt = reuse.publish(snapshot, captured, new / "assessment", observations, "current")
        assert receipt["original_capture_at"] == REVISION
        assert receipt["outcome"] == "current"
        assert receipt["authority"] == "historical_planning_only"
        assert receipt["validation_reused"] is False
        assert {row["luid"] for row in receipt["sources"]} == {"w", "d"}
        assert not (new / "assessment" / "admin_insights.json").exists()
        assert not (new / "oracle").exists()
        assert (new / "assessment" / "estate.db").read_bytes() == original[Path("assessment/estate.db")]
    assert original == {path.relative_to(run.root): path.read_bytes() for path in run.root.rglob("*") if path.is_file()}
    assert calls.count("signout") == 2
    assert not any("metadata" in str(call) or "permissions" in str(call) for call in calls)


@pytest.mark.parametrize(
    "kind,state,revision",
    [
        ("workbooks", "stale", "2026-02-01T00:00:00Z"),
        ("datasources", "stale", "2026-02-01T00:00:00Z"),
        ("workbooks", "unknown", None),
        ("datasources", "unknown", None),
    ],
)
def test_selected_revision_is_stale_or_unknown_not_fresh(saved_assessment, tmp_path, kind, state, revision):
    """Missing revision metadata and changed provider revisions cannot pass as current."""
    run, live, _calls, survey = saved_assessment
    live[kind][0]["updatedAt"] = revision
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    observations = _check(snapshot, captured, survey)
    assert [
        row["state"] for row in observations if row["kind"] == ("workbook" if kind == "workbooks" else "datasource")
    ] == [state]
    receipt = reuse.publish(snapshot, captured, tmp_path / "new" / "assessment", observations, "acknowledge")
    assert receipt["outcome"] == "acknowledged_historical"


@pytest.mark.parametrize("change", ["rename", "move", "missing", "new-member", "dependencies", "unknown-dependencies"])
def test_identity_or_dependency_changes_refuse_even_before_acknowledgement(saved_assessment, tmp_path, change):
    """Policy acknowledgement cannot authorize guessed identity, membership or dependency closure."""
    run, live, calls, survey = saved_assessment
    if change == "rename":
        live["workbooks"][0]["name"] = "Renamed"
    elif change == "move":
        live["workbooks"][0]["project"]["id"] = "outside"
    elif change == "missing":
        live["datasources"] = []
    elif change == "new-member":
        live["workbooks"].append({"id": "new", "name": "New", "project": {"id": "p"}})
    elif change == "dependencies":
        survey["workbooks"][0]["published_dependencies"] = []
    else:
        survey["workbooks"][0]["dependencies_unknown"] = True
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    with pytest.raises(reuse.ReuseError):
        _check(snapshot, captured, survey)
    if "signin" in calls:
        assert calls[-1] == "signout"


@pytest.mark.parametrize("change", ["site", "duplicate-run", "degraded", "contradiction", "wal", "symlink", "moved"])
def test_saved_snapshot_refusals_do_not_publish_planning_evidence(saved_assessment, tmp_path, change):
    """Malformed or mutable saved evidence cannot become a fresh-looking assessment."""
    run, _live, _calls, _survey = saved_assessment
    env = dict(ENV)
    if change == "site":
        env["TABLEAU_SITE"] = "wrong"
    elif change == "duplicate-run":
        with sqlite3.connect(run.assessment / "estate.db") as conn:
            conn.execute("INSERT INTO assessment_run VALUES(?,0,0,2,0)", (REVISION,))
    elif change == "degraded":
        with sqlite3.connect(run.assessment / "estate.db") as conn:
            conn.execute("UPDATE assessment_run SET degraded_primary=1")
    elif change == "contradiction":
        with sqlite3.connect(run.assessment / "estate.db") as conn:
            conn.execute("UPDATE workbook SET name='contradiction' WHERE luid='w'")
    elif change == "wal":
        (run.assessment / "estate.db-wal").write_bytes(b"not quiescent")
    elif change == "symlink":
        path = run.assessment / "raw" / "workbooks.json"
        path.rename(path.with_suffix(".original"))
        path.symlink_to(path.with_suffix(".original"))
    else:
        manifest = json.loads(run.manifest_path.read_text(encoding="utf-8"))
        manifest["unit_key"] = "moved"
        run.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    new = tmp_path / "new"
    with pytest.raises(reuse.ReuseError):
        reuse.capture(run.root, new / "scratch" / "assessment-snapshot", env)
    assert not (new / "assessment").exists()


def test_partial_live_inventory_refuses_and_releases_pat(saved_assessment, tmp_path, monkeypatch):
    """A server failure after partial rows is unknown freshness, not a complete smaller site."""
    run, _live, calls, survey = saved_assessment
    site = assess_estate.Site
    monkeypatch.setattr(site, "paged", lambda *_args: ([], {"error": "private transport detail"}))
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    with pytest.raises(reuse.ReuseError, match="incomplete"):
        _check(snapshot, captured, survey)
    assert calls[-1] == "signout"


def test_captured_byte_mutation_cannot_be_published(saved_assessment, tmp_path):
    """Custody hashes must identify the bytes actually copied into the new assessment."""
    run, _live, _calls, survey = saved_assessment
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    observations = _check(snapshot, captured, survey)
    (captured / "assessment.json").write_text("{}", encoding="utf-8")
    with pytest.raises(reuse.ReuseError, match="bytes changed"):
        reuse.publish(snapshot, captured, tmp_path / "new" / "assessment", observations, "current")
    assert not (tmp_path / "new" / "assessment" / "assessment.json").exists()


def test_intersection_does_not_require_whole_project_membership(saved_assessment, tmp_path):
    """One workbook in a broader project is an intersection, not a project migration."""
    run, live, _calls, survey = saved_assessment
    live["workbooks"][1]["project"]["id"] = "p"
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    observations = reuse.check_sources(
        snapshot,
        ENV,
        ["w"],
        {("workbook", "w"), ("datasource", "d")},
        project="p",
        survey=survey,
        database=captured / "estate.db",
        project_membership=False,
    )
    assert all(row["state"] == "current" for row in observations)


def test_new_standalone_project_datasource_requires_refresh(saved_assessment, tmp_path):
    """A new project-local datasource must not vanish from project acquisition under reuse."""
    run, live, _calls, survey = saved_assessment
    live["datasources"].append({"id": "new-d", "name": "Standalone", "project": {"id": "p"}, "updatedAt": REVISION})
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    with pytest.raises(reuse.ReuseError, match="datasource membership"):
        _check(snapshot, captured, survey)


def test_previously_provider_free_project_still_checks_datasource_membership(saved_assessment, tmp_path):
    """An empty saved provider set is not permission to skip current project inventory."""
    run, live, calls, survey = saved_assessment
    survey["workbooks"][0]["published_dependencies"] = []
    with sqlite3.connect(run.assessment / "estate.db") as conn:
        conn.execute("DELETE FROM dependency")
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    live["datasources"].append({"id": "new-d", "name": "Standalone", "project": {"id": "p"}})
    with pytest.raises(reuse.ReuseError, match="datasource membership"):
        reuse.check_sources(
            snapshot,
            ENV,
            ["w"],
            {("workbook", "w")},
            project="p",
            survey=survey,
            database=captured / "estate.db",
        )
    assert any(isinstance(call, tuple) and call[1] == "datasources" for call in calls)


def test_site_reuse_reconciles_all_selected_datasources(saved_assessment, tmp_path):
    """Site-wide reuse cannot silently omit a newly published standalone datasource."""
    run, live, _calls, survey = saved_assessment
    survey["workbooks"].append({"luid": "other", "dependencies_unknown": False, "published_dependencies": []})
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    live["datasources"].append({"id": "new-d", "name": "New", "project": {"id": "outside"}})
    with pytest.raises(reuse.ReuseError, match="site datasource membership"):
        reuse.check_sources(
            snapshot,
            ENV,
            ["w", "other"],
            {("workbook", "w"), ("workbook", "other"), ("datasource", "d")},
            project=None,
            survey=survey,
            database=captured / "estate.db",
        )


def test_capture_does_not_delete_existing_destination(tmp_path):
    """A failed exclusive write cannot remove retained evidence in the new run."""
    source, target = tmp_path / "source", tmp_path / "existing"
    source.write_bytes(b"source")
    target.write_bytes(b"retained")
    with pytest.raises(FileExistsError):
        reuse._capture(source, target)
    assert target.read_bytes() == b"retained"


def test_stale_publication_cannot_use_current_policy(saved_assessment, tmp_path):
    """The publication helper cannot accidentally bypass the frontend acknowledgement choice."""
    run, live, _calls, survey = saved_assessment
    live["workbooks"][0]["updatedAt"] = "different"
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    with pytest.raises(reuse.ReuseError, match="acknowledgement"):
        reuse.publish(
            snapshot, captured, tmp_path / "new" / "assessment", _check(snapshot, captured, survey), "current"
        )
    assert not (tmp_path / "new" / "assessment").exists()


def test_live_revision_diagnostics_scrub_reflected_credentials(saved_assessment, tmp_path):
    """A live server echo in revision metadata must not enter the persisted decision receipt."""
    run, live, _calls, survey = saved_assessment
    live["datasources"][0]["updatedAt"] = ENV["TABLEAU_PAT_SECRET"]
    captured = tmp_path / "new" / "scratch" / "assessment-snapshot"
    snapshot = reuse.capture(run.root, captured, ENV)
    observations = _check(snapshot, captured, survey)
    receipt = reuse.publish(snapshot, captured, tmp_path / "new" / "assessment", observations, "acknowledge")
    assert ENV["TABLEAU_PAT_SECRET"] not in json.dumps(receipt)

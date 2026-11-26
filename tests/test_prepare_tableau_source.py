"""Mocked thin preparation controls; no server, credentials, engine, or assessment."""

# Descriptive test names and the shared HTTP double are their documentation.
# pylint: disable=missing-function-docstring,missing-class-docstring

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import prepare_tableau_source as prep  # noqa: E402  # pylint: disable=wrong-import-position
import harvest_estate_assets  # noqa: E402  # pylint: disable=wrong-import-position


XML = b'<workbook version="2024.1"><datasources/><worksheets/><dashboards/></workbook>'
PUBLISHED = b"""<workbook version="2024.1"><datasources>
<datasource name="ds"><connection class="sqlproxy" dbname="Master"/>
<repository-location id="Master" site="site" derived-from="https://tableau.example/t/site/datasources/Master"/>
</datasource></datasources><worksheets/><dashboards/></workbook>"""
ENV = {
    "TABLEAU_SERVER_URL": "https://tableau.example",
    "TABLEAU_SITE": "site",
    "TABLEAU_PAT_NAME": "mock-name",
    "TABLEAU_PAT_SECRET": "mock-secret",
}
P1 = {"id": "p1", "name": "Chosen"}
P2 = {"id": "p2", "name": "Other"}
W1 = {"id": "wb1", "name": "Same", "project": P1}
W2 = {"id": "wb2", "name": "Same", "project": P2}


@pytest.fixture(name="run")
def run_fixture(tmp_path):
    # The runner is configured with --basetemp inside the project.
    return tmp_path / "private-run"


@pytest.fixture(name="server")
def server_fixture(monkeypatch):
    class MockSession:
        site_id = "site-luid"
        token = "mock-session-token"

        def __init__(self):
            self.requests = []
            self.signins = 0
            self.closed = False
            self.inventory = {"projects": [P1, P2], "workbooks": [W1, W2], "datasources": []}
            self.payloads = {"workbook": (200, XML), "datasource": (200, b'<datasource name="Master"/>')}

        def sign_in(self):
            self.signins += 1

        def sign_out(self):
            self.closed = True

        def raw_get(self, path):
            self.requests.append(path)
            kind = "workbook" if "/workbooks/" in path else "datasource"
            status, raw = self.payloads[kind]
            return status, raw, "application/xml"

        def redact_text(self, text):
            return text.replace(ENV["TABLEAU_PAT_SECRET"], "[hidden]").replace(self.token, "[hidden]")

        def reflected_credential(self, raw):
            return ENV["TABLEAU_PAT_SECRET"].encode() in raw or self.token.encode() in raw

    instance = MockSession()
    monkeypatch.setattr(prep, "TableauSession", lambda *args, **kwargs: instance)
    monkeypatch.setattr(prep, "list_inventory", lambda session, collection: session.inventory[collection])
    return instance


def test_exact_scoped_selection_and_luid_precedence(run, server):
    result = prep.prepare_sources(run, ENV, project="Chosen", workbooks=["Same"])
    assert result["state"] == "ready"
    assert [unit["luid"] for unit in result["units"]] == ["wb1"]
    assert "/workbooks/wb1/content?" in server.requests[0]
    assert server.closed


def test_ambiguous_name_requires_human_candidates_without_download(run, server):
    result = prep.prepare_sources(run, ENV, workbooks=["Same"])
    assert result["state"] == "needs_action"
    assert {row["id"] for row in result["findings"][0]["candidates"]} == {"wb1", "wb2"}
    assert server.requests == []


def test_luid_is_selected_even_when_another_workbook_name_matches(run, server):
    server.inventory["workbooks"].append({"id": "wb3", "name": "wb1", "project": P1})
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert result["state"] == "ready"
    assert [unit["luid"] for unit in result["units"]] == ["wb1"]


@pytest.mark.parametrize("packaged", [False, True])
def test_local_parse_provenance_and_resume_preserve_authored_bytes(run, monkeypatch, packaged):
    run.parent.mkdir(parents=True, exist_ok=True)
    local = run.parent / ("input.twbx" if packaged else "input.twb")
    if packaged:
        with zipfile.ZipFile(local, "w") as archive:
            archive.writestr("input.twb", XML)
    else:
        local.write_bytes(XML)
    monkeypatch.setattr(prep, "_session", lambda _: pytest.fail("local input must not authenticate"))
    result = prep.prepare_sources(run, {}, local_sources=[local])
    assert result["state"] == "ready"
    unit = result["units"][0]
    assert Path(unit["source"]).read_bytes() == local.read_bytes()
    provenance = json.loads(Path(unit["provenance"]).read_text(encoding="utf-8"))
    assert provenance["identity_authority"] == "local_file_only"
    assert provenance["luid"] is None and provenance["site_luid"] is None
    Path(unit["spec"]).write_text('{"authored": true}', encoding="utf-8")
    monkeypatch.setattr(prep, "parse_workbook", lambda _: pytest.fail("successful parse must not repeat"))
    resumed = prep.prepare_sources(run, {}, local_sources=[local], retry=True)
    assert resumed["state"] == "ready"
    assert Path(unit["spec"]).read_text(encoding="utf-8") == '{"authored": true}'


def test_partial_parse_failure_retained_and_retry_does_not_redownload(run, server, monkeypatch):
    original = prep.parse_workbook
    failures = []

    def fail_once(path):
        failures.append(path)
        raise ValueError("native parser finding")

    monkeypatch.setattr(prep, "parse_workbook", fail_once)
    failed = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert failed["state"] == "needs_action"
    assert Path(failed["units"][0]["source"]).exists()
    assert failed["units"][0]["findings"][0]["detail"] == "native parser finding"
    prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert len(failures) == 1 and len(server.requests) == 1
    monkeypatch.setattr(prep, "parse_workbook", original)
    resumed = prep.prepare_sources(run, ENV, workbooks=["wb1"], retry=True)
    assert resumed["state"] == "ready" and len(server.requests) == 1
    assert resumed["units"][0]["findings"][0]["detail"] == "native parser finding"


def test_missing_pat_fixed_secure_action_and_no_secret_receipts(run, server):
    result = prep.prepare_sources(run, {"TABLEAU_SERVER_URL": ENV["TABLEAU_SERVER_URL"]}, workbooks=["wb1"])
    assert result["state"] == "needs_action"
    assert result["actions"][0]["mandatory"]
    assert result["actions"][0]["choices"] == ["retry"]
    assert server.signins == 0
    assert "TABLEAU_PAT_SECRET" in result["findings"][0]["detail"]


def test_external_dependency_downloaded_without_other_workbooks(run, server):
    server.payloads["workbook"] = (200, PUBLISHED)
    server.inventory["datasources"] = [{"id": "ds1", "name": "Master", "contentUrl": "Master", "project": P2}]
    result = prep.prepare_sources(run, ENV, project="Chosen", workbooks=["wb1"])
    assert result["state"] == "ready"
    assert [unit["luid"] for unit in result["units"]] == ["wb1", "ds1"]
    workbook = result["units"][0]
    assert workbook["dependencies"] == ["datasource-ds1"]
    assert any("outside" in str(item) for item in workbook["limitations"])
    assert sum("/workbooks/" in path for path in server.requests) == 1
    assert sum("/datasources/ds1/content" in path for path in server.requests) == 1


def test_dependency_access_denied_is_native_mandatory_stop(run, server):
    server.payloads["workbook"] = (200, PUBLISHED)
    server.payloads["datasource"] = (403, b'<error code="403004">permission denied mock-secret</error>')
    server.inventory["datasources"] = [{"id": "ds1", "name": "Master", "contentUrl": "Master", "project": P2}]
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert result["state"] == "needs_action"
    dependency = result["units"][1]
    assert dependency["native_exit_code"] == 403
    assert 'code="403004"' in dependency["findings"][0]["detail"]
    assert dependency["findings"][0]["mandatory"]
    assert "mock-secret" not in Path(result["manifest"]).read_text(encoding="utf-8")
    resumed = prep.prepare_sources(
        run,
        ENV,
        workbooks=["wb1"],
        skip=[dependency["key"]],
        continue_with_limitations=True,
    )
    assert resumed["state"] == "needs_action"
    assert len(server.requests) == 2


def test_local_published_dependency_never_fabricates_server_identity(run, server):
    local = run.parent / "local.twb"
    local.write_bytes(PUBLISHED)
    result = prep.prepare_sources(run, {}, local_sources=[local])
    assert result["state"] == "needs_action"
    assert result["units"][0]["findings"][-1]["mandatory"]
    assert server.signins == 0
    provenance = json.loads(Path(result["units"][0]["provenance"]).read_text(encoding="utf-8"))
    assert provenance["luid"] is None


def test_output_guard_refuses_public_directory_before_any_call(monkeypatch):
    monkeypatch.setattr(prep, "refuse_unignored_output", lambda *args, **kwargs: True)
    monkeypatch.setattr(prep, "_session", lambda _: pytest.fail("privacy guard must precede authentication"))
    result = prep.prepare_sources(Path("not-an-output"), ENV, workbooks=["wb1"])
    assert result["state"] == "needs_action" and result["native_exit_code"] == 2
    assert result["manifest"] is None


def test_reflected_secret_success_body_is_not_saved(run, server):
    server.payloads["workbook"] = (200, XML + b"mock-secret")
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert result["state"] == "needs_action"
    assert result["units"][0]["source"] is None
    assert not list(run.rglob("*.twb"))


def test_selection_retry_after_config_failure_does_not_omit_server_scope(run, server):
    failed = prep.prepare_sources(run, {}, workbooks=["wb1"])
    assert failed["state"] == "needs_action"
    resumed = prep.prepare_sources(run, ENV, workbooks=["wb1"], retry=True)
    assert resumed["state"] == "ready"
    assert [unit["luid"] for unit in resumed["units"]] == ["wb1"]
    assert resumed["previous_findings"][0]["mandatory"]
    assert server.requests


def test_resolve_selection_is_read_only_and_preparation_reuses_scope(run, server, monkeypatch):
    selected = prep.resolve_selection(ENV, project="Chosen", workbooks=["Same"])
    assert selected["state"] == "resolved"
    assert not run.exists() and server.requests == []
    monkeypatch.setattr(prep, "resolve_selection", lambda *args, **kwargs: pytest.fail("scope must not be reselected"))
    result = prep.prepare_sources(run, ENV, project="Chosen", workbooks=["Same"], selection=selected)
    assert result["units"][0]["state"] == "prepared"
    assert selected["units"][0]["source"] is None
    assert len(server.requests) == 1


def test_failed_local_parse_can_be_replaced_without_overwriting_original(run):
    bad = run.parent / "broken.twb"
    bad.write_bytes(b"not XML")
    good = run.parent / "replacement.twb"
    good.write_bytes(XML)
    failed = prep.prepare_sources(run, {}, local_sources=[bad])
    original = Path(failed["units"][0]["source"])
    key = failed["units"][0]["key"]
    result = prep.prepare_sources(run, {}, local_sources=[bad], replacements={key: good})
    assert result["state"] == "ready"
    assert original.read_bytes() == b"not XML"
    assert Path(result["units"][0]["source"]) != original
    assert result["units"][0]["findings"]


def test_nonmandatory_skip_is_explicitly_limited_not_success(run):
    bad = run.parent / "broken.twb"
    bad.write_bytes(b"not XML")
    failed = prep.prepare_sources(run, {}, local_sources=[bad])
    result = prep.prepare_sources(run, {}, local_sources=[bad], skip=[failed["units"][0]["key"]])
    assert result["state"] == "limited" and result["native_exit_code"] == 3
    assert result["units"][0]["state"] == "skipped"
    assert result["units"][0]["spec"] is None
    assert "not prepared" in str(result["limitations"])


def test_unresolved_dependency_has_working_local_replacement_action(run, server):
    server.payloads["workbook"] = (200, PUBLISHED)
    failed = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert failed["state"] == "needs_action"
    replacement_key = failed["actions"][0]["replacement_key"]
    local = run.parent / "master.tds"
    local.write_bytes(b'<datasource name="Master"/>')
    result = prep.prepare_sources(
        run,
        ENV,
        workbooks=["wb1"],
        retry=True,
        replacements={replacement_key: local},
    )
    assert result["state"] == "ready"
    assert result["units"][1]["local_source"] == str(local.resolve())
    assert result["units"][1]["luid"] is None
    assert len(server.requests) == 1


def test_authentication_native_400_cannot_be_skipped_or_continued(run, server):
    def rejected():
        raise RuntimeError("Tableau sign-in failed: HTTP 400. native mock-secret")

    server.sign_in = rejected
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert result["actions"][0]["mandatory"]
    assert result["findings"][0]["native_exit_code"] == 400
    assert "mock-secret" not in Path(result["manifest"]).read_text(encoding="utf-8")
    resumed = prep.prepare_sources(run, ENV, workbooks=["wb1"], continue_with_limitations=True)
    assert resumed["state"] == "needs_action"


def test_source_preparation_has_no_engine_lookup_or_execution(run, server, monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("thin preparation must never resolve or execute the engine")

    monkeypatch.setattr(harvest_estate_assets, "engine_scripts_dir", forbidden)
    monkeypatch.setattr(harvest_estate_assets, "download", forbidden)
    monkeypatch.setattr(harvest_estate_assets, "parse_theirs", forbidden)
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert result["state"] == "ready"
    assert len(server.requests) == 1


def test_missing_successful_artifact_is_not_reported_as_prepared(run, server):
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    Path(result["units"][0]["spec"]).unlink()
    resumed = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert resumed["state"] == "needs_action"
    assert "missing" in resumed["units"][0]["findings"][-1]["detail"]
    assert len(server.requests) == 1


def test_source_receipt_recovers_successful_stages_after_manifest_loss(run, server, monkeypatch):
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    Path(result["manifest"]).unlink()
    Path(result["units"][0]["spec"]).write_text('{"authored": true}', encoding="utf-8")
    monkeypatch.setattr(prep, "parse_workbook", lambda _: pytest.fail("parse stage already receipted"))
    resumed = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert resumed["state"] == "ready" and len(server.requests) == 1
    assert Path(resumed["units"][0]["spec"]).read_text(encoding="utf-8") == '{"authored": true}'


def test_cross_site_dependency_url_cannot_bind_same_named_local_site_source(run, server):
    server.payloads["workbook"] = (200, PUBLISHED.replace(b' site="site"', b"").replace(b"/t/site/", b"/t/other/"))
    server.inventory["datasources"] = [{"id": "ds1", "name": "Master", "contentUrl": "Master", "project": P2}]
    result = prep.prepare_sources(run, ENV, workbooks=["wb1"])
    assert result["state"] == "needs_action"
    assert "another site" in result["units"][0]["findings"][-1]["detail"]
    assert len(server.requests) == 1

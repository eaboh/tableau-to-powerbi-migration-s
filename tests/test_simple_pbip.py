"""Portable PBIP custody and connection-intake controls, using fictional artifacts only."""

import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from simple_pbip import PBIPRefusal, copy_pbip, inspect_connections, plan_greenfield  # noqa: E402
import simple_pbip  # noqa: E402
from work_dirs import allocate_run  # noqa: E402


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(path, value):
    return write(path, json.dumps(value))


@pytest.fixture
def supplied(tmp_path):
    root = tmp_path / "supplied"
    project = write_json(
        root / "Example.pbip", {"version": "1.0", "artifacts": [{"report": {"path": "Example.Report"}}]}
    )
    write_json(
        root / "Example.Report" / "definition.pbir",
        {"version": "4.0", "datasetReference": {"byPath": {"path": "../Other.SemanticModel"}}},
    )
    write_json(root / "Example.Report" / "definition" / "report.json", {"themeCollection": {}})
    write_json(root / "Other.SemanticModel" / "definition.pbism", {"version": "4.0"})
    write(root / "Other.SemanticModel" / "definition" / "model.tmdl", "model Model\n\tculture: en-US\n")
    write(
        root / "Other.SemanticModel" / "definition" / "expressions.tmdl",
        'expression Server = "fictional.example" meta [IsParameterQuery=true, Type="Text"]\n'
        'expression Source =\n\tlet\n\t\tSource = Sql.Database(Server, "Training"),\n'
        '\t\tChosen = Source{[Schema="public", Item="Demo"]}[Data]\n\tin Chosen\n',
    )
    return project


@pytest.fixture
def working(tmp_path):
    run = allocate_run("fictional", repo_root=tmp_path / "owned")
    return run.root / "deliverables" / "unit" / "fabric"


def snapshot(root):
    return {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in root.rglob("*")
        if path.is_file()
    }


def test_copy_is_bound_relevant_and_source_read_only(supplied, working):
    root = supplied.parent
    write(root / "Other.SemanticModel" / ".pbi" / "cache.abf", "private rows")
    write(root / "Other.SemanticModel" / ".env", "secret")
    write(root / "Other.SemanticModel" / "data" / "sample.csv", "private rows")
    write(root / "Example.Report" / "notes.txt", "unrelated")
    write(root / "Unrelated.SemanticModel" / "definition" / "model.tmdl", "unrelated")
    before = snapshot(root)
    result = copy_pbip(supplied, working)
    assert result == {
        "root": str(working),
        "project_file": str(working / "Example.pbip"),
        "report": str(working / "Example.Report"),
        "semantic_model": str(working / "Other.SemanticModel"),
    }
    assert json.loads((working / "Example.Report" / "definition.pbir").read_text())["datasetReference"] == {
        "byPath": {"path": "../Other.SemanticModel"}
    }
    assert {str(path.relative_to(working)) for path in working.rglob("*") if path.is_file()} == {
        "Example.pbip",
        "Example.Report/definition.pbir",
        "Example.Report/definition/report.json",
        "Other.SemanticModel/definition.pbism",
        "Other.SemanticModel/definition/model.tmdl",
        "Other.SemanticModel/definition/expressions.tmdl",
    }
    assert snapshot(root) == before
    authored = write(working / "authored.txt", "do not overwrite")
    with pytest.raises(PBIPRefusal, match="already exists"):
        copy_pbip(supplied, working)
    assert authored.read_text() == "do not overwrite"


def test_copy_preserves_nested_report_binding(supplied, working):
    root = supplied.parent
    nested = root / "reports" / "Nested.Report"
    nested.parent.mkdir()
    (root / "Example.Report").rename(nested)
    write_json(supplied, {"artifacts": [{"report": {"path": "reports/Nested.Report"}}]})
    write_json(nested / "definition.pbir", {"datasetReference": {"byPath": {"path": "../../Other.SemanticModel"}}})
    result = copy_pbip(supplied, working)
    assert result["report"] == str(working / "reports" / "Nested.Report")
    assert result["semantic_model"] == str(working / "Other.SemanticModel")


def test_only_referenced_static_resources_are_copied(supplied, working):
    report = supplied.parent / "Example.Report"
    write_json(report / "definition" / "report.json", {"themeCollection": {"customTheme": {"name": "Fictional"}}})
    write_json(report / "StaticResources" / "SharedResources" / "Fictional.json", {"name": "Fictional"})
    write_json(report / "StaticResources" / "SharedResources" / "Unrelated.json", {"privateRows": [1, 2]})
    write(report / "StaticResources" / "RegisteredResources" / "Unrelated.png", "unrelated template image")
    copy_pbip(supplied, working)
    copied = working / "Example.Report" / "StaticResources"
    assert (copied / "SharedResources" / "Fictional.json").is_file()
    assert not (copied / "SharedResources" / "Unrelated.json").exists()
    assert not (copied / "RegisteredResources" / "Unrelated.png").exists()


@pytest.mark.parametrize(
    "reference",
    [
        {"byConnection": {"connectionString": "private"}},
        {"byPath": {"path": "../Other.SemanticModel"}, "byConnection": {}},
        {"byPath": {"path": "../../External.SemanticModel"}},
        {"byPath": {"path": "C:\\Other.SemanticModel"}},
        {"byPath": {"path": "//network/Other.SemanticModel"}},
    ],
)
def test_bad_model_binding_refuses_before_writes(supplied, working, reference):
    write_json(supplied.parent / "Example.Report" / "definition.pbir", {"datasetReference": reference})
    with pytest.raises(PBIPRefusal):
        copy_pbip(supplied, working)
    assert not working.exists()


def test_ambiguous_project_refuses(supplied, working):
    write_json(supplied, {"artifacts": [{"report": {"path": "Example.Report"}}, {"report": {"path": "Other.Report"}}]})
    with pytest.raises(PBIPRefusal, match="one report"):
        copy_pbip(supplied, working)
    assert not working.exists()


def test_missing_local_model_is_planned_not_fabricated(supplied, working):
    shutil.rmtree(supplied.parent / "Other.SemanticModel")
    before = snapshot(supplied.parent)
    result = copy_pbip(supplied, working)
    assert result == {
        "root": str(working),
        "project_file": str(working / "Example.pbip"),
        "report": str(working / "Example.Report"),
        "semantic_model": None,
        "expected_semantic_model": str(working / "Other.SemanticModel"),
    }
    binding = json.loads((working / "Example.Report" / "definition.pbir").read_text())["datasetReference"]
    assert binding == {"byPath": {"path": "../Other.SemanticModel"}}
    assert not (working / "Other.SemanticModel").exists()
    assert snapshot(supplied.parent) == before
    with pytest.raises(PBIPRefusal, match="already exists"):
        copy_pbip(supplied, working)
    with pytest.raises(PBIPRefusal, match="missing"):
        inspect_connections(supplied)


def test_missing_model_in_nested_safe_path_is_planned(supplied, working):
    write_json(
        supplied.parent / "Example.Report" / "definition.pbir",
        {"datasetReference": {"byPath": {"path": "../models/Planned.SemanticModel"}}},
    )
    result = copy_pbip(supplied, working)
    assert result["semantic_model"] is None
    assert result["expected_semantic_model"] == str(working / "models" / "Planned.SemanticModel")
    assert not (working / "models").exists()


@pytest.mark.parametrize(
    "reference", ["../../Missing.SemanticModel", "../Missing.Report", "../Example.Report/Model.SemanticModel"]
)
def test_missing_model_does_not_relax_binding_boundaries(supplied, working, reference):
    write_json(
        supplied.parent / "Example.Report" / "definition.pbir", {"datasetReference": {"byPath": {"path": reference}}}
    )
    with pytest.raises(PBIPRefusal):
        copy_pbip(supplied, working)
    assert not working.exists()


def test_missing_model_mode_still_refuses_non_directory(supplied, working):
    write(supplied.parent / "Missing.SemanticModel", "not a model directory")
    write_json(
        supplied.parent / "Example.Report" / "definition.pbir",
        {"datasetReference": {"byPath": {"path": "../Missing.SemanticModel"}}},
    )
    with pytest.raises(PBIPRefusal, match="directory"):
        copy_pbip(supplied, working)
    assert not working.exists()


@pytest.mark.parametrize(
    "text",
    [
        'expression Password = "fictional-secret"\n',
        "expression Source = #table(type table [Amount=number], {{1}})\n",
        'expression Source = Binary.Decompress(Binary.FromText("FAKE"), Compression.Deflate)\n',
        'expression Source = Json.Document("[{""Amount"":1}]")\n',
        'expression Username = "fictional-user"\n',
        'expression Source = Web.Contents("https://fictional-user:fictional-pass@example.test")\n',
    ],
)
def test_credential_or_inline_rows_refuse_copy_without_echo(supplied, working, text):
    write(supplied.parent / "Other.SemanticModel" / "definition" / "expressions.tmdl", text)
    with pytest.raises(PBIPRefusal) as refusal:
        copy_pbip(supplied, working)
    assert "fictional-secret" not in str(refusal.value)
    assert not working.exists()


@pytest.mark.parametrize("location", ["model", "report", "ancestor", "erased", "destination"])
def test_symlink_refuses_without_following(supplied, working, tmp_path, location):
    root = supplied.parent
    if location in {"model", "report"}:
        folder = root / ("Other.SemanticModel" if location == "model" else "Example.Report")
        real = root / "real"
        folder.rename(real)
        folder.symlink_to(real, target_is_directory=True)
    elif location == "ancestor":
        alias = tmp_path / "alias"
        alias.symlink_to(root, target_is_directory=True)
        supplied = alias / supplied.name
    elif location == "erased":
        alias = root / "alias"
        alias.symlink_to(root, target_is_directory=True)
        write_json(
            root / "Example.Report" / "definition.pbir",
            {"datasetReference": {"byPath": {"path": "../alias/../Other.SemanticModel"}}},
        )
    else:
        working.parent.mkdir(parents=True)
        working.symlink_to(root, target_is_directory=True)
    with pytest.raises(PBIPRefusal, match="symlink"):
        copy_pbip(supplied, working)


def test_hardlinked_artifact_refuses(supplied, working):
    os.link(supplied, supplied.parent / "alias.pbip")
    with pytest.raises(PBIPRefusal, match="unshared"):
        copy_pbip(supplied, working)


def test_mocked_windows_reparse_refuses(supplied, working, monkeypatch):
    original = Path.lstat
    model = supplied.parent / "Other.SemanticModel"

    def lstat(path):
        info = original(path)
        if path == model:
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
        return info

    monkeypatch.setattr(Path, "lstat", lstat)
    with pytest.raises(PBIPRefusal, match="reparse"):
        copy_pbip(supplied, working)
    assert not working.exists()


def test_unignored_output_refuses_before_creation(supplied, working, monkeypatch):
    monkeypatch.setattr(simple_pbip, "refuse_unignored_output", lambda *args, **kwargs: True)
    with pytest.raises(PBIPRefusal, match="git-ignored"):
        copy_pbip(supplied, working)
    assert not working.exists()


def test_corrupt_run_custody_refuses(supplied, working):
    run = next(parent for parent in working.parents if (parent / "run.json").exists())
    write_json(run / "run.json", {})
    with pytest.raises(PBIPRefusal, match="custody"):
        copy_pbip(supplied, working)
    assert not working.exists()


def test_non_run_destination_refuses(supplied, tmp_path):
    with pytest.raises(PBIPRefusal, match="allocated run"):
        copy_pbip(supplied, tmp_path / "arbitrary")


def test_connection_inspection_uses_actual_m_and_no_private_values(supplied):
    model = supplied.parent / "Other.SemanticModel"
    write(
        model / "definition" / "tables" / "Example.tmdl",
        "table Demo\n\tpartition Demo = m\n\t\tmode: import\n\t\tsource =\n"
        '\t\t\tlet Source = Snowflake.Databases("warehouse.example", "COMPUTE"),\n'
        '\t\t\tDb = Source{[Name="Training", Kind="Database"]}[Data]\n\t\t\tin Db\n',
    )
    write(
        model / "definition" / "expressions.tmdl",
        'expression Server = "fictional.example" meta [IsParameterQuery=true]\n'
        'expression Source = Sql.Database(Server, "Training"){[Schema="public",Item="Demo"]}[Data]\n'
        'expression Password = "fictional-sensitive-canary" meta [IsParameterQuery=true]\n'
        'expression SecretFree = "unrelated-literal-canary" // comment-sensitive-canary\n'
        'expression Rows = #table(type table [A=text], {{"row-sensitive-canary"}})\n',
    )
    before = snapshot(supplied.parent)
    result = inspect_connections(supplied)
    encoded = json.dumps(result)
    for private in (
        "fictional-sensitive-canary",
        "unrelated-literal-canary",
        "comment-sensitive-canary",
        "row-sensitive-canary",
    ):
        assert private not in encoded
    assert {item["name"] for item in result["parameters"]} == {"Server", "Password"}
    assert all(item["value"] is None for item in result["parameters"])
    assert {item["connector"] for item in result["connections"]} == {"Sql.Database", "Snowflake.Databases"}
    slots = result["target_change_slots"]
    assert any(item["slot"] == "server" and item["parameter"] == "Server" for item in slots)
    assert any(item["slot"] == "warehouse" and item["value"] == "COMPUTE" for item in slots)
    assert any(item["slot"] == "database" and item["value"] == "Training" for item in slots)
    assert any(item["slot"] == "schema" and item["value"] == "public" for item in slots)
    assert all(item["file"].endswith(".tmdl") and item["line"] > 0 for item in slots)
    assert snapshot(supplied.parent) == before


def test_text_mentioning_connector_is_not_a_connection(supplied):
    write(
        supplied.parent / "Other.SemanticModel" / "definition" / "expressions.tmdl",
        'expression Example = "Sql.Database(""private-mention-canary"", ""private-db-canary"")"\n',
    )
    result = inspect_connections(supplied)
    assert result["connections"] == []
    assert result["target_change_slots"] == []
    assert "private-mention-canary" not in json.dumps(result)


def test_greenfield_is_only_planning(working):
    result = plan_greenfield(working, "Demo")
    assert result["emitted"] is False
    assert result["project_file"] == str(working / "Demo.pbip")
    assert result["semantic_model"] == str(working / "Demo.SemanticModel")
    assert not working.exists()
    with pytest.raises(PBIPRefusal, match="identifier"):
        plan_greenfield(working, "../escape")

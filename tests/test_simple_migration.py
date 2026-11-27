"""Portable controls for engine-free intake, custody and same-run human decisions."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import simple_migration as simple  # noqa: E402
from simple_pbip import PBIPRefusal  # noqa: E402


@pytest.fixture
def local_run(tmp_path, monkeypatch):
    source = tmp_path / "Example.twb"
    source.write_text("<workbook/>", encoding="utf-8")
    calls = []

    def prepare(root, _env, **kwargs):
        calls.append(kwargs)
        spec = root / "assets" / "migration-spec.json"
        spec.write_text('{"name":"Example"}', encoding="utf-8")
        return {
            "state": "ok",
            "native_exit_code": 0,
            "actions": [],
            "units": [
                {
                    "key": "local-example",
                    "kind": "workbook",
                    "name": "Example",
                    "source": str(source),
                    "spec": str(spec),
                    "state": "ok",
                },
            ],
        }

    monkeypatch.setitem(
        sys.modules,
        "prepare_tableau_source",
        SimpleNamespace(
            prepare_sources=prepare,
            resolve_selection=lambda *_a, **_k: {
                "state": "resolved",
                "selection_complete": True,
                "actions": [],
                "units": [{"key": "local-example", "kind": "workbook", "name": "Example", "state": "pending"}],
            },
        ),
    )
    monkeypatch.setitem(sys.modules, "simple_pbip", SimpleNamespace(inspect_connections=lambda _: {}))
    return source, tmp_path, calls


def _start(source, parent, *extra):
    return [
        "--runs-parent",
        str(parent),
        "--local",
        str(source),
        "--mode",
        "single",
        "--style",
        "one-to-one",
        "--numeric",
        "none",
        "--assessment",
        "skip",
        *extra,
    ]


def _result(capsys):
    return json.loads(capsys.readouterr().out.splitlines()[-1])


def test_intake_never_infers_single_style_or_numeric(local_run, capsys):
    source, parent, calls = local_run
    assert simple.main(["--runs-parent", str(parent), "--local", str(source)]) == 3
    result = _result(capsys)
    assert {row["id"] for row in result["actions"]} >= {"intake:mode", "intake:style", "intake:numeric"}
    assert calls == []
    state = json.loads((Path(result["run"]) / "run.json").read_text())
    assert state["route"] == "simple/v1"
    assert not any(key in state["intake"] for key in ("mode", "style", "numeric"))


def test_local_single_no_engine_and_resume_preserves_success(local_run, capsys):
    source, parent, calls = local_run

    def never_run(*_args):
        pytest.fail("single assessment skip must not invoke assessor, converter, survey or database sweep")

    assert simple.main(_start(source, parent), runner=never_run) == 3
    result = _result(capsys)
    root = Path(result["run"])
    assert result["actions"][0]["id"] == "reference:u0001"
    assert simple.main(["--resume", str(root), "--decision", "reference:u0001=continue"], runner=never_run) == 0
    result = _result(capsys)
    assert result["actions"][0]["owner"] == "pbi-semantic-builder"
    assert result["certification"] == "NOT_CHECKED"
    working = root / "deliverables" / "u0001"
    authored = working / "author.tmdl"
    authored.write_text("measure kept = 1", encoding="utf-8")
    assert simple.main(["--resume", str(root)], runner=never_run) == 0
    _result(capsys)
    assert authored.read_text() == "measure kept = 1"
    assert len(calls) == 1
    assert len(list((parent / "_runs").glob("*/run.json"))) == 1
    state = json.loads((root / "run.json").read_text())
    assert state["stages"]["assessment"]["state"] == "skipped"
    assert "reference:u0001" not in state["stages"]
    assert any("unverified" in row for row in state["limitations"])


def test_missing_pat_is_secure_mandatory_action(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(
        simple,
        "diagnose_env",
        lambda *_a, **_k: (
            {},
            {
                "status": "BLOCKED_CONFIG",
                "reason": "configuration_inconsistent",
                "checks": [],
            },
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "prepare_tableau_source",
        SimpleNamespace(
            prepare_sources=lambda *_a, **_k: pytest.fail("must not try missing credentials"),
        ),
    )
    assert (
        simple.main(
            [
                "--runs-parent",
                str(tmp_path),
                "--workbook",
                "wb",
                "--mode",
                "single",
                "--style",
                "one-to-one",
                "--numeric",
                "none",
                "--assessment",
                "skip",
            ]
        )
        == 3
    )
    result = _result(capsys)
    assert result["actions"][0]["mandatory"]
    assert result["actions"][0]["choices"] == ["retry"]
    assert "securely" in result["actions"][0]["reason"]
    assert simple.main(["--resume", result["run"], "--decision", "configuration=continue"]) == 3
    assert _result(capsys)["actions"][0]["mandatory"]


def test_native_stage_findings_override_is_not_pass(tmp_path):
    state = {"stages": {}, "decisions": [], "limitations": []}
    artifact = tmp_path / "missing.json"
    result = simple._stage(tmp_path, state, "reference", [], {}, artifact, lambda *_: 7)
    assert result["kind"] == "human"
    state["decisions"].append({"id": "reference", "choice": "continue"})
    assert simple._stage(tmp_path, state, "reference", [], {}, artifact, lambda *_: pytest.fail("no replay")) is None
    assert {key: state["stages"]["reference"][key] for key in ("state", "native_exit_code", "artifact")} == {
        "state": "findings",
        "native_exit_code": 7,
        "artifact": str(artifact),
    }
    assert not artifact.exists()


def test_existing_artifact_refuses_automatic_replay(tmp_path):
    state = {"stages": {}, "decisions": [{"id": "reference", "choice": "retry"}], "limitations": []}
    artifact = tmp_path / "existing.json"
    artifact.write_text('{"authored":true}')
    result = simple._stage(tmp_path, state, "reference", [], {}, artifact, lambda *_: pytest.fail("overwrite"))
    assert "preserved" in result["reason"]
    assert artifact.read_text() == '{"authored":true}'


def test_resume_cannot_change_selected_scope(local_run, capsys):
    source, parent, _calls = local_run
    simple.main(_start(source, parent))
    result = _result(capsys)
    assert simple.main(["--resume", result["run"], "--workbook", "unrelated"]) == 1
    assert _result(capsys)["actions"][0]["mandatory"]


def test_comparison_is_independent_and_advisory(local_run, capsys):
    source, parent, _calls = local_run
    simple.main(_start(source, parent))
    result = _result(capsys)
    root = Path(result["run"])
    simple.main(["--resume", str(root), "--decision", "reference:u0001=continue", "--decision", "cache:u0001=continue"])
    _result(capsys)
    for stage in ("semantic", "report"):
        role = "semantic_model" if stage == "semantic" else "report"
        relative = f"deliverables/u0001/Example.{'SemanticModel' if stage == 'semantic' else 'Report'}"
        (root / relative).mkdir()
        result_file = root / f"{stage}-result.json"
        result_file.write_text(json.dumps({"state": "authored", "native_exit_code": 0, "artifacts": {role: relative}}))
        assert simple.main(["--resume", str(root), "--record", f"u0001:{stage}={result_file}"]) == 0
        result = _result(capsys)
    assert result["actions"][0]["owner"] == "pbi-migration-validator"
    comparison = root / "comparison-result.json"
    comparison.write_text(json.dumps({"state": "findings", "native_exit_code": 4}))
    assert simple.main(["--resume", str(root), "--record", f"u0001:comparison={comparison}"]) == 3
    _result(capsys)
    assert simple.main(["--resume", str(root), "--decision", "u0001:comparison=accept"]) == 0
    result = _result(capsys)
    assert result["actions"] == []
    assert result["stages"]["u0001:comparison"]["native_exit_code"] == 4
    assert result["stages"]["u0001:comparison"]["state"] == "findings"
    assert result["certification"] == "NOT_CHECKED"


def test_batch_cannot_skip_assessment(tmp_path, capsys):
    assert (
        simple.main(
            [
                "--runs-parent",
                str(tmp_path),
                "--project",
                "exact",
                "--mode",
                "batch",
                "--style",
                "one-to-one",
                "--numeric",
                "none",
                "--assessment",
                "skip",
            ]
        )
        == 1
    )
    assert _result(capsys)["actions"][0]["mandatory"]


def test_t2p_simple_json_status_and_units(local_run, capfd):
    import t2p

    source, parent, _calls = local_run
    assert t2p.main(["start", *_start(source, parent), "--json"]) == 3
    result = json.loads(capfd.readouterr().out)
    assert result["route"] == "simple/v1"
    assert result["human_actions"][0]["id"] == "reference:u0001"
    assert {stage["stage"] for stage in result["stages"]} == {"selection", "sources", "assessment"}
    assert result["path_report"] is None
    root = result["run_location"]["physical_run"]
    assert t2p.main(["status", "--run", root, "--json"]) == 0
    status = json.loads(capfd.readouterr().out)
    assert status["route"] == "simple/v1"
    assert status["human_actions"][0]["id"] == "reference:u0001"
    assert status["observations"]["units"][0]["id"] == "u0001"
    assert status["next"]["command"] is None
    assert t2p.main(["units", "show", "u0001", "--runs-parent", str(parent), "--json"]) == 0
    lookup = json.loads(capfd.readouterr().out)
    assert lookup["unit_lookup"]["candidates"][0]["source"]["name"] == "Example"


def test_replacement_preserves_native_failure(tmp_path):
    original = tmp_path / "missing.json"
    replacement = tmp_path / "replacement.json"
    replacement.write_text('{"reference":"replacement"}')
    state = {
        "stages": {"reference": {"state": "findings", "native_exit_code": 7, "artifact": str(original)}},
        "decisions": [{"id": "reference", "choice": "replace"}],
        "replacements": {"reference": str(replacement)},
        "limitations": [],
    }
    assert simple._stage(tmp_path, state, "reference", [], {}, original, lambda *_: pytest.fail("replay")) is None
    assert state["stages"]["reference"]["state"] == "replacement"
    assert state["stages"]["reference"]["native_exit_code"] == 7


def test_facade_and_backend_intake_surfaces_match():
    import argparse
    import t2p

    facade = argparse.ArgumentParser()
    backend = argparse.ArgumentParser()
    t2p._add_simple_arguments(facade)
    simple.add_arguments(backend)

    def shape(parser):
        return {
            (tuple(item.option_strings), item.dest, tuple(item.choices or ()), item.nargs) for item in parser._actions
        }

    assert shape(facade) == shape(backend)


def test_mandatory_builder_stop_cannot_be_accepted(local_run, capsys):
    source, parent, _calls = local_run
    simple.main(_start(source, parent))
    root = Path(_result(capsys)["run"])
    simple.main(["--resume", str(root), "--decision", "reference:u0001=continue"])
    _result(capsys)
    result_file = root / "semantic-result.json"
    result_file.write_text(json.dumps({"state": "failed", "native_exit_code": 1, "mandatory_stop": True}))
    assert (
        simple.main(
            [
                "--resume",
                str(root),
                "--record",
                f"u0001:semantic={result_file}",
                "--decision",
                "u0001:semantic=continue",
            ]
        )
        == 3
    )
    result = _result(capsys)
    assert result["actions"][0]["choices"] == ["retry"]
    assert result["stages"]["u0001:semantic"]["mandatory_stop"]


def test_real_local_parse_to_greenfield_handoff_without_conversion(tmp_path, capsys):
    source = Path(__file__).parent / "fixtures" / "minimal.twb"
    original = source.read_bytes()

    def no_external_process(*_args):
        pytest.fail("local single skip must not call a survey, assessor, converter, sweep, or Desktop")

    assert simple.main(_start(source, tmp_path), runner=no_external_process) == 3
    result = _result(capsys)
    root = Path(result["run"])
    assert result["actions"][0]["id"] == "reference:u0001"
    assert result["stages"]["sources"]["units"][0]["state"] == "prepared"
    unit = json.loads((root / "run.json").read_text())["units"][0]
    assert Path(unit["spec"]).is_file()
    assert Path(unit["provenance"]).is_file()
    assert (
        simple.main(["--resume", str(root), "--decision", "reference:u0001=continue"], runner=no_external_process) == 0
    )
    result = _result(capsys)
    assert result["actions"][0]["owner"] == "pbi-semantic-builder"
    assert source.read_bytes() == original
    assert not (root / "assessment" / "estate.db").exists()
    assert not (root / "bundle" / "report.json").exists()
    assert not list(root.rglob("package-manifest.json"))


def test_batch_assesses_selected_workbooks_before_harvest_and_keeps_datasources_dependencies(
    tmp_path,
    monkeypatch,
    capsys,
):
    events = []
    selected = [
        {"key": "wb-a", "kind": "workbook", "luid": "wb-a", "name": "Same"},
        {"key": "wb-b", "kind": "workbook", "luid": "wb-b", "name": "Same"},
        {"key": "ds", "kind": "datasource", "luid": "ds", "name": "External dependency"},
    ]

    def resolve(*_args, **_kwargs):
        events.append("resolve")
        return {"state": "resolved", "selection_complete": True, "units": selected, "actions": []}

    def prepare(_root, _env, **kwargs):
        events.append("prepare")
        assert kwargs["selection"]["units"] == selected
        return {
            "state": "ready",
            "native_exit_code": 0,
            "actions": [],
            "units": [{**row, "state": "prepared"} for row in selected],
        }

    def run(command, _environment):
        name = Path(command[2]).name
        events.append(name)
        if name == "assess_estate.py":
            assert [command[i + 1] for i, token in enumerate(command) if token == "--workbook"] == ["wb-a", "wb-b"]
            assert command[command.index("--project") + 1] == "exact-project"
            (Path(command[command.index("--out") + 1]) / "assessment.json").write_text('{"listing_errors":[]}')
        elif name == "assessment_report.py":
            assert "--without-survey" in command
            (Path(command[command.index("--run") + 1]) / "assessment-report.html").write_text("<html/>")
        elif name == "capture_tableau_oracle.py":
            assert "--workbook-id" in command
            destination = Path(command[command.index("--out") + 1])
            destination.mkdir()
            (destination / "oracle-manifest.json").write_text('{"views":[],"credential_blocked":0}')
        else:
            pytest.fail("unexpected advanced/engine process")
        return 0

    monkeypatch.setitem(
        sys.modules,
        "prepare_tableau_source",
        SimpleNamespace(
            resolve_selection=resolve,
            prepare_sources=prepare,
        ),
    )
    monkeypatch.setattr(simple, "diagnose_env", lambda *_a, **_k: ({}, {"status": "READY_TO_ATTEMPT"}))
    assert (
        simple.main(
            [
                "--runs-parent",
                str(tmp_path),
                "--project",
                "exact-project",
                "--mode",
                "batch",
                "--style",
                "one-to-one",
                "--numeric",
                "required",
            ],
            runner=run,
        )
        == 0
    )
    result = _result(capsys)
    assert events[:4] == ["resolve", "assess_estate.py", "assessment_report.py", "prepare"]
    state = json.loads((Path(result["run"]) / "run.json").read_text())
    assert [unit["key"] for unit in state["units"]] == ["wb-a", "wb-b"]
    assert len(result["actions"]) == 2
    assert all(item["owner"] == "pbi-semantic-builder" for item in result["actions"])
    assert state["units"][0]["working"]["root"] != state["units"][1]["working"]["root"]


def test_capture_authorization_failure_cannot_be_overridden(tmp_path):
    artifact = tmp_path / "oracle-manifest.json"
    state = {"stages": {}, "decisions": [], "limitations": []}

    def capture(_command, _environment):
        artifact.write_text('{"credential_blocked":1,"views":[]}')
        return 2

    finding = simple._stage(tmp_path, state, "reference:u0001", [], {}, artifact, capture)
    assert finding["mandatory"]
    state["decisions"].append({"id": "reference:u0001", "choice": "continue"})
    finding = simple._stage(
        tmp_path,
        state,
        "reference:u0001",
        [],
        {},
        artifact,
        lambda *_: pytest.fail("authorization must not be replayed"),
    )
    assert finding["mandatory"]
    assert state["stages"]["reference:u0001"]["native_exit_code"] == 2


def test_supplied_report_missing_model_commissions_semantic_creation_without_touching_template(tmp_path, capsys):
    source = Path(__file__).parent / "fixtures" / "minimal.twb"
    template = tmp_path / "template"
    report_folder = template / "Example.Report"
    report_folder.mkdir(parents=True)
    pbip = template / "Example.pbip"
    pbip.write_text(json.dumps({"version": "1.0", "artifacts": [{"report": {"path": "Example.Report"}}]}))
    binding = report_folder / "definition.pbir"
    binding.write_text(
        json.dumps(
            {
                "version": "4.0",
                "datasetReference": {
                    "byPath": {"path": "../Example.SemanticModel"},
                },
            }
        )
    )
    before = {str(path.relative_to(template)): path.read_bytes() for path in template.rglob("*") if path.is_file()}
    simple.main(_start(source, tmp_path))
    result = _result(capsys)
    root = Path(result["run"])
    state = json.loads((root / "run.json").read_text())
    key = state["units"][0]["key"]
    assert (
        simple.main(["--resume", str(root), "--pbip", f"{key}={pbip}", "--decision", "reference:u0001=continue"]) == 0
    )
    result = _result(capsys)
    assert result["actions"][0]["owner"] == "pbi-semantic-builder"
    state = json.loads((root / "run.json").read_text())
    working = state["units"][0]["working"]
    assert working["semantic_model"] is None
    assert not Path(working["expected_semantic_model"]).exists()
    assert Path(working["report"]).is_dir()
    assert before == {
        str(path.relative_to(template)): path.read_bytes() for path in template.rglob("*") if path.is_file()
    }


def test_explicit_capture_retry_preserves_original_native_failure_and_partial_evidence(tmp_path):
    artifact = tmp_path / "oracle-manifest.json"
    state = {"stages": {}, "decisions": [], "limitations": []}
    original = '{"views":[],"credential_blocked":0,"partial":true}'

    def first(_command, _environment):
        artifact.write_text(original)
        return 3

    command = ["capture", "--out", str(tmp_path)]
    assert simple._stage(tmp_path, state, "reference:u0001", command, {}, artifact, first)["kind"] == "human"
    state["decisions"].append({"id": "reference:u0001", "choice": "retry"})

    def retry(args, _environment):
        destination = Path(args[args.index("--out") + 1])
        assert destination != tmp_path
        destination.mkdir()
        (destination / artifact.name).write_text('{"views":[],"credential_blocked":0}')
        return 0

    assert simple._stage(tmp_path, state, "reference:u0001", command, {}, artifact, retry) is None
    assert artifact.read_text() == original
    current = state["stages"]["reference:u0001"]
    assert current["native_exit_code"] == 0
    assert current["attempts"][0]["native_exit_code"] == 3
    assert Path(current["artifact"]).parent != tmp_path


@pytest.mark.parametrize(
    ("pbips", "targets", "message"),
    [
        ({"workbook-key": "/first.pbip", "luid": "/second.pbip"}, {}, "conflicting_workbook_PBIP_mappings"),
        ({}, {"workbook-key:server": "first", "luid:server": "second"}, "conflicting_connection_targets"),
    ],
)
def test_identity_aliases_cannot_silently_choose_conflicting_mappings(tmp_path, pbips, targets, message):
    state = {
        "units": [{"id": "u0001", "key": "workbook-key", "luid": "luid"}],
        "pbips": pbips,
        "targets": targets,
        "decisions": [],
        "limitations": [],
    }
    with pytest.raises(ValueError, match=message):
        simple._prepare_working(tmp_path, state)
    assert not (tmp_path / "deliverables").exists()


def test_unapplied_mapping_can_be_corrected_without_retargeting_another_units_work(tmp_path):
    state = {
        "units": [
            {"key": "first", "working": {"root": str(tmp_path)}},
            {"key": "second"},
        ],
        "pbips": {"first": "/first.pbip", "second": "/missing.pbip"},
        "targets": {},
        "replacements": {},
        "decisions": [],
    }
    args = SimpleNamespace(
        pbip=["second=/replacement.pbip"], target=[], replacement=[], connection_example=None, decision=[]
    )
    simple._apply_inputs(args, state)
    assert state["pbips"]["second"] == "/replacement.pbip"
    args.pbip = ["first=/other.pbip"]
    with pytest.raises(ValueError, match="existing_authored_mapping_change_refused"):
        simple._apply_inputs(args, state)
    assert state["pbips"]["first"] == "/first.pbip"


def test_failed_connection_example_can_be_replaced_before_handoff(local_run, capsys, monkeypatch):
    source, parent, calls = local_run
    examples = [parent / f"sample-{index}.pbip" for index in range(3)]
    inspections = []

    def inspect(path):
        inspections.append(path)
        if path != examples[-1]:
            raise PBIPRefusal("Referenced report/model directory is missing")
        return {"project_file": str(path), "connections": [{"connector": "Sql.Database"}]}

    monkeypatch.setitem(sys.modules, "simple_pbip", SimpleNamespace(inspect_connections=inspect))
    simple.main(_start(source, parent, "--connection-example", str(examples[0])))
    root = Path(_result(capsys)["run"])
    resume = ["--resume", str(root), "--decision", "reference:u0001=continue"]
    assert simple.main(resume) == 1
    assert _result(capsys)["actions"][0]["reason"] == "operation_refused:PBIPRefusal"
    state = json.loads((root / "run.json").read_text())
    assert "connection_inspection" not in state
    assert all("working" not in unit for unit in state["units"])
    assert simple.main([*resume, "--connection-example", str(examples[1])]) == 1
    assert _result(capsys)["actions"][0]["reason"] == "operation_refused:PBIPRefusal"
    assert simple.main([*resume, "--connection-example", str(examples[2])]) == 0
    result = _result(capsys)
    assert result["actions"][0]["owner"] == "pbi-semantic-builder"
    state = json.loads((root / "run.json").read_text())
    assert state["connection_example"] == str(examples[-1])
    assert state["connection_example_history"] == [str(path) for path in examples[:-1]]
    assert state["connection_inspection"]["project_file"] == str(examples[-1])
    brief = Path(result["actions"][0]["brief"]).read_text(encoding="utf-8")
    assert f'"example": {json.dumps(str(examples[-1]))}' in brief
    assert inspections == examples
    assert len(calls) == 1
    assert simple.main([*resume, "--connection-example", str(examples[-1])]) == 0
    _result(capsys)
    assert (
        json.loads((root / "run.json").read_text())["connection_example_history"] == state["connection_example_history"]
    )
    assert inspections == examples


@pytest.mark.parametrize("used_by", ["inspection", "working"])
def test_used_connection_example_replacement_preserves_persisted_inputs(local_run, capsys, used_by):
    source, parent, _calls = local_run
    original = parent / "original.pbip"
    simple.main(_start(source, parent, "--connection-example", str(original)))
    root = Path(_result(capsys)["run"])
    manifest = root / "run.json"
    state = json.loads(manifest.read_text())
    if used_by == "inspection":
        state["connection_inspection"] = None
    else:
        state["units"][0]["working"] = {"root": str(root / "deliverables" / "u0001")}
    manifest.write_text(json.dumps(state), encoding="utf-8")
    before = manifest.read_bytes()
    assert (
        simple.main(
            [
                "--resume",
                str(root),
                "--connection-example",
                str(parent / "replacement.pbip"),
                "--pbip",
                f"local-example={parent / 'another.pbip'}",
            ]
        )
        == 1
    )
    assert _result(capsys)["actions"][0]["mandatory"]
    assert manifest.read_bytes() == before


def test_explicitly_skipped_unknown_mapping_resumes_same_run_and_preserves_decision(local_run, capsys):
    source, parent, _calls = local_run
    simple.main(_start(source, parent, "--pbip", "wrong=/unused.pbip"))
    root = Path(_result(capsys)["run"])
    assert simple.main(["--resume", str(root), "--decision", "reference:u0001=continue"]) == 3
    assert _result(capsys)["actions"][0]["id"] == "mapping:u0001"
    assert simple.main(["--resume", str(root), "--decision", "mapping:wrong=skip"]) == 0
    result = _result(capsys)
    assert result["actions"][0]["owner"] == "pbi-semantic-builder"
    state = json.loads((root / "run.json").read_text())
    assert state["pbips"]["wrong"] == "/unused.pbip"
    assert any("supplied_mapping_not_applied" in item for item in state["limitations"])


def test_explicit_builder_retry_preserves_authored_artifacts(local_run, capsys):
    source, parent, _calls = local_run
    simple.main(_start(source, parent))
    root = Path(_result(capsys)["run"])
    simple.main(["--resume", str(root), "--decision", "reference:u0001=continue"])
    _result(capsys)
    relative = "deliverables/u0001/Example.SemanticModel"
    model = root / relative
    model.mkdir()
    authored = model / "author.tmdl"
    authored.write_text("measure preserved = 1")
    record = root / "semantic-result.json"
    record.write_text(
        json.dumps({"state": "authored", "native_exit_code": 0, "artifacts": {"semantic_model": relative}})
    )
    simple.main(["--resume", str(root), "--record", f"u0001:semantic={record}"])
    assert _result(capsys)["actions"][0]["id"] == "cache:u0001"
    assert simple.main(["--resume", str(root), "--decision", "u0001:semantic=retry"]) == 0
    result = _result(capsys)
    assert result["actions"][0]["owner"] == "pbi-semantic-builder"
    assert result["stages"]["u0001:semantic"]["state"] == "authored"
    assert authored.read_text() == "measure preserved = 1"
    retried = root / "semantic-retry-result.json"
    retried.write_text(json.dumps({"state": "authored", "native_exit_code": 0}))
    assert simple.main(["--resume", str(root), "--record", f"u0001:semantic={retried}"]) == 3
    result = _result(capsys)
    assert result["actions"][0]["id"] == "cache:u0001"
    assert result["stages"]["u0001:semantic"]["attempts"][0]["artifact"] == str(record)
    assert simple.main(["--resume", str(root)]) == 3
    assert _result(capsys)["actions"][0]["id"] == "cache:u0001"

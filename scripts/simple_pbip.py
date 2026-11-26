"""Read-only PBIP intake and exclusive, run-owned copies for simple assessment.

Library only. This does not emit a model, edit connections, refresh data, or establish fidelity.
Only a single local report binding is supported; existing models must be TMDL. A missing local
model is returned as a planned builder address, never fabricated. Existing destinations refuse:
the caller owns resume and must reuse its recorded working paths instead of replaying the copy.
"""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path, PureWindowsPath

from bundle_corpus import is_reparse_entry
from harvest_estate_assets import refuse_unignored_output
from work_dirs import _load_selected_run


class PBIPRefusal(ValueError):
    """Structural refusal, without echoing source content or credential values."""


_SECRET = re.compile(
    r"password|passwd|pwd|secret|token|credential|authorization|api.?key|access.?key|private.?key|connectionstring"
    r"|username|user.?id|\buid\b|\bbearer\b",
    re.I,
)
_STRING = re.compile(r'(?<!#)"(?:[^"]|"")*"')
_COMMENTS = re.compile(r'("(?:[^"]|"")*"|//[^\n]*|/\*.*?\*/)', re.S)
_INLINE_DATA = re.compile(
    r"#table\s*\(|Table\.From(?:Rows|Records|Columns)\s*\(|Binary\.(?:Decompress|FromText)\s*\("
    r'|(?:Json|Csv|Xml)\.Document\s*\(\s*"|DATATABLE\s*\(',
    re.I,
)
_URL_AUTH = re.compile(r"https?://[^/\s\"<>]+:[^/\s\"<>]+@|[?&](?:key|sig|signature|auth)=", re.I)
_CONNECTORS = {
    "Sql.Database": ("server", "database"),
    "Snowflake.Databases": ("server", "warehouse"),
    "PostgreSQL.Database": ("server", "database"),
    "MySQL.Database": ("server", "database"),
    "Oracle.Database": ("server",),
    "AmazonRedshift.Database": ("server", "database"),
}
_CONNECTOR_PATTERN = re.compile(
    r"\b("
    + "|".join(re.escape(name) for name in _CONNECTORS)
    + r')\s*\(\s*((?:"(?:[^"]|"")*"|[^,)])+)(?:,\s*((?:"(?:[^"]|"")*"|[^,)])+))?'
)
_BLOCK = re.compile(r"^(?P<indent>[ \t]*)(?P<kind>expression|partition)\s+(?P<name>'(?:[^']|'')*'|[^=\n]+)", re.M)


def _path(path: Path) -> Path:
    """Inspect components before normalization, so '..' cannot erase a reparse entry."""
    path = Path(path)
    if ".." in path.parts or str(path).replace("\\", "/").startswith("//"):
        raise PBIPRefusal("Unsafe path: traversal, UNC and device spellings are not supported")
    path = path.absolute()
    for component in reversed((path, *path.parents)):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if is_reparse_entry(info):
            raise PBIPRefusal("Unsafe path: symlink, junction or reparse point")
        if component != path and not stat.S_ISDIR(info.st_mode):
            raise PBIPRefusal("Unsafe path: non-directory ancestor")
    return path


def _read(path: Path) -> bytes:
    path = _path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise PBIPRefusal("Artifact must be a regular, unshared file")
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise PBIPRefusal("Artifact identity changed while reading")
        return stream.read()


def _json(path: Path) -> dict:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PBIPRefusal("Ambiguous JSON: duplicate keys")
            result[key] = value
        return result

    try:
        value = json.loads(_read(path).decode("utf-8-sig"), object_pairs_hook=unique)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PBIPRefusal("Artifact is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise PBIPRefusal("Artifact JSON must be an object")
    return value


def _reference(base: Path, declared: object, root: Path, *, allow_missing: bool = False) -> Path:
    if not isinstance(declared, str) or not declared or PureWindowsPath(declared).drive:
        raise PBIPRefusal("Binding must be an unambiguous local relative path")
    spelling = declared.replace("\\", "/")
    if spelling.startswith("/") or ":" in spelling:
        raise PBIPRefusal("External report/model references are not supported")
    current = base
    for part in spelling.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            current = current.parent
        else:
            current = _path(current / part)
        if not current.is_relative_to(root):
            raise PBIPRefusal("Report/model binding escapes the supplied project")
    if allow_missing and not current.exists():
        return current
    if not current.is_dir():
        raise PBIPRefusal("Referenced report/model directory is missing")
    return current


def _layout(source: Path, *, allow_missing_model: bool = False) -> tuple[Path, Path, Path]:
    source = _path(source)
    if source.suffix.lower() != ".pbip":
        raise PBIPRefusal("Supply an existing .pbip project file")
    project = _json(source)
    artifacts = project.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 1:
        raise PBIPRefusal("Exactly one report artifact is required; ambiguous projects refuse")
    artifact = artifacts[0]
    if not isinstance(artifact, dict) or set(artifact) != {"report"} or not isinstance(artifact["report"], dict):
        raise PBIPRefusal("Project must declare one report path")
    if set(artifact["report"]) != {"path"}:
        raise PBIPRefusal("Project report reference is ambiguous")
    report = _reference(source.parent, artifact["report"]["path"], source.parent)
    if report.suffix.lower() != ".report":
        raise PBIPRefusal("Referenced artifact must be a .Report directory")
    binding = _json(report / "definition.pbir").get("datasetReference")
    if not isinstance(binding, dict) or set(binding) != {"byPath"}:
        raise PBIPRefusal("Only a local byPath model binding is supported; byConnection refuses")
    by_path = binding["byPath"]
    if not isinstance(by_path, dict) or set(by_path) != {"path"}:
        raise PBIPRefusal("Model binding is ambiguous")
    model = _reference(report, by_path["path"], source.parent, allow_missing=allow_missing_model)
    if (
        model.suffix.lower() != ".semanticmodel"
        or model == report
        or report.is_relative_to(model)
        or model.is_relative_to(report)
    ):
        raise PBIPRefusal("Binding must identify a separate .SemanticModel directory")
    if allow_missing_model and not model.exists():
        return source, report, model
    _json(model / "definition.pbism")
    try:
        _read(model / "definition" / "model.tmdl")
    except FileNotFoundError as exc:
        raise PBIPRefusal("A TMDL model is required; BIM and remote models are unsupported") from exc
    return source, report, model


def _files(root: Path, role: str):
    """Allow only authored PBIP artifacts, never arbitrary adjacent/template data."""
    for entry in sorted(root.iterdir()):
        entry = _path(entry)
        info = entry.lstat()
        if entry.name.lower() in {".pbi", ".git", ".env", ".env.local", "data", "credentials"}:
            continue
        if stat.S_ISDIR(info.st_mode):
            if entry.parent == root and entry.name not in {"definition", "StaticResources"}:
                continue
            yield from _files_nested(entry, root, role)
        elif _allowed(entry, root, role):
            yield entry
        elif not stat.S_ISREG(info.st_mode):
            raise PBIPRefusal("Non-regular artifact in supplied tree")


def _files_nested(directory: Path, root: Path, role: str):
    for entry in sorted(directory.iterdir()):
        entry = _path(entry)
        info = entry.lstat()
        if stat.S_ISDIR(info.st_mode):
            if entry.name.lower() not in {".pbi", ".git", "data", "credentials"}:
                yield from _files_nested(entry, root, role)
        elif not stat.S_ISREG(info.st_mode):
            raise PBIPRefusal("Non-regular artifact in supplied tree")
        elif _allowed(entry, root, role):
            yield entry


def _allowed(path: Path, root: Path, role: str) -> bool:
    relative = path.relative_to(root)
    if len(relative.parts) == 1:
        return path.name in (
            {"definition.pbir", "report.json", ".platform"}
            if role == "report"
            else {"definition.pbism", "diagramLayout.json", ".platform"}
        )
    if relative.parts[0] == "definition":
        return path.suffix.lower() == (".json" if role == "report" else ".tmdl")
    return (
        role == "report"
        and relative.parts[0] == "StaticResources"
        and path.suffix.lower() in {".json", ".png", ".jpg", ".jpeg", ".svg", ".gif"}
    )


def _no_credentials(value: object) -> bool:
    if isinstance(value, dict):
        return any(_SECRET.search(key) or _no_credentials(child) for key, child in value.items())
    if isinstance(value, list):
        return any(_no_credentials(child) for child in value)
    return isinstance(value, str) and bool(_SECRET.search(value))


def _copy_payload(path: Path) -> bytes:
    payload = _read(path)
    if (
        path.suffix.lower() in {".tmdl", ".json", ".pbip", ".pbir", ".pbism", ".platform", ".svg"}
        or path.name == ".platform"
    ):
        try:
            text = payload.decode("utf-8-sig")
        except UnicodeError as exc:
            raise PBIPRefusal("Authored artifact must be UTF-8") from exc
        if _SECRET.search(text) or _URL_AUTH.search(text):
            raise PBIPRefusal("Credential-bearing artifact refuses; supply a credential-free project")
        if _INLINE_DATA.search(text):
            raise PBIPRefusal("Embedded template data refuses; supply a source-backed model without inline rows")
        if path.suffix.lower() in {".json", ".pbip", ".pbir", ".pbism"} or path.name == ".platform":
            if _no_credentials(_json(path)):
                raise PBIPRefusal("Credential-bearing artifact refuses")
    return payload


def _report_files(report: Path) -> list[Path]:
    candidates = list(_files(report, "report"))
    authored = [path for path in candidates if path.relative_to(report).parts[0] != "StaticResources"]
    resources = [path for path in candidates if path not in authored]

    def strings(value):
        if isinstance(value, str):
            yield value.replace("\\", "/").rsplit("/", 1)[-1]
        elif isinstance(value, dict):
            for child in value.values():
                yield from strings(child)
        elif isinstance(value, list):
            for child in value:
                yield from strings(child)

    references = set()
    for path in authored:
        references.update(strings(_json(path)))
    selected = []
    while resources:
        found = [path for path in resources if path.name in references or path.stem in references]
        if not found:
            break
        for path in found:
            selected.append(path)
            resources.remove(path)
            if path.suffix == ".json":
                references.update(strings(_json(path)))
    return authored + selected


def _destination(destination: Path) -> Path:
    destination = _path(destination)
    if destination.exists():
        raise PBIPRefusal("Destination already exists; reuse recorded custody paths, never overwrite authored work")
    for ancestor in destination.parents:
        if (ancestor / "run.json").exists():
            _, problem = _load_selected_run(ancestor)
            if problem:
                raise PBIPRefusal("Destination run custody cannot be established")
            return destination
    raise PBIPRefusal("Destination must belong to an existing allocated run")


def _paths(project: Path, report: Path, model: Path) -> dict:
    return {"project_file": str(project), "report": str(report), "semantic_model": str(model)}


def _copied_paths(project: Path) -> dict:
    project, report, model = _layout(project, allow_missing_model=True)
    result = {"root": str(project.parent), **_paths(project, report, model)}
    if not model.exists():
        result["semantic_model"] = None
        result["expected_semantic_model"] = str(model)
    return result


def copy_pbip(source: Path, destination: Path) -> dict:
    """Copy the bound report and any existing model. Missing model paths are planning only."""
    project, report, model = _layout(source, allow_missing_model=True)
    destination = _destination(destination)
    if destination.is_relative_to(project.parent) or project.parent.is_relative_to(destination):
        raise PBIPRefusal("Source and destination trees must not overlap")
    payloads = {project.relative_to(project.parent): _copy_payload(project)}
    for root, role in ((report, "report"), (model, "model")):
        if not root.exists():
            continue
        for path in _report_files(root) if role == "report" else _files(root, role):
            payloads[path.relative_to(project.parent)] = _copy_payload(path)
    if refuse_unignored_output(destination, None, artifacts=[str(path) for path in payloads]):
        raise PBIPRefusal("Working artifacts must be git-ignored")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir()
    # Exclusive file creation means a failed/partial copy is never replayed over authored work.
    for relative, payload in payloads.items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(payload)
    return _copied_paths(destination / project.name)


def plan_greenfield(destination: Path, name: str = "Report") -> dict:
    """Return future working addresses only. No directories, model, report or data are emitted."""
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,79}", name):
        raise PBIPRefusal("Greenfield name must be a simple artifact identifier")
    destination = _destination(destination)
    return {
        "root": str(destination),
        **_paths(destination / f"{name}.pbip", destination / f"{name}.Report", destination / f"{name}.SemanticModel"),
        "emitted": False,
    }


def _without_comments(text: str) -> str:
    return _COMMENTS.sub(lambda match: match[0] if match[0].startswith('"') else "", text)


def _slot(argument: str, slot: str, location: dict) -> dict | None:
    argument = argument.strip()
    if _STRING.fullmatch(argument):
        value = argument[1:-1].replace('""', '"')
        if _SECRET.search(value) or re.search(r"[;=?@]", value):
            return None
        return {**location, "slot": slot, "value": value, "parameter": None}
    if re.fullmatch(r'#"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*', argument):
        name = argument[2:-1].replace('""', '"') if argument.startswith('#"') else argument
        return {**location, "slot": slot, "value": None, "parameter": name}
    return None


def _expression_blocks(model: Path):
    for path in _files(model, "model"):
        if path.suffix.lower() != ".tmdl":
            continue
        text = _read(path).decode("utf-8-sig")
        blocks = list(_BLOCK.finditer(text))
        for index, block in enumerate(blocks):
            body = _without_comments(
                text[block.end() : blocks[index + 1].start() if index + 1 < len(blocks) else len(text)]
            )
            name = block["name"].strip().strip("'").replace("''", "'")
            yield (
                {
                    "file": str(path.relative_to(model)),
                    "name": name,
                    "kind": block["kind"],
                    "line": text[: block.start()].count("\n") + 1,
                },
                body,
            )


def _in_literal(position: int, literal_spans: list[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in literal_spans)


def _navigation_slots(body: str, location: dict, literal_spans: list[tuple[int, int]]):
    for match in re.finditer(r'\bSchema\s*=\s*("(?:[^"]|"")*"|#"(?:[^"]|"")*"|[A-Za-z_]\w*)', body):
        if not _in_literal(match.start(), literal_spans):
            if target := _slot(match[1], "schema", location):
                yield target
    for match in re.finditer(r"\[([^\]\n]*)\]", body):
        if _in_literal(match.start(), literal_spans):
            continue
        record = match[1]
        if re.search(r'\bKind\s*=\s*"Database"', record):
            named = re.search(r'\bName\s*=\s*("(?:[^"]|"")*"|#"(?:[^"]|"")*"|[A-Za-z_]\w*)', record)
            if named and (target := _slot(named[1], "database", location)):
                yield target


def _connection_targets(body: str, location: dict) -> tuple[list, list]:
    connections, slots = [], []
    literal_spans = [(match.start(), match.end()) for match in _STRING.finditer(body)]
    for match in _CONNECTOR_PATTERN.finditer(body):
        if _in_literal(match.start(), literal_spans):
            continue
        connector = match[1]
        connections.append({**location, "connector": connector})
        for position, slot in enumerate(_CONNECTORS[connector], start=2):
            if match[position] and (target := _slot(match[position], slot, {**location, "connector": connector})):
                slots.append(target)
    slots.extend(_navigation_slots(body, location, literal_spans))
    return connections, slots


def inspect_connections(example_pbip: Path) -> dict:
    """Inspect real TMDL/M, returning literal-redacted expressions and explicit target slots.

    Arbitrary string literals, comments and numeric literals are omitted from expression bodies.
    Only recognized server/warehouse/database/schema target values survive. Secrets, source rows,
    cache files and unrelated siblings are never returned. Builders own any commissioned edits.
    """
    project, report, model = _layout(example_pbip)
    expressions, parameters, connections, slots = [], [], [], []
    for location, body in _expression_blocks(model):
        safe_body = _STRING.sub('"[REDACTED]"', body)
        safe_body = re.sub(r"\b\d+(?:\.\d+)?\b", "[NUMBER]", safe_body)
        omitted = _SECRET.search(location["name"]) or _INLINE_DATA.search(body)
        expressions.append({**location, "expression": "[REDACTED]" if omitted else safe_body})
        if re.search(r"IsParameterQuery\s*=\s*true", body, re.I):
            parameters.append({**location, "value": None})
        if not omitted:
            targets = _connection_targets(body, location)
            connections.extend(targets[0])
            slots.extend(targets[1])
    parameter_names = {item["name"] for item in parameters}
    for target in slots:
        if target["parameter"] not in parameter_names and target["parameter"] is not None:
            target["unresolved_parameter"] = True
        if target["parameter"] and _SECRET.search(target["parameter"]):
            target["value"] = None
    return {
        **_paths(project, report, model),
        "expressions": expressions,
        "parameters": parameters,
        "connections": connections,
        "target_change_slots": slots,
        "limitations": [
            "Only recognized connector arguments and schema navigation are classified; "
            "builders must inspect unclassified expressions."
        ],
    }

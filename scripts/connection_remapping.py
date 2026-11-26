"""Internal, inert connection-target sample import and static working-partition comparison."""

from __future__ import annotations

import hashlib
import json
import re
import stat
from pathlib import Path
from typing import Any

from check_empty_model import _partition_blocks

LIMIT = 1024 * 1024
NAME = re.compile(r"[A-Za-z0-9_ ./$-]{1,256}\Z")
HOST = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}\Z")
PLATFORMS = {"snowflake", "sqlserver", "postgres", "databricks"}


def canonical(value: Any) -> str:
    """Pinned v1 JSON identity: sorted keys, ASCII escapes, compact separators, SHA256."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def source_key(entry: dict[str, Any]) -> str:
    """Identity excludes progress, credentials and target decisions."""
    identity = {key: entry[key] for key in ("name", "connection", "legs")}
    return "v1:" + hashlib.sha256(canonical(identity).encode("utf-8")).hexdigest()


def fields(value: Any, required: set[str], optional: set[str] | None = None) -> None:
    """Reject unknown fields rather than copying untrusted sample content."""
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - (optional or set()):
        raise ValueError("Connection sample has missing, duplicate or unsupported fields.")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Connection sample has duplicate fields.")
        result[key] = value
    return result


def physical(path: Path) -> Path:
    """Reject aliases before resolving a private sample or working artifact."""
    absolute = path.absolute()
    if ".." in absolute.parts:
        raise ValueError("Connection sample/artifact paths must be physical, without parent traversal.")
    for part in (absolute, *absolute.parents):
        info = part.lstat()
        if part.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Linked connection sample/artifact paths are not supported.")
        if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise ValueError("Sample/table files require independent regular-file custody.")
    return absolute.resolve(strict=True)


def read_sample(path: Path) -> dict[str, Any]:
    """Read bounded JSON only, never executable M or embedded credentials."""
    path = physical(path)
    if path.stat().st_size > LIMIT:
        raise ValueError("Connection sample exceeds 1 MB.")
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_pairs)


def scalar(value: Any, *, host: bool = False) -> str:
    """Endpoint/name grammar admits no URL credentials, assignments or executable syntax."""
    if not isinstance(value, str) or not (HOST if host else NAME).fullmatch(value):
        raise ValueError("Invalid target endpoint/name; use non-secret scalar configuration only.")
    return value


def expression(target: dict[str, str], table: str) -> str:
    """Generate a complete, bounded partition, not arbitrary M supplied by a sample."""
    platform = target["class"]

    def quote(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    server = quote(target["server"])
    database = quote(target["database"])
    schema = quote(target["schema"])
    name = quote(table)
    if platform == "snowflake":
        root = f"Snowflake.Databases({server}, {quote(target['warehouse'])})"
        steps = [
            f'Database = Source{{[Name={database},Kind="Database"]}}[Data]',
            f'Schema = Database{{[Name={schema},Kind="Schema"]}}[Data]',
            f'Data = Schema{{[Name={name},Kind="Table"]}}[Data]',
        ]
    elif platform == "databricks":
        root = f"Databricks.Catalogs({server}, {quote(target['httpPath'])}, null)"
        steps = [
            f'Database = Source{{[Name={database},Kind="Database"]}}[Data]',
            f'Schema = Database{{[Name={schema},Kind="Schema"]}}[Data]',
            f'Data = Schema{{[Name={name},Kind="Table"]}}[Data]',
        ]
    else:
        connector = "Sql.Database" if platform == "sqlserver" else "PostgreSQL.Database"
        root = f"{connector}({server}, {database})"
        steps = [f"Data = Source{{[Schema={schema},Item={name}]}}[Data]"]
    return "let\n    Source = " + root + ",\n    " + ",\n    ".join(steps) + "\nin\n    Data"


def approve(manifest: dict[str, Any], sample: dict[str, Any]) -> dict[str, Any]:
    """Resolve every source exactly once; retain source metadata rather than relabeling it."""
    fields(sample, {"schema", "confirmed", "mappings"})
    if sample["schema"] != "connection-targets/1" or sample["confirmed"] is not True:
        raise ValueError("Explicitly confirm the connection-targets/1 sample.")
    mappings = sample["mappings"]
    sources = manifest["connections"]
    keys = [source_key(entry) for entry in sources]
    if len(set(keys)) != len(keys):
        raise ValueError("Sanitized connection identities are ambiguous; resolve source attribution first.")
    if not isinstance(mappings, list) or not 1 <= len(mappings) <= 1000:
        raise ValueError("Provide 1..1000 explicit source mappings.")
    used: set[str] = set()
    tables: set[str] = set()
    approved = []
    for mapping in mappings:
        fields(mapping, {"sourceKey", "confirmed", "target", "bindings"})
        key = mapping["sourceKey"]
        if not isinstance(key, str) or key not in keys or key in used or mapping["confirmed"] is not True:
            raise ValueError("Confirm each unique exact source key from the current manifest.")
        used.add(key)
        target = mapping["target"]
        fields(target, {"class", "server", "database", "schema"}, {"warehouse", "httpPath"})
        if not isinstance(target["class"], str) or target["class"] not in PLATFORMS:
            raise ValueError("Supported sample platforms: snowflake, sqlserver, postgres, databricks.")
        extras = (
            {"warehouse"}
            if target["class"] == "snowflake"
            else {"httpPath"}
            if target["class"] == "databricks"
            else set()
        )
        fields(target, {"class", "server", "database", "schema"} | extras)
        for field, value in target.items():
            scalar(value, host=field == "server")
        bindings = mapping["bindings"]
        if not isinstance(bindings, list) or not 1 <= len(bindings) <= 1000:
            raise ValueError("Provide exact table/partition bindings for each source.")
        converted = []
        for binding in bindings:
            fields(binding, {"table", "partition", "targetTable"})
            for value in binding.values():
                scalar(value)
            table = binding["table"]
            if table in tables or "/" in table or table in (".", ".."):
                raise ValueError("Every working table must have one unambiguous connection binding.")
            tables.add(table)
            converted.append({**binding, "expression": expression(target, binding["targetTable"])})
        source = sources[keys.index(key)]
        approved.append(
            {
                "sourceKey": key,
                "target": dict(target),
                "bindings": converted,
                "platform_changed": target["class"] != source["connection"].get("class"),
                "attribution_unverified": True,
                "semantic_tasks": [
                    "Verify SQL/navigation, column types, calculations, report bindings and security against the target."
                ],
            }
        )
    if used != set(keys):
        raise ValueError("Map all source keys explicitly; unmapped connections cannot be silently preserved.")
    return {
        "schema": "approved-connection-targets/1",
        "template": "canonical-navigation/1",
        "manifest_hash": hashlib.sha256(
            canonical([{key: row[key] for key in ("name", "connection", "legs")} for row in sources]).encode("utf-8")
        ).hexdigest(),
        "mappings": approved,
        "source_semantics": "UNVERIFIED",
        "validation_reused": False,
    }


def _normalize(value: str) -> str:
    return "\n".join(line.lstrip(" \t") for line in value.replace("\r\n", "\n").strip("\n").split("\n"))


def check_targets(bundle: Path, model: Path, approved: dict[str, Any]) -> dict[str, Any]:
    """Compare complete canonical target partitions, never certify provenance or real data."""
    root = physical(bundle if bundle.is_dir() else bundle.parent)
    model = physical(model)
    allowed = [root / "pbip", root / "fabric"]
    if not model.is_dir() or not any(model.is_relative_to(path) for path in allowed):
        raise ValueError(
            "Check only a working model under bundle/pbip or package/fabric; never pristine/supplied models."
        )
    table_root = physical(model / "definition" / "tables")
    results = []
    for mapping in approved["mappings"]:
        for binding in mapping["bindings"]:
            status = "NOT_CHECKED"
            file = table_root / (binding["table"] + ".tmdl")
            if file.exists():
                file = physical(file)
                if file.stat().st_size > LIMIT:
                    raise ValueError("Working table exceeds 1 MB.")
                text = file.read_text(encoding="utf-8-sig")
                declarations = re.findall(r"^table\s+(.+?)\s*$", text, re.MULTILINE)
                declared = "'" + binding["table"].replace("'", "''") + "'"
                blocks = _partition_blocks(text)
                owned = False
                exact_partition = False
                if len(blocks) == 1:
                    lines = text.splitlines()
                    partition_line = blocks[0]["line"] - 1
                    header = lines[partition_line]
                    raw_name = re.fullmatch(r"\s*partition\s+(.+?)\s*=\s*m\s*", header)
                    expected_name = "'" + binding["partition"].replace("'", "''") + "'"
                    exact_partition = raw_name is not None and raw_name[1] in (binding["partition"], expected_name)
                    depth = len(header[: len(header) - len(header.lstrip())].expandtabs(4))
                    for prior in reversed(lines[:partition_line]):
                        if prior.strip() and len(prior[: len(prior) - len(prior.lstrip())].expandtabs(4)) < depth:
                            owned = prior in ("table " + binding["table"], "table " + declared)
                            break
                if (
                    declarations in ([binding["table"]], [declared])
                    and len(blocks) == 1
                    and owned
                    and exact_partition
                    and blocks[0]["kind"].lower() == "m"
                ):
                    body = blocks[0]["body"]
                    # A complete source expression only; metadata after it needs host interpretation.
                    match = re.fullmatch(r"\s*mode:\s*import\s*\n\s*source\s*=\s*\n([\s\S]+)", body)
                    if match:
                        status = (
                            "TEXT_MATCHED"
                            if _normalize(match[1]) == _normalize(expression(mapping["target"], binding["targetTable"]))
                            else "MISMATCH"
                        )
            results.append(
                {
                    "sourceKey": mapping["sourceKey"],
                    "table": binding["table"],
                    "status": status,
                    "attribution_unverified": True,
                }
            )
    return {
        "source_semantics": "UNVERIFIED",
        "checks": results,
        "status": "MISMATCH"
        if any(row["status"] == "MISMATCH" for row in results)
        else "NOT_CHECKED"
        if any(row["status"] == "NOT_CHECKED" for row in results)
        else "TEXT_MATCHED",
    }

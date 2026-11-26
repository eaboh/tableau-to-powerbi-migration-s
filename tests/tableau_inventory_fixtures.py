"""Upgrade legacy parser fixtures to the documented paginated wire envelope."""

import json


def connection_body(body):
    try:
        payload = json.loads(body)
    except (ValueError, TypeError, RecursionError):
        return body
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
        return body
    data = payload["data"]
    if "workbooks" not in data:
        return body
    nodes = data.pop("workbooks")
    if isinstance(nodes, list):
        nodes = [
            {"luid": f"00000000-0000-4000-8000-{index:012d}", **node} if isinstance(node, dict) else node
            for index, node in enumerate(nodes)
        ]
    data["workbooksConnection"] = {
        "nodes": nodes,
        "pageInfo": {"hasNextPage": False, "endCursor": None},
    }
    return json.dumps(payload).encode()

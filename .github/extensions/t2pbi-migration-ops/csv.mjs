export function csvCell(value) {
    let result = String(value ?? "");
    if (/^[\s]*[=+\-@]/u.test(result) || /^[\t\r\n]/u.test(result)) result = `'${result}`;
    return `"${result.replaceAll('"', '""')}"`;
}

export function toCsv(rows, columns) {
    return "\uFEFF" + [columns, ...rows.map((row) => columns.map((key) => row[key]))]
        .map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

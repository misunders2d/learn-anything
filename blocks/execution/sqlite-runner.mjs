export const SQL_RESULT_PREFIX = "__LEARN_ANYTHING_SQL__";

export const sqlRunnerSource = `import json
import sqlite3
import sys
from pathlib import Path

connection = sqlite3.connect(":memory:")

def authorize(action, _arg1, _arg2, _database, _trigger):
    denied = {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH}
    return sqlite3.SQLITE_DENY if action in denied else sqlite3.SQLITE_OK

connection.set_authorizer(authorize)
try:
    setup = Path("setup.sql").read_text(encoding="utf-8")
    if setup.strip():
        connection.executescript(setup)

    query = Path("query.sql").read_text(encoding="utf-8")
    cursor = connection.execute(query)
    if cursor.description:
        columns = [item[0] for item in cursor.description]
        fetched = cursor.fetchmany(501)
        rows = fetched[:500]
        payload = {
            "columns": columns,
            "rows": rows,
            "rowCount": len(rows),
            "truncatedRows": len(fetched) > 500,
        }
    else:
        connection.commit()
        payload = {
            "columns": [],
            "rows": [],
            "rowCount": max(cursor.rowcount, 0),
            "message": f"{max(cursor.rowcount, 0)} row(s) affected",
        }
    print("${SQL_RESULT_PREFIX}" + json.dumps(payload, default=str))
except sqlite3.Error as error:
    print("${SQL_RESULT_PREFIX}" + json.dumps({"error": str(error)}))
    sys.exit(1)
`;

export function parseSqlResult(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith(SQL_RESULT_PREFIX));
  if (!line) throw new Error("SQLite runner returned no structured result.");
  return JSON.parse(line.slice(SQL_RESULT_PREFIX.length));
}

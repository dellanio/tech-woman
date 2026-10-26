"""Ferramenta OFFLINE: Backup API e arquivo tipado sem perda de inteiros/BLOBs.
A saída --read é privada; nunca enviar stdout a logs/artifacts públicos com dados reais.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def cell(value):
    if value is None:
        return {"type": "null", "value": None}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "real", "value": value.hex()}
    if isinstance(value, bytes):
        return {"type": "blob", "value": base64.b64encode(value).decode("ascii")}
    return {"type": "text", "value": value}


def connect(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def checks(connection):
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("Snapshot SQLite sem integridade")
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Snapshot SQLite contém FKs órfãs")


def backup(source, target):
    if Path(source).resolve() == Path(target).resolve():
        raise ValueError("Não sobrescrever origem")
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    with connect(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst, pages=256)
        checks(dst)


def read(path):
    tables = []
    with connect(path) as db:
        db.execute("BEGIN")
        checks(db)
        for name, ddl in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
            quoted = '"' + name.replace('"', '""') + '"'
            columns = [[cell(v) for v in row] for row in db.execute(f"PRAGMA table_xinfo({quoted})")]
            rows = [[cell(v) for v in row] for row in db.execute(f"SELECT * FROM {quoted}")]
            tables.append({"name": name, "ddl": ddl, "columns": columns, "rows": rows})
        db.rollback()
    content = {"format": 1, "integrity": "ok", "tables": tables}
    # Checksum lógico canônico não depende do layout físico/checkpoint de SQLite.
    content["checksum"] = hashlib.sha256(json.dumps(content, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    return content


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup", nargs=2)
    parser.add_argument("--read")
    args = parser.parse_args()
    if args.backup:
        backup(*args.backup)
    elif args.read:
        print(json.dumps(read(args.read), ensure_ascii=True))
    else:
        parser.error("Informe --backup ORIGEM DESTINO ou --read CÓPIA")

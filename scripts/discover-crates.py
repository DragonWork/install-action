#!/usr/bin/env python3
"""Build a CLI inventory from the official crates.io database dump."""

import argparse
import csv
import codecs
import json
import re
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

DUMP_URL = "https://static.crates.io/db-dump.tar.gz"
MIN_DOWNLOADS = 10_000
VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def version_key(value):
    return tuple(map(int, value.split("."))) if VERSION.fullmatch(value) else None


def binary_names(value):
    if value in (None, "", "\\N"):
        return None
    if value == "{}":
        return []
    if not value.startswith("{") or not value.endswith("}"):
        raise ValueError("Invalid binary-name array in crates.io dump")
    return next(csv.reader([value[1:-1]], escapechar="\\"))


def scan(stream):
    names, downloads, latest, binaries, yanked = {}, {}, {}, {}, {}
    required = {"crates.csv", "crate_downloads.csv", "versions.csv"}
    tables = set()
    csv.field_size_limit(16 * 1024 * 1024)
    with tarfile.open(fileobj=stream, mode="r|gz") as archive:
        for member in archive:
            table = Path(member.name).name
            if not member.isfile() or table not in required:
                continue
            print(f"Reading {table}", flush=True)
            tables.add(table)
            rows = csv.DictReader(codecs.getreader("utf-8")(archive.extractfile(member)))
            for row in rows:
                if table == "crates.csv":
                    names[row["id"]] = {"name": row["name"], "repository": row.get("repository")}
                    continue
                if table == "crate_downloads.csv":
                    downloads[row["crate_id"]] = int(row["downloads"])
                    continue
                key = version_key(row["num"])
                if key is None:
                    continue
                crate_id = row["crate_id"]
                if row["yanked"] in {"t", "true", "1"}:
                    yanked.setdefault(crate_id, []).append(row["num"])
                    continue
                bins = binary_names(row["bin_names"])
                if crate_id not in latest or key > latest[crate_id][0]:
                    latest[crate_id] = (key, bins)
                if not bins or (crate_id in binaries and key <= binaries[crate_id][0]):
                    continue
                binaries[crate_id] = (key, {
                    "version": row["num"],
                    "binaries": bins, "repository": row.get("repository") or None,
                })
            if tables == required:
                break
    if tables != required:
        raise ValueError("Database dump is missing required tables")
    crates = {}
    for crate_id, (_, details) in binaries.items():
        if crate_id in names and downloads.get(crate_id, 0) >= MIN_DOWNLOADS:
            details["repository"] = details["repository"] or names[crate_id]["repository"]
            details["downloads"] = downloads[crate_id]
            crates[names[crate_id]["name"]] = details
    unknown = sorted(names[crate_id]["name"] for crate_id, (_, bins) in latest.items()
                     if bins is None and crate_id in names and downloads.get(crate_id, 0) >= MIN_DOWNLOADS)
    yanked_versions = {names[crate_id]["name"]: sorted(versions, key=version_key)
                       for crate_id, versions in yanked.items()
                       if crate_id in names and downloads.get(crate_id, 0) >= MIN_DOWNLOADS}
    return {"crates": dict(sorted(crates.items())), "unknown": unknown,
            "yanked": dict(sorted(yanked_versions.items()))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="registry/catalog.json")
    args = parser.parse_args()
    destination = Path(args.output)
    previous = json.loads(destination.read_text()) if destination.exists() else {}
    headers = {"User-Agent": "DragonWork/install-action (https://github.com/DragonWork/install-action)"}
    if previous.get("etag") and previous.get("minimumDownloads") == MIN_DOWNLOADS and previous.get("schema") == 2:
        headers["If-None-Match"] = previous["etag"]
    request = urllib.request.Request(DUMP_URL, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            catalog = {"schema": 2, "minimumDownloads": MIN_DOWNLOADS, "source": DUMP_URL, "etag": response.headers.get("ETag"),
                       "modified": response.headers.get("Last-Modified"), **scan(response)}
    except urllib.error.HTTPError as error:
        if error.code != 304:
            raise
        catalog = previous
        print("The crates.io dump is unchanged.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    for entry in catalog["crates"].values():
        entry.pop("checksum", None)
    destination.write_text(json.dumps(catalog, sort_keys=True, separators=(",", ":")) + "\n")
    print(f"Discovered {len(catalog['crates'])} CLI crates; {len(catalog['unknown'])} await upstream binary metadata.")


if __name__ == "__main__":
    main()

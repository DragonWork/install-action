#!/usr/bin/env python3
"""Build a CLI inventory from the official crates.io database dump."""

import argparse
import csv
import codecs
import datetime
import hashlib
import json
import os
import re
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DUMP_URL = "https://static.crates.io/db-dump.tar.gz"
MIN_DOWNLOADS = 10_000
SCHEMA = 3
USER_AGENT = "DragonWork/install-action (https://github.com/DragonWork/install-action)"
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


def scan(stream, today=None):
    names, downloads, latest, binaries, yanked, activity = {}, {}, {}, {}, {}, {}
    cutoff = ((today or datetime.date.today()) - datetime.timedelta(days=365)).isoformat()
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
                if (row.get("created_at") or "")[:10] >= cutoff:
                    activity[crate_id] = activity.get(crate_id, 0) + 1
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
            details["recentVersions"] = min(activity.get(crate_id, 0), 12)
            crates[names[crate_id]["name"]] = details
    unknown = sorted(names[crate_id]["name"] for crate_id, (_, bins) in latest.items()
                     if bins is None and crate_id in names and downloads.get(crate_id, 0) >= MIN_DOWNLOADS)
    yanked_versions = {names[crate_id]["name"]: sorted(versions, key=version_key)
                       for crate_id, versions in yanked.items()
                       if crate_id in names and downloads.get(crate_id, 0) >= MIN_DOWNLOADS}
    return {"crates": dict(sorted(crates.items())), "unknown": unknown,
            "yanked": dict(sorted(yanked_versions.items()))}


def refresh_downloads(catalog, previous, opener=urllib.request.urlopen, pause=time.sleep, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if previous.get("popularityUpdatedAt"):
        age = now - datetime.datetime.fromisoformat(previous["popularityUpdatedAt"])
        if datetime.timedelta(0) <= age < datetime.timedelta(hours=12) and all(
                name in previous.get("crates", {}) and "recentDownloads" in previous["crates"][name]
                for name in catalog["crates"]):
            for name, entry in catalog["crates"].items():
                entry["recentDownloads"] = previous["crates"][name]["recentDownloads"]
            catalog["popularityUpdatedAt"] = previous["popularityUpdatedAt"]
            return
    names = sorted(catalog["crates"])
    for offset in range(0, len(names), 100):
        batch = names[offset:offset + 100]
        query = urllib.parse.urlencode([("per_page", "100")] + [("ids[]", name) for name in batch])
        request = urllib.request.Request("https://crates.io/api/v1/crates?" + query,
                                         headers={"User-Agent": USER_AGENT})
        with opener(request, timeout=60) as response:
            rows = json.load(response)["crates"]
        found = set()
        for row in rows:
            name, recent = row["id"], row.get("recent_downloads")
            if name not in batch or name in found or type(recent) is not int or recent < 0:
                raise ValueError("Invalid recent download statistics from crates.io")
            catalog["crates"][name]["recentDownloads"] = recent
            found.add(name)
        if found != set(batch):
            raise ValueError("Incomplete recent download statistics from crates.io")
        print(f"Updated download statistics for {offset + len(batch)} / {len(names)} crates.", flush=True)
        if offset + 100 < len(names):
            pause(1)
    catalog["popularityUpdatedAt"] = now.isoformat()


def inventory_key(etag):
    digest = hashlib.sha256(f"{etag}:{SCHEMA}:{MIN_DOWNLOADS}".encode()).hexdigest()
    return f"crates-inventory-{SCHEMA}-{digest}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="registry/catalog.json")
    parser.add_argument("--cache-info", action="store_true")
    args = parser.parse_args()
    destination = Path(args.output)
    previous = json.loads(destination.read_text()) if destination.exists() else {}
    headers = {"User-Agent": USER_AGENT}
    if args.cache_info:
        with urllib.request.urlopen(urllib.request.Request(DUMP_URL, method="HEAD", headers=headers), timeout=60) as response:
            etag = response.headers.get("ETag")
        if not etag:
            raise ValueError("The crates.io dump has no ETag")
        restore = previous.get("etag") != etag or previous.get("schema") != SCHEMA or previous.get("minimumDownloads") != MIN_DOWNLOADS
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"key={inventory_key(etag)}\nrestore={str(restore).lower()}\n")
        return
    if previous.get("etag") and previous.get("minimumDownloads") == MIN_DOWNLOADS and previous.get("schema") == SCHEMA:
        headers["If-None-Match"] = previous["etag"]
    request = urllib.request.Request(DUMP_URL, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            catalog = {"schema": SCHEMA, "minimumDownloads": MIN_DOWNLOADS, "source": DUMP_URL, "etag": response.headers.get("ETag"),
                       "modified": response.headers.get("Last-Modified"), **scan(response)}
    except urllib.error.HTTPError as error:
        if error.code != 304:
            raise
        catalog = previous
        print("The crates.io dump is unchanged.")
    refresh_downloads(catalog, previous)
    destination.parent.mkdir(parents=True, exist_ok=True)
    for entry in catalog["crates"].values():
        entry.pop("checksum", None)
    destination.write_text(json.dumps(catalog, sort_keys=True, separators=(",", ":")) + "\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"key={inventory_key(catalog['etag'])}\n")
    print(f"Discovered {len(catalog['crates'])} CLI crates; {len(catalog['unknown'])} await upstream binary metadata.")


if __name__ == "__main__":
    main()

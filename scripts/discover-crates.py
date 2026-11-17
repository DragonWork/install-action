#!/usr/bin/env python3
"""Build a CLI inventory from the official crates.io database dump."""

import argparse
import csv
import codecs
import datetime
import hashlib
import http.client
import json
import os
import re
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from email.utils import parsedate_to_datetime

DUMP_URL = "https://static.crates.io/db-dump.tar.gz"
MIN_DOWNLOADS = 10_000
SCHEMA = 3
USER_AGENT = "DragonWork/install-action (https://github.com/DragonWork/install-action)"
VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def warning(message):
    text = str(message).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::warning::{text}", flush=True)


def request_data(request, consume, opener=None, pause=time.sleep, timeout=60):
    opener = opener or urllib.request.urlopen
    for attempt in range(3):
        delay = 2 ** (attempt + 1)
        try:
            with opener(request, timeout=timeout) as response:
                return consume(response)
        except urllib.error.HTTPError as error:
            if error.code not in {408, 429, 500, 502, 503, 504} or attempt == 2:
                raise
            retry_after = error.headers.get("Retry-After") if error.headers else None
            if retry_after:
                try:
                    delay = max(delay, float(retry_after))
                except ValueError:
                    try:
                        delay = max(delay, (parsedate_to_datetime(retry_after)
                                            - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
                    except (TypeError, ValueError):
                        pass
            if delay > 60:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException,
                EOFError, tarfile.ReadError, json.JSONDecodeError):
            if attempt == 2:
                raise
        warning(f"Temporary crates.io request failure; retrying in {delay:g}s (attempt {attempt + 2}/3).")
        pause(delay)


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


def scan(stream, today=None, registered=()):
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

    def eligible(crate_id):
        return crate_id in names and (downloads.get(crate_id, 0) >= MIN_DOWNLOADS
                                      or names[crate_id]["name"] in registered)

    crates = {}
    for crate_id, (_, details) in binaries.items():
        if eligible(crate_id):
            details["repository"] = details["repository"] or names[crate_id]["repository"]
            details["downloads"] = downloads.get(crate_id, 0)
            details["recentVersions"] = min(activity.get(crate_id, 0), 12)
            crates[names[crate_id]["name"]] = details
    unknown = sorted(names[crate_id]["name"] for crate_id, (_, bins) in latest.items()
                     if bins is None and eligible(crate_id))
    yanked_versions = {names[crate_id]["name"]: sorted(versions, key=version_key)
                       for crate_id, versions in yanked.items()
                       if eligible(crate_id)}
    return {"crates": dict(sorted(crates.items())), "unknown": unknown,
            "yanked": dict(sorted(yanked_versions.items()))}


def refresh_registered_version(catalog, row, opener, pause):
    name = row["id"]
    entry = catalog["crates"].get(name, {})
    if "max_stable_version" not in row or (entry and row["max_stable_version"] == entry["version"]):
        return
    # The list endpoint has no binary targets. Read version details only for a changed or missing crate.
    request = urllib.request.Request("https://crates.io/api/v1/crates/" + urllib.parse.quote(name, safe=""),
                                     headers={"User-Agent": USER_AGENT})
    pause(1)
    data = request_data(request, json.load, opener, pause)
    if data["crate"]["id"] != name:
        raise ValueError("Unexpected crate in version response")
    versions = [v for v in data["versions"] if version_key(v["num"]) is not None]
    yanked = sorted((v["num"] for v in versions if v["yanked"]), key=version_key)
    if yanked:
        catalog["yanked"][name] = yanked
    else:
        catalog["yanked"].pop(name, None)
    latest = max((v for v in versions if not v["yanked"] and v.get("bin_names")),
                 key=lambda v: version_key(v["num"]), default=None)
    if latest:
        entry.update(version=latest["num"], binaries=latest["bin_names"], downloads=data["crate"]["downloads"],
                     repository=latest.get("repository") or data["crate"].get("repository"))
        catalog["crates"][name] = entry
    else:
        catalog["crates"].pop(name, None)


def refresh_downloads(catalog, previous, opener=None, pause=time.sleep, now=None, registered=frozenset()):
    now = now or datetime.datetime.now(datetime.timezone.utc)

    def fresh(entry):
        if type(entry.get("recentDownloads")) is not int or entry["recentDownloads"] < 0:
            return False
        try:
            age = now - datetime.datetime.fromisoformat(entry["recentDownloadsUpdatedAt"])
            return datetime.timedelta(0) <= age < datetime.timedelta(hours=12)
        except (KeyError, TypeError, ValueError):
            return False

    for name, entry in catalog["crates"].items():
        old = previous.get("crates", {}).get(name, {})
        if type(old.get("recentDownloads")) is int and old["recentDownloads"] >= 0:
            entry["recentDownloads"] = old["recentDownloads"]
            updated = old.get("recentDownloadsUpdatedAt", previous.get("popularityUpdatedAt"))
            if updated:
                entry["recentDownloadsUpdatedAt"] = updated
    stale = {name for name, entry in catalog["crates"].items() if not fresh(entry)}
    names = sorted(registered) + sorted(stale - registered)
    for offset in range(0, len(names), 100):
        batch = names[offset:offset + 100]
        query = urllib.parse.urlencode([("per_page", "100")] + [("ids[]", name) for name in batch])
        request = urllib.request.Request("https://crates.io/api/v1/crates?" + query,
                                         headers={"User-Agent": USER_AGENT})
        try:
            data = request_data(request, json.load, opener, pause)
            if not isinstance(data, dict) or not isinstance(data.get("crates"), list):
                raise ValueError("Invalid recent download statistics response")
            rows = data["crates"]
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException, ValueError) as error:
            warning(f"Download statistics refresh deferred; keeping cached counts for {len(names) - offset} crates: {error}")
            break
        found = {}
        for row in rows:
            name = row.get("id") if isinstance(row, dict) else None
            recent = row.get("recent_downloads") if isinstance(row, dict) else None
            if not isinstance(name, str) or name not in batch or name in found or type(recent) is not int or recent < 0:
                warning("Invalid recent download statistics from crates.io; keeping cached counts for this batch.")
                found = {}
                break
            found[name] = row
        for name, row in found.items():
            if name in registered:
                try:
                    refresh_registered_version(catalog, row, opener, pause)
                except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException,
                        KeyError, TypeError, ValueError) as error:
                    warning(f"Version lookup for {name} deferred: {error}")
            entry = catalog["crates"].get(name)
            if entry is not None and (not fresh(entry) or entry["recentDownloads"] != row["recent_downloads"]):
                entry.update(recentDownloads=row["recent_downloads"], recentDownloadsUpdatedAt=now.isoformat())
        missing = sorted(set(batch) - found.keys())
        if missing:
            warning(f"No current download statistics for {', '.join(missing)}; keeping previous counts where available.")
        print(f"Checked download statistics for {offset + len(batch)} / {len(names)} crates.", flush=True)
        if offset + 100 < len(names):
            pause(1)
    if all(fresh(entry) for entry in catalog["crates"].values()):
        catalog["popularityUpdatedAt"] = min((entry["recentDownloadsUpdatedAt"] for entry in catalog["crates"].values()),
                                              default=now.isoformat())
    else:
        catalog.pop("popularityUpdatedAt", None)


def save_catalog(destination, catalog):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix=".catalog-", suffix=".json", delete=False) as output:
            temporary = Path(output.name)
            json.dump(catalog, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


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
    reusable = previous.get("etag") and previous.get("schema") == SCHEMA and previous.get("minimumDownloads") == MIN_DOWNLOADS
    if args.cache_info:
        etag = request_data(urllib.request.Request(DUMP_URL, method="HEAD", headers=headers),
                            lambda response: response.headers.get("ETag"))
        if not etag:
            raise ValueError("The crates.io dump has no ETag")
        restore = not reusable or previous["etag"] != etag
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"key={inventory_key(etag)}\nrestore={str(restore).lower()}\n")
        return
    if reusable:
        headers["If-None-Match"] = previous["etag"]
    request = urllib.request.Request(DUMP_URL, headers=headers)
    tools = destination.parent / "tools"
    registered = {p.name for p in tools.iterdir() if p.is_dir()} if tools.is_dir() else set()
    try:
        catalog = request_data(request, lambda response: {
            "schema": SCHEMA, "minimumDownloads": MIN_DOWNLOADS, "source": DUMP_URL,
            "etag": response.headers.get("ETag"), "modified": response.headers.get("Last-Modified"),
            **scan(response, registered=registered),
        }, timeout=120)
    except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException, EOFError,
            tarfile.ReadError) as error:
        if not reusable:
            raise
        catalog = previous
        if getattr(error, "code", None) == 304:
            print("The crates.io dump is unchanged.")
        else:
            warning(f"Using the existing inventory while the dump is unavailable: {error}")
    refresh_downloads(catalog, previous, registered=registered)
    for entry in catalog["crates"].values():
        entry.pop("checksum", None)
    save_catalog(destination, catalog)
    if os.environ.get("GITHUB_OUTPUT") and catalog.get("etag"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"key={inventory_key(catalog['etag'])}\n")
    print(f"Discovered {len(catalog['crates'])} CLI crates; {len(catalog['unknown'])} await upstream binary metadata.")


if __name__ == "__main__":
    main()

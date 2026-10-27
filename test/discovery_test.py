import csv
import contextlib
import datetime
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("discovery", Path(__file__).parents[1] / "scripts/discover-crates.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))

    def test_complete_catalog_uses_binary_targets_and_keeps_unknown_metadata(self):
        files = {
            "crates.csv": [
                ["id", "name", "repository"],
                ["1", "cli", "https://github.com/example/cli"],
                ["2", "library", ""], ["3", "unknown", ""],
                ["4", "small-cli", ""],
                ["5", "yanked-cli", "https://github.com/example/yanked-cli"],
            ],
            "crate_downloads.csv": [
                ["crate_id", "downloads"],
                ["1", "10000"], ["2", "100000"], ["3", "10001"], ["4", "9999"],
                ["5", "10000"],
            ],
            "versions.csv": [
                ["crate_id", "num", "yanked", "bin_names", "tar_sha256", "repository", "created_at"],
                ["1", "1.0.0", "f", "{cli}", "\\x" + "a" * 64, "", "2020-01-01 00:00:00+00"],
                ["1", "2.0.0", "f", "{cli,helper}", "\\x" + "b" * 64, "", "2026-10-01 00:00:00+00"],
                ["1", "3.0.0", "t", "{cli}", "\\x" + "c" * 64, "", "2026-10-02 00:00:00+00"],
                ["2", "1.0.0", "f", "{}", "\\x" + "d" * 64, ""],
                ["3", "1.0.0", "f", "", "\\x" + "e" * 64, ""],
                ["4", "1.0.0", "f", "{small-cli}", "\\x" + "f" * 64, ""],
                ["4", "2.0.0", "t", "{small-cli}", "", ""],
                ["5", "1.0.0", "t", "{yanked-cli}", "", ""],
            ],
        }
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            for name, rows in files.items():
                text = io.StringIO()
                csv.writer(text).writerows(rows)
                content = text.getvalue().encode()
                info = tarfile.TarInfo("dump/data/" + name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        data.seek(0)
        result = discovery.scan(data, today=datetime.date(2026, 10, 24))
        self.assertEqual(list(result["crates"]), ["cli"])
        self.assertEqual(result["crates"]["cli"]["version"], "2.0.0")
        self.assertEqual(result["crates"]["cli"]["binaries"], ["cli", "helper"])
        self.assertEqual(result["crates"]["cli"]["downloads"], 10000)
        self.assertEqual(result["crates"]["cli"]["recentVersions"], 1)
        self.assertEqual(result["unknown"], ["unknown"])
        self.assertEqual(result["yanked"], {"cli": ["3.0.0"], "yanked-cli": ["1.0.0"]})

    def test_download_statistics_are_batched_complete_and_cached(self):
        now = datetime.datetime(2026, 10, 24, tzinfo=datetime.timezone.utc)
        catalog = {"crates": {f"cli-{n}": {"downloads": 10000} for n in range(101)}}
        requests, pauses = [], []

        def opener(request, timeout):
            self.assertEqual(timeout, 60)
            names = discovery.urllib.parse.parse_qs(discovery.urllib.parse.urlparse(request.full_url).query)["ids[]"]
            self.assertLessEqual(len(names), 100)
            requests.extend(names)
            return io.StringIO(discovery.json.dumps({"crates": [{"id": name, "recent_downloads": 123} for name in names]}))

        discovery.refresh_downloads(catalog, {}, opener, pauses.append, now)
        self.assertEqual(len(requests), 101)
        self.assertEqual(pauses, [1])
        self.assertTrue(all(row["recentDownloads"] == 123 for row in catalog["crates"].values()))
        cached = {"crates": {name: {} for name in catalog["crates"]}}
        discovery.refresh_downloads(cached, catalog, lambda *_: self.fail("Statistics should be cached"), now=now)
        self.assertEqual(cached["crates"]["cli-0"]["recentDownloads"], 123)

    def test_missing_crates_keep_old_counts_and_only_retry_stale_statistics(self):
        now = datetime.datetime(2026, 10, 27, tzinfo=datetime.timezone.utc)
        old_time = (now - datetime.timedelta(days=1)).isoformat()
        previous = {"popularityUpdatedAt": old_time, "crates": {
            "present": {"recentDownloads": 10}, "removed": {"recentDownloads": 20},
        }}
        catalog = {"crates": {name: {"version": "1.2.3", "downloads": 10000} for name in ["present", "removed", "new"]}}
        discovery.refresh_downloads(catalog, previous,
                                    lambda *_, **__: io.StringIO('{"crates":[{"id":"present","recent_downloads":30}]}'), now=now)
        self.assertEqual(catalog["crates"]["present"]["recentDownloads"], 30)
        self.assertEqual(catalog["crates"]["removed"]["recentDownloads"], 20)
        self.assertEqual(catalog["crates"]["removed"]["recentDownloadsUpdatedAt"], old_time)
        self.assertNotIn("recentDownloads", catalog["crates"]["new"])
        self.assertNotIn("popularityUpdatedAt", catalog)
        self.assertIn("No current download statistics for new, removed", self.output.getvalue())
        self.assertTrue(all(entry["version"] == "1.2.3" and entry["downloads"] == 10000 for entry in catalog["crates"].values()))
        requests = []

        def opener(request, **kwargs):
            names = discovery.urllib.parse.parse_qs(discovery.urllib.parse.urlparse(request.full_url).query)["ids[]"]
            requests.extend(names)
            return io.StringIO(json.dumps({"crates": [{"id": name, "recent_downloads": 40} for name in names]}))

        # The unchanged-dump path reuses the same object; refreshed entries must still stay cached.
        discovery.refresh_downloads(catalog, catalog, opener, now=now + datetime.timedelta(hours=1))
        self.assertEqual(requests, ["new", "removed"])
        self.assertEqual(catalog["crates"]["present"]["recentDownloads"], 30)
        self.assertEqual(catalog["crates"]["removed"]["recentDownloads"], 40)
        self.assertEqual(catalog["popularityUpdatedAt"], now.isoformat())

    def test_statistics_outage_retries_then_preserves_counts_without_hammering_remaining_batches(self):
        now = datetime.datetime(2026, 10, 27, tzinfo=datetime.timezone.utc)
        previous = {"popularityUpdatedAt": (now - datetime.timedelta(days=1)).isoformat(),
                    "crates": {f"cli-{n}": {"recentDownloads": 7} for n in range(101)}}
        catalog = {"crates": {name: {} for name in previous["crates"]}}
        calls, pauses = [], []

        def unavailable(request, **kwargs):
            calls.append(request.full_url)
            raise discovery.urllib.error.HTTPError(request.full_url, 503, "Unavailable", {}, None)

        discovery.refresh_downloads(catalog, previous, unavailable, pauses.append, now)
        self.assertEqual(len(calls), 3)
        self.assertEqual(pauses, [2, 4])
        self.assertTrue(all(entry["recentDownloads"] == 7 for entry in catalog["crates"].values()))
        self.assertNotIn("popularityUpdatedAt", catalog)

    def test_invalid_statistics_never_replace_cached_counts(self):
        now = datetime.datetime(2026, 10, 27, tzinfo=datetime.timezone.utc)
        previous = {"crates": {"cli": {"recentDownloads": 7}}}
        responses = [
            {"crates": [{"id": "cli", "recent_downloads": -1}]},
            {"crates": [{"id": "cli", "recent_downloads": True}]},
            {"crates": [{"id": "cli", "recent_downloads": 1}, {"id": "cli", "recent_downloads": 2}]},
            {"crates": [{"id": "other", "recent_downloads": 9}]},
            {"crates": [None]}, {"crates": {}}, {},
        ]
        for response in responses:
            with self.subTest(response=response):
                catalog = {"crates": {"cli": {}}}
                discovery.refresh_downloads(catalog, previous, lambda *_, **__: io.StringIO(json.dumps(response)), now=now)
                self.assertEqual(catalog["crates"]["cli"], {"recentDownloads": 7})
                self.assertNotIn("popularityUpdatedAt", catalog)

    def test_requests_retry_transient_reads_and_respect_rate_limits(self):
        request = discovery.urllib.request.Request("https://crates.io/api/v1/crates")
        errors = [TimeoutError("timed out"), discovery.http.client.IncompleteRead(b"partial"),
                  discovery.urllib.error.HTTPError(request.full_url, 429, "Limited", {"Retry-After": "3"}, None)]
        for error in errors:
            with self.subTest(error=error):
                calls, pauses = [], []

                def opener(*args, **kwargs):
                    calls.append(1)
                    if len(calls) == 1:
                        raise error
                    return io.StringIO('{"crates":[]}')

                self.assertEqual(discovery.request_data(request, json.load, opener, pauses.append), {"crates": []})
                self.assertEqual(len(calls), 2)
                self.assertEqual(pauses, [3 if isinstance(error, discovery.urllib.error.HTTPError) else 2])
        for code, headers in [(404, {}), (429, {"Retry-After": "600"})]:
            with self.subTest(code=code):
                def opener(*args, **kwargs):
                    raise discovery.urllib.error.HTTPError(request.full_url, code, "Deferred", headers, None)

                with self.assertRaises(discovery.urllib.error.HTTPError):
                    discovery.request_data(request, json.load, opener, lambda *_: self.fail("Must not retry yet"))

    def test_bad_json_is_retried_but_invalid_inventory_is_not_accepted(self):
        request = discovery.urllib.request.Request(discovery.DUMP_URL)
        calls = []

        def opener(*args, **kwargs):
            calls.append(1)
            return io.StringIO('{"crates":' if len(calls) == 1 else '{"crates":[]}')

        self.assertEqual(discovery.request_data(request, json.load, opener, lambda *_: None), {"crates": []})
        self.assertEqual(len(calls), 2)
        with self.assertRaisesRegex(ValueError, "missing required tables"):
            empty = io.BytesIO()
            with tarfile.open(fileobj=empty, mode="w:gz"):
                pass
            discovery.request_data(request, discovery.scan, lambda *_, **__: io.BytesIO(empty.getvalue()),
                                   lambda *_: self.fail("Malformed inventory must remain an error"))

    def test_interrupted_catalog_save_preserves_previous_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="install-action-discovery-test-") as directory:
            destination = Path(directory) / "catalog.json"
            discovery.save_catalog(destination, {"crates": {"cli": {"version": "1.0.0"}}})
            original = destination.read_bytes()
            with patch.object(discovery.os, "replace", side_effect=OSError("write interrupted")):
                with self.assertRaisesRegex(OSError, "write interrupted"):
                    discovery.save_catalog(destination, {"crates": {"cli": {"version": "2.0.0"}}})
            self.assertEqual(destination.read_bytes(), original)
            self.assertEqual(list(Path(directory).iterdir()), [destination])
            discovery.save_catalog(destination, {"crates": {"cli": {"version": "2.0.0"}}})
            self.assertEqual(json.loads(destination.read_text())["crates"]["cli"]["version"], "2.0.0")


if __name__ == "__main__":
    unittest.main()

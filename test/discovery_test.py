import csv
import datetime
import importlib.util
import io
import tarfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("discovery", Path(__file__).parents[1] / "scripts/discover-crates.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class DiscoveryTests(unittest.TestCase):
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
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            discovery.refresh_downloads({"crates": {"missing": {}}}, {}, lambda *_, **__: io.StringIO('{"crates":[]}'), now=now)


if __name__ == "__main__":
    unittest.main()

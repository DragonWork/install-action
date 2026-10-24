import csv
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
                ["crate_id", "num", "yanked", "bin_names", "tar_sha256", "repository"],
                ["1", "1.0.0", "f", "{cli}", "\\x" + "a" * 64, ""],
                ["1", "2.0.0", "f", "{cli,helper}", "\\x" + "b" * 64, ""],
                ["1", "3.0.0", "t", "{cli}", "\\x" + "c" * 64, ""],
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
        result = discovery.scan(data)
        self.assertEqual(list(result["crates"]), ["cli"])
        self.assertEqual(result["crates"]["cli"]["version"], "2.0.0")
        self.assertEqual(result["crates"]["cli"]["binaries"], ["cli", "helper"])
        self.assertEqual(result["crates"]["cli"]["downloads"], 10000)
        self.assertEqual(result["unknown"], ["unknown"])
        self.assertEqual(result["yanked"], {"cli": ["3.0.0"], "yanked-cli": ["1.0.0"]})


if __name__ == "__main__":
    unittest.main()

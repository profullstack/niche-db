#!/usr/bin/env python3
"""Find certified police publishers in Nixle's public city directories.

Run after discover-police-sources.py. Shares its robots checks and per-host
throttle; never guesses account handles. Resumes from the recorded results.
County and station publishers remain candidates until their jurisdiction is
reviewed. A city directory also lists nearby agencies: do not assign those to
the city merely because they appear in the directory.
"""
import concurrent.futures
import html
import importlib.util
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/data/police-sources"
spec = importlib.util.spec_from_file_location("discovery", ROOT / "scripts/discover-police-sources.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


def city_publisher(label, city):
    label = re.sub(r"^(?:SBSD\s*-\s*|LASD\s*-\s*|City of\s+)", "", label, flags=re.I)
    # Chino Hills is not Chino, and Madera County is not Madera city.
    return bool(re.match(re.escape(city) + r"(?:,\s*CA)?\s+(?:Police\b|Department of Public Safety\b|Sheriff\b|Station\b)", label, re.I))


def publishers(body, city):
    found = {}
    for path, label in re.findall(r'<h2 class="certified">\s*<a href="(/[a-z0-9-]+/?)">(.*?)</a>', body, re.S):
        label = html.unescape(re.sub(r"<[^>]+>", "", label)).strip()
        if not city_publisher(label, city):
            continue
        found[path.rstrip("/")] = label
    return found


def survey(city):
    name = "Ventura" if city["name"] == "San Buenaventura (Ventura)" else city["name"]
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    url = f'https://local.nixle.com/city/{city["state"].lower()}/{slug}/'
    result = {"id": city["id"], "directory": url, "checked_at": datetime.now(timezone.utc).isoformat(), "channels": []}
    try:
        final, body = discovery.public_get(url)
        if "Nixle</title>" not in body:
            raise ValueError("not a public city directory")
        result["channels"] = [{
            "kind": "nixle", "url": "https://local.nixle.com" + path + "/", "title": label,
            "evidence_url": final, "verification": "certified-publisher-in-city-directory; jurisdiction-review-required",
            "access": "not-tested",
        } for path, label in publishers(body, name).items()]
    except Exception as error:
        result["error"] = str(error)[:200]
    return result


def main():
    rows = json.loads((OUT / "inventory.json").read_text())["places"]
    path = OUT / "nixle-directories.json"
    results = {r["id"]: r for r in json.loads(path.read_text())} if path.exists() else {}
    todo = [r for r in rows if r["id"] not in results]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        for i, result in enumerate(executor.map(survey, todo), 1):
            results[result["id"]] = result
            path.write_text(json.dumps(list(results.values()), indent=2) + "\n")
            if i % 20 == 0:
                print(f'{i}/{len(todo)} directories; {sum(len(r["channels"]) for r in results.values())} publisher candidates', flush=True)
    print(f'{len(results)} directories; {sum(len(r["channels"]) for r in results.values())} publisher candidates', flush=True)


if __name__ == "__main__":
    main()

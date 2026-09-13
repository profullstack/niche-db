#!/usr/bin/env python3
"""Build the small runtime directory from research and explicitly reviewed feeds.

Discovery candidates never enable ingestion. Add a publisher to
docs/data/police-ingestion-ca.json only after checking identity, city jurisdiction,
public access and freshness, then run this script and the adapter smoke check.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    inventory = json.loads((ROOT / "docs/data/police-sources/inventory.json").read_text())
    reviewed = json.loads((ROOT / "docs/data/police-ingestion-ca.json").read_text())
    if inventory["state"] != "CA" or inventory["population_min_exclusive"] != 50000:
        raise ValueError("Runtime CA catalogue requires the CA inventory with the 50,000 cutoff")
    cities = []
    owners = {source["url"].rstrip("/"): name for name, source in reviewed.items()}
    for row in inventory["places"]:
        ingestion = reviewed.get(row["name"])
        references = {}
        if ingestion:
            references[ingestion["url"]] = {"url": ingestion["url"], "kind": ingestion["format"], "reviewed": True, "evidenceUrl": ingestion["evidenceUrl"]}
        priority = {"x": 0, "incident-log": 1, "newsroom": 2, "nixle": 3, "department-page": 4, "facebook": 5, "instagram": 6, "nextdoor": 7, "crime-map": 8, "social-directory": 9}
        candidates = sorted(row["channels"], key=lambda c: (
            not c.get("verification", "").startswith("reviewed"),
            priority.get(c["kind"], 99),
            not bool(re.search(r"police|sheriff|\bpd\b|public.safety", c["url"], re.I)),
            len(c["url"]),
        ))
        for channel in candidates:
            # This is the city's headquarters planning site, not its police newsroom.
            if channel["kind"] not in priority or "newportbeachpolicehq.com" in channel["url"]:
                continue
            owner = owners.get(channel["url"].rstrip("/"))
            if owner and owner != row["name"]:
                continue
            if len(references) >= 6:
                break
            references.setdefault(channel["url"], {
                "kind": channel["kind"], "url": channel["url"],
                "reviewed": channel.get("verification", "").startswith("reviewed"),
                "evidenceUrl": channel["evidence_url"],
            })
        cities.append({
            "geoid": row["geoid"], "name": row["name"], "state": row["state"],
            "slug": re.sub(r"[^a-z0-9]+", "-", row["name"].lower()).strip("-"),
            "population": row["population"], "lat": row["lat"], "lon": row["lon"],
            "ingestion": ingestion, "references": list(references.values()),
        })
    if set(reviewed) - {c["name"] for c in cities}:
        raise ValueError("Reviewed feed belongs to a city outside this inventory")
    payload = {
        "state": "CA", "populationYear": inventory["population_year"],
        "minimumPopulation": 50000, "populationSource": inventory["population_source"],
        "cities": cities,
    }
    (ROOT / "packages/adapters/src/police-sources-ca.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f'{len(cities)} cities; {len(reviewed)} reviewed feeds')


if __name__ == "__main__":
    main()

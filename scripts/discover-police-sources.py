#!/usr/bin/env python3
"""Inventory police reporting channels by state, starting with CA over 50,000.

Uses Census Vintage 2025 and the official .gov registry. Public links only;
does not sign in to social networks, infer handles, or call paid services.
Run: python3 scripts/discover-police-sources.py [--state CA] [--min-population 50000]
Outputs a resumable JSON inventory and flat CSV, including unresolved places.
"""

import argparse
import concurrent.futures
import csv
import hashlib
import io
import json
import math
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/data/police-sources"
CENSUS = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025.csv"
GOV = "https://raw.githubusercontent.com/cisagov/dotgov-data/main/current-full.csv"
WIKIDATA = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": "SELECT ?item ?fips ?website WHERE { ?item wdt:P774 ?fips; wdt:P856 ?website. }", "format": "json"})
GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_{}_national.zip"
UA = "NicheDBPoliceSources/1.0 (+https://nichedb.dev)"
POLICE = re.compile(r"police|sheriff|public[-_ /]?safety|\bdps\b|\bpd\b", re.I)
REPORT = re.compile(r"news|press|media|blotter|bulletin|crime|incident|activity|alert|social|connect|transparency", re.I)
EXCLUDE = re.compile(r"recruit|career|apply|employment|report-a|reporting-a|file-a|records-request|sex-offender|most-wanted", re.I)
SOCIAL = {"x.com": "x", "twitter.com": "x", "facebook.com": "facebook", "instagram.com": "instagram", "nextdoor.com": "nextdoor", "youtube.com": "youtube"}
LOCKS = {}
LOCKS_GUARD = threading.Lock()
ROBOTS = {}


def norm(value):
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", value)


def city_name(name):
    return re.sub(r" (?:city|town|village|borough|municipality|township)(?: municipality)?$", "", name)


def canonical(url):
    parsed = urllib.parse.urlparse(url.strip())
    host = (parsed.hostname or "").lower().removeprefix("www.")
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) if not k.lower().startswith(("utm_", "oc_lang", "ref_src", "lang_update"))]
    if host in ("twitter.com", "x.com"):
        return "https://x.com/" + parsed.path.strip("/").lower()
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query), fragment=""))


def download(url, cache):
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / hashlib.sha256(url.encode()).hexdigest()
    if path.exists():
        return path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as response:
        data = response.read()
    path.write_bytes(data)
    return data


def municipalities(population_csv, gazetteers, minimum_population=50000):
    """Whole legal places and functioning towns, never county/place-part rows.

    Places and MCDs can overlap legally; retain their separate Census IDs.
    Inactive/statistical MCDs and CDPs are excluded from this municipal scope.
    """
    gaz = {}
    for data in gazetteers:
        for row in csv.DictReader(io.StringIO(data), delimiter="|"):
            gaz[row["GEOID"]] = row
    rows = []
    for row in csv.DictReader(io.StringIO(population_csv)):
        if row["SUMLEV"] not in ("162", "061", "170") or row["FUNCSTAT"] not in ("A", "B", "C"):
            continue
        population = int(row["POPESTIMATE2025"])
        if population <= minimum_population:
            continue
        geoid = row["STATE"] + (row["COUNTY"] + row["COUSUB"] if row["SUMLEV"] == "061" else row["CONCIT"] if row["SUMLEV"] == "170" else row["PLACE"])
        point = gaz.get(geoid, {})
        rows.append({
            "id": f'{row["SUMLEV"]}:{geoid}', "geoid": geoid,
            "name": city_name(row["NAME"]), "census_name": row["NAME"],
            "state": point.get("USPS", ""), "state_name": row["STNAME"],
            "state_fips": row["STATE"], "county_fips": row["COUNTY"],
            "geography": {"162": "incorporated-place", "061": "minor-civil-division", "170": "consolidated-city"}[row["SUMLEV"]],
            "population": population, "population_year": 2025,
            "lat": float(point["INTPTLAT"]) if point else None,
            "lon": float(point["INTPTLONG"]) if point else None,
        })
    states = {r["state_name"]: r["state"] for r in rows if r["state"]}
    for row in rows:
        row["state"] = row["state"] or states.get(row["state_name"], "")
    return sorted(rows, key=lambda r: (r["state"], -r["population"], r["id"]))


def government_domains(place, domains):
    matches = []
    for row in domains:
        if row["Domain type"] != "City" or row["State"] != place["state"] or norm(row["City"]) != norm(place["name"]):
            continue
        org = row["Organization name"] + " " + row["Suborganization name"]
        if re.search(r"court|school|library|housing|utility|utilities|water district|transit|hospital", org, re.I):
            continue
        if norm(place["name"]) not in norm(org):
            continue
        matches.append({"url": "https://" + row["Domain name"] + "/", "organization": org.strip(), "evidence": GOV})
    return sorted(matches, key=lambda r: (not bool(POLICE.search(r["organization"])), len(r["url"])))[:3]


class Links(HTMLParser):
    def __init__(self, html, base):
        super().__init__(convert_charrefs=True)
        self.base, self.links, self.anchor = base, [], None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag not in ("a", "link") or not attrs.get("href"):
            return
        url = urllib.parse.urljoin(self.base, attrs["href"])
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            return
        url = canonical(url)
        entry = {"url": url, "text": attrs.get("title", "") + " " + attrs.get("aria-label", ""), "type": attrs.get("type", "")}
        self.links.append(entry)
        if tag == "a":
            self.anchor = entry

    def handle_endtag(self, tag):
        if tag == "a":
            self.anchor = None

    def handle_data(self, data):
        if self.anchor is not None:
            self.anchor["text"] += " " + data.strip()


def channel(link, police_page=False):
    url = urllib.parse.urlparse(link["url"])
    host = url.hostname.lower().removeprefix("www.").removeprefix("m.")
    text = link["text"] + " " + urllib.parse.unquote(url.path)
    if host in SOCIAL:
        # Sharing buttons, intent URLs and city-wide footer accounts are not
        # department accounts. Never manufacture /<city>Police handles.
        if re.search(r"/(?:share|sharer|intent|search|login|hashtag|watch)(?:[/.?]|$)", url.path) or len(url.path.strip("/")) < 2:
            return None
        handle = url.path.strip("/").split("/")[0]
        if not (POLICE.search(text) or re.search(r"(?:pd|dps)$", handle, re.I)):
            return None
        if SOCIAL[host] == "x" and "/status/" in url.path:
            return None
        return SOCIAL[host]
    if host.endswith("citizenrims.com"):
        return "incident-log"
    if host == "local.nixle.com" and re.fullmatch(r"/[a-z0-9-]+/?", url.path) and url.path.strip("/") not in ("accounts", "zipcode", "register"):
        return "nixle"
    if host in ("communitycrimemap.com", "www.crimemapping.com", "crimemapping.com"):
        return "crime-map"
    if police_page and re.search(r"/rss\.aspx$", url.path, re.I):
        return "feed-directory"
    if police_page and ("rss" in link["type"] or "atom" in link["type"] or re.search(r"/feed/?$|rssfeed\.aspx|rss\.xml|\.rss$", link["url"], re.I)):
        return "feed-candidate"
    if police_page and re.search(r"blotter|bulletin|crime[-_ /]?(?:log|report)|daily[-_ /]?(?:log|activity)", text, re.I):
        return "incident-log"
    if police_page and len(link["text"].strip()) < 100 and re.search(r"press[-_ /]?releases|newsroom|media[-_ /]?(?:releases|center)|news[-_ /]?(?:releases|center)", link["text"], re.I) and not re.search(r"\.(?:pdf|docx?)$|/DocumentCenter/|/News-Articles/|/Components/News/News/", url.path, re.I):
        return "newsroom"
    if police_page and re.search(r"alert|notify|notification", text, re.I) and not EXCLUDE.search(text):
        return "alerts"
    return None


def public_get(url):
    host = urllib.parse.urlparse(url).netloc
    with LOCKS_GUARD:
        lock = LOCKS.setdefault(host, threading.Lock())
    with lock:
        if host not in ROBOTS:
            robots_url = urllib.parse.urljoin(url, "/robots.txt")
            rp = urllib.robotparser.RobotFileParser(robots_url)
            try:
                with urllib.request.urlopen(urllib.request.Request(robots_url, headers={"User-Agent": UA}), timeout=8) as res:
                    rp.parse(res.read(256000).decode("utf-8", "replace").splitlines())
            except urllib.error.HTTPError as error:
                if error.code in (401, 403, 429) or error.code >= 500:
                    raise RuntimeError(f"robots unavailable: HTTP {error.code}") from error
                rp.parse([])
            except Exception as error:
                raise RuntimeError("robots unavailable") from error
            ROBOTS[host] = rp
        if not ROBOTS[host].can_fetch(UA, url):
            raise RuntimeError("robots disallows discovery")
        delay = max(0.5, ROBOTS[host].crawl_delay(UA) or 0.5)
        if delay > 10:
            raise RuntimeError("crawl delay exceeds discovery budget")
        time.sleep(delay)
        request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/rss+xml,*/*"})
        with urllib.request.urlopen(request, timeout=10) as res:
            content = res.read(2_000_000).decode(res.headers.get_content_charset() or "utf-8", "replace")
            if re.search(r"<title>[^<]*(?:just a moment|access denied|attention required|request rejected)", content, re.I):
                raise RuntimeError("access challenge")
            return res.url, content


def survey(place, domains, overrides, websites):
    result = {**place, "checked_at": datetime.now(timezone.utc).isoformat(), "domains": government_domains(place, domains), "channels": [], "errors": [], "pages_checked": 0}
    manual = overrides.get(place["state"] + ":" + place["name"], {})
    queue = [(u, 0, True, "curated department URL") for u in manual.get("department_urls", [])]
    queue += [(r["url"], 0, bool(POLICE.search(r["organization"] + r["url"])), r["evidence"]) for r in result["domains"]]
    # Wikidata supplies discovery leads for .org/.com municipal websites. Keep
    # its item as provenance; a lead is not a human-verified department source.
    for candidate in websites.get(place["state_fips"] + place["geoid"][-5:], []):
        if candidate["url"] not in [q[0] for q in queue]:
            queue.append((candidate["url"], 0, False, candidate["evidence_url"]))
    result["website_candidates"] = websites.get(place["state_fips"] + place["geoid"][-5:], [])
    result["channels"].extend(manual.get("channels", []))
    visited, found = set(), {c["url"] for c in result["channels"]}
    while queue and result["pages_checked"] < 7:
        url, depth, police_page, evidence = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        result["pages_checked"] += 1
        try:
            final_url, html = public_get(url)
            if police_page and final_url not in found:
                result["channels"].append({"kind": "department-page", "url": canonical(final_url), "evidence_url": evidence, "verification": "discovered-department-page; review-jurisdiction", "access": "public-html"})
                found.add(final_url)
            links = Links(html, final_url).links
            follow = []
            for link in links:
                kind = channel(link, police_page)
                if kind and link["url"] not in found:
                    result["channels"].append({"kind": kind, "url": link["url"], "evidence_url": final_url, "link_text": link["text"].strip()[:300], "verification": "linked-from-municipal-or-department-page; review-scope", "access": "not-tested"})
                    found.add(link["url"])
                text = link["text"] + " " + urllib.parse.unquote(link["url"])
                parsed = urllib.parse.urlparse(link["url"])
                if depth >= 2 or kind in (*SOCIAL.values(), "crime-map", "incident-log", "nixle", "feed-candidate") or EXCLUDE.search(text) or re.search(r"\.(?:pdf|docx?|xlsx?|png|jpg|zip)$", parsed.path, re.I):
                    continue
                same_site = parsed.hostname.removeprefix("www.") == urllib.parse.urlparse(final_url).hostname.removeprefix("www.")
                if kind == "feed-directory":
                    follow.append((link["url"], depth + 1, True, final_url))
                elif POLICE.search(text) and (same_site or POLICE.search(parsed.hostname)):
                    follow.append((link["url"], depth + 1, True, final_url))
                elif police_page and same_site and REPORT.search(text):
                    follow.append((link["url"], depth + 1, True, final_url))
            follow.sort(key=lambda q: (not bool(REPORT.search(q[0])) if police_page else False, len(q[0])))
            queue = follow[:3] + queue
        except Exception as error:
            result["errors"].append({"url": url, "error": str(error)[:180]})
    useful = [c for c in result["channels"] if c["kind"] not in ("department-page", "feed-directory")]
    result["status"] = "channels-found" if useful else "department-found" if result["channels"] else "unresolved"
    return result


def distance_km(lat, lon, origin=(37.243507, -121.942648)):
    if lat is None or lon is None:
        return None
    a, b = map(math.radians, origin)
    c, d = math.radians(lat), math.radians(lon)
    return 6371.0088 * 2 * math.asin(min(1, math.sqrt(math.sin((c-a)/2)**2 + math.cos(a)*math.cos(c)*math.sin((d-b)/2)**2)))


def export(rows, output, minimum_population=50000, state="CA"):
    output.mkdir(parents=True, exist_ok=True)
    ordered = sorted(rows, key=lambda r: (r["state"], r["name"], r["id"]))
    for row in ordered:
        distance = distance_km(row["lat"], row["lon"])
        row["distance_from_link_km"] = round(distance, 2) if distance is not None else None
    payload = {"population_source": CENSUS, "domain_source": GOV, "population_min_exclusive": minimum_population, "population_year": 2025, "state": state, "scope": "Active incorporated places, minor civil divisions and consolidated cities; overlapping governments retained; CDPs excluded", "generated_at": datetime.now(timezone.utc).isoformat(), "places": ordered}
    (output / "inventory.json").write_text(json.dumps(payload, indent=2) + "\n")
    with (output / "channels.csv").open("w", newline="") as f:
        fields = ["id", "name", "state", "population", "population_year", "geography", "status", "distance_from_link_km", "kind", "url", "evidence_url", "verification", "access"]
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for row in ordered:
            for item in row["channels"] or [{}]:
                writer.writerow({**row, **item})
    counts = {key: sum(r["status"] == key for r in ordered) for key in ("channels-found", "department-found", "unresolved", "pending")}
    counts.update(places=len(ordered), channels=sum(len(r["channels"]) for r in ordered))
    (output / "summary.json").write_text(json.dumps(counts, indent=2) + "\n")
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", default="CA", help="Two-letter state, or all; default CA")
    parser.add_argument("--min-population", type=int, default=50000)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--retry-unresolved", action="store_true")
    parser.add_argument("--output", type=Path, default=OUT)
    parser.add_argument("--cache", type=Path, default=Path("/tmp/nichedb-police-source-cache"))
    args = parser.parse_args()
    census = download(CENSUS, args.cache).decode("cp1252")
    gazetteers = []
    for kind in ("place", "cousubs"):
        z = zipfile.ZipFile(io.BytesIO(download(GAZ.format(kind), args.cache)))
        gazetteers.append(z.read(z.namelist()[0]).decode("utf-8-sig"))
    places = municipalities(census, gazetteers, args.min_population)
    if args.state.lower() != "all":
        places = [r for r in places if r["state"] == args.state.upper()]
    domains = list(csv.DictReader(io.StringIO(download(GOV, args.cache).decode("utf-8-sig"))))
    websites = {}
    for row in json.loads(download(WIKIDATA, args.cache))["results"]["bindings"]:
        geoid = re.sub(r"\D", "", row["fips"]["value"])
        url = row["website"]["value"]
        if len(geoid) == 7 and urllib.parse.urlparse(url).scheme in ("http", "https"):
            websites.setdefault(geoid, []).append({"url": url, "evidence_url": row["item"]["value"].replace("http:", "https:")})
    overrides_path = ROOT / "docs/data/police-source-overrides.json"
    overrides = json.loads(overrides_path.read_text()) if overrides_path.exists() else {}
    previous_path = args.output / "inventory.json"
    previous = {r["id"]: r for r in json.loads(previous_path.read_text())["places"]} if previous_path.exists() and not args.refresh else {}
    results = {r["id"]: previous.get(r["id"], {**r, "status": "pending", "channels": [], "errors": []}) for r in places}
    todo = [r for r in places if r["id"] not in previous or previous[r["id"]]["status"] == "pending" or (args.retry_unresolved and previous[r["id"]]["status"] == "unresolved")]
    todo.sort(key=lambda r: (distance_km(r["lat"], r["lon"]) or 99999, -r["population"]))
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(places)} eligible governments; surveying {len(todo)}", flush=True)
    export(list(results.values()), args.output, args.min_population, args.state.upper())
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(survey, place, domains, overrides, websites): place for place in todo}
        for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
            place = futures[future]
            try:
                result = future.result()
            except Exception as error:
                result = {**results[place["id"]], "status": "unresolved", "errors": [{"error": str(error)}]}
            results[place["id"]] = result
            if i % 25 == 0 or i == len(todo):
                print(f"{i}/{len(todo)} {export(list(results.values()), args.output, args.min_population, args.state.upper())}", flush=True)


if __name__ == "__main__":
    main()

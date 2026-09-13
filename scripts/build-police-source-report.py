#!/usr/bin/env python3
"""Merge reviewed/indexed sources, audit public feeds, and render the inventory.

Run after discover-police-sources.py. --validate checks Nixle and police RSS
endpoints and records item counts and dates; it never turns an account link
into a claim that a live feed is available. Indexed search findings are data
in docs/data/police-sources/indexed-searches.json, with their original queries.
"""
import argparse
import concurrent.futures
import importlib.util
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/data/police-sources"
spec = importlib.util.spec_from_file_location("discovery", ROOT / "scripts/discover-police-sources.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


def clean_channels(channels):
    found = {}
    for original in channels:
        row = dict(original)
        row["url"] = discovery.canonical(row["url"])
        parsed = urllib.parse.urlparse(row["url"])
        host = (parsed.hostname or "").removeprefix("www.")
        if row["kind"] == "nixle" and not (host == "local.nixle.com" and re.fullmatch(r"/[a-z0-9-]+/?", parsed.path) and parsed.path.strip("/") not in ("register", "accounts", "zipcode")):
            row["kind"] = "announcement" if re.search(r"/alert/\d+", parsed.path) else "alert-directory"
        if row["kind"] == "x":
            handle = parsed.path.strip("/").split("/")[0]
            if handle in ("intent", "share", "search", "hashtag", "home", "login"):
                continue
            row["url"] = "https://x.com/" + handle
        if row["kind"] == "feed-candidate":
            context = row["url"] + " " + row.get("link_text", "") + " " + (urllib.parse.urlparse(row.get("evidence_url", "")).hostname or "")
            if not discovery.POLICE.search(context):
                continue
        if row["kind"] == "newsroom":
            if re.search(r"/News-Articles/|/Components/News/News/|/DocumentCenter/|\.(?:pdf|docx?)$", parsed.path, re.I):
                row["kind"] = "announcement"
        if row["kind"] == "feed-candidate" and "ModID=58" in row["url"]:
            row["kind"] = "calendar-feed"
        if row["kind"] == "feed-candidate" and re.search(r"/rss\.aspx$", parsed.path, re.I):
            row["kind"] = "feed-directory"
        # Many sites link to the same source once per translation/language.
        key = row["url"].lower().replace("http://", "https://").replace("https://www.", "https://").rstrip("/")
        if key not in found or row.get("verification", "").startswith(("reviewed", "official-department")):
            found[key] = row
    return list(found.values())


def validate_channel(row):
    audit = {"url": row["url"], "checked_at": datetime.now(timezone.utc).isoformat()}
    try:
        url, body = discovery.public_get(row["url"])
        audit["final_url"] = url
        if row["kind"] == "nixle":
            publisher = re.search(r'<title>Messages from (.*?)\s*:\s*Nixle</title>', body, re.I | re.S)
            if not publisher or 'id="wire"' not in body:
                raise ValueError("not a public Nixle agency archive")
            audit["publisher"] = publisher[1]
            audit["item_count"] = len(re.findall(r'<li\s+id="pub_\d+"', body))
            newest = re.search(r'<h2 class="time">(.*?)</h2>', body, re.S)
            audit["newest_label"] = re.sub(r"<[^>]*>", "", newest[1]).strip() if newest else None
            audit["access"] = "public-nixle-archive" if audit["item_count"] else "empty-public-nixle-archive"
            audit["ingestion"] = "HTML adapter required; publication dates are on individual alerts"
        else:
            xml = ET.fromstring(body)
            if xml.tag not in ("rss", "{http://www.w3.org/2005/Atom}feed", "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}RDF"):
                raise ValueError("not RSS/Atom")
            items = xml.findall(".//item") or xml.findall("{http://www.w3.org/2005/Atom}entry")
            audit["publisher"] = xml.findtext("channel/title") or xml.findtext("{http://www.w3.org/2005/Atom}title")
            audit["item_count"] = len(items)
            dates = []
            for item in items:
                raw = item.findtext("pubDate") or item.findtext("{http://www.w3.org/2005/Atom}published") or item.findtext("{http://www.w3.org/2005/Atom}updated")
                if raw:
                    try:
                        dates.append(parsedate_to_datetime(raw).isoformat())
                    except (ValueError, TypeError):
                        dates.append(raw)
            audit["newest_label"] = max(dates) if dates else None
            audit["access"] = "public-feed-with-items" if items else "empty-public-feed"
            audit["ingestion"] = "RSS/Atom parser; confirm police scope and classify announcements separately"
    except Exception as error:
        audit["access"] = "unavailable-to-validator"
        audit["error"] = str(error)[:200]
    return audit


def render(rows, summary):
    # Escape '<' to prevent a publisher-controlled string from ending script.
    data = json.dumps(rows, separators=(",", ":")).replace("<", "\\u003c")
    page = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NicheDB · Police source inventory</title>
<style>body{font:16px system-ui;background:#101720;color:#e9f0f7;margin:auto;max-width:1280px;padding:32px}h1{font-size:34px;margin-bottom:8px}p{max-width:950px;line-height:1.6;color:#bccbda}a{color:#81c8ff}input,select{font:inherit;padding:12px;border:1px solid #526174;border-radius:7px;background:#192534;color:white;margin:5px}input{min-width:260px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{text-align:left;vertical-align:top;padding:14px;border-bottom:1px solid #344352}th{color:#94aabc}.source{display:block;margin-bottom:12px}.muted{font-size:12px;color:#94aabc;display:block;margin-top:3px}.tag{color:#b4ebcb}#count{padding:12px 0}button{font:inherit;padding:10px;cursor:pointer}td:nth-child(1){min-width:145px}label{display:inline-block}details{margin-top:12px}summary{cursor:pointer}@media(max-width:650px){body{padding:15px}th:nth-child(2),td:nth-child(2){display:none}input{min-width:0;width:85%}td{padding:8px}}</style>
<h1>Police reports &amp; announcement sources</h1><p>U.S. municipal governments with more than 20,000 residents in Census Vintage 2025. Includes functioning towns and townships; overlapping governments retain separate Census IDs. Source discovery does not establish complete crime coverage or live ingestion.</p>
<p><strong>Start with the area in your NicheDB link.</strong> The default view shows municipalities whose Census reference point lies within 100 km of 37.243507, −121.942648. These points locate jurisdictions, not incidents.</p>
<label>Find a place<br><input id="search" placeholder="City, state, department, or account"></label>
<label>Area<br><select id="area"><option value="near">Within the linked 100 km</option><option value="all">All U.S. governments</option><option value="gaps">Places with no source found</option></select></label>
<label>Channel<br><select id="kind"><option value="">All source types</option><option>x</option><option>facebook</option><option>nixle</option><option>newsroom</option><option>incident-log</option><option>feed-candidate</option><option>department-page</option></select></label>
<p id="count" role="status"></p><table><thead><tr><th>Place</th><th>Population</th><th>Sources and evidence</th></tr></thead><tbody id="rows"></tbody></table><button type="button" id="more">Show 100 more</button>
<p>“Reviewed” identifies sources checked during this research. Automated links and indexed results remain candidates for checking department identity, jurisdiction, subject matter, and freshness. RSS calendars, empty feeds, single announcements, and alert signup pages are recorded separately. X and other social account URLs are not working ingestion endpoints.</p>
<p>Files: <a href="channels.csv">channels.csv</a> · <a href="inventory.json">inventory.json</a> · <a href="summary.json">summary.json</a> · <a href="validation.json">validation.json</a></p>
<script id="data" type="application/json">DATA</script><script>
const data=JSON.parse(document.getElementById('data').textContent),body=document.getElementById('rows');let limit=100;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(){const q=document.getElementById('search').value.toLowerCase(),area=document.getElementById('area').value,kind=document.getElementById('kind').value;const filtered=data.filter(r=>(area!=='near'||r.distance_from_link_km!==null&&r.distance_from_link_km<=100)&&(area!=='gaps'||!r.channels.length)&&(!kind||r.channels.some(c=>c.kind===kind))&&(!q||(r.name+' '+r.state+' '+r.state_name+' '+r.channels.map(c=>c.url+' '+(c.title||'')).join(' ')).toLowerCase().includes(q)));
document.getElementById('count').textContent=filtered.length.toLocaleString()+' governments · '+filtered.filter(r=>r.channels.length).length.toLocaleString()+' with source candidates · '+data.length.toLocaleString()+' in the national inventory';
body.innerHTML=filtered.slice(0,limit).map(r=>{const channels=r.channels.filter(c=>!kind||c.kind===kind).sort((a,b)=>((a.kind==='department-page')-(b.kind==='department-page')));const link=c=>'<span class="source"><span class="tag">'+esc(c.kind)+'</span> · <a target="_blank" rel="noopener noreferrer" href="'+esc(c.url)+'">'+esc(c.url)+'</a><span class="muted">'+esc(c.verification)+' · '+esc(c.access)+(c.validation?.newest_label?' · Latest: '+esc(c.validation.newest_label):'')+'</span><span class="muted">Evidence: <a target="_blank" rel="noopener noreferrer" href="'+esc(c.evidence_url)+'">'+esc(c.evidence_url)+'</a></span></span>';return '<tr><td><strong>'+esc(r.name)+', '+esc(r.state)+'</strong><span class="muted">'+esc(r.geography)+' · '+esc(r.id)+(r.distance_from_link_km!==null?' · '+r.distance_from_link_km+' km':'')+'</span></td><td>'+r.population.toLocaleString()+'<span class="muted">2025 estimate</span></td><td>'+channels.slice(0,4).map(link).join('')+(channels.length>4?'<details><summary>'+ (channels.length-4)+' more candidates</summary>'+channels.slice(4).map(link).join('')+'</details>':'')+(!channels.length?'Source unresolved. Check the local or contracted sheriff agency.':'')+'</td></tr>'}).join('');document.getElementById('more').hidden=filtered.length<=limit;}
for(const id of ['search','area','kind'])document.getElementById(id).addEventListener('input',()=>{limit=100;render()});document.getElementById('more').onclick=()=>{limit+=100;render()};render();</script></html>"""
    state = summary.get("state", "CA")
    minimum = summary.get("population_min_exclusive", 50000)
    page = page.replace("U.S. municipal governments with more than 20,000 residents", f"{state} municipal governments with more than {minimum:,} residents")
    page = page.replace("All U.S. governments", "All cities in this state").replace("in the national inventory", "in this state inventory")
    return page.replace("DATA", data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--state", default="CA")
    parser.add_argument("--min-population", type=int, default=50000)
    args = parser.parse_args()
    inventory = json.loads((OUT / "inventory.json").read_text())
    rows = inventory["places"]
    rows = [r for r in rows if (args.state.lower() == "all" or r["state"] == args.state.upper()) and r["population"] > args.min_population]
    by_id = {r["id"]: r for r in rows}
    searches_path = OUT / "indexed-searches.json"
    if searches_path.exists():
        for result in json.loads(searches_path.read_text()):
            if result["id"] in by_id:
                by_id[result["id"]]["channels"].extend(result["channels"])
                by_id[result["id"]]["indexed_search_query"] = result["query"]
    nixle_path = OUT / "nixle-directories.json"
    if nixle_path.exists():
        for result in json.loads(nixle_path.read_text()):
            if result["id"] in by_id:
                by_id[result["id"]]["channels"] = [c for c in by_id[result["id"]]["channels"] if not c.get("verification", "").startswith("certified-publisher-in-city-directory")]
                by_id[result["id"]]["channels"].extend(result["channels"])
    overrides = json.loads((ROOT / "docs/data/police-source-overrides.json").read_text())
    for row in rows:
        row["channels"].extend(overrides.get(row["state"] + ":" + row["name"], {}).get("channels", []))
        row["channels"] = clean_channels(row["channels"])
    validations_path = OUT / "validation.json"
    validations = json.loads(validations_path.read_text()) if validations_path.exists() else {}
    scope_urls = {c["url"] for row in rows for c in row["channels"]}
    validations = {u: v for u, v in validations.items() if u in scope_urls}
    if args.validate:
        todo = {c["url"]: c for row in rows for c in row["channels"] if c["kind"] in ("nixle", "feed-candidate") and c["url"] not in validations}
        print(f"Checking {len(todo)} public archive/feed URLs", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            for i, audit in enumerate(executor.map(validate_channel, todo.values()), 1):
                validations[audit["url"]] = audit
                if i % 20 == 0:
                    validations_path.write_text(json.dumps(validations, indent=2) + "\n")
                    print(f"Validated {i}/{len(todo)}", flush=True)
    validations_path.write_text(json.dumps(validations, indent=2) + "\n")
    for row in rows:
        for channel in row["channels"]:
            if channel["url"] in validations:
                channel["validation"] = validations[channel["url"]]
                channel["access"] = channel["validation"]["access"]
        useful = [c for c in row["channels"] if c["kind"] not in ("department-page", "feed-directory", "calendar-feed", "alert-directory", "announcement")]
        row["status"] = "channels-found" if useful else "department-found" if row["channels"] else "unresolved"
    summary = discovery.export(rows, OUT, args.min_population, args.state.upper())
    reviewed = json.loads((ROOT / "docs/data/police-ingestion-ca.json").read_text()) if args.state.upper() == "CA" else {}
    summary["reviewed_ingestion_cities"] = sum(r["name"] in reviewed for r in rows)
    summary["state"] = args.state.upper()
    summary["population_min_exclusive"] = args.min_population
    summary["unique_channel_urls"] = len({c["url"] for row in rows for c in row["channels"]})
    summary["local_governments_within_100km"] = sum(row["distance_from_link_km"] is not None and row["distance_from_link_km"] <= 100 for row in rows)
    summary["public_archives_or_feeds_with_items"] = sum(v["access"] in ("public-nixle-archive", "public-feed-with-items") for v in validations.values())
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (OUT / "index.html").write_text(render(rows, summary))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

"""Collect per-IP request evidence from nginx access logs and sshd for the /traffic review.

Run as root on dev2. stdin: one IP per line (the pending queue). stdout: JSON
{ip: {n, status: {code: count}, paths: [...], hosts: [...], ua: [...], ssh_accepted, ssh_failed}}.
Only the listed IPs are kept; nothing else from the logs leaves the box.
"""
import collections, glob, gzip, json, re, subprocess, sys

wanted = {l.strip() for l in sys.stdin if l.strip()}
LINE = re.compile(r'^(\S+) (\S+) \S+ \S+ \[[^\]]+\] "([A-Z]+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"')

out = {}
def rec(ip):
    r = out.get(ip)
    if r is None:
        r = out[ip] = {"n": 0, "status": collections.Counter(), "paths": [], "hosts": collections.Counter(),
                       "ua": collections.Counter(), "ssh_accepted": 0, "ssh_failed": 0}
    return r

files = sorted(glob.glob("/var/log/nginx/*access.log*"))
for f in files:
    opener = gzip.open if f.endswith(".gz") else open
    try:
        with opener(f, "rt", errors="replace") as fh:
            for line in fh:
                sp = line.find(" ")
                ip = line[sp + 1:line.find(" ", sp + 1)]
                if ip not in wanted:
                    continue
                m = LINE.match(line)
                if not m:
                    continue
                host, _, method, path, status, ua = m.groups()
                r = rec(ip)
                r["n"] += 1
                r["status"][status] += 1
                r["hosts"][host] += 1
                if len(r["ua"]) < 5 or ua in r["ua"]:
                    r["ua"][ua[:160]] += 1
                if len(r["paths"]) < 60 and path not in r["paths"]:
                    r["paths"].append(path[:300])
    except Exception as e:
        print(f"skip {f}: {e}", file=sys.stderr)

# sshd: accepted logins and failures per address, from the whole journal.
j = subprocess.run(["journalctl", "-q", "--no-pager", "-o", "cat", "_COMM=sshd", "--since", "-30d"],
                   capture_output=True, text=True, errors="replace").stdout
for line in j.splitlines():
    m = re.search(r"from (\S+) port", line)
    if not m or m.group(1) not in wanted:
        continue
    r = rec(m.group(1))
    if line.startswith("Accepted"):
        r["ssh_accepted"] += 1
    elif "Failed" in line or "Invalid user" in line:
        r["ssh_failed"] += 1

for r in out.values():
    r["status"] = dict(r["status"])
    r["hosts"] = [h for h, _ in r["hosts"].most_common(5)]
    r["ua"] = [u for u, _ in r["ua"].most_common(3)]
json.dump(out, sys.stdout)
print(f"{len(files)} log files, {len(out)} of {len(wanted)} addresses seen", file=sys.stderr)

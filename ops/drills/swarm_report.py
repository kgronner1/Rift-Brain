#!/usr/bin/env python3
"""Release drill 5's verdict (RJ 471, spec M9): reads the request log of Wobble Planet's --net_swarm and says whether
the brain's return after an outage was a stampede.

    python3 ops/drills/swarm_report.py <requests.csv> [<requests.csv> ...] [options]

    --window SEC     the steady window's length (default 60)
    --factor F       the limit, as a multiple of the steady mean (default 2)
    --min-seen P     the share of the swarm that must have seen the outage for the measurement to count (default 0.5)
    --max-gap MS     the longest frame gap the swarm process may have had (default 1000)
    --json FILE      also write the numbers as JSON

The log is `t_ms,client,op,result,ms` per request, `t_ms` when it was sent, with `#` lines for the run's settings
(start_unix_ms), `all_signed_in` and the process's health. Several logs (one per swarm process) are merged on their
start_unix_ms. Every op but `config` (the CDN, not the brain) is a brain request.

What is measured, in order (docs/release-drills.md, "Drill 5: stampede", in Wobble Planet):

  1. The steady window: the first full WINDOW seconds, in whole seconds of the swarm's clock, after every client has
     signed in. Its mean, brain requests per second, is the swarm's normal load on the brain.
  2. The outage: from the first request that failed in transport (NET_UNREACHABLE or MALFORMED_RESPONSE -- what a
     stopped brain behind Caddy, or a refused connection, answers) to the brain's return, the first request answered
     ok that was sent at least 2 s later.
  3. The reconnects: every client that failed in the outage is reconnecting from the brain's return until its first ok.
     Each brain request it sends meanwhile, its last one (the ok) included, is a reconnect request, counted in the
     same whole-second buckets as everything else (the first, the second the brain came back in, is a partial one).

Verdict: PASS when no 1 s reconnect bucket holds more than FACTOR x the steady mean ("no 1 s reconnect bucket above 2x
the mean over the first full window"), AND the measurement worked: a full steady window before the outage, an outage
seen by at least MIN-SEEN of the swarm and then ended, every client that lost the brain back on it by the end of the
log, and a swarm process that never stalled for more than MAX-GAP ms. Anything else is a FAIL that says which.
Prints a histogram from just before the outage to the end of the reconnects. Exit 0 on PASS, 1 on FAIL, 2 on bad input.
"""
import argparse
import json
import math
import sys
from collections import Counter, defaultdict

TRANSPORT = {"NET_UNREACHABLE", "MALFORMED_RESPONSE"}
OK = {"ok", "queued"}
MIN_OUTAGE_MS = 2000


def read_logs(paths):
    """Returns (rows, meta): rows are (t_ms, client, op, result) on one clock, the earliest log's start being 0."""
    logs = []
    for path in paths:
        start = None
        rows = []
        meta = {"all_signed_in": None, "health": [], "n": 0}
        try:
            fh = open(path, encoding="utf-8")
        except OSError as err:
            raise SystemExit(f"swarm_report.py: {err}") from None
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("#"):
                    fields = dict(f.split("=", 1) for f in line[1:].split() if "=" in f)
                    if line.startswith("# net_swarm"):
                        start = int(fields["start_unix_ms"])
                        meta["n"] = int(fields.get("n", 0))
                    elif line.startswith("# all_signed_in"):
                        meta["all_signed_in"] = int(fields["t_ms"])
                    elif line.startswith("# health"):
                        meta["health"].append((int(fields["t_ms"]), int(float(fields["max_frame_gap_ms"]))))
                    continue
                if line.startswith("t_ms,"):
                    continue
                parts = line.split(",")
                if len(parts) < 4:
                    raise SystemExit(f"swarm_report.py: {path}: not a swarm log line: {line}")
                rows.append((int(parts[0]), int(parts[1]), parts[2], parts[3]))
        if start is None:
            raise SystemExit(f"swarm_report.py: {path}: no '# net_swarm start_unix_ms=' line -- is it a --net_swarm log?")
        logs.append((start, rows, meta))
    t0 = min(s for s, _, _ in logs)
    rows = []
    meta = {"all_signed_in": 0, "health": [], "n": 0, "files": len(logs)}
    for start, r, m in logs:
        off = start - t0
        rows.extend((t + off, c, op, res) for t, c, op, res in r)
        meta["n"] += m["n"]
        if m["all_signed_in"] is None:
            meta["all_signed_in"] = None
        elif meta["all_signed_in"] is not None:
            meta["all_signed_in"] = max(meta["all_signed_in"], m["all_signed_in"] + off)
        meta["health"].extend((t + off, gap) for t, gap in m["health"])
    rows.sort()
    return rows, meta


def analyse(rows, meta, window_sec=60, factor=2.0, min_seen=0.5, max_gap_ms=1000):
    brain = [r for r in rows if r[2] != "config"]
    out = {"window_sec": window_sec, "factor": factor, "problems": [], "clients": meta["n"]}
    problems = out["problems"]
    per_sec = Counter(t // 1000 for t, _, _, _ in brain)
    out["per_sec"] = per_sec

    gaps = [(t, g) for t, g in meta["health"] if g > max_gap_ms]
    out["max_gap_ms"] = max((g for _, g in meta["health"]), default=0)
    if gaps:
        problems.append(f"the swarm process stalled ({len(gaps)} health line(s) with a frame gap over {max_gap_ms} ms, the "
                        f"longest {max(g for _, g in gaps)} ms): its timings cannot be trusted -- fewer clients per process")

    signed_in = meta["all_signed_in"]
    if signed_in is None:
        first_ok = {}
        for t, c, _, res in brain:
            if res in OK and c not in first_ok:
                first_ok[c] = t
        signed_in = max(first_ok.values()) if len(first_ok) >= meta["n"] > 0 else None
    out["all_signed_in_ms"] = signed_in

    down = next((t for t, _, _, res in brain if res in TRANSPORT and (signed_in is None or t >= signed_in)), None)
    out["down_ms"] = down
    if signed_in is None:
        problems.append("the swarm never had every client signed in, so it has no steady load to compare with")
    else:
        ws = math.ceil(signed_in / 1000)
        out["window_start_s"] = ws
        if down is not None and ws + window_sec > down // 1000:
            problems.append(f"no full {window_sec} s steady window before the outage: every client was signed in at "
                            f"t={signed_in / 1000:.1f}s and the outage began at t={down / 1000:.1f}s -- start the outage later")
        elif brain and ws + window_sec > brain[-1][0] // 1000:
            problems.append(f"the log ends before a full {window_sec} s steady window")
        else:
            out["steady_mean"] = sum(per_sec[s] for s in range(ws, ws + window_sec)) / window_sec
    if down is None:
        problems.append("no outage in the log: no brain request failed in transport after every client signed in")
        return out

    back = next((t for t, _, _, res in brain if res in OK and t >= down + MIN_OUTAGE_MS), None)
    out["back_ms"] = back
    if back is None:
        problems.append(f"the brain never came back: nothing answered ok after the outage began at t={down / 1000:.1f}s")
        return out
    out["outage_sec"] = (back - down) / 1000

    lost = {c for t, c, _, res in brain if down <= t < back and res in TRANSPORT}
    active = {c for t, c, _, _ in brain if t < down}
    out["lost"] = len(lost)
    out["active"] = len(active)
    if not active or len(lost) < min_seen * len(active):
        problems.append(f"only {len(lost)} of {len(active)} clients saw the outage (need {min_seen:.0%}): it was too short, "
                        "or the swarm too idle, to measure a return")

    reconnect = Counter()
    back_at = {}
    for t, c, _, res in brain:
        if t < back or c not in lost or c in back_at:
            continue
        reconnect[t // 1000 - back // 1000] += 1
        if res in OK:
            back_at[c] = t
    stragglers = len(lost) - len(back_at)
    out["reconnect"] = reconnect
    out["reconnected"] = len(back_at)
    if stragglers:
        problems.append(f"{stragglers} of {len(lost)} clients that lost the brain never got back on it before the log ended")
    span = max(back_at.values()) // 1000 - back // 1000 + 1 if back_at else 0
    out["span_sec"] = span
    out["peak"] = max(reconnect.values()) if reconnect else 0
    out["peak_at_s"] = max(reconnect, key=lambda k: (reconnect[k], -k)) if reconnect else None
    out["reconnect_requests"] = sum(reconnect.values())
    if span:
        out["span_mean"] = sum(reconnect[s] for s in range(span)) / span
    after = [per_sec[back // 1000 + s] for s in range(max(span, 1))]
    out["peak_all"] = max(after) if after else 0

    if "steady_mean" in out:
        out["limit"] = factor * out["steady_mean"]
        out["ratio"] = out["peak"] / out["steady_mean"] if out["steady_mean"] > 0 else float("inf")
        if out["peak"] > out["limit"]:
            out["stampede"] = True
    return out


def histogram(out, rows_per_sec_cap=60):
    lines = []
    if out.get("down_ms") is None or out.get("back_ms") is None:
        return lines
    per_sec, reconnect = out["per_sec"], out.get("reconnect", Counter())
    back_s = out["back_ms"] // 1000
    first = max(0, out["down_ms"] // 1000 - 5)
    last = back_s + max(out.get("span_sec", 0), 1) + 4
    top = max([per_sec[s] for s in range(first, last + 1)] + [1])
    scale = max(1, math.ceil(top / rows_per_sec_cap))
    limit = out.get("limit")
    lines.append(f"  second  brain  reconnect   (one # = {scale} request{'s' if scale > 1 else ''}; "
                 f"R = reconnects{'; | = the limit' if limit else ''})")
    for s in range(first, last + 1):
        r = reconnect.get(s - back_s, 0) if s >= back_s else 0
        bar = "R" * (r // scale) + "#" * ((per_sec[s] - r) // scale)
        if limit:
            cut = int(limit // scale)
            bar = (bar + " " * max(0, cut - len(bar)))
            bar = bar[:cut] + "|" + bar[cut:]
        mark = ""
        if s == out["down_ms"] // 1000:
            mark = "  <- outage"
        elif s == back_s:
            mark = "  <- brain back"
        lines.append(f"  {s:6d}  {per_sec[s]:5d}  {r:9d}   {bar.rstrip()}{mark}")
    return lines


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("logs", nargs="+")
    p.add_argument("--window", type=int, default=60)
    p.add_argument("--factor", type=float, default=2.0)
    p.add_argument("--min-seen", type=float, default=0.5)
    p.add_argument("--max-gap", type=int, default=1000)
    p.add_argument("--json")
    a = p.parse_args(argv)
    if a.window < 1 or a.factor <= 0:
        print("swarm_report.py: --window and --factor must be above 0", file=sys.stderr)
        return 2
    rows, meta = read_logs(a.logs)
    out = analyse(rows, meta, a.window, a.factor, a.min_seen, a.max_gap)

    print(f"SWARM  {meta['files']} log(s), {meta['n']} clients, {len(rows)} requests "
          f"({sum(1 for r in rows if r[2] != 'config')} to the brain)")
    by = defaultdict(Counter)
    for _, _, op, res in rows:
        by[op][res] += 1
    for op in sorted(by):
        print(f"SWARM  {op:12s} " + ", ".join(f"{k} {v}" for k, v in by[op].most_common()))
    if out.get("all_signed_in_ms") is not None:
        print(f"SWARM  every client signed in at t={out['all_signed_in_ms'] / 1000:.1f}s")
    if "steady_mean" in out:
        ws = out["window_start_s"]
        print(f"SWARM  steady window t={ws}..{ws + a.window}s: {out['steady_mean']:.1f} brain requests/s "
              f"(the limit: {a.factor:g}x = {a.factor * out['steady_mean']:.1f})")
    if out.get("back_ms") is not None:
        print(f"SWARM  outage t={out['down_ms'] / 1000:.1f}s .. {out['back_ms'] / 1000:.1f}s ({out['outage_sec']:.1f} s); "
              f"{out['lost']} of {out['active']} clients lost the brain, {out['reconnected']} back on it within "
              f"{out['span_sec']} s")
        print(f"SWARM  reconnects: {out['reconnect_requests']} requests; peak {out['peak']} in second "
              f"+{out['peak_at_s']} after the return; mean over the reconnect span {out.get('span_mean', 0):.1f}/s; "
              f"busiest second of all brain traffic then {out['peak_all']}")
    print(f"SWARM  the swarm process's longest frame gap: {out.get('max_gap_ms', 0)} ms")
    for line in histogram(out):
        print(line)
    for problem in out["problems"]:
        print(f"STAMPEDE FAIL  {problem}")
    if "ratio" in out:
        word = "FAIL" if out.get("stampede") else "PASS"
        print(f"STAMPEDE {word}  peak reconnect bucket {out['peak']} vs the limit {out['limit']:.1f} "
              f"({out['ratio']:.2f}x the steady mean {out['steady_mean']:.1f}/s)")
    passed = not out["problems"] and "ratio" in out and not out.get("stampede")
    print(f"STAMPEDE VERDICT: {'PASS' if passed else 'FAIL'}")
    if a.json:
        dump = {k: v for k, v in out.items() if k not in ("per_sec", "reconnect")}
        dump["reconnect"] = {str(k): v for k, v in sorted(out.get("reconnect", {}).items())}
        dump["verdict"] = "PASS" if passed else "FAIL"
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(dump, f, indent=1)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""The report of a capacity run (RJ 484): ops/drills/measure_capacity.sh writes the run's directory and calls this.

    python3 ops/drills/capacity_report.py <run dir>

Reads meta.env, samples.csv (capacity_agent.sh's), events.log and, when present, cw_<metric>.json (CloudWatch). Prints
Markdown: per-phase tables, the derived figures, and a "Capacity" table ready for Wobble Planet's docs/backend-ops.md.
Only settled samples count (a stage's matches all in game); the warm-ups are left out.
"""
import csv
import datetime
import json
import os
import statistics
import sys

T2_MICRO_EARN_PER_H = 6.0      # credits a t2.micro earns an hour (its 10% baseline)
T2_MICRO_MAX_BALANCE = 144.0   # the most it can hold (24 h of earning)
T2_MICRO_BASELINE_PCT = 10.0


def meta(run_dir):
    out = {}
    with open(os.path.join(run_dir, "meta.env")) as f:
        for line in f:
            line = line.strip()
            if "=" in line:
                k, v = line.split("=", 1)
                out[k] = v.strip("'")
    return out


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.fmean(xs) if xs else None


def median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def p95(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]


def fmt(x, digits=0, unit=""):
    if x is None:
        return "-"
    return f"{x:.{digits}f}{unit}"


def mb(kb):
    return None if kb is None else kb / 1024.0


def load_samples(run_dir):
    rows = []
    with open(os.path.join(run_dir, "samples.csv")) as f:
        for r in csv.DictReader(f):
            rows.append(r)
    return rows


def phase_order(rows):
    seen = []
    for r in rows:
        if r["phase"] not in seen and r["phase"] not in ("start", "end"):
            seen.append(r["phase"])
    return seen


def cw_points(run_dir, metric):
    path = os.path.join(run_dir, f"cw_{metric}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        pts = json.load(f).get("Datapoints", [])
    out = []
    for p in pts:
        ts = datetime.datetime.fromisoformat(p["Timestamp"].replace("Z", "+00:00")).timestamp()
        out.append((ts, p))
    return sorted(out, key=lambda x: x[0])


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: capacity_report.py <run dir>")
    run_dir = sys.argv[1]
    m = meta(run_dir)
    rows = load_samples(run_dir)
    floor_mb = float(m.get("FLOOR_MB", 150))
    phases = phase_order(rows)
    settled = [r for r in rows if r["settled"] == "1"]
    by_phase = {p: [r for r in settled if r["phase"] == p] for p in phases}

    events = []
    ev_path = os.path.join(run_dir, "events.log")
    if os.path.exists(ev_path):
        with open(ev_path) as f:
            events = [line.rstrip("\n") for line in f]
    aborted = [e for e in events if " ABORT " in e]
    skips = [e for e in events if " SKIP " in e or " WARN " in e]
    exits = [e for e in events if " EXIT " in e]
    done = [e for e in events if " DONE " in e]
    match_secs = []
    for e in events:
        if " POSTGAME " in e and "ended after " in e:
            try:
                match_secs.append(int(e.split("ended after ", 1)[1].split("s", 1)[0]))
            except ValueError:
                pass

    start = int(m.get("RUN_START", 0) or 0)
    when = datetime.datetime.fromtimestamp(start, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if start else "?"
    print(f"# Capacity run {when}")
    print()
    print(f"- instance: {m.get('INSTANCE_TYPE', '?')} {m.get('INSTANCE_ID', '')}, {m.get('NPROC', '?')} core(s), "
          f"{fmt(mb(num(m.get('MEM_TOTAL_KB'))))} MB; credit mode {m.get('CREDIT_MODE', '?')}")
    print(f"- server: {m.get('WIRE_DIR', '?')} (`{m.get('BINARY', '?')}`), each match `--open_mode --bots=3 --bot_difficulty=Hard`")
    print(f"- phases: {m.get('PHASES', '?')}; a sample every {m.get('INTERVAL', '?')} s; floor {floor_mb:.0f} MB")
    if aborted:
        print(f"- **ABORTED**: {aborted[0].split(' ', 2)[2]}")
    for e in skips:
        print(f"- note: {e.split(' ', 2)[2]}")
    if exits:
        print(f"- server exits: {len(exits)} (each restarted while its phase wanted it); first: {exits[0].split(' ', 2)[2]}")
    if match_secs:
        print(f"- matches that ended: {len(match_secs)}; a server's start to its POSTGAME, median {statistics.median(match_secs):.0f} s "
              f"(min {min(match_secs)}, max {max(match_secs)}); each was then replaced by a fresh server")
    else:
        print("- no match ended during the run: every figure is mid-match")
    if done:
        print(f"- {done[-1].split(' ', 2)[2]}")
    print()

    # --- the box ---
    print("## The box, per phase (settled samples)")
    print()
    print("| phase | matches | samples | MB available (median / min) | swap used MB (max) | swap in / out pages/s | load 1m (mean / max) | CPU % (mean / p95) | steal % | iowait % |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    box_stats = {}
    for p in phases:
        b = [r for r in by_phase[p] if r["who"] == "box"]
        if not b:
            continue
        avail = [mb(num(r["avail_kb"])) for r in b]
        cpu = [num(r["box_cpu_pct"]) for r in b]
        st = {
            "matches": median([num(r["matches"]) for r in b]),
            "avail_med": median(avail), "avail_min": min(x for x in avail if x is not None),
            "cpu_mean": mean(cpu), "cpu_p95": p95(cpu), "steal": mean([num(r["steal_pct"]) for r in b]),
            "load_mean": mean([num(r["load1"]) for r in b]), "load_max": max(num(r["load1"]) or 0 for r in b),
            "t0": int(b[0]["t"]), "t1": int(b[-1]["t"]),
        }
        box_stats[p] = st
        print(f"| {p} | {fmt(st['matches'])} | {len(b)} | {fmt(st['avail_med'])} / {fmt(st['avail_min'])} | "
              f"{fmt(max(mb(num(r['swap_used_kb'])) or 0 for r in b))} | "
              f"{fmt(mean([num(r['swapin_pps']) for r in b]), 1)} / {fmt(mean([num(r['swapout_pps']) for r in b]), 1)} | "
              f"{fmt(st['load_mean'], 2)} / {fmt(st['load_max'], 2)} | {fmt(st['cpu_mean'], 1)} / {fmt(st['cpu_p95'], 1)} | "
              f"{fmt(st['steal'], 1)} | {fmt(mean([num(r['iowait_pct']) for r in b]), 1)} |")
    print()

    # --- the game servers ---
    print("## Each game server, per phase")
    print()
    print("RSS is resident memory; peak is the kernel's high-water mark (VmHWM) since the server started. CPU is percent of one core.")
    print()
    print("Server rows count only while their server is in a match (between INGAME and POSTGAME).")
    print()
    print("| phase | servers | RSS MB per server (median) | peak RSS MB (max) | swapped MB (max) | CPU % per server (mean / p95) | all servers' CPU % (mean) |")
    print("|---|---|---|---|---|---|---|")
    srv_stats = {}
    for p in phases:
        s = [r for r in by_phase[p] if r["who"].startswith("server.")]
        # Only a server in a match counts toward a match's cost; one between matches is waiting for its replacement.
        if s and "state" in s[0]:
            s = [r for r in s if r.get("state") == "ingame"]
        if not s:
            continue
        per = {}
        for r in s:
            per.setdefault(r["who"], []).append(r)
        rss_med = mean([median([mb(num(r["rss_kb"])) for r in rs]) for rs in per.values()])
        peak = max(mb(num(r["peak_kb"])) or 0 for r in s)
        cpu = [num(r["cpu_pct"]) for r in s]
        by_t = {}
        for r in s:
            if num(r["cpu_pct"]) is not None:
                by_t[r["t"]] = by_t.get(r["t"], 0.0) + num(r["cpu_pct"])
        srv_stats[p] = {"n": len(per), "rss": rss_med, "peak": peak, "cpu": mean(cpu), "cpu_p95": p95(cpu),
                        "total_cpu": mean(list(by_t.values()))}
        print(f"| {p} | {len(per)} | {fmt(rss_med)} | {fmt(peak)} | {fmt(max(mb(num(r['swap_kb'])) or 0 for r in s))} | "
              f"{fmt(mean(cpu), 1)} / {fmt(p95(cpu), 1)} | {fmt(srv_stats[p]['total_cpu'], 1)} |")
    print()

    # --- the brains and the rest ---
    others = sorted({r["who"] for r in settled if r["who"] != "box" and not r["who"].startswith("server.")})
    if others:
        print("## The brains and the box's other services, per phase")
        print()
        print("RSS MB (median) / CPU % (mean). `other-server.<pid>` is a game server this run did not start (a real lobby).")
        print()
        print("| process | " + " | ".join(phases) + " |")
        print("|---|" + "---|" * len(phases))
        for who in others:
            cells = []
            for p in phases:
                rs = [r for r in by_phase[p] if r["who"] == who]
                cells.append(f"{fmt(median([mb(num(r['rss_kb'])) for r in rs]))} / {fmt(mean([num(r['cpu_pct']) for r in rs]), 1)}" if rs else "-")
            print(f"| {who} | " + " | ".join(cells) + " |")
        print()

    # --- derived ---
    idle = box_stats.get("idle")
    match_phases = [p for p in phases if p.startswith("m") and p[1:].isdigit() and p in box_stats]
    per_match_mem = []
    for p in match_phases:
        n = box_stats[p]["matches"] or 0
        if idle and n > 0:
            per_match_mem.append((idle["avail_med"] - box_stats[p]["avail_med"]) / n)
    marg_mem = mean(per_match_mem)
    srv_rss = mean([srv_stats[p]["rss"] for p in match_phases if p in srv_stats])
    srv_peak = max([srv_stats[p]["peak"] for p in match_phases if p in srv_stats] or [0]) or None
    cpu_per_match = mean([srv_stats[p]["cpu"] for p in match_phases if p in srv_stats])
    idle_cpu = idle["cpu_mean"] if idle else None

    print("## Derived")
    print()
    derived = []
    if marg_mem is not None:
        derived.append(("memory a match takes from MemAvailable (idle less each stage, / matches)", f"{marg_mem:.0f} MB"))
    if srv_rss is not None:
        derived.append(("a server's resident memory, steady (median) / peak", f"{srv_rss:.0f} MB / {fmt(srv_peak)} MB"))
    if idle and marg_mem:
        fit = int((idle["avail_med"] - floor_mb) // marg_mem) if marg_mem > 0 else None
        derived.append((f"matches that fit over the {floor_mb:.0f} MB floor, from idle", f"{fit}" if fit is not None else "-"))
    if cpu_per_match is not None:
        derived.append(("CPU a match takes (one server, % of a core)", f"{cpu_per_match:.1f} %"))
    if idle_cpu is not None:
        derived.append(("idle CPU (three brains, MariaDB, Caddy)", f"{idle_cpu:.1f} %"))
    if cpu_per_match and idle_cpu is not None and cpu_per_match > 0:
        derived.append(("matches until the box's CPU is full", f"{(100 - idle_cpu) / cpu_per_match:.1f}"))
        neutral = (T2_MICRO_BASELINE_PCT - idle_cpu) / cpu_per_match
        derived.append((f"matches that run credit-neutral (under the {T2_MICRO_BASELINE_PCT:.0f}% baseline)", f"{max(neutral, 0):.2f}"))
        for k in (1, 2, 3):
            use = (idle_cpu + k * cpu_per_match) / 100 * 60
            net = use - T2_MICRO_EARN_PER_H
            hours = f"{T2_MICRO_MAX_BALANCE / net:.1f} h from a full {T2_MICRO_MAX_BALANCE:.0f}" if net > 0 else "never: it earns more than it spends"
            derived.append((f"credits at {k} match(es) back to back (sampled CPU)", f"{use:.1f}/h spent, {net:+.1f}/h net; empty in {hours}"))
    for label, v in derived:
        print(f"- {label}: **{v}**")
    print()

    # --- CloudWatch ---
    print("## CPU credits (CloudWatch)")
    print()
    skipped = os.path.join(run_dir, "cloudwatch.skipped")
    bal = cw_points(run_dir, "CPUCreditBalance")
    cw_rows = []
    if os.path.exists(skipped):
        with open(skipped) as f:
            print(f"Skipped: {f.read().strip()}. The credit figures above come from the sampled CPU instead.")
    elif bal is None:
        print("Not fetched.")
    else:
        end = int(m.get("RUN_END", 0) or 0)
        inside = [(t, p) for t, p in bal if start - 300 <= t <= end + 300]
        print("| 5-min period starting (UTC) | CPUCreditBalance | CPUCreditUsage | CPUUtilization % (avg / max) |")
        print("|---|---|---|---|")
        usage = {t: p for t, p in (cw_points(run_dir, "CPUCreditUsage") or [])}
        util = {t: p for t, p in (cw_points(run_dir, "CPUUtilization") or [])}
        for t, p in bal:
            u = usage.get(t, {})
            c = util.get(t, {})
            mark = " (run)" if start - 300 <= t <= end else ""
            print(f"| {datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%H:%M')}{mark} | "
                  f"{fmt(p.get('Average'), 1)} | {fmt(u.get('Sum'), 2)} | {fmt(c.get('Average'), 1)} / {fmt(c.get('Maximum'), 1)} |")
        print()
        sess = box_stats.get("session")
        window = (sess["t0"], sess["t1"]) if sess else (start, end)
        wpts = [(t, p["Average"]) for t, p in bal if window[0] - 150 <= t <= window[1] + 150]
        if len(wpts) >= 2:
            hours = (wpts[-1][0] - wpts[0][0]) / 3600.0
            drop = wpts[0][1] - wpts[-1][1]
            rate = drop / hours if hours > 0 else 0
            label = "the session" if sess else "the run"
            print(f"Over {label} ({hours * 60:.0f} min of CloudWatch points): the balance went {wpts[0][1]:.1f} -> {wpts[-1][1]:.1f}, "
                  f"{rate:+.1f} credits/h net drain (earning included).")
            cw_rows.append((f"credit drain, {label} (CloudWatch)", f"{rate:.1f}/h net" + (f"; a full {T2_MICRO_MAX_BALANCE:.0f} lasts {T2_MICRO_MAX_BALANCE / rate:.1f} h" if rate > 0 else "")))
        elif not inside:
            print("No CloudWatch point inside the run yet: its 5-minute figures arrive ~10 min late. Re-render with --report later.")
        else:
            print("Too few CloudWatch points inside the window to give a rate (a run under ~10 min): the session run gives one.")
    print()

    # --- the doc table ---
    print("## For docs/backend-ops.md, \"Capacity\"")
    print()
    print(f"Measured {when[:10]} on the {m.get('INSTANCE_TYPE', '?')} ({m.get('NPROC', '?')} core, "
          f"{fmt(mb(num(m.get('MEM_TOTAL_KB'))))} MB), server {m.get('WIRE_DIR', '?')}, three Hard bots per match, "
          f"with the legacy, dev and alpha brains running.")
    print()
    print("| figure | value |")
    print("|---|---|")
    if idle:
        print(f"| idle: memory available / CPU / load | {fmt(idle['avail_med'])} MB / {fmt(idle['cpu_mean'], 1)} % / {fmt(idle['load_mean'], 2)} |")
    for p in match_phases:
        b, s = box_stats[p], srv_stats.get(p)
        print(f"| {fmt(b['matches'])} match(es): memory available (min) / box CPU (mean, p95) / load / steal | "
              f"{fmt(b['avail_med'])} ({fmt(b['avail_min'])}) MB / {fmt(b['cpu_mean'], 1)}, {fmt(b['cpu_p95'], 1)} % / "
              f"{fmt(b['load_mean'], 2)} / {fmt(b['steal'], 1)} % |")
    if "session" in box_stats:
        b = box_stats["session"]
        print(f"| session, {fmt(b['matches'])} match(es) back to back for {(b['t1'] - b['t0']) / 60:.0f} min: memory available (min) / CPU / steal | "
              f"{fmt(b['avail_med'])} ({fmt(b['avail_min'])}) MB / {fmt(b['cpu_mean'], 1)} % / {fmt(b['steal'], 1)} % |")
    for label, v in derived + cw_rows:
        print(f"| {label} | {v} |")
    for who in [w for w in others if w in ("legacy", "dev", "alpha")]:
        idle_rs = [r for r in by_phase.get("idle", []) if r["who"] == who]
        busy_rs = [r for p in match_phases for r in by_phase[p] if r["who"] == who]
        print(f"| brain {who}: RSS / CPU idle, and during matches | {fmt(median([mb(num(r['rss_kb'])) for r in idle_rs]))} MB / "
              f"{fmt(mean([num(r['cpu_pct']) for r in idle_rs]), 1)} %; {fmt(median([mb(num(r['rss_kb'])) for r in busy_rs]))} MB / "
              f"{fmt(mean([num(r['cpu_pct']) for r in busy_rs]), 1)} % |")


if __name__ == "__main__":
    main()

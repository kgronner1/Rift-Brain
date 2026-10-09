# rift-brain

This is a node server endpoint that will control game lobbies and placement of players who connect to the server.

Players will ping this api, a receive either a port to connect to for the game or a wait code.

Game lobbies will contact the api for health checks and to update game status and player counts.

This api will create and destroy game instances as needed.

AUTOMATIC START UP:

Rift-Brain should automatically start on server bootup using pm2

To list and check active instances type "pm2 list".

ON NEW SERVER:

"pm2 stop rift-brain"
will stop an instance
"pm2 start rift-brain" 
will start it
"ps -ef" 
will show a full list of processes
"mysql -u USER -p"
type password then you're into db.
"use rift_brain"
tables are user and user_stats

allow scp uploads
chmod u+w /home/ec2-user

TO MANUALLY START SERVER:

node ./src/app.js

Must be done in Rift-Brain folder for .env reasons

## Layout (RJ 462)

```
src/app.js              bootstrap: env, database, lobby registry, listeners
src/config/env.js       every setting, from .env, validated at boot (see .env.example)
src/db.js               the MySQL pool
src/match/lobbies.js    the legacy brain's game instances and join queue (in process memory)
src/match/registry.js   a new environment's lobbies, seats and lobby-wait queue, per wire protocol (RJ 466)
src/match/manifest.js   SERVERS_DIR/manifest.json: which server binary serves which (wire, fp) (RJ 466)
src/match/host.js       the box side: UDP port test, starting and stopping game servers (RJ 466)
src/routes/internal/    the internal API, game server -> brain, on 127.0.0.1:INTERNAL_PORT (RJ 466)
src/match/ports.js      which game port is free
src/match/process.js    spawning and killing game server processes
src/storage/            today's storage.js, split by table
src/routes/legacy/      today's routes, unchanged in path and shape; they go at cutover
src/migrate.js          schema migrations (see "Migrations")
src/config/remoteSchema.js  the remote config document's rules (RJ 463)
src/config/remote.js    the brain's copy of its remote config document, read every 30 s (RJ 465)
src/contract/           the /v1 envelope and the error code registry (RJ 465)
src/middleware/         /v1's request id, client-header gates, session auth, rate limits, errors (RJ 465)
src/auth/               tokens (sign/verify, the lobby key) and device credentials (RJ 465)
src/routes/v1/          API v1 (RJ 465); /v1/match/join and /v1/queue's lobby kind (RJ 466); its admission kind (RJ 468)
src/admission/          the admission queue in front of sign-in (RJ 468, spec M6), in process memory
src/log.js              every log line, with tokens, credentials and passwords redacted (RJ 465)
fixtures/               join_token_v1.txt and its builder: the client's cross-language token test (RJ 465)
test/                   npm test (node --test); pure tests need no database
config/                 the remote config documents, one per environment (RJ 463)
ops/config/             validate.mjs, publish.sh, rollback.sh (RJ 463)
infra/                  CloudFormation, the box's provisioning, and their tests (RJ 463): infra/README.md
```

With `ENV` unset the brain behaves exactly as before RJ 462 (port 3000 on every interface, UDP 8080-8085,
the single server binary in /home/ec2-user), so the legacy box keeps its `.env` as it is. A new environment
(`ENV=dev|alpha|prod`) must spell out `PUBLIC_PORT`, `INTERNAL_PORT`, `GAME_PORTS`, `GAME_HOST`, `SERVERS_DIR` and
its three keys, binds 127.0.0.1, and serves none of today's matchmaking routes (only `GET /` and
`/server_health_check` of them): it matches through `/v1/match/join`.

`npm test` runs every test. Database tests run only when `RJ_TEST_DB` is set.

## Migrations

The schema is `migrations/NNNN_name.sql`, applied in order by `src/migrate.js` and recorded (with each file's
SHA-256) in `schema_migrations`. No new dependencies: it uses mysql2.

```
npm run migrate                  # apply what is pending
npm run migrate -- --baseline    # on a copy of rift_brain: mark 0001 applied without running it
npm run migrate -- --status      # list applied and pending, change nothing
```

- It reads `MYSQL_*` from `.env` and runs only with `ENV=dev|alpha|prod`. It refuses the legacy `rift_brain`
  database outright: the legacy brain still reads `users.access_token` until cutover.
- A fresh database is built from 0001. A database that already has tables needs `--baseline` first, and
  0001 is refused on it, so the baseline can never be replayed over real data.
- An applied migration's file must never change (the run stops); fix forward with a new number.
- `GET_LOCK` keeps two runs from overlapping. DDL is not transactional, so a migration that fails part way is
  not recorded; write each step to check before it acts (0002 does), so it can simply be run again.

| File | What |
|---|---|
| `0001_baseline.sql` | today's `rift_brain` schema, dumped from the box (not yet in git, see below) |
| `0002_hardening.sql` | `UNIQUE` on `users.username` and `users.email`; `user_credentials`; drops `users.access_token` |

**Making `0001_baseline.sql`** (once, by hand, on the box). Over SSH:

```
mysqldump -u <db user> -p --no-data --skip-comments --skip-add-drop-table --routines --triggers rift_brain \
  | sed -E 's/ AUTO_INCREMENT=[0-9]+//' > ~/0001_baseline.sql
```

`--skip-add-drop-table` matters: a default dump starts each table with `DROP TABLE IF EXISTS`. The `sed` drops
today's row counters, so a fresh database starts its ids at 1. Then, on the Mac, from this checkout:

```
scp -i <pem> ec2-user@<host>:~/0001_baseline.sql migrations/0001_baseline.sql
grep -c '^CREATE TABLE' migrations/0001_baseline.sql     # users, user_stats, user_accolades, ... (5 or more)
grep -nE 'DROP TABLE|INSERT INTO' migrations/0001_baseline.sql   # nothing
```

Commit it as it is: migrate records its checksum, and an edit after the first run stops every later run.

**Tests.** `npm test` runs the pure tests. The database tests (`test/migrate.db.test.js`) run when
`RJ_TEST_DB=mysql://user:pass@127.0.0.1:3306/rj_migrate_test` names a disposable database (the name must contain
`test`; every test drops and recreates it). They build from a miniature 0001, and from the real one once it exists.

## API v1 (RJ 465)

A new environment (`ENV=dev|alpha|prod`) serves `/v1` on its public listener beside today's routes; the legacy
brain (`ENV` unset) does not, and is otherwise unchanged. The contract is the alpha-readiness spec, section 4:
any change to it needs Alex and Kyler.

- **Every response is an envelope** (`src/contract/envelope.js`): `{result:"ok",data}`, `{result:"error",error}` or
  `{result:"queued",queued}`. A route raises `fail('VALIDATION', { message })`; `src/contract/codes.js` fills the
  retry, scope, action and status, and config `messages.<CODE>` overrides the text. Every response carries
  `X-RJ-Ref`, the same `ref` as the error body and the request's `[v1]` log line.
- **In order**, for every `/v1` request: the ref; the client-header gates of spec 4.9 (`ENV_MISMATCH`,
  `API_UNSUPPORTED`, `UPDATE_REQUIRED` app then multiplayer, `MAINTENANCE`), before the body is read; the body
  (64 KB); then the route, whose locked ones check `Authorization: Bearer <session>` (`AUTH_REQUIRED`,
  `AUTH_EXPIRED`) and their rate limits.
- **The gates and the limits come from the remote config document** at `CONFIG_URL` (`src/config/remote.js`):
  fetched at boot and every 30 s, read field by field (a bad field keeps its last value), refused whole for another
  `env`, an older `serial` or another `schema`. If CloudFront is unreachable the brain keeps its last copy; until the
  first fetch, the compiled defaults (open gates, spec 4.5's limits).
- **Sign-in.** `POST /v1/accounts` and a password login at `POST /v1/session` issue a device credential (32 random
  bytes; the database keeps only its SHA-256 in `user_credentials`) and a one-hour session token. A credential restore
  at `/v1/session` issues a session. Revoke a device with `UPDATE user_credentials SET revoked_at = NOW() WHERE id = ?`.
- **Tokens** (`src/auth/tokens.js`): `base64url(payload).base64url(HMAC-SHA256(key bytes, payload part))`, no
  padding, times in seconds. `SESSION_KEY` signs sessions; a dev token is invalid in alpha.
- **Rate limits** (`server.rate_limits` in config, per minute, in memory): password logins per IP and per account,
  account creation per IP and per username/email, credential restores per credential. Over a limit: `RATE_LIMITED`
  with `retry: after` and `Retry-After`.
- **Logs** go through `src/log.js`, which redacts any value under a key naming a password, token, credential,
  authorization, grant or session, and anything shaped like one of our tokens. Request bodies are never logged.
- **`fixtures/join_token_v1.txt`** is the client's cross-language test (Wobble Planet copies it to
  `Tools/harness/fixtures/`). `node fixtures/build_join_token_v1.js --write` rebuilds it; `npm test` fails if it drifts.

**Tests.** `npm test` runs the contract tests (`test/contract.test.js` pins the registry to spec 4.3 and the
envelope's shapes; `test/v1_http.test.js` the gates' order and the middleware's), tokens, log redaction and the SQL
key filters with no database. `test/v1.db.test.js` drives every route against a database built from `migrations/`
when `RJ_TEST_DB` is set, e.g. with a throwaway MariaDB 10.11:

```
docker run -d --name rb-test-db -e MARIADB_ROOT_PASSWORD=pw -p 127.0.0.1:33306:3306 mariadb:10.11
RJ_TEST_DB=mysql://root:pw@127.0.0.1:33306/rj_migrate_test npm test
docker rm -f rb-test-db
```

The box runs Node 16: runtime code uses no global `fetch` (the config fetcher is `https.get`). Tests may use newer
Node.


## Matchmaking (RJ 466, spec M4)

A new environment matches players through `POST /v1/match/join` and `/v1/queue/:ticket`, hands each a **join
token** (spec 4.8, signed with `JOIN_KEY`, 60 s, one seat in one lobby), and runs **one server binary per wire
protocol**. Game servers talk back on the **internal API**, `127.0.0.1:INTERNAL_PORT/internal/v1/*` (spec 4.11),
authenticated by their **lobby key**, hex `HMAC-SHA256(LOBBY_MASTER_KEY, lobby_id)`.

**The servers directory.** Wobble Planet's `deploy_server.sh --env dev|alpha` writes it; the brain only reads it,
again on every join, so a deploy needs no brain restart:

```
<SERVERS_DIR>/                                   /opt/rj/dev/servers, /opt/rj/alpha/servers
  manifest.json
  wire-<N>-<fp>/server.x86_64                    one directory per (wire VERSION, FINGERPRINT); executable
```

```json
{ "servers": [
  { "wire": 17, "fp": "9f2c4e1a0b7d3c55", "path": "wire-17-9f2c4e1a0b7d3c55/server.x86_64",
    "sha": "<the Wobble Planet commit>", "deployed_at": "2026-10-08T18:00:00Z", "status": "active" } ] }
```

- `wire` is a positive integer, `fp` 16 lower-case hex characters, `status` `active` or `retired`. `path` is
  relative to `SERVERS_DIR` (an absolute path must lie inside it). `sha` and `deployed_at` are for people.
- An entry the brain cannot use is skipped and logged (`[manifest]`); the others still serve. A missing or
  unparseable manifest is "nothing deployed": every join answers `SERVER_BEHIND`.
- Upload a binary as `server.x86_64.new` and `mv` it into place (running lobbies keep the old inode); write the
  manifest to a temporary file in `SERVERS_DIR` and `mv` it over `manifest.json`.
- `--retire N` sets `status: retired` on every entry of wire N; `--withdraw N` removes them (the binaries stay).

**Routing** a client on `(X-RJ-Wire, X-RJ-Wire-Fp)`: below `gates.min_wire`, or any entry of that wire `retired` ->
`UPDATE_REQUIRED` (scope multiplayer); an `active` entry for exactly that pair -> play, in lobbies of that pair only;
anything else -> `SERVER_BEHIND`. A private code whose lobby runs another pair -> `LOBBY_WRONG_VERSION`.

**A lobby** is spawned on the first port of `GAME_PORTS` that no lobby holds and that passes a UDP bind test, as
`<binary> --port=<p> --lobby_id=<id> --net_env=<ENV> --brain_url=http://127.0.0.1:<INTERNAL_PORT> [--private_code=<c>]`,
with `RJ_JOIN_KEY` and `RJ_LOBBY_KEY` in its environment (never argv), its working directory the binary's, and nothing
else of the brain's environment but `PATH HOME USER LANG LC_ALL TMPDIR`. Its states come from its heartbeats
(`BOOTING`, `PREGAME`, `INGAME`, `POSTGAME`); only `PREGAME` takes players. Capacity is seated humans + reservations +
bots < 4. A join token's seat is reserved for 60 s; `player-joined` seats it, `player-left` frees it. A lobby with no
heartbeat for 45 s is stopped; an empty one ends after `POSTGAME`, or after 120 s empty in `PREGAME` or `INGAME`.

**The lobby-wait queue** is the `lobby` kind of spec 4.2's `queued`: FIFO, `poll_after_ms` 3000 ± 20% (1000 ± 20%
while the lobby boots or the brain is adopting), `expires_in_sec` 60 (each poll renews it), capped at
`server.lobby_queue_max` (beyond it, `NO_CAPACITY`; a player waiting on a lobby that is booting is not counted).
`create_private` always answers `queued` while its lobby boots; the poll that finds it ready answers as the join's ok.

**A brain restart** loses nothing that matters: pm2 runs it with `treekill: false`, so its game servers keep running.
For 30 s it spawns nothing and every join answers `queued`; meanwhile each lobby's next heartbeat (every 15 s) verifies
under its derived key and the brain adopts it, seats included. After 30 s it stops any of its own servers that never
heartbeated: a process carrying `--lobby_id=` that runs a binary under `SERVERS_DIR` or names this brain's
`--brain_url`. Nothing else on the box is ever signalled.

**The internal API's answers** are the 4.2 envelope. A missing or wrong lobby key is `AUTH_REQUIRED` (401).
`heartbeat`, `player-joined` and `player-left` answer `{}`; `player-joined` for a seat that is not that player's is
`VALIDATION` (409), and any call but a heartbeat from a lobby the brain does not know is `LOBBY_NOT_FOUND` (send a
heartbeat). `match/results` takes today's array and answers `{players, ignored_user_ids}`: `players` is today's
`data` (each player's new all-time stats), for the players who took a seat in this lobby; the rest are ignored.
`match/accolades` answers `{user_accolades, ignored_keys}`, or `VALIDATION` (403) for a player with no seat.

**Tests.** `test/manifest.test.js`, `test/match_registry.test.js`, `test/match_http.test.js` (every
`/v1/match/join` outcome), `test/internal_http.test.js` (the lobby key, adoption after a restart, the seat checks)
and `test/match_host.test.js` (a real spawn and UDP test) need no database; `test/internal.db.test.js` writes match
results against one.


## Admission queue (RJ 468, spec M6)

A token bucket in front of sign-in, **off by default**. Every value is `server.admission` in the environment's config
document, read live: a publish switches it on or off, or retunes it, within the brain's 30 s config poll, with no
restart.

- **Who queues.** With `enabled: true`, when the bucket is empty **or** anyone is already waiting, `POST /v1/session`
  and `POST /v1/accounts` answer `queued` (202, kind `admission`) instead of signing in, unless the request is a
  **refresh** (`{credential, session}` whose session is genuine, issued to that credential's user, and younger than
  `session_refresh_grace_sec`) or carries a valid `grant`. Input checks and rate limits come first; the database comes
  after, so a queued request costs no bcrypt and no query.
- **The bucket** holds `burst` tokens and refills at `rate_per_min`. A sweep every second grants waiting tickets FIFO,
  one token each. While anyone waits, tokens are not capped at `burst` until the sweep has spent them.
- **A ticket** (`q_...`) is bound to `X-RJ-Install`, one per install (asking again returns the same place). `expires_in_sec`
  is `ticket_ttl_sec`, renewed by every poll; a ticket unpolled that long is dropped. `poll_after_ms` is
  `clamp(eta_ms / 10, 2000, 30000) x [0.8, 1.2]`, per response. Position and eta never rise for a ticket.
- **The grant.** `GET /v1/queue/:ticket` on a granted ticket answers `{grant}`: a token (`typ: "g"`, signed with
  `SESSION_KEY`, spec 4.8) naming the ticket and the install, valid `grant_ttl_sec`. Sent back as `grant` on
  `/v1/session` or `/v1/accounts` from the same install, it admits the request and ends the ticket; it stays valid to its
  `exp` for that install (a mistyped password does not cost the place). From another install, or forged, or of another
  env: `QUEUE_TICKET_INVALID`. Expired: the request is queued again at its ticket's place. An unredeemed grant lapses
  and its ticket re-queues at the front.
- **Off** (`enabled: false`) admits everyone at once; every waiting ticket is granted at its next poll or within a
  second, and the bucket is held full for the next time it is switched on.
- `/v1/queue/:ticket` serves both kinds: the admission queue is asked first, then the match registry's lobby wait.
  An unknown, expired or foreign ticket is `QUEUE_TICKET_INVALID` (404). `DELETE` leaves the line.
- In memory, single host: a brain restart empties the line (players re-queue at their next sign-in; a grant already
  issued still verifies). The brain logs `[admission] on` / `off` as the switch flips; never a ticket's grant.

**Tests.** `test/admission.test.js` (the queue itself over an injected clock; no fetch, so it also runs on Node 16),
`test/admission_http.test.js` (the routes, no database) and `test/admission.db.test.js` (a grant redeemed for a
session, against a database built from `migrations/`, with `RJ_TEST_DB`).

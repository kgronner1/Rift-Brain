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
src/match/lobbies.js    game instances and the join queue (in process memory)
src/match/ports.js      which game port is free
src/match/process.js    spawning and killing game server processes
src/storage/            today's storage.js, split by table
src/routes/legacy/      today's routes, unchanged in path and shape; they go at cutover
src/migrate.js          schema migrations (see "Migrations")
test/                   npm test (node --test); pure tests need no database
```

With `ENV` unset the brain behaves exactly as before RJ 462 (port 3000 on every interface, UDP 8080-8085,
the single server binary in /home/ec2-user), so the legacy box keeps its `.env` as it is. A new environment
(`ENV=dev|alpha|prod`) must spell out `PUBLIC_PORT`, `GAME_PORTS` and `SERVER_BINARY`, and binds 127.0.0.1.

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

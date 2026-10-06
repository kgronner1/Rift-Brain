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
test/                   npm test (node --test); pure tests need no database
```

With `ENV` unset the brain behaves exactly as before RJ 462 (port 3000 on every interface, UDP 8080-8085,
the single server binary in /home/ec2-user), so the legacy box keeps its `.env` as it is. A new environment
(`ENV=dev|alpha|prod`) must spell out `PUBLIC_PORT`, `GAME_PORTS` and `SERVER_BINARY`, and binds 127.0.0.1.

`npm test` runs every test. Database tests run only when `RJ_TEST_DB` is set.

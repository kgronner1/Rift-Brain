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

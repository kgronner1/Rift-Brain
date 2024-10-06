# rift-brain

This is a dockerized node server endpoint that will control game lobbies and placement of players who connect to the server.

Players will ping this api, a receive either a port to connect to for the game or a wait code.

Game lobbies will contact the api for health checks and to update game status and player counts.

This api will create and destroy game instances as needed.

TO START DOCKER AND SERVER:

docker build -t rift-brain:1.0 .   
docker run -p 3000:3000 -d rift-brain:1.0

TO START SERVER ONLY:

node ./src/app.js
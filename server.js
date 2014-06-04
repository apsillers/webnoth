var express = require('express')
  , app = express()
  , server = app.listen(8080);
var MongoClient = require('mongodb').MongoClient
  , Server = require('mongodb').Server;
var fs = require('fs');
var io = require('socket.io').listen(server);
var passport = require("passport");
var socketOwnerCanAct = require("./auth").socketOwnerCanAct;
var createUnit = require("./createUnit");
var loadMap = require("./loadUtils").loadMap;
var loadUnitType = require("./loadUtils").loadUnitType;
var initLobbyListeners = require("./lobby").initLobbyListeners;
var Unit = require("./static/shared/unit.js").Unit;
var unitLib = require("./static/shared/unit.js").unitLib;
var executeAttack = require("./executeAttack");
var socketList = [];

var mongoClient = new MongoClient(new Server('localhost', 27017));
mongoClient.open(function(err, mongoClient) {
    var mongo = mongoClient.db("webnoth");

    var collections = {};

    mongo.collection("games", function(err, gamesCollection) {
        mongo.collection("units", function(err, unitsCollection) {
	    mongo.collection("users", function(err, usersCollection) {
		collections.games = gamesCollection;
		collections.units = unitsCollection;
		collections.users = usersCollection;
            });
	});
    });

    require("./auth").initAuth(app, mongo, collections);

    unitLib.init(function() {
	io.sockets.on('connection', function (socket) {
            initListeners(socket, collections);
	});
    });

});

app.use(express.static(__dirname + '/static'));
app.use(express.cookieParser());
app.use(express.bodyParser());

var MongoStore = require('connect-mongo-store')(express);
var mongoStore = new MongoStore('mongodb://localhost:27017/webnoth');
app.use(express.session({store: mongoStore, secret: 'keyboard cat'}));

app.use(passport.initialize());
app.use(passport.session());

mongoStore.on('connect', function() {
    console.log('Store is ready to use')
});

mongoStore.on('error', function(err) {
    console.log('Do not ignore me', err)
});

var passportSocketIo = require("passport.socketio");

function onAuthorizeSuccess(data, accept){
    console.log('successful connection to socket.io');

  // The accept-callback still allows us to decide whether to
  // accept the connection or not.
    accept(null, true);
}

function onAuthorizeFail(data, message, error, accept){
    if(error)
	throw new Error(message);
    console.log('failed connection to socket.io:', message);

  // We use this callback to log all of our failed connections.
    accept(null, true);
}

io.set('authorization', passportSocketIo.authorize({
    cookieParser: express.cookieParser,
    secret:      'keyboard cat',    // the session_secret to parse the cookie
    store:       mongoStore,        // we NEED to use a sessionstore. no memorystore please
    success:     onAuthorizeSuccess,  // *optional* callback on success - read more below
    fail:        onAuthorizeFail,     // *optional* callback on fail/error - read more below
}));

// initialize all socket.io listeners on a socket
function initListeners(socket, collections) {
    initLobbyListeners(socket, collections);

    // request for all game data
    socket.on("alldata", function(data) {
	console.log("serving data to", socket.handshake.user.username);
        var gameId = data.gameId;
	var user = socket.handshake.user;

        collections.units.find({ gameId:gameId }, function(err, cursor) {
            collections.games.findOne({ id:gameId }, function(err, game) {
		var player = game.players.filter(function(p) { return p.username == user.username })[0];
                cursor.toArray(function(err, docs) {
                    socket.emit("initdata", {map: game.map, units: docs, player: player, activeTeam: game.activeTeam, villages:game.villages, timeOfDay: game.timeOfDay });
                });
            });
        });
    });

    // subscribe to a game channel
    socket.on("join game", function(gameId) {
        socket.join("game"+gameId);
	if(socket.handshake.user) {
	    socketList.push({ gameId: gameId, username: socket.handshake.user.username, socket: socket })
	}
    });

    socket.on("disconnect", function() {
	var socketData = socketList.filter(function(o) {
	    return o.socket == socket;
	})[0];
	socketList.splice(socketList.indexOf(socketData), 1);
    });

    // create a new game
    socket.on("new game", function(data) {
	collections.games.find({}, {"id":true}).toArray(function(err, gameList) {  
	    gameList.sort(function(a,b) { return b.id - a.id; });
	    if(gameList[0] == undefined) { gameList[0] = { id: 0 }; }
	    var id = gameList[0].id+1;

	    var gameData = {
		"id" : id,
		"map" : "test_map.map",
		"timeOfDay" : "morning",
		"players" : [
		    { "team": 1, "gold": 40, "username": "hello", "race":"elves" },
		    { "team": 2, "gold": 40, "username": "goodbye", "race":"orcs" }
		],
		"villages": {},
		"activeTeam": 1
	    };
	    
	    loadMap(gameData.map, function(err, mapData) {
		var startPositions = [];
		for(var pos in mapData) {
		    if(mapData[pos].start != undefined) {
			var coords = pos.split(",");
			startPositions[mapData[pos].start] = coords;
		    }

		    if(mapData[pos].terrain.properties.indexOf("village") != -1) {
			gameData.villages[pos] = 0;
		    }
		}
		
		collections.games.insert(gameData, {safe: true}, function(err, item) {    
		    var index = 0;
		    (function addCommander() {
			index++;
			if(index == startPositions.length) { console.log("wow, we made a game"); return; }
			var typeName = index==1?"elven_archer":"grunt";
			var coords = startPositions[index];
			loadUnitType(typeName, function(err, typeObj) {
			    collections.units.insert({
				gameId: id,
				x:+coords[0],
				y:+coords[1],
				team:index,
				type:typeName,
				isCommander:true,
				hp:typeObj.maxHp,
				moveLeft:typeObj.move
			    }, {safe:true}, addCommander)
			});
		    })();
		});
	    });
	});
    });

    // create a new game
    socket.on("launch game", function(data) {
        // data.opponentList
        // 
    });

    // move a unit
    socket.on("move", function(data) {
        var gameId = data.gameId;
        var path = data.path;
	var attackIndex = data.attackIndex;
	var user = socket.handshake.user;

        collections.games.findOne({id:gameId}, function(err, game) {
            loadMap(game.map, function(err, mapData) {
                collections.units.findOne({ x:path[0].x, y:path[0].y, gameId:gameId }, function(err, unit) {

		    // ensure that the logged-in user has the right to move this unit
		    var player = game.players.filter(function(p) { return p.username == user.username })[0];
		    if(!socketOwnerCanAct(socket, game) && player && player.team != unit.team) {
			socket.emit("moved", { path:[path[0]] });
			return;
		    }

		    unit = new Unit(unit);

		    console.log(unit.type, unit.name);

                    collections.units.find({ gameId: gameId }, function(err, cursor) {
                        cursor.toArray(function(err, unitArray) {
			    // make the move
                            var moveResult = require("./executePath")(path, unit, unitArray, mapData);

                            var endPoint = moveResult.path[moveResult.path.length-1];
                            unit.x = endPoint.x;
                            unit.y = endPoint.y;
			    unit.moveLeft -= moveResult.moveCost || 0;

			    // if there is a village here and
			    // if the village is not co-team with the unit, capture it
			    if(mapData[endPoint.x+","+endPoint.y].terrain.properties.indexOf("village") != -1 &&
			       game.villages[endPoint.x+","+endPoint.y] != unit.team) {
				game.villages[endPoint.x+","+endPoint.y] = unit.team;
				moveResult.capture = true;
				unit.moveLeft = 0;
				collections.games.save(game, {safe: true}, concludeMove);
			    } else {
				concludeMove();
			    }
			    
			    function concludeMove() {
                                var emitMove = function() {
				    io.sockets.in("game"+gameId).emit("moved", moveResult);
                                };
				
				// perform the attack
				if(moveResult.attack && !unit.hasAttacked) {
				    var targetCoords = path[path.length-1];
				    collections.units.findOne({ x:targetCoords.x, y:targetCoords.y, gameId:gameId }, function(err, defender) {
					if(defender == null) { emitMove(); }

					unit.hasAttacked = true;
					unit.moveLeft = 0;

					defender = new Unit(defender);
					
					// resolve combat
					moveResult.combat = executeAttack(unit, attackIndex, defender, unitArray, mapData, game);

					collections.games.save(game, { safe: true }, function() {
					    // injure/kill units models
					    var handleDefender = function() {
						if(defender.hp < 0) { collections.units.remove({ _id: defender._id }, emitMove); }
						else { collections.units.save(defender.getStorableObj(), {safe: true}, emitMove); }
					    }
					
					    if(unit.hp < 0) { collections.units.remove({ _id: unit._id}, handleDefender); }
					    else { collections.units.save(unit.getStorableObj(), {safe: true}, handleDefender); }
					});
				    });
				} else {
                                    collections.units.save(unit.getStorableObj(), {safe:true}, emitMove);
				}
			    }
                        });
                    });
                });
            });
        });
    });

    // create a new unit
    socket.on("create", function(data) {
	var gameId = data.gameId;
	var user = socket.handshake.user;

        collections.games.findOne({id:gameId}, function(err, game) {
            loadMap(game.map, function(err, mapData) {
		var player = game.players.filter(function(p) { return p.username == user.username })[0];

		if(socketOwnerCanAct(socket, game)) {
		    createUnit(data, mapData, collections, game, player, function(createResult) {
			io.sockets.in("game"+gameId).emit("created", createResult);
			socket.emit("playerUpdate", { gold: player.gold });
		    });
		} else {
		    socket.emit("created", {});
		}
	    });
	});
    });

    socket.on("levelup", function(data) {
        var gameId = data.gameId;
        var choiceNum = data.choiceNum;
	var user = socket.handshake.user;

        collections.games.findOne({id:gameId}, function(err, game) {
	    // ensure that the logged-in user has the right to act
	    if(!socketOwnerCanAct(socket, game, true)) {
		return;
	    }

	    var player = game.players.filter(function(p) { return p.username == user.username })[0];
	    if(!player || !player.advancingUnit) { return; }

	    var coords = player.advancingUnit.split(",").map(function(i) { return parseInt(i); });
            collections.units.findOne({ x:coords[0], y:coords[1], gameId:gameId }, function(err, unit) {
		unit = new Unit(unit);
		var leveledUnit = unit.levelUp(choiceNum);

		var leveledOwnProps = leveledUnit.getStorableObj();
	        for(var prop in leveledOwnProps) {
		    unit[prop] = leveledOwnProps[prop]; 
		}

		delete player.advancingUnit;

		collections.games.save(game, { safe: true }, function() {
		    collections.units.save(unit.getStorableObj(), { safe: true }, function() {
			io.sockets.in("game"+gameId).emit("leveledup", { x: coords[0], y: coords[1], choiceNum: choiceNum });
		    });
		});
	    });
	});
    });
	    

    socket.on("endTurn", function(data) {
	var gameId = data.gameId;

        collections.games.findOne({id:gameId}, function(err, game) {
	    if(!socketOwnerCanAct(socket, game)) {
		return;
	    }

	    game.activeTeam %= (game.players.length);
	    game.activeTeam++;

	    var villageCount = 0;
	    for(var coords in game.villages) {
		if(game.villages[coords] == game.activeTeam) {
		    villageCount++;
		}
	    }
	    game.players[game.activeTeam - 1].gold += villageCount*2;

	    if(game.activeTeam == 1) {
		var times = ["morning", "afternoon", "dusk", "first watch", "second watch", "dawn"];
		game.timeOfDay = times[(times.indexOf(game.timeOfDay) + 1) % times.length];
	    }

	    collections.games.save(game, { safe: true }, function() {

		// find all units owned by the newly active player
		collections.units.find({ gameId: gameId, team: game.activeTeam }, function(err, unitCursor) { 
		    var updates = [];
		    var sendUpdates = function() {
			io.sockets.in("game"+gameId).emit("newTurn", { activeTeam: game.activeTeam, updates: updates, timeOfDay: game.timeOfDay });

			var activePlayerSocketData = socketList.filter(function(o) {
			    return o.gameId == gameId && o.username == game.players[game.activeTeam-1].username;
			})[0];

			if(activePlayerSocketData) {
			    activePlayerSocketData.socket.emit("playerUpdate", { gold: game.players[game.activeTeam-1].gold });
			}
		    };
		    
		    loadMap(game.map, function(err, mapData) {
			unitCursor.next(function updateUnitForNewTurn(err, unit) {
			    if(unit == null) { sendUpdates(); return; }
			    
			    var update = { x: unit.x, y: unit.y };
			    unit = new Unit(unit);
			    // heal unmoved units
			    if(unit.moveLeft == unit.move && !unit.hasAttacked) {
				unit.hp = Math.min(unit.hp+2, unit.maxHp);
				update.hp = unit.hp;
			    }
				
			    // refill move points
			    unit.moveLeft = unit.move;
			    update.moveLeft = unit.moveLeft;
			    unit.hasAttacked = false;
	
			    // if on a village, heal
			    if(mapData[unit.x+","+unit.y].terrain.properties.indexOf("village") != -1){
				unit.hp = Math.min(unit.hp+8, unit.maxHp);
				update.hp = unit.hp;
				
				// TODO: remove poison
			    }
				    
			    // TODO: if poisoned, hurt
			    // TODO: remove slow
				
			    updates.push(update);
			    
			    collections.units.save(unit.getStorableObj(), {safe:true}, function() {
				unitCursor.next(updateUnitForNewTurn);
			    });
			});
		    });
		});
	    });
	});
    });
};

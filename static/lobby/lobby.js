var socket = io.connect('//' + location.host);
var rooms = {};
var players = [];
var username;

socket.emit("join lobby");

socket.on("lobby data", function(data) {
    rooms = data.rooms;
    renderRoomList();

    players = data.players;
    renderPlayerList();

    username = data.you;
});

socket.on("joined lobby", function(data) {
    players.push(data);
    renderPlayerList();
});

socket.on("left lobby", function(data) {
    players.splice(players.indexOf(data), 1);
    renderPlayerList();
});



socket.on("created room", function(data) {
    rooms[data.id] = data;
    renderRoomList();
});

socket.on("joined room", function(data) {
    rooms[data.room.id] = data.room;
    renderRoomList();
    if(username == data.username) {
	window.location = "/lobby/room.html?id="+data.room.id;
    }
});

function renderPlayerList() {
    players.sort();
    var $playerList = $("#player-list");
    $playerList.html("");
    $.each(players, function(i, p) {
	$playerList.append($("<div>").text(p));
    });
};

function renderRoomList() {
    var $roomList = $("#room-list");
    $roomList.html("");

    $.each(rooms, function(roomId, data) {
	var roomItem = $("<div>");
	roomItem.text(roomId + ": " + data.name + " " + data.filledSlots + "/" + data.totalSlots);
	$roomList.append(roomItem);
	roomItem.click(function() {
	    socket.emit("join room", { id: roomId });
	});
    });
}

$("#create-game").click(function() {
    $("#create-dialog").show();
});
$("#launch-game").click(function() {
    socket.emit("create room", {
	name: $("#create-dialog-name").val(),
	map: $("#create-dialog-map").val()
    });
});
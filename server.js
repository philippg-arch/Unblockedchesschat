const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const playerPoints = new Map();

class RankTier {
  constructor(name, minPoints, maxPoints, color) {
    this.name = name;
    this.minPoints = minPoints;
    this.maxPoints = maxPoints;
    this.color = color;
  }

  matches(points) {
    return points >= this.minPoints && points <= this.maxPoints;
  }
}

class BeginnerTier extends RankTier {
  constructor() { super('Beginner', 0, 499, '#9dd9ff'); }
}

class RookieTier extends RankTier {
  constructor() { super('Rookie', 500, 999, '#7ae582'); }
}

class ExperiencedTier extends RankTier {
  constructor() { super('Experienced', 1000, 1499, '#ffd166'); }
}

class ExpertTier extends RankTier {
  constructor() { super('Expert', 1500, 1999, '#ff9f1c'); }
}

class MasterTier extends RankTier {
  constructor() { super('Master', 2000, 2499, '#f72585'); }
}

class GrandMasterTier extends RankTier {
  constructor() { super('Grand Master', 2500, Number.MAX_SAFE_INTEGER, '#d6a6ff'); }
}

const rankTiers = [
  new BeginnerTier(),
  new RookieTier(),
  new ExperiencedTier(),
  new ExpertTier(),
  new MasterTier(),
  new GrandMasterTier(),
];

function getTierForPoints(points) {
  return rankTiers.find((tier) => tier.matches(points)) || rankTiers[0];
}

function getRatingForPlayer(name) {
  const points = playerPoints.get(name) || 0;
  const tier = getTierForPoints(points);
  return {
    name,
    points,
    tier: tier.name,
    tierColor: tier.color,
  };
}

function getLeaderboard() {
  return [...playerPoints.entries()]
    .map(([name, points]) => ({ name, points }))
    .sort((first, second) => second.points - first.points || first.name.localeCompare(second.name))
    .slice(0, 5);
}

function createRoom(roomName) {
  return {
    name: roomName,
    game: new Chess(),
    players: new Map(),
    gameOver: false,
    winner: null,
  };
}

function publicPlayers(room) {
  return [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    rating: getRatingForPlayer(player.name),
  }));
}

function roomSnapshot(room) {
  return {
    roomName: room.name,
    players: publicPlayers(room),
    fen: room.game.fen(),
    turn: room.game.turn(),
    check: room.game.in_check(),
    gameOver: room.gameOver,
    winner: room.winner,
  };
}

function removePlayerFromRoom(socket) {
  const roomName = socket.data?.roomName;
  if (!roomName) return;

  const room = rooms.get(roomName);
  if (!room) {
    socket.data.roomName = null;
    return;
  }

  room.players.delete(socket.id);
  socket.to(roomName).emit('opponent-left');

  if (room.players.size === 0) {
    rooms.delete(roomName);
  } else {
    io.to(roomName).emit('lobby-update', {
      roomName,
      players: publicPlayers(room),
    });
  }

  socket.data.roomName = null;
}

function awardPoints(room) {
  const players = [...room.players.values()];
  const winnerColor = room.game.turn() === 'w' ? 'b' : 'w';
  const winner = room.game.in_checkmate()
    ? players.find((player) => player.color === winnerColor)
    : null;
  const loser = winner ? players.find((player) => player.color !== winnerColor) : null;

  if (winner) {
    const next = (playerPoints.get(winner.name) || 0) + 30;
    playerPoints.set(winner.name, next);
  }

  if (loser) {
    const next = (playerPoints.get(loser.name) || 0) + 10;
    playerPoints.set(loser.name, next);
  }

  players.forEach((player) => {
    if (!playerPoints.has(player.name)) playerPoints.set(player.name, 0);
  });

  room.winner = winner ? winner.name : null;

  return {
    winner: room.winner,
    ratings: players.map((player) => getRatingForPlayer(player.name)),
  };
}

io.on('connection', (socket) => {
  socket.data = socket.data || {};
  socket.emit('leaderboard-update', getLeaderboard());

  socket.on('join-game', ({ roomName, name } = {}) => {
    const cleanRoomName = String(roomName || '').trim().toUpperCase().slice(0, 20);
    const cleanName = String(name || '').trim().slice(0, 24);

    if (!cleanRoomName || !cleanName) {
      socket.emit('game-error', 'Please enter a room code and your name.');
      return;
    }

    removePlayerFromRoom(socket);

    let room = rooms.get(cleanRoomName);
    if (!room) {
      room = createRoom(cleanRoomName);
      rooms.set(cleanRoomName, room);
    }

    if (room.players.size >= 2) {
      socket.emit('game-error', 'This room is full. Please choose another room code.');
      return;
    }

    const color = room.players.size === 0 ? 'w' : 'b';
    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName,
      color,
      mediaReady: false,
    });

    socket.join(cleanRoomName);
    socket.data.roomName = cleanRoomName;
    socket.data.name = cleanName;
    socket.data.color = color;

    const myRating = getRatingForPlayer(cleanName);

    socket.emit('joined', {
      roomName: cleanRoomName,
      color,
      rating: myRating,
      players: publicPlayers(room),
      state: roomSnapshot(room),
    });

    io.to(cleanRoomName).emit('lobby-update', {
      roomName: cleanRoomName,
      players: publicPlayers(room),
    });

    if ([...room.players.values()].some((player) => player.id !== socket.id && player.mediaReady)) {
      socket.emit('media-ready');
    }

    if (room.players.size === 2) {
      room.game = new Chess();
      room.gameOver = false;
      room.winner = null;
      io.to(cleanRoomName).emit('game-start', {
        roomName: cleanRoomName,
        players: publicPlayers(room),
        state: roomSnapshot(room),
      });
    }
  });

  socket.on('move', ({ from, to, promotion } = {}) => {
    const roomName = socket.data.roomName;
    const room = roomName ? rooms.get(roomName) : null;

    if (!room || room.gameOver) {
      socket.emit('game-error', 'The game is not active.');
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) return;

    if (room.game.turn() !== player.color) {
      socket.emit('game-error', "It's not your turn.");
      return;
    }

    try {
      const move = room.game.move({
        from,
        to,
        promotion: promotion || 'q',
      });

      if (!move) {
        socket.emit('game-error', 'That move is not legal.');
        return;
      }

      const state = {
        roomName,
        fen: room.game.fen(),
        turn: room.game.turn(),
        check: room.game.in_check(),
        checkmate: room.game.in_checkmate(),
        draw: room.game.in_draw(),
        stalemate: room.game.in_stalemate(),
        insufficientMaterial: room.game.insufficient_material(),
        threefoldRepetition: room.game.in_threefold_repetition(),
        lastMove: { from: move.from, to: move.to },
      };

      if (room.game.game_over()) {
        room.gameOver = true;
        const prize = awardPoints(room);
        state.gameOver = true;
        state.winner = room.winner;
        state.ratings = prize.ratings;
        io.emit('leaderboard-update', getLeaderboard());
      }

      io.to(roomName).emit('game-state', state);
    } catch {
      socket.emit('game-error', 'Could not apply that move.');
    }
  });

  socket.on('chat-message', (text) => {
    const roomName = socket.data.roomName;
    if (!roomName || typeof text !== 'string') return;

    const message = text.trim().slice(0, 500);
    if (!message) return;

    io.to(roomName).emit('chat-message', {
      name: socket.data.name,
      text: message,
      timestamp: Date.now(),
    });
  });

  socket.on('signal', ({ to, data } = {}) => {
    if (!to || !data) return;

    const room = socket.data.roomName ? rooms.get(socket.data.roomName) : null;
    if (!room || !room.players.has(to)) return;

    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media-ready', () => {
    const room = socket.data.roomName ? rooms.get(socket.data.roomName) : null;
    const player = room?.players.get(socket.id);
    if (!room || !player) return;

    player.mediaReady = true;
    socket.to(socket.data.roomName).emit('media-ready');
  });

  socket.on('disconnect', () => removePlayerFromRoom(socket));
});

app.use(express.static('public'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Unblocked Chess Chat running on http://${HOST}:${PORT}`);
});

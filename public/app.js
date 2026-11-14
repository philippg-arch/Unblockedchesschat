const socket = io();
const game = new Chess();
const boardElement = document.getElementById('board');
const statusElement = document.getElementById('status');
const ratingElement = document.getElementById('player-rating');
const playersListElement = document.getElementById('players');
const chatLogElement = document.getElementById('chat-log');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

const PIECES = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
};

const rankTiers = [
  { name: 'Beginner', min: 0, max: 499, color: '#9dd9ff' },
  { name: 'Rookie', min: 500, max: 999, color: '#7ae582' },
  { name: 'Experienced', min: 1000, max: 1499, color: '#ffd166' },
  { name: 'Expert', min: 1500, max: 1999, color: '#ff9f1c' },
  { name: 'Master', min: 2000, max: 2499, color: '#f72585' },
  { name: 'Grand Master', min: 2500, max: Number.MAX_SAFE_INTEGER, color: '#d6a6ff' },
];

function getTierForPoints(points) {
  return rankTiers.find((tier) => points >= tier.min && points <= tier.max) || rankTiers[0];
}

function updateRatingChip(points, tierName) {
  const tier = getTierForPoints(points);
  ratingElement.textContent = `${points} points · ${tier.name}`;
  ratingElement.style.border = `1px solid ${tier.color}`;
  ratingElement.style.background = `${tier.color}22`;
  ratingElement.style.color = '#f5f8ff';
  document.getElementById('home-rating').textContent = points.toLocaleString();
  document.getElementById('stats-rating').textContent = points.toLocaleString();
}

let selectedSquare = null;
let legalTargets = [];
let myColor = null;
let myName = '';
let opponentId = null;
let localStream = null;
let peerConnection = null;
let remoteDescriptionSet = false;
let pendingCandidates = [];
let currentRoomName = '';
let currentOpponentName = '';
let selectedMode = 'Rapid';
let lastRecordedGame = '';

const HISTORY_KEY = 'houseOfChess.recentGames';

function readGameHistory() {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) return [];

    const history = JSON.parse(stored);
    if (!Array.isArray(history)) {
      throw new TypeError('Saved game history must be a list.');
    }

    return history.filter((entry) =>
      entry &&
      typeof entry.opponent === 'string' &&
      typeof entry.result === 'string' &&
      typeof entry.room === 'string' &&
      typeof entry.date === 'string'
    );
  } catch (error) {
    console.error('Could not read recent games from this browser.', error);
    return [];
  }
}

function renderGameHistory() {
  const history = readGameHistory();
  const wins = history.filter((entry) => entry.result === 'Win').length;
  const gamesPlayed = history.length;
  const winRate = gamesPlayed ? `${Math.round((wins / gamesPlayed) * 100)}%` : '—';
  const streak = history.findIndex((entry) => entry.result !== 'Win');
  const currentStreak = streak === -1 ? wins : streak;

  document.getElementById('home-games').textContent = gamesPlayed;
  document.getElementById('stats-games').textContent = gamesPlayed;
  document.getElementById('stats-wins').textContent = wins;
  document.getElementById('home-winrate').textContent = winRate;
  document.getElementById('stats-winrate').textContent = winRate;
  document.getElementById('home-streak').textContent = currentStreak;

  [document.getElementById('recent-games'), document.getElementById('stats-recent-games')].forEach((container) => {
    container.replaceChildren();

    if (history.length === 0) {
      const mark = document.createElement('span');
      mark.className = 'empty-mark';
      mark.textContent = '♟';

      const copy = document.createElement('div');
      const title = document.createElement('strong');
      const description = document.createElement('p');
      title.textContent = container.id === 'recent-games'
        ? 'Your story starts here.'
        : 'Every great record begins with a game.';
      description.textContent = container.id === 'recent-games'
        ? 'Finish your first game and it will appear here.'
        : 'Your completed matches will appear here.';
      copy.append(title, description);
      container.append(mark, copy);
      return;
    }

    history.slice(0, 4).forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      const result = document.createElement('span');
      result.className = `history-result ${entry.result.toLowerCase()}`;
      result.textContent = entry.result;
      const opponent = document.createElement('strong');
      opponent.textContent = `vs. ${entry.opponent}`;
      const room = document.createElement('span');
      room.className = 'history-room';
      room.textContent = entry.room;
      const date = document.createElement('time');
      date.className = 'history-date';
      date.dateTime = entry.date;
      date.textContent = new Date(entry.date).toLocaleDateString();
      row.append(result, opponent, room, date);
      container.appendChild(row);
    });
  });
}

function recordCompletedGame(state) {
  const gameKey = `${currentRoomName}:${state.fen}`;
  if (gameKey === lastRecordedGame) return;
  lastRecordedGame = gameKey;

  const history = readGameHistory();
  history.unshift({
    opponent: currentOpponentName || 'Opponent',
    result: !state.winner ? 'Draw' : state.winner === myName ? 'Win' : 'Loss',
    room: currentRoomName || 'Private room',
    date: new Date().toISOString(),
  });

  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('Could not save this game to recent games.', error);
  }

  renderGameHistory();
}

function showView(viewName) {
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.viewPanel === viewName);
  });
  document.querySelectorAll('.nav-link[data-view]').forEach((link) => {
    const active = link.dataset.view === viewName;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  const headings = {
    home: 'OVERVIEW',
    play: 'PLAY',
    tournaments: 'TOURNAMENTS',
    stats: 'YOUR STATS',
    settings: 'SETTINGS',
  };
  document.getElementById('page-heading').textContent = headings[viewName] || headings.home;
  if (viewName === 'play') renderBoard();
}

document.querySelectorAll('.nav-link[data-view]').forEach((link) => {
  link.addEventListener('click', () => showView(link.dataset.view));
});

document.querySelectorAll('[data-open-view]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.openView));
});

document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedMode = button.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((modeButton) => {
      modeButton.classList.toggle('selected', modeButton === button);
      modeButton.setAttribute('aria-pressed', modeButton === button ? 'true' : 'false');
    });
    document.getElementById('selected-mode-label').textContent = `FORMAT · ${selectedMode.toUpperCase()}`;
    showView('play');
  });
});

try {
  const savedPlayerName = localStorage.getItem('houseOfChess.playerName');
  if (savedPlayerName) {
    document.getElementById('player-name').value = savedPlayerName;
    document.getElementById('player-name-settings').value = savedPlayerName;
    document.querySelector('.profile-name').textContent = savedPlayerName.toUpperCase();
  }
} catch (error) {
  console.error('Could not read your saved display name.', error);
}

document.getElementById('player-name-settings').addEventListener('input', (event) => {
  document.getElementById('player-name').value = event.target.value;
});

document.getElementById('save-settings').addEventListener('click', () => {
  const nameInput = document.getElementById('player-name-settings');
  const name = nameInput.value.trim();
  const feedback = document.getElementById('settings-feedback');
  if (!name) {
    feedback.textContent = 'Enter a display name before saving.';
    nameInput.focus();
    return;
  }

  try {
    localStorage.setItem('houseOfChess.playerName', name);
  } catch (error) {
    console.error('Could not save your display name.', error);
    feedback.textContent = 'Your browser could not save this preference.';
    return;
  }

  document.getElementById('player-name').value = name;
  document.querySelector('.profile-name').textContent = name.toUpperCase();
  feedback.textContent = 'Your display name has been saved.';
});

document.getElementById('room-code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('join-room').click();
});

function setStatus(message) {
  statusElement.textContent = message;
}

function renderBoard() {
  boardElement.innerHTML = '';

  const rows = myColor === 'b' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = myColor === 'b' ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'] : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  rows.forEach((rank) => {
    files.forEach((file) => {
      const squareName = `${file}${rank}`;
      const square = document.createElement('div');
      square.className = `square ${(rank + file.charCodeAt(0)) % 2 === 0 ? 'light' : 'dark'}`;
      square.dataset.square = squareName;

      if (selectedSquare === squareName) {
        square.classList.add('selected');
      }

      if (legalTargets.includes(squareName)) {
        square.classList.add('target');
      }

      const piece = game.get(squareName);
      if (piece) {
        const pieceEl = document.createElement('span');
        pieceEl.className = `piece ${piece.color === 'w' ? 'white-piece' : 'black-piece'}`;
        pieceEl.textContent = PIECES[`${piece.color}${piece.type}`];
        square.appendChild(pieceEl);
      }

      square.addEventListener('click', () => handleSquareClick(squareName));
      boardElement.appendChild(square);
    });
  });
}

function handleSquareClick(squareName) {
  if (!myColor || game.turn() !== myColor || game.game_over()) {
    return;
  }

  const clickedPiece = game.get(squareName);

  if (!selectedSquare) {
    if (clickedPiece && clickedPiece.color === myColor) {
      selectedSquare = squareName;
      legalTargets = game.moves({ square: squareName, verbose: true }).map((move) => move.to);
      renderBoard();
    }
    return;
  }

  if (clickedPiece && clickedPiece.color === myColor) {
    selectedSquare = squareName;
    legalTargets = game.moves({ square: squareName, verbose: true }).map((move) => move.to);
    renderBoard();
    return;
  }

  if (legalTargets.includes(squareName)) {
    socket.emit('move', {
      from: selectedSquare,
      to: squareName,
      promotion: 'q',
    });
  }

  selectedSquare = null;
  legalTargets = [];
  renderBoard();
}

function updatePlayers(players) {
  playersListElement.innerHTML = '';

  if (!players || players.length === 0) {
    playersListElement.textContent = 'No players yet';
    return;
  }

  players.forEach((player) => {
    const row = document.createElement('div');
    row.className = 'player-pill';

    const name = document.createElement('strong');
    name.textContent = `${player.name} (${player.color === 'w' ? 'White' : 'Black'})`;

    const rating = document.createElement('span');
    const tier = getTierForPoints(player.rating?.points ?? 0);
    rating.textContent = `${player.rating?.points ?? 0} · ${tier.name}`;
    rating.style.color = tier.color;

    row.append(name, rating);
    playersListElement.appendChild(row);
  });

  const opponent = players.find((player) => player.id !== socket.id);
  opponentId = opponent ? opponent.id : null;
  currentOpponentName = opponent ? opponent.name : '';

  if (myColor === 'w' && opponentId && localStream) {
    startPeerConnection();
  }
}

function appendChatMessage(name, text) {
  const line = document.createElement('div');
  line.className = 'chat-message';
  line.textContent = `${name}: ${text}`;
  chatLogElement.appendChild(line);
  chatLogElement.scrollTop = chatLogElement.scrollHeight;
}

function attachLocalStream() {
  if (!localStream) return;
  localVideo.srcObject = localStream;

  if (peerConnection) {
    localStream.getTracks().forEach((track) => {
      const alreadySent = peerConnection.getSenders().some((sender) => sender.track === track);
      if (!alreadySent) peerConnection.addTrack(track, localStream);
    });
  }
}

function startPeerConnection() {
  if (!opponentId || !localStream) return;

  if (!peerConnection) {
    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    peerConnection.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          to: opponentId,
          data: { type: 'candidate', candidate: event.candidate },
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'failed') {
        setStatus('Video call connection failed.');
      }
    };

    attachLocalStream();
  }

  if (myColor === 'w' && !peerConnection.localDescription) {
    peerConnection.createOffer()
      .then((offer) => peerConnection.setLocalDescription(offer))
      .then(() => {
        socket.emit('signal', {
          to: opponentId,
          data: { type: 'offer', sdp: peerConnection.localDescription },
        });
      })
      .catch((error) => setStatus(`Video setup error: ${error.message}`));
  }
}

async function handlePeerSignal({ from, data }) {
  if (!data) return;
  opponentId = from;

  if (!localStream) return;

  if (!peerConnection) {
    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    peerConnection.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          to: opponentId,
          data: { type: 'candidate', candidate: event.candidate },
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'failed') {
        setStatus('Video call connection failed.');
      }
    };

    attachLocalStream();
  }

  try {
    if (data.type === 'offer') {
      await peerConnection.setRemoteDescription(data.sdp);
      remoteDescriptionSet = true;
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', {
        to: from,
        data: { type: 'answer', sdp: peerConnection.localDescription },
      });
      for (const candidate of pendingCandidates) {
        await peerConnection.addIceCandidate(candidate);
      }
      pendingCandidates = [];
    } else if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(data.sdp);
      remoteDescriptionSet = true;
      for (const candidate of pendingCandidates) {
        await peerConnection.addIceCandidate(candidate);
      }
      pendingCandidates = [];
    } else if (data.type === 'candidate') {
      if (remoteDescriptionSet) {
        await peerConnection.addIceCandidate(data.candidate);
      } else {
        pendingCandidates.push(data.candidate);
      }
    }
  } catch (error) {
    setStatus(`Video signal error: ${error.message}`);
  }
}

async function enableCameraAndMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    attachLocalStream();
    setStatus('Camera and microphone enabled.');
    if (opponentId) {
      startPeerConnection();
    }
  } catch (error) {
    setStatus(`Camera access blocked: ${error.message}`);
  }
}

function toggleMute() {
  if (!localStream) {
    setStatus('Enable camera first to use audio.');
    return;
  }

  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) {
    setStatus('No microphone was found.');
    return;
  }

  audioTrack.enabled = !audioTrack.enabled;
  const button = document.getElementById('mute-toggle');
  button.textContent = audioTrack.enabled ? 'Mute mic' : 'Unmute mic';
}

document.getElementById('join-room').addEventListener('click', () => {
  const playerName = document.getElementById('player-name').value.trim();
  const roomCode = document.getElementById('room-code').value.trim();

  if (!playerName || !roomCode) {
    setStatus('Please enter a name and room code.');
    return;
  }

  myName = playerName;
  socket.emit('join-game', { roomName: roomCode, name: playerName });
});

document.getElementById('camera-toggle').addEventListener('click', enableCameraAndMic);
document.getElementById('mute-toggle').addEventListener('click', toggleMute);

document.getElementById('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('chat-input');

  if (!input.value.trim()) return;

  socket.emit('chat-message', input.value.trim());
  input.value = '';
});

socket.on('joined', ({ roomName, color, rating, players, state }) => {
  myColor = color;
  myName = document.getElementById('player-name').value.trim();
  updateRatingChip(rating.points, rating.tier);
  setStatus(`Joined ${roomName}. Waiting for opponent…`);
  game.load(state.fen);
  renderBoard();
  updatePlayers(players);
});

socket.on('lobby-update', ({ players }) => {
  updatePlayers(players);
});

socket.on('game-start', ({ players, state }) => {
  game.load(state.fen);
  updatePlayers(players);
  renderBoard();
  setStatus(`${myColor === 'w' ? 'White' : 'Black'} to move.`);
});

socket.on('game-state', (state) => {
  game.load(state.fen);
  selectedSquare = null;
  legalTargets = [];
  renderBoard();

  if (state.gameOver) {
    if (state.winner) {
      setStatus(`${state.winner} wins!`);
    } else {
      setStatus('Draw game.');
    }

    if (state.ratings) {
      const myRating = state.ratings.find((entry) => entry.name === myName);
      if (myRating) {
        updateRatingChip(myRating.points, myRating.tier);
      }
    }
    return;
  }

  if (state.check) {
    setStatus('Check!');
  } else if (game.turn() === myColor) {
    setStatus('Your move.');
  } else {
    setStatus('Opponent to move.');
  }
});

socket.on('chat-message', ({ name, text }) => {
  appendChatMessage(name, text);
});

socket.on('opponent-left', () => {
  setStatus('Your opponent left the room.');
  updatePlayers([]);
});

socket.on('game-error', (message) => {
  setStatus(message);
});

socket.on('signal', handlePeerSignal);

socket.on('joined', ({ roomName }) => {
  currentRoomName = roomName;
});

socket.on('game-start', ({ roomName }) => {
  currentRoomName = roomName || currentRoomName;
  lastRecordedGame = '';
});

socket.on('game-state', (state) => {
  if (state.gameOver) recordCompletedGame(state);
});

renderGameHistory();
renderBoard();
setStatus('Waiting for a room.');

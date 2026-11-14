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

renderBoard();
setStatus('Waiting for a room.');

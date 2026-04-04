/**
 * DUGOUT - Voice Chat Extension
 * 
 * Features:
 * - Create/Join voice chat rooms with word-based IDs
 * - WebRTC P2P mesh audio with SimplePeer
 * - Socket.io signaling server connection
 * - Chrome storage for session persistence
 */

// ===================
// CONFIGURATION
// ===================

const CONFIG = {
  SIGNAL_SERVER: 'http://192.168.132.222:3000',
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  MAX_NAME_LENGTH: 15,
  CREATE_LIMIT_TEXT: 'You can create only one dugout per day. Copy & share with friends to join.',
  MIC_SETTINGS_URL: 'chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fiacmlinclegfmidcbmeccbecmjpealeg%2F'
};

// ===================
// STATE
// ===================

let wordlist = [];           // BIP39 wordlist for room ID generation
let currentRoomId = null;    // Current room ID
let userName = null;         // User's display name
let socket = null;           // Socket.io connection
let localStream = null;      // Local microphone stream
let peers = {};              // WebRTC peer connections { peerId: SimplePeer }
let peerNames = {};          // Peer display names { peerId: name }
let isMuted = false;         // Mute state
let previousView = 'mainView'; // For back navigation

// ===================
// UTILITY FUNCTIONS
// ===================

/** Get date key in YYYY-MM-DD format */
function getDayKey(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/** Load BIP39 wordlist for room ID generation */
async function loadWordlist() {
  try {
    const response = await fetch(chrome.runtime.getURL('resources/bip39-wordlist.txt'));
    wordlist = (await response.text()).trim().split('\n');
  } catch (err) {
    console.error('Failed to load wordlist:', err);
  }
}

/** Validate room ID format (word-word-word) */
function isValidRoomId(roomId) {
  const parts = roomId.trim().toLowerCase().split('-');
  return parts.length === 3 && parts.every(p => p.length > 0);
}

// ===================
// SERVER API
// ===================

/**
 * Generate unique room ID by trying random word combinations
 * Server validates uniqueness (7-day cooldown)
 */
async function generateRoomId() {
  if (wordlist.length === 0) return null;

  for (let attempt = 0; attempt < 100; attempt++) {
    const words = Array.from({ length: 3 }, () => 
      wordlist[Math.floor(Math.random() * wordlist.length)]
    );
    const roomId = words.join('-');

    try {
      const res = await fetch(`${CONFIG.SIGNAL_SERVER}/api/dugout/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId })
      });

      if (res.ok) return (await res.json()).roomId;
      if (res.status !== 409) break; // Only retry on conflict
    } catch (err) {
      console.error('Network error:', err);
      return null;
    }
  }
  return null;
}

/**
 * Check if dugout exists on server
 * Returns { exists, expired, invalid }
 */
async function checkDugoutStatus(roomId) {
  try {
    const res = await fetch(`${CONFIG.SIGNAL_SERVER}/api/dugout/check/${encodeURIComponent(roomId)}`);
    return res.ok ? await res.json() : { exists: false, expired: false, invalid: true };
  } catch (err) {
    console.error('Network error:', err);
    return { exists: false, expired: false, invalid: true };
  }
}

// ===================
// UI FUNCTIONS
// ===================

const $ = (id) => document.getElementById(id);

/** Update status indicator in main view */
function updateStatus(text, isActive = false) {
  $('statusText').textContent = text;
  document.querySelector('.status-dot').style.background = isActive ? '#10b981' : '#8b5cf6';
}

/** Switch between views */
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(viewId).classList.remove('hidden');
}

/** Update voice status indicator */
function setVoiceStatus(text, state = 'connecting') {
  $('voiceStatusText').textContent = text;
  const dot = $('voiceDot');
  dot.className = 'voice-dot';
  if (state === 'connected') dot.classList.add('connected');
  if (state === 'error') dot.classList.add('error');
}

/** Render peers list in voice view */
function updatePeersList() {
  const peerIds = Object.keys(peers);
  let html = `<div class="peer-item"><span class="peer-dot"></span><span class="peer-you">${userName} (You)</span></div>`;
  
  peerIds.forEach(id => {
    html += `<div class="peer-item"><span class="peer-dot"></span><span>${peerNames[id] || 'Unknown'}</span></div>`;
  });
  
  $('peersList').innerHTML = html;
}

/** Update mute button appearance */
function updateMuteButton() {
  const btn = $('muteBtn');
  btn.textContent = isMuted ? 'Unmute' : 'Mute';
  btn.classList.toggle('muted', isMuted);
  updatePeersList();
}

/** Show/hide microphone help section */
function showMicHelp() { $('micHelp')?.classList.remove('hidden'); }
function hideMicHelp() { $('micHelp')?.classList.add('hidden'); }

/** Check microphone permission state */
async function getMicPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch { return 'prompt'; }
}

// Error message helpers
function showError(elementId, message) {
  const el = $(elementId);
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideError(elementId) {
  const el = $(elementId);
  el.textContent = '';
  el.classList.add('hidden');
}

// ===================
// WEBRTC FUNCTIONS
// ===================

/**
 * Create WebRTC peer connection
 * @param {string} peerId - Remote peer's socket ID
 * @param {boolean} initiator - Whether we initiate the connection
 */
function createPeer(peerId, initiator) {
  const peer = new SimplePeer({
    initiator,
    trickle: true,
    stream: localStream,
    config: { iceServers: CONFIG.ICE_SERVERS }
  });

  // Send signaling data to remote peer via server
  peer.on('signal', signal => {
    socket.emit('signal', { to: peerId, signal });
  });

  // Handle incoming audio stream
  peer.on('stream', remoteStream => {
    addRemoteAudio(peerId, remoteStream);
    setVoiceStatus('Voice connected', 'connected');
    updatePeersList();
  });

  peer.on('connect', () => setVoiceStatus('Voice connected', 'connected'));
  peer.on('close', () => removePeer(peerId));
  peer.on('error', (err) => {
    console.error(`Peer ${peerId} error:`, err);
    removePeer(peerId);
  });

  peers[peerId] = peer;
  updatePeersList();
  return peer;
}

/** Add audio element for remote peer */
function addRemoteAudio(peerId, stream) {
  const existing = $(`audio-${peerId}`);
  if (existing) existing.remove();

  const audio = document.createElement('audio');
  audio.id = `audio-${peerId}`;
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.playsInline = true;
  $('audioContainer').appendChild(audio);
}

/** Remove peer connection and audio */
function removePeer(peerId) {
  if (peers[peerId]) {
    peers[peerId].destroy();
    delete peers[peerId];
  }
  delete peerNames[peerId];
  $(`audio-${peerId}`)?.remove();
  updatePeersList();
}

// ===================
// VOICE CHAT
// ===================

/** Start voice chat session */
async function startVoiceChat() {
  if (!currentRoomId || !userName) return;

  // Persist session for popup restoration
  chrome.storage.local.set({ activeVoiceSession: true, currentRoomId, userName });

  $('voiceRoomCode').textContent = currentRoomId;
  $('leaveConfirmation')?.classList.add('hidden');
  showView('voiceView');
  setVoiceStatus('Requesting microphone...', 'connecting');
  hideMicHelp();

  // Check mic permission
  if (await getMicPermissionState() === 'denied') {
    setVoiceStatus('Mic blocked', 'error');
    chrome.storage.local.remove(['activeVoiceSession']);
    showMicHelp();
    return;
  }

  // Get microphone access
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setVoiceStatus('Connecting to server...', 'connecting');
    hideMicHelp();
  } catch (err) {
    console.error('Mic error:', err);
    setVoiceStatus('Mic blocked', 'error');
    chrome.storage.local.remove(['activeVoiceSession']);
    showMicHelp();
    return;
  }

  // Connect to signaling server
  try {
    socket = io(CONFIG.SIGNAL_SERVER, { transports: ['websocket', 'polling'] });
  } catch (err) {
    console.error('Socket error:', err);
    setVoiceStatus('Connection failed', 'error');
    chrome.storage.local.remove(['activeVoiceSession']);
    return;
  }

  // Socket event handlers
  socket.on('connect', () => {
    setVoiceStatus('Joining room...', 'connecting');
    socket.emit('join', { room: currentRoomId, name: userName });
  });

  socket.on('room-joined', ({ peers: existingPeers }) => {
    const total = existingPeers.length + 1;
    setVoiceStatus(`In dugout ${total} player${total === 1 ? '' : 's'}`, 'connected');
    chrome.storage.local.set({ activeVoiceSession: true });

    existingPeers.forEach(({ id, name }) => {
      peerNames[id] = name;
      createPeer(id, true);
    });
    updatePeersList();
  });

  socket.on('user-joined', ({ id, name }) => {
    peerNames[id] = name;
    updatePeersList();
  });

  socket.on('signal', ({ from, signal }) => {
    if (!peers[from]) createPeer(from, false);
    peers[from]?.signal(signal);
  });

  socket.on('user-left', peerId => {
    removePeer(peerId);
    const count = Object.keys(peers).length + 1;
    setVoiceStatus(`In dugout ${count} player${count === 1 ? '' : 's'}`, 'connected');
  });

  socket.on('connect_error', () => {
    setVoiceStatus('Connection failed', 'error');
    chrome.storage.local.remove(['activeVoiceSession']);
  });

  socket.on('disconnect', () => {
    setVoiceStatus('Disconnected', 'error');
    chrome.storage.local.remove(['activeVoiceSession']);
  });
}

/** Leave voice chat and cleanup */
function leaveVoiceChat() {
  // Destroy all peer connections
  Object.keys(peers).forEach(removePeer);

  // Stop microphone
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  // Disconnect socket
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  // Reset state
  isMuted = false;
  peerNames = {};
  currentRoomId = null;

  $('leaveConfirmation')?.classList.add('hidden');
  hideMicHelp();
  chrome.storage.local.remove(['activeVoiceSession', 'currentRoomId']);

  updateStatus('Ready', false);
  showView('mainView');
}

/** Toggle microphone mute */
function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  updateMuteButton();
}

// ===================
// INITIALIZATION
// ===================

document.addEventListener('DOMContentLoaded', async function() {
  await loadWordlist();

  // DOM element references
  const elements = {
    createRoomBtn: $('createRoomBtn'),
    joinRoomBtn: $('joinRoomBtn'),
    copyRoomBtn: $('copyRoomBtn'),
    backFromCreateBtn: $('backFromCreateBtn'),
    backFromJoinBtn: $('backFromJoinBtn'),
    confirmJoinBtn: $('confirmJoinBtn'),
    generatedRoomId: $('generatedRoomId'),
    createLimitMessage: $('createLimitMessage'),
    joinRoomInput: $('joinRoomInput'),
    startVoiceFromCreateBtn: $('startVoiceFromCreateBtn'),
    muteBtn: $('muteBtn'),
    leaveVoiceBtn: $('leaveVoiceBtn'),
    leaveConfirmation: $('leaveConfirmation'),
    confirmLeaveYes: $('confirmLeaveYes'),
    confirmLeaveNo: $('confirmLeaveNo'),
    enableMicBtn: $('enableMicBtn'),
    nameInput: $('nameInput'),
    confirmNameBtn: $('confirmNameBtn'),
    backFromNameBtn: $('backFromNameBtn')
  };

  // Load saved username
  chrome.storage.local.get(['userName'], ({ userName: saved }) => {
    if (saved) {
      userName = saved;
      elements.nameInput.value = saved;
    }
  });

  // --- CREATE ROOM ---
  elements.createRoomBtn.addEventListener('click', async () => {
    chrome.storage.local.get(['createdDugoutId', 'createdDugoutDayKey'], async (result) => {
      const todayKey = getDayKey();

      // Check if user already created a dugout today
      if (result.createdDugoutId && result.createdDugoutDayKey === todayKey) {
        currentRoomId = result.createdDugoutId;
        elements.generatedRoomId.textContent = result.createdDugoutId;
        elements.createLimitMessage.textContent = CONFIG.CREATE_LIMIT_TEXT;
        elements.createLimitMessage.classList.remove('hidden');
        updateStatus('in dugout', true);
        showView('createView');
        return;
      }

      // Generate new room ID
      currentRoomId = await generateRoomId();
      if (!currentRoomId) {
        alert('Failed to create dugout. Please try again.');
        return;
      }

      elements.createLimitMessage.classList.add('hidden');
      chrome.storage.local.set({
        currentRoomId,
        createdDugoutId: currentRoomId,
        createdDugoutDayKey: todayKey
      });
      elements.generatedRoomId.textContent = currentRoomId;
      updateStatus('dugout created', true);
      showView('createView');
    });
  });

  // --- JOIN ROOM ---
  elements.joinRoomBtn.addEventListener('click', () => {
    elements.joinRoomInput.value = '';
    hideError('joinErrorMessage');
    showView('joinView');
    elements.joinRoomInput.focus();
  });

  elements.confirmJoinBtn.addEventListener('click', async () => {
    const raw = elements.joinRoomInput.value.trim();
    if (!raw) {
      showError('joinErrorMessage', 'Enter dugout code');
      return;
    }

    const roomId = raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '');
    if (!isValidRoomId(roomId)) {
      showError('joinErrorMessage', 'Invalid format. Use: word-word-word');
      return;
    }

    const status = await checkDugoutStatus(roomId);
    if (status.exists) {
      hideError('joinErrorMessage');
      currentRoomId = roomId;
      chrome.storage.local.set({ currentRoomId: roomId });
      updateStatus('dugout joined', true);
      previousView = 'joinView';
      showView('nameView');
      elements.nameInput.focus();
    } else if (status.expired) {
      showError('joinErrorMessage', 'Oops! dugout expired');
    } else {
      showError('joinErrorMessage', 'Oops! invalid dugout');
    }
  });

  // Auto-format join input: lowercase, spaces → hyphens, only letters/hyphens
  elements.joinRoomInput.addEventListener('input', function() {
    hideError('joinErrorMessage');
    this.value = this.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '').replace(/--+/g, '-');
  });

  elements.joinRoomInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') elements.confirmJoinBtn.click();
  });

  // --- COPY ROOM CODE ---
  elements.copyRoomBtn.addEventListener('click', async () => {
    if (!currentRoomId) return;
    try {
      await navigator.clipboard.writeText(currentRoomId);
      elements.copyRoomBtn.textContent = 'Copied';
      setTimeout(() => { elements.copyRoomBtn.textContent = 'Copy'; }, 1200);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });

  // --- NAME INPUT ---
  elements.startVoiceFromCreateBtn.addEventListener('click', () => {
    hideError('nameErrorMessage');
    previousView = 'createView';
    showView('nameView');
    elements.nameInput.focus();
  });

  elements.confirmNameBtn.addEventListener('click', () => {
    const name = elements.nameInput.value.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (!name) {
      showError('nameErrorMessage', 'Please enter your name (only letters)');
      return;
    }
    userName = name.substring(0, CONFIG.MAX_NAME_LENGTH);
    hideError('nameErrorMessage');
    chrome.storage.local.set({ userName });
    startVoiceChat();
  });

  elements.nameInput.addEventListener('input', function() {
    hideError('nameErrorMessage');
    this.value = this.value.toLowerCase().replace(/[^a-z]/g, '');
  });

  elements.nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') elements.confirmNameBtn.click();
  });

  // --- NAVIGATION ---
  elements.backFromCreateBtn.addEventListener('click', () => showView('mainView'));
  elements.backFromJoinBtn.addEventListener('click', () => {
    hideError('joinErrorMessage');
    showView('mainView');
  });
  elements.backFromNameBtn.addEventListener('click', () => {
    hideError('nameErrorMessage');
    showView(previousView);
  });

  // --- VOICE CONTROLS ---
  elements.muteBtn.addEventListener('click', toggleMute);

  elements.leaveVoiceBtn.addEventListener('click', () => {
    elements.leaveConfirmation.classList.remove('hidden');
  });

  elements.confirmLeaveYes.addEventListener('click', () => {
    elements.leaveConfirmation.classList.add('hidden');
    leaveVoiceChat();
  });

  elements.confirmLeaveNo.addEventListener('click', () => {
    elements.leaveConfirmation.classList.add('hidden');
  });

  elements.enableMicBtn.addEventListener('click', () => {
    chrome.tabs?.create?.({ url: CONFIG.MIC_SETTINGS_URL }) || 
    window.open(CONFIG.MIC_SETTINGS_URL, '_blank');
  });

  // --- RESTORE SESSION ---
  chrome.storage.local.get(
    ['activeVoiceSession', 'currentRoomId', 'userName', 'createdDugoutId', 'createdDugoutDayKey'],
    (result) => {
      const todayKey = getDayKey();

      // Restore active voice session
      if (result.activeVoiceSession && result.currentRoomId && result.userName) {
        currentRoomId = result.currentRoomId;
        userName = result.userName;
        elements.nameInput.value = userName;
        startVoiceChat();
        return;
      }

      // Auto-rejoin if user created dugout today
      if (result.currentRoomId && result.userName &&
          result.createdDugoutId === result.currentRoomId &&
          result.createdDugoutDayKey === todayKey) {
        currentRoomId = result.currentRoomId;
        userName = result.userName;
        elements.nameInput.value = userName;
        startVoiceChat();
        return;
      }

      // Show current room status
      if (result.currentRoomId) {
        currentRoomId = result.currentRoomId;
        updateStatus('in dugout', true);
        return;
      }

      // Check if on Hotstar
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab?.url?.includes('hotstar.com')) {
          updateStatus('On Hotstar', true);
        }
      });
    }
  );
});

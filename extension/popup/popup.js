let wordlist = [];
let currentRoomId = null;
const CREATE_LIMIT_TEXT = 'You can create only one dugout in 24 hours. Copy & share it with your friends to join.';

function getDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Load wordlist on startup
async function loadWordlist() {
  try {
    const response = await fetch(chrome.runtime.getURL('resources/bip39-wordlist.txt'));
    const text = await response.text();
    wordlist = text.trim().split('\n');
  } catch (error) {
    console.error('Error loading wordlist:', error);
  }
}

// Generate random room ID from 3 words
function generateRoomId() {
  if (wordlist.length === 0) return 'error-loading-wordlist';
  
  const word1 = wordlist[Math.floor(Math.random() * wordlist.length)];
  const word2 = wordlist[Math.floor(Math.random() * wordlist.length)];
  const word3 = wordlist[Math.floor(Math.random() * wordlist.length)];
  
  return `${word1}-${word2}-${word3}`;
}

function isValidRoomId(roomId) {
  const cleaned = roomId.trim().toLowerCase();
  const parts = cleaned.split('-');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

// Update status
function updateStatus(text, isActive = false) {
  document.getElementById('statusText').textContent = text;
  const dot = document.querySelector('.status-dot');
  dot.style.background = isActive ? '#10b981' : '#8b5cf6';
}

function showView(viewId) {
  const views = document.querySelectorAll('.view');
  views.forEach((view) => view.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', async function() {
  // Load wordlist first
  await loadWordlist();

  const createRoomBtn = document.getElementById('createRoomBtn');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const copyRoomBtn = document.getElementById('copyRoomBtn');
  const backFromCreateBtn = document.getElementById('backFromCreateBtn');
  const backFromJoinBtn = document.getElementById('backFromJoinBtn');
  const confirmJoinBtn = document.getElementById('confirmJoinBtn');
  const generatedRoomId = document.getElementById('generatedRoomId');
  const createLimitMessage = document.getElementById('createLimitMessage');
  const joinRoomInput = document.getElementById('joinRoomInput');
  
  // Button handlers
  createRoomBtn.addEventListener('click', function() {
    chrome.storage.local.get(['createdDugoutId', 'createdDugoutDayKey'], function(result) {
      const todayKey = getDayKey();
      const existingDugoutId = result.createdDugoutId;
      const createdDayKey = result.createdDugoutDayKey;

      if (existingDugoutId && createdDayKey === todayKey) {
        currentRoomId = existingDugoutId;
        generatedRoomId.textContent = existingDugoutId;
        createLimitMessage.textContent = CREATE_LIMIT_TEXT;
        createLimitMessage.classList.remove('hidden');
        updateStatus('in dugout', true);
        showView('createView');
        return;
      }

      currentRoomId = generateRoomId();
      createLimitMessage.textContent = '';
      createLimitMessage.classList.add('hidden');
      chrome.storage.local.set({
        currentRoomId: currentRoomId,
        createdDugoutId: currentRoomId,
        createdDugoutDayKey: todayKey,
      });
      generatedRoomId.textContent = currentRoomId;
      updateStatus('dugout created', true);
      showView('createView');
    });
  });
  
  joinRoomBtn.addEventListener('click', function() {
    joinRoomInput.value = '';
    showView('joinView');
    joinRoomInput.focus();
  });

  copyRoomBtn.addEventListener('click', async function() {
    if (!currentRoomId) return;

    try {
      await navigator.clipboard.writeText(currentRoomId);
      copyRoomBtn.textContent = 'Copied';
      setTimeout(() => {
        copyRoomBtn.textContent = 'Copy';
      }, 1200);
    } catch (error) {
      console.error('Copy failed:', error);
    }
  });

  backFromCreateBtn.addEventListener('click', function() {
    showView('mainView');
  });

  backFromJoinBtn.addEventListener('click', function() {
    showView('mainView');
  });

  confirmJoinBtn.addEventListener('click', function() {
    const roomId = joinRoomInput.value;
    if (!roomId) return;

    const cleanedRoomId = roomId.trim().toLowerCase();

    if (isValidRoomId(cleanedRoomId)) {
      currentRoomId = cleanedRoomId;
      chrome.storage.local.set({ currentRoomId: cleanedRoomId });
      updateStatus('dugout joined', true);
      showView('mainView');
    } else {
      window.alert('Invalid room ID format. Use: word-word-word');
    }
  });

  joinRoomInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      confirmJoinBtn.click();
    }
  });
  
  // Check if user already has a room
  chrome.storage.local.get(['currentRoomId'], function(result) {
    if (result.currentRoomId) {
      currentRoomId = result.currentRoomId;
      updateStatus('in dugout', true);
      return;
    }

    // Check if we're on Hotstar
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        const url = tabs[0].url;
        if (url && url.includes('hotstar.com')) {
          updateStatus('On Hotstar', true);
        }
      }
    });
  });
});

/**
 * DUGOUT - WebRTC Signaling Server
 * 
 * Handles:
 * - Room creation/validation via REST API
 * - WebSocket signaling for WebRTC peer connections
 * - Persistent storage of daily & 7-day room IDs
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ===================
// DATABASE MANAGEMENT
// ===================

const dbDir = path.join(__dirname, 'databases');
const dailyDugoutsFile = path.join(dbDir, 'daily-dugouts.json');
const usedRoomIdsFile = path.join(dbDir, 'used-room-ids.json');

// Ensure database directory exists
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

/**
 * Load database from JSON file into Map
 * @param {string} filePath - Path to JSON file
 * @returns {Map} - Loaded data as Map
 */
function loadDatabase(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return new Map(Object.entries(JSON.parse(data)));
    }
  } catch (err) {
    console.error(`Error loading ${filePath}:`, err.message);
  }
  return new Map();
}

/**
 * Save Map to JSON file
 * @param {Map} map - Data to save
 * @param {string} filePath - Target file path
 */
function saveDatabase(map, filePath) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch (err) {
    console.error(`Error saving ${filePath}:`, err.message);
  }
}

// In-memory databases
const dailyDugouts = loadDatabase(dailyDugoutsFile); // Active dugouts today (expire at midnight)
const usedRoomIds = loadDatabase(usedRoomIdsFile);   // All dugouts (expire after 7 days)
let currentDayKey = getDayKey();

/** Get date key in YYYY-MM-DD format */
function getDayKey(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/** Remove room IDs older than 7 days */
function cleanupExpiredRoomIds() {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const [roomId, timestamp] of usedRoomIds.entries()) {
    if (now - timestamp >= sevenDays) {
      usedRoomIds.delete(roomId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired room IDs`);
    saveDatabase(usedRoomIds, usedRoomIdsFile);
  }
}

/** Clear daily dugouts at midnight */
function cleanupDailyDugouts() {
  const todayKey = getDayKey();
  if (todayKey !== currentDayKey) {
    dailyDugouts.clear();
    currentDayKey = todayKey;
    console.log(`🧹 Cleared daily dugouts (new day: ${todayKey})`);
    saveDatabase(dailyDugouts, dailyDugoutsFile);
  }
}

/** Check if room ID is available (not used in last 7 days) */
function isRoomIdAvailable(roomId) {
  if (!usedRoomIds.has(roomId)) return true;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - usedRoomIds.get(roomId) >= sevenDays;
}

/** Store dugout in both databases */
function storeDugout(roomId) {
  const now = Date.now();
  dailyDugouts.set(roomId, now);
  usedRoomIds.set(roomId, now);
  saveDatabase(dailyDugouts, dailyDugoutsFile);
  saveDatabase(usedRoomIds, usedRoomIdsFile);
}

// Run cleanup on startup and hourly
cleanupExpiredRoomIds();
cleanupDailyDugouts();
setInterval(() => {
  cleanupExpiredRoomIds();
  cleanupDailyDugouts();
}, 60 * 60 * 1000);

// =============
// REST API
// =============

// Health check
app.get('/', (req, res) => res.send('Dugout Server Running'));

// Check if dugout exists
app.get('/api/dugout/check/:roomId', (req, res) => {
  const roomId = req.params.roomId.toLowerCase().trim();
  const inDaily = dailyDugouts.has(roomId);
  const inSevenDay = usedRoomIds.has(roomId);

  res.json({
    exists: inDaily,           // Active today
    expired: !inDaily && inSevenDay,  // Was active but expired
    invalid: !inDaily && !inSevenDay  // Never existed
  });
});

// Create new dugout
app.post('/api/dugout/create', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ error: 'Room ID required' });

  const cleanedRoomId = roomId.toLowerCase().trim();
  if (!isRoomIdAvailable(cleanedRoomId)) {
    return res.status(409).json({ error: 'Room ID already in use' });
  }

  storeDugout(cleanedRoomId);
  res.json({ success: true, roomId: cleanedRoomId });
});

// Server stats (for debugging)
app.get('/api/stats', (req, res) => {
  res.json({
    dailyDugouts: dailyDugouts.size,
    usedRoomIds: usedRoomIds.size,
    activeRooms: rooms.size
  });
});

// ===================
// WEBSOCKET SIGNALING
// ===================

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rooms = new Map(); // Track rooms and their members

io.on('connection', (socket) => {
  let userRoom = null;
  let userName = null;

  // Join room
  socket.on('join', ({ room, name }) => {
    userRoom = room;
    userName = name || 'Anonymous';
    const existingPeers = rooms.get(room) || [];

    socket.join(room);
    rooms.set(room, [...existingPeers, { id: socket.id, name: userName }]);

    // Notify new user of existing peers
    socket.emit('room-joined', { room, peers: existingPeers });
    // Notify existing peers of new user
    socket.to(room).emit('user-joined', { id: socket.id, name: userName });

    console.log(`👤 ${userName} joined ${room} (${existingPeers.length + 1} users)`);
  });

  // Relay WebRTC signaling data
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { signal, from: socket.id });
  });

  // Handle disconnect
  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (room === socket.id) continue;

      socket.to(room).emit('user-left', socket.id);
      const roomUsers = rooms.get(room) || [];
      const updated = roomUsers.filter(u => u.id !== socket.id);
      updated.length > 0 ? rooms.set(room, updated) : rooms.delete(room);

      console.log(`👋 ${userName || 'User'} left ${room} (${updated.length} users)`);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
const ENABLE_NGROK = process.env.ENABLE_NGROK === 'true';

// Get local IP address for display
function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// Store public URL for API access
let publicUrl = null;

// API endpoint to get the current server URL
app.get('/api/server-url', (req, res) => {
  res.json({
    local: `http://${getLocalIP()}:${PORT}`,
    public: publicUrl
  });
});

async function startServer() {
  server.listen(PORT, '0.0.0.0', async () => {
    const localIP = getLocalIP();
    console.log(`\n🏏 Dugout Server running on port ${PORT}`);
    console.log(`📡 Local:   http://localhost:${PORT}`);
    console.log(`📡 Network: http://${localIP}:${PORT}`);

    if (ENABLE_NGROK) {
      try {
        // Try to load auth token from config.json first, then environment variable
        let authToken = process.env.NGROK_AUTHTOKEN;
        
        if (!authToken) {
          try {
            const configPath = path.join(__dirname, 'config.json');
            if (fs.existsSync(configPath)) {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              authToken = config.ngrokAuthToken;
              if (authToken === 'PASTE_YOUR_NGROK_TOKEN_HERE') {
                authToken = null;
              }
            }
          } catch (configErr) {
            console.log('   Could not read config.json');
          }
        }
        
        if (!authToken) {
          throw new Error('No auth token found. Please edit config.json or set NGROK_AUTHTOKEN environment variable');
        }
        
        const ngrok = require('@ngrok/ngrok');
        
        // Connect ngrok to the local server
        const listener = await ngrok.forward({
          addr: PORT,
          authtoken: authToken
        });
        
        publicUrl = listener.url();
        console.log(`\n🌐 PUBLIC URL: ${publicUrl}`);
        console.log(`   Share this URL with anyone to join from anywhere!`);
        console.log(`\n📋 Update extension's CONFIG.SIGNAL_SERVER to:`);
        console.log(`   '${publicUrl}'`);
      } catch (err) {
        console.error('\n❌ ngrok failed:', err.message);
        console.log('\n📝 To fix this:');
        console.log(`   1. Sign up at https://ngrok.com (free)`);
        console.log(`   2. Get your auth token from: https://dashboard.ngrok.com/get-started/your-authtoken`);
        console.log(`   3. Edit config.json and paste your token`);
        console.log(`   4. Restart the server`);
      }
    } else {
      console.log(`\n⚠️  Other devices must use: ${localIP}:${PORT}`);
      console.log(`   Make sure all devices are on the SAME WiFi network!`);
      console.log(`\n💡 To enable PUBLIC access (any network):`);
      console.log(`   1. Sign up at https://ngrok.com (free)`);
      console.log(`   2. Get your auth token from dashboard`);
      console.log(`   3. Edit config.json and paste your token`);
      console.log(`   4. Run: npm run start:public`);
    }
    console.log('');
  });
}

startServer();

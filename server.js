const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ 
    host: '0.0.0.0',
    port: PORT 
});

// rooms = { room_id: { clients: Set(ws), seats: Array(10), chat: Array, hostId: string } }
const rooms = new Map();

const MAX_SEATS = 10;
const MAX_CHAT = 200;

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            clients: new Set(),
            seats: new Array(MAX_SEATS).fill(null),
            chat: [],
            hostId: null,
            bannedCommenters: new Set(),
            mutedUsers: new Set(),
            lockedSeats: new Set(),
            selfMutedUsers: new Set(),
            // Real-time media state for catch-up when new users join
            mediaState: {
                url: null,
                position: 0,
                isPlaying: false,
                updatedAt: Date.now(),
            },
        });
    }
    return rooms.get(roomId);
}

wss.on('connection', (ws) => {
    ws.id = crypto.randomUUID();
    ws.rooms = new Set();
    ws.userId = null;
    ws.userInfo = null; // { user_id, username, name, profile_pic }
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });
    
    console.log(`[CONNECTED] Client ${ws.id}`);

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (error) {
            console.error(`[ERROR] Invalid JSON from ${ws.id}`, error.message);
            return;
        }

        const { event, room_id, user_id, data, timestamp } = parsedMessage;

        if (!event || !room_id || !user_id) {
            console.error(`[ERROR] Missing required properties in message from ${ws.id}`);
            return;
        }

        ws.userId = user_id;
        if (data && data.user_info) {
            ws.userInfo = data.user_info;
        }
        // Skip high-frequency heartbeat events to keep logs readable
        if (event !== 'POSITION_SYNC') {
            console.log(`[EVENT] ${event} from ${user_id} in room ${room_id}`);
        }

        switch (event) {
            case 'JOIN_ROOM':
                joinRoom(ws, room_id, user_id, data);
                break;
            case 'LEAVE_ROOM':
                leaveRoom(ws, room_id, user_id);
                break;
            case 'PLAY':
                handlePlay(ws, room_id, user_id, data, parsedMessage);
                break;
            case 'PAUSE':
                handlePause(ws, room_id, user_id, data, parsedMessage);
                break;
            case 'SEEK':
                handleSeek(ws, room_id, user_id, data, parsedMessage);
                break;
            case 'CHANGE_MEDIA':
                handleChangeMedia(ws, room_id, user_id, data, parsedMessage);
                break;
            case 'POSITION_SYNC':
                handlePositionSync(ws, room_id, user_id, data);
                break;
            case 'TAKE_SEAT':
                handleTakeSeat(ws, room_id, user_id, data);
                break;
            case 'LEAVE_SEAT':
                handleLeaveSeat(ws, room_id, user_id, data);
                break;
            case 'ROOM_CHAT':
                handleChat(ws, room_id, user_id, data);
                break;
            case 'HOST_KICK':
                handleHostKick(ws, room_id, user_id, data);
                break;
            case 'HOST_MUTE':
                handleHostMute(ws, room_id, user_id, data);
                break;
            case 'HOST_UNMUTE':
                handleHostUnmute(ws, room_id, user_id, data);
                break;
            case 'HOST_BAN_COMMENT':
                handleHostBanComment(ws, room_id, user_id, data);
                break;
            case 'HOST_UNBAN_COMMENT':
                handleHostUnbanComment(ws, room_id, user_id, data);
                break;
            case 'LOCK_SEAT':
                handleLockSeat(ws, room_id, user_id, data);
                break;
            case 'UNLOCK_SEAT':
                handleUnlockSeat(ws, room_id, user_id, data);
                break;
            case 'SELF_MUTE':
                handleSelfMute(ws, room_id, user_id, data);
                break;
            case 'SELF_UNMUTE':
                handleSelfUnmute(ws, room_id, user_id, data);
                break;
            case 'WEBRTC_SIGNAL':
                handleWebRtcSignal(ws, room_id, user_id, data);
                break;
            default:
                console.warn(`[WARNING] Unknown event: ${event}`);
                break;
        }
    });

    ws.on('close', () => {
        console.log(`[DISCONNECT] Client ${ws.id} (${ws.userId || 'Unknown User'}) disconnected`);
        handleDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error(`[ERROR] WebSocket error for ${ws.id}:`, error.message);
    });
});

function joinRoom(ws, roomId, userId, data) {
    const room = getOrCreateRoom(roomId);
    room.clients.add(ws);
    ws.rooms.add(roomId);

    const userInfo = data?.user_info || { user_id: userId };

    // If this is the room owner (roomId matches userId), they are the host
    const isHost = (roomId === userId);
    if (isHost && !room.hostId) {
        room.hostId = userId;
        // Auto-assign host to seat 0
        if (room.seats[0] === null) {
            room.seats[0] = userInfo;
        }
    }

    // Send ROOM_STATE to the joining client (full state sync including current media)
    const now = Date.now();
    const stateMsg = {
        event: 'ROOM_STATE',
        room_id: roomId,
        user_id: userId,
        data: {
            seats: room.seats,
            chat: room.chat.slice(-50),
            host_id: room.hostId,
            muted_users: Array.from(room.mutedUsers),
            banned_commenters: Array.from(room.bannedCommenters),
            locked_seats: Array.from(room.lockedSeats),
            self_muted_users: Array.from(room.selfMutedUsers),
            // Include current media state so joining viewers can catch up
            media_state: {
                url: room.mediaState.url,
                position: room.mediaState.position,
                is_playing: room.mediaState.isPlaying,
                server_ts: room.mediaState.updatedAt,
            },
        },
        timestamp: now
    };
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(stateMsg));
    }

    // Broadcast USER_JOINED to others
    broadcastToRoom(roomId, {
        event: 'USER_JOINED',
        room_id: roomId,
        user_id: userId,
        data: { user_info: userInfo },
        timestamp: Date.now()
    }, ws);
}

function leaveRoom(ws, roomId, userId) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    room.clients.delete(ws);
    ws.rooms.delete(roomId);

    // Remove from any seat
    for (let i = 0; i < room.seats.length; i++) {
        if (room.seats[i] && room.seats[i].user_id === userId) {
            room.seats[i] = null;
        }
    }

    if (room.clients.size === 0) {
        // Clear room entirely when empty
        rooms.delete(roomId);
    } else {
        // Broadcast seat update + user left
        broadcastToRoom(roomId, {
            event: 'USER_LEFT',
            room_id: roomId,
            user_id: userId,
            data: {
                seats: room.seats,
                locked_seats: Array.from(room.lockedSeats),
                self_muted_users: Array.from(room.selfMutedUsers),
            },
            timestamp: Date.now()
        }, ws);
    }
}

function handleTakeSeat(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const seatIndex = data?.seat_index;
    if (typeof seatIndex !== 'number' || seatIndex < 0 || seatIndex >= MAX_SEATS) return;

    // Check if seat is occupied
    if (room.seats[seatIndex] !== null) return;

    // Locked seats can only be taken by the host
    if (room.lockedSeats.has(seatIndex) && room.hostId !== userId) return;

    // Remove user from any current seat
    for (let i = 0; i < room.seats.length; i++) {
        if (room.seats[i] && room.seats[i].user_id === userId) {
            room.seats[i] = null;
        }
    }

    const userInfo = data?.user_info || ws.userInfo || { user_id: userId };
    room.seats[seatIndex] = userInfo;

    broadcastToAll(roomId, {
        event: 'SEAT_UPDATE',
        room_id: roomId,
        user_id: userId,
        data: {
            seats: room.seats,
            locked_seats: Array.from(room.lockedSeats),
            self_muted_users: Array.from(room.selfMutedUsers),
        },
        timestamp: Date.now()
    });
}

function handleLeaveSeat(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    for (let i = 0; i < room.seats.length; i++) {
        if (room.seats[i] && room.seats[i].user_id === userId) {
            room.seats[i] = null;
        }
    }

    broadcastToAll(roomId, {
        event: 'SEAT_UPDATE',
        room_id: roomId,
        user_id: userId,
        data: {
            seats: room.seats,
            locked_seats: Array.from(room.lockedSeats),
            self_muted_users: Array.from(room.selfMutedUsers),
        },
        timestamp: Date.now()
    });
}

function handleChat(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    // Check if banned
    if (room.bannedCommenters.has(userId)) return;

    const msg = {
        user_id: userId,
        username: data?.username || '',
        name: data?.name || '',
        profile_pic: data?.profile_pic || null,
        message: (data?.message || '').substring(0, 500), // limit length
        timestamp: Date.now(),
    };

    room.chat.push(msg);
    if (room.chat.length > MAX_CHAT) {
        room.chat.shift();
    }

    broadcastToAll(roomId, {
        event: 'ROOM_CHAT',
        room_id: roomId,
        user_id: userId,
        data: msg,
        timestamp: Date.now()
    });
}

function handleHostKick(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return; // only host can kick

    const targetUserId = data?.target_user_id;
    if (!targetUserId || targetUserId === userId) return;

    // Remove from seat
    for (let i = 0; i < room.seats.length; i++) {
        if (room.seats[i] && room.seats[i].user_id === targetUserId) {
            room.seats[i] = null;
        }
    }

    broadcastToAll(roomId, {
        event: 'HOST_KICK',
        room_id: roomId,
        user_id: userId,
        data: {
            target_user_id: targetUserId,
            seats: room.seats,
            locked_seats: Array.from(room.lockedSeats),
            self_muted_users: Array.from(room.selfMutedUsers),
        },
        timestamp: Date.now()
    });
}

function handleHostMute(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;

    const targetUserId = data?.target_user_id;
    if (!targetUserId) return;
    room.mutedUsers.add(targetUserId);

    broadcastToAll(roomId, {
        event: 'HOST_MUTE',
        room_id: roomId,
        user_id: userId,
        data: { target_user_id: targetUserId, muted_users: Array.from(room.mutedUsers) },
        timestamp: Date.now()
    });
}

function handleHostUnmute(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;

    const targetUserId = data?.target_user_id;
    if (!targetUserId) return;
    room.mutedUsers.delete(targetUserId);

    broadcastToAll(roomId, {
        event: 'HOST_UNMUTE',
        room_id: roomId,
        user_id: userId,
        data: { target_user_id: targetUserId, muted_users: Array.from(room.mutedUsers) },
        timestamp: Date.now()
    });
}

function handleHostBanComment(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;

    const targetUserId = data?.target_user_id;
    if (!targetUserId) return;
    room.bannedCommenters.add(targetUserId);

    broadcastToAll(roomId, {
        event: 'HOST_BAN_COMMENT',
        room_id: roomId,
        user_id: userId,
        data: { target_user_id: targetUserId, banned_commenters: Array.from(room.bannedCommenters) },
        timestamp: Date.now()
    });
}

function handleHostUnbanComment(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;

    const targetUserId = data?.target_user_id;
    if (!targetUserId) return;
    room.bannedCommenters.delete(targetUserId);

    broadcastToAll(roomId, {
        event: 'HOST_UNBAN_COMMENT',
        room_id: roomId,
        user_id: userId,
        data: { target_user_id: targetUserId, banned_commenters: Array.from(room.bannedCommenters) },
        timestamp: Date.now()
    });
}

function handleLockSeat(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;

    const seatIndex = data?.seat_index;
    if (typeof seatIndex !== 'number' || seatIndex < 0 || seatIndex >= MAX_SEATS) return;

    room.lockedSeats.add(seatIndex);

    broadcastToAll(roomId, {
        event: 'LOCK_SEAT',
        room_id: roomId,
        user_id: userId,
        data: { seat_index: seatIndex },
        timestamp: Date.now()
    });
}

function handleUnlockSeat(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;

    const seatIndex = data?.seat_index;
    if (typeof seatIndex !== 'number' || seatIndex < 0 || seatIndex >= MAX_SEATS) return;

    room.lockedSeats.delete(seatIndex);

    broadcastToAll(roomId, {
        event: 'UNLOCK_SEAT',
        room_id: roomId,
        user_id: userId,
        data: { seat_index: seatIndex },
        timestamp: Date.now()
    });
}

function handleSelfMute(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    room.selfMutedUsers.add(userId);

    broadcastToAll(roomId, {
        event: 'SELF_MUTE',
        room_id: roomId,
        user_id: userId,
        data: { user_id: userId },
        timestamp: Date.now()
    });
}

function handleSelfUnmute(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    room.selfMutedUsers.delete(userId);

    broadcastToAll(roomId, {
        event: 'SELF_UNMUTE',
        room_id: roomId,
        user_id: userId,
        data: { user_id: userId },
        timestamp: Date.now()
    });
}

// ── Media playback handlers ────────────────────────────────────────────────
// Only the host (room owner) may control playback.
// Each handler updates the in-memory mediaState so late joiners can catch up,
// then re-broadcasts the original message with a server_ts stamp so viewers
// can compensate for network latency when seeking.

function handlePlay(ws, roomId, userId, data, rawMsg) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId && room.hostId !== userId) return; // only host controls
    const position = typeof data?.position === 'number' ? data.position : room.mediaState.position;
    const now = Date.now();
    room.mediaState.position = position;
    room.mediaState.isPlaying = true;
    room.mediaState.updatedAt = now;
    // Embed server_ts inside data so Flutter can read it via event.data['server_ts']
    // and compute precise latency-compensated seek positions for viewers.
    const enrichedData = { ...(rawMsg.data || {}), position, server_ts: now };
    broadcastToRoom(roomId, { ...rawMsg, data: enrichedData, server_ts: now }, ws);
}

function handlePause(ws, roomId, userId, data, rawMsg) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId && room.hostId !== userId) return;
    const position = typeof data?.position === 'number' ? data.position : room.mediaState.position;
    const now = Date.now();
    room.mediaState.position = position;
    room.mediaState.isPlaying = false;
    room.mediaState.updatedAt = now;
    const enrichedData = { ...(rawMsg.data || {}), position, server_ts: now };
    broadcastToRoom(roomId, { ...rawMsg, data: enrichedData, server_ts: now }, ws);
}

function handleSeek(ws, roomId, userId, data, rawMsg) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId && room.hostId !== userId) return;
    const position = typeof data?.position === 'number' ? data.position : room.mediaState.position;
    const now = Date.now();
    room.mediaState.position = position;
    room.mediaState.updatedAt = now;
    const enrichedData = { ...(rawMsg.data || {}), position, server_ts: now };
    broadcastToRoom(roomId, { ...rawMsg, data: enrichedData, server_ts: now }, ws);
}

function handleChangeMedia(ws, roomId, userId, data, rawMsg) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId && room.hostId !== userId) return;
    const now = Date.now();
    room.mediaState.url = data?.media_url || null;
    room.mediaState.position = 0;
    room.mediaState.isPlaying = false;
    room.mediaState.updatedAt = now;
    broadcastToRoom(roomId, { ...rawMsg, server_ts: now }, ws);
}

// Silent host heartbeat — updates server position, NOT broadcast to clients.
// This keeps the catch-up position accurate for future joiners without
// triggering false seeks on connected viewers.
function handlePositionSync(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room.hostId !== userId) return;
    const position = data?.position;
    if (typeof position !== 'number') return;
    room.mediaState.position = position;
    room.mediaState.updatedAt = Date.now();
    // Not broadcast — purely a server-side state refresh
}

/// Routes a WebRTC signaling message to a specific user in the room.
function handleWebRtcSignal(ws, roomId, userId, data) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const targetUserId = data?.target_user_id;
    if (!targetUserId) return;

    for (const client of room.clients) {
        if (client.userId === targetUserId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                event: 'WEBRTC_SIGNAL',
                room_id: roomId,
                user_id: userId,
                data: {
                    target_user_id: targetUserId,
                    signal_type: data.signal_type,
                    signal_data: data.signal_data,
                },
                timestamp: Date.now()
            }));
            break;
        }
    }
}

function handleDisconnect(ws) {
    for (const roomId of ws.rooms) {
        leaveRoom(ws, roomId, ws.userId);
    }
}

function broadcastToRoom(roomId, messageObj, senderWs) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const messageString = JSON.stringify(messageObj);

    for (const client of room.clients) {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    }
}

function broadcastToAll(roomId, messageObj) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const messageString = JSON.stringify(messageObj);

    for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    }
}

// ── Heartbeat: terminate dead connections every 30 s ────────────────
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));


console.log(`[SERVER] WebSocket sync server is running on port ${PORT}`);

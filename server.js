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
            seats: new Array(MAX_SEATS).fill(null), // each seat: { user_id, username, name, profile_pic } or null
            chat: [],
            hostId: null,
            bannedCommenters: new Set(),
            mutedUsers: new Set(),
        });
    }
    return rooms.get(roomId);
}

wss.on('connection', (ws) => {
    ws.id = crypto.randomUUID();
    ws.rooms = new Set();
    ws.userId = null;
    ws.userInfo = null; // { user_id, username, name, profile_pic }
    
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
        console.log(`[EVENT] ${event} from ${user_id} in room ${room_id}`);

        switch (event) {
            case 'JOIN_ROOM':
                joinRoom(ws, room_id, user_id, data);
                break;
            case 'LEAVE_ROOM':
                leaveRoom(ws, room_id, user_id);
                break;
            case 'PLAY':
            case 'PAUSE':
            case 'SEEK':
            case 'CHANGE_MEDIA':
                broadcastToRoom(room_id, parsedMessage, ws);
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

    // Send ROOM_STATE to the joining client (full state sync)
    const stateMsg = {
        event: 'ROOM_STATE',
        room_id: roomId,
        user_id: userId,
        data: {
            seats: room.seats,
            chat: room.chat.slice(-50), // last 50 messages
            host_id: room.hostId,
            muted_users: Array.from(room.mutedUsers),
            banned_commenters: Array.from(room.bannedCommenters),
        },
        timestamp: Date.now()
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
            data: { seats: room.seats },
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
        data: { seats: room.seats },
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
        data: { seats: room.seats },
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
        data: { target_user_id: targetUserId, seats: room.seats },
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

console.log(`[SERVER] WebSocket sync server is running on port ${PORT}`);

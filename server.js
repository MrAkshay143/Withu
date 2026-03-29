const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Data structure to maintain rooms
// rooms = { room_id: Set(client) }
const rooms = new Map();

wss.on('connection', (ws) => {
    // Generate an internal client ID (for debugging/tracking)
    ws.id = crypto.randomUUID();
    ws.rooms = new Set(); // Keep track of which rooms this client has joined
    ws.userId = null;     // Assign user_id when they send an event containing it
    
    console.log(`[CONNECTED] Client ${ws.id}`);

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (error) {
            console.error(`[ERROR] Invalid JSON from ${ws.id}`, error.message);
            return; // Ignore invalid messages
        }

        const { event, room_id, user_id, data, timestamp } = parsedMessage;

        if (!event || !room_id || !user_id) {
            console.error(`[ERROR] Missing required properties in message from ${ws.id}`);
            return;
        }

        ws.userId = user_id;
        console.log(`[EVENT] ${event} from ${user_id} in room ${room_id}`);

        switch (event) {
            case 'JOIN_ROOM':
                joinRoom(ws, room_id, user_id);
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

function joinRoom(ws, roomId, userId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
    }
    
    const roomClients = rooms.get(roomId);
    roomClients.add(ws);
    ws.rooms.add(roomId);

    // Broadcast USER_JOINED event
    const joinMessage = {
        event: 'USER_JOINED',
        room_id: roomId,
        user_id: userId,
        timestamp: Date.now()
    };
    
    broadcastToRoom(roomId, joinMessage, ws);
}

function leaveRoom(ws, roomId, userId) {
    if (rooms.has(roomId)) {
        const roomClients = rooms.get(roomId);
        roomClients.delete(ws);
        ws.rooms.delete(roomId);

        // Delete the room if it's empty
        if (roomClients.size === 0) {
            rooms.delete(roomId);
        } else {
            // Broadcast USER_LEFT
            const leaveMessage = {
                event: 'USER_LEFT',
                room_id: roomId,
                user_id: userId,
                timestamp: Date.now()
            };
            broadcastToRoom(roomId, leaveMessage, ws);
        }
    }
}

function handleDisconnect(ws) {
    // Leave all rooms the client was part of
    for (const roomId of ws.rooms) {
        leaveRoom(ws, roomId, ws.userId);
    }
}

function broadcastToRoom(roomId, messageObj, senderWs) {
    if (!rooms.has(roomId)) return;

    const roomClients = rooms.get(roomId);
    const messageString = JSON.stringify(messageObj);

    for (const client of roomClients) {
        // Broadcast to all clients in the room except the sender
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    }
}

console.log(`[SERVER] WebSocket sync server is running on port ${PORT}`);

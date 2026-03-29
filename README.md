# Withu - Real-time Synced Media WebSocket Server

A lightweight, scalable WebSocket server that synchronizes media playback across multiple users in a room.

## 🎯 Features

- Personal rooms based on `user_id`
- Real-time media synchronization (Play, Pause, Seek, Change Media)
- Direct friend joining
- Minimal dependencies (Node.js & ws)
- Railway deployment ready

## 🚀 Setup Instructions

1. **Clone the repository:**

   ```bash
   git clone https://github.com/MrAkshay143/Withu.git
   cd Withu
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Run the server:**
   ```bash
   npm start
   ```

## 🚄 Railway Deployment Steps

1. Connect your GitHub repository to [Railway](https://railway.app/).
2. Create a new project and select "Deploy from repo".
3. Railway will automatically detect the `start` script in `package.json`.
4. The server will bind to the assigned `PORT` implicitly. No additional configuration is required!

## 🔗 WebSocket Connection Example

```javascript
const ws = new WebSocket("wss://your-railway-app-url");

ws.onopen = () => {
  // Join a room
  ws.send(
    JSON.stringify({
      event: "JOIN_ROOM",
      room_id: "user_123",
      user_id: "user_456",
      timestamp: Date.now(),
    }),
  );
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log("Received:", message);
};

// Play a song
function playMedia() {
  ws.send(
    JSON.stringify({
      event: "PLAY",
      room_id: "user_123",
      user_id: "user_456",
      data: {
        media_url: "https://example.com/audio.mp3",
        current_time: 45.2,
        is_playing: true,
      },
      timestamp: Date.now(),
    }),
  );
}
```

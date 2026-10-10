# English Practice Voice Rooms

A minimal room-based group voice chat built with React, Node.js, Socket.IO, and WebRTC audio.

## Requirements
- Node.js 20+ recommended
- npm

## 1. Install dependencies

Open two terminals.

Terminal 1:
```bash
cd server
npm install
npm run dev
```

Terminal 2:
```bash
cd client
npm install
npm run dev
```

Open the Vite URL (usually http://localhost:5173). Open it in multiple browser tabs/devices to test.

## How it works
- One person creates a room and shares the room ID.
- Others enter that ID to join.
- Socket.IO handles room membership and WebRTC signalling.
- WebRTC sends microphone audio directly between peers.
- No login and no video.

## Important notes
- Allow microphone access when prompted.
- Microphone access generally requires HTTPS in production. `localhost` is allowed for local development.
- WebRTC peer-to-peer works best for small groups. For larger groups, use an SFU such as LiveKit/mediasoup.
- This starter is intended for a small MVP. It does not include recording or AI analysis.
- Room IDs are not passwords. Anyone who knows an active room ID can join. Don't use this for private/sensitive conversations.
- To test with other devices, deploy the app over HTTPS and make sure the server is reachable. For reliable connections across restrictive networks, configure a TURN server (see `client/src/App.jsx` ICE_SERVERS).

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors'); // New Security Package

const app = express();
app.use(cors()); // Allow all connections

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Allow any phone to connect
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('chat message', (msg) => {
    // Broadcast to everyone including sender (easier for synchronization)
    io.emit('chat message', msg); 
  });
});

// Use the PORT the Cloud gives us, or 3000 if local
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
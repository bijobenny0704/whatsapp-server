const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

// ⚠️ YOUR MONGODB LINK
const MONGO_URI = "mongodb+srv://bijobenny0704_db_user:GGqNHv2v6itXU3nw@cluster0.9wymndv.mongodb.net/whatsapp_clone?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ DB Error:', err));

// Updated Schema: Tracks Sender AND Receiver
const messageSchema = new mongoose.Schema({
  text: String,
  sender: String,
  receiver: String, // New Field
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Track Online Users
let onlineUsers = new Set(); 

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // 1. User Logs In
  socket.on('login', (phoneNumber) => {
    socket.join(phoneNumber); // Create a private "Room" for this user
    onlineUsers.add(phoneNumber); // Add to online list
    
    // Broadcast updated user list to everyone
    io.emit('user list', Array.from(onlineUsers));
  });

  // 2. Load Private Chat History (Between Me and Target)
  socket.on('get history', async ({ me, partner }) => {
    const messages = await Message.find({
      $or: [
        { sender: me, receiver: partner },
        { sender: partner, receiver: me }
      ]
    }).sort({ timestamp: 1 });
    
    socket.emit('history', messages);
  });

  // 3. Handle Private Message
  socket.on('private message', (msg) => {
    const newMessage = new Message(msg);
    newMessage.save().then(() => {
      // Send to Receiver (Specific Room)
      io.to(msg.receiver).emit('private message', msg);
      // Send back to Sender (so it appears on their screen too)
      io.to(msg.sender).emit('private message', msg);
    });
  });

  // 4. Handle Disconnect (Optional cleanup)
  socket.on('disconnect', () => {
    // Ideally remove from onlineUsers set here, simplified for demo
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
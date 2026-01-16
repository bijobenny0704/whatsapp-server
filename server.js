const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

// ⚠️ YOUR SPECIFIC DATABASE LINK (I pasted it here for you)
const MONGO_URI = "mongodb+srv://bijobenny0704_db_user:GGqNHv2v6itXU3nw@cluster0.9wymndv.mongodb.net/whatsapp_clone?retryWrites=true&w=majority&appName=Cluster0";

// Connect to MongoDB using Mongoose
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Database'))
  .catch(err => console.error('❌ Database Connection Error:', err));

// Define the "Shape" of a Message
const messageSchema = new mongoose.Schema({
  text: String,
  sender: String,
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. Load Old Messages
  Message.find().sort({ timestamp: 1 }).then(messages => {
    socket.emit('load history', messages);
  });

  // 2. Save New Message & Broadcast
  socket.on('chat message', (msg) => {
    const newMessage = new Message({ 
        text: msg.text, 
        sender: msg.sender 
    });

    newMessage.save().then(() => {
      io.emit('chat message', msg);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
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

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String, // In a real app, hash this!
  chatCode: { type: String, unique: true }, // The unique ID to find this user
  joinedGroups: [String] // List of Group IDs
});

const groupSchema = new mongoose.Schema({
  name: String,
  members: [String], // Array of chatCodes
  admin: String
});

const messageSchema = new mongoose.Schema({
  text: String,
  sender: String,   // chatCode of sender
  senderName: String, // Actual name (for display)
  receiver: String, // chatCode (for private) OR groupId (for groups)
  isGroup: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const Message = mongoose.model('Message', messageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Helper: Generate random 6-digit code (e.g., "A1B2C3")
const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- 1. AUTHENTICATION ---
  
  socket.on('signup', async ({ name, email, password }) => {
    try {
      const existing = await User.findOne({ email });
      if (existing) return socket.emit('auth_error', 'Email already exists');

      const chatCode = generateCode();
      const newUser = new User({ name, email, password, chatCode });
      await newUser.save();

      socket.emit('auth_success', { name, chatCode });
    } catch (e) {
      socket.emit('auth_error', 'Signup failed');
    }
  });

  socket.on('login', async ({ email, password }) => {
    try {
      const user = await User.findOne({ email, password });
      if (user) {
        socket.emit('auth_success', { name: user.name, chatCode: user.chatCode });
      } else {
        socket.emit('auth_error', 'Invalid email or password');
      }
    } catch (e) {
      socket.emit('auth_error', 'Login error');
    }
  });

  // --- 2. JOINING (The "Online" status) ---
  socket.on('join_self', async (myCode) => {
    socket.join(myCode); // Join my private room
    
    // Also join all my groups
    const user = await User.findOne({ chatCode: myCode });
    if (user && user.joinedGroups) {
      user.joinedGroups.forEach(groupId => socket.join(groupId));
    }
  });

  // --- 3. CHAT LISTS ---
  socket.on('get_conversations', async (myCode) => {
    // A. Find Private Chats (Messages where I am sender or receiver)
    const messages = await Message.find({
      $or: [{ sender: myCode }, { receiver: myCode }],
      isGroup: false
    }).sort({ timestamp: -1 });

    const contactSet = new Set();
    messages.forEach(m => contactSet.add(m.sender === myCode ? m.receiver : m.sender));
    
    // B. Find My Groups
    const user = await User.findOne({ chatCode: myCode });
    const groupIds = user ? user.joinedGroups : [];
    const groups = await Group.find({ _id: { $in: groupIds } });

    // C. Combine & Send
    const contacts = Array.from(contactSet).map(code => ({ id: code, name: `User ${code}`, type: 'private' }));
    const groupList = groups.map(g => ({ id: g._id.toString(), name: g.name, type: 'group' }));
    
    socket.emit('conversation_list', [...groupList, ...contacts]);
  });

  // --- 4. MESSAGING ---
  socket.on('send_message', async (data) => {
    const newMessage = new Message(data);
    await newMessage.save();

    if (data.isGroup) {
      // Send to the Group Room
      socket.to(data.receiver).emit('receive_message', newMessage);
    } else {
      // Send to Private Room
      socket.to(data.receiver).emit('receive_message', newMessage);
    }
    // Send back to sender for confirmation
    socket.emit('receive_message', newMessage);
  });

  socket.on('get_history', async ({ myCode, partnerId, isGroup }) => {
    let query;
    if (isGroup) {
      query = { receiver: partnerId, isGroup: true };
    } else {
      query = { 
        $or: [
          { sender: myCode, receiver: partnerId },
          { sender: partnerId, receiver: myCode }
        ],
        isGroup: false
      };
    }
    const history = await Message.find(query).sort({ timestamp: 1 });
    socket.emit('history', history);
  });

  // --- 5. CREATE GROUP ---
  socket.on('create_group', async ({ groupName, creatorCode }) => {
    const newGroup = new Group({ name: groupName, admin: creatorCode, members: [creatorCode] });
    await newGroup.save();

    // Update Creator's group list
    await User.updateOne({ chatCode: creatorCode }, { $push: { joinedGroups: newGroup._id.toString() } });
    
    socket.emit('group_created', { id: newGroup._id.toString(), name: groupName });
  });

  // --- 6. ADD MEMBER TO GROUP ---
  socket.on('add_member', async ({ groupId, newMemberCode }) => {
    const user = await User.findOne({ chatCode: newMemberCode });
    if (!user) return; // User doesn't exist

    await Group.updateOne({ _id: groupId }, { $push: { members: newMemberCode } });
    await User.updateOne({ chatCode: newMemberCode }, { $push: { joinedGroups: groupId } });
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
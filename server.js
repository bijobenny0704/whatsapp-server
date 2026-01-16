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
  password: String,
  chatCode: { type: String, unique: true }, 
  joinedGroups: [String] 
});

const groupSchema = new mongoose.Schema({
  name: String,
  groupCode: { type: String, unique: true }, // NEW: Short code to join
  members: [String], // Array of User chatCodes
  admin: String
});

const messageSchema = new mongoose.Schema({
  text: String,
  sender: String,   
  senderName: String, 
  receiver: String, // chatCode OR groupCode
  isGroup: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const Message = mongoose.model('Message', messageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- AUTH ---
  socket.on('signup', async ({ name, email, password }) => {
    try {
      const existing = await User.findOne({ email });
      if (existing) return socket.emit('auth_error', 'Email already exists');
      const chatCode = generateCode();
      const newUser = new User({ name, email, password, chatCode });
      await newUser.save();
      socket.emit('auth_success', { name, chatCode });
    } catch (e) { socket.emit('auth_error', 'Signup failed'); }
  });

  socket.on('login', async ({ email, password }) => {
    try {
      const user = await User.findOne({ email, password });
      if (user) socket.emit('auth_success', { name: user.name, chatCode: user.chatCode });
      else socket.emit('auth_error', 'Invalid credentials');
    } catch (e) { socket.emit('auth_error', 'Login error'); }
  });

  // --- JOINING ---
  socket.on('join_self', async (myCode) => {
    socket.join(myCode); // Join my private room
    const user = await User.findOne({ chatCode: myCode });
    if (user && user.joinedGroups) {
      // Find the Group Codes for these IDs
      const groups = await Group.find({ _id: { $in: user.joinedGroups } });
      groups.forEach(g => socket.join(g.groupCode)); // Join Group Rooms
    }
  });

  // --- DATA LOADING ---
  socket.on('get_conversations', async (myCode) => {
    // 1. Private Chats
    const messages = await Message.find({
      $or: [{ sender: myCode }, { receiver: myCode }],
      isGroup: false
    }).sort({ timestamp: -1 });
    
    const contactSet = new Set();
    messages.forEach(m => contactSet.add(m.sender === myCode ? m.receiver : m.sender));

    // 2. Groups
    const user = await User.findOne({ chatCode: myCode });
    const groupIds = user ? user.joinedGroups : [];
    const groups = await Group.find({ _id: { $in: groupIds } });

    const contacts = Array.from(contactSet).map(code => ({ id: code, name: `User ${code}`, type: 'private' }));
    const groupList = groups.map(g => ({ id: g.groupCode, name: g.name, type: 'group' }));
    
    socket.emit('conversation_list', [...groupList, ...contacts]);
  });

  // --- MESSAGING ---
  socket.on('send_message', async (data) => {
    const newMessage = new Message(data);
    await newMessage.save();
    
    // Broadcast to Receiver (User Code or Group Code)
    socket.to(data.receiver).emit('receive_message', newMessage);
    socket.emit('receive_message', newMessage); // Echo back
  });

  socket.on('get_history', async ({ myCode, partnerId, isGroup }) => {
    let query = isGroup 
      ? { receiver: partnerId, isGroup: true } // partnerId is the groupCode
      : { 
          $or: [
            { sender: myCode, receiver: partnerId },
            { sender: partnerId, receiver: myCode }
          ],
          isGroup: false 
        };
    
    const history = await Message.find(query).sort({ timestamp: 1 });
    socket.emit('history', history);
  });

  // --- GROUP MANAGEMENT ---
  socket.on('create_group', async ({ groupName, creatorCode }) => {
    const gCode = generateCode(); // Generate unique Group Code
    const user = await User.findOne({ chatCode: creatorCode });
    
    const newGroup = new Group({ 
      name: groupName, 
      groupCode: gCode, 
      admin: creatorCode, 
      members: [creatorCode] 
    });
    await newGroup.save();

    // Add group ID to User's list
    user.joinedGroups.push(newGroup._id);
    await user.save();
    
    socket.join(gCode); // Make creator join the room immediately
    socket.emit('group_created', { id: gCode, name: groupName });
  });

  socket.on('join_group', async ({ groupCode, userCode }) => {
    const group = await Group.findOne({ groupCode });
    if (!group) return socket.emit('error', 'Group not found');

    // Check if already member
    if (group.members.includes(userCode)) return socket.emit('error', 'Already in group');

    group.members.push(userCode);
    await group.save();

    await User.updateOne({ chatCode: userCode }, { $push: { joinedGroups: group._id } });
    
    socket.join(groupCode);
    socket.emit('group_joined', { id: groupCode, name: group.name });
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
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
  name: { type: String, unique: true },
  groupCode: { type: String, unique: true },
  members: [String],
  admin: String
});

const messageSchema = new mongoose.Schema({
  text: String,
  sender: String, senderName: String, receiver: String,
  isGroup: { type: Boolean, default: false },
  readBy: [String], 
  timestamp: { type: Date, default: Date.now }
});

// NEW: Status Schema (Expires in 24 hours)
const statusSchema = new mongoose.Schema({
  text: String,
  userCode: String,
  userName: String,
  timestamp: { type: Date, default: Date.now, expires: 86400 } // 86400s = 24h
});

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const Message = mongoose.model('Message', messageSchema);
const Status = mongoose.model('Status', statusSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString(); 

let otpStore = {}; 

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- 1. AUTH & OTP ---
  socket.on('request_signup_otp', async ({ name, email, password }) => {
    const existing = await User.findOne({ email });
    if (existing) return socket.emit('auth_error', 'Email already exists');
    const otp = generateOTP();
    otpStore[email] = { otp, name, password, type: 'signup' };
    socket.emit('otp_sent', { email, mode: 'signup', dev_otp: otp });
  });

  socket.on('verify_signup_otp', async ({ email, otp }) => {
    const data = otpStore[email];
    if (!data || data.otp !== otp) return socket.emit('auth_error', 'Invalid OTP');
    const chatCode = generateCode();
    const newUser = new User({ name: data.name, email, password: data.password, chatCode });
    await newUser.save();
    delete otpStore[email];
    socket.emit('auth_success', { name: data.name, chatCode });
  });

  socket.on('login', async ({ email, password }) => {
    const user = await User.findOne({ email, password });
    if (user) socket.emit('auth_success', { name: user.name, chatCode: user.chatCode });
    else socket.emit('auth_error', 'Invalid credentials');
  });

  socket.on('request_reset_otp', async (email) => {
    const user = await User.findOne({ email });
    if (!user) return socket.emit('auth_error', 'Email not found');
    const otp = generateOTP();
    otpStore[email] = { otp, type: 'reset' };
    socket.emit('otp_sent', { email, mode: 'reset', dev_otp: otp });
  });

  socket.on('reset_password', async ({ email, otp, newPassword }) => {
    const data = otpStore[email];
    if (!data || data.otp !== otp) return socket.emit('auth_error', 'Invalid OTP');
    await User.updateOne({ email }, { password: newPassword });
    delete otpStore[email];
    socket.emit('password_reset_success');
  });

  // --- 2. CHAT & GROUPS ---
  socket.on('join_self', async (myCode) => {
    socket.join(myCode);
    const user = await User.findOne({ chatCode: myCode });
    if (user && user.joinedGroups) {
      const groups = await Group.find({ _id: { $in: user.joinedGroups } });
      groups.forEach(g => socket.join(g.groupCode));
    }
  });

  socket.on('get_conversations', async (myCode) => {
    const messages = await Message.find({ $or: [{ sender: myCode }, { receiver: myCode }], isGroup: false }).sort({ timestamp: -1 });
    const contactSet = new Set();
    messages.forEach(m => contactSet.add(m.sender === myCode ? m.receiver : m.sender));
    const user = await User.findOne({ chatCode: myCode });
    const groups = await Group.find({ _id: { $in: (user ? user.joinedGroups : []) } });
    const contacts = Array.from(contactSet).map(code => ({ id: code, name: `User ${code}`, type: 'private' }));
    const groupList = groups.map(g => ({ id: g.groupCode, name: g.name, type: 'group' }));
    socket.emit('conversation_list', [...groupList, ...contacts]);
  });

  socket.on('send_message', async (data) => {
    const newMessage = new Message({ ...data, readBy: [data.sender] });
    await newMessage.save();
    socket.to(data.receiver).emit('receive_message', newMessage);
    socket.emit('receive_message', newMessage); 
  });

  socket.on('get_history', async ({ myCode, partnerId, isGroup }) => {
    const query = isGroup ? { receiver: partnerId, isGroup: true } : { $or: [{ sender: myCode, receiver: partnerId }, { sender: partnerId, receiver: myCode }], isGroup: false };
    const history = await Message.find(query).sort({ timestamp: 1 });
    await Message.updateMany(query, { $addToSet: { readBy: myCode } });
    socket.emit('history', history);
  });

  socket.on('create_group', async ({ groupName, creatorCode }) => {
      try {
        if (!creatorCode) return socket.emit('error', 'Please relogin');
        if (groupName.length < 3) return socket.emit('error', 'Name too short');
        const existingGroup = await Group.findOne({ name: groupName });
        if (existingGroup) return socket.emit('error', `Group "${groupName}" already exists!`);
        const user = await User.findOne({ chatCode: creatorCode });
        if (!user) return socket.emit('error', 'User not found');
        const gCode = generateCode();
        const newGroup = new Group({ name: groupName, groupCode: gCode, admin: creatorCode, members: [creatorCode] });
        await newGroup.save();
        if (!user.joinedGroups) user.joinedGroups = [];
        user.joinedGroups.push(newGroup._id.toString());
        await user.save();
        socket.join(gCode);
        socket.emit('group_created', { id: gCode, name: groupName });
      } catch (e) { socket.emit('error', 'Group Create Failed'); }
  });
  
  socket.on('join_group', async ({ groupIdentifier, userCode }) => {
    const group = await Group.findOne({ $or: [{ groupCode: groupIdentifier }, { name: groupIdentifier }] });
    if (!group) return socket.emit('error', 'Group not found');
    if (group.members.includes(userCode)) return socket.emit('error', 'Already in group');
    group.members.push(userCode);
    await group.save();
    await User.updateOne({ chatCode: userCode }, { $push: { joinedGroups: group._id.toString() } });
    socket.join(group.groupCode);
    socket.emit('group_joined', { id: group.groupCode, name: group.name });
  });

  // --- 3. STATUS LOGIC (NEW) ---
  socket.on('post_status', async ({ text, userCode, userName }) => {
    const newStatus = new Status({ text, userCode, userName });
    await newStatus.save();
    io.emit('status_updated'); // Broadcast update to everyone
  });

  socket.on('get_statuses', async (myCode) => {
    // 1. Find Chat Friends
    const messages = await Message.find({ $or: [{ sender: myCode }, { receiver: myCode }], isGroup: false });
    const friends = new Set();
    messages.forEach(m => friends.add(m.sender === myCode ? m.receiver : m.sender));

    // 2. Get All Statuses
    const allStatuses = await Status.find().sort({ timestamp: -1 });

    // 3. Mark Friends vs Others
    const organized = allStatuses.map(s => ({
      ...s.toObject(),
      isFriend: friends.has(s.userCode),
      isMe: s.userCode === myCode
    }));

    socket.emit('status_list', organized);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
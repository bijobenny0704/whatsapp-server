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

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const Message = mongoose.model('Message', messageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString(); 

let otpStore = {}; 

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- 1. SIGNUP & OTP ---
  socket.on('request_signup_otp', async ({ name, email, password }) => {
    const existing = await User.findOne({ email });
    if (existing) return socket.emit('auth_error', 'Email already exists');
    const otp = generateOTP();
    otpStore[email] = { otp, name, password, type: 'signup' };
    console.log(`[DEV OTP] Code for ${email}: ${otp}`);
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

  // --- 2. LOGIN ---
  socket.on('login', async ({ email, password }) => {
    const user = await User.findOne({ email, password });
    if (user) socket.emit('auth_success', { name: user.name, chatCode: user.chatCode });
    else socket.emit('auth_error', 'Invalid credentials');
  });

  // --- 3. PASSWORD RESET ---
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

  // --- 4. CHAT LOGIC ---
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

  // --- 5. GROUP LOGIC ---
  socket.on('create_group', async ({ groupName, creatorCode }) => {
      try {
        if (!creatorCode) return socket.emit('error', 'Please relogin');
        if (groupName.length < 3) return socket.emit('error', 'Name too short (min 3 chars)');
        
        // Check Duplicate Name
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
  
  // --- UPDATED JOIN LOGIC (Name OR Code) ---
  socket.on('join_group', async ({ groupIdentifier, userCode }) => {
    // Search by EITHER Group Code OR Group Name
    const group = await Group.findOne({
      $or: [
        { groupCode: groupIdentifier },
        { name: groupIdentifier }
      ]
    });

    if (!group) return socket.emit('error', 'Group not found (Check Name or Code)');
    if (group.members.includes(userCode)) return socket.emit('error', 'Already in group');

    group.members.push(userCode);
    await group.save();
    await User.updateOne({ chatCode: userCode }, { $push: { joinedGroups: group._id.toString() } });
    socket.join(group.groupCode);
    socket.emit('group_joined', { id: group.groupCode, name: group.name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
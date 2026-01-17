const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// STATIC FILES
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use('/uploads', express.static(UPLOAD_DIR));

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
  msgType: { type: String, default: 'text' }, 
  mediaUrl: String,
  location: { latitude: Number, longitude: Number },
  sender: String, senderName: String, receiver: String,
  isGroup: { type: Boolean, default: false },
  readBy: [String], 
  timestamp: { type: Date, default: Date.now }
});

const statusSchema = new mongoose.Schema({
  text: String,
  mediaUrl: String,
  mediaType: { type: String, default: 'video' },
  userCode: String,
  userName: String,
  timestamp: { type: Date, default: Date.now, expires: 86400 } 
});

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const Message = mongoose.model('Message', messageSchema);
const Status = mongoose.model('Status', statusSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString(); 

// --- 1. NEW: DIRECT STREAM UPLOAD (Fixes Large Videos) ---
// This accepts the raw file stream directly from the phone
app.post('/upload_stream', (req, res) => {
  const ext = req.query.ext || 'jpg';
  const fileName = `file_${Date.now()}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  
  // Create a writable stream to the disk
  const writeStream = fs.createWriteStream(filePath);
  
  // Pipe the request (phone data) -> disk
  req.pipe(writeStream);

  writeStream.on('finish', () => {
    // Return the URL to the phone
    res.json({ url: `/uploads/${fileName}`, success: true });
  });

  writeStream.on('error', (err) => {
    console.error("Stream Error:", err);
    res.status(500).json({ error: "Upload Failed" });
  });
});

// --- SOCKET LOGIC ---
let otpStore = {}; 

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- 2. FINALIZE MEDIA (After Upload is Done) ---
  socket.on('finalize_media', async ({ mediaUrl, type, mediaType, userCode, userName, caption, receiver, isGroup }) => {
    // The file is already uploaded via HTTP. Now we just save the DB entry.
    if (type === 'status') {
      const newStatus = new Status({ text: caption, mediaUrl, mediaType, userCode, userName });
      await newStatus.save();
      io.emit('status_updated'); 
    } 
    else if (type === 'chat') {
      const newMessage = new Message({
        text: caption || (mediaType === 'image' ? '📷 Photo' : '🎥 Video'),
        msgType: mediaType,
        mediaUrl,
        sender: userCode, senderName: userName, receiver, isGroup,
        readBy: [userCode]
      });
      await newMessage.save();
      
      if (isGroup) socket.to(receiver).emit('receive_message', newMessage);
      else socket.to(receiver).emit('receive_message', newMessage);
      socket.emit('receive_message', newMessage); 
    }
  });

  // --- 3. AUTH ---
  socket.on('request_signup_otp', async ({ name, email, password }) => {
    const existing = await User.findOne({ email });
    if (existing) return socket.emit('auth_error', 'Email already exists');
    const otp = generateOTP();
    otpStore[email] = { otp, name, password, type: 'signup' };
    console.log(`[OTP] ${email}: ${otp}`);
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

  // --- 4. CHAT ---
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

  // --- 5. GROUPS ---
  socket.on('create_group', async ({ groupName, creatorCode }) => {
      try {
        if (!creatorCode) return socket.emit('error', 'Please relogin');
        if (groupName.length < 3) return socket.emit('error', 'Name too short');
        const existing = await Group.findOne({ name: { $regex: new RegExp(`^${groupName}$`, 'i') } });
        if (existing) return socket.emit('error', 'Group name taken');
        const user = await User.findOne({ chatCode: creatorCode });
        if (!user) return socket.emit('error', 'User not found');
        const gCode = generateCode();
        const newGroup = new Group({ name: groupName, groupCode: gCode, admin: creatorCode, members: [creatorCode] });
        await newGroup.save();
        await User.updateOne({ chatCode: creatorCode }, { $push: { joinedGroups: newGroup._id.toString() } });
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

  // --- 6. REELS ---
  socket.on('get_statuses', async (myCode) => {
    const messages = await Message.find({ $or: [{ sender: myCode }, { receiver: myCode }], isGroup: false });
    const friends = new Set();
    messages.forEach(m => friends.add(m.sender === myCode ? m.receiver : m.sender));
    const allStatuses = await Status.find().sort({ timestamp: -1 });
    const organized = allStatuses.map(s => ({
      ...s.toObject(),
      isFriend: friends.has(s.userCode),
      isMe: s.userCode === myCode,
      mediaUrl: s.mediaUrl.startsWith('http') ? s.mediaUrl : `https://otoevnt-server.onrender.com${s.mediaUrl}`
    }));
    organized.sort((a, b) => {
        if (a.isMe) return -1;
        if (b.isMe) return 1;
        if (a.isFriend && !b.isFriend) return -1;
        if (!a.isFriend && b.isFriend) return 1;
        return 0;
    });
    socket.emit('status_list', organized);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
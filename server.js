const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');
const { Resend } = require('resend'); // New Email Tool

const app = express();
app.use(cors());

// ⚠️ YOUR MONGODB LINK
const MONGO_URI = "mongodb+srv://bijobenny0704_db_user:GGqNHv2v6itXU3nw@cluster0.9wymndv.mongodb.net/whatsapp_clone?retryWrites=true&w=majority&appName=Cluster0";

// ⚠️ PASTE YOUR RESEND API KEY HERE
const resend = new Resend('re_Eos7HEz9_8FETvRnM5PafFFpLM7PfiqH1'); 

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ DB Error:', err));

// --- NEW EMAIL FUNCTION (Fast & Not Blocked) ---
const sendOTPEmail = async (email, otp, type) => {
  const subject = type === 'signup' ? 'Verify Your Account' : 'Reset Password Request';
  
  // LOGS (So you can still see it if email fails)
  console.log("========================================");
  console.log(`[ATTEMPTING EMAIL] To: ${email} | OTP: ${otp}`);
  console.log("========================================");

  try {
    const data = await resend.emails.send({
      from: 'onboarding@resend.dev', // Default testing email
      to: email,                     // ⚠️ In Free Mode, this MUST be YOUR account email
      subject: subject,
      html: `<p>Your OTOEVNT Code is: <strong>${otp}</strong></p>`
    });

    if (data.error) {
      console.error("[EMAIL ERROR]", data.error);
      return false;
    }

    console.log("[SUCCESS] Email Sent! ID:", data.id);
    return true;
  } catch (err) {
    console.error("[CRASH] Email Failed:", err);
    return false; // App will fallback to logs
  }
};

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
  groupCode: { type: String, unique: true },
  members: [String],
  admin: String
});

const messageSchema = new mongoose.Schema({
  text: String,
  sender: String, senderName: String, receiver: String,
  isGroup: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const Message = mongoose.model('Message', messageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString(); 

// --- SOCKET LOGIC ---
let otpStore = {}; 

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // 1. SIGNUP
  socket.on('request_signup_otp', async ({ name, email, password }) => {
    const existing = await User.findOne({ email });
    if (existing) return socket.emit('auth_error', 'Email already exists');

    const otp = generateOTP();
    otpStore[email] = { otp, name, password, type: 'signup' };
    
    // Send Email
    await sendOTPEmail(email, otp, 'signup');
    
    // Always tell app "Sent" so it moves to next screen (Logs act as backup)
    socket.emit('otp_sent', { email, mode: 'signup' });
  });

  // 2. VERIFY
  socket.on('verify_signup_otp', async ({ email, otp }) => {
    const data = otpStore[email];
    if (!data || data.otp !== otp) return socket.emit('auth_error', 'Invalid OTP');

    const chatCode = generateCode();
    const newUser = new User({ name: data.name, email, password: data.password, chatCode });
    await newUser.save();
    
    delete otpStore[email];
    socket.emit('auth_success', { name: data.name, chatCode });
  });

  // 3. LOGIN
  socket.on('login', async ({ email, password }) => {
    const user = await User.findOne({ email, password });
    if (user) socket.emit('auth_success', { name: user.name, chatCode: user.chatCode });
    else socket.emit('auth_error', 'Invalid credentials');
  });

  // 4. CHAT (Standard)
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
    const newMessage = new Message(data);
    await newMessage.save();
    socket.to(data.receiver).emit('receive_message', newMessage);
    socket.emit('receive_message', newMessage); 
  });

  socket.on('get_history', async ({ myCode, partnerId, isGroup }) => {
    const query = isGroup ? { receiver: partnerId, isGroup: true } : { $or: [{ sender: myCode, receiver: partnerId }, { sender: partnerId, receiver: myCode }], isGroup: false };
    const history = await Message.find(query).sort({ timestamp: 1 });
    socket.emit('history', history);
  });
  
  socket.on('create_group', async ({ groupName, creatorCode }) => {
      try {
        const user = await User.findOne({ chatCode: creatorCode });
        if (!user) return socket.emit('error', 'User not found');
        const gCode = generateCode();
        const newGroup = new Group({ name: groupName, groupCode: gCode, admin: creatorCode, members: [creatorCode] });
        await newGroup.save();
        if (!user.joinedGroups) user.joinedGroups = [];
        user.joinedGroups.push(newGroup._id);
        await user.save();
        socket.join(gCode);
        socket.emit('group_created', { id: gCode, name: groupName });
      } catch (e) { socket.emit('error', 'Group Create Failed'); }
  });
  
  socket.on('join_group', async ({ groupCode, userCode }) => {
    const group = await Group.findOne({ groupCode });
    if (!group) return socket.emit('error', 'Group not found');
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
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const mongoose = require('mongoose');
const { Resend } = require('resend'); // Import Resend

const app = express();
app.use(cors());

// ⚠️ YOUR MONGODB LINK
const MONGO_URI = "mongodb+srv://bijobenny0704_db_user:GGqNHv2v6itXU3nw@cluster0.9wymndv.mongodb.net/whatsapp_clone?retryWrites=true&w=majority&appName=Cluster0";

// ⚠️ YOUR RESEND API KEY
const resend = new Resend('re_Eos7HEz9_8FETvRnM5PafFFpLM7PfiqH1'); // <-- PASTE YOUR KEY HERE

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ DB Error:', err));

// ... (Keep your User/Group/Message Schemas same as before) ...

// --- NEW EMAIL FUNCTION (Uses HTTP, works on Render) ---
const sendOTPEmail = async (email, otp, type) => {
  const subject = type === 'signup' ? 'Verify Your Account' : 'Reset Password Request';
  const htmlContent = `
    <h1>${subject}</h1>
    <p>Your code is: <strong>${otp}</strong></p>
    <p>This code expires in 5 minutes.</p>
  `;

  try {
    const data = await resend.emails.send({
      from: 'onboarding@resend.dev', // Use this exact email for testing
      to: email,                     // Only works with YOUR registered email in testing
      subject: subject,
      html: htmlContent
    });
    
    console.log("[SUCCESS] Email ID:", data.id);
    return true;
  } catch (err) {
    console.error("[ERROR] Email Failed:", err);
    return false;
  }
};

// ... (Keep the rest of your server code: io.on connection, etc.) ...

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // --- 1. SIGNUP FLOW ---
  socket.on('request_signup_otp', async ({ name, email, password }) => {
    const existing = await User.findOne({ email });
    if (existing) return socket.emit('auth_error', 'Email already exists');

    const otp = generateOTP();
    // Save data temporarily
    otpStore[email] = { otp, name, password, type: 'signup' };
    
    const sent = await sendOTPEmail(email, otp, 'signup');
    if (sent) socket.emit('otp_sent', { email, mode: 'signup' });
    else socket.emit('auth_error', 'Failed to send email. Check server logs.');
  });

  socket.on('verify_signup_otp', async ({ email, otp }) => {
    const data = otpStore[email];
    if (!data || data.otp !== otp || data.type !== 'signup') {
      return socket.emit('auth_error', 'Invalid or Expired OTP');
    }

    // Create User
    const chatCode = generateCode();
    const newUser = new User({ name: data.name, email, password: data.password, chatCode });
    await newUser.save();
    
    delete otpStore[email]; // Clear OTP
    socket.emit('auth_success', { name: data.name, chatCode });
  });

  // --- 2. FORGOT PASSWORD FLOW ---
  socket.on('request_reset_otp', async (email) => {
    const user = await User.findOne({ email });
    if (!user) return socket.emit('auth_error', 'Email not found');

    const otp = generateOTP();
    otpStore[email] = { otp, type: 'reset' };

    const sent = await sendOTPEmail(email, otp, 'reset');
    if (sent) socket.emit('otp_sent', { email, mode: 'reset' });
    else socket.emit('auth_error', 'Failed to send email.');
  });

  socket.on('reset_password', async ({ email, otp, newPassword }) => {
    const data = otpStore[email];
    if (!data || data.otp !== otp || data.type !== 'reset') {
      return socket.emit('auth_error', 'Invalid OTP');
    }

    await User.updateOne({ email }, { password: newPassword });
    delete otpStore[email];
    socket.emit('password_reset_success');
  });

  // --- 3. LOGIN & CHAT (Same as before) ---
  socket.on('login', async ({ email, password }) => {
    const user = await User.findOne({ email, password });
    if (user) socket.emit('auth_success', { name: user.name, chatCode: user.chatCode });
    else socket.emit('auth_error', 'Invalid credentials');
  });

  // Keep all previous chat logic (join_self, get_conversations, send_message, create_group, etc.)
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
    let query = isGroup ? { receiver: partnerId, isGroup: true } : { $or: [{ sender: myCode, receiver: partnerId }, { sender: partnerId, receiver: myCode }], isGroup: false };
    const history = await Message.find(query).sort({ timestamp: 1 });
    socket.emit('history', history);
  });

  socket.on('create_group', async ({ groupName, creatorCode }) => {
    try {
      if (!creatorCode) return socket.emit('error', 'Not logged in');
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
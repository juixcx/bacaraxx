const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) console.error('❌ ไม่พบค่า MONGO_URI');

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    isAdmin: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

let globalState = {
  gameState: 'BETTING',
  countdown: 10,
  roundEndTime: Date.now() + 10000,
  adminWinMode: 'normal',
  history: [],       
  lastResult: null,  
};

let timerInterval = null;
const suits = ['♠', '♥', '♦', '♣'];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// เพิ่มไพ่พิเศษ วอก และ เฟือง (ให้มีโอกาสออกน้อยกว่าไพ่ปกติ)
const specialCards = ['วอก', 'เฟือง']; 

function createDeck() {
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ value: v, suit: s, isRed: ['♥','♦'].includes(s) });
        }
    }
    // เพิ่มไพ่พิเศษ (สมมติให้มี 2 ใบต่อสำรับ)
    deck.push({ value: 'วอก', suit: '♠', isRed: false, isSpecial: true });
    deck.push({ value: 'เฟือง', suit: '♦', isRed: true, isSpecial: true });
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// ฟังก์ชันแปลงค่าไพ่ (วอก/เฟือง ให้ค่า 0)
const getVal = (card) => {
    if (card.isSpecial) return 0; 
    return ['10','J','Q','K'].includes(card.value) ? 0 : card.value === 'A' ? 1 : parseInt(card.value);
};

const calcScore = (hand) => hand.reduce((sum, c) => sum + getVal(c), 0) % 10;

function generateGameResult() {
  let deck = shuffleDeck(createDeck());
  
  // แจกไพ่ 2 ใบแรก
  let pHand = [deck.pop(), deck.pop()];
  let bHand = [deck.pop(), deck.pop()];

  // เช็คไพ่พิเศษ (วอก/เฟือง) ก่อนเลย
  let pWinSpecial = pHand.some(c => c.isSpecial);
  let bWinSpecial = bHand.some(c => c.isSpecial);

  if (pWinSpecial || bWinSpecial) {
      let winner = 'tie';
      if (pWinSpecial && bWinSpecial) winner = 'tie'; // ออกทั้งสองฝั่ง เสมอ
      else if (pWinSpecial) winner = 'player'; // วอก/เฟือง ออกฝั่ง Player ชนะทันที
      else if (bWinSpecial) winner = 'banker'; // วอก/เฟือง ออกฝั่ง Banker ชนะทันที
      
      return { pHand, bHand, pScore: 0, bScore: 0, winner, isSpecialWin: true };
  }

  // ถ้าไม่มีไพ่พิเศษ ให้เล่นตามกฎบาคาร่าปกติ
  let pScore = calcScore(pHand);
  let bScore = calcScore(bHand);
  let pThirdVal = null;

  if (pScore >= 8 || bScore >= 8) {
      let winner = pScore > bScore ? 'player' : bScore > pScore ? 'banker' : 'tie';
      return { pHand, bHand, pScore, bScore, winner };
  }

  if (pScore <= 5) {
      let card = deck.pop();
      pHand.push(card);
      pThirdVal = getVal(card);
      pScore = calcScore(pHand);
  }

  let bShouldDraw = false;
  if (pThirdVal === null) {
      if (bScore <= 5) bShouldDraw = true;
  } else {
      if (bScore <= 2) bShouldDraw = true;
      else if (bScore === 3) bShouldDraw = (pThirdVal !== 8);
      else if (bScore === 4) bShouldDraw = (pThirdVal >= 2 && pThirdVal <= 7);
      else if (bScore === 5) bShouldDraw = (pThirdVal >= 4 && pThirdVal <= 7);
      else if (bScore === 6) bShouldDraw = (pThirdVal === 6 || pThirdVal === 7);
  }

  if (bShouldDraw) {
      bHand.push(deck.pop());
      bScore = calcScore(bHand);
  }

  let winner = pScore > bScore ? 'player' : bScore > pScore ? 'banker' : 'tie';
  return { pHand, bHand, pScore, bScore, winner };
}

function startRound() {
  if (globalState.history.length >= 50) {
    globalState.history = []; 
    globalState.lastResult = null;
    io.emit('resetScoreboard'); 
  }

  globalState.gameState = 'BETTING';
  globalState.countdown = 10; 
  globalState.roundEndTime = Date.now() + 10000;
  globalState.lastResult = null; 
  io.emit('stateSync', globalState);

  if (timerInterval) clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    globalState.countdown--;
    io.emit('stateSync', globalState);

    if (globalState.countdown <= 0) {
      clearInterval(timerInterval);
      globalState.gameState = 'DEALING';
      io.emit('stateSync', globalState);

      const result = generateGameResult();

      globalState.lastResult = result;
      globalState.history.push(result.winner);

      io.emit('startDealing', result);

      setTimeout(() => { startRound(); }, 15000); 
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.emit('stateSync', globalState);
  if (globalState.gameState === 'DEALING' && globalState.lastResult) socket.emit('startDealing', globalState.lastResult);

  socket.on('loginRequest', async (data) => {
      const { username, password, isRegister } = data;
      try {
          if (isRegister) {
              const existingUser = await User.findOne({ username });
              if (existingUser) return socket.emit('loginResponse', { success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว!' });
              
              const isAdmin = (password === 'min888');
              const newUser = new User({ username, password, balance: 1000, isAdmin: isAdmin });
              await newUser.save();
              socket.emit('loginResponse', { success: true, user: { username: newUser.username, balance: newUser.balance, isAdmin: newUser.isAdmin } });
          } else {
              const user = await User.findOne({ username, password });
              if (!user) return socket.emit('loginResponse', { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!' });
              
              if (password === 'min888' && !user.isAdmin) { user.isAdmin = true; await user.save(); }
              socket.emit('loginResponse', { success: true, user: { username: user.username, balance: user.balance, isAdmin: user.isAdmin } });
          }
      } catch (err) {
          socket.emit('loginResponse', { success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
      }
  });

  socket.on('updatePlayerBalance', async (data) => {
      try { await User.updateOne({ username: data.username }, { balance: data.newBalance }); } catch (err) {}
  });

  socket.on('adminAdjustCredit', async (data) => {
      const { targetUser, amount } = data;
      try {
          const user = await User.findOne({ username: targetUser });
          if (!user) return socket.emit('adminAdjustResult', { success: false, message: `ไม่พบชื่อผู้ใช้ ${targetUser}` });
          user.balance += amount;
          if(user.balance < 0) user.balance = 0;
          await user.save();
          io.emit('balanceUpdatedByAdmin', { username: targetUser, newBalance: user.balance });
          socket.emit('adminAdjustResult', { success: true, message: `ปรับเครดิต ${targetUser} เป็น ${user.balance} สำเร็จ` });
      } catch (err) { socket.emit('adminAdjustResult', { success: false, message: 'เกิดข้อผิดพลาด' }); }
  });

  socket.on('adminAction', (data) => { if (data.type === 'SET_WIN_MODE') globalState.adminWinMode = data.mode; });
});

startRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

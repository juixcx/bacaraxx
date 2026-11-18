const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ==========================================
// ✅ ตั้งค่าการเชื่อมต่อ MongoDB
// ==========================================
// ระบบจะพยายามดึงจาก Environment Variable ใน Render ก่อน
// ถ้าไม่มี (เช่นรันในเครื่อง) จะใช้ลิงก์สำรองที่ให้มา
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://minnie78t_db_user:UBdFCHKmBm5qB0Nw@my.ype6nu7.mongodb.net/baccarat?retryWrites=true&w=majority'; 

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- สร้าง Schema สำหรับ User ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 }, // สมัครใหม่รับ 1000
    isAdmin: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

// ให้ Express เสิร์ฟไฟล์ในโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- สถานะกลางของเซิร์ฟเวอร์ ----------------
let globalState = {
  gameState: 'BETTING',
  countdown: 10,
  adminWinMode: 'normal',
  history: [],       
  lastResult: null,  
};

let timerInterval = null;
const suits = ['♠', '♥', '♦', '♣'];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// --- ฟังก์ชันสร้างไพ่และคำนวณแต้ม ---
function createDeck() {
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ value: v, suit: s, isRed: ['♥','♦'].includes(s) });
        }
    }
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const getVal = (card) => ['10','J','Q','K'].includes(card.value) ? 0 : card.value === 'A' ? 1 : parseInt(card.value);
const calcScore = (hand) => hand.reduce((sum, c) => sum + getVal(c), 0) % 10;

function createHandWithScore(targetScore, deck) {
  let hand = [];
  let v1 = Math.floor(Math.random() * (targetScore + 1));
  let v2 = targetScore - v1;
  
  const findCard = (val) => {
      let strVal = val === 0 ? (Math.random() < 0.5 ? '10' : 'J') : (val === 1 ? 'A' : val.toString());
      let idx = deck.findIndex(c => c.value === strVal);
      if (idx !== -1) return deck.splice(idx, 1)[0];
      return deck.splice(0, 1)[0];
  };

  hand.push(findCard(v1));
  hand.push(findCard(v2));
  return hand;
}

function generateGameResult() {
  let deck = shuffleDeck(createDeck());
  let pHand, bHand, pScore, bScore;

  if (globalState.adminWinMode === 'force_player') {
    pScore = Math.random() < 0.5 ? 8 : 9;
    bScore = Math.floor(Math.random() * 8);
    pHand = createHandWithScore(pScore, deck);
    bHand = createHandWithScore(bScore, deck);
  } else if (globalState.adminWinMode === 'force_banker') {
    bScore = Math.random() < 0.5 ? 8 : 9;
    pScore = Math.floor(Math.random() * 8);
    pHand = createHandWithScore(pScore, deck);
    bHand = createHandWithScore(bScore, deck);
  } else if (globalState.adminWinMode === 'force_tie') {
    pScore = Math.floor(Math.random() * 10);
    bScore = pScore;
    pHand = createHandWithScore(pScore, deck);
    bHand = createHandWithScore(bScore, deck);
  } else {
    pHand = [deck.pop(), deck.pop()];
    bHand = [deck.pop(), deck.pop()];
    
    pScore = calcScore(pHand);
    bScore = calcScore(bHand);
    let pDrewThird = false;
    let pThirdVal = null;

    if (pScore < 8 && bScore < 8) {
      if (pScore <= 5) {
        let card = deck.pop();
        pHand.push(card);
        pThirdVal = getVal(card);
        pScore = calcScore(pHand);
        pDrewThird = true;
      }
      
      let bShouldDraw = false;
      if (!pDrewThird) {
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
    }
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
      
      setTimeout(() => {
        startRound();
      }, 15000); 
    }
  }, 1000);
}

// ---------------- Socket Connection ----------------
io.on('connection', (socket) => {
  socket.emit('stateSync', globalState);
  
  if (globalState.gameState === 'DEALING' && globalState.lastResult) {
      socket.emit('startDealing', globalState.lastResult);
  }

  // --- ระบบ Login / สมัครสมาชิก (MongoDB) ---
  socket.on('loginRequest', async (data) => {
      const { username, password, isRegister } = data;
      
      try {
          if (isRegister) {
              // เช็คว่ามีชื่อนี้ในระบบหรือยัง
              const existingUser = await User.findOne({ username });
              if (existingUser) {
                  return socket.emit('loginResponse', { success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว!' });
              }
              
              // สร้าง User ใหม่
              const newUser = new User({ username, password, balance: 1000 });
              await newUser.save();
              
              socket.emit('loginResponse', { 
                  success: true, 
                  user: { username: newUser.username, balance: newUser.balance, isAdmin: newUser.isAdmin } 
              });
          } else {
              // ล็อกอิน
              const user = await User.findOne({ username, password });
              if (!user) {
                  return socket.emit('loginResponse', { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!' });
              }
              
              // ตรวจสอบสิทธิ์แอดมิน (ถ้ารหัสเป็น min888 ให้ถือว่าเป็นแอดมิน)
              let isAdmin = user.isAdmin || (password === 'min888');
              
              socket.emit('loginResponse', { 
                  success: true, 
                  user: { username: user.username, balance: user.balance, isAdmin: isAdmin } 
              });
          }
      } catch (err) {
          console.error(err);
          socket.emit('loginResponse', { success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
      }
  });

  // --- อัปเดตเครดิตผู้เล่น (เมื่อเดิมพันหรือชนะ) ---
  socket.on('updatePlayerBalance', async (data) => {
      const { username, newBalance } = data;
      try {
          await User.updateOne({ username }, { balance: newBalance });
      } catch (err) {
          console.error('Error updating balance:', err);
      }
  });

  // --- แอดมิน ปรับเครดิตผู้เล่นรายบุคคล ---
  socket.on('adminAdjustCredit', async (data) => {
      const { targetUser, amount } = data;
      try {
          const user = await User.findOne({ username: targetUser });
          if (!user) {
              return socket.emit('adminAdjustResult', { success: false, message: `ไม่พบชื่อผู้ใช้ ${targetUser} ในระบบ` });
          }
          
          // อัปเดตเครดิต
          user.balance += amount;
          if(user.balance < 0) user.balance = 0; // ไม่ให้ติดลบ
          await user.save();
          
          // แจ้งเตือนผู้เล่นคนนั้น (ถ้าออนไลน์)
          io.emit('balanceUpdatedByAdmin', { username: targetUser, newBalance: user.balance });
          socket.emit('adminAdjustResult', { success: true, message: `ปรับเครดิต ${targetUser} เป็น ${user.balance} สำเร็จ` });
          
      } catch (err) {
          console.error(err);
          socket.emit('adminAdjustResult', { success: false, message: 'เกิดข้อผิดพลาดในการบันทึก' });
      }
  });

  // --- รับคำสั่งจากแอดมิน (เปลี่ยนโหมดเกม) ---
  socket.on('adminAction', (data) => {
    if (data.type === 'SET_WIN_MODE') {
      globalState.adminWinMode = data.mode;
    }
  });
});

// เริ่มต้นเกม
startRound();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

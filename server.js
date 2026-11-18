const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- ฐานข้อมูลผู้เล่นจำลอง ----------------
// เก็บข้อมูลใน Memory (ถ้ารีสตาร์ทเซิร์ฟเวอร์ ข้อมูลจะหาย)
// รูปแบบ: username: { password, balance, isAdmin }
let usersDB = {
    "ba_eu37": { password: "1234", balance: 5000, isAdmin: false },
    "admin_master": { password: "min888", balance: 999999, isAdmin: true }
};

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

  // --- ระบบ Login / สมัครสมาชิก ---
  socket.on('loginRequest', (data) => {
      const { username, password, isRegister } = data;
      
      // ถ้าเป็นการสมัครใหม่
      if (isRegister) {
          if (usersDB[username]) {
              socket.emit('loginResponse', { success: false, message: 'ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว!' });
          } else {
              usersDB[username] = { password: password, balance: 1000, isAdmin: false }; // สมัครใหม่รับ 1000
              socket.emit('loginResponse', { success: true, user: { username: username, balance: usersDB[username].balance, isAdmin: false } });
          }
          return;
      }

      // ถ้าเป็นการล็อกอิน
      const user = usersDB[username];
      if (user && user.password === password) {
          // แอดมิน can login with min888
          let isAdmin = user.isAdmin || (password === 'min888');
          socket.emit('loginResponse', { success: true, user: { username: username, balance: user.balance, isAdmin: isAdmin } });
      } else {
          socket.emit('loginResponse', { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!' });
      }
  });

  // --- ระบบซิงค์เครดิตผู้เล่น (เมื่อเดิมพันหรือรับโค้ด) ---
  socket.on('updatePlayerBalance', (data) => {
      const { username, newBalance } = data;
      if (usersDB[username]) {
          usersDB[username].balance = newBalance;
      }
  });

  // --- ระบบแอดมิน ปรับเครดิตคนอื่น ---
  socket.on('adminAdjustCredit', (data) => {
      const { targetUser, amount } = data;
      if (usersDB[targetUser]) {
          usersDB[targetUser].balance += amount;
          // ส่งข้อมูลใหม่ไปหาคนๆ นั้น (ถ้าคนๆ นั้นออนไลน์อยู่)
          io.emit('balanceUpdatedByAdmin', { username: targetUser, newBalance: usersDB[targetUser].balance });
          socket.emit('adminAdjustResult', { success: true, message: `ปรับเครดิต ${targetUser} เป็น ${usersDB[targetUser].balance} สำเร็จ` });
      } else {
          socket.emit('adminAdjustResult', { success: false, message: `ไม่พบชื่อผู้ใช้ ${targetUser} ในระบบ` });
      }
  });

  socket.on('adminAction', (data) => {
    if (data.type === 'SET_WIN_MODE') {
      globalState.adminWinMode = data.mode;
    }
  });
});

startRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

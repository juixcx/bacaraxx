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

// ---------------- สถานะกลางของเซิร์ฟเวอร์ ----------------
let globalState = {
  gameState: 'BETTING',
  countdown: 10,
  adminWinMode: 'normal',
  history: [],       // เก็บสถิติ 50 ตา
  lastResult: null,  
};

let timerInterval = null;
const suits = ['♠', '♥', '♦', '♣'];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// สร้างสำรับไพ่ 52 ใบ
function createDeck() {
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ value: v, suit: s, isRed: ['♥','♦'].includes(s) });
        }
    }
    return deck;
}

// สับไพ่
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const getVal = (card) => ['10','J','Q','K'].includes(card.value) ? 0 : card.value === 'A' ? 1 : parseInt(card.value);
const calcScore = (hand) => hand.reduce((sum, c) => sum + getVal(c), 0) % 10;

// ฟังก์ชันสร้างไพ่ให้ได้แต้มตามที่ต้องการ (ใช้สำหรับ Admin ล็อกผล)
function createHandWithScore(targetScore, deck) {
  let hand = [];
  let v1 = Math.floor(Math.random() * (targetScore + 1));
  let v2 = targetScore - v1;
  
  // ดึงไพ่จากสำรับที่มีอยู่จริงเพื่อไม่ให้ไพ่ซ้ำ
  const findCard = (val) => {
      let strVal = val === 0 ? (Math.random() < 0.5 ? '10' : 'J') : (val === 1 ? 'A' : val.toString());
      let idx = deck.findIndex(c => c.value === strVal);
      if (idx !== -1) return deck.splice(idx, 1)[0];
      return deck.splice(0, 1)[0]; // fallback
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
    // สุ่มปกติตามกติกาบาคาร่า
    pHand = [deck.pop(), deck.pop()];
    bHand = [deck.pop(), deck.pop()];
    
    pScore = calcScore(pHand);
    bScore = calcScore(bHand);
    let pDrewThird = false;
    let pThirdVal = null;

    // กฎการจั่วไพ่
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
  // ครบ 50 ตา ค่อยรีเซ็ต
  if (globalState.history.length >= 50) {
    console.log('ครบ 50 ตา! รีเซ็ตสถิติใหม่');
    globalState.history = []; 
    globalState.lastResult = null;
    io.emit('resetScoreboard'); 
  }

  globalState.gameState = 'BETTING';
  globalState.countdown = 10; // เวลาเดิมพัน 10 วินาที
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
      // เก็บเฉพาะชื่อผู้ชนะลงใน history
      globalState.history.push(result.winner);
      
      io.emit('startDealing', result);
      
      // รอให้แอนิเมชันแจกไพ่จบ (ประมาณ 12-15 วินาที) แล้วเริ่มรอบใหม่
      setTimeout(() => {
        startRound();
      }, 15000); 
    }
  }, 1000);
}

io.on('connection', (socket) => {
  // ส่งข้อมูลสถานะปัจจุบันให้ Client ที่เพิ่งเข้ามา
  socket.emit('stateSync', globalState);
  
  // ถ้าคนใหม่เข้ามาตอนกำลังแจกไพ่ ให้ส่งผลไพ่รอบนั้นไปให้ดูด้วย
  if (globalState.gameState === 'DEALING' && globalState.lastResult) {
      socket.emit('startDealing', globalState.lastResult);
  }

  // รับคำสั่งจาก Admin
  socket.on('adminAction', (data) => {
    if (data.type === 'SET_WIN_MODE') {
      globalState.adminWinMode = data.mode;
      console.log('Admin เปลี่ยนโหมด结果为:', globalState.adminWinMode);
    }
  });
});

startRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

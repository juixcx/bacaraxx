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

let globalState = {
  gameState: 'BETTING',
  countdown: 10,
  adminWinMode: 'normal',
  history: [],       // เก็บสถิติ 20 ตา
  lastResult: null,  // เก็บไพ่ตาล่าสุด
};

let timerInterval = null;
const suits = ['♠', '♥', '♦', '♣'];

const createCard = (valStr) => {
  const suit = suits[Math.floor(Math.random() * suits.length)];
  return { value: valStr, suit: suit, isRed: ['♥','♦'].includes(suit) };
};

const getVal = (card) => ['10','J','Q','K'].includes(card.value) ? 0 : card.value === 'A' ? 1 : parseInt(card.value);
const calcScore = (hand) => hand.reduce((sum, c) => sum + getVal(c), 0) % 10;

function createHandWithScore(targetScore) {
  if (targetScore > 9) targetScore = 9;
  if (targetScore < 0) targetScore = 0;

  let hand = [];
  let v1 = Math.floor(Math.random() * (targetScore + 1));
  hand.push(createCard(v1 === 0 ? '10' : v1.toString()));
  
  if (targetScore === 0 && v1 === 0) {
    hand.push(createCard('10')); 
    return hand;
  }

  let v2 = targetScore - v1;
  if (v2 < 0) v2 = 0;
  hand.push(createCard(v2 === 0 ? '10' : v2.toString()));
  
  return hand;
}

function generateGameResult() {
  let pHand, bHand;
  let pScore, bScore;

  if (globalState.adminWinMode === 'force_player') {
    pScore = Math.random() < 0.5 ? 8 : 9;
    bScore = Math.floor(Math.random() * 8);
    pHand = createHandWithScore(pScore);
    bHand = createHandWithScore(bScore);
  } else if (globalState.adminWinMode === 'force_banker') {
    bScore = Math.random() < 0.5 ? 8 : 9;
    pScore = Math.floor(Math.random() * 8);
    pHand = createHandWithScore(pScore);
    bHand = createHandWithScore(bScore);
  } else if (globalState.adminWinMode === 'force_tie') {
    pScore = Math.floor(Math.random() * 10);
    bScore = pScore;
    pHand = createHandWithScore(pScore);
    bHand = createHandWithScore(bScore);
  } else {
    pHand = [createCard(Math.floor(Math.random()*10).toString()), createCard(Math.floor(Math.random()*10).toString())];
    bHand = [createCard(Math.floor(Math.random()*10).toString()), createCard(Math.floor(Math.random()*10).toString())];
    
    pScore = calcScore(pHand);
    bScore = calcScore(bHand);
    let pDrewThird = false;
    let pThirdVal = null;

    if (pScore < 8 && bScore < 8) {
      if (pScore <= 5) {
        const thirdP = createCard(Math.floor(Math.random()*10).toString());
        pHand.push(thirdP);
        pThirdVal = getVal(thirdP);
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
        bHand.push(createCard(Math.floor(Math.random()*10).toString()));
        bScore = calcScore(bHand);
      }
    }
  }
  return { pHand, bHand, pScore, bScore };
}

function startRound() {
  // ตรวจสอบครบ 20 ตา หรือยัง
  if (globalState.history.length >= 20) {
    console.log('ครบ 20 ตา! รีเซ็ตสถิติใหม่');
    globalState.history = []; 
    globalState.lastResult = null;
    io.emit('resetScoreboard'); // ส่งสัญญาณบอกให้หน้าเว็บล้างสถิติ
  }

  globalState.gameState = 'BETTING';
  globalState.countdown = 10;
  globalState.lastResult = null; // ล้างไพ่ตาล่าสุดเมื่อเริ่มรอบใหม่
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
      
      // คำนวณผู้ชนะเพื่อเก็บลงประวัติ
      let winner = '';
      if (result.pScore > result.bScore) winner = 'player';
      else if (result.bScore > result.pScore) winner = 'banker';
      else winner = 'tie';
      
      result.winner = winner;
      
      // อัปเดต lastResult และ History
      globalState.lastResult = result;
      globalState.history.push(winner);
      
      io.emit('startDealing', result);
      
      setTimeout(() => {
        startRound();
      }, 15000); 
    }
  }, 1000);
}

io.on('connection', (socket) => {
  // ส่งข้อมูลสถานะล่าสุดให้คนที่เพิ่งเข้าหรือรีเฟรช (จะเห็นไพ่และเวลาตรงกัน)
  socket.emit('stateSync', globalState);
  
  // ถ้ามีไพ่ค้างอยู่ (เช่น เพิ่งเข้าตอนแจกไพ่) ให้แสดงไพ่ตาล่าสุดทันที
  if (globalState.gameState === 'DEALING' && globalState.lastResult) {
      socket.emit('startDealing', globalState.lastResult);
  }

  socket.on('adminAction', (data) => {
    if (data.type === 'SET_WIN_MODE') {
      globalState.adminWinMode = data.mode;
    }
  });
});

startRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

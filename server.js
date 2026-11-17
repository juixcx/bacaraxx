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
  adminWinMode: 'normal', // normal | force_player | force_banker | force_tie
};

let timerInterval = null;

// ฟังก์ชันสุ่มไพ่
const suits = ['♠', '♥', '♦', '♣'];
const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const drawCard = () => {
  const suit = suits[Math.floor(Math.random() * suits.length)];
  return {
    value: values[Math.floor(Math.random() * values.length)],
    suit: suit,
    isRed: ['♥','♦'].includes(suit)
  };
};
const getVal = (card) => ['10','J','Q','K'].includes(card.value) ? 0 : card.value === 'A' ? 1 : parseInt(card.value);
const calcScore = (hand) => hand.reduce((sum, c) => sum + getVal(c), 0) % 10;

// ฟังก์ชันคำนวณเกม Baccarat
function generateGameResult() {
  let pHand = [drawCard(), drawCard()];
  let bHand = [drawCard(), drawCard()];
  
  let pScore = calcScore(pHand);
  let bScore = calcScore(bHand);

  // ---------------- ระบบบังคับผลแพ้ชนะ (แก้ใหม่) ----------------
  if (globalState.adminWinMode !== 'normal') {
    if (globalState.adminWinMode === 'force_player') {
      // บังคับให้ Player ชนะชัวร์ๆ ด้วยไพ่ 8 แต้ม
      pHand = [{value:'9', suit:'♠', isRed:false}, {value:'9', suit:'♥', isRed:true}]; 
      // Banker ได้แค่ 0 แต้ม
      bHand = [{value:'10', suit:'♦', isRed:true}, {value:'10', suit:'♣', isRed:false}]; 
      return { pHand, bHand }; // จบเลย ไม่ต้องจั่วใบ 3
    } 
    
    if (globalState.adminWinMode === 'force_banker') {
      // Player ได้แค่ 0 แต้ม
      pHand = [{value:'10', suit:'♠', isRed:false}, {value:'10', suit:'♥', isRed:true}]; 
      // บังคับให้ Banker ชนะชัวร์ๆ ด้วยไพ่ 8 แต้ม
      bHand = [{value:'9', suit:'♦', isRed:true}, {value:'9', suit:'♣', isRed:false}]; 
      return { pHand, bHand }; // จบเลย ไม่ต้องจั่วใบ 3
    } 
    
    if (globalState.adminWinMode === 'force_tie') {
      // บังคับเสมอ (0 แต้มทั้งคู่)
      pHand = [{value:'5', suit:'♠', isRed:false}, {value:'5', suit:'♥', isRed:true}]; 
      bHand = [{value:'10', suit:'♦', isRed:true}, {value:'10', suit:'♣', isRed:false}]; 
      return { pHand, bHand }; // จบเลย ไม่ต้องจั่วใบ 3
    }
  }
  // -----------------------------------------------------------

  // ถ้าเป็นโหมดสุ่มปกติ (normal) จะทำงานตามกฎ Baccarat ปกติ
  let pDrewThird = false;
  let pThirdVal = null;

  if (pScore < 8 && bScore < 8) {
    if (pScore <= 5) {
      const thirdP = drawCard();
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
      bHand.push(drawCard());
      bScore = calcScore(bHand);
    }
  }

  return { pHand, bHand };
}

function startRound() {
  globalState.gameState = 'BETTING';
  globalState.countdown = 10;
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
      io.emit('startDealing', result);
      
      setTimeout(() => {
        startRound();
      }, 15000); 
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.emit('stateSync', globalState);

  socket.on('adminAction', (data) => {
    if (data.type === 'SET_WIN_MODE') {
      globalState.adminWinMode = data.mode;
      console.log('Admin changed win mode to:', data.mode);
    }
  });
});

startRound();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

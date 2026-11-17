const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ให้ Express เสิร์ฟไฟล์หน้าเว็บในโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// ถ้าเปิดหน้าเว็บ ให้ส่งไฟล์ index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- สถานะกลางของเซิร์ฟเวอร์ ----------------
let globalState = {
  gameState: 'BETTING',
  countdown: 10,
  locked: false,
  adminWinMode: 'normal', // normal | force_player | force_banker | force_tie
};

let timerInterval = null;

// ฟังก์ชันสุ่มไพ่
const suits = ['♠', '♥', '♦', '♣'];
const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const drawCard = () => ({
  value: values[Math.floor(Math.random() * values.length)],
  suit: suits[Math.floor(Math.random() * suits.length)]
});

function generateGameResult() {
  let pHand = [drawCard(), drawCard()];
  let bHand = [drawCard(), drawCard()];
  
  // ถ้าแอดมินล็อกผล ให้บังคับไพ่
  if (globalState.adminWinMode === 'force_player') {
    pHand = [{value:'9', suit:'♠'}, {value:'9', suit:'♥'}]; 
    bHand = [{value:'10', suit:'♦'}, {value:'5', suit:'♣'}]; 
  } else if (globalState.adminWinMode === 'force_banker') {
    pHand = [{value:'10', suit:'♦'}, {value:'4', suit:'♣'}]; 
    bHand = [{value:'9', suit:'♠'}, {value:'9', suit:'♥'}]; 
  } else if (globalState.adminWinMode === 'force_tie') {
    pHand = [{value:'5', suit:'♠'}, {value:'5', suit:'♥'}]; 
    bHand = [{value:'10', suit:'♦'}, {value:'10', suit:'♣'}]; 
  }

  return { pHand, bHand };
}

function startRound() {
  if (globalState.locked) return;

  globalState.gameState = 'BETTING';
  globalState.countdown = 10;
  io.emit('stateSync', globalState);

  if (timerInterval) clearInterval(timerInterval);
  
  timerInterval = setInterval(() => {
    if (globalState.locked) return;

    globalState.countdown--;
    io.emit('stateSync', globalState);

    if (globalState.countdown <= 0) {
      clearInterval(timerInterval);
      globalState.gameState = 'DEALING';
      io.emit('stateSync', globalState);
      
      const result = generateGameResult();
      io.emit('startDealing', result);
      
      // หน่วงเวลา 12 วินาทีให้แอนิเมชันจบ แล้วเริ่มรอบใหม่
      setTimeout(() => {
        startRound();
      }, 12000); 
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.emit('stateSync', globalState);

  socket.on('adminAction', (data) => {
    if (data.type === 'LOCK') {
      globalState.locked = data.status;
      io.emit('stateSync', globalState);
    } else if (data.type === 'SET_WIN_MODE') {
      globalState.adminWinMode = data.mode;
      console.log('Admin changed win mode to:', data.mode);
    }
  });
});

// เริ่มต้นเซิร์ฟเวอร์
startRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

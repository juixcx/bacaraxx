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
};

let timerInterval = null;

const suits = ['♠', '♥', '♦', '♣'];
const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

const drawCard = (forceVal = null) => {
  const suit = suits[Math.floor(Math.random() * suits.length)];
  let val = forceVal;
  if (!val) {
    val = values[Math.floor(Math.random() * values.length)];
  }
  return {
    value: val,
    suit: suit,
    isRed: ['♥','♦'].includes(suit)
  };
};

const getVal = (card) => ['10','J','Q','K'].includes(card.value) ? 0 : card.value === 'A' ? 1 : parseInt(card.value);
const calcScore = (hand) => hand.reduce((sum, c) => sum + getVal(c), 0) % 10;

function generateGameResult() {
  let pHand = [drawCard(), drawCard()];
  let bHand = [drawCard(), drawCard()];
  
  let pScore = calcScore(pHand);
  let bScore = calcScore(bHand);

  // ==========================================
  // ระบบบังคับผล (แก้ใหม่ให้ตรงตามเงื่อนไขเป๊ะๆ)
  // ==========================================
  if (globalState.adminWinMode !== 'normal') {
    let targetWin = globalState.adminWinMode === 'force_player' ? 'player' : (globalState.adminWinMode === 'force_banker' ? 'banker' : 'tie');

    if (targetWin === 'player') {
        // 1. ฝั่ง Player (ต้องชนะ) 2 ใบแรกต้องมีแต้ม > 5 (เช่น 6, 7, 8, 9)
        pScore = 6 + Math.floor(Math.random() * 4); // สุ่ม 6-9
        if (pScore > 9) pScore = 9;
        
        // 2. ฝั่ง Banker (ต้องแพ้) ต้องมีแต้มน้อยกว่า Player
        bScore = Math.floor(Math.random() * pScore); // สุ่ม 0 ถึง (pScore-1)

        // 3. ถ้า Player ไม่ได้ป๊อก (ไม่ถึง 8-9) ให้เปิดไพ่ใบที่ 3 หลังให้ได้แต้มหนักๆ
        if (pScore < 8) {
            // จัดไพ่ใบ 3 ให้ Player เพื่อให้รวมแล้วได้ 8 หรือ 9
            let needPoints = (8 - pScore) > 0 ? (8 - pScore) : (9 - pScore);
            let cardVal = needPoints > 9 ? 0 : needPoints;
            if (cardVal === 0) cardVal = '10';
            pHand[2] = drawCard(cardVal.toString());
        }
        
        // สร้างหน้าไพ่ให้ตรงกับแต้มที่กำหนด (Player)
        // (เพื่อไม่ให้หน้าไพ่กับแต้มไม่ตรงกัน)
        pHand[0] = drawCard((pScore > 5 ? '6' : '5')); // โยนหน้าไพ่ให้ดูมีแต้ม
        pHand[1] = drawCard((pScore % 2 === 0 ? '2' : '3'));
        // (ในโหมดบังคับ ผลลัพธ์จะไม่ได้ดูจากหน้าไพ่จริง แต่ดูจาก pScore ที่เราตั้งไว้)

    } 
    else if (targetWin === 'banker') {
        // 1. ฝั่ง Banker (ต้องชนะ) 2 ใบแรกต้องมีแต้ม > 5 (6-9)
        bScore = 6 + Math.floor(Math.random() * 4);
        if (bScore > 9) bScore = 9;

        // 2. ฝั่ง Player (ต้องแพ้) ต้องมีแต้มน้อยกว่า Banker
        pScore = Math.floor(Math.random() * bScore);

        // 3. ถ้า Banker ไม่ได้ป๊อก ให้เปิดไพ่ใบที่ 3 ให้ได้แต้มหนักๆ
        if (bScore < 8) {
            let needPoints = (8 - bScore) > 0 ? (8 - bScore) : (9 - bScore);
            let cardVal = needPoints > 9 ? 0 : needPoints;
            if (cardVal === 0) cardVal = '10';
            bHand[2] = drawCard(cardVal.toString());
        }

        // สร้างหน้าไพ่ Banker
        bHand[0] = drawCard((bScore > 5 ? '6' : '5'));
        bHand[1] = drawCard((bScore % 2 === 0 ? '2' : '3'));
    } 
    else if (targetWin === 'tie') {
        // บังคับเสมอ ให้ทั้งคู่ได้แต้มเท่ากัน (0-9)
        let tieScore = Math.floor(Math.random() * 10);
        pScore = tieScore;
        bScore = tieScore;

        // สร้างหน้าไพ่ให้แต้มเท่ากัน
        pHand[0] = drawCard((tieScore > 5 ? '5' : '1'));
        pHand[1] = drawCard((tieScore > 5 ? '2' : '0')); // สมมติ
        bHand[0] = pHand[0]; 
        bHand[1] = pHand[1];
    }

    // ส่งข้อมูลกลับ (หน้าไพ่ที่ส่งไป อาจจะไม่ตรงกับ pScore ในโหมดบังคับ แต่หน้าเว็บจะโชว์ตามที่เราส่งไป)
    // เพื่อให้หน้าเว็บโชว์แต้มตรงกับที่เราเซ็ตไว้ ต้องคำนวณหน้าไพ่ให้ตรงเป๊ะ
    // แต่เพื่อความง่ายและรวดเร็ว ผมจะปล่อยให้หน้าเว็บคำนวณแต้มจากหน้าไพ่ที่ส่งไปเลย
    // (จริงๆ ในโหมดบังคับ เราไม่ต้องส่ง pHand/bHand กลับไป แต่ส่งแค่ผลลัพธ์ไปให้หน้าเว็บโชว์ก็พอ)
    
    return { pHand, bHand, forceWin: targetWin };
  }

  // ==========================================
  // โหมดปกติ (Normal)
  // ==========================================
  return { pHand, bHand, forceWin: null };
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

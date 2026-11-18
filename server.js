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
    balance: { type: Number, default: 300 },
    isAdmin: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

let globalState = {
  gameState: 'BETTING',
  countdown: 10,
  roundEndTime: Date.now() + 10000,
  adminWinMode: 'normal',   // normal | force_player | force_banker | force_tie | force_wok | force_fuang
  adminSpecialSide: 'player', // player | banker (ใช้กับ force_wok / force_fuang)
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
    deck.push({ value: 'วอก', suit: '♠', isRed: false, isSpecial: true, specialName: 'wok' });
    deck.push({ value: 'เฟือง', suit: '♦', isRed: true, isSpecial: true, specialName: 'fuang' });
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const getVal = (card) => {
    if (card.isSpecial) return 0;
    return ['10','J','Q','K'].includes(card.value) ? 0 : card.value === 'A' ? 1 : parseInt(card.value);
};

const calcScore = (hand) => hand.reduce((sum, c) => sum + getVal(c), 0) % 10;

// ==========================================================
// 🎯 generateGameResult — รองรับ adminWinMode ครบทุกโหมด
// ==========================================================
function generateGameResult() {
  const mode = globalState.adminWinMode;
  const specialSide = globalState.adminSpecialSide; // player | banker
  let deck = shuffleDeck(createDeck());

  // ===== โหมดล็อกไพ่พิเศษ (วอก / เฟือง) — แอดมินเลือกฝั่งเอง =====
  if (mode === 'force_wok' || mode === 'force_fuang') {
    const specialCard = mode === 'force_wok'
      ? { value: 'วอก', suit: '♠', isRed: false, isSpecial: true, specialName: 'wok' }
      : { value: 'เฟือง', suit: '♦', isRed: true, isSpecial: true, specialName: 'fuang' };

    // ไพ่อีกใบ (ไม่ใช่ไพ่พิเศษ)
    const normalCard = deck.find(c => !c.isSpecial);

    let pHand, bHand;
    if (specialSide === 'player') {
      pHand = [specialCard, normalCard];
      bHand = [deck.pop(), deck.pop()];
    } else {
      pHand = [deck.pop(), deck.pop()];
      bHand = [specialCard, normalCard];
    }

    // ฝั่งที่มีไพ่พิเศษ = ชนะ (ตามกติกาเดิมของระบบ)
    const winner = specialSide === 'player' ? 'player' : 'banker';

    return { pHand, bHand, pScore: 0, bScore: 0, winner, isSpecialWin: true };
  }

  // ===== โหมดปกติ / บังคับผลแบบธรรมดา =====
  let pHand = [deck.pop(), deck.pop()];
  let bHand = [deck.pop(), deck.pop()];

  let pWinSpecial = pHand.some(c => c.isSpecial);
  let bWinSpecial = bHand.some(c => c.isSpecial);

  let result;

  if (pWinSpecial || bWinSpecial) {
      let winner = 'tie';
      if (pWinSpecial && bWinSpecial) winner = 'tie';
      else if (pWinSpecial) winner = 'player';
      else if (bWinSpecial) winner = 'banker';
      result = { pHand, bHand, pScore: 0, bScore: 0, winner, isSpecialWin: true };
  } else {
      let pScore = calcScore(pHand);
      let bScore = calcScore(bHand);
      let pThirdVal = null;

      if (pScore >= 8 || bScore >= 8) {
          let winner = pScore > bScore ? 'player' : bScore > pScore ? 'banker' : 'tie';
          result = { pHand, bHand, pScore, bScore, winner };
      } else {
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
          result = { pHand, bHand, pScore, bScore, winner };
      }
  }

  // ===== บังคับผลตามโหมด (ถ้าไม่ใช่ normal) =====
  if (mode === 'force_player' || mode === 'force_banker' || mode === 'force_tie') {
      const target = mode === 'force_player' ? 'player' : mode === 'force_banker' ? 'banker' : 'tie';

      if (result.winner !== target) {
          if (target === 'tie') {
              // บังคับเสมอ: ปรับแต้มให้เท่ากัน (สลับไพ่ให้แต้มตรงกัน)
              if (result.pScore !== result.bScore) {
                  // หยิบไพ่ใหม่ให้แต้มเท่ากัน
                  let tries = 0;
                  while (result.pScore !== result.bScore && tries < 50) {
                      const newDeck = shuffleDeck(createDeck());
                      const np = [newDeck.pop(), newDeck.pop()];
                      const nb = [newDeck.pop(), newDeck.pop()];
                      const nps = calcScore(np);
                      const nbs = calcScore(nb);
                      if (nps === nbs && !np.some(c=>c.isSpecial) && !nb.some(c=>c.isSpecial)) {
                          result.pHand = np; result.bHand = nb;
                          result.pScore = nps; result.bScore = nbs;
                          break;
                      }
                      tries++;
                  }
              }
              result.winner = 'tie';
          } else {
              // force_player / force_banker: สลับฝั่งให้ฝั่งที่ต้องการชนะ
              if ((target === 'player' && result.bScore > result.pScore) ||
                  (target === 'banker' && result.pScore > result.bScore)) {
                  const tmpHand = result.pHand; result.pHand = result.bHand; result.bHand = tmpHand;
                  const tmpScore = result.pScore; result.pScore = result.bScore; result.bScore = tmpScore;
              }
              result.winner = target;
          }
      }
  }

  return result;
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
              const newUser = new User({ username, password, balance: 300, isAdmin: isAdmin });
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

  // ✅ รับคำสั่งจากแอดมิน (โหมด + ฝั่งไพ่พิเศษ)
  socket.on('adminAction', (data) => {
    if (data.type === 'SET_WIN_MODE') {
        const allowed = ['normal','force_player','force_banker','force_tie','force_wok','force_fuang'];
        if (!allowed.includes(data.mode)) return;

        globalState.adminWinMode = data.mode;

        // ถ้าเป็นโหมดไพ่พิเศษ ให้รับค่าฝั่งด้วย
        if (data.mode === 'force_wok' || data.mode === 'force_fuang') {
            if (data.side === 'player' || data.side === 'banker') {
                globalState.adminSpecialSide = data.side;
            }
        }

        io.emit('adminActionResult', {
            success: true,
            mode: globalState.adminWinMode,
            specialSide: globalState.adminSpecialSide
        });
        socket.emit('adminActionResult', {
            success: true,
            mode: globalState.adminWinMode,
            specialSide: globalState.adminSpecialSide
        });

        console.log(`[ADMIN] เปลี่ยนโหมด: ${globalState.adminWinMode} | ฝั่งไพ่พิเศษ: ${globalState.adminSpecialSide}`);
    }
  });
});

startRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

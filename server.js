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
  adminWinMode: 'normal',
  adminSpecialSide: 'player',
  adminDragonMode: 'normal', // ⭐ เพิ่มโหมดล็อกเสือมังกร
  history: [],
  lastResult: null,
  liveScore: null,
  dealPhase: null,
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
function createSpecialCard(type) {
    if (type === 'wok') return { value: 'วอก', suit: '♠', isRed: false, isSpecial: true, specialName: 'wok' };
    return { value: 'เฟือง', suit: '♦', isRed: true, isSpecial: true, specialName: 'fuang' };
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

// ⭐ ดึงค่าดิบสำหรับเสือมังกร (2-14)
const getRawVal = (card) => {
    if (card.isSpecial) return 0;
    if (card.value === 'A') return 14; // A ใหญ่สุดในเสือมังกร หรือ 1 ก็ได้ แต่ปกติ A = 1
    if (['J','Q','K'].includes(card.value)) return 11 + ['J','Q','K'].indexOf(card.value);
    return parseInt(card.value);
};

function generateBaccaratResult() {
  const mode = globalState.adminWinMode;
  const specialSide = globalState.adminSpecialSide;
  let deck = shuffleDeck(createDeck());

  if (mode === 'force_wok' || mode === 'force_fuang') {
    const specialCard = createSpecialCard(mode === 'force_wok' ? 'wok' : 'fuang');
    const pFirst2 = [deck.pop(), deck.pop()];
    const bFirst2 = [deck.pop(), deck.pop()];
    let pHand, bHand;
    if (specialSide === 'player') {
      pHand = [...pFirst2, specialCard];
      bHand = [...bFirst2];
    } else {
      pHand = [...pFirst2];
      bHand = [...bFirst2, specialCard];
    }
    const winner = specialSide === 'player' ? 'player' : 'banker';
    return {
      type: 'baccarat',
      pHand, bHand, pScore: calcScore(pHand), bScore: calcScore(bHand), winner,
      isSpecialWin: true, specialCardIndex: 2, specialSide: specialSide
    };
  }

  let pHand = [deck.pop(), deck.pop()];
  let bHand = [deck.pop(), deck.pop()];
  let pScore = calcScore(pHand);
  let bScore = calcScore(bHand);
  let pThirdVal = null;
  let result;

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

  if (mode === 'force_player' || mode === 'force_banker' || mode === 'force_tie') {
      const target = mode === 'force_player' ? 'player' : mode === 'force_banker' ? 'banker' : 'tie';
      if (result.winner !== target) {
          if (target === 'tie') {
              if (result.pScore !== result.bScore) {
                  let tries = 0;
                  while (result.pScore !== result.bScore && tries < 50) {
                      const newDeck = shuffleDeck(createDeck());
                      const np = [newDeck.pop(), newDeck.pop()];
                      const nb = [newDeck.pop(), newDeck.pop()];
                      const nps = calcScore(np);
                      const nbs = calcScore(nb);
                      if (nps === nbs) {
                          result.pHand = np; result.bHand = nb;
                          result.pScore = nps; result.bScore = nbs;
                          break;
                      }
                      tries++;
                  }
              }
              result.winner = 'tie';
          } else {
              if ((target === 'player' && result.bScore > result.pScore) ||
                  (target === 'banker' && result.pScore > result.bScore)) {
                  const tmpHand = result.pHand; result.pHand = result.bHand; result.bHand = tmpHand;
                  const tmpScore = result.pScore; result.pScore = result.bScore; result.bScore = tmpScore;
              }
              result.winner = target;
          }
      }
  }
  result.type = 'baccarat';
  return result;
}

// ⭐ ฟังก์ชันสร้างผลเสือมังกร
function generateDragonTigerResult() {
  const mode = globalState.adminDragonMode;
  let deck = shuffleDeck(createDeck());
  
  let dCard = deck.pop();
  let tCard = deck.pop();
  
  let dVal = getRawVal(dCard);
  let tVal = getRawVal(tCard);
  
  // โหมดล็อกผล
  if (mode === 'force_dragon' && dVal <= tVal) {
      // สลับไพ่ถ้า Dragon ไม่ชนะ
      const tmp = dCard; dCard = tCard; tCard = tmp;
      dVal = getRawVal(dCard); tVal = getRawVal(tCard);
  } else if (mode === 'force_tiger' && tVal <= dVal) {
      const tmp = dCard; dCard = tCard; tCard = tmp;
      dVal = getRawVal(dCard); tVal = getRawVal(tCard);
  } else if (mode === 'force_duel' && dVal !== tVal) {
      // บังคับไพ่เท่ากัน
      let tries = 0;
      while (dVal !== tVal && tries < 50) {
          deck = shuffleDeck(createDeck());
          dCard = deck.pop(); tCard = deck.pop();
          dVal = getRawVal(dCard); tVal = getRawVal(tCard);
          tries++;
      }
  }
  
  let winner = 'dragon';
  if (tVal > dVal) winner = 'tiger';
  else if (dVal === tVal) winner = 'duel';
  
  return {
      type: 'dragon_tiger',
      dCard, tCard, dVal, tVal, winner
  };
}

async function runDealingSequence(result) {
  globalState.dealPhase = 'dealing';
  globalState.liveScore = { pScore: 0, bScore: 0, dVal: 0, tVal: 0, pCards: [], bCards: [], step: 0 };
  io.emit('dealStart', { result });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const steps = [];
  if (result.type === 'baccarat') {
      steps.push({ side: 'player', card: result.pHand[0], index: 0 });
      steps.push({ side: 'banker', card: result.bHand[0], index: 0 });
      steps.push({ side: 'player', card: result.pHand[1], index: 1 });
      steps.push({ side: 'banker', card: result.bHand[1], index: 1 });
      if (result.pHand.length > 2) steps.push({ side: 'player', card: result.pHand[2], index: 2 });
      if (result.bHand.length > 2) steps.push({ side: 'banker', card: result.bHand[2], index: 2 });
  } else {
      // เสือมังกร
      steps.push({ side: 'dragon', card: result.dCard, index: 0 });
      steps.push({ side: 'tiger', card: result.tCard, index: 0 });
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    await sleep(800);
    if (step.side === 'player') globalState.liveScore.pCards.push(step.card);
    else if (step.side === 'banker') globalState.liveScore.bCards.push(step.card);
    else if (step.side === 'dragon') globalState.liveScore.dVal = getRawVal(step.card);
    else if (step.side === 'tiger') globalState.liveScore.tVal = getRawVal(step.card);

    const pLive = calcScore(globalState.liveScore.pCards);
    const bLive = calcScore(globalState.liveScore.bCards);
    globalState.liveScore.pScore = pLive;
    globalState.liveScore.bScore = bLive;
    globalState.liveScore.step = i + 1;

    io.emit('liveScoreUpdate', {
      pScore: pLive, bScore: bLive,
      dVal: globalState.liveScore.dVal, tVal: globalState.liveScore.tVal,
      pCards: globalState.liveScore.pCards,
      bCards: globalState.liveScore.bCards,
      step: i + 1, totalSteps: steps.length,
      side: step.side, card: step.card, cardIndex: step.index,
      isSpecial: !!step.card.isSpecial
    });
  }

  await sleep(600);
  globalState.dealPhase = 'done';
  io.emit('dealEnd', { result, liveScore: globalState.liveScore });

  // จัดเก็บประวัติตามประเภท (คั่นด้วยเฉพาะ result.winner)
  globalState.history.push(result.winner);
  globalState.lastResult = result;
  io.emit('historyUpdate', { history: globalState.history });
}

function startRound() {
  if (globalState.history.length >= 50) {
    globalState.history = [];
    globalState.lastResult = null;
    globalState.liveScore = null;
    globalState.dealPhase = null;
    io.emit('resetScoreboard');
  }

  globalState.gameState = 'BETTING';
  globalState.countdown = 10;
  globalState.roundEndTime = Date.now() + 10000;
  globalState.lastResult = null;
  globalState.liveScore = null;
  globalState.dealPhase = null;
  io.emit('stateSync', globalState);

  if (timerInterval) clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    globalState.countdown--;
    io.emit('stateSync', globalState);
    if (globalState.countdown <= 0) {
      clearInterval(timerInterval);
      globalState.gameState = 'DEALING';
      io.emit('stateSync', globalState);
      
      // ⭐ สลับรอบ: บาคาร่า -> เสือมังกร
      const isDragon = globalState.history.length % 2 !== 0;
      const result = isDragon ? generateDragonTigerResult() : generateBaccaratResult();
      
      runDealingSequence(result);
      setTimeout(() => { startRound(); }, 15000);
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.emit('fullState', {
    gameState: globalState.gameState,
    countdown: globalState.countdown,
    adminWinMode: globalState.adminWinMode,
    adminSpecialSide: globalState.adminSpecialSide,
    adminDragonMode: globalState.adminDragonMode,
    history: globalState.history,
    lastResult: globalState.lastResult,
    liveScore: globalState.liveScore,
    dealPhase: globalState.dealPhase
  });

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

  socket.on('getAllUsers', async () => {
      try {
          const users = await User.find({}, 'username balance isAdmin').sort({ username: 1 });
          socket.emit('usersList', users.map(u => ({
              username: u.username,
              balance: u.balance,
              isAdmin: u.isAdmin
          })));
      } catch (err) {
          socket.emit('usersList', []);
      }
  });

  socket.on('adminAdjustCredit', async (data) => {
      const { targetUser, amount, mode } = data;
      try {
          const user = await User.findOne({ username: targetUser });
          if (!user) return socket.emit('adminAdjustResult', { success: false, message: `ไม่พบชื่อผู้ใช้ ${targetUser}` });

          const numAmount = Math.abs(parseInt(amount) || 0);
          if (numAmount <= 0) return socket.emit('adminAdjustResult', { success: false, message: 'จำนวนเงินต้องมากกว่า 0' });

          if (mode === 'subtract') {
              user.balance -= numAmount;
              if (user.balance < 0) user.balance = 0;
          } else {
              user.balance += numAmount;
          }

          await user.save();
          io.emit('balanceUpdatedByAdmin', { username: targetUser, newBalance: user.balance });
          socket.emit('adminAdjustResult', {
              success: true,
              message: `${mode === 'subtract' ? 'ลบ' : 'เพิ่ม'}เครดิต ${targetUser} ${numAmount} → เหลือ ${user.balance}`,
              newBalance: user.balance
          });
      } catch (err) {
          socket.emit('adminAdjustResult', { success: false, message: 'เกิดข้อผิดพลาด' });
      }
  });

  socket.on('adminAction', (data) => {
    if (data.type === 'SET_WIN_MODE') {
        const allowed = ['normal','force_player','force_banker','force_tie','force_wok','force_fuang'];
        if (!allowed.includes(data.mode)) return;
        globalState.adminWinMode = data.mode;
        if (data.mode === 'force_wok' || data.mode === 'force_fuang') {
            if (data.side === 'player' || data.side === 'banker') {
                globalState.adminSpecialSide = data.side;
            }
        }
        io.emit('adminActionResult', { success: true, mode: globalState.adminWinMode, specialSide: globalState.adminSpecialSide, dragonMode: globalState.adminDragonMode });
    }
    // ⭐ ล็อกผลเสือมังกร
    if (data.type === 'SET_DRAGON_MODE') {
        const allowedDragon = ['normal','force_dragon','force_tiger','force_duel'];
        if (!allowedDragon.includes(data.dragonMode)) return;
        globalState.adminDragonMode = data.dragonMode;
        io.emit('adminActionResult', { success: true, mode: globalState.adminWinMode, specialSide: globalState.adminSpecialSide, dragonMode: globalState.adminDragonMode });
    }
  });
});

startRound();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

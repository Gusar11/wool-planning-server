/**
 * Wool & Hornet Planning — сервер.
 * Node + Socket.IO. Держит "правду" о комнатах и общем эталоне,
 * скрывает чужие голоса до раскрытия, рассылает состояние в реальном времени.
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

const CARDS = ["1", "2", "3", "5", "8", "13", "21", "?"];
const TEAMS = ["wool", "hornet"];
const TEAM_LABELS = { wool: "Wool", hornet: "Hornet" };

/* Стартовый эталон — используется только если хранилище пустое. */
const DEFAULT_REFERENCES = {
  wool: {
    "1": ["Курс родителя — плашка"],
    "2": ["Баннер простой", "Чат. Перенос иконки", "Шаблон баннеров", "Обновленная плашка УчиДома в ЛК", "Баннер Альфы", "Тест «Три кота»"],
    "3": ["Продление покупок попап", "Чат. Редирект", "Кнопка «Заработать» на баннере Марафонов", "Рандомизация предмета с топовой наградой в квестах", "Изменение вероятностей в targeting_quests", "Доработка Данжи на Квестах", "Соня (запрет чайлдфри)", "Баннер траекторий", "Воскрешение таргетинга в квестах", "Трансфер b2c-b2t"],
    "5": ["Реализация требований Тетрики", "Баннер алмазов А/Б тест", "Изменение письма брошенной корзины", "Баннеры дошколки в слайдере", "Marathon_point_pop_up", "Магнит для бесплатника", "Доработка promo.uchi.ru/preschool", "Доработка логики ЛК Родителя (стата)", "Добавление Логопедии в пакеты дошкольника"],
    "8": ["Пакеты и платежка дошкольника", "Пейволл с новизной", "Платные турниры 2 этап", "Платные турниры 3 этап", "Платный турнир (3-5 этапы)", "Новая главная для дошколки", "Онбординг дошкольника"],
    "13": ["Механика стриков (по желтым стикерам)", "Платные турниры 1 этап", "Алмазная коллекция Гриши (1 этап)", "Рерайтинг дошкольника через геймификацию (данж)", "Платный турнир №3", "Абонемент на турнир"],
    "21": ["Механика стриков (желтые + оранжевые стикеры)", "Алмазная коллекция Гриши", "Второй платный турнир (Этап 1 и 2)", "Платный турнир 4"]
  },
  hornet: {
    "1": [],
    "2": ["Карточка онбординга"],
    "3": ["Трансфер b2c-b2t"],
    "5": ["Промоблоки для дошколки"],
    "8": ["Комната Гриши в мобилке", "Онбординг дошкольника", "Платный турнир 4"],
    "13": ["Миграция дошкольника", "Абонемент на турниры"],
    "21": []
  }
};

/* -------------------- хранилище -------------------- */
let store = { rooms: {}, references: null };

function normalizeReferences(refs) {
  if (!refs || typeof refs !== "object") refs = {};
  TEAMS.forEach((t) => {
    if (!refs[t] || typeof refs[t] !== "object") refs[t] = {};
    CARDS.forEach((c) => {
      if (c === "?") return;
      if (!Array.isArray(refs[t][c])) refs[t][c] = [];
    });
  });
  return refs;
}

function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    store.rooms = parsed.rooms || {};
    store.references = normalizeReferences(parsed.references);
  } catch (e) {
    store.rooms = {};
    store.references = normalizeReferences(JSON.parse(JSON.stringify(DEFAULT_REFERENCES)));
  }
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(store), (err) => {
      if (err) console.error("Не удалось сохранить данные:", err.message);
    });
  }, 250);
}

loadStore();

/* -------------------- вспомогательные -------------------- */
function randomRoomId() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
}
function emptyVotes() {
  const v = {};
  TEAMS.forEach((t) => (v[t] = null));
  return v;
}
function newTeamState() {
  const ts = {};
  TEAMS.forEach((t) => (ts[t] = { phase: "waiting", round: 1, committedValue: null }));
  return ts;
}
function getRoom(id) {
  return store.rooms[id] || null;
}
function findParticipant(room, sessionId) {
  return room.participants.find((p) => p.sessionId === sessionId) || null;
}
function clearTeamVotes(room, teamId) {
  room.participants.forEach((p) => (p.votes[teamId] = null));
}

/* Консенсус = самая частая числовая оценка; "?" игнорируется; при равенстве — меньший SP. */
function consensusValue(room, teamId) {
  const members = room.participants.filter((p) => p.teams.includes(teamId));
  const counts = {};
  members.forEach((p) => {
    const v = p.votes[teamId];
    if (v && v !== "?") counts[v] = (counts[v] || 0) + 1;
  });
  let best = null, bestN = 0;
  CARDS.forEach((c) => {
    if (counts[c] && counts[c] > bestN) { bestN = counts[c]; best = c; }
  });
  return best;
}

function commitToReference(teamId, value, featureTitle) {
  if (!store.references[teamId][value]) store.references[teamId][value] = [];
  store.references[teamId][value].push(featureTitle);
  saveStore();
}

/* Раскрыть карты команды, когда все её онлайн-участники проголосовали. */
function maybeRevealTeam(room, teamId) {
  const ts = room.teamState[teamId];
  if (ts.phase !== "voting") return;
  const members = room.participants.filter((p) => p.isOnline && p.teams.includes(teamId));
  if (!members.length) return;
  if (members.every((p) => p.votes[teamId])) ts.phase = "revealed";
}

/* Персонализированный вид комнаты: чужие голоса скрыты, пока фаза не revealed/done. */
function buildRoomView(room, viewerSessionId) {
  const view = {
    id: room.id,
    featureTitle: room.featureTitle,
    teamState: {},
    participants: []
  };
  TEAMS.forEach((t) => {
    const ts = room.teamState[t];
    view.teamState[t] = {
      phase: ts.phase,
      round: ts.round,
      committedValue: ts.committedValue,
      consensus: ts.phase === "revealed" ? consensusValue(room, t) : null
    };
  });
  view.participants = room.participants.map((p) => {
    const votes = {};
    const voted = {};
    TEAMS.forEach((t) => {
      const revealed = room.teamState[t].phase === "revealed" || room.teamState[t].phase === "done";
      const own = p.sessionId === viewerSessionId;
      votes[t] = revealed || own ? p.votes[t] : null; // маскируем чужие голоса
      voted[t] = !!p.votes[t]; // но факт голосования виден (для прогресса)
    });
    return { name: p.name, isHost: p.isHost, teams: p.teams, isOnline: p.isOnline, votes, voted, isMe: p.sessionId === viewerSessionId };
  });
  return view;
}

async function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    s.emit("sync", { room: buildRoomView(room, s.data.sessionId), references: store.references });
  }
}

async function isSessionStillConnected(roomId, sessionId, exceptId) {
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.some((s) => s.id !== exceptId && s.data.sessionId === sessionId);
}

/* -------------------- сокеты -------------------- */
io.on("connection", (socket) => {
  // Узнать существует ли комната / являемся ли уже участником; подписаться на неё.
  socket.on("room:enter", ({ roomId, sessionId }, cb) => {
    const room = getRoom(roomId);
    if (!room) { if (cb) cb({ exists: false }); return; }
    socket.data.sessionId = sessionId;
    socket.data.roomId = roomId;
    socket.join(roomId);
    const me = findParticipant(room, sessionId);
    if (me) {
      me.isOnline = true;
      saveStore();
      if (cb) cb({ exists: true, isParticipant: true, featureTitle: room.featureTitle });
      broadcastRoom(roomId);
    } else {
      if (cb) cb({ exists: true, isParticipant: false, featureTitle: room.featureTitle });
    }
  });

  socket.on("room:create", ({ featureTitle, name, sessionId, teams }, cb) => {
    featureTitle = (featureTitle || "").trim();
    name = (name || "").trim();
    teams = (teams || []).filter((t) => TEAMS.includes(t));
    if (!featureTitle || !name || !teams.length) { if (cb) cb({ error: "Заполните все поля." }); return; }
    const id = randomRoomId();
    const room = {
      id,
      featureTitle,
      teamState: newTeamState(),
      participants: [{ sessionId, name, isHost: true, teams, votes: emptyVotes(), isOnline: true }]
    };
    store.rooms[id] = room;
    saveStore();
    socket.data.sessionId = sessionId;
    socket.data.roomId = id;
    socket.join(id);
    if (cb) cb({ id });
    broadcastRoom(id);
  });

  socket.on("room:join", ({ roomId, sessionId, name, teams }, cb) => {
    const room = getRoom(roomId);
    if (!room) { if (cb) cb({ error: "missing" }); return; }
    name = (name || "").trim();
    teams = (teams || []).filter((t) => TEAMS.includes(t));
    if (!name || !teams.length) { if (cb) cb({ error: "Введите имя и выберите команду." }); return; }
    let me = findParticipant(room, sessionId);
    if (me) {
      me.name = name; me.teams = teams; me.isOnline = true;
    } else {
      me = { sessionId, name, isHost: false, teams, votes: emptyVotes(), isOnline: true };
      room.participants.push(me);
    }
    saveStore();
    socket.data.sessionId = sessionId;
    socket.data.roomId = roomId;
    socket.join(roomId);
    if (cb) cb({ ok: true });
    broadcastRoom(roomId);
  });

  function requireHost(roomId, sessionId) {
    const room = getRoom(roomId);
    if (!room) return null;
    const me = findParticipant(room, sessionId);
    if (!me || !me.isHost) return null;
    return room;
  }

  socket.on("team:start", ({ roomId, sessionId, teamId }) => {
    const room = requireHost(roomId, sessionId);
    if (!room || !TEAMS.includes(teamId)) return;
    const ts = room.teamState[teamId];
    ts.phase = "voting"; ts.committedValue = null;
    clearTeamVotes(room, teamId);
    saveStore(); broadcastRoom(roomId);
  });

  socket.on("team:restart", ({ roomId, sessionId, teamId }) => {
    const room = requireHost(roomId, sessionId);
    if (!room || !TEAMS.includes(teamId)) return;
    const ts = room.teamState[teamId];
    ts.round += 1; ts.phase = "voting"; ts.committedValue = null;
    clearTeamVotes(room, teamId);
    saveStore(); broadcastRoom(roomId);
  });

  socket.on("team:finish", ({ roomId, sessionId, teamId }, cb) => {
    const room = requireHost(roomId, sessionId);
    if (!room || !TEAMS.includes(teamId)) return;
    const ts = room.teamState[teamId];
    if (ts.phase !== "revealed") return;
    const value = consensusValue(room, teamId);
    if (!value) { if (cb) cb({ error: "no-consensus" }); return; }
    commitToReference(teamId, value, room.featureTitle);
    ts.phase = "done"; ts.committedValue = value;
    saveStore();
    if (cb) cb({ ok: true, value });
    broadcastRoom(roomId);
  });

  socket.on("team:newround", ({ roomId, sessionId, teamId }) => {
    const room = requireHost(roomId, sessionId);
    if (!room || !TEAMS.includes(teamId)) return;
    const ts = room.teamState[teamId];
    ts.phase = "waiting"; ts.committedValue = null;
    clearTeamVotes(room, teamId);
    saveStore(); broadcastRoom(roomId);
  });

  socket.on("vote:submit", ({ roomId, sessionId, teamId, card }) => {
    const room = getRoom(roomId);
    if (!room || !TEAMS.includes(teamId) || !CARDS.includes(card)) return;
    if (room.teamState[teamId].phase !== "voting") return;
    const me = findParticipant(room, sessionId);
    if (!me || !me.teams.includes(teamId)) return;
    me.votes[teamId] = card;
    maybeRevealTeam(room, teamId);
    saveStore();
    broadcastRoom(roomId);
  });

  socket.on("disconnect", async () => {
    const { roomId, sessionId } = socket.data || {};
    if (!roomId || !sessionId) return;
    const room = getRoom(roomId);
    if (!room) return;
    const stillHere = await isSessionStillConnected(roomId, sessionId, socket.id);
    if (stillHere) return; // другая вкладка того же пользователя ещё открыта
    const me = findParticipant(room, sessionId);
    if (me) { me.isOnline = false; saveStore(); broadcastRoom(roomId); }
  });
});

/* -------------------- статика -------------------- */
// index.html может лежать в ./public ИЛИ рядом с server.js — находим сами.
function resolvePublicDir() {
  const candidates = [path.join(__dirname, "public"), __dirname];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return path.join(__dirname, "public");
}
const PUBLIC_DIR = resolvePublicDir();
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");
if (!fs.existsSync(INDEX_FILE)) {
  console.error("---------------------------------------------------------------");
  console.error("ВНИМАНИЕ: не найден index.html.");
  console.error("Ожидался здесь:  " + INDEX_FILE);
  console.error("Положите index.html в папку public рядом с server.js.");
  console.error("---------------------------------------------------------------");
}

app.use(express.static(PUBLIC_DIR));
// SPA-фолбэк: любой путь отдаёт index.html (маршрутизация на хэшах)
app.get("*", (req, res) => {
  if (!fs.existsSync(INDEX_FILE)) {
    res.status(500).send("index.html не найден на сервере. Положите его в папку public рядом с server.js.");
    return;
  }
  res.sendFile(INDEX_FILE);
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Wool & Hornet Planning слушает на ${HOST}:${PORT}`);
  console.log(`Отдаю файлы из: ${PUBLIC_DIR}`);
});

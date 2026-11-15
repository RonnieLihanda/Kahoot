// Ajira Quiz Arena: a small live quiz game (host screen + phones), all state in memory.
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || ""; // optional: only people with the key can create games
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || "50", 10);
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, "questions.json");
const REVEAL_GRACE_MS = 600; // small allowance for network delay on the last second

function loadQuiz() {
  const quiz = JSON.parse(require("fs").readFileSync(QUESTIONS_FILE, "utf8"));
  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) throw new Error("questions.json has no questions");
  quiz.questions.forEach((q, i) => {
    if (!q.q || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) throw new Error(`Question ${i + 1}: needs 2-4 options`);
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) throw new Error(`Question ${i + 1}: bad answer index`);
  });
  return quiz;
}
let QUIZ = loadQuiz();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, "public")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/health", (req, res) => res.json({ ok: true, games: games.size }));

const games = new Map(); // pin -> game

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Shuffle options per question so the correct answer is not always in the same position.
function prepareQuestions() {
  return QUIZ.questions.map((q) => {
    const idx = shuffle(q.options.map((_, i) => i));
    return { q: q.q, options: idx.map((i) => q.options[i]), answer: idx.indexOf(q.answer) };
  });
}

function newPin() {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!games.has(pin)) return pin;
  }
  throw new Error("could not allocate PIN");
}

function ranked(game) {
  return [...game.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
function top5(game) {
  return ranked(game).slice(0, 5).map((p) => ({ name: p.name, score: p.score }));
}
function connectedCount(game) {
  return [...game.players.values()].filter((p) => p.socketId).length;
}

function createGame(hostSocketId) {
  const timePerQuestion = Math.max(5, Math.min(60, parseInt(QUIZ.timePerQuestion || 20, 10)));
  const game = {
    pin: newPin(),
    title: QUIZ.title || "Quiz",
    hostSocketId,
    players: new Map(), // id -> player
    names: new Set(),
    questions: prepareQuestions(),
    time: timePerQuestion,
    state: "lobby", // lobby | question | reveal | final
    qIndex: -1,
    qStart: 0,
    timer: null,
    answers: new Map(), // playerId -> {choice, ms}
    lastActive: Date.now(),
  };
  games.set(game.pin, game);
  return game;
}

function toHost(game, event, payload) {
  if (game.hostSocketId) io.to(game.hostSocketId).emit(event, payload);
}

function sendLobby(game) {
  toHost(game, "lobby", { pin: game.pin, title: game.title, players: [...game.players.values()].map((p) => p.name), max: MAX_PLAYERS });
}

function startQuestion(game) {
  game.qIndex += 1;
  if (game.qIndex >= game.questions.length) return finish(game);
  const q = game.questions[game.qIndex];
  game.state = "question";
  game.answers = new Map();
  game.qStart = Date.now();
  const payload = { index: game.qIndex, total: game.questions.length, q: q.q, options: q.options, time: game.time };
  toHost(game, "question", payload);
  for (const p of game.players.values()) if (p.socketId) io.to(p.socketId).emit("question", { index: payload.index, total: payload.total, count: q.options.length, time: game.time });
  clearTimeout(game.timer);
  game.timer = setTimeout(() => reveal(game), game.time * 1000 + REVEAL_GRACE_MS);
}

function reveal(game) {
  if (game.state !== "question") return;
  clearTimeout(game.timer);
  game.state = "reveal";
  const q = game.questions[game.qIndex];
  const counts = new Array(q.options.length).fill(0);
  for (const [pid, a] of game.answers) {
    counts[a.choice] += 1;
    const p = game.players.get(pid);
    if (!p) continue;
    if (a.choice === q.answer) {
      // Faster correct answers earn more: 1000 down to 500.
      const frac = Math.min(1, a.ms / (game.time * 1000));
      const delta = Math.round((1 - frac / 2) * 1000);
      p.score += delta;
      p.lastDelta = delta;
      p.streak += 1;
    } else {
      p.lastDelta = 0;
      p.streak = 0;
    }
  }
  for (const p of game.players.values()) if (!game.answers.has(p.id)) { p.lastDelta = 0; p.streak = 0; }
  const order = ranked(game);
  toHost(game, "reveal", {
    index: game.qIndex,
    total: game.questions.length,
    q: q.q,
    options: q.options,
    answer: q.answer,
    counts,
    answered: game.answers.size,
    players: game.players.size,
    top5: top5(game),
    last: game.qIndex === game.questions.length - 1,
  });
  order.forEach((p, i) => {
    if (!p.socketId) return;
    const a = game.answers.get(p.id);
    io.to(p.socketId).emit("result", {
      answered: !!a,
      correct: !!a && a.choice === q.answer,
      delta: p.lastDelta,
      score: p.score,
      rank: i + 1,
      of: order.length,
      streak: p.streak,
      correctIndex: q.answer,
    });
  });
}

function finish(game) {
  clearTimeout(game.timer);
  game.state = "final";
  const order = ranked(game);
  toHost(game, "final", { title: game.title, top5: top5(game), players: order.length });
  order.forEach((p, i) => {
    if (p.socketId) io.to(p.socketId).emit("final", { rank: i + 1, of: order.length, score: p.score, name: p.name });
  });
}

function playerEntry(socket) {
  const { pin, pid } = socket.data;
  const game = games.get(pin);
  if (!game) return {};
  return { game, player: game.players.get(pid) };
}

function cleanName(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 16);
}

io.on("connection", (socket) => {
  // ---- host
  socket.on("host:create", (key, cb) => {
    if (typeof cb !== "function") return;
    if (HOST_KEY && key !== HOST_KEY) return cb({ error: "Wrong host key." });
    const game = createGame(socket.id);
    socket.data.hostPin = game.pin;
    socket.join(game.pin);
    cb({ pin: game.pin, title: game.title, total: game.questions.length, max: MAX_PLAYERS });
    sendLobby(game);
  });

  socket.on("host:reconnect", (pin, cb) => {
    const game = games.get(String(pin));
    if (!game || typeof cb !== "function") return cb && cb({ error: "Game not found." });
    game.hostSocketId = socket.id;
    socket.data.hostPin = game.pin;
    cb({ ok: true, state: game.state });
    sendLobby(game);
  });

  function hostGame(socket) {
    const game = games.get(socket.data.hostPin);
    return game && game.hostSocketId === socket.id ? game : null;
  }

  socket.on("host:start", () => {
    const game = hostGame(socket);
    if (!game || game.state !== "lobby") return;
    if (game.players.size === 0) return toHost(game, "notice", "Wait for at least one player to join.");
    game.lastActive = Date.now();
    startQuestion(game);
  });
  socket.on("host:next", () => {
    const game = hostGame(socket);
    if (!game) return;
    game.lastActive = Date.now();
    if (game.state === "question") return reveal(game); // host can end a question early
    if (game.state === "reveal") return startQuestion(game);
  });
  socket.on("host:kick", (name) => {
    const game = hostGame(socket);
    if (!game) return;
    for (const p of game.players.values()) {
      if (p.name === name) {
        if (p.socketId) io.to(p.socketId).emit("kicked");
        game.players.delete(p.id);
        game.names.delete(p.name.toLowerCase());
      }
    }
    sendLobby(game);
  });

  // ---- players
  socket.on("player:join", ({ pin, name } = {}, cb) => {
    if (typeof cb !== "function") return;
    const game = games.get(String(pin || "").trim());
    if (!game) return cb({ error: "Game not found. Check the PIN." });
    if (game.state !== "lobby") return cb({ error: "This game has already started." });
    if (game.players.size >= MAX_PLAYERS) return cb({ error: `Game is full (${MAX_PLAYERS} players).` });
    const nick = cleanName(name);
    if (!nick) return cb({ error: "Enter a nickname." });
    if (game.names.has(nick.toLowerCase())) return cb({ error: "That nickname is taken. Try another." });
    const id = crypto.randomBytes(8).toString("hex");
    game.players.set(id, { id, name: nick, score: 0, socketId: socket.id, lastDelta: 0, streak: 0 });
    game.names.add(nick.toLowerCase());
    socket.data.pin = game.pin;
    socket.data.pid = id;
    socket.join(game.pin);
    game.lastActive = Date.now();
    cb({ ok: true, id, name: nick, title: game.title });
    sendLobby(game);
  });

  // A phone that slept or lost signal can come back to the same player.
  socket.on("player:rejoin", ({ pin, id } = {}, cb) => {
    if (typeof cb !== "function") return;
    const game = games.get(String(pin || ""));
    const p = game && game.players.get(id);
    if (!p) return cb({ error: "Session expired. Join again." });
    p.socketId = socket.id;
    socket.data.pin = game.pin;
    socket.data.pid = id;
    socket.join(game.pin);
    const q = game.questions[game.qIndex];
    cb({ ok: true, name: p.name, state: game.state, score: p.score,
      question: game.state === "question" ? { index: game.qIndex, total: game.questions.length, count: q.options.length, time: Math.max(0, game.time - (Date.now() - game.qStart) / 1000), answered: game.answers.has(id) } : null });
  });

  socket.on("player:answer", (choice) => {
    const { game, player } = playerEntry(socket);
    if (!game || !player || game.state !== "question") return;
    const q = game.questions[game.qIndex];
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
    if (game.answers.has(player.id)) return; // first answer counts
    const ms = Date.now() - game.qStart;
    if (ms > game.time * 1000 + REVEAL_GRACE_MS) return;
    game.answers.set(player.id, { choice, ms });
    socket.emit("locked");
    toHost(game, "progress", { answered: game.answers.size, players: connectedCount(game) });
    if (game.answers.size >= connectedCount(game)) reveal(game); // everyone in: move on
  });

  socket.on("disconnect", () => {
    const { game, player } = playerEntry(socket);
    if (game && player && player.socketId === socket.id) {
      player.socketId = null;
      if (game.state === "lobby") {
        // In the lobby a dropped phone is removed so the headcount stays honest.
        setTimeout(() => {
          const p = game.players.get(player.id);
          if (p && !p.socketId && game.state === "lobby") {
            game.players.delete(p.id);
            game.names.delete(p.name.toLowerCase());
            sendLobby(game);
          }
        }, 15000);
      }
    }
  });
});

// Remove finished or abandoned games after 3 hours of inactivity.
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [pin, g] of games) if (g.lastActive < cutoff) { clearTimeout(g.timer); games.delete(pin); }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Ajira Quiz Arena on port ${PORT} (${QUIZ.questions.length} questions, max ${MAX_PLAYERS} players)`));
}
module.exports = { server, io };

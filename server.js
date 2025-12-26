/**
 * IPL AUCTION SERVER - RENDER PRODUCTION READY
 * FEATURES:
 * 1. Fixed IP Proxy Parsing (Crucial for Render/AWS)
 * 2. Auto-Wake / Keep-Alive Logic
 * 3. Robust Host Recovery
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const os = require("os");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const AUCTION_TIMER_SECONDS = 10;
const PORT = process.env.PORT || 3001; // 🔧 Render uses dynamic ports

// --- SERVE HTML ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "ipl.html"));
});

// --- SERVE STATIC FILES ---
app.use(express.static(__dirname));
app.use(express.raw({ type: "audio/wav", limit: "10mb" }));

// --- ROBUST IP GETTER FOR RENDER ---
function getClientIp(socket) {
    const header = socket.handshake.headers['x-forwarded-for'];
    if (header) {
        // Render returns "clientIP, proxy1, proxy2"
        // We MUST take the first one, otherwise string matching fails
        const ip = header.split(',')[0].trim();
        if (ip.startsWith("::ffff:")) return ip.substr(7);
        return ip;
    }
    const ip = socket.handshake.address;
    if (ip && ip.startsWith("::ffff:")) return ip.substr(7);
    return ip;
}

// --- GLOBAL STATE ---
const rooms = {};

// --- UTILS ---
function getRoomId(socket) {
  return [...socket.rooms].find((r) => r !== socket.id);
}

function isAdmin(socket) {
  const roomId = getRoomId(socket);
  const r = rooms[roomId];
  return r && r.adminSocketId === socket.id;
}

// --- KEEP ALIVE LOGIC ---
// This logs a heartbeat to the console to prevent some platforms from thinking the app is idle
setInterval(() => {
    const roomCount = Object.keys(rooms).length;
    if (roomCount > 0) {
        console.log(`[Heartbeat] Active Rooms: ${roomCount} | Memory kept alive.`);
    }
}, 60000); // Check every 1 minute

// --- TIMER LOGIC ---
function startTimer(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  if (r.timerInterval) clearInterval(r.timerInterval);

  r.timer = AUCTION_TIMER_SECONDS;
  r.timerPaused = false;

  io.to(roomId).emit("timer_tick", r.timer, false);
  io.to(roomId).emit("timer_status", false);

  r.timerInterval = setInterval(() => {
    if (r.timerPaused) return;
    r.timer--;
    io.to(roomId).emit("timer_tick", r.timer, false);
    if (r.timer <= 0) {
      processSale(roomId, "TIMER");
    }
  }, 1000);
}

function stopTimer(roomId) {
  const r = rooms[roomId];
  if (r && r.timerInterval) {
    clearInterval(r.timerInterval);
    r.timerInterval = null;
  }
}

function processSale(roomId, source = "UNKNOWN") {
  const r = rooms[roomId];
  if (!r || !r.currentPlayer || r.sellingInProgress) return;

  r.sellingInProgress = true;
  stopTimer(roomId);
  io.to(roomId).emit("timer_ended");

  if (r.currentBidder) {
    const team = r.teams.find((t) => t.bidKey === r.currentBidder);
    const price = r.currentBid;

    if (team) {
      team.roster.push({ ...r.currentPlayer, price });
      team.totalSpent += price;
      team.totalPlayers += 1;
      team.budget -= price;
    }

    r.currentPlayer.status = "SOLD";
    r.currentPlayer.soldPrice = price;

    io.to(roomId).emit("sale_finalized", {
      soldPlayer: r.currentPlayer,
      isUnsold: false,
      soldDetails: { soldTeam: team?.name },
      price,
      updatedTeams: r.teams,
    });
  } else {
    r.currentPlayer.status = "UNSOLD";
    io.to(roomId).emit("sale_finalized", {
      soldPlayer: r.currentPlayer,
      isUnsold: true,
      price: 0,
      updatedTeams: r.teams,
    });
  }
  r.auctionIndex++;

  setTimeout(() => {
    if (rooms[roomId]) rooms[roomId].sellingInProgress = false;
    startNextLot(roomId);
  }, 3800);
}

// --- AUTH MIDDLEWARE ---
io.use((socket, next) => {
  const playerId = socket.handshake.auth.playerId;
  if (playerId) {
    socket.playerId = playerId; 
    return next();
  }
  socket.playerId = "guest_" + socket.id;
  next();
});

// --- SOCKET HANDLERS ---
io.on("connection", (socket) => {
  const clientIp = getClientIp(socket);
  console.log(`User Connected: ${socket.id} (PID: ${socket.playerId}) [IP: ${clientIp}]`);

  socket.on("pingServer", () => {
    socket.emit("pongServer");
  });

  // 1. Create Room
  socket.on("create_room", ({ roomId, password, config }) => {
    if (rooms[roomId]) return socket.emit("error_message", "Room exists");

    rooms[roomId] = {
      password,
      config,
      users: [],
      teams: [],
      auctionQueue: [],
      auctionIndex: 0,
      currentBid: 0,
      currentBidder: null,
      currentPlayer: null,
      timer: AUCTION_TIMER_SECONDS,
      timerInterval: null,
      timerPaused: true,
      state: { isActive: false },
      adminSocketId: socket.id,
      adminIP: getClientIp(socket), // Store clean IP
      sellingInProgress: false,
      squads: {},
    };
    socket.join(roomId);
    rooms[roomId].users.push(socket.id);
    socket.emit("roomcreated", roomId);
  });

  // 2. Join Room (UPDATED FOR RENDER PROXY)
  socket.on("join_room", ({ roomId, password }) => {
    const r = rooms[roomId];
    if (!r || r.password !== password)
      return socket.emit("error_message", "Invalid Login");

    socket.join(roomId);
    if (!r.users.includes(socket.id)) r.users.push(socket.id);

    const currentIp = getClientIp(socket);
    let isAdminReconnected = false;

    // 🔧 LOGIC: If IP matches Admin, Force Restore
    if (r.adminIP && r.adminIP === currentIp) {
         console.log(`Host reconnected via IP Match: ${currentIp}`);
         
         // Disconnect old admin socket if ghost
         const oldAdminSocket = io.sockets.sockets.get(r.adminSocketId);
         if (oldAdminSocket) oldAdminSocket.disconnect(true);

         r.adminSocketId = socket.id; 
         isAdminReconnected = true;
    }

    // 🔧 LOGIC: Restore Team Ownership
    const myExistingTeam = r.teams.find(
      (t) => t.ownerPlayerId === socket.playerId || (t.ownerIP === currentIp && !t.ownerSocketId)
    );

    if (myExistingTeam) {
      console.log(`Player returned. Reconnecting to ${myExistingTeam.name}`);
      myExistingTeam.ownerSocketId = socket.id;
      socket.emit("team_claim_success", myExistingTeam.bidKey);
    }

    const syncState = {
      isActive: r.state.isActive,
      teams: r.teams,
      queue: r.auctionQueue,
      auctionIndex: r.auctionIndex,
    };

    socket.emit("room_joined", {
      roomId,
      isAdmin: isAdminReconnected, 
      lobbyState: { teams: r.teams, userCount: r.users.length },
      state: syncState,
    });

    io.to(roomId).emit("lobby_update", {
      teams: r.teams,
      userCount: r.users.length,
    });
  });

  socket.on("request_sync", () => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r) {
      socket.emit("sync_data", {
        teams: r.teams,
        queue: r.auctionQueue,
        auctionIndex: r.auctionIndex,
        currentLot: r.currentPlayer,
        currentBid: r.currentBid,
        currentBidder: r.currentBidder,
        timer: r.timer,
        timerPaused: r.timerPaused,
      });
    }
  });

  socket.on("disconnect", () => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (!r) return;

    r.users = r.users.filter((id) => id !== socket.id);

    const ownedTeam = r.teams.find((t) => t.ownerSocketId === socket.id);
    if (ownedTeam) {
      console.log(`Owner of ${ownedTeam.name} disconnected temporarily.`);
      ownedTeam.ownerSocketId = null; 
    }

    io.to(roomId).emit("lobby_update", {
      teams: r.teams,
      userCount: r.users.length,
    });

    if (r.users.length === 0) {
      stopTimer(roomId);
      delete rooms[roomId];
    }
  });

  socket.on("update_lobby_teams", (teams) => {
    const roomId = getRoomId(socket);
    if (roomId && rooms[roomId]) {
      rooms[roomId].teams = teams;
      io.to(roomId).emit("lobby_update", {
        teams,
        userCount: rooms[roomId].users.length,
      });
    }
  });

  socket.on("claim_lobby_team", (key) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (!r) return;

    const currentIp = getClientIp(socket);

    const existingTeam = r.teams.find(
      (team) => team.ownerPlayerId === socket.playerId || team.ownerIP === currentIp
    );
    if (existingTeam) {
      socket.emit("error_message", "You already have a team!");
      return;
    }

    const t = r.teams.find((x) => x.bidKey === key);

    if (t && !t.isTaken) {
      t.isTaken = true;
      t.ownerSocketId = socket.id;
      t.ownerPlayerId = socket.playerId; 
      t.ownerIP = currentIp; 
      socket.emit("team_claim_success", key);
      io.to(roomId).emit("lobby_update", {
        teams: r.teams,
        userCount: r.users.length,
      });
    }
  });

  socket.on("reclaim_team", (key) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (!r) return;
    const t = r.teams.find((x) => x.bidKey === key);

    const currentIp = getClientIp(socket);
    if (t && t.isTaken && (t.ownerPlayerId === socket.playerId || t.ownerIP === currentIp)) {
      t.ownerSocketId = socket.id;
      socket.emit("team_claim_success", key);
    }
  });

  socket.on("admin_rename_team", ({ key, newName }) => {
    const roomId = getRoomId(socket);
    if (!isAdmin(socket)) return;
    const t = rooms[roomId].teams.find((x) => x.bidKey === key);
    if (t) t.name = newName;
    io.to(roomId).emit("lobby_update", {
      teams: rooms[roomId].teams,
      userCount: rooms[roomId].users.length,
    });
  });

  socket.on("start_auction", ({ teams, queue }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (!r || !isAdmin(socket)) return;

    r.teams = teams.map((t) => ({
      ...t,
      roster: [],
      totalSpent: 0,
      totalPlayers: 0,
    }));
    r.auctionQueue = queue;
    r.auctionIndex = 0;
    r.state.isActive = true;

    io.to(roomId).emit("auction_started", {
      teams: r.teams,
      queue: r.auctionQueue,
    });
    startNextLot(roomId);
  });

  socket.on("place_bid", ({ teamKey, amount }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    const bidderSocket = io.sockets.sockets.get(socket.id);

    if (!r || !r.state.isActive || r.timerPaused || r.sellingInProgress || !r.currentPlayer)
      return;

    const team = r.teams.find((t) => t.bidKey === teamKey);

    if (!team) return bidderSocket && bidderSocket.emit("error_message", "Invalid team.");
    if (team.ownerSocketId !== socket.id)
      return bidderSocket && bidderSocket.emit("error_message", "You do not own this team.");

    if (r.currentBidder === teamKey) return;
    if (team.budget < amount)
      return bidderSocket && bidderSocket.emit("error_message", "Not enough budget!");
    if (amount <= r.currentBid)
      return bidderSocket && bidderSocket.emit("error_message", "Bid is too low.");

    r.currentBid = amount;
    r.currentBidder = teamKey;

    io.to(roomId).emit("bid_update", {
      amount,
      team,
    });

    startTimer(roomId);
  });

  socket.on("toggle_timer", () => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r && isAdmin(socket)) {
      r.timerPaused = !r.timerPaused;
      io.to(roomId).emit("timer_status", r.timerPaused);
    }
  });

  socket.on("request_next_player", () => {
    const roomId = getRoomId(socket);
    if (isAdmin(socket) && rooms[roomId] && !rooms[roomId].sellingInProgress) {
      startNextLot(roomId);
    }
  });

  socket.on("finalize_sale", ({ isUnsold, soldTo, price }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (!r || !isAdmin(socket)) return;
    if (isUnsold) r.currentBidder = null;
    processSale(roomId, "ADMIN_MANUAL");
  });
  
  socket.on("end_auction_trigger", () => {
    const roomId = getRoomId(socket);
    if (!isAdmin(socket)) return;
    const r = rooms[roomId];
    stopTimer(roomId);
    r.state.isActive = false;
    io.to(roomId).emit("open_squad_selection");
  });

  socket.on("submit_squad", ({ teamKey, playing11, impact, captain }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r) {
      r.squads[teamKey] = { playing11, impact, captain };
      const total = r.teams.length;
      const submitted = Object.keys(r.squads).length;

      io.to(roomId).emit("squad_submission_update", {
        submittedCount: submitted,
        totalTeams: total,
      });

      if (submitted === total) {
        setTimeout(() => runSimulationLogic(roomId, r), 2000);
      }
    }
  });

  socket.on("run_simulation", () => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r && isAdmin(socket)) runSimulationLogic(roomId, r);
  });
});

function runSimulationLogic(roomId, r) {
  const tourneyTeams = r.teams
    .map((t) => ({
      name: t.name,
      bidKey: t.bidKey,
      playing11: r.squads[t.bidKey] ? r.squads[t.bidKey].playing11 : [],
      roster: t.roster || [],
      captain: r.squads[t.bidKey] ? r.squads[t.bidKey].captain : null,
    }))
    .filter((t) => t.playing11.length === 11 || t.roster.length >= 11);

  tourneyTeams.forEach((t) => {
    if (t.playing11.length !== 11 && t.roster.length >= 11) {
      t.playing11 = t.roster.slice(0, 11);
    }
  });

  if (tourneyTeams.length < 2) {
    io.to(roomId).emit(
      "simulation_error",
      `Cannot start! Need at least 2 teams with 11+ players. Currently have: ${tourneyTeams.length}`
    );
    return;
  }
  const results = runAdvancedSimulation(tourneyTeams);
  io.to(roomId).emit("tournament_results", results);
}

function startNextLot(roomId) {
  const r = rooms[roomId];
  if (!r || r.auctionIndex >= r.auctionQueue.length) {
    io.to(roomId).emit("open_squad_selection");
    return;
  }

  r.currentPlayer = r.auctionQueue[r.auctionIndex];
  r.currentBid = r.currentPlayer.basePrice;
  r.currentBidder = null;
  r.sellingInProgress = false;

  io.to(roomId).emit("update_lot", {
    player: r.currentPlayer,
    currentBid: r.currentBid,
    lotNumber: r.auctionIndex + 1,
  });

  startTimer(roomId);
}

// ==========================================
// REALISTIC T20 AI ENGINE
// ==========================================

function runAdvancedSimulation(teams) {
  const stats = {};
  const leagueMatches = [];
  const playoffs = [];

  teams.forEach((t) => {
    t.stats = { p: 0, w: 0, l: 0, pts: 0, nrr: 0, runsScored: 0, runsConceded: 0, oversFaced: 0, oversBowled: 0 };
    t.playing11.forEach((p) => {
      if (!stats[p.name])
        stats[p.name] = { name: p.name, role: p.roleKey || "batter", runs: 0, balls: 0, fours: 0, sixes: 0, wickets: 0, overs: 0, runsGiven: 0, pts: 0 };
    });
  });

  function getStat(name) { return stats[name]; }

  function simulateInnings(batTeam, bowlTeam, target = null) {
    let score = 0, wickets = 0, legalBallsBowled = 0;
    const MAX_BALLS = 120;
    const getMatchForm = () => Math.floor(Math.random() * 10) - 5;

    let battingCard = batTeam.playing11.map((p) => ({
      name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, status: "dnb",
      skill: (p.stats?.bat || 50) + getMatchForm(),
      luck: (p.stats?.luck || 50) + getMatchForm(),
      role: p.roleKey,
    }));

    let validBowlers = bowlTeam.playing11.filter((p) =>
      ["bowler", "allrounder", "spinner", "fast"].includes(p.roleKey)
    );
    if (validBowlers.length < 5) {
      let batters = bowlTeam.playing11.filter((p) => p.roleKey === "batter");
      validBowlers = [...validBowlers, ...batters.slice(0, 5 - validBowlers.length)];
    }
    if (validBowlers.length < 5) {
      let wks = bowlTeam.playing11.filter((p) => p.roleKey === "wk");
      validBowlers = [...validBowlers, ...wks.slice(0, 5 - validBowlers.length)];
    }

    let bowlingCard = validBowlers.map((b) => ({
      name: b.name, overs: 0, runs: 0, wkts: 0, balls: 0,
      skill: (["wk", "batter"].includes(b.roleKey) ? 20 : b.stats?.bowl || 50) + getMatchForm(),
      luck: (b.stats?.luck || 50) + getMatchForm(),
      role: b.roleKey,
    }));

    let strikerIdx = 0, nonStrikerIdx = 1;
    battingCard[strikerIdx].status = "not out";
    battingCard[nonStrikerIdx].status = "not out";

    while (legalBallsBowled < MAX_BALLS && wickets < 10) {
      if (target !== null && score > target) break;

      let overNum = Math.floor(legalBallsBowled / 6);
      let bowlerObj = bowlingCard[overNum % bowlingCard.length];
      let strikerObj = battingCard[strikerIdx];

      let batVal = strikerObj.skill;
      let bowlVal = bowlerObj.skill;
      if (["wk", "batter"].includes(bowlerObj.role)) batVal += 15;

      let luckDiff = strikerObj.luck - bowlerObj.luck;
      let ballLuck = Math.random();
      let diff = batVal - bowlVal + luckDiff * 0.15;
      let outcome = 0;

      if (diff > 40) {
        if (ballLuck > 0.98) outcome = -1;
        else if (ballLuck > 0.88) outcome = 6;
        else if (ballLuck > 0.7) outcome = 4;
        else if (ballLuck > 0.35) outcome = 1;
        else if (ballLuck > 0.25) outcome = 2;
        else outcome = 0;
      } else if (diff > 20) {
        if (ballLuck > 0.96) outcome = -1;
        else if (ballLuck > 0.9) outcome = 6;
        else if (ballLuck > 0.78) outcome = 4;
        else if (ballLuck > 0.4) outcome = 1;
        else if (ballLuck > 0.3) outcome = 2;
        else outcome = 0;
      } else if (diff < -20) {
        if (ballLuck > 0.85) outcome = -1;
        else if (ballLuck > 0.95) outcome = 4;
        else if (ballLuck > 0.5) outcome = 0;
        else outcome = 1;
      } else {
        if (ballLuck > 0.95) outcome = -1;
        else if (ballLuck > 0.92) outcome = 6;
        else if (ballLuck > 0.82) outcome = 4;
        else if (ballLuck > 0.45) outcome = 1;
        else if (ballLuck > 0.35) outcome = 2;
        else outcome = 0;
      }

      if (overNum >= 16) {
        if (outcome === 0 && Math.random() > 0.6) outcome = -1;
        else if (outcome === 1 && Math.random() > 0.7) outcome = 4;
      }

      legalBallsBowled++;
      bowlerObj.balls++;
      if (bowlerObj.balls % 6 === 0) getStat(bowlerObj.name).overs++;

      if (outcome === -1) {
        wickets++;
        bowlerObj.wkts++;
        getStat(bowlerObj.name).wickets++;
        getStat(bowlerObj.name).pts += 25;
        strikerObj.balls++;
        getStat(strikerObj.name).balls++;
        strikerObj.status = "out";
        strikerIdx = Math.max(strikerIdx, nonStrikerIdx) + 1;
        if (strikerIdx < 11) battingCard[strikerIdx].status = "not out";
      } else {
        score += outcome;
        strikerObj.runs += outcome;
        strikerObj.balls++;
        if (outcome === 4) { strikerObj.fours++; getStat(strikerObj.name).fours++; }
        if (outcome === 6) { strikerObj.sixes++; getStat(strikerObj.name).sixes++; }
        getStat(strikerObj.name).runs += outcome;
        getStat(strikerObj.name).balls++;
        getStat(strikerObj.name).pts += outcome;
        if (outcome === 4) getStat(strikerObj.name).pts += 1;
        if (outcome === 6) getStat(strikerObj.name).pts += 2;

        bowlerObj.runs += outcome;
        getStat(bowlerObj.name).runsGiven += outcome;
        if (outcome % 2 !== 0) [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];
      }
      if (legalBallsBowled % 6 === 0) [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];
    }

    bowlingCard.forEach((b) => {
      let o = Math.floor(b.balls / 6);
      let rem = b.balls % 6;
      b.oversDisplay = rem === 0 ? o : `${o}.${rem}`;
      b.economy = b.balls > 0 ? ((b.runs / b.balls) * 6).toFixed(1) : "0.0";
    });

    return { score, wickets, balls: legalBallsBowled, battingCard, bowlingCard, teamName: batTeam.name };
  }

  function playMatch(t1, t2, type) {
    const i1 = simulateInnings(t1, t2, null);
    const i2 = simulateInnings(t2, t1, i1.score);

    let win, lose, margin;
    if (i2.score > i1.score) { win = t2; lose = t1; margin = `${10 - i2.wickets} wkts`; }
    else if (i1.score > i2.score) { win = t1; lose = t2; margin = `${i1.score - i2.score} runs`; }
    else { win = t1; lose = t2; margin = "Super Over"; }

    if (type === "League") {
      win.stats.p++; win.stats.w++; win.stats.pts += 2;
      lose.stats.p++; lose.stats.l++;
      win.stats.runsScored += win === t1 ? i1.score : i2.score;
      win.stats.runsConceded += win === t1 ? i2.score : i1.score;
      win.stats.oversFaced += win === t1 ? 20 : i2.balls / 6;
      win.stats.oversBowled += win === t1 ? i2.balls / 6 : 20;
      lose.stats.runsScored += lose === t1 ? i1.score : i2.score;
      lose.stats.runsConceded += lose === t1 ? i2.score : i1.score;
      lose.stats.oversFaced += lose === t1 ? 20 : i2.balls / 6;
      lose.stats.oversBowled += lose === t1 ? i2.balls / 6 : 20;
    }

    const allBat = [...i1.battingCard, ...i2.battingCard];
    const allBowl = [...i1.bowlingCard, ...i2.bowlingCard];
    const topScorer = allBat.sort((a, b) => b.runs - a.runs)[0] || { name: "-", runs: 0 };
    const bestBowler = allBowl.sort((a, b) => b.wkts - a.wkts || a.runs - b.runs)[0] || { name: "-", wkts: 0 };

    let matchPerformers = [];
    const addPerf = (name, team, ptsToAdd, descStr) => {
      let p = matchPerformers.find((x) => x.name === name);
      if (!p) { p = { name, team, points: 0, desc: [] }; matchPerformers.push(p); }
      p.points += ptsToAdd;
      if (descStr) p.desc.push(descStr);
    };
    i1.battingCard.forEach((p) => { if (p.runs > 0) addPerf(p.name, t1.name, p.runs + p.sixes * 2 + p.fours, `${p.runs} runs`); });
    i1.bowlingCard.forEach((p) => { if (p.wkts > 0) addPerf(p.name, t2.name, p.wkts * 25, `${p.wkts} wkts`); });
    i2.battingCard.forEach((p) => { if (p.runs > 0) addPerf(p.name, t2.name, p.runs + p.sixes * 2 + p.fours, `${p.runs} runs`); });
    i2.bowlingCard.forEach((p) => { if (p.wkts > 0) addPerf(p.name, t1.name, p.wkts * 25, `${p.wkts} wkts`); });
    matchPerformers.sort((a, b) => b.points - a.points);

    const t1BestBat = i1.battingCard.sort((a, b) => b.runs - a.runs)[0] || { name: "-", runs: 0 };
    const t1BestBowl = i2.bowlingCard.sort((a, b) => b.wkts - a.wkts || a.runs - b.runs)[0] || { name: "-", wkts: 0, runs: 0 };
    const t2BestBat = i2.battingCard.sort((a, b) => b.runs - a.runs)[0] || { name: "-", runs: 0 };
    const t2BestBowl = i1.bowlingCard.sort((a, b) => b.wkts - a.wkts || a.runs - b.runs)[0] || { name: "-", wkts: 0, runs: 0 };

    return {
      type, t1: t1.name, t2: t2.name,
      score1: `${i1.score}/${i1.wickets}`, score2: `${i2.score}/${i2.wickets}`,
      winnerName: win.name, margin,
      topScorer: { name: topScorer.name, runs: topScorer.runs },
      bestBowler: { name: bestBowler.name, figures: `${bestBowler.wkts} wkts` },
      winObj: win, loseObj: lose,
      top3Performers: matchPerformers.slice(0, 3),
      t1Best: { bat: t1BestBat, bowl: t1BestBowl },
      t2Best: { bat: t2BestBat, bowl: t2BestBowl },
      details: {
        i1: { team: t1.name, score: i1.score, wkts: i1.wickets, bat: i1.battingCard, bowl: i1.bowlingCard },
        i2: { team: t2.name, score: i2.score, wkts: i2.wickets, bat: i2.battingCard, bowl: i2.bowlingCard },
      },
      allTeamsData: teams,
    };
  }

  for (let i = 0; i < teams.length; i++) {
    for (let j = 0; j < teams.length; j++) {
      if (i !== j) leagueMatches.push(playMatch(teams[i], teams[j], "League"));
    }
  }

  teams.forEach((t) => {
    if (t.stats.oversFaced > 0) {
      let forRate = t.stats.runsScored / t.stats.oversFaced;
      let againstRate = t.stats.runsConceded / t.stats.oversBowled;
      t.stats.nrr = forRate - againstRate;
    }
  });
  teams.sort((a, b) => b.stats.pts - a.stats.pts || b.stats.nrr - a.stats.nrr);

  let champion, runner;
  if (teams.length >= 4) {
    const q1 = playMatch(teams[0], teams[1], "Qualifier 1"); playoffs.push(q1);
    const eli = playMatch(teams[2], teams[3], "Eliminator"); playoffs.push(eli);
    const q2 = playMatch(q1.loseObj, eli.winObj, "Qualifier 2"); playoffs.push(q2);
    const fin = playMatch(q1.winObj, q2.winObj, "FINAL"); playoffs.push(fin);
    champion = fin.winnerName; runner = champion === q1.winObj.name ? q2.winObj.name : q1.winObj.name;
  } else {
    const fin = playMatch(teams[0], teams[1], "FINAL"); playoffs.push(fin);
    champion = fin.winnerName; runner = teams[0].name === champion ? teams[1].name : teams[0].name;
  }

  const allStats = Object.values(stats);
  const orangeCap = allStats.filter((s) => s.role === "batter" || s.role === "wk").sort((a, b) => b.runs - a.runs)[0] || { name: "-", runs: 0 };
  const purpleCap = allStats.filter((s) => s.role === "bowler" || s.role === "spinner" || s.role === "fast").sort((a, b) => b.wickets - a.wickets)[0] || { name: "-", wickets: 0 };
  const mvp = allStats.filter((s) => s.role === "allrounder").sort((a, b) => b.pts - a.pts)[0] || { name: "-", pts: 0 };

  return {
    winner: champion, runnerUp: runner,
    standings: teams.map((t) => ({ name: t.name, played: t.stats.p, won: t.stats.w, lost: t.stats.l, points: t.stats.pts, nrr: t.stats.nrr })),
    leagueMatches, playoffs, orangeCap, purpleCap, mvp, allTeamsData: teams,
  };
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`LAN: http://${getIP()}:${PORT}`);
});

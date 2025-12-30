const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());

// Method Change: Create Server
const server = http.createServer(app);

// Method Change: Socket.io setup for production environment
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from any domain (crucial for hosting)
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
});

const AUCTION_TIMER_SECONDS = 10;

// Method Change: GoDaddy assigns a specific named pipe or port.
// We MUST use process.env.PORT
const PORT = process.env.PORT || 3001;

// --- SERVE FILES ---
// Method Change: Robust path resolving
app.use(express.static(path.join(__dirname)));

// Serve the main file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "ipl.html"));
});

// --- UTILS ---
function getRoomId(socket) {
  return [...socket.rooms].find((r) => r !== socket.id);
}

function isAdmin(socket) {
  const roomId = getRoomId(socket);
  const r = rooms[roomId];
  return r && r.adminSocketId === socket.id;
}

// --- GLOBAL STATE ---
const rooms = {};

// --- TIMER LOGIC ---
function startTimer(roomId) {
  const r = rooms[roomId];
  if (!r) return;

  // Optimization: Don't restart if timer is basically full (prevents spam jitter)
  if (r.timerInterval && r.timer > AUCTION_TIMER_SECONDS - 2) return;

  if (r.timerInterval) clearInterval(r.timerInterval);

  r.timer = AUCTION_TIMER_SECONDS;
  r.timerPaused = false;
  
  // Anti-Drift: precise end time
  r.timerEndTime = Date.now() + (r.timer * 1000);

  io.to(roomId).emit("timer_tick", r.timer);
  io.to(roomId).emit("timer_status", false);

  r.timerInterval = setInterval(() => {
    if (r.timerPaused) {
       // If paused, dragging the end time forward so we don't jump when unpaused
       r.timerEndTime += 1000;
       return;
    }
    
    // Calculate remaining based on system clock
    const remaining = Math.ceil((r.timerEndTime - Date.now()) / 1000);
    r.timer = remaining;

    io.to(roomId).emit("timer_tick", r.timer);
    if (r.timer <= 0) {
      processSale(roomId);
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

  let soldPrice = 0;
  let soldTeamName = null;
  let isUnsold = true;

  if (r.currentBidder) {
    const team = r.teams.find((t) => t.bidKey === r.currentBidder);
    if (team) {
      soldPrice = r.currentBid;
      team.roster.push({
        ...r.currentPlayer,
        price: soldPrice,
        status: "SOLD",
      });
      team.totalSpent += soldPrice;
      team.totalPlayers += 1;
      team.budget -= soldPrice;
      soldTeamName = team.name;
      isUnsold = false;
    }
  }

  r.currentPlayer.status = isUnsold ? "UNSOLD" : "SOLD";
  r.currentPlayer.soldPrice = soldPrice;

  // Send finalized data (used by Frontend TTS)
  io.to(roomId).emit("sale_finalized", {
    soldPlayer: r.currentPlayer,
    isUnsold: isUnsold,
    soldDetails: { soldTeam: soldTeamName },
    price: soldPrice,
    updatedTeams: r.teams,
  });

  r.auctionIndex++;

  setTimeout(() => {
    if (rooms[roomId]) rooms[roomId].sellingInProgress = false;
    startNextLot(roomId);
  }, 4000); // 4s delay to read the result
}

function startNextLot(roomId) {
  const r = rooms[roomId];
  if (!r) return;

  if (r.auctionIndex >= r.auctionQueue.length) {
    io.to(roomId).emit("open_squad_selection");
    return;
  }

  r.currentPlayer = r.auctionQueue[r.auctionIndex];

  // Skip if already processed (Resuming)
  if (r.currentPlayer.status) {
    r.auctionIndex++;
    startNextLot(roomId);
    return;
  }

  r.currentBid = r.currentPlayer.basePrice;
  r.currentBidder = null;
  r.sellingInProgress = false;

  // Trigger update (Frontend plays "Lot Number..." TTS)
  io.to(roomId).emit("update_lot", {
    player: r.currentPlayer,
    currentBid: r.currentBid,
    lotNumber: r.auctionIndex + 1,
  });

  startTimer(roomId);
}

// --- AUTH MIDDLEWARE ---
io.use((socket, next) => {
  const playerId = socket.handshake.auth.playerId;
  socket.playerId = playerId || "guest_" + socket.id;
  next();
});

// --- SOCKET HANDLERS ---
io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id} (PID: ${socket.playerId})`);

  socket.on("pingServer", () => socket.emit("pongServer"));

  // 1. CREATE ROOM
  socket.on("create_room", ({ roomId, password, config }) => {
    if (rooms[roomId]) return socket.emit("error_message", "Room Exists!");

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
      adminPlayerId: socket.playerId,
      sellingInProgress: false,
      squads: {},
    };
    socket.join(roomId);
    rooms[roomId].users.push(socket.id);
    socket.emit("roomcreated", roomId);
  });

  // 2. JOIN ROOM
  socket.on("join_room", ({ roomId, password }) => {
    const r = rooms[roomId];
    if (!r || r.password !== password)
      return socket.emit("error_message", "Invalid Credentials");

    socket.join(roomId);
    if (!r.users.includes(socket.id)) r.users.push(socket.id);

    let isAdminReconnected = false;

    if (r.adminPlayerId === socket.playerId) {
      r.adminSocketId = socket.id;
      isAdminReconnected = true;
    }

    const myTeam = r.teams.find((t) => t.ownerPlayerId === socket.playerId);
    if (myTeam) {
      myTeam.ownerSocketId = socket.id;
      socket.emit("team_claim_success", myTeam.bidKey);
    }

    socket.emit("room_joined", {
      roomId,
      isAdmin: isAdminReconnected,
      lobbyState: { teams: r.teams, userCount: r.users.length },
      state: {
        isActive: r.state.isActive,
        teams: r.teams,
        queue: r.auctionQueue,
      },
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
      let remaining = r.timer;
      if (!r.timerPaused && r.timerEndTime) {
         remaining = Math.ceil((r.timerEndTime - Date.now()) / 1000);
         if (remaining < 0) remaining = 0;
      }
      
      socket.emit("sync_data", {
        teams: r.teams,
        queue: r.auctionQueue,
        auctionIndex: r.auctionIndex,
        currentLot: r.currentPlayer,
        currentBid: r.currentBid,
        currentBidder: r.currentBidder,
        timer: remaining,
        timerPaused: r.timerPaused,
      });
    }
  });

  socket.on("update_lobby_teams", (teams) => {
    const roomId = getRoomId(socket);
    if (!isAdmin(socket)) return;
    if (rooms[roomId]) {
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

    if (
      r.teams.find(
        (t) => t.ownerPlayerId === socket.playerId && t.bidKey !== key
      )
    ) {
      return socket.emit("error_message", "You already own a team!");
    }

    const t = r.teams.find((x) => x.bidKey === key);
    if (t && (!t.isTaken || t.ownerPlayerId === socket.playerId)) {
      t.isTaken = true;
      t.ownerSocketId = socket.id;
      t.ownerPlayerId = socket.playerId;
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

    if (t && t.ownerPlayerId === socket.playerId) {
      t.ownerSocketId = socket.id;
      socket.emit("team_claim_success", key);
    }
  });

  socket.on("request_reclaim_manual", ({ teamKey }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (!r) return;

    const targetTeam = r.teams.find((t) => t.bidKey === teamKey);
    if (!targetTeam) return;

    if (r.adminSocketId) {
      io.to(r.adminSocketId).emit("admin_reclaim_request", {
        teamKey: teamKey,
        teamName: targetTeam.name,
        requesterId: socket.id,
        requesterPid: socket.playerId,
      });
    }
  });

  socket.on(
    "admin_reclaim_decision",
    ({ approved, teamKey, requesterId, requesterPid }) => {
      const roomId = getRoomId(socket);
      const r = rooms[roomId];
      if (!r || !isAdmin(socket)) return;

      if (approved) {
        const team = r.teams.find((t) => t.bidKey === teamKey);
        if (team) {
          team.ownerSocketId = requesterId;
          team.ownerPlayerId = requesterPid;
          io.to(requesterId).emit("team_claim_success", teamKey);
          io.to(roomId).emit("lobby_update", {
            teams: r.teams,
            userCount: r.users.length,
          });
        }
      } else {
        io.to(requesterId).emit(
          "error_message",
          "Host denied your reclaim request."
        );
      }
    }
  );

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

  // START AUCTION - Accepts filtered teams list
  socket.on("start_auction", ({ queue }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r && isAdmin(socket)) {
      // SECURITY FIX: Use Server Internal State for Teams, do not trust client 'teams'
      const activeTeams = r.teams.filter(t => t.isTaken);
      
      r.teams = activeTeams.map((t) => ({
        ...t,
        roster: [],
        totalSpent: 0,
        totalPlayers: 0,
      }));
      r.auctionQueue = queue;
      r.state.isActive = true;
      io.to(roomId).emit("auction_started", {
        teams: r.teams,
        queue: r.auctionQueue,
      });
      startNextLot(roomId);
    }
  });

  socket.on("place_bid", ({ teamKey, amount }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (
      !r ||
      !r.state.isActive ||
      r.timerPaused ||
      r.sellingInProgress ||
      !r.currentPlayer
    )
      return;

    const team = r.teams.find((t) => t.bidKey === teamKey);
    if (!team) return;

    if (team.ownerSocketId !== socket.id) {
      if (team.ownerPlayerId === socket.playerId) {
        team.ownerSocketId = socket.id;
      } else {
        return socket.emit("error_message", "Authorization Failed");
      }
    }

    if (r.currentBidder === teamKey) return;
    if (team.budget < amount) return socket.emit("error_message", "No Budget!");
    if (amount <= r.currentBid && r.currentBidder)
      return socket.emit("error_message", "Bid too low!");

    r.currentBid = amount;
    r.currentBidder = teamKey;

    io.to(roomId).emit("bid_update", { amount, team });
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

  socket.on("finalize_sale", () => {
    const roomId = getRoomId(socket);
    if (isAdmin(socket)) {
      // Server Authority: We ignore client params (isUnsold, price, etc.)
      // internal state (r.currentBidder) determines the outcome.
      processSale(roomId, "ADMIN");
    }
  });

  socket.on("end_auction_trigger", () => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (isAdmin(socket) && r) {
      stopTimer(roomId);
      r.state.isActive = false;
      io.to(roomId).emit("open_squad_selection");
    }
  });

  socket.on("submit_squad", ({ teamKey, playing11, impact, captain }) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r) {
      r.squads[teamKey] = { playing11, impact, captain };
      io.to(roomId).emit("squad_submission_update", {
        submittedCount: Object.keys(r.squads).length,
        totalTeams: r.teams.filter((t) => t.isTaken).length,
      });

      // Auto-start simulation if all teams have submitted
      const activeTeamsCount = r.teams.filter((t) => t.isTaken).length;
      if (Object.keys(r.squads).length === activeTeamsCount) {
         console.log("All squads submitted. Auto-starting simulation...");
         runSimulationLogic(roomId, r);
      }
    }
  });



  // Added to support the previous script listener
  socket.on("startTournament", (data) => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r && isAdmin(socket)) {
      runSimulationLogic(roomId, r);
    }
  });

  socket.on("disconnect", () => {
    const roomId = getRoomId(socket);
    const r = rooms[roomId];
    if (r) {
      r.users = r.users.filter((id) => id !== socket.id);
      io.to(roomId).emit("lobby_update", {
        teams: r.teams,
        userCount: r.users.length,
      });
    }
  });
});

// --- ROBUST AI ENGINE ---
function runSimulationLogic(roomId, r) {
  // 1. Prepare Teams (Auto-fill if not submitted)
  const tourneyTeams = r.teams
    .filter((t) => t.isTaken)
    .map((t) => {
      const squadData = r.squads[t.bidKey];
      let p11 = squadData ? squadData.playing11 : [];

      // Auto-fill logic: if squad incomplete, fill from roster
      if (p11.length < 11 && t.roster.length > 0) {
        // Simple fill: take first 11 or all if less than 11
        const needed = 11 - p11.length;
        const available = t.roster.filter(
          (p) => !p11.some((x) => x.name === p.name)
        );
        p11 = [...p11, ...available.slice(0, needed)];
      }

      const captainName = squadData
        ? squadData.captain
        : p11.length > 0
        ? p11[0].name
        : "None";

      return {
        ...t,
        playing11: p11,
        captain: captainName,
      };
    })
    .filter((t) => t.playing11.length > 0); // Need at least 1 player to play

  if (tourneyTeams.length < 2) {
    return io
      .to(roomId)
      .emit(
        "simulation_error",
        "Need at least 2 teams with players to simulate!"
      );
  }

  try {
    console.log("Teams prepared, running NEW GAME LOGIC sim...");
    // Calling the NEW Logic Engine
    const results = runNewLogicSimulation(tourneyTeams);
    console.log("Simulation complete, sending results.");
    // Sending 'tournament_results' to match frontend listener in script.js
    io.to(roomId).emit("tournamentComplete", results);
  } catch (e) {
    console.error("Simulation Error:", e);
    io.to(roomId).emit("simulation_error", "Server Logic Error: " + e.message);
  }
}

// =================================================================
// 🚀 UPDATED GAME ENGINE (Strict adherence to your Luck/Role Rules)
// =================================================================

// 1. Helper to generate Luck (1-10)
const getLuck = () => Math.floor(Math.random() * 10) + 1;

// 2. Define Batting Order Priority
const ROLE_PRIORITY = {
  opener: 1,
  wk: 1, // Wicketkeepers are often top/middle
  "middle order": 2,
  batter: 2,
  finisher: 3,
  "all-rounder": 4,
  ar: 4,
  allrounder: 4,
  spinner: 5,
  spin: 5,
  "fast bowler": 6,
  bowler: 6,
  fast: 6,
  pace: 6,
};

// Helper to determine order
const getPriority = (roleKey) => {
  if (!roleKey) return 99;
  const lower = roleKey.toLowerCase();
  for (const key in ROLE_PRIORITY) {
    if (lower.includes(key)) return ROLE_PRIORITY[key];
  }
  return 99;
};

// 3. The Core Ball-by-Ball Logic
// 3. The Core Ball-by-Ball Logic (Rebalanced for T20)
// --- SIMULATION HELPERS ---

const BATTER_PROFILE = {
  opener: { aggression: 0.6, risk: 0.4 },
  anchor: { aggression: 0.35, risk: 0.2 }, // Tuned: Slower accumulation
  finisher: { aggression: 0.9, risk: 0.65 },
  allrounder: { aggression: 0.55, risk: 0.4 },
  bowler: { aggression: 0.2, risk: 0.7 },
};

function getBatterProfile(roleKey) {
  const r = (roleKey || "").toLowerCase();
  if (r.includes("finisher")) return BATTER_PROFILE.finisher;
  if (r.includes("opener")) return BATTER_PROFILE.opener;
  if (r.includes("all")) return BATTER_PROFILE.allrounder;
  if (r.includes("bowl") || r.includes("spin") || r.includes("fast"))
    return BATTER_PROFILE.bowler;
  return BATTER_PROFILE.anchor;
}

function getPhase(over) {
  if (over <= 6) return "powerplay";
  if (over <= 15) return "middle";
  return "death";
}

function chooseShot(profile, phase, pressure) {
  let boundaryChance = profile.aggression;

  if (phase === "powerplay") boundaryChance += 0.1;
  if (phase === "death") boundaryChance += 0.25;
  if (pressure > 9) boundaryChance += 0.2;

  // Anchor Cap: Anchors don't go wild unless necessary
  if (profile === BATTER_PROFILE.anchor && phase !== "death" && pressure < 8) {
     boundaryChance = Math.min(boundaryChance, 0.5);
  }

  return Math.min(boundaryChance, 0.95);
}

function getBowlerType(roleKey) {
  const r = (roleKey || "").toLowerCase();
  if (r.includes("spin")) return "spin";
  if (r.includes("fast") || r.includes("pace")) return "pace";
  return "medium";
}

function bowlerImpact(bowlerType, phase) {
  // Realism Tune: Middle overs = Stability (More dots, fewer wickets)
  if (bowlerType === "spin" && phase === "middle") return { dot: 0.2, wicket: 0.08 };
  if (bowlerType === "pace" && phase === "death") return { dot: 0.1, wicket: 0.15 };
  return { dot: 0.05, wicket: 0.05 };
}

// --- NEW REALISTIC ENGINE ---
function playBall(batsman, bowler, context) {
  const luck = getLuck();
  const profile = getBatterProfile(batsman.roleKey);
  const phase = getPhase(context.over);
  // Default RRR of 8 if setting target, else calc real RRR
  const pressure = context.requiredRunRate || 8; 
  const bowlerType = getBowlerType(bowler.roleKey);
  const impact = bowlerImpact(bowlerType, phase);

  let result = { runs: 0, isOut: false, type: "runs", commentary: "" };

  // Wicket chance (modified by luck to keep user's luck stat relevant but minimal)
  // High luck reduces out chance slightly
  const luckFactor = (10 - luck) * 0.02; 
  
  if (Math.random() < (profile.risk + impact.wicket + luckFactor) * 0.15) {
    result.isOut = true;
    result.type = "out";
    result.commentary = "Caught! The risk didn't pay off.";
    return result;
  }

  // Dot ball chance
  if (Math.random() < impact.dot) {
    result.runs = 0;
    result.commentary = "Excellent delivery. No run.";
    return result;
  }

  // Boundary decision
  const boundaryChance = chooseShot(profile, phase, pressure);
  // Luck boosts boundary chance
  if (Math.random() < boundaryChance * (luck / 5)) {
    result.runs = Math.random() < 0.65 ? 4 : 6;
    
    // Realism Tune: Bowlers rarely hit 6s unless Luck is perfect
    if (profile === BATTER_PROFILE.bowler && result.runs === 6 && luck < 10) {
        result.runs = 4; // Downgrade to 4
        result.commentary = "Edged down to third man for FOUR."; 
    }

    result.type = result.runs === 4 ? "four" : "six";
    if (!result.commentary) {
         result.commentary = result.runs === 4 ? "Smashed for FOUR!" : "That's huge! SIX runs!";
    }
    return result;
  }

  // Strike rotation (1s, 2s, 3s)
  result.runs = Math.floor(Math.random() * 3) + 1;
  result.commentary = "Working the gaps.";
  return result;
}

function runNewLogicSimulation(teams) {
  const allStats = {}; // Central stats tracker for Caps
  const leagueMatches = [];
  const playoffs = [];

  // Init Stats
  teams.forEach((t) => {
    t.stats = {
      p: 0,
      w: 0,
      l: 0,
      pts: 0,
      nrr: 0,
      runsScored: 0,
      runsConceded: 0,
      oversFaced: 0,
      oversBowled: 0,
    };
    t.playing11.forEach((p) => {
      allStats[p.name] = {
        name: p.name,
        runs: 0,
        wkts: 0,
        pts: 0,
        fours: 0,
        sixes: 0,
      };
    });
  });

  const getPlayerStat = (name) => {
    if (!allStats[name])
      allStats[name] = {
        name: name,
        runs: 0,
        wkts: 0,
        pts: 0,
        fours: 0,
        sixes: 0,
      };
    return allStats[name];
  };

  // --- INNINGS SIMULATOR ---
  function simulateInnings(batTeam, bowlTeam, target = null, pitchType = "flat") {
    // 1. Sort Batting Lineup based on Roles
    const battingLineup = [...batTeam.playing11].sort(
      (a, b) => getPriority(a.roleKey) - getPriority(b.roleKey)
    );

    // 2. Prepare Bowling Options (All non-WK usually)
    let bowlers = bowlTeam.playing11.filter(
      (p) => getPriority(p.roleKey) !== 1
    ); // exclude openers/wk usually
    // Prioritize actual bowlers/ARs
    bowlers = bowlTeam.playing11.filter((p) => {
      const r = (p.roleKey || "").toLowerCase();
      return (
        r.includes("bowl") ||
        r.includes("fast") ||
        r.includes("spin") ||
        r.includes("ar") ||
        r.includes("all")
      );
    });
    if (bowlers.length < 5) bowlers = bowlTeam.playing11.slice(5); // fallback
    if (bowlers.length === 0) bowlers = bowlTeam.playing11; // Extreme fallback (squad < 5)

    // Card Data for Scorecard
    const batCard = battingLineup.map((p) => ({
      name: p.name,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      status: "dnb",
    }));

    const bowlCardMap = {}; // Helper to track bowler stats

    let score = 0,
      wickets = 0,
      balls = 0;
    let strikerIdx = 0,
      nonStrikerIdx = 1;

    batCard[strikerIdx].status = "not out";
    if (batCard[nonStrikerIdx]) batCard[nonStrikerIdx].status = "not out";

    for (let ball = 1; ball <= 120; ball++) {
      // Safety check: Stop if wickets exceed available batters (e.g. squad < 11)
      if (wickets >= 10 || wickets >= batCard.length - 1 || (target && score > target)) break;

      const currentBatsman = batCard[strikerIdx];
      const originalBatsmanObj = battingLineup[strikerIdx];

      // Rotate Bowlers (Max 4 overs limit)
      let bowlerIndex = Math.floor((ball - 1) / 6) % bowlers.length;
      let bowlerObj = bowlers[bowlerIndex];

      // Find valid bowler (check quota)
      let attempts = 0;
      while (attempts < bowlers.length) {
        const bName = bowlerObj.name;
        // Init stats if needed to check usage
        if (!bowlCardMap[bName]) {
          bowlCardMap[bName] = {
            name: bName,
            runs: 0,
            wkts: 0,
            balls: 0,
            economy: 0,
          };
        }
        
        if (bowlCardMap[bName].balls < 24) {
          break; // Found valid bowler
        }
        
        // Try next bowler
        bowlerIndex = (bowlerIndex + 1) % bowlers.length;
        bowlerObj = bowlers[bowlerIndex];
        attempts++;
      }

      // Fallback: If all main bowlers exhausted, find ANYONE who can bowl
      if (attempts >= bowlers.length) {
          const partTimer = bowlTeam.playing11.find(p => {
              const bg = bowlCardMap[p.name];
              return !bg || bg.balls < 24;
          });
          if (partTimer) {
             bowlerObj = partTimer;
          } else {
             // Absolute worst case: Allow overflow
             bowlerObj = bowlers[0]; 
          }
           // Ensure stats exist for safety
           if (!bowlCardMap[bowlerObj.name]) {
              bowlCardMap[bowlerObj.name] = {
                  name: bowlerObj.name,
                  runs: 0, wkts: 0, balls: 0, economy: 0
              };
           }
      }
      
      const bowlerStats = bowlCardMap[bowlerObj.name];

      // --- PLAY BALL ---
      const context = {
        over: Math.floor((ball - 1) / 6) + 1,
        wickets: wickets,
        requiredRunRate: target
          ? Math.max(0, (target - score) / (Math.max(1, 120 - (ball - 1)) / 6))
          : null,
      };

      const res = playBall(originalBatsmanObj, bowlerObj, context);

      currentBatsman.balls++;
      bowlerStats.balls++;

      if (res.isOut) {
        wickets++;
        currentBatsman.status = "out";
        bowlerStats.wkts++;

        // Update Global Stats
        getPlayerStat(bowlerObj.name).wkts++;
        getPlayerStat(bowlerObj.name).pts += 25;

        // Next Batsman
        // Next Batsman (Logic: Wickets count = previous outs + 1 current out. 
        // So new batter index = wickets + 1, because 0 and 1 were openers)
        strikerIdx = Math.min(wickets + 1, batCard.length - 1);
        if (batCard[strikerIdx]) batCard[strikerIdx].status = "not out";
      } else {
        score += res.runs;
        currentBatsman.runs += res.runs;
        bowlerStats.runs += res.runs;

        // Update Global Stats
        const pStat = getPlayerStat(currentBatsman.name);
        pStat.runs += res.runs;
        pStat.pts += res.runs;

        if (res.type === "four") {
          currentBatsman.fours++;
          pStat.fours++;
          pStat.pts += 1;
        }
        if (res.type === "six") {
          currentBatsman.sixes++;
          pStat.sixes++;
          pStat.pts += 2;
        }

        // Swap Strike
        if (res.runs % 2 !== 0) {
          [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];
        }
      }

      // Over End Swap
      if (ball % 6 === 0) {
        [strikerIdx, nonStrikerIdx] = [nonStrikerIdx, strikerIdx];
      }
    }

    // Convert Map to Array for Scorecard
    const bowlCard = Object.values(bowlCardMap);
    bowlCard.forEach((b) => {
      b.oversDisplay = `${Math.floor(b.balls / 6)}.${b.balls % 6}`;
      b.economy = (b.runs / (b.balls / 6 || 1)).toFixed(1);
    });

    return {
      score,
      wickets,
      balls,
      bat: batCard,
      bowl: bowlCard,
      team: batTeam.name,
    };
  }

  function playMatch(t1, t2, type) {
    // Determine Pitch Condition: 25% Bowling, 75% Batting (Flat)
    const pitchType = Math.random() < 0.25 ? "bowling" : "flat";
    
    const i1 = simulateInnings(t1, t2, null, pitchType);
    const i2 = simulateInnings(t2, t1, i1.score, pitchType);

    let winnerName = i2.score > i1.score ? t2.name : t1.name;
    if (i1.score === i2.score) winnerName = t1.name; // Simple tie-break

    const margin =
      i2.score > i1.score
        ? `${10 - i2.wickets} wkts`
        : `${i1.score - i2.score} runs`;

    // Stats Update for Table
    if (type === "League") {
      const winner = [t1, t2].find((t) => t.name === winnerName);
      const loser = [t1, t2].find((t) => t.name !== winnerName);

      winner.stats.played++;
      winner.stats.p++;
      winner.stats.won++;
      winner.stats.w++;
      winner.stats.pts += 2;
      loser.stats.played++;
      loser.stats.p++;
      loser.stats.lost++;
      loser.stats.l++;

      // NRR Calc helpers
      winner.stats.runsScored += winner === t1 ? i1.score : i2.score;
      winner.stats.runsConceded += winner === t1 ? i2.score : i1.score;
      winner.stats.oversFaced += winner === t1 ? 20 : i2.balls / 6;
      winner.stats.oversBowled += winner === t1 ? i2.balls / 6 : 20;

      loser.stats.runsScored += loser === t1 ? i1.score : i2.score;
      loser.stats.runsConceded += loser === t1 ? i2.score : i1.score;
      loser.stats.oversFaced += loser === t1 ? 20 : i2.balls / 6;
      loser.stats.oversBowled += loser === t1 ? i2.balls / 6 : 20;
    }

    // Helper for Top Performer
    const bestBat = [...i1.bat, ...i2.bat].sort((a, b) => b.runs - a.runs)[0];
    const bestBowl = [...i1.bowl, ...i2.bowl].sort(
      (a, b) => b.wkts - a.wkts
    )[0];

    return {
      t1: t1.name,
      t2: t2.name,
      score1: `${i1.score}/${i1.wickets}`,
      score2: `${i2.score}/${i2.wickets}`,
      winnerName,
      margin,
      type,
      topScorer: bestBat,
      bestBowler: {
        name: bestBowl?.name || "-",
        figures: `${bestBowl?.wkts || 0} wkts`,
      },
      details: { i1, i2 },
    };
  }

  // --- LEAGUE GENERATION (Double Round Robin) ---
  // 2 Matches against every team (Home and Away)
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
        // Match 1: i vs j
        leagueMatches.push(playMatch(teams[i], teams[j], "League"));
        // Match 2: j vs i
        leagueMatches.push(playMatch(teams[j], teams[i], "League"));
    }
  }

  // Calculate NRR and Sort
  teams.forEach((t) => {
    t.stats.nrr =
      t.stats.runsScored / t.stats.oversFaced -
        t.stats.runsConceded / t.stats.oversBowled || 0;
  });
  teams.sort((a, b) => b.stats.pts - a.stats.pts || b.stats.nrr - a.stats.nrr);

  // --- PLAYOFFS ---
  // Top 4 play playoffs, else Top 2 play final
  let champion = teams[0].name;
  let runner = teams[1] ? teams[1].name : "";

  if (teams.length >= 4) {
    const q1 = playMatch(teams[0], teams[1], "Qualifier 1");
    const elim = playMatch(teams[2], teams[3], "Eliminator");

    const loserQ1 = q1.winnerName === teams[0].name ? teams[1] : teams[0];
    const winnerElim = elim.winnerName === teams[2].name ? teams[2] : teams[3];

    const q2 = playMatch(loserQ1, winnerElim, "Qualifier 2");

    const finalist1 = teams.find((t) => t.name === q1.winnerName);
    const finalist2 = teams.find((t) => t.name === q2.winnerName);

    const final = playMatch(finalist1, finalist2, "FINAL");
    playoffs.push(q1, elim, q2, final);
    champion = final.winnerName;
    runner =
      final.winnerName === finalist1.name ? finalist2.name : finalist1.name;
  } else if (teams.length >= 2) {
    const final = playMatch(teams[0], teams[1], "FINAL");
    playoffs.push(final);
    champion = final.winnerName;
  }

  const statsArr = Object.values(allStats);

  return {
    winner: champion,
    runnerUp: runner,
    standings: teams,
    leagueMatches,
    playoffs,
    allTeamsData: teams,
    orangeCap: statsArr.sort((a, b) => b.runs - a.runs)[0],
    purpleCap: statsArr.sort((a, b) => b.wkts - a.wkts)[0],
    mvp: statsArr.sort((a, b) => b.pts - a.pts)[0],
  };
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

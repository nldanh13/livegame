/**
 * CÔNG THÀNH CHIẾN - SĂN 3 SAO  (v5: solo + đội Xanh/Đỏ, Rồng canh, quỹ đội, quà phá hoại)
 * Server: nhận sự kiện TikTok Live -> đưa vào bộ luật chơi (game.js) -> đẩy ảnh chụp trận đấu sang overlay OBS.
 *
 * >>> ĐIỀN TÊN KÊNH TIKTOK CỦA BẠN Ở DÒNG DƯỚI (không có dấu @) <<<
 */
const TIKTOK_USERNAME = process.env.TIKTOK_USER || 'ten_kenh_cua_ban';
const PORT = process.env.PORT || 3000;

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { Game } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* ------------------------------------------------------------------ */
/* Log + config (tự nạp lại khi sửa config.json)                        */
/* ------------------------------------------------------------------ */
const recentLog = [];
function log(msg) {
  console.log(msg);
  recentLog.push({ t: Date.now(), msg: String(msg) });
  if (recentLog.length > 40) recentLog.shift();
}

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config, chatCommands, joinCommands, diamondTiers;

function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config = c;
  diamondTiers = [...(c.diamondTiers || [])].sort((a, b) => b.minDiamonds - a.minDiamonds);
  chatCommands = {};
  joinCommands = {};
  for (const [k, v] of Object.entries((c.team && c.team.joinCommands) || {})) joinCommands[k.trim().toLowerCase().normalize('NFC')] = v;
  for (const [k, v] of Object.entries((c.chat && c.chat.commands) || {})) chatCommands[k.trim().toLowerCase()] = v;
}
let configWarnings = [];
function validateConfig(c) {
  const w = [], has = (k) => !!(c.troops[k] || c.spells[k]);
  for (const [g, k] of Object.entries(c.gifts || {})) if (!has(k)) w.push(`Quà "${g}" đang gán cho "${k}" nhưng không có lính/phép này trong config.json`);
  for (const t of c.diamondTiers || []) if (!c.troops[t.troop]) w.push(`diamondTiers: lính "${t.troop}" không tồn tại`);
  for (const [cmd, k] of Object.entries((c.chat && c.chat.commands) || {})) if (!has(k)) w.push(`Lệnh chat "${cmd}" trỏ tới "${k}" không tồn tại`);
  if (c.likes && c.likes.enabled && !c.troops[c.likes.troop]) w.push(`likes.troop "${c.likes.troop}" không tồn tại`);
  for (const [ev, e] of Object.entries(c.events || {})) if (e && e.enabled && !c.troops[e.troop]) w.push(`events.${ev}.troop "${e.troop}" không tồn tại`);
  for (const e of [...(c.layout || []), ...(c.bossLayout || [])]) if (!c.buildings[e.type]) w.push(`layout: công trình "${e.type}" không tồn tại`);
  for (const k of ['guardian', 'siegeMachine', 'hero']) if (!(c.npcs && c.npcs[k])) w.push(`Thiếu npcs.${k} (tính năng chế độ Đội sẽ lỗi)`);
  for (const [k, t] of Object.entries(c.troops)) if (!t.look || !t.hp) w.push(`Lính "${k}" thiếu look/hp`);
  return w;
}
loadConfig();
configWarnings = validateConfig(config);
configWarnings.forEach((m) => console.warn('⚠️  Cấu hình: ' + m));

const clientConfig = () => ({
  troops: config.troops, spells: config.spells, buildings: config.buildings, npcs: config.npcs || {}, gifts: config.gifts || {}, brand: config.brand || {},
  team: { names: config.team.names, colors: config.team.colors, hint: '!xanh / !do', siegeBonus: config.team.siegeBonus || 1, clashSec: config.team.clashSec || 90 },
});

fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  try {
    loadConfig();
    configWarnings = validateConfig(config); configWarnings.forEach((m) => console.warn('⚠️  Cấu hình: ' + m));
    game.setConfig(config);
    io.emit('config', clientConfig());
    log('♻️  Đã nạp lại config.json (áp dụng cho lính/phép mới; công trình áp dụng từ ván sau)');
  } catch (e) {
    console.error('⚠️  config.json bị lỗi cú pháp, giữ bản cũ:', e.message);
  }
});

/* ------------------------------------------------------------------ */
/* Lưu trữ: cấp, độ khó, kỷ lục                                         */
/* ------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, 'data');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
let stats = { level: 1, bestLevel: 1, roundsWon: 0, difficulty: config.difficulty.start || 1, allTime: {}, mode: config.mode || 'solo', teamScore: { blue: 0, red: 0, draws: 0 }, teamDifficulty: 1 };
try { stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) }; } catch (_) { /* lần chạy đầu */ }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const top = Object.entries(stats.allTime).sort((a, b) => b[1].dmg - a[1].dmg).slice(0, 300);
      stats.allTime = Object.fromEntries(top);
      fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
    } catch (e) { console.error('Không lưu được stats.json:', e.message); }
  }, 5000);
}

function topAllTime(n = 3) {
  return Object.values(stats.allTime).sort((a, b) => b.dmg - a.dmg).slice(0, n)
    .map((p) => ({ name: p.name, avatar: p.avatar, dmg: Math.round(p.dmg) }));
}

// Hạng người xem: sát thương thật gây ra qua các buổi live -> lính mạnh hơn
function rankOf(userId) {
  const dmg = (stats.allTime[userId] && stats.allTime[userId].dmg) || 0;
  let r = config.ranks && config.ranks[0];
  for (const x of config.ranks || []) if (dmg >= x.min) r = x;
  return r || null;
}

/* ------------------------------------------------------------------ */
/* Game                                                                 */
/* ------------------------------------------------------------------ */
let roundTimer = null;
let endPending = null;

const game = new Game(config, {
  emit(type, data) {
    io.emit(type, data);
    if (type === 'cleared') { endPending = setTimeout(() => endRound('win'), 2800); }
    else if (type === 'timeup') { endRound('timeout'); }
    else if (type === 'guardian') log('🐉 Rồng canh kho báu xuất hiện giữa sân!');
    else if (type === 'guardianDown') log(`🏆 ${data.by || 'Đội ' + data.team} hạ Rồng! Đội ${(config.team.names[data.team] || data.team)} nhận buff ×${data.mult} trong ${data.buffSec}s`);
    else if (type === 'golden') log('✨ GIỜ VÀNG: sát thương ×' + data.mult);
    else if (type === 'overtime') log('⏱️  Hòa! Vào hiệp phụ "cái chết bất ngờ"');
    else if (type === 'unlock') log(`🛠️  Quỹ đội ${(config.team.names[data.team] || data.team)} đầy: ${data.label} xuất trận`);
    else if (type === 'morale') log(`📣 Đội ${(config.team.names[data.team] || data.team)} đủ tinh thần: buff ×${data.mult}`);
    else if (type === 'bounty') log(`🎯 Truy nã ${data.name} (${data.pts} điểm)`);
    else if (type === 'bldDestroyed' && data.kind !== 'resource') log(`💥 ${data.by || '?'} phá hủy ${(config.buildings[data.type] || {}).label || data.type}`);
  },
  onDamage(owner, amount) {
    if (owner.sim) return;
    const a = (stats.allTime[owner.id] ||= { name: owner.name, avatar: owner.avatar, dmg: 0 });
    a.dmg += amount; a.name = owner.name;
    if (owner.avatar) a.avatar = owner.avatar;
    scheduleSave();
  },
});

function roundPayload() {
  return {
    mode: game.mode, level: game.level, boss: game.boss, mod: game.mod ? game.mod.label : '',
    layout: game.layout(), roundLen: game.roundLen, arena: game.arena,
    teamScore: stats.teamScore, teams: teamInfo(),
  };
}

function newRound(level) {
  clearTimeout(endPending); clearTimeout(roundTimer); roundSeq++; giftUse = {}; roundReal = false; if (cheerState.size > 5000) cheerState.clear();
  if (stats.mode === 'team') {
    game.newRound(config.team.level, stats.teamDifficulty, 'team');
    updateHandicap();
  } else {
    game.newRound(level, stats.difficulty, 'solo');
    stats.level = level;
    stats.bestLevel = Math.max(stats.bestLevel, level);
  }
  scheduleSave();
  io.emit('roundStart', roundPayload());
  if (game.mode === 'team') log(`⚔️  Trận đội mới - căn cứ cấp ${config.team.level} - độ khó ×${stats.teamDifficulty.toFixed(2)} - giao tranh ${config.team.clashSec || 90}s rồi công thành`);
  else log(`🏰 Ván mới - Cấp ${level}${game.boss ? ' (BOSS)' : ''} - độ khó ×${stats.difficulty.toFixed(2)}${game.mod ? ' - ' + game.mod.label : ''}`);
}

function endRound(result) {
  if (game.status === 'ended') return;
  clearTimeout(endPending);
  const dcfg = config.difficulty;
  const win = result === 'win';
  let payload, nextLevel = game.level, breakSec = config.round.breakSec;
  const realRound = roundReal, before = realRound ? null : JSON.stringify({ level: stats.level, bestLevel: stats.bestLevel, roundsWon: stats.roundsWon, difficulty: stats.difficulty, teamScore: stats.teamScore, teamDifficulty: stats.teamDifficulty });

  if (game.mode === 'team') {
    const res = game.teamResult();
    if (res.winner === 'blue' || res.winner === 'red') stats.teamScore[res.winner]++; else stats.teamScore.draws++;
    const pmax = Math.max(res.teams.blue.p, res.teams.red.p) / 100;
    if (!win && pmax < 0.5) stats.teamDifficulty = Math.max(dcfg.min, stats.teamDifficulty - dcfg.easeOnTimeout);
    else if (win && game.timeLeft / game.roundLen > dcfg.fastWinRatio) stats.teamDifficulty = Math.min(dcfg.max, stats.teamDifficulty + dcfg.hardenOnFastWin);
    breakSec = config.team.breakSec;
    payload = {
      mode: 'team', result, winner: res.winner, reason: win ? (game.clearReason || 'annihilation') : (game.overtimeUsed ? 'overtime' : 'timeup'), teams: res.teams,
      teamScore: stats.teamScore, allTime: topAllTime(3), breakMs: breakSec * 1000,
    };
    log(`🏁 Kết thúc trận đội: ${res.winner === 'draw' ? 'HÒA' : 'ĐỘI ' + (config.team.names[res.winner] || res.winner).toUpperCase() + ' THẮNG'} - Xanh ${res.teams.blue.starCount}* ${res.teams.blue.p}% / Đỏ ${res.teams.red.starCount}* ${res.teams.red.p}%`);
  } else {
    const starCount = game.starCount();
    if (win) {
      stats.roundsWon++;
      if (game.timeLeft / game.roundLen > dcfg.fastWinRatio) stats.difficulty = Math.min(dcfg.max, stats.difficulty + dcfg.hardenOnFastWin);
    } else if (starCount < 2) {
      stats.difficulty = Math.max(dcfg.min, stats.difficulty - dcfg.easeOnTimeout);
    }
    nextLevel = win ? game.level + 1 : game.level;
    payload = {
      mode: 'solo', result, stars: game.stars, starCount, level: game.level, boss: game.boss,
      destruction: Math.round(game.destruction() * 100), thKiller: game.thKiller,
      top: game.topPlayers(3), allTime: topAllTime(3), breakMs: breakSec * 1000,
    };
    log(`🏁 Kết thúc ván: ${win ? 'THẮNG' : 'hết giờ'} - ${starCount} sao - phá ${payload.destruction}%`);
  }
  if (!realRound) { Object.assign(stats, JSON.parse(before)); nextLevel = game.level; if (payload.teamScore) payload.teamScore = stats.teamScore; payload.demo = true; }
  try {
    if (game.mode === 'team' && realRound) { // đại gia của mùa: cộng dồn điểm quà mỗi trận
      const sp = (stats.seasonPts ||= {});
      for (const o of game.owners) if (!o.sim && o.points > 0) { const a = (sp[o.id] ||= { name: o.name, avatar: o.avatar, pts: 0 }); a.name = o.name; a.pts += o.points; }
      const keep = Object.entries(sp).sort((a, b) => b[1].pts - a[1].pts).slice(0, 300); stats.seasonPts = Object.fromEntries(keep);
      payload.seasonTop = keep.slice(0, 3).map(([, v]) => ({ name: v.name, avatar: v.avatar, pts: Math.round(v.pts) }));
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const rec = { t: new Date().toISOString(), mode: game.mode, level: game.level, result, winner: payload.winner || null, reason: payload.reason || null,
      sec: Math.round(game.roundLen - game.timeLeft), overtime: !!game.overtimeUsed, guardian: game.mode === 'team' ? (game.guardianState === 2 ? 'gone' : game.guardianState === 1 ? 'alive' : 'none') : null,
      players: game.owners.filter((o) => !o.sim).length, gifts: giftUse, demo: !realRound,
      blue: payload.teams ? { p: payload.teams.blue.p, s: payload.teams.blue.starCount } : null, red: payload.teams ? { p: payload.teams.red.p, s: payload.teams.red.starCount } : null,
      p: payload.destruction != null ? payload.destruction : null, stars: payload.starCount != null ? payload.starCount : null };
    fs.appendFile(path.join(DATA_DIR, 'matches.jsonl'), JSON.stringify(rec) + '\n', () => {});
  } catch (e) { console.error('⚠️  Không ghi được nhật ký trận:', e.message); }
  scheduleSave();
  game.status = 'ended';
  io.emit('roundEnd', payload);
  roundTimer = setTimeout(() => newRound(nextLevel), breakSec * 1000);
}

function snapPayload() {
  const top = game.mode === 'team' ? { blue: game.topPlayers(1, 'blue'), red: game.topPlayers(1, 'red') } : game.topPlayers(3);
  return { ...game.snapshot(), top };
}

// Vòng lặp mô phỏng: 20 lần/giây, gửi ảnh chụp 10 lần/giây
let lastTick = Date.now(), tickN = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  if (game.status === 'playing') game.tick(dt);
  tickN++;
  if (game.status === 'playing' || game.status === 'cleared') {
    if (tickN % 2 === 0 && (game.units.length || tickN % 10 === 0)) io.volatile.emit('snap', snapPayload());
  }
}, 50);

/* ------------------------------------------------------------------ */
/* Nhận sự kiện -> game                                                 */
/* ------------------------------------------------------------------ */
/* ---------- Đội (chỉ dùng trong chế độ team) ---------- */
const teamOf = new Map();    // userId -> 'blue' | 'red'
const lastActive = new Map(); // userId -> thời điểm tương tác gần nhất

function activeCounts() {
  const cut = Date.now() - (config.team.handicap.activeMinutes || 20) * 60000;
  const c = { blue: 0, red: 0 };
  for (const [id, t] of teamOf) if ((lastActive.get(id) || 0) >= cut) c[t]++;
  return c;
}

function updateHandicap() {
  const c = activeCounts(), h = config.team.handicap, m = { blue: 1, red: 1 };
  if (h && h.enabled && game.mode === 'team') {
    const big = c.blue >= c.red ? 'blue' : 'red', small = big === 'blue' ? 'red' : 'blue';
    const ratio = Math.max(c[big], 1) / Math.max(c[small], 1);
    if (c[big] >= 4 && ratio > 1) m[small] = 1 + Math.min(h.maxBonus, (ratio - 1) * h.perRatio);
  }
  game.setHandicap(m);
  game.setActive(c.blue + c.red);
  return { counts: c, handicap: m };
}
const teamInfo = () => { const x = updateHandicap(); return { counts: x.counts, handicap: x.handicap }; };
setInterval(() => {
  if (game.mode !== 'team') return;
  io.emit('teams', teamInfo());
  const cut = Date.now() - 3 * 3600000; // dọn người không hoạt động > 3 giờ
  for (const [id, t] of lastActive) if (t < cut) { lastActive.delete(id); teamOf.delete(id); }
}, 3000);

function joinTeam(user, want, source) {
  // Một khi đã đóng góp trong trận này thì không được đổi đội
  if (game.ownerMap.has(user.id)) return teamOf.get(user.id) || null;
  const c = activeCounts();
  let team = want;
  if (team !== 'blue' && team !== 'red') team = c.blue === c.red ? (Math.random() < 0.5 ? 'blue' : 'red') : (c.blue < c.red ? 'blue' : 'red');
  if (teamOf.get(user.id) === team) return team;
  teamOf.set(user.id, team);
  lastActive.set(user.id, Date.now());
  io.emit('join', { user: { name: user.name, avatar: user.avatar }, team, auto: source === 'auto', counts: activeCounts() });
  log(`👥 ${user.name} vào đội ${config.team.names[team]}${source === 'auto' ? ' (tự chia)' : ''}`);
  return team;
}

function resolveTeam(user) {
  if (game.mode !== 'team') return 'atk';
  if (user.sim) return user.team;
  lastActive.set(user.id, Date.now());
  return teamOf.get(user.id) || joinTeam(user, 'auto', 'auto');
}

// points: giá trị đóng góp vào quỹ đội (1 xu = 1 điểm) và xếp hạng "truy nã"
let giftUse = {};
function dispatch(user, key, count, source, points = 0) {
  const team = resolveTeam(user);
  if (!team) return;
  if (source === 'sim') touchReal();
  if (!user.sim) giftUse[key] = (giftUse[key] || 0) + count;
  const rank = user.sim ? null : rankOf(user.id);
  if (config.troops[key]) game.spawn(user, key, count, source, rank, team, points);
  else if (config.spells[key]) game.cast(user, key, count, source, rank, team, points);
}

/* ---------- Hô hào: chat lại lệnh đội của mình để nạp thanh tinh thần ---------- */
const cheerState = new Map(); // userId -> { round, last, n }
let roundSeq = 0;
function cheer(user, team) {
  const ch = config.team.cheer || {}, now = Date.now();
  let st = cheerState.get(user.id);
  if (!st || st.round !== roundSeq) st = { round: roundSeq, last: 0, n: 0 };
  if (now - st.last < (ch.perUserGapSec || 1.5) * 1000 || st.n >= (ch.perUserCap || 30)) return;
  st.last = now; st.n++; cheerState.set(user.id, st);
  game.addMorale(team, 1);
}

function noteGift(d) {
  const sg = (stats.seenGifts ||= {}), n = String(d.giftName || '').slice(0, 60); if (!n) return;
  const g = (sg[n] ||= { name: n, diamonds: 0, count: 0, last: 0 });
  g.count += Math.max(1, d.repeatCount || 1); g.diamonds = d.diamondCount || g.diamonds; g.last = Date.now();
  if (Object.keys(sg).length > 200) { const keep = Object.entries(sg).sort((a, b) => b[1].last - a[1].last).slice(0, 150); stats.seenGifts = Object.fromEntries(keep); }
  scheduleSave();
}
function pickForGift(gift) {
  const byName = config.gifts && config.gifts[gift.giftName];
  if (byName && (config.troops[byName] || config.spells[byName])) return byName;
  for (const tier of diamondTiers) if (gift.diamondCount >= tier.minDiamonds && config.troops[tier.troop]) return tier.troop;
  return null;
}

const normTxt = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
function cleanName(name) { // tên hiện trực tiếp trên live: che từ nhạy cảm để kênh không bị cảnh cáo
  const m = config.moderation; name = String(name || '').slice(0, (m && m.maxLen) || 24);
  if (!m || !m.enabled) return name;
  const tokens = normTxt(name).split(/[^a-z0-9]+/).filter(Boolean), joined = tokens.join('');
  for (const w of m.badWords || []) { const b = normTxt(w).replace(/[^a-z0-9]/g, ''); if (b && (b.length >= 5 ? joined.includes(b) : tokens.includes(b))) return m.replaceWith || 'Khán giả'; }
  return name;
}
let lastReal = Date.now(), roundReal = false;
const touchReal = () => { lastReal = Date.now(); };
function userFrom(d) {
  touchReal(); roundReal = true;
  return {
    id: d.uniqueId || String(d.userId || 'unknown'),
    name: cleanName(d.nickname || d.uniqueId || 'Ẩn danh'),
    avatar: typeof d.profilePictureUrl === 'string' ? d.profilePictureUrl : '',
  };
}

/* ------------------------------------------------------------------ */
/* TikTok Live                                                          */
/* ------------------------------------------------------------------ */
let reconnectTimer = null, tiktokConnected = false, likeBucket = 0;
const chatCooldown = new Map(), socialDone = new Set();

function scheduleReconnect(ms) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connectTikTok, ms); }

function connectTikTok() {
  if (TIKTOK_USERNAME === 'ten_kenh_cua_ban') {
    log('⚠️  Chưa điền tên kênh TikTok trong server.js -> chạy CHẾ ĐỘ THỬ (dùng http://localhost:' + PORT + '/admin).');
    return;
  }
  const conn = new WebcastPushConnection(TIKTOK_USERNAME, { processInitialData: false });
  conn.connect()
    .then((s) => { tiktokConnected = true; log(`✅ Đã kết nối phòng live @${TIKTOK_USERNAME} (roomId ${s.roomId})`); })
    .catch((err) => { tiktokConnected = false; log(`❌ Không kết nối được (kênh phải đang LIVE): ${err.message || err}`); scheduleReconnect(15000); });

  conn.on('gift', (d) => {
    touchReal();
    log(`🎁 ${d.nickname}: "${d.giftName}" x${d.repeatCount} (${d.diamondCount} xu/quà)`);
    if (d.giftType === 1 && !d.repeatEnd) return; // chuỗi quà chưa kết thúc
    noteGift(d);
    const key = pickForGift(d);
    if (key) dispatch(userFrom(d), key, Math.max(1, d.repeatCount || 1), 'gift', Math.max(1, (d.diamondCount || 1) * Math.max(1, d.repeatCount || 1)));
  });

  conn.on('like', (d) => {
    touchReal();
    const lk = config.likes;
    if (!lk || !lk.enabled) return;
    likeBucket += d.likeCount || 1;
    if (likeBucket >= lk.likesPerTroop) {
      const n = Math.floor(likeBucket / lk.likesPerTroop);
      likeBucket %= lk.likesPerTroop;
      dispatch(userFrom(d), lk.troop, n, 'like', n * ((config.team.fund && config.team.fund.likePoints) || 1));
    }
  });

  for (const ev of ['follow', 'share']) {
    conn.on(ev, (d) => {
      const e = config.events && config.events[ev];
      if (!e || !e.enabled) return;
      const u = userFrom(d);
      const k = ev + ':' + u.id + ':' + game.mode + ':' + game.level + ':' + stats.roundsWon + ':' + (stats.teamScore.blue + stats.teamScore.red + stats.teamScore.draws); // mỗi người 1 lần / ván
      if (socialDone.has(k)) return;
      socialDone.add(k);
      if (socialDone.size > 5000) socialDone.clear();
      dispatch(u, e.troop, e.count || 1, ev, (config.team.fund && config.team.fund[ev + 'Points']) || 0);
    });
  }

  conn.on('chat', (d) => {
    touchReal();
    if (!d.comment) return;
    const text = d.comment.trim().toLowerCase().normalize('NFC');
    // Lệnh chọn đội (chỉ có tác dụng trong chế độ đội)
    if (game.mode === 'team') {
      const want = joinCommands[text];
      if (want) {
        const u = userFrom(d); lastActive.set(u.id, Date.now());
        if ((want === 'blue' || want === 'red') && teamOf.get(u.id) === want) cheer(u, want); // đã ở đội này: chat lại lệnh = hô hào
        else joinTeam(u, want, 'chat');
        return;
      }
    }
    const cc = config.chat;
    if (!cc || !cc.enabled) return;
    const key = chatCommands[text];
    if (!key) return;
    const u = userFrom(d), now = Date.now();
    if (now - (chatCooldown.get(u.id) || 0) < (cc.cooldownSec || 30) * 1000) return;
    chatCooldown.set(u.id, now);
    dispatch(u, key, 1, 'chat', (config.team.fund && config.team.fund.chatPoints) || 0);
  });

  conn.on('streamEnd', () => log('📴 Livestream đã kết thúc.'));
  conn.on('disconnected', () => { tiktokConnected = false; log('🔌 Mất kết nối, thử lại sau 10 giây...'); scheduleReconnect(10000); });
}

/* ------------------------------------------------------------------ */
/* Web: overlay, admin (chỉ máy bạn), Socket.io                         */
/* ------------------------------------------------------------------ */
const LOCAL = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
function localOnly(req, res, next) {
  if (LOCAL.includes(req.socket.remoteAddress || '')) return next();
  res.sendStatus(403);
}

app.use(express.static(path.join(__dirname, 'public')));

// Trang overlay: ưu tiên public/index.html; nếu lỡ để index.html cạnh server.js thì vẫn chạy; nếu thiếu thì báo rõ lý do
const OVERLAY_CANDIDATES = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')];
app.get('/', (_req, res) => {
  const f = OVERLAY_CANDIDATES.find((x) => fs.existsSync(x));
  if (f) return res.sendFile(f);
  res.status(404).type('text/plain; charset=utf-8').send(
    'Không tìm thấy file overlay.\n\nHãy đặt file index.html vào thư mục "public" cạnh server.js:\n  ' +
    OVERLAY_CANDIDATES[0] + '\n\nCấu trúc đúng:\n  server.js\n  game.js\n  config.json\n  admin.html\n  public/index.html'
  );
});
app.get('/admin', localOnly, (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

const simUser = (team, name) => ({ id: 'sim-' + team, name: name || 'Khán giả thử', avatar: '', sim: true, team });
const simTeam = (t) => (game.mode === 'team' ? (t === 'red' ? 'red' : 'blue') : 'atk');

/* ---------- Chế độ trình diễn: phòng vắng thì khán giả ảo tự đánh nhau để màn hình không trống ---------- */
let demoOn = false, demoNext = 0;
const DEMO_NAMES = ['Lan Anh', 'Minh Khôi', 'Bảo Trân', 'Hoàng Nam', 'Thu Hà', 'Quốc Đạt', 'Ngọc Mai', 'Tuấn Kiệt', 'Phương Linh', 'Đức Anh', 'Gia Hân', 'Khánh Vy'];
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
setInterval(() => {
  const c = config.demo || {}, now = Date.now();
  const idle = c.enabled !== false && now - lastReal > (c.idleSec || 30) * 1000;
  if (idle !== demoOn) { demoOn = idle; io.emit('demo', { on: demoOn }); log(demoOn ? '🎬 Phòng vắng: bật chế độ trình diễn (không tính vào thống kê)' : '🎬 Có khán giả: tắt chế độ trình diễn'); }
  if (!demoOn || game.status !== 'playing' || now < demoNext) return;
  demoNext = now + (c.everySec || 3) * 1000 * (0.6 + Math.random() * 0.8);
  const team = pickOne(game.mode === 'team' ? ['blue', 'red'] : ['atk']);
  const troops = ['barbarian', 'barbarian', 'archer', 'giant', 'wizard', 'hogRider', 'minion', 'balloon'].filter((k) => config.troops[k]);
  const spells = ['lightning', 'rage', 'heal', 'freeze'].filter((k) => config.spells[k]);
  const key = Math.random() < 0.12 && spells.length ? pickOne(spells) : pickOne(troops);
  if (!key) return;
  const name = pickOne(DEMO_NAMES);
  dispatch({ id: 'demo:' + name + ':' + team, name, avatar: '', sim: true, team }, key, Math.random() < 0.2 ? 3 : 1, 'demo');
}, 500);
app.get('/sim', localOnly, (req, res) => {
  const key = String(req.query.key || 'barbarian');
  if (!config.troops[key] && !config.spells[key]) return res.status(400).send('Không có trong config.json');
  const count = Math.min(50, Math.max(1, parseInt(req.query.count, 10) || 1));
  const team = simTeam(String(req.query.team || 'blue'));
  dispatch(simUser(team, String(req.query.user || (team === 'red' ? 'Thử Đỏ' : team === 'blue' ? 'Thử Xanh' : 'Khán giả thử')).slice(0, 24)), key, count, 'sim');
  res.send('ok');
});

app.use('/api', localOnly, express.json());
app.get('/api/status', (_req, res) => {
  res.json({
    game: {
      mode: game.mode, level: game.level, boss: game.boss, status: game.status, mod: game.mod ? game.mod.label : '', phase: game.phase, clashLeft: Math.round(game.clashLeft),
      destruction: Math.round(game.destruction() * 1000) / 10, stars: game.stars,
      timeLeft: Math.round(game.timeLeft), units: game.units.length,
      alive: game.aliveBuildings(), total: game.buildings.length,
      combo: { n: game.T[game.teams[0]].combo.left > 0 ? game.T[game.teams[0]].combo.count : 0, m: game.comboMult(game.teams[0]) },
      difficulty: game.mode === 'team' ? stats.teamDifficulty : stats.difficulty,
      team: game.mode === 'team' ? {
        blue: { p: Math.round(game.destruction('blue') * 1000) / 10, stars: game.starCount('blue') },
        red: { p: Math.round(game.destruction('red') * 1000) / 10, stars: game.starCount('red') },
        counts: activeCounts(), handicap: game.handicap, score: stats.teamScore,
        fund: { blue: Math.round(game.T.blue.fund) + '/' + game.T.blue.fundMax, red: Math.round(game.T.red.fund) + '/' + game.T.red.fundMax },
        golden: game.golden, overtime: game.overtime, guardian: !!game.guardian,
      } : null,
    },
    log: recentLog.slice(-25).reverse(),
    warnings: configWarnings, demo: demoOn,
    stats: { roundsWon: stats.roundsWon, bestLevel: stats.bestLevel, allTime: topAllTime(5) },
    keys: { troops: Object.keys(config.troops), spells: Object.keys(config.spells) },
    tiktok: { user: TIKTOK_USERNAME, connected: tiktokConnected },
  });
});

/* ---------- Chỉnh cân bằng ngay trong admin (chỉ các thông số trong danh sách trắng) ---------- */
const TUNE = [
  ['team.durationSec', 'Thời gian trận đội (giây)', 120, 480, 10], ['team.clashSec', 'Pha giao tranh (giây)', 30, 180, 5],
  ['team.hpMult', 'Máu căn cứ đội ×', 0.5, 2, 0.05], ['team.multCap', 'Trần hệ số sát thương', 1.5, 3.5, 0.1],
  ['team.siegeBonus', 'Thưởng pha công thành ×', 1, 2, 0.05], ['team.golden.mult', 'Giờ vàng ×', 1, 3, 0.1],
  ['team.guardian.atSec', 'Rồng xuất hiện ở giây', 20, 150, 5], ['team.guardian.hp', 'Máu Rồng', 800, 6000, 100],
  ['team.guardian.hpPerPlayer', 'Máu Rồng thêm theo người', 0, 0.1, 0.005], ['team.guardian.dps', 'Sát thương Rồng', 10, 80, 2],
  ['team.guardian.buffMult', 'Buff hạ Rồng ×', 1.1, 2.5, 0.05], ['team.fund.start', 'Quỹ đội cần (điểm)', 100, 2000, 50],
  ['team.cheer.start', 'Tinh thần cần (lần chat)', 15, 200, 5], ['team.cheer.buffMult', 'Buff hô hào ×', 1.1, 2, 0.05],
  ['spells.meteor.damage', 'Sát thương Thiên thạch', 100, 1500, 25], ['spells.poison.pctPerSec', 'Độc (% máu/giây)', 0.005, 0.08, 0.005],
  ['spells.shield.durationSec', 'Khiên (giây)', 3, 20, 1], ['npcs.siegeMachine.hp', 'Máu Máy phá thành', 500, 5000, 100], ['npcs.hero.hp', 'Máu Tướng', 400, 4000, 100],
];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
app.get('/api/tune', localOnly, (_req, res) => res.json(TUNE.map(([p, label, min, max, step]) => ({ path: p, label, min, max, step, value: getPath(config, p) }))));
app.post('/api/tune', localOnly, (req, res) => {
  const t = TUNE.find((x) => x[0] === (req.body || {}).path), v = Number((req.body || {}).value);
  if (!t || !Number.isFinite(v) || v < t[2] || v > t[3]) return res.status(400).json({ error: 'Giá trị không hợp lệ' });
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')), ks = t[0].split('.'), last = ks.pop();
    ks.reduce((a, k) => a[k], raw)[last] = v;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); // watchFile sẽ tự nạp lại trong ~1 giây
    ks.reduce((a, k) => a[k], config)[last] = v;
    log(`🎚️  Chỉnh ${t[0]} = ${v}`);
    res.json({ ok: true, path: t[0], value: v });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ---------- Bảng gán quà: liệt kê quà thật đã thấy trong phòng và gán lính/phép ngay trên admin ---------- */
app.get('/api/gifts', (_req, res) => {
  const seen = stats.seenGifts || {}, map = config.gifts || {};
  const rows = [...new Set([...Object.keys(seen), ...Object.keys(map)])].map((n) => ({
    name: n, diamonds: (seen[n] || {}).diamonds || 0, count: (seen[n] || {}).count || 0, key: map[n] || '',
    effective: pickForGift({ giftName: n, diamondCount: (seen[n] || {}).diamonds || 0 }) || '',
  })).sort((a, b) => (b.count - a.count) || (b.diamonds - a.diamonds));
  const options = [...Object.entries(config.troops).map(([k, t]) => ({ key: k, label: t.label || k, type: 'Lính' })), ...Object.entries(config.spells).map(([k, t]) => ({ key: k, label: t.label || k, type: 'Phép' }))];
  res.json({ rows, options });
});
app.post('/api/gifts', (req, res) => {
  const name = String((req.body || {}).name || '').slice(0, 60), key = String((req.body || {}).key || '');
  if (!name || (key && !config.troops[key] && !config.spells[key])) return res.status(400).json({ error: 'Tên quà hoặc lính/phép không hợp lệ' });
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); raw.gifts = raw.gifts || {};
    if (key) raw.gifts[name] = key; else delete raw.gifts[name];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
    config.gifts = raw.gifts; log(`🎁 Gán quà "${name}" → ${key || '(bỏ gán)'}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/backup', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="siege-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json({ exportedAt: new Date().toISOString(), stats });
});
app.get('/api/matches', localOnly, (_req, res) => {
  let rows = [];
  try { rows = fs.readFileSync(path.join(DATA_DIR, 'matches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) {}
  const team = rows.filter((r) => r.mode === 'team'), gifts = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.gifts || {})) gifts[k] = (gifts[k] || 0) + n;
  const win = (w) => team.filter((r) => r.winner === w).length;
  res.json({ total: rows.length, team: { n: team.length, blue: win('blue'), red: win('red'), draw: win('draw'), overtime: team.filter((r) => r.overtime).length,
    guardianKilled: team.filter((r) => r.guardian === 'gone').length, avgSec: team.length ? Math.round(team.reduce((a, r) => a + r.sec, 0) / team.length) : 0 },
    topGifts: Object.entries(gifts).sort((a, b) => b[1] - a[1]).slice(0, 8), last: rows.slice(-8) });
});

app.post('/api/admin', (req, res) => {
  const { action, key, count, level, value } = req.body || {};
  switch (action) {
    case 'sim':
      if (!config.troops[key] && !config.spells[key]) return res.status(400).json({ error: 'Không có trong config.json' });
      { const team = simTeam(String(req.body.team || 'blue')); dispatch(simUser(team, 'Admin ' + team), key, Math.min(50, Math.max(1, parseInt(count, 10) || 1)), 'sim'); }
      break;
    case 'skip':
      if (game.status === 'playing' || game.status === 'cleared') endRound(game.status === 'cleared' ? 'win' : 'timeout');
      break;
    case 'event': {
      if (game.mode !== 'team') return res.status(400).json({ error: 'Chỉ dùng được ở chế độ Đội' });
      const tm = value === 'red' ? 'red' : 'blue';
      if (key === 'guardian') game.debugGuardian();
      else if (key === 'golden') game.debugGolden();
      else if (key === 'fund') game.debugFund(tm, Math.max(1, parseInt(count, 10) || 100));
      else if (key === 'morale') game.debugMorale(tm);
      else return res.status(400).json({ error: 'sự kiện không hợp lệ' });
      break;
    }
    case 'resetSeason':
      stats.seasonPts = {}; stats.teamScore = { blue: 0, red: 0, draws: 0 }; scheduleSave(); log('🧹 Đã xóa Đại gia mùa và tỷ số mùa');
      break;
    case 'setMode':
      if (value !== 'solo' && value !== 'team') return res.status(400).json({ error: 'mode phải là solo hoặc team' });
      stats.mode = value; scheduleSave(); newRound(stats.level || 1);
      break;
    case 'reset': newRound(game.level); break;
    case 'setLevel': newRound(Math.min(999, Math.max(1, parseInt(level, 10) || 1))); break;
    case 'setDifficulty': {
      const v = Math.min(config.difficulty.max, Math.max(config.difficulty.min, parseFloat(value) || 1));
      if (game.mode === 'team') stats.teamDifficulty = v; else stats.difficulty = v;
    }
      scheduleSave();
      break;
    case 'resetStats':
      stats = { level: 1, bestLevel: 1, roundsWon: 0, difficulty: config.difficulty.start || 1, allTime: {}, mode: stats.mode, teamScore: { blue: 0, red: 0, draws: 0 }, teamDifficulty: 1 };
      scheduleSave(); newRound(1);
      break;
    default: return res.status(400).json({ error: 'action không hợp lệ' });
  }
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('init', {
    ...clientConfig(),
    ...roundPayload(),
    status: game.status, demo: demoOn,
    owners: game.owners.map((o) => game.publicOwner(o)),
    snap: game.status === 'idle' ? null : snapPayload(),
  });
});

if (stats.mode !== 'team' && stats.mode !== 'solo') stats.mode = 'solo';
newRound(Math.max(1, stats.level || 1));
for (const f of ['game.js', 'config.json', 'admin.html']) if (!fs.existsSync(path.join(__dirname, f))) console.error('⚠️  Thiếu file ' + f + ' cạnh server.js');
if (!OVERLAY_CANDIDATES.some((x) => fs.existsSync(x))) console.error('⚠️  Thiếu public/index.html - mở http://localhost:' + PORT + ' sẽ báo "Cannot GET /". Hãy tạo thư mục public và đặt index.html vào đó.');
server.listen(PORT, () => {
  log(`🌐 Overlay: http://localhost:${PORT}  (dán vào OBS Browser Source)`);
  log(`🛠  Bảng điều khiển: http://localhost:${PORT}/admin`);
  connectTikTok();
});

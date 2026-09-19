'use strict';
/**
 * LUẬT CHƠI - mô phỏng trận công thành (server là "trọng tài" duy nhất).
 *
 * Hai chế độ:
 *  - solo: mọi khán giả (đội 'atk') cùng đánh một căn cứ (đội 'def').
 *  - team: hai đội 'blue' và 'red', mỗi đội có căn cứ riêng (đối xứng, giống hệt nhau)
 *          và đánh căn cứ của đội kia. Thắng theo sao, rồi tới % phá hủy.
 *
 * Quy ước: building.team là đội SỞ HỮU căn cứ. Lính của đội T tấn công công trình của ENEMY[T].
 * Module này không biết gì về TikTok hay Socket.io nên có thể test riêng.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (n) => Math.round(n * 10) / 10;
const ENEMY_SOLO = { atk: 'def', def: 'atk' };
const ENEMY_TEAM = { blue: 'red', red: 'blue' };

class Game {
  constructor(config, hooks = {}, rng = Math.random) {
    this.hooks = hooks;
    this.rng = rng;
    this.cfg = config;
    this.status = 'idle'; // idle | playing | cleared | timeup | ended
    this.mode = 'solo';
    this.teams = ['atk'];
    this.ENEMY = ENEMY_SOLO;
    this.T = { atk: this._mkTeam() };
    this.handicap = {};
    this.arena = { w: 100, h: 100, cx: 50, cy: 46 };
    this.level = 1;
    this.buildings = [];
    this.units = [];
    this.owners = [];
    this.ownerMap = new Map();
    this.timeLeft = 0; this.roundLen = 1;
    this.enraged = false; this.mod = null; this.boss = false;
    this.difficulty = 1; this.clearedBy = null; this.phase = null; this.clashLeft = 0;
    this.bid = 1; this.uid = 1;
    this.golden = false; this.overtime = false; this.overtimeUsed = false; this.clearReason = null;
    this.guardian = null; this.guardianState = 0; this.activePlayers = 0;
    this.leader = null; this.slowT = 0; this.closeT = 0; this.bountyFlushT = 0; this.flip = false;
    this.lateRushOn = false;
  }

  setConfig(c) { this.cfg = c; }
  emit(type, data) { if (this.hooks.emit) this.hooks.emit(type, data); }

  _mkTeam() {
    const tc = (this.cfg && this.cfg.team) || {}, fu = tc.fund || {}, ch = tc.cheer || {};
    return {
      combo: { count: 0, left: 0 }, rageLeft: 0, rageMult: 1, freezeEnemyLeft: 0,
      dw: 0, tw: 1, stars: [false, false, false], thDestroyed: false, thKiller: null,
      fund: 0, fundMax: fu.start || 250, unlocks: 0,
      morale: 0, moraleMax: ch.start || 45, moraleBuffLeft: 0,
      buffLeft: 0, poisonEnemyLeft: 0, poisonPct: 0.03, shieldLeft: 0, cleanseLeft: 0,
      cuOn: false, bounty: -1, bountyBuf: 0, bountyTarget: '', troopTotals: {},
    };
  }

  /* ------------------------------------------------------------ */
  /* Bắt đầu ván / trận                                            */
  /* ------------------------------------------------------------ */
  newRound(level, difficulty = 1, mode = 'solo') {
    const c = this.cfg;
    this.mode = mode === 'team' ? 'team' : 'solo';
    const team = this.mode === 'team';
    this.teams = team ? ['blue', 'red'] : ['atk'];
    this.ENEMY = team ? ENEMY_TEAM : ENEMY_SOLO;
    this.T = {}; for (const t of this.teams) this.T[t] = this._mkTeam();
    this.level = level;
    this.difficulty = difficulty;
    this.boss = !team && !!c.town.bossEvery && level % c.town.bossEvery === 0;
    this.mod = null;
    if (!team) {
      if (this.boss) this.mod = c.bossModifier || null;
      else if (level >= 2 && c.modifiers && c.modifiers.length) this.mod = c.modifiers[Math.floor(this.rng() * c.modifiers.length)];
    }
    const ta = (c.team && c.team.arena) || { w: 100, h: 140, cy: 36 };
    this.arena = team ? { w: ta.w, h: ta.h, cx: ta.w / 2, cy: ta.cy } : { w: 100, h: 100, cx: c.arena.cx, cy: c.arena.cy };
    // 2 căn cứ thẳng hàng dọc theo trục giữa sân đấu chuẩn Clash of Clans / Clash Royale
    if (team) this.arena.bx = (c.team.baseOffsetX != null ? c.team.baseOffsetX : 0) * this.arena.w;

    this.status = 'playing';
    this.roundLen = team ? c.team.durationSec : c.round.durationSec + (this.boss ? c.town.bossExtraSec || 0 : 0);
    this.timeLeft = this.roundLen;
    this.units = []; this.owners = []; this.ownerMap = new Map();
    this.bid = 1; this.uid = 1;
    this.enraged = false; this.clearedBy = null;
    // Trận đội có 2 pha: giao tranh (lính đuổi đánh nhau) rồi công thành (dồn sức phá căn cứ)
    this.phase = team ? 'clash' : null;
    this.clashLeft = team ? (c.team.clashSec || 90) : 0;
    this.golden = false; this.overtime = false; this.overtimeUsed = false; this.clearReason = null;
    this.guardian = null; this.guardianState = 0; this.leader = null; this.slowT = 0; this.closeT = 0; this.bountyFlushT = 0;
    this.lateRushOn = false;
    this._buildBase();
    for (const t of this.teams) this.T[t].tw = this._weightOf(this.ENEMY[t]) || 1;
  }

  _weightOf(baseTeam) { return this.buildings.filter((b) => b.team === baseTeam).reduce((s, b) => s + b.weight, 0); }
  _shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  _buildBase() {
    const c = this.cfg, bc = c.buildings, d = c.difficulty, A = this.arena, team = this.mode === 'team';
    const lv = this.level - 1;
    const hpScale = this.difficulty * (1 + lv * d.perLevelHp) * (this.mod && this.mod.hp ? this.mod.hp : 1) * (this.boss ? c.town.bossHpMultiplier || 1 : 1) * (team ? c.team.hpMult || 1 : 1);
    const dpsScale = (0.6 + 0.4 * this.difficulty) * (1 + lv * d.perLevelDps) * (this.mod && this.mod.defDps ? this.mod.defDps : 1);
    const rScale = team ? c.team.baseScale || 1 : 1;

    const types = [];
    for (const e of c.layout) {
      if (this.level < e.minLevel || e.type === 'townHall') continue;
      for (let i = 0; i < (e.count || 1); i++) types.push(e.type);
    }
    if (this.boss) for (const e of c.bossLayout || []) for (let i = 0; i < (e.count || 1); i++) types.push(e.type);
    this._shuffle(types);

    // Vị trí tương đối so với tâm căn cứ: lưới vuông kiên cố kiểu làng Clash of Clans bao quanh Nhà Chính ở tâm (0,0)
    const GRID = 8.5;
    const slots = [
      // Vòng 1 (sát Nhà Chính): 8 vị trí bảo vệ trực tiếp
      [-GRID, -GRID], [0, -GRID], [GRID, -GRID],
      [-GRID, 0],                 [GRID, 0],
      [-GRID, GRID],  [0, GRID],  [GRID, GRID],
      // Vòng 2 (vành đai pháo đài): 12 vị trí bao quanh
      [-GRID * 2, 0], [GRID * 2, 0], [0, -GRID * 2], [0, GRID * 2],
      [-GRID * 2, -GRID], [-GRID * 2, GRID], [GRID * 2, -GRID], [GRID * 2, GRID],
      [-GRID, -GRID * 2], [GRID, -GRID * 2], [-GRID, GRID * 2], [GRID, GRID * 2],
      [-GRID * 2, -GRID * 2], [GRID * 2, -GRID * 2], [-GRID * 2, GRID * 2], [GRID * 2, GRID * 2]
    ];
    this._shuffle(slots);
    const chosen = types.slice(0, slots.length);

    const mk = (type, x, y, owner) => {
      const b = bc[type];
      if (!b) return null;
      const hp = b.hp * hpScale;
      return {
        id: this.bid++, team: owner, type, kind: b.kind, x: r1(x), y: r1(y), radius: r1(b.radius * rScale),
        maxHp: hp, hp, weight: b.weight,
        dps: (b.dps || 0) * dpsScale, rampDps: (b.rampDps || 0) * dpsScale, rampSec: b.rampSec || 6,
        range: b.range || 0, minRange: b.minRange || 0, splash: b.splash || 0, targets: b.targets || 'both',
        tid: -1, ramp: 0,
      };
    };

    this.buildings = [];
    const bx = A.bx || 0;
    const bases = team
      ? [{ owner: 'blue', cx: A.cx - bx, cy: A.cy, sign: 1 }, { owner: 'red', cx: A.cx + bx, cy: A.h - A.cy, sign: -1 }] // đỏ = xoay 180° => công bằng tuyệt đối
      : [{ owner: 'def', cx: A.cx, cy: A.cy, sign: 1 }];
    for (const base of bases) {
      const th = mk('townHall', base.cx, base.cy, base.owner);
      if (th) this.buildings.push(th);
      chosen.forEach((t, i) => { const b = mk(t, base.cx + slots[i][0] * base.sign, base.cy + slots[i][1] * base.sign, base.owner); if (b) this.buildings.push(b); });
    }
  }

  /* ------------------------------------------------------------ */
  /* Chủ sở hữu (người xem)                                        */
  /* ------------------------------------------------------------ */
  _owner(user, rank, team) {
    let o = this.ownerMap.get(user.id);
    if (!o) {
      o = { i: this.owners.length, id: user.id, name: user.name, avatar: user.avatar || '', team, rank: rank ? rank.name : '', color: rank ? rank.color : '#fff4e0', dmg: 0, kills: 0, frags: 0, points: 0, sim: !!user.sim };
      this.owners.push(o); this.ownerMap.set(user.id, o);
    }
    return o;
  }
  publicOwner(o) { return { i: o.i, name: o.name, avatar: o.avatar, rank: o.rank, color: o.color, team: o.team }; }

  topPlayers(n = 3, team = null) {
    return this.owners.filter((o) => !team || o.team === team).sort((a, b) => b.dmg - a.dmg).slice(0, n).filter((o) => o.dmg > 0)
      .map((o) => ({ i: o.i, name: o.name, avatar: o.avatar, dmg: Math.round(o.dmg), kills: o.kills, frags: o.frags, color: o.color, team: o.team }));
  }

  _credit(ownerIdx, amount) {
    const o = this.owners[ownerIdx];
    if (!o) return;
    o.dmg += amount;
    if (this.hooks.onDamage) this.hooks.onDamage(o, amount);
  }

  /* ------------------------------------------------------------ */
  /* Combo / buff (theo từng đội)                                  */
  /* ------------------------------------------------------------ */
  bumpCombo(team) {
    const c = this.cfg.combo, s = this.T[team];
    if (!c || !c.enabled || !s) return;
    if (s.combo.left <= 0) s.combo.count = 0;
    s.combo.count++;
    s.combo.left = c.windowSec;
  }
  comboMult(team) {
    const c = this.cfg.combo, s = this.T[team];
    if (!c || !c.enabled || !s || s.combo.left <= 0) return 1;
    return Math.min(c.maxMultiplier, 1 + Math.floor(s.combo.count / c.stepEvery) * c.bonusPerStep);
  }
  troopMult(team) {
    const s = this.T[team];
    const ch = (this.cfg.team && this.cfg.team.cheer) || {}, gu = (this.cfg.team && this.cfg.team.guardian) || {};
    const stack = this.comboMult(team) * (s && s.rageLeft > 0 ? s.rageMult : 1) * (this.mod && this.mod.troopDps ? this.mod.troopDps : 1) * (this.handicap[team] || 1) * this._catchUp(team)
      * (s && s.moraleBuffLeft > 0 ? ch.buffMult || 1.3 : 1) * (s && s.buffLeft > 0 ? gu.buffMult || 1.5 : 1);
    // tránh "cuốn chiếu": các hệ số cộng dồn bị chặn trần; giờ vàng nhân sau cùng để 30 giây cuối luôn đáng xem
    const cap = this.mode === 'team' && this.cfg.team.multCap ? this.cfg.team.multCap : Infinity;
    return Math.min(stack, cap) * this.goldenMult();
  }
  goldenMult() {
    if (!this.golden) return 1;
    const g = this.mode === 'team' ? (this.cfg.team && this.cfg.team.golden) : (this.cfg.round && this.cfg.round.golden);
    return (g && g.mult) || 2;
  }
  setActive(n) { this.activePlayers = n || 0; }
  // Đội đang bị bỏ xa được cộng sát thương để trận không kết thúc quá sớm
  _catchUp(team) {
    const cu = this.mode === 'team' && this.cfg.team && this.cfg.team.catchUp;
    if (!cu || !cu.bonus) return 1;
    const other = this.teams.find((t) => t !== team);
    return this.destruction(other) - this.destruction(team) >= cu.gap ? 1 + cu.bonus : 1;
  }
  // Càng gần hết giờ, phòng thủ (solo) càng mạnh dần lên để trận đấu dồn dập hơn, tách biệt với boss nổi điên
  defMult() {
    if (this.mode !== 'solo') return 1;
    let m = this.enraged ? 1.4 : 1;
    const lr = this.cfg.difficulty && this.cfg.difficulty.lateRush;
    if (lr && lr.startFrac && this.roundLen > 0) {
      const frac = this.timeLeft / this.roundLen;
      if (frac <= lr.startFrac) {
        const p = clamp(1 - frac / lr.startFrac, 0, 1);
        m = Math.max(m, 1 + p * ((lr.maxDefMult || 1.4) - 1));
      }
    }
    return m;
  }
  setHandicap(h) { this.handicap = h || {}; }

  /* ------------------------------------------------------------ */
  /* Triệu hồi lính                                                */
  /* ------------------------------------------------------------ */
  _spawnPoint(team) {
    const r = this.rng, A = this.arena;
    if (this.mode === 'team') {
      const zone = team === 'blue' ? [6, A.h * 0.42] : [A.h * 0.58, A.h - 6];
      const s = Math.floor(r() * 3);
      if (s === 0) return [-3, zone[0] + r() * (zone[1] - zone[0])];
      if (s === 1) return [A.w + 3, zone[0] + r() * (zone[1] - zone[0])];
      return [15 + r() * (A.w - 30), team === 'blue' ? -3 : A.h + 3];
    }
    const s = Math.floor(r() * 3);
    if (s === 0) return [-3, 45 + r() * 50];
    if (s === 1) return [A.w + 3, 45 + r() * 50];
    return [10 + r() * 80, A.h + 3];
  }

  spawn(user, key, count, source = 'gift', rank = null, team = null, points = 0) {
    const t = this.cfg.troops[key];
    team = team || this.teams[0];
    if (!t || this.status !== 'playing' || !this.T[team]) return false;
    this.bumpCombo(team);
    const owner = this._owner(user, rank, team);
    if (points) this._points(owner, team, points);
    if (this.mode === 'team') { const s = this.T[team]; s.troopTotals[key] = (s.troopTotals[key] || 0) + count; }
    const rankMult = rank ? rank.mult || 1 : 1;
    // giới hạn số lính cùng lúc để OBS không bị giật: vượt trần thì gộp thành lính "to" hơn (sức mạnh giữ nguyên)
    const cap = this.mode === 'team' ? ((this.cfg.team && this.cfg.team.maxUnitsPerTeam) || 80) : ((this.cfg.round && this.cfg.round.maxUnits) || 150);
    const alive = this.units.reduce((a, u) => a + (u.team === team && !u.boss ? 1 : 0), 0);
    const n = Math.max(1, Math.min(count, t.maxSpawn || 6, cap - alive));
    const scale = count / n; // quà nhiều -> lính "to" hơn thay vì tăng số lượng vô hạn
    const [bx, by] = this._spawnPoint(team);
    for (let i = 0; i < n; i++) {
      const hp = t.hp * scale * rankMult;
      this.units.push({
        id: this.uid++, key, owner: owner.i, team,
        x: bx + (this.rng() - .5) * 6, y: by + (this.rng() - .5) * 6,
        hp, maxHp: hp, dps: t.dps * scale * rankMult, speed: t.speed, range: t.range,
        air: !!t.air, pref: t.target || 'nearest', chain: t.chain || 0,
        hitsG: t.hits === 'ground' || t.hits === 'both', hitsA: t.hits === 'air' || t.hits === 'both',
        foeRad: t.foe === 'seek' ? Infinity : t.foe === 'contact' ? (this.cfg.team && this.cfg.team.contactRadius) || 7 : 0,
        unitDps: t.unitDps || t.dps, unitSplash: t.unitSplash || 0, foe: null, scanT: this.rng() * 0.3,
        vs: r1(1 + Math.min(0.8, Math.log2(Math.max(1, scale)) * 0.15)),
        state: 0, target: null, ang: this.rng() * Math.PI * 2,
      });
    }
    this.emit('spawn', { user: this.publicOwner(owner), troop: key, count, units: n, source, mult: r1(this.troopMult(team)), team, pts: points || 0 });
    return true;
  }

  /* ------------------------------------------------------------ */
  /* Phép                                                          */
  /* ------------------------------------------------------------ */
  cast(user, key, count, source = 'gift', rank = null, team = null, points = 0) {
    const sp = this.cfg.spells[key];
    team = team || this.teams[0];
    if (!sp || this.status !== 'playing' || !this.T[team]) return false;
    const s = this.T[team];
    const teamOnly = sp.kind === 'repair' || sp.kind === 'poison' || sp.kind === 'shield';
    if (teamOnly && this.mode !== 'team') return false; // chỉ có nghĩa khi có căn cứ và lính của đối phương
    this.bumpCombo(team);
    const owner = this._owner(user, rank, team);
    if (points) this._points(owner, team, points);
    const info = { user: this.publicOwner(owner), spell: key, count, source, team, pts: points || 0 };
    const enemyBase = this.ENEMY[team];
    const dmgMult = this.comboMult(team) * (s.rageLeft > 0 ? s.rageMult : 1) * this.goldenMult();

    if (sp.kind === 'instant' || sp.kind === 'meteor') {
      if (this._shielded(enemyBase)) { // khiên chặn phép công kích
        info.blocked = true; this.emit('spell', info); this.emit('spellBlocked', { team, target: enemyBase, spell: key }); return true;
      }
      const alive = this.buildings.filter((b) => b.hp > 0 && b.team === enemyBase);
      const defs = this._shuffle(alive.filter((b) => b.kind === 'defense'));
      const rest = this._shuffle(alive.filter((b) => b.kind !== 'defense'));
      if (sp.kind === 'instant') {
        const targets = [...defs, ...rest].slice(0, sp.bolts || 3);
        const dmg = (sp.damage || 0) * count * dmgMult;
        info.targets = targets.map((b) => b.id); info.damage = Math.round(dmg);
        this.emit('spell', info);
        for (const b of targets) this._hitBuilding(b, dmg, owner.i);
      } else { // thiên thạch: nổ lan quanh một công trình
        if (!alive.length) return true;
        const R = sp.radius || 11;
        // nhắm vào cụm công trình dày nhất (ưu tiên có phòng thủ) để nổ lan hiệu quả
        const center = alive.map((b) => ({ b, score: alive.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) <= R).length + (b.kind === 'defense' ? 1.5 : 0) + this.rng() * 0.1 }))
          .sort((p, q) => q.score - p.score)[0].b;
        const dmg = (sp.damage || 0) * count * dmgMult, uDmg = (sp.unitDamage || 0) * count * dmgMult;
        const hits = alive.map((b) => ({ b, d: Math.hypot(b.x - center.x, b.y - center.y) })).filter((h) => h.d <= R);
        info.x = center.x; info.y = center.y; info.radius = R; info.targets = hits.map((h) => h.b.id); info.damage = Math.round(dmg);
        this.emit('spell', info);
        for (const h of hits) this._hitBuilding(h.b, dmg * (1 - 0.6 * h.d / R), owner.i);
        for (const e of this.units) { // lính địch quanh điểm nổ cũng bị thương
          if (e.team !== enemyBase || e.hp <= 0) continue;
          const d = Math.hypot(e.x - center.x, e.y - center.y);
          if (d <= R * 1.15) { e.pend = (e.pend || 0) + uDmg * (1 - 0.5 * d / (R * 1.15)); e.lastHit = owner.i; }
        }
        this._applyPending();
      }
    } else if (sp.kind === 'buff') {
      s.rageLeft = Math.min(60, s.rageLeft + (sp.durationSec || 10) * count);
      s.rageMult = sp.multiplier || 1.5;
      info.left = s.rageLeft; info.mult = s.rageMult;
      this.emit('spell', info);
    } else if (sp.kind === 'freeze') {
      s.freezeEnemyLeft = Math.min(30, s.freezeEnemyLeft + (sp.durationSec || 8) * count);
      info.left = s.freezeEnemyLeft;
      this.emit('spell', info);
    } else if (sp.kind === 'heal') {
      const frac = (sp.heal || .5) * count;
      for (const u of this.units) if (u.team === team) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * frac);
      s.cleanseLeft = Math.max(s.cleanseLeft, 6); // giải độc
      this.emit('spell', info);
    } else if (sp.kind === 'repair') {
      const frac = (sp.heal || .3) * count, ids = [];
      for (const b of this.buildings) if (b.team === team && b.hp > 0 && b.hp < b.maxHp) { b.hp = Math.min(b.maxHp, b.hp + b.maxHp * frac); ids.push(b.id); }
      info.targets = ids;
      this.emit('spell', info);
    } else if (sp.kind === 'poison') {
      s.poisonEnemyLeft = Math.min(30, s.poisonEnemyLeft + (sp.durationSec || 10) * count); s.poisonPct = sp.pctPerSec || 0.03;
      info.left = s.poisonEnemyLeft;
      this.emit('spell', info);
    } else if (sp.kind === 'shield') {
      s.shieldLeft = Math.min(24, s.shieldLeft + (sp.durationSec || 8) * count);
      info.left = s.shieldLeft;
      this.emit('spell', info);
    }
    return true;
  }

  /* ------------------------------------------------------------ */
  /* Sát thương lên công trình / sao                               */
  /* ------------------------------------------------------------ */
  _hitBuilding(b, dmg, ownerIdx) {
    if (b.hp <= 0 || dmg <= 0 || this._shielded(b.team)) return 0;
    const real = Math.min(b.hp, dmg);
    b.hp -= real;
    this._credit(ownerIdx, real);
    if (b.hp <= 0) this._destroyed(b, ownerIdx);
    return real;
  }

  _destroyed(b, ownerIdx) {
    b.hp = 0; b.tid = -1;
    const A = this.ENEMY[b.team]; // đội đang tấn công căn cứ này
    const s = this.T[A];
    if (s) s.dw += b.weight;
    const o = this.owners[ownerIdx];
    if (o) o.kills++;
    if (b.kind === 'townhall' && s) { s.thDestroyed = true; s.thKiller = o ? o.name : null; }
    this.emit('bldDestroyed', { id: b.id, type: b.type, kind: b.kind, team: b.team, by: o ? o.name : '', color: o ? o.color : '#fff', weight: b.weight });
    this._updateStars(A);
    if (this.overtime && this.status === 'playing') { // hiệp phụ "cái chết bất ngờ": phá được công trình trước là thắng
      this.status = 'cleared'; this.clearedBy = A; this.clearReason = 'suddendeath';
      this.emit('cleared', { winner: A, reason: 'suddendeath' });
    }
  }

  aliveIn(baseTeam) { return this.buildings.filter((b) => b.hp > 0 && b.team === baseTeam).length; }
  aliveBuildings() { return this.buildings.filter((b) => b.hp > 0).length; }
  destruction(team = null) { const t = team || this.teams[0], s = this.T[t]; return s ? clamp(s.dw / s.tw, 0, 1) : 0; }
  starCount(team = null) { const t = team || this.teams[0]; return this.T[t] ? this.T[t].stars.filter(Boolean).length : 0; }
  get stars() { return this.T[this.teams[0]] ? this.T[this.teams[0]].stars : [false, false, false]; }
  get thKiller() { return this.T[this.teams[0]] ? this.T[this.teams[0]].thKiller : null; }

  _updateStars(A) {
    const s = this.T[A]; if (!s) return;
    const p = this.destruction(A);
    const now = [p >= (this.cfg.stars.half || 0.5), s.thDestroyed, this.aliveIn(this.ENEMY[A]) === 0];
    now.forEach((v, i) => {
      if (v && !s.stars[i]) { s.stars[i] = true; this.emit('star', { team: A, index: i, count: s.stars.filter(Boolean).length }); }
    });
    if (this.mode === 'solo' && this.boss && !this.enraged && p >= 0.5) { this.enraged = true; this.emit('enrage', {}); }
    if (this.aliveIn(this.ENEMY[A]) === 0 && this.status === 'playing') {
      this.status = 'cleared'; this.clearedBy = A; this.clearReason = 'annihilation';
      this.emit('cleared', { winner: this.mode === 'team' ? A : null, reason: 'annihilation' });
    }
  }

  /* Kết quả trận đội: sao -> % phá hủy -> hòa */
  teamResult() {
    const teams = {};
    for (const t of this.teams) {
      teams[t] = { p: Math.round(this.destruction(t) * 100), stars: this.T[t].stars, starCount: this.starCount(t), top: this.topPlayers(3, t), thKiller: this.T[t].thKiller, topPts: this.topPoints(t) };
    }
    let winner = 'draw';
    if (this.mode === 'team') {
      if (this.clearedBy) winner = this.clearedBy;
      else {
        const [a, b] = this.teams;
        const sa = this.starCount(a), sb = this.starCount(b), pa = this.destruction(a), pb = this.destruction(b);
        if (sa !== sb) winner = sa > sb ? a : b;
        else if (Math.abs(pa - pb) > 0.0005) winner = pa > pb ? a : b;
      }
    }
    return { winner, teams };
  }

  /* ------------------------------------------------------------ */
  /* Vòng mô phỏng                                                 */
  /* ------------------------------------------------------------ */
  tick(dt) {
    if (this.status !== 'playing') return;
    this.timeLeft -= dt;
    for (const t of this.teams) {
      const s = this.T[t];
      s.combo.left = Math.max(0, s.combo.left - dt);
      s.rageLeft = Math.max(0, s.rageLeft - dt);
      s.freezeEnemyLeft = Math.max(0, s.freezeEnemyLeft - dt);
      s.moraleBuffLeft = Math.max(0, s.moraleBuffLeft - dt);
      s.buffLeft = Math.max(0, s.buffLeft - dt);
      s.poisonEnemyLeft = Math.max(0, s.poisonEnemyLeft - dt);
      s.shieldLeft = Math.max(0, s.shieldLeft - dt);
      s.cleanseLeft = Math.max(0, s.cleanseLeft - dt);
    }
    if (this.phase === 'clash') {
      this.clashLeft -= dt;
      if (this.clashLeft <= 0) { this.clashLeft = 0; this.phase = 'siege'; this.emit('phase', { phase: 'siege', bonus: (this.cfg.team && this.cfg.team.siegeBonus) || 1 }); }
    }
    if (this.mode === 'team') this._teamEvents(dt); else this._soloEvents(dt);
    this._unitsStep(dt);
    this._applyPending();
    if (this.status === 'playing') this._defensesStep(dt);
    if (this.mode === 'team') this._poisonStep(dt);
    const alive = [];
    for (const u of this.units) { if (u.hp > 0) alive.push(u); else this._onUnitDeath(u); }
    this.units = alive;

    if (this.status === 'playing' && this.timeLeft <= 0) {
      const ot = (this.cfg.team && this.cfg.team.overtimeSec) || 0;
      if (this.mode === 'team' && !this.overtime && ot > 0 && this.teamResult().winner === 'draw') { // hòa -> hiệp phụ
        this.overtime = true; this.overtimeUsed = true; this.timeLeft = ot;
        this.emit('overtime', { sec: ot });
      } else {
        this.timeLeft = 0; this.status = 'timeup';
        this.emit('timeup', {});
      }
    }
  }

  /* ---------- Sự kiện trận solo: giờ vàng cuối trận, phòng thủ tăng cường ---------- */
  _soloEvents(dt) {
    const rc = this.cfg.round || {}, g = rc.golden;
    if (g && g.sec && !this.golden && this.timeLeft > 0 && this.timeLeft <= g.sec) {
      this.golden = true; this.emit('golden', { mult: g.mult || 2, sec: Math.max(0, Math.round(this.timeLeft)) });
    }
    const lr = this.cfg.difficulty && this.cfg.difficulty.lateRush;
    if (lr && lr.startFrac && !this.lateRushOn && this.roundLen > 0 && this.timeLeft / this.roundLen <= lr.startFrac) {
      this.lateRushOn = true; this.emit('lateRush', {});
    }
  }

  /* ---------- Sự kiện trận đội: giờ vàng, Rồng canh kho báu, truy nã, lật kèo ---------- */
  _teamEvents(dt) {
    const tc = this.cfg.team, g = tc.golden || {};
    if (!this.golden && g.sec && (this.timeLeft <= g.sec || this.overtime)) {
      this.golden = true; this.emit('golden', { mult: g.mult || 2, sec: Math.max(0, Math.round(this.timeLeft)) });
    }
    const gd = tc.guardian;
    if (gd && this.guardianState === 0 && !this.overtime && (this.roundLen - this.timeLeft) >= gd.atSec) this._spawnGuardian();
    this.slowT -= dt;
    if (this.slowT > 0) return;
    this.slowT = 0.5;
    // bám đuổi: báo cho người xem khi một đội bắt đầu được cộng sát thương
    for (const t of this.teams) {
      const on = this._catchUp(t) > 1, s = this.T[t];
      if (on && !s.cuOn) this.emit('catchUp', { team: t, bonus: tc.catchUp.bonus });
      s.cuOn = on;
    }
    this.bountyFlushT -= 0.5; this.closeT -= 0.5;
    if (this.bountyFlushT <= 0) {
      this.bountyFlushT = 1.5;
      for (const t of this.teams) { const s = this.T[t]; if (s.bountyBuf > 0) { this.emit('bountyClaimed', { team: t, count: s.bountyBuf, target: s.bountyTarget, fund: s.bountyBuf * ((tc.bounty && tc.bounty.fund) || 0) }); s.bountyBuf = 0; } }
      this._updateBounty();
    }
    this._leadCheck();
  }

  _leadCheck() {
    const lc = this.cfg.team.lead || {}, diff = this.destruction('blue') - this.destruction('red');
    const cur = diff >= (lc.flipMargin || 0.03) ? 'blue' : diff <= -(lc.flipMargin || 0.03) ? 'red' : null;
    if (cur && this.leader && cur !== this.leader) this.emit('leadChange', { team: cur, diff: Math.abs(diff) });
    if (cur) this.leader = cur;
    if (!this.overtime && this.timeLeft <= (lc.closeWithinSec || 45) && Math.abs(diff) < (lc.closeMargin || 0.05) && this.closeT <= 0) {
      this.closeT = 20;
      this.emit('closeCall', { diff: Math.abs(diff), trailing: diff > 0 ? 'red' : diff < 0 ? 'blue' : null, timeLeft: Math.round(this.timeLeft) });
    }
  }

  topPoints(team) {
    let best = null;
    for (const o of this.owners) if (o.team === team && !o.sim && o.points > 0 && (!best || o.points > best.points)) best = o;
    return best ? { name: best.name, pts: Math.round(best.points), color: best.color, avatar: best.avatar, i: best.i } : null;
  }

  _updateBounty() {
    const min = (this.cfg.team.bounty && this.cfg.team.bounty.minPoints) || 40;
    for (const t of this.teams) {
      const s = this.T[t], best = this.topPoints(t), nb = best && best.pts >= min ? best.i : -1;
      if (nb !== s.bounty) { s.bounty = nb; if (nb >= 0) this.emit('bounty', { team: t, against: this.ENEMY[t], name: best.name, pts: best.pts, color: best.color }); }
    }
  }

  _poisonStep(dt) {
    for (const t of this.teams) {
      const s = this.T[t]; if (s.poisonEnemyLeft <= 0) continue;
      const en = this.ENEMY[t]; if (this.T[en].cleanseLeft > 0) continue;
      for (const u of this.units) if (u.team === en && u.hp > 0) u.hp -= Math.max(u.maxHp * s.poisonPct, 3) * dt;
    }
  }

  _shielded(baseTeam) { const s = this.T[baseTeam]; return !!(s && s.shieldLeft > 0); }

  /* ---------- Quỹ đội, tinh thần, Rồng canh ---------- */
  _points(owner, team, pts) { owner.points += pts; this._addFund(team, pts); }

  _addFund(team, pts) {
    if (this.mode !== 'team') return;
    const s = this.T[team], gr = ((this.cfg.team.fund && this.cfg.team.fund.growth) || 1.35);
    s.fund += pts;
    while (s.fund >= s.fundMax) {
      s.fund -= s.fundMax; s.unlocks++; s.fundMax = Math.round(s.fundMax * gr);
      this._summonNpc(team, s.unlocks % 2 === 1 ? 'siegeMachine' : 'hero');
    }
  }

  _teamOwner(team) {
    const id = 'team:' + team;
    let o = this.ownerMap.get(id);
    if (!o) {
      const nm = (this.cfg.team.names && this.cfg.team.names[team]) || team;
      o = { i: this.owners.length, id, name: 'Cả đội ' + nm, avatar: '', team, rank: '', color: (this.cfg.team.colors && this.cfg.team.colors[team]) || '#fff', dmg: 0, kills: 0, frags: 0, points: 0, sim: true };
      this.owners.push(o); this.ownerMap.set(id, o);
    }
    return o;
  }

  _summonNpc(team, key) {
    const t = this.cfg.npcs && this.cfg.npcs[key]; if (!t || this.status !== 'playing') return;
    const owner = this._teamOwner(team), [bx, by] = this._spawnPoint(team);
    this.units.push({
      id: this.uid++, key, owner: owner.i, team, x: bx, y: by,
      hp: t.hp, maxHp: t.hp, dps: t.dps, speed: t.speed, range: t.range, air: !!t.air, pref: t.target || 'nearest', chain: 0,
      hitsG: t.hits === 'ground' || t.hits === 'both', hitsA: t.hits === 'air' || t.hits === 'both',
      foeRad: t.foe === 'seek' ? Infinity : t.foe === 'contact' ? 7 : 0, unitDps: t.unitDps || t.dps, unitSplash: 0, foe: null, scanT: 0,
      vs: 1, state: 0, target: null, ang: this.rng() * Math.PI * 2,
    });
    this.emit('unlock', { team, kind: key, label: t.label });
  }

  addMorale(team, n = 1) {
    if (this.mode !== 'team' || this.status !== 'playing' || !this.T[team]) return;
    const s = this.T[team], ch = this.cfg.team.cheer || {};
    s.morale += n;
    if (s.morale >= s.moraleMax) {
      s.morale = 0; s.moraleMax = Math.round(s.moraleMax * (ch.growth || 1.25));
      s.moraleBuffLeft = ch.buffSec || 12; s.cleanseLeft = Math.max(s.cleanseLeft, 6);
      for (const u of this.units) if (u.team === team) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * (ch.healFrac || 0.3));
      this.emit('morale', { team, buffSec: s.moraleBuffLeft, mult: ch.buffMult || 1.3 });
    }
  }

  _spawnGuardian() {
    const g = this.cfg.team.guardian, A = this.arena, n = Math.min(this.activePlayers, g.maxPlayers || 40);
    const hp = g.hp * (1 + (g.hpPerPlayer || 0) * n);
    const u = { id: this.uid++, key: 'guardian', owner: -1, team: 'neutral', boss: true, x: A.cx, y: A.h / 2, hp, maxHp: hp, dps: g.dps, speed: 0, range: g.range, splash: g.splash, air: false, vs: 1, state: 0, target: null, foe: null, ang: 0, left: g.leaveSec, lastTeam: null, lastOwner: -1 };
    this.units.push(u); this.guardian = u; this.guardianState = 1;
    this.emit('guardian', { hp: Math.round(hp), leaveSec: g.leaveSec, x: u.x, y: u.y });
  }

  _guardianStep(u, dt) {
    u.left -= dt;
    if (u.left <= 0) { u.leaving = true; u.hp = 0; return; }
    let best = null, bd = u.range + 1;
    for (const e of this.units) {
      if (e === u || e.hp <= 0 || e.team === 'neutral') continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) { u.state = 0; u.foe = null; return; }
    u.state = 1; u.foe = best;
    const dmg = u.dps * dt;
    best.hp -= dmg;
    for (const e of this.units) if (e !== best && e !== u && e.hp > 0 && e.team !== 'neutral' && Math.hypot(e.x - best.x, e.y - best.y) <= u.splash) e.hp -= dmg * 0.6;
  }

  _onUnitDeath(u) {
    if (u.boss) {
      this.guardianState = 2; this.guardian = null;
      if (u.leaving || !u.lastTeam) { this.emit('guardianLeft', {}); return; }
      const g = this.cfg.team.guardian, s = this.T[u.lastTeam], o = this.owners[u.lastOwner];
      s.buffLeft = g.buffSec || 20;
      this._addFund(u.lastTeam, g.killFund || 0);
      this.emit('guardianDown', { team: u.lastTeam, by: o ? o.name : '', color: o ? o.color : '#fff', buffSec: g.buffSec || 20, mult: g.buffMult || 1.5, x: u.x, y: u.y });
      return;
    }
    const s = this.T[u.team];
    if (this.mode === 'team' && s && u.owner >= 0 && s.bounty === u.owner) { // lính của người bị truy nã
      const claimer = this.ENEMY[u.team], cs = this.T[claimer], o = this.owners[u.owner];
      cs.bountyBuf++; cs.bountyTarget = o ? o.name : '';
      this._addFund(claimer, (this.cfg.team.bounty && this.cfg.team.bounty.fund) || 0);
    }
  }

  _pickTarget(u) {
    let best = null, bd = Infinity;
    const enemy = this.ENEMY[u.team];
    const scan = (defOnly) => {
      for (const b of this.buildings) {
        if (b.hp <= 0 || b.team !== enemy || (defOnly && b.kind !== 'defense')) continue;
        const d = Math.hypot(b.x - u.x, b.y - u.y);
        if (d < bd) { bd = d; best = b; }
      }
    };
    scan(u.pref === 'defense');
    if (!best && u.pref === 'defense') scan(false);
    return best;
  }

  _unitsStep(dt) {
    const siege = this.mode === 'team' && this.phase === 'siege' ? (this.cfg.team.siegeBonus || 1) : 1;
    const mult = {}, spd = {};
    for (const t of this.teams) { mult[t] = this.troopMult(t); spd[t] = this.T[t].rageLeft > 0 ? 1.25 : 1; }
    this.flip = !this.flip;
    const order = this.flip ? this.units : [...this.units].reverse();
    for (const u of order) {
      if (this.status !== 'playing') break;
      if (u.hp <= 0) continue;
      if (u.boss) { this._guardianStep(u, dt); continue; }
      if (this.mode === 'team' && this._fight(u, dt, mult[u.team], spd[u.team])) continue; // đang giao tranh với lính địch
      if (!u.target || u.target.hp <= 0) u.target = this._pickTarget(u);
      const b = u.target;
      if (!b) { u.state = 0; continue; }
      const ax = b.x + Math.cos(u.ang) * b.radius * 0.7, ay = b.y + Math.sin(u.ang) * b.radius * 0.7;
      const dist = Math.hypot(ax - u.x, ay - u.y);
      if (dist <= u.range + 0.3) {
        u.state = 1;
        const dmg = u.dps * mult[u.team] * dt * siege;
        this._hitBuilding(b, dmg, u.owner);
        if (u.chain) {
          const others = this.buildings.filter((o) => o !== b && o.hp > 0 && o.team === b.team && Math.hypot(o.x - b.x, o.y - b.y) <= 9)
            .sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y)).slice(0, u.chain);
          for (const o of others) this._hitBuilding(o, dmg * 0.5, u.owner);
        }
      } else {
        u.state = 0;
        const step = Math.min(dist, u.speed * spd[u.team] * dt);
        u.x += (ax - u.x) / dist * step;
        u.y += (ay - u.y) / dist * step;
      }
    }
  }

  /* ---------- Giao tranh lính với lính (chỉ ở chế độ đội) ---------- */
  _foeRadius(u) {
    if (this.phase === 'siege') return Math.min(u.foeRad, (this.cfg.team && this.cfg.team.contactRadius) || 7); // pha công thành: chỉ đánh khi bị chặn đường
    return u.foeRad;
  }

  _findFoe(u) {
    const rad = this._foeRadius(u);
    if (!rad) return null;
    let best = null, bd = rad;
    for (const e of this.units) {
      if (e.team === u.team || e.hp <= 0) continue;
      if (e.air ? !u.hitsA : !u.hitsG) continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  _hitUnit(u, e, dmg) {
    const real = Math.min(Math.max(e.hp, 0), dmg);
    e.pend = (e.pend || 0) + dmg; e.lastHit = u.owner; // áp dụng đồng thời sau vòng lặp
    if (e.boss) { e.lastTeam = u.team; e.lastOwner = u.owner; }
    this._credit(u.owner, real * ((this.cfg.team && this.cfg.team.unitCredit) || 0));
  }
  _applyPending() {
    for (const e of this.units) {
      if (!e.pend) continue;
      const was = e.hp > 0; e.hp -= e.pend; e.pend = 0;
      if (was && e.hp <= 0 && e.lastHit != null) { const o = this.owners[e.lastHit]; if (o) o.frags++; }
    }
  }

  // Trả về true nếu lính này đang bận đánh nhau (thì không đi công thành trong tick này)
  _fight(u, dt, mult, spd) {
    u.scanT -= dt;
    if (!u.foe || u.foe.hp <= 0 || u.scanT <= 0) { u.foe = this._findFoe(u); u.scanT = 0.3; }
    const e = u.foe;
    if (!e || e.hp <= 0) { u.foe = null; return false; }
    const dist = Math.hypot(e.x - u.x, e.y - u.y);
    if (dist > this._foeRadius(u) + 3) { u.foe = null; return false; } // bị kéo ra xa quá tầm thì bỏ
    if (dist <= u.range + 0.6) {
      u.state = 1;
      const dmg = u.unitDps * mult * dt;
      this._hitUnit(u, e, dmg);
      if (u.unitSplash) {
        for (const o of this.units) {
          if (o === e || o.team === u.team || o.hp <= 0 || (o.air ? !u.hitsA : !u.hitsG)) continue;
          if (Math.hypot(o.x - e.x, o.y - e.y) <= u.unitSplash) this._hitUnit(u, o, dmg * 0.6);
        }
      }
    } else {
      u.state = 0;
      const step = Math.min(dist - (u.range + 0.4), u.speed * spd * dt);
      u.x += (e.x - u.x) / dist * step;
      u.y += (e.y - u.y) / dist * step;
    }
    return true;
  }

  _canHit(d, u) {
    if (u.team !== this.ENEMY[d.team]) return false;
    const dist = Math.hypot(u.x - d.x, u.y - d.y);
    if (dist > d.range + 0.5 || dist < d.minRange) return false;
    return d.targets === 'both' || (d.targets === 'air' && u.air) || (d.targets === 'ground' && !u.air);
  }

  _defensesStep(dt) {
    const dm = this.defMult();
    const bl = this.flip ? this.buildings : [...this.buildings].reverse();
    for (const d of bl) {
      if (d.hp <= 0 || d.kind !== 'defense') continue;
      const attacker = this.T[this.ENEMY[d.team]];
      if (attacker && attacker.freezeEnemyLeft > 0) { d.tid = -1; d.ramp = 0; continue; }

      let t = null;
      if (d.tid > 0) { t = this.units.find((u) => u.id === d.tid); if (!t || t.hp <= 0 || !this._canHit(d, t)) t = null; }
      if (!t) {
        let bd = Infinity;
        for (const u of this.units) {
          if (u.hp <= 0 || !this._canHit(d, u)) continue;
          const dist = Math.hypot(u.x - d.x, u.y - d.y);
          if (dist < bd) { bd = dist; t = u; }
        }
      }
      if (!t) { d.tid = -1; d.ramp = 0; continue; }
      if (d.tid !== t.id) d.ramp = 0;
      d.tid = t.id; d.ramp += dt;

      let dps = d.dps;
      if (d.rampDps) dps = d.dps + (d.rampDps - d.dps) * Math.min(1, d.ramp / d.rampSec);
      const dmg = dps * dm * dt;
      t.hp -= dmg;
      if (d.splash) {
        for (const u of this.units) {
          if (u === t || u.hp <= 0 || u.air !== t.air || u.team !== t.team) continue;
          if (Math.hypot(u.x - t.x, u.y - t.y) <= d.splash) u.hp -= dmg * 0.7;
        }
      }
    }
  }

  /* ---------- Hàm thử (bảng điều khiển admin) ---------- */
  debugGuardian() { if (this.mode === 'team' && this.status === 'playing') { if (this.guardian) return; this.guardianState = 0; this._spawnGuardian(); } }
  debugFund(team, n) { if (this.T[team]) this._addFund(team, n); }
  debugMorale(team) { if (this.T[team]) this.addMorale(team, this.T[team].moraleMax); }
  debugGolden() { if (this.mode === 'team') this.timeLeft = Math.min(this.timeLeft, ((this.cfg.team.golden && this.cfg.team.golden.sec) || 30) + 0.2); }

  /* ------------------------------------------------------------ */
  /* Dữ liệu gửi cho overlay                                       */
  /* ------------------------------------------------------------ */
  layout() {
    return this.buildings.map((b) => ({ id: b.id, type: b.type, team: b.team, x: b.x, y: b.y, radius: b.radius, maxHp: Math.round(b.maxHp) }));
  }

  snapshot() {
    const T = {};
    for (const t of this.teams) {
      const s = this.T[t];
      T[t] = {
        p: Math.round(this.destruction(t) * 1000) / 10, s: s.stars,
        cb: { n: s.combo.left > 0 ? s.combo.count : 0, m: this.comboMult(t), l: r1(s.combo.left), w: (this.cfg.combo && this.cfg.combo.windowSec) || 1 },
        rg: { l: r1(s.rageLeft), m: s.rageMult },
        fz: r1(s.freezeEnemyLeft), // đội này đang đóng băng phòng thủ của đối phương
      };
      if (this.mode === 'team') {
        Object.assign(T[t], {
          fu: Math.round(s.fund / s.fundMax * 100), fl: s.unlocks,
          mo: Math.round(s.morale / s.moraleMax * 100), mb: r1(s.moraleBuffLeft),
          bf: r1(s.buffLeft), ps: r1(s.poisonEnemyLeft), sh: r1(s.shieldLeft), cu: s.cuOn,
          tp: this.topPoints(t), bt: s.bounty >= 0, tt: s.troopTotals,
        });
      }
    }
    const gu = this.guardian;
    return {
      m: this.mode,
      u: this.units.map((u) => [u.id, u.key, r1(u.x), r1(u.y), Math.round(clamp(u.hp / u.maxHp, 0, 1) * 100), u.state, u.target ? u.target.id : -1, u.owner, u.vs, u.team, u.foe && u.foe.hp > 0 ? u.foe.id : -1,
        u.owner >= 0 && this.T[u.team] && this.T[u.team].bounty === u.owner ? 1 : 0]),
      b: this.buildings.map((b) => [b.id, Math.round(b.hp), b.tid]),
      tl: Math.round(this.timeLeft * 10) / 10,
      en: this.enraged,
      ph: this.phase, pl: r1(Math.max(0, this.clashLeft)),
      gd: this.golden, ot: this.overtime, lr: this.lateRushOn,
      bo: gu ? { id: gu.id, hp: Math.round(gu.hp / gu.maxHp * 100), left: r1(gu.left) } : null,
      T,
    };
  }
}

module.exports = { Game };

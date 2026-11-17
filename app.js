'use strict';

/* =====================================================================
   Checklist Comparison — standalone site
   - Baseline data (FFXIAH, 2026-11-15) lives in data/baseline.json.
   - Live XIchecklist syncs come from the Google Apps Script web app
     below, which reads the "FFXI Achievement Sync" Google Form,
     checks each submission's key privately, and serves clean JSON.
     Syncs carry titles, RoE, missions, quests, warps and key items;
     v1.5 syncs also carry jobs, per-job Master Levels, crafts and
     REMA, which replace the baseline values for that player.
   - The Apps Script CANNOT be fetched with plain fetch(): it sends no
     CORS headers, so browsers block the response. The working pattern
     is JSONP (a <script> tag with a ?callback= parameter), which is
     what loadLiveData() below does. The endpoint is slow — cold start
     plus the Google redirect chain measured 17.6s / 17.7s / 33.9s —
     so the timeout is 40s with one retry, and the last good live
     response is cached in localStorage: cached data renders
     immediately and survives a failed refresh. Only a page with no
     cache at all falls back to the baseline — and says so. It never
     breaks.
   ===================================================================== */

// Paste the Apps Script web app /exec URL here after deploying.
// Leave it empty to run on baseline data only.
const API_URL = 'https://script.google.com/macros/s/AKfycbwgEpK90nzPaQQrJsY4dfiTFZsdidzV_l5orx8k08-E_I0KJCx1t2V-Cy17zJ4_CRvgEw/exec';
const API_TIMEOUT_MS = 40000; // Apps Script cold start + redirect chain measured 17.6–33.9s

/* ---------------- Scoring (must match the Muse page) ---------------- */

const TITLE_RATES = { quest: 10, mission: 20, nm: 25, battlefield: 50, master_trials: 100, other: 0 };
const CHECK_RATES = { roe: 5, missions: 5, quests: 10, warps: 5, keyItems: 2 };
const ML_RATE = 1; // 1 point per Master Level (added 2026-11-16)
const BADGE_TIERS = [
  { at: 100, name: 'First Century' },
  { at: 250, name: 'Quarter Way There' },
  { at: 500, name: 'Halfway to Everywhere' },
  { at: 750, name: 'Three-Quarters There' },
  { at: 1000, name: 'Title Master' },
];

// Which XIchecklist count fields belong to each scored group.
// NOTE: 'abyssea' (lowercase) is a quest region; 'Abyssea' (capitalised)
// is a key-item field whose total is 0 in the payload, so it is excluded
// from the key-item group entirely (completed and total).
const MISSION_FIELDS = ['sandoriamissions', 'bastokmissions', 'windurstmissions', 'zilartmissions', 'copmissions', 'ahturhganmissions', 'assaults', 'wotgmissions', 'acpmissions', 'mkdmissions', 'asamissions', 'soamissions', 'rovmissions', 'tvrmissions', 'campaign'];
const QUEST_FIELDS = ['bastok', 'sandoria', 'windurst', 'jeuno', 'ahturhgan', 'crystalwar', 'outlands', 'other', 'abyssea', 'adoulin', 'coalition'];
const WARP_FIELDS = ['homepoints', 'survivalguides', 'waypoints', 'telepoints', 'cavernousmaws', 'lycopodium', 'eschanportals', 'outposts', 'protowaypoints', 'abysseaconflux'];
const KEY_ITEM_FIELDS = ['Permanent_Key_Items', 'Magical_Maps', 'Mounts', 'Claim_Slips', 'Active_Effects', 'Voidwatch', 'Mog_Garden', 'MedalOfAltana'];
const MAGIC_FIELDS = ['WhiteMagic', 'BlackMagic', 'SummonerPact', 'Ninjutsu', 'BardSong', 'BlueMagic', 'Geomancy', 'Trust', 'CorsairRoll', 'pupattachments'];

const FIELD_LABELS = {
  sandoriamissions: 'San d\u2019Oria', bastokmissions: 'Bastok', windurstmissions: 'Windurst',
  zilartmissions: 'Rise of the Zilart', copmissions: 'Chains of Promathia',
  ahturhganmissions: 'Treasures of Aht Urhgan', assaults: 'Assault', wotgmissions: 'Wings of the Goddess',
  acpmissions: 'A Crystalline Prophecy', mkdmissions: 'A Moogle Kupo d\u2019Etat',
  asamissions: 'A Shantotto Ascension', soamissions: 'Seekers of Adoulin',
  rovmissions: 'Rhapsodies of Vana\u2019diel', tvrmissions: 'The Voracious Resurgence', campaign: 'Campaign',
  bastok: 'Bastok', sandoria: 'San d\u2019Oria', windurst: 'Windurst', jeuno: 'Jeuno',
  ahturhgan: 'Aht Urhgan', crystalwar: 'Crystal War', outlands: 'Outlands', other: 'Other',
  abyssea: 'Abyssea', adoulin: 'Adoulin', coalition: 'Coalition',
  homepoints: 'Home Points', survivalguides: 'Survival Guides', waypoints: 'Waypoints',
  telepoints: 'Telepoints', cavernousmaws: 'Cavernous Maws', lycopodium: 'Lycopodium',
  eschanportals: 'Eschan Portals', outposts: 'Outposts', protowaypoints: 'Proto-Waypoints',
  abysseaconflux: 'Abyssean Confluxes',
  Permanent_Key_Items: 'Permanent Key Items', Magical_Maps: 'Magical Maps', Mounts: 'Mounts',
  Claim_Slips: 'Claim Slips', Active_Effects: 'Active Effects', Voidwatch: 'Voidwatch',
  Mog_Garden: 'Mog Garden', MedalOfAltana: 'Medal of Altana',
  WhiteMagic: 'White Magic', BlackMagic: 'Black Magic', SummonerPact: 'Summoner Pacts',
  Ninjutsu: 'Ninjutsu', BardSong: 'Bard Songs', BlueMagic: 'Blue Magic', Geomancy: 'Geomancy',
  Trust: 'Trusts', CorsairRoll: 'Corsair Rolls', pupattachments: 'Puppet Attachments',
  Titles: 'Titles', roe: 'Records of Eminence', zones: 'Zones', mentor_rank: 'Mentor Rank',
  meritpoints: 'Merit Points', jobpoints: 'Job Points', masterlevels: 'Master Levels',
  craftingskills: 'Crafting Skills', combatskills: 'Combat Skills',
};

function sumFields(counts, fields) {
  let completed = 0, total = 0;
  for (const f of fields) {
    const v = counts && counts[f];
    if (v && typeof v.completed === 'number') completed += v.completed;
    if (v && typeof v.total === 'number') total += v.total;
  }
  return { completed, total };
}

function scoreJobs(player) {
  if (!player.jobs) return 0;
  let s = 0;
  for (const j of Object.values(player.jobs)) {
    s += j.level;
    if (j.level >= 99) s += 100;
  }
  return s;
}

function scoreCrafts(player) {
  if (!player.crafts) return 0;
  let s = 0;
  for (const lvl of Object.values(player.crafts)) {
    s += 2 * Math.min(lvl, 70) + Math.max(0, lvl - 70);
  }
  return s;
}

function scoreRema(player) {
  if (!player.rema) return 0;
  let s = 0;
  for (const r of player.rema) {
    if (r.kind === 'rod' || r.kind === 'escutcheon') s += 50;
    else if (r.stage === 119) s += 250;
    else s += 150; // any other-stage REMA
  }
  return s;
}

// Titles are scored from the sync's per-group counts, NOT the raw list
// (the list is truncated at the 28,000-char form cap).
function scoreTitles(sync) {
  if (!sync || !sync.groups) return 0;
  let s = 0;
  for (const [group, rate] of Object.entries(TITLE_RATES)) {
    const g = sync.groups[group];
    if (g) s += g.completed * rate;
  }
  return s;
}

function scoreChecklist(sync) {
  if (!sync || !sync.counts) return 0;
  const c = sync.counts;
  const roe = c.roe ? c.roe.completed : 0;
  const missions = sumFields(c, MISSION_FIELDS).completed;
  const quests = sumFields(c, QUEST_FIELDS).completed;
  const warps = sumFields(c, WARP_FIELDS).completed;
  const keyItems = sumFields(c, KEY_ITEM_FIELDS).completed;
  return roe * CHECK_RATES.roe
    + missions * CHECK_RATES.missions
    + quests * CHECK_RATES.quests
    + warps * CHECK_RATES.warps
    + keyItems * CHECK_RATES.keyItems;
}

// Master Levels: 1 point each. A live sync's per-job Master Level map
// (v1.5 payloads) is authoritative and REPLACES the counts.masterlevels
// total — the two are never added together. Without the map, a live
// sync's masterlevels count is authoritative (it covers all 22 jobs);
// otherwise sum the baseline per-job ML figures from FFXIAH, skipping
// jobs whose ML is unknown.
function scoreMasterLevels(player, sync) {
  if (sync && sync.masterLevels && Object.keys(sync.masterLevels).length) {
    let s = 0;
    for (const v of Object.values(sync.masterLevels)) s += v;
    return s * ML_RATE;
  }
  if (sync && sync.counts && sync.counts.masterlevels && typeof sync.counts.masterlevels.completed === 'number') {
    return sync.counts.masterlevels.completed * ML_RATE;
  }
  if (!player.jobs) return 0;
  let s = 0;
  for (const j of Object.values(player.jobs)) {
    if (typeof j.ml === 'number') s += j.ml;
  }
  return s * ML_RATE;
}

function badgeFor(titleCount) {
  let earned = null, next = null;
  for (const t of BADGE_TIERS) {
    if (titleCount >= t.at) earned = t;
    else if (!next) next = t;
  }
  return { earned, next };
}

/* ---------------- Sync payload normalisation ---------------- */

// v1.5 sync fields (read live from the game by the autosync fork):
//   jobs          { "WAR": 99, ... } — all 22 jobs, uppercase 3-letter codes
//   master_levels { "WAR": 40, ... } — per-job Master Levels, 0-50
//   crafts        { "Smithing": 68, ... } — all 10 crafts, keys as in baseline.json
//   rema          [ { "name": "Caladbolg", "item_level": 119 }, ... ]
// The receiver forwards the whole payload as-is, so these arrive inside
// each player's sync object with no receiver change. When a field is
// absent the baseline.json values are used instead (see effective*).

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Keep only finite numeric values, floored; null when nothing usable.
function normalizeSyncLevelMap(map) {
  if (!isPlainObject(map)) return null;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'number' && isFinite(v)) out[k] = Math.floor(v);
  }
  return Object.keys(out).length ? out : null;
}

function normalizeSyncJobs(jobs) {
  const m = normalizeSyncLevelMap(jobs);
  if (!m) return null;
  const out = {};
  for (const [code, lvl] of Object.entries(m)) out[String(code).toUpperCase()] = lvl;
  return out;
}

function normalizeSyncMasterLevels(ml) { return normalizeSyncLevelMap(ml); }

function normalizeSyncCrafts(crafts) { return normalizeSyncLevelMap(crafts); }

// Convert synced REMA items to the baseline shape
// ({ kind: 'rema'|'rod'|'escutcheon', name, stage }). Extras are
// identified by name, mirroring baseline.json: fishing rods and
// escutcheons are the 50-point extras, never 119/150-point weapons.
function normalizeSyncRema(rema) {
  if (!Array.isArray(rema)) return null;
  const out = [];
  for (const r of rema) {
    if (!r || typeof r.name !== 'string') continue;
    const name = r.name;
    const ilvl = typeof r.item_level === 'number' ? r.item_level : null;
    if (/fishing rod/i.test(name) || /^lu shang/i.test(name)) out.push({ kind: 'rod', name, stage: null });
    else if (/escutcheon/i.test(name)) out.push({ kind: 'escutcheon', name, stage: null });
    else out.push({ kind: 'rema', name, stage: ilvl });
  }
  return out.length ? out : null;
}

// The fork sends "Leathercraft"; baseline.json spells it "Leathercrafting".
const CRAFT_KEY_ALIASES = { Leathercraft: 'Leathercrafting' };

// Effective (merged) values for one player: synced fields win, baseline
// fills anything the sync didn't send. Jobs/crafts merge per key; REMA
// merges per weapon name — the sync updates each weapon it found, and
// baseline weapons the inventory scan couldn't see (Wardrobes 5-8,
// storage slips) stay on the card. Mastery Rank takes the sync scalar
// when present, baseline otherwise.
function effectiveJobs(player, sync) {
  if (!sync || !sync.jobs) return player.jobs || null;
  const base = player.jobs || {};
  const out = {};
  const codes = new Set([...Object.keys(base), ...Object.keys(sync.jobs)]);
  for (const code of codes) {
    const lvl = sync.jobs[code] != null ? sync.jobs[code] : (base[code] ? base[code].level : null);
    if (lvl == null) continue;
    let ml = null;
    if (sync.masterLevels && sync.masterLevels[code] != null) ml = sync.masterLevels[code];
    else if (base[code] && base[code].ml != null) ml = base[code].ml;
    out[code] = { level: lvl, ml };
  }
  return Object.keys(out).length ? out : null;
}

function effectiveCrafts(player, sync) {
  if (!sync || !sync.crafts) return player.crafts || null;
  const out = Object.assign({}, player.crafts || {});
  for (const [name, lvl] of Object.entries(sync.crafts)) {
    out[CRAFT_KEY_ALIASES[name] || name] = lvl;
  }
  return Object.keys(out).length ? out : null;
}

function effectiveRema(player, sync) {
  if (!sync || !sync.rema) return player.rema || null;
  const byName = new Map();
  for (const r of (player.rema || [])) byName.set(r.name, { kind: r.kind, name: r.name, stage: r.stage });
  for (const r of sync.rema) byName.set(r.name, { kind: r.kind, name: r.name, stage: r.stage });
  const out = [...byName.values()];
  return out.length ? out : null;
}

// Turn a raw sync payload (as served by the Apps Script) into the
// shape the page uses. Returns null if the payload is unusable.
function normalizeSync(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.counts || typeof payload.counts !== 'object') return null;
  const c = payload.counts;
  const groups = payload.title_points_groups || {};
  const titlesCount = c.Titles || { completed: 0, total: 0 };
  return {
    syncedAt: payload.synced_at || null,
    counts: c,
    scalars: payload.scalars || {},
    jobs: normalizeSyncJobs(payload.jobs),
    masterLevels: normalizeSyncMasterLevels(payload.master_levels),
    crafts: normalizeSyncCrafts(payload.crafts),
    rema: normalizeSyncRema(payload.rema),
    titles: { completed: titlesCount.completed, total: titlesCount.total },
    groups: {
      quest: groups.quest || { completed: 0, total: 0 },
      mission: groups.mission || { completed: 0, total: 0 },
      nm: groups.nm || { completed: 0, total: 0 },
      battlefield: groups.battlefield || { completed: 0, total: 0 },
      master_trials: groups.master_trials || { completed: 0, total: 0 },
      other: groups.other || { completed: 0, total: 0 },
    },
    titlesByContent: payload.titles_by_content || {},
    titlesList: Array.isArray(payload.titles) ? payload.titles : [],
    titlesTruncated: !!payload.titles_truncated,
    titlesTotal: payload.titles_total || titlesCount.completed,
    roe: c.roe || { completed: 0, total: 0 },
    missions: sumFields(c, MISSION_FIELDS),
    quests: sumFields(c, QUEST_FIELDS),
    warps: sumFields(c, WARP_FIELDS),
    keyItems: sumFields(c, KEY_ITEM_FIELDS),
  };
}

// Merge one baseline player with their live sync (if any) and score it.
// Jobs/crafts/REMA come from the sync when present, baseline otherwise;
// scoring is identical either way. `effective` is the merged player
// the card and the milestone matrix render from.
function scorePlayer(player, livePayload) {
  const sync = livePayload ? normalizeSync(livePayload) : null;
  const effective = Object.assign({}, player, {
    jobs: effectiveJobs(player, sync),
    crafts: effectiveCrafts(player, sync),
    rema: effectiveRema(player, sync),
    masteryRank: sync && sync.scalars && sync.scalars.mastery_rank != null ? sync.scalars.mastery_rank : player.masteryRank,
  });
  const jobs = scoreJobs(effective);
  const masterLevels = scoreMasterLevels(player, sync);
  const crafts = scoreCrafts(effective);
  const rema = scoreRema(effective);
  const titles = scoreTitles(sync);
  const checklist = scoreChecklist(sync);
  return {
    player,
    effective,
    sync,
    scores: { jobs, masterLevels, crafts, rema, titles, checklist, total: jobs + masterLevels + crafts + rema + titles + checklist },
  };
}

// Score every baseline player against a {name: payload} live map and rank them.
function computeBoard(baselinePlayers, liveByName) {
  const rows = baselinePlayers.map((p) => scorePlayer(p, liveByName ? liveByName[p.name] || null : null));
  rows.sort((a, b) => b.scores.total - a.scores.total || a.player.name.localeCompare(b.player.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/* ---------------- Milestones (who-has-what matrix) ---------------- */

function milestoneValue(player, sync, check) {
  try { return check(player, sync); } catch (e) { return null; }
}

// Partial progress toward a milestone, for the "Name · have/need"
// display in the who-has-what list. Returns { have, need } or null
// when the milestone is boolean-only or the player has no data.
function milestoneProgress(player, sync, m) {
  try { return m.progress ? m.progress(player, sync) : null; } catch (e) { return null; }
}

const MILESTONES = [
  { id: 'all99', label: 'All 22 jobs at 99', check: (p) => p.jobs ? Object.values(p.jobs).every((j) => j.level >= 99) : null, progress: (p) => p.jobs ? { have: Object.values(p.jobs).filter((j) => j.level >= 99).length, need: 22 } : null },
  { id: 'rank10', label: 'Nation Rank 10', check: (p) => p.nationRank == null ? null : p.nationRank >= 10, progress: (p) => p.nationRank != null ? { have: p.nationRank, need: 10 } : null },
  { id: 'mr7', label: 'Mastery Rank 7+', check: (p, s) => { const v = s && s.scalars && s.scalars.mastery_rank != null ? s.scalars.mastery_rank : p.masteryRank; return v == null ? null : v >= 7; }, progress: (p, s) => { const v = s && s.scalars && s.scalars.mastery_rank != null ? s.scalars.mastery_rank : p.masteryRank; return v == null ? null : { have: v, need: 7 }; } },
  { id: 'mr8', label: 'Mastery Rank 8', check: (p, s) => { const v = s && s.scalars && s.scalars.mastery_rank != null ? s.scalars.mastery_rank : p.masteryRank; return v == null ? null : v >= 8; }, progress: (p, s) => { const v = s && s.scalars && s.scalars.mastery_rank != null ? s.scalars.mastery_rank : p.masteryRank; return v == null ? null : { have: v, need: 8 }; } },
  { id: 'craft110', label: 'A craft at 110', check: (p) => p.crafts ? Object.values(p.crafts).some((v) => v >= 110) : null, progress: (p) => p.crafts ? { have: Math.max.apply(null, Object.values(p.crafts)), need: 110 } : null },
  { id: 'fish110', label: 'Fishing 110', check: (p) => p.crafts ? (p.crafts.Fishing || 0) >= 110 : null, progress: (p) => p.crafts ? { have: (p.crafts.Fishing || 0), need: 110 } : null },
  { id: 'craft90', label: 'A craft at 90+', check: (p) => p.crafts ? Object.values(p.crafts).some((v) => v >= 90) : null, progress: (p) => p.crafts ? { have: Math.max.apply(null, Object.values(p.crafts)), need: 90 } : null },
  { id: 't100', label: '100+ titles', check: (p, s) => s ? s.titles.completed >= 100 : null, progress: (p, s) => s ? { have: s.titles.completed, need: 100 } : null },
  { id: 't250', label: '250+ titles', check: (p, s) => s ? s.titles.completed >= 250 : null, progress: (p, s) => s ? { have: s.titles.completed, need: 250 } : null },
  { id: 't500', label: '500+ titles', check: (p, s) => s ? s.titles.completed >= 500 : null, progress: (p, s) => s ? { have: s.titles.completed, need: 500 } : null },
  { id: 't750', label: '750+ titles', check: (p, s) => s ? s.titles.completed >= 750 : null, progress: (p, s) => s ? { have: s.titles.completed, need: 750 } : null },
  { id: 't1000', label: '1,000+ titles', check: (p, s) => s ? s.titles.completed >= 1000 : null, progress: (p, s) => s ? { have: s.titles.completed, need: 1000 } : null },
  { id: 'ult10', label: '10+ ultimates', check: (p) => p.rema ? p.rema.length >= 10 : null, progress: (p) => p.rema ? { have: p.rema.length, need: 10 } : null },
  { id: 'ult25', label: '25+ ultimates', check: (p) => p.rema ? p.rema.length >= 25 : null, progress: (p) => p.rema ? { have: p.rema.length, need: 25 } : null },
  { id: 'ult40', label: '40+ ultimates', check: (p) => p.rema ? p.rema.length >= 40 : null, progress: (p) => p.rema ? { have: p.rema.length, need: 40 } : null },
  { id: 'rema119', label: 'A 119 REMA weapon', check: (p) => p.rema ? p.rema.some((r) => r.kind === 'rema' && r.stage === 119) : null },
  { id: 'lushang', label: 'Lu Shang\u2019s Fishing Rod', check: (p) => p.rema ? p.rema.some((r) => r.name.indexOf('Lu Shang') === 0) : null },
  { id: 'merits', label: 'Merit Points capped', check: (p, s) => { if (!s) return null; const m = s.counts.meritpoints; return m && m.total > 0 ? m.completed >= m.total : null; }, progress: (p, s) => { if (!s) return null; const m = s.counts.meritpoints; return m && m.total > 0 ? { have: m.completed, need: m.total } : null; } },
  { id: 'roe400', label: 'RoE 400+', check: (p, s) => s ? s.roe.completed >= 400 : null, progress: (p, s) => s ? { have: s.roe.completed, need: 400 } : null },
  { id: 'mis500', label: 'Missions 500+', check: (p, s) => s ? s.missions.completed >= 500 : null, progress: (p, s) => s ? { have: s.missions.completed, need: 500 } : null },
  { id: 'que400', label: 'Quests 400+', check: (p, s) => s ? s.quests.completed >= 400 : null, progress: (p, s) => s ? { have: s.quests.completed, need: 400 } : null },
  { id: 'warp300', label: 'Warps 300+', check: (p, s) => s ? s.warps.completed >= 300 : null, progress: (p, s) => s ? { have: s.warps.completed, need: 300 } : null },
  { id: 'zone250', label: 'Zones 250+', check: (p, s) => { if (!s) return null; const z = s.counts.zones; return z ? z.completed >= 250 : null; }, progress: (p, s) => { if (!s) return null; const z = s.counts.zones; return z ? { have: z.completed, need: 250 } : null; } },
  { id: 'play2000', label: 'Playtime 2,000+ hrs', check: (p, s) => s && s.scalars.playtime != null ? s.scalars.playtime >= 2000 : null, progress: (p, s) => s && s.scalars.playtime != null ? { have: s.scalars.playtime, need: 2000 } : null },
];

/* ---------------- Live data (JSONP — see header note) ---------------- */

function loadLiveData(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('no DOM')); return; }
    const cbName = 'ffxiSyncCb_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('API timed out')); }, timeoutMs || API_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      try { delete window[cbName]; } catch (e) { /* ignore */ }
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cbName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('API could not be reached')); };
    script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + encodeURIComponent(cbName);
    document.head.appendChild(script);
  });
}

/* ---------------- Live-data cache (localStorage) ---------------- */

// The Apps Script endpoint is slow (cold start + redirect chain: the
// parent measured 17.6s / 17.7s / 33.9s), so a fresh load often outruns
// even a 40s timeout. The last good live response is cached locally so
// the page can render it immediately and keep showing it when a refresh
// fails, instead of dropping to baseline. The cache never expires on
// its own — the status line always shows when it was fetched, so its
// age is visible. All localStorage access is guarded: a missing or
// blocked localStorage must never break rendering.
const CACHE_KEY = 'ffxi-live-v1';

function safeLocalStorage() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
  } catch (e) {
    return null;
  }
}

// Store a live response ({ players, ... }) with a fetch timestamp.
// Only a response that actually carries players is worth caching.
// Returns true when the cache was written.
function saveLiveCache(data) {
  if (!data || typeof data !== 'object' || !data.players || typeof data.players !== 'object'
      || Object.keys(data.players).length === 0) return false;
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), data }));
    return true;
  } catch (e) {
    return false;
  }
}

// Read the cached live response. Returns { fetchedAt, data } or null
// when there is no cache, or it is corrupt / the wrong shape.
function loadLiveCache() {
  const ls = safeLocalStorage();
  if (!ls) return null;
  let raw = null;
  try { raw = ls.getItem(CACHE_KEY); } catch (e) { return null; }
  if (!raw) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.fetchedAt !== 'number' || !isFinite(parsed.fetchedAt)) return null;
  if (!parsed.data || typeof parsed.data !== 'object') return null;
  if (!parsed.data.players || typeof parsed.data.players !== 'object') return null;
  if (Object.keys(parsed.data.players).length === 0) return null;
  return parsed;
}

// Honest status line for a cached render: always names when fetched.
function cachedStatusText(fetchedAt) {
  const when = shortDateTime(fetchedAt);
  return 'Showing cached live data' + (when ? ' from ' + when : '') + '.';
}

// One retry after a timeout only — a cold Apps Script start can eat
// the first attempt. Other failures (unreachable, no DOM) fail at once.
function loadLiveDataWithRetry(url, timeoutMs) {
  return loadLiveData(url, timeoutMs).catch((err) => {
    if (err && err.message === 'API timed out') return loadLiveData(url, timeoutMs);
    throw err;
  });
}

// Render cached live data immediately when present, then refresh in
// the background. A failed refresh keeps the cached data; only a page
// with no cache at all falls back to baseline. `loader` is injectable
// for tests; it defaults to the real JSONP load with one timeout retry.
function loadLiveWithCache(baseline, loader) {
  const cached = loadLiveCache();
  if (cached) {
    renderAll(baseline, cached.data.players, cachedStatusText(cached.fetchedAt) + ' Refreshing\u2026', 'warn');
  } else {
    renderAll(baseline, null, 'Loading live sync data\u2026', '');
  }
  const doLoad = loader || (() => loadLiveDataWithRetry(API_URL));
  return doLoad()
    .then((data) => {
      saveLiveCache(data);
      const live = data && data.players ? data.players : {};
      const n = Object.keys(live).length;
      renderAll(baseline, live, n ? 'Live sync data loaded (' + n + ' player' + (n === 1 ? '' : 's') + ').' : 'Sync API answered but returned no players — showing baseline data.', n ? 'ok' : 'warn');
      return data;
    })
    .catch((err) => {
      const stillCached = loadLiveCache();
      if (stillCached) {
        renderAll(baseline, stillCached.data.players, 'Live sync unavailable (' + err.message + ') — ' + cachedStatusText(stillCached.fetchedAt), 'warn');
      } else {
        renderAll(baseline, null, 'Sync data unavailable (' + err.message + ') — showing baseline data.', 'warn');
      }
      return null;
    });
}

/* ---------------- Rendering ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) { return Number(n).toLocaleString('en-US'); }

function bar(completed, total) {
  if (!total) return '';
  const pct = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  return '<div class="bar"><span style="width:' + pct + '%"></span></div>';
}

function countRow(label, v) {
  return '<div class="count-row"><span>' + esc(label) + '</span><b>' + fmt(v.completed) + ' / ' + fmt(v.total) + '</b>' + bar(v.completed, v.total) + '</div>';
}

function groupBlock(title, fields, counts) {
  const rows = fields.map((f) => {
    const v = counts[f];
    if (!v) return '';
    return countRow(FIELD_LABELS[f] || f, v);
  }).join('');
  return '<div class="group-block"><h4>' + esc(title) + '</h4>' + rows + '</div>';
}

function renderLeaderboard(rows) {
  const el = document.getElementById('leaderboard-list');
  if (!el) return;
  el.innerHTML = rows.map((r) => {
    const s = r.scores;
    return '<a class="lb-row rank-' + r.rank + '" href="#card-' + esc(r.player.id) + '">'
      + '<span class="rank-circle">' + r.rank + '</span>'
      + '<span class="lb-name">' + esc(r.player.name) + '</span>'
      + '<span class="lb-points">' + fmt(s.total) + '</span>'
      + '</a>';
  }).join('');
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Sync timestamps show date + time ("Nov 16, 2026, 8:39 AM") so a
// card's freshness is visible at a glance. Rendered in the viewer's
// local timezone by toLocaleString.
function shortDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderCard(row) {
  const p = row.player, s = row.sync, sc = row.scores;
  const badge = s ? badgeFor(s.titles.completed) : { earned: null, next: BADGE_TIERS[0] };
  let html = '<article class="card" id="card-' + esc(p.id) + '">'
    + '<header class="card-head"><div><h3>' + esc(p.name) + '</h3>'
    + '<div class="sub">' + esc(p.server || '') + (p.nation ? ' &middot; ' + esc(p.nation) + (p.nationRank != null ? ' Rank ' + p.nationRank : '') : '') + '</div>'
    + (badge.earned ? '<div class="badge-line card-badge"><span class="badge earned">\u2605 ' + esc(badge.earned.name) + '</span></div>' : '')
    + '</div>'
    + '<div class="card-total"><span class="rank-badge">#' + row.rank + '</span><b>' + fmt(sc.total) + '</b><span>points</span></div></header>'
    + '<table class="breakdown">'
    + '<tr><td>Jobs</td><td class="num">' + fmt(sc.jobs) + '</td></tr>'
    + '<tr><td>Master Levels</td><td class="num">' + fmt(sc.masterLevels) + '</td></tr>'
    + '<tr><td>Crafts</td><td class="num">' + fmt(sc.crafts) + '</td></tr>'
    + '<tr><td>Relics</td><td class="num">' + fmt(sc.rema) + '</td></tr>'
    + '<tr><td>Titles</td><td class="num">' + fmt(sc.titles) + '</td></tr>'
    + '<tr><td>Checklist</td><td class="num">' + fmt(sc.checklist) + '</td></tr>'
    + '<tr class="total-row"><td>Total</td><td class="num">' + fmt(sc.total) + '</td></tr>'
    + '</table>';
  if (p.title) html += '<p class="flavor">\u201c' + esc(p.title) + '\u201d</p>';
  if (p.linkshells && p.linkshells.length) html += '<p class="linkshells">Linkshells: ' + p.linkshells.map(esc).join(', ') + '</p>';
  if (row.effective.masteryRank != null) html += '<p class="meta-line">Mastery Rank ' + row.effective.masteryRank + '</p>';

  html += '<div class="card-detail">';
  html += renderJobs(row.effective.jobs);
  html += renderCrafts(row.effective.crafts);
  html += renderRema(row.effective.rema);
  html += renderSync(s);
  html += '</div></article>';
  return html;
}

function renderJobs(jobs) {
  if (!jobs) return '<section class="detail-section"><h4>Jobs</h4><p class="na">Not available — FFXIAH page is empty or private.</p></section>';
  const order = ['WAR', 'MNK', 'WHM', 'BLM', 'RDM', 'THF', 'PLD', 'DRK', 'BST', 'BRD', 'RNG', 'SAM', 'NIN', 'DRG', 'SMN', 'BLU', 'COR', 'PUP', 'DNC', 'SCH', 'GEO', 'RUN'];
  const tiles = order.map((abbr) => {
    const j = jobs[abbr];
    if (!j) return '';
    return '<div class="job-tile' + (j.level >= 99 ? ' max' : '') + '"><span class="job-abbr">' + abbr + '</span><b>' + j.level + '</b>' + (j.ml != null ? '<span class="ml">ML ' + j.ml + '</span>' : '<span class="ml na">ML ?</span>') + '</div>';
  }).join('');
  const codes = Object.keys(jobs);
  const allMax = codes.length === 22 && codes.every((c) => jobs[c].level >= 99);
  return '<section class="detail-section"><details class="collapse"><summary>' + (allMax ? 'Jobs — all 22 at 99' : 'Jobs') + '</summary><div class="job-grid">' + tiles + '</div></details></section>';
}

function renderCrafts(crafts) {
  if (!crafts) return '<section class="detail-section"><h4>Crafts</h4><p class="na">Not available — FFXIAH page is empty or private.</p></section>';
  const rows = Object.entries(crafts).map(([name, lvl]) => countRow(name, { completed: lvl, total: 110 })).join('');
  return '<section class="detail-section"><h4>Crafts</h4>' + rows + '</section>';
}

function renderRema(rema) {
  if (!rema) return '<section class="detail-section"><h4>Ultimates (REMA)</h4><p class="na">Not available — FFXIAH page is empty or private.</p></section>';
  const at119 = rema.filter((r) => r.kind === 'rema' && r.stage === 119);
  const other = rema.filter((r) => r.kind === 'rema' && r.stage !== 119);
  const extras = rema.filter((r) => r.kind !== 'rema');
  const chip = (r) => '<span class="chip">' + esc(r.name) + (r.stage ? ' <span class="stage">' + r.stage + '</span>' : '') + '</span>';
  return '<section class="detail-section"><details class="collapse"><summary>Ultimates (' + rema.length + ')</summary>'
    + '<h5>119 (' + at119.length + ')</h5><div>' + at119.map(chip).join('') + '</div>'
    + (other.length ? '<h5>Below 119 (' + other.length + ')</h5><div>' + other.map(chip).join('') + '</div>' : '')
    + (extras.length ? '<h5>Extras</h5><div>' + extras.map(chip).join('') + '</div>' : '')
    + '</details></section>';
}

function renderSync(s) {
  if (!s) {
    return '<section class="detail-section sync-section"><h4>Checklist sync</h4>'
      + '<p class="na">Not synced yet — install the XIchecklist autosync fork and zone once, and titles, Records of Eminence, missions, quests and warps will fill in here automatically.</p></section>';
  }
  const badge = badgeFor(s.titles.completed);
  let html = '<section class="detail-section sync-section"><details class="collapse"><summary>Checklist sync <span class="pill teal">Synced ' + esc(shortDateTime(s.syncedAt)) + '</span></summary>';
  html += '<div class="badge-line">' + (badge.earned
    ? '<span class="badge earned">\u2605 ' + esc(badge.earned.name) + ' — ' + badge.earned.at + ' titles</span>'
    : '<span class="badge">No title badge yet</span>')
    + (badge.next ? '<span class="badge-next">Next badge: ' + badge.next.at + ' titles (' + fmt(s.titles.completed) + '/' + badge.next.at + ')</span>' : '<span class="badge-next">Top badge earned</span>')
    + '</div>';
  html += countRow('Titles', s.titles);
  const g = s.groups;
  html += '<div class="title-groups">'
    + '<div><span>Quest titles</span><b>' + fmt(g.quest.completed) + '</b><i>10 pts each</i></div>'
    + '<div><span>Mission titles</span><b>' + fmt(g.mission.completed) + '</b><i>20 pts each</i></div>'
    + '<div><span>NM titles</span><b>' + fmt(g.nm.completed) + '</b><i>25 pts each</i></div>'
    + '<div><span>Battlefield titles</span><b>' + fmt(g.battlefield.completed) + '</b><i>50 pts each</i></div>'
    + '<div><span>Master Trials titles</span><b>' + fmt(g.master_trials.completed) + '</b><i>100 pts each</i></div>'
    + '<div><span>Ungrouped titles</span><b>' + fmt(g.other.completed) + '</b><i>0 pts</i></div>'
    + '</div>';
  if (s.titlesTruncated) html += '<p class="note">Title list is partial (' + fmt(s.titlesList.length) + ' of ' + fmt(s.titlesTotal) + ' shown) — the sync form caps each submission, but the counts above are complete.</p>';
  html += countRow('Records of Eminence', s.roe);
  html += countRow('Missions', s.missions);
  html += countRow('Quests', s.quests);
  html += countRow('Warps', s.warps);
  html += countRow('Key items', s.keyItems);
  html += groupBlock('Missions by expansion', MISSION_FIELDS, s.counts);
  html += groupBlock('Quests by region', QUEST_FIELDS, s.counts);
  html += groupBlock('Warps', WARP_FIELDS, s.counts);
  html += groupBlock('Key items', KEY_ITEM_FIELDS, s.counts);
  html += groupBlock('Magic & trusts', MAGIC_FIELDS, s.counts);
  const z = s.counts.zones, mp = s.counts.meritpoints, ml = s.counts.masterlevels, jp = s.counts.jobpoints;
  if (z) html += countRow('Zones visited', z);
  if (mp) html += countRow('Merit Points', mp);
  if (ml) html += countRow('Master Levels (total)', ml);
  if (jp) html += countRow('Job Points', jp);
  if (s.scalars.playtime != null) html += '<p class="meta-line">Playtime: ' + fmt(s.scalars.playtime) + ' hours &middot; Highest Master Level: ' + (s.scalars.masterlevels_highest != null ? s.scalars.masterlevels_highest : '?') + '</p>';
  html += '</details></section>';
  return html;
}

function renderMatrix(rows) {
  const el = document.getElementById('matrix-list');
  if (!el) return;
  el.innerHTML = MILESTONES.map((m) => {
    const spans = rows.map((r) => {
      // Milestones read the merged player so a synced value counts the
      // same way the card and the score do.
      const p = r.effective || r.player;
      const v = milestoneValue(p, r.sync, m.check);
      if (v === true) return '<span class="has">\u2713 ' + esc(r.player.name) + '</span>';
      if (v === false) {
        const prog = milestoneProgress(p, r.sync, m);
        if (prog) return '<span class="prog">' + esc(r.player.name) + ' \u00b7 ' + fmt(prog.have) + '/' + fmt(prog.need) + '</span>';
        return '<span class="no">' + esc(r.player.name) + ' \u00b7 \u2014</span>';
      }
      return '<span class="unknown">' + esc(r.player.name) + ' \u00b7 ?</span>';
    }).join('');
    return '<article class="ms-card"><h4>' + esc(m.label) + '</h4><div class="ms-players">' + spans + '</div></article>';
  }).join('');
}

function setStatus(text, kind) {
  const el = document.getElementById('sync-status');
  if (el) { el.textContent = text; el.className = 'sync-status ' + (kind || ''); }
}

// Combined linkshell totals: every player's points added together.
function linkshellTotals(rows) {
  const totals = { jobs: 0, masterLevels: 0, crafts: 0, rema: 0, titles: 0, checklist: 0, total: 0, players: rows.length, synced: 0, titlesCompleted: 0 };
  for (const r of rows) {
    const s = r.scores;
    totals.jobs += s.jobs;
    totals.masterLevels += s.masterLevels;
    totals.crafts += s.crafts;
    totals.rema += s.rema;
    totals.titles += s.titles;
    totals.checklist += s.checklist;
    totals.total += s.total;
    if (r.sync) {
      totals.synced++;
      totals.titlesCompleted += r.sync.titles.completed;
    }
  }
  return totals;
}

function renderLinkshellTotal(rows) {
  const el = document.getElementById('linkshell-total');
  if (!el) return;
  const t = linkshellTotals(rows);
  let html = '<table class="breakdown">'
    + '<tr><td>Jobs</td><td class="num">' + fmt(t.jobs) + '</td></tr>'
    + '<tr><td>Master Levels</td><td class="num">' + fmt(t.masterLevels) + '</td></tr>'
    + '<tr><td>Crafts</td><td class="num">' + fmt(t.crafts) + '</td></tr>'
    + '<tr><td>Relics</td><td class="num">' + fmt(t.rema) + '</td></tr>'
    + '<tr><td>Titles</td><td class="num">' + fmt(t.titles) + '</td></tr>'
    + '<tr><td>Checklist</td><td class="num">' + fmt(t.checklist) + '</td></tr>'
    + '<tr class="total-row"><td>Combined total</td><td class="num">' + fmt(t.total) + '</td></tr>'
    + '</table>'
    + '<p class="meta-line">' + t.players + ' players &middot; ' + t.synced + ' synced &middot; ' + fmt(t.titlesCompleted) + ' titles &middot; ' + fmt(t.masterLevels) + ' Master Levels</p>';
  html += '<table class="breakdown"><tr><td><b>Player</b></td><td class="num"><b>Points</b></td><td class="num"><b>Share</b></td></tr>';
  for (const r of rows) {
    const pct = t.total > 0 ? (100 * r.scores.total / t.total).toFixed(1) + '%' : '0.0%';
    html += '<tr><td>' + esc(r.player.name) + '</td><td class="num">' + fmt(r.scores.total) + '</td><td class="num">' + pct + '</td></tr>';
  }
  html += '</table>';
  el.innerHTML = html;
}

function renderAll(baseline, liveByName, statusText, statusKind) {
  const rows = computeBoard(baseline.players, liveByName);
  renderLeaderboard(rows);
  const cardsEl = document.getElementById('cards');
  if (cardsEl) cardsEl.innerHTML = rows.map(renderCard).join('');
  renderMatrix(rows);
  renderLinkshellTotal(rows);
  setStatus(statusText, statusKind);
  const updatedEl = document.getElementById('last-updated');
  if (updatedEl) {
    const latest = rows.map((r) => r.sync && r.sync.syncedAt).filter(Boolean).sort().pop();
    updatedEl.textContent = latest ? 'Last sync: ' + shortDateTime(latest) : 'Baseline: ' + esc(baseline.meta.baseline_date);
  }
}

/* ---------------- Boot ---------------- */

function init() {
  return fetch('data/baseline.json')
    .then((res) => { if (!res.ok) throw new Error('baseline.json could not be loaded'); return res.json(); })
    .then((baseline) => {
      document.getElementById('page-title').textContent = baseline.meta.title || 'Checklist Comparison';
      document.getElementById('page-subtitle').textContent = baseline.meta.subtitle || '';
      if (!API_URL) {
        renderAll(baseline, null, 'Sync API not configured — showing baseline data only.', 'warn');
        return baseline;
      }
      return loadLiveWithCache(baseline).then(() => baseline);
    })
    .catch((err) => {
      setStatus('Could not load the page data: ' + err.message, 'error');
    });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scoreJobs, scoreCrafts, scoreRema, scoreTitles, scoreChecklist, scoreMasterLevels,
    normalizeSync, normalizeSyncJobs, normalizeSyncMasterLevels, normalizeSyncCrafts, normalizeSyncRema,
    effectiveJobs, effectiveCrafts, effectiveRema, scorePlayer, computeBoard, badgeFor, sumFields,
    loadLiveData, loadLiveDataWithRetry, loadLiveWithCache,
    saveLiveCache, loadLiveCache, cachedStatusText, API_TIMEOUT_MS, CACHE_KEY,
    shortDateTime, renderLeaderboard, renderCard, renderMatrix, linkshellTotals, renderLinkshellTotal,
    milestoneProgress,
    MILESTONES, MISSION_FIELDS, QUEST_FIELDS, WARP_FIELDS, KEY_ITEM_FIELDS,
    TITLE_RATES, CHECK_RATES, ML_RATE,
  };
}

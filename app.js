'use strict';

/* =====================================================================
   FFXI Achievement Compare — standalone site
   - Baseline data (FFXIAH, 2026-11-15) lives in data/baseline.json.
   - Live XIchecklist syncs come from the Google Apps Script web app
     below, which reads the "FFXI Achievement Sync" Google Form,
     checks each submission's key privately, and serves clean JSON.
   - The Apps Script CANNOT be fetched with plain fetch(): it sends no
     CORS headers, so browsers block the response. The working pattern
     is JSONP (a <script> tag with a ?callback= parameter), which is
     what loadLiveData() below does. If the script can't be reached,
     the page falls back to the baseline and says so — it never breaks.
   ===================================================================== */

// Paste the Apps Script web app /exec URL here after deploying.
// Leave it empty to run on baseline data only.
const API_URL = 'https://script.google.com/macros/s/AKfycbwgEpK90nzPaQQrJsY4dfiTFZsdidzV_l5orx8k08-E_I0KJCx1t2V-Cy17zJ4_CRvgEw/exec';
const API_TIMEOUT_MS = 12000;

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

// Master Levels: 1 point each. A live sync's masterlevels count is
// authoritative (it covers all 22 jobs); otherwise sum the baseline
// per-job ML figures from FFXIAH, skipping jobs whose ML is unknown.
function scoreMasterLevels(player, sync) {
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
function scorePlayer(player, livePayload) {
  const sync = livePayload ? normalizeSync(livePayload) : null;
  const jobs = scoreJobs(player);
  const masterLevels = scoreMasterLevels(player, sync);
  const crafts = scoreCrafts(player);
  const rema = scoreRema(player);
  const titles = scoreTitles(sync);
  const checklist = scoreChecklist(sync);
  return {
    player,
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

const MILESTONES = [
  { id: 'all99', label: 'All 22 jobs at 99', check: (p) => p.jobs ? Object.values(p.jobs).every((j) => j.level >= 99) : null },
  { id: 'rank10', label: 'Nation Rank 10', check: (p) => p.nationRank == null ? null : p.nationRank >= 10 },
  { id: 'mr7', label: 'Mastery Rank 7+', check: (p, s) => { const v = p.masteryRank != null ? p.masteryRank : (s && s.scalars.mastery_rank); return v == null ? null : v >= 7; } },
  { id: 'mr8', label: 'Mastery Rank 8', check: (p, s) => { const v = p.masteryRank != null ? p.masteryRank : (s && s.scalars.mastery_rank); return v == null ? null : v >= 8; } },
  { id: 'craft110', label: 'A craft at 110', check: (p) => p.crafts ? Object.values(p.crafts).some((v) => v >= 110) : null },
  { id: 'fish110', label: 'Fishing 110', check: (p) => p.crafts ? (p.crafts.Fishing || 0) >= 110 : null },
  { id: 'craft90', label: 'A craft at 90+', check: (p) => p.crafts ? Object.values(p.crafts).some((v) => v >= 90) : null },
  { id: 't100', label: '100+ titles', check: (p, s) => s ? s.titles.completed >= 100 : null },
  { id: 't250', label: '250+ titles', check: (p, s) => s ? s.titles.completed >= 250 : null },
  { id: 't500', label: '500+ titles', check: (p, s) => s ? s.titles.completed >= 500 : null },
  { id: 't750', label: '750+ titles', check: (p, s) => s ? s.titles.completed >= 750 : null },
  { id: 't1000', label: '1,000+ titles', check: (p, s) => s ? s.titles.completed >= 1000 : null },
  { id: 'ult10', label: '10+ ultimates', check: (p) => p.rema ? p.rema.length >= 10 : null },
  { id: 'ult25', label: '25+ ultimates', check: (p) => p.rema ? p.rema.length >= 25 : null },
  { id: 'ult40', label: '40+ ultimates', check: (p) => p.rema ? p.rema.length >= 40 : null },
  { id: 'rema119', label: 'A 119 REMA weapon', check: (p) => p.rema ? p.rema.some((r) => r.kind === 'rema' && r.stage === 119) : null },
  { id: 'lushang', label: 'Lu Shang\u2019s Fishing Rod', check: (p) => p.rema ? p.rema.some((r) => r.name.indexOf('Lu Shang') === 0) : null },
  { id: 'merits', label: 'Merit Points capped', check: (p, s) => { if (!s) return null; const m = s.counts.meritpoints; return m && m.total > 0 ? m.completed >= m.total : null; } },
  { id: 'roe400', label: 'RoE 400+', check: (p, s) => s ? s.roe.completed >= 400 : null },
  { id: 'mis500', label: 'Missions 500+', check: (p, s) => s ? s.missions.completed >= 500 : null },
  { id: 'que400', label: 'Quests 400+', check: (p, s) => s ? s.quests.completed >= 400 : null },
  { id: 'warp300', label: 'Warps 300+', check: (p, s) => s ? s.warps.completed >= 300 : null },
  { id: 'zone250', label: 'Zones 250+', check: (p, s) => { if (!s) return null; const z = s.counts.zones; return z ? z.completed >= 250 : null; } },
  { id: 'play2000', label: 'Playtime 2,000+ hrs', check: (p, s) => s && s.scalars.playtime != null ? s.scalars.playtime >= 2000 : null },
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
  const el = document.getElementById('leaderboard-body');
  if (!el) return;
  el.innerHTML = rows.map((r) => {
    const s = r.scores;
    return '<tr class="rank-' + r.rank + '">'
      + '<td class="rank">#' + r.rank + '</td>'
      + '<td><a href="#card-' + esc(r.player.id) + '" class="name-link">' + esc(r.player.name) + '</a></td>'
      + '<td class="num total">' + fmt(s.total) + '</td>'
      + '<td class="num">' + fmt(s.jobs) + '</td>'
      + '<td class="num">' + fmt(s.crafts) + '</td>'
      + '<td class="num">' + fmt(s.rema) + '</td>'
      + '<td class="num">' + fmt(s.titles) + '</td>'
      + '<td class="num">' + fmt(s.checklist) + '</td>'
      + '<td>' + (r.sync ? '<span class="pill synced">Synced ' + esc(shortDate(r.sync.syncedAt)) + '</span>' : '<span class="pill not-synced">Not synced yet</span>') + '</td>'
      + '</tr>';
  }).join('');
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderCard(row) {
  const p = row.player, s = row.sync, sc = row.scores;
  const badge = s ? badgeFor(s.titles.completed) : { earned: null, next: BADGE_TIERS[0] };
  let html = '<article class="card" id="card-' + esc(p.id) + '">'
    + '<header class="card-head"><div><h3>' + esc(p.name) + '</h3>'
    + '<div class="sub">' + esc(p.server || '') + (p.nation ? ' &middot; ' + esc(p.nation) + (p.nationRank != null ? ' Rank ' + p.nationRank : '') : '') + '</div></div>'
    + '<div class="card-total"><span class="rank-badge">#' + row.rank + '</span><b>' + fmt(sc.total) + '</b><span>points</span></div></header>'
    + '<div class="breakdown">'
    + '<div><span>Jobs</span><b>' + fmt(sc.jobs) + '</b></div>'
    + '<div><span>Master Levels</span><b>' + fmt(sc.masterLevels) + '</b></div>'
    + '<div><span>Crafts</span><b>' + fmt(sc.crafts) + '</b></div>'
    + '<div><span>Relics</span><b>' + fmt(sc.rema) + '</b></div>'
    + '<div><span>Titles</span><b>' + fmt(sc.titles) + '</b></div>'
    + '<div><span>Checklist</span><b>' + fmt(sc.checklist) + '</b></div>'
    + '</div>';
  if (p.title) html += '<p class="flavor">\u201c' + esc(p.title) + '\u201d</p>';
  if (p.linkshells && p.linkshells.length) html += '<p class="linkshells">Linkshells: ' + p.linkshells.map(esc).join(', ') + '</p>';
  if (p.masteryRank != null) html += '<p class="meta-line">Mastery Rank ' + p.masteryRank + '</p>';

  html += '<div class="card-detail">';
  html += renderJobs(p);
  html += renderCrafts(p);
  html += renderRema(p);
  html += renderSync(s);
  html += '</div></article>';
  return html;
}

function renderJobs(p) {
  if (!p.jobs) return '<section class="detail-section"><h4>Jobs</h4><p class="na">Not available — FFXIAH page is empty or private.</p></section>';
  const order = ['WAR', 'MNK', 'WHM', 'BLM', 'RDM', 'THF', 'PLD', 'DRK', 'BST', 'BRD', 'RNG', 'SAM', 'NIN', 'DRG', 'SMN', 'BLU', 'COR', 'PUP', 'DNC', 'SCH', 'GEO', 'RUN'];
  const tiles = order.map((abbr) => {
    const j = p.jobs[abbr];
    if (!j) return '';
    return '<div class="job-tile"><span class="job-abbr">' + abbr + '</span><b>' + j.level + '</b>' + (j.ml != null ? '<span class="ml">ML ' + j.ml + '</span>' : '<span class="ml na">ML ?</span>') + '</div>';
  }).join('');
  return '<section class="detail-section"><h4>Jobs — all 22 at 99</h4><div class="job-grid">' + tiles + '</div></section>';
}

function renderCrafts(p) {
  if (!p.crafts) return '<section class="detail-section"><h4>Crafts</h4><p class="na">Not available — FFXIAH page is empty or private.</p></section>';
  const rows = Object.entries(p.crafts).map(([name, lvl]) => countRow(name, { completed: lvl, total: 110 })).join('');
  return '<section class="detail-section"><h4>Crafts</h4>' + rows + '</section>';
}

function renderRema(p) {
  if (!p.rema) return '<section class="detail-section"><h4>Ultimates (REMA)</h4><p class="na">Not available — FFXIAH page is empty or private.</p></section>';
  const at119 = p.rema.filter((r) => r.kind === 'rema' && r.stage === 119);
  const other = p.rema.filter((r) => r.kind === 'rema' && r.stage !== 119);
  const extras = p.rema.filter((r) => r.kind !== 'rema');
  const li = (r) => '<li>' + esc(r.name) + (r.stage ? ' <span class="stage">' + r.stage + '</span>' : '') + '</li>';
  return '<section class="detail-section"><h4>Ultimates (' + p.rema.length + ')</h4>'
    + '<h5>119 (' + at119.length + ')</h5><ul class="rema-list">' + at119.map(li).join('') + '</ul>'
    + (other.length ? '<h5>Below 119 (' + other.length + ')</h5><ul class="rema-list">' + other.map(li).join('') + '</ul>' : '')
    + (extras.length ? '<h5>Extras</h5><ul class="rema-list">' + extras.map(li).join('') + '</ul>' : '')
    + '</section>';
}

function renderSync(s) {
  if (!s) {
    return '<section class="detail-section sync-section"><h4>Checklist sync</h4>'
      + '<p class="na">Not synced yet — install the XIchecklist autosync fork and zone once, and titles, Records of Eminence, missions, quests and warps will fill in here automatically.</p></section>';
  }
  const badge = badgeFor(s.titles.completed);
  let html = '<section class="detail-section sync-section"><h4>Checklist sync <span class="pill synced">Synced ' + esc(shortDate(s.syncedAt)) + '</span></h4>';
  html += '<div class="badge-line">' + (badge.earned
    ? '<span class="badge earned">' + esc(badge.earned.name) + ' — ' + badge.earned.at + ' titles</span>'
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
  html += groupBlock('Magic &amp; trusts', MAGIC_FIELDS, s.counts);
  const z = s.counts.zones, mp = s.counts.meritpoints, ml = s.counts.masterlevels, jp = s.counts.jobpoints;
  if (z) html += countRow('Zones visited', z);
  if (mp) html += countRow('Merit Points', mp);
  if (ml) html += countRow('Master Levels (total)', ml);
  if (jp) html += countRow('Job Points', jp);
  if (s.scalars.playtime != null) html += '<p class="meta-line">Playtime: ' + fmt(s.scalars.playtime) + ' hours &middot; Highest Master Level: ' + (s.scalars.masterlevels_highest != null ? s.scalars.masterlevels_highest : '?') + '</p>';
  html += '</section>';
  return html;
}

function renderMatrix(rows) {
  const el = document.getElementById('matrix-body');
  if (!el) return;
  const head = document.getElementById('matrix-head');
  if (head) {
    head.innerHTML = '<th>Milestone</th>' + rows.map((r) => '<th>' + esc(r.player.name) + '</th>').join('');
  }
  el.innerHTML = MILESTONES.map((m) => {
    const cells = rows.map((r) => {
      const v = milestoneValue(r.player, r.sync, m.check);
      return '<td class="' + (v === true ? 'yes' : v === false ? 'no' : 'unknown') + '">' + (v === true ? '\u2713' : v === false ? '\u2014' : '?') + '</td>';
    }).join('');
    return '<tr><td class="ms-label">' + esc(m.label) + '</td>' + cells + '</tr>';
  }).join('');
}

function setStatus(text, kind) {
  const el = document.getElementById('sync-status');
  if (el) { el.textContent = text; el.className = 'sync-status ' + (kind || ''); }
}

function renderAll(baseline, liveByName, statusText, statusKind) {
  const rows = computeBoard(baseline.players, liveByName);
  renderLeaderboard(rows);
  const cardsEl = document.getElementById('cards');
  if (cardsEl) cardsEl.innerHTML = rows.map(renderCard).join('');
  renderMatrix(rows);
  setStatus(statusText, statusKind);
  const updatedEl = document.getElementById('last-updated');
  if (updatedEl) {
    const latest = rows.map((r) => r.sync && r.sync.syncedAt).filter(Boolean).sort().pop();
    updatedEl.textContent = latest ? 'Last sync: ' + shortDate(latest) : 'Baseline: ' + esc(baseline.meta.baseline_date);
  }
}

/* ---------------- Boot ---------------- */

function init() {
  return fetch('data/baseline.json')
    .then((res) => { if (!res.ok) throw new Error('baseline.json could not be loaded'); return res.json(); })
    .then((baseline) => {
      document.getElementById('page-title').textContent = baseline.meta.title || 'FFXI Achievement Compare';
      document.getElementById('page-subtitle').textContent = baseline.meta.subtitle || '';
      if (!API_URL) {
        renderAll(baseline, null, 'Sync API not configured — showing baseline data only.', 'warn');
        return baseline;
      }
      renderAll(baseline, null, 'Loading live sync data\u2026', '');
      return loadLiveData(API_URL)
        .then((data) => {
          const live = data && data.players ? data.players : {};
          const n = Object.keys(live).length;
          renderAll(baseline, live, n ? 'Live sync data loaded (' + n + ' player' + (n === 1 ? '' : 's') + ').' : 'Sync API answered but returned no players — showing baseline data.', n ? 'ok' : 'warn');
          return baseline;
        })
        .catch((err) => {
          renderAll(baseline, null, 'Sync data unavailable (' + err.message + ') — showing baseline data.', 'warn');
          return baseline;
        });
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
    normalizeSync, scorePlayer, computeBoard, badgeFor, sumFields,
    loadLiveData,
    MILESTONES, MISSION_FIELDS, QUEST_FIELDS, WARP_FIELDS, KEY_ITEM_FIELDS,
    TITLE_RATES, CHECK_RATES, ML_RATE,
  };
}

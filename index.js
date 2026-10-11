// ============================================================================
//  EBUTUOY :: backend
// ============================================================================
//  An anti-popularity YouTube discovery engine.
//
//  Endpoints:
//    GET  /health             service status check
//    GET  /seen               every video_id served (paginated count)
//    POST /seen               record a video as served
//    GET  /search             discover obscure videos
//    POST /tag                attach tags to a video
//    GET  /revisit-eligible   videos due for replay
//    POST /revisit-played     mark a revisit as just-played
//    GET  /tag-counts, /playlist, /clip-lists, /clips, POST /clip
//                             dormant: the current frontend no longer calls
//                             them, kept so saved data stays reachable
//
//  Language filter:
//    /search drops videos whose defaultAudioLanguage is set to anything
//    other than English (en, en-US, en-GB, etc). Videos with no language
//    field set are allowed through (small creators often don't tag), and
//    a script-based check rejects titles dominated by non-Latin scripts.
//
//  Playability filter (bug hunt revision):
//    /search only returns videos that can play inside our embed: public,
//    processed, embeddable, not live or upcoming, not age restricted, and
//    not region blocked for the US. Before this, those slipped through and
//    sat on a "video unavailable" screen for the full 30 seconds.
//
//  Storage:
//    The SQLite file lives on the Railway volume when one is attached.
//    Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically for a service with
//    a volume. Without a volume the file sits next to this script and gets
//    wiped on every redeploy, which is what was happening before.
//
// ----------------------------------------------------------------------------
//  Authorship log (most recent first):
//    [ORANGE]  bug hunt: playability filter, fail-closed sub lookup,
//              pagination, quota tracking, volume-aware storage, atomic save
//    [ORANGE]  add English-preferred language filter to /search
//    [ORANGE]  add tag system + revisit queue with 24hr/100vid eligibility
//    [ORANGE]  add roulette mode (random global geo), expand /search
//    [ORANGE]  initial scaffold + search pipeline
// ----------------------------------------------------------------------------

const express   = require('express');
const cors      = require('cors');
const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Where the database file lives. Railway volume first, then an explicit
// override, then next to this script (local dev only, not persistent).
// /data is checked too, in case a volume is mounted there without the env var.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || process.env.DATA_DIR
  || (fs.existsSync('/data') ? '/data' : __dirname);
const DB_PATH  = path.join(DATA_DIR, 'ebutuoy.db');

const YT_KEY                   = process.env.YOUTUBE_API_KEY;
const MAX_VIEWS                = 1000;
const MAX_SUBS                 = 1000;
const FETCH_N                  = 50;
const REVISIT_MIN_HOURS        = 24;
const REVISIT_MIN_VIDEOS_SEEN  = 100;
const VIEWER_REGION            = 'US';    // used for the region block check

// ===== YOUTUBE QUOTA TRACKING ==============================================
// YouTube gives 10,000 units per day, reset at midnight Pacific time.
// search costs 100, videos and channels cost 1 each. This counter is an
// estimate kept in memory, so it resets if the server restarts. It is shown
// on /health so you can see how much of the day is left.
const DAILY_QUOTA = 10000;
const quota = { day: null, used: 0 };

function pacificDay() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
}

function spendQuota(units) {
  const today = pacificDay();
  if (quota.day !== today) { quota.day = today; quota.used = 0; }
  quota.used += units;
}

// ytGet(url, cost)
// One place for every YouTube API call. Counts quota, parses JSON, and
// turns a YouTube error into a thrown Error. Quota errors get a flag so the
// route can answer 429 and the frontend can show a clear message.
async function ytGet(url, cost) {
  spendQuota(cost);
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) {
    const reason = data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    const err = new Error(data.error.message || 'youtube error');
    err.quota = reason === 'quotaExceeded' || reason === 'dailyLimitExceeded';
    throw err;
  }
  return data;
}

let db;

async function initDb() {
  const SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = null;
  if (fs.existsSync(DB_PATH)) {
    try {
      db = new SQL.Database(fs.readFileSync(DB_PATH));
    } catch (err) {
      // A damaged file should not take the whole service down. Keep the bad
      // file aside for inspection and start fresh.
      console.error('db file unreadable, starting fresh:', err.message);
      fs.renameSync(DB_PATH, DB_PATH + '.broken-' + Date.now());
    }
  }
  if (!db) db = new SQL.Database();
  console.log('database at ' + DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS seen_videos (
    video_id TEXT PRIMARY KEY,
    seen_at  INTEGER NOT NULL,
    title    TEXT,
    channel  TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tag_actions (
    video_id   TEXT NOT NULL,
    tag        TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    title      TEXT,
    channel    TEXT,
    PRIMARY KEY (video_id, tag, applied_at)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS revisit_queue (
    video_id           TEXT PRIMARY KEY,
    title              TEXT,
    channel            TEXT,
    tagged_at          INTEGER NOT NULL,
    videos_seen_at_tag INTEGER NOT NULL,
    last_replayed_at   INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS clips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   TEXT NOT NULL,
    title      TEXT,
    channel    TEXT,
    start_sec  INTEGER NOT NULL,
    end_sec    INTEGER NOT NULL,
    clip_list  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  saveDb();
}

// saveDb()
// Writes to a temp file first, then renames over the real one. A rename is
// all-or-nothing, so a crash mid-write can never leave a half-written db.
function saveDb() {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_PATH);
}

function getSeenSet() {
  const stmt = db.prepare('SELECT video_id FROM seen_videos');
  const set  = new Set();
  while (stmt.step()) set.add(stmt.getAsObject().video_id);
  stmt.free();
  return set;
}

function getSeenCount() {
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM seen_videos');
  stmt.step();
  const c = stmt.getAsObject().c;
  stmt.free();
  return c;
}

function randomLand() {
  const regions = [
    [25,  50,  -125, -70],
    [-40, 10,  -80,  -40],
    [36,  60,  -10,  40],
    [-30, 35,  -15,  45],
    [10,  40,  35,   90],
    [20,  45,  100,  145],
    [-40, 20,  95,   155],
  ];
  const r = regions[Math.floor(Math.random() * regions.length)];
  return {
    lat: Number((r[0] + Math.random() * (r[1] - r[0])).toFixed(4)),
    lng: Number((r[2] + Math.random() * (r[3] - r[2])).toFixed(4))
  };
}

// ===== LANGUAGE FILTER =====================================================

// isLikelyEnglish(video)
// Returns true if the video is plausibly English content, false if it
// looks foreign-language.
//
// Strategy (in priority order):
//   1. If defaultAudioLanguage starts with "en", trust it absolutely.
//   2. If defaultAudioLanguage is set to a non-en language, reject.
//   3. If defaultAudioLanguage is missing/null, scan the title for
//      dominant non-Latin script characters. If more than 30% of the
//      non-whitespace title is in CJK, Cyrillic, Arabic, Devanagari,
//      Thai, Hangul, Hebrew, etc, reject. Otherwise allow.
//
// The 30% threshold lets occasional emoji or foreign words in an
// otherwise-English title through (e.g. an English title with a Japanese
// place name in it).
function isLikelyEnglish(video) {
  const langField = video.snippet?.defaultAudioLanguage || video.snippet?.defaultLanguage;
  if (langField) {
    return langField.toLowerCase().startsWith('en');
  }
  const title = video.snippet?.title || '';
  if (!title) return true;   // no title to judge, allow

  // Count non-Latin script characters in the title.
  // We're looking for code-point ranges that are clearly non-Latin.
  const nonLatinRanges = [
    [0x0400, 0x04FF],   // Cyrillic
    [0x0500, 0x052F],   // Cyrillic supplement
    [0x0600, 0x06FF],   // Arabic
    [0x0700, 0x074F],   // Syriac
    [0x0900, 0x097F],   // Devanagari
    [0x0E00, 0x0E7F],   // Thai
    [0x3040, 0x309F],   // Hiragana
    [0x30A0, 0x30FF],   // Katakana
    [0x3400, 0x4DBF],   // CJK Extension A
    [0x4E00, 0x9FFF],   // CJK Unified Ideographs
    [0xAC00, 0xD7AF],   // Hangul syllables
    [0x0590, 0x05FF],   // Hebrew
  ];
  let nonLatin = 0;
  let total    = 0;
  for (const ch of title) {
    const cp = ch.codePointAt(0);
    // skip whitespace and basic punctuation
    if (cp <= 0x20 || (cp >= 0x21 && cp <= 0x2F) || (cp >= 0x3A && cp <= 0x40)) continue;
    total++;
    for (const [lo, hi] of nonLatinRanges) {
      if (cp >= lo && cp <= hi) { nonLatin++; break; }
    }
  }
  if (total === 0) return true;
  const ratio = nonLatin / total;
  return ratio < 0.30;
}

// ===== PLAYABILITY FILTER ==================================================

// isPlayableInEmbed(video)
// True only if the video will play inside our embedded player.
// Needs the "status" part on the /videos call.
function isPlayableInEmbed(video) {
  const st = video.status || {};
  if (st.embeddable !== true)          return false;   // uploader blocked embedding
  if (st.privacyStatus !== 'public')   return false;
  if (st.uploadStatus && st.uploadStatus !== 'processed') return false;

  // live streams and upcoming premieres have no normal playback yet
  const live = video.snippet && video.snippet.liveBroadcastContent;
  if (live && live !== 'none') return false;

  const cd = video.contentDetails || {};
  // age restricted videos refuse to play in embeds
  if (cd.contentRating && cd.contentRating.ytRating === 'ytAgeRestricted') return false;

  // region block: either explicitly blocked here, or an allow list without us
  const rr = cd.regionRestriction;
  if (rr) {
    if (Array.isArray(rr.blocked) && rr.blocked.includes(VIEWER_REGION)) return false;
    if (Array.isArray(rr.allowed) && !rr.allowed.includes(VIEWER_REGION)) return false;
  }
  return true;
}

// ===== ROUTES ===============================================================

app.get('/health', (req, res) => {
  spendQuota(0);   // rolls the counter over at midnight Pacific
  res.json({
    status:     'ok',
    service:    'ebutuoy',
    has_key:    !!YT_KEY,
    persistent: DATA_DIR !== __dirname,
    db_path:    DB_PATH,
    quota_used_today_estimate: quota.used,
    quota_daily_limit:         DAILY_QUOTA
  });
});

app.get('/seen', (req, res) => {
  const ids = Array.from(getSeenSet());
  res.json({ count: ids.length, video_ids: ids });
});

app.post('/seen', (req, res) => {
  const { video_id, title, channel } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  db.run(
    'INSERT OR IGNORE INTO seen_videos (video_id, seen_at, title, channel) VALUES (?, ?, ?, ?)',
    [video_id, Date.now(), title || null, channel || null]
  );
  saveDb();
  res.json({ ok: true });
});

app.post('/tag', (req, res) => {
  const { video_id, tags, title, channel } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'tags array required' });
  }
  const now          = Date.now();
  const seenSnapshot = getSeenCount();

  for (const rawTag of tags) {
    const tag = String(rawTag).trim().toLowerCase();
    if (!tag) continue;
    db.run(
      'INSERT OR IGNORE INTO tag_actions (video_id, tag, applied_at, title, channel) VALUES (?, ?, ?, ?, ?)',
      [video_id, tag, now, title || null, channel || null]
    );
    if (tag === 'revisit') {
      const existing = db.prepare('SELECT video_id FROM revisit_queue WHERE video_id = ?');
      existing.bind([video_id]);
      const exists = existing.step();
      existing.free();
      if (exists) {
        db.run(
          'UPDATE revisit_queue SET tagged_at = ?, videos_seen_at_tag = ? WHERE video_id = ?',
          [now, seenSnapshot, video_id]
        );
      } else {
        db.run(
          'INSERT INTO revisit_queue (video_id, title, channel, tagged_at, videos_seen_at_tag) VALUES (?, ?, ?, ?, ?)',
          [video_id, title || null, channel || null, now, seenSnapshot]
        );
      }
    }
  }
  saveDb();
  res.json({ ok: true });
});

app.get('/revisit-eligible', (req, res) => {
  const now          = Date.now();
  const minTagAge    = REVISIT_MIN_HOURS * 60 * 60 * 1000;
  const seenCount    = getSeenCount();
  const stmt = db.prepare(`
    SELECT video_id, title, channel, tagged_at, videos_seen_at_tag, last_replayed_at
    FROM revisit_queue
    WHERE (? - tagged_at) >= ?
      AND (? - videos_seen_at_tag) >= ?
    ORDER BY tagged_at ASC
  `);
  stmt.bind([now, minTagAge, seenCount, REVISIT_MIN_VIDEOS_SEEN]);
  const eligible = [];
  while (stmt.step()) eligible.push(stmt.getAsObject());
  stmt.free();
  res.json({
    eligible,
    count:          eligible.length,
    now_seen_count: seenCount,
    eligibility_rule: {
      min_hours_since_tag:       REVISIT_MIN_HOURS,
      min_videos_seen_since_tag: REVISIT_MIN_VIDEOS_SEEN
    }
  });
});

app.post('/revisit-played', (req, res) => {
  const { video_id } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  const now       = Date.now();
  const seenCount = getSeenCount();
  db.run(
    'UPDATE revisit_queue SET last_replayed_at = ?, tagged_at = ?, videos_seen_at_tag = ? WHERE video_id = ?',
    [now, now, seenCount, video_id]
  );
  saveDb();
  res.json({ ok: true });
});

// GET /search
// Query params (combine freely):
//   q          topic search string
//   lat,lng    geographic centre point
//   radius     search radius, default 50km
//   random     "true" for Roulette (server picks a random spot)
//   pageToken  token from a previous response, to get the NEXT page of the
//              same search instead of the same 50 results again
//
// Pipeline: search (100 units) -> videos (1) -> channels (1) -> filters.
// Filters, in order: seen log, playability, language, popularity.
// Response always carries next_page_token (null when there are no more
// pages) so the frontend can keep Topic and Local mode fresh.
app.get('/search', async (req, res) => {
  if (!YT_KEY) return res.status(500).json({ error: 'no api key configured on server' });
  let { q, lat, lng, radius, pageToken } = req.query;
  const wantRandom = req.query.random === 'true';

  let chosenLocation = null;
  if (wantRandom) {
    const pick = randomLand();
    lat = String(pick.lat); lng = String(pick.lng); chosenLocation = pick;
    pageToken = null;   // a page token from another spot means nothing here
  }
  if (!q && (!lat || !lng)) {
    const pick = randomLand();
    lat = String(pick.lat); lng = String(pick.lng); chosenLocation = pick;
    pageToken = null;
  }

  // helper so every early return has the same shape
  const reply = (extra) => res.json(Object.assign({
    videos: [], location: chosenLocation, next_page_token: null
  }, extra));

  try {
    // ---- step 1: candidates ---------------------------------------------
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part',           'snippet');
    searchUrl.searchParams.set('type',           'video');
    searchUrl.searchParams.set('maxResults',     String(FETCH_N));
    searchUrl.searchParams.set('order',          'date');
    searchUrl.searchParams.set('videoEmbeddable', 'true');   // free pre-filter
    searchUrl.searchParams.set('key',            YT_KEY);
    if (q) searchUrl.searchParams.set('q', q);
    if (lat && lng) {
      searchUrl.searchParams.set('location',       `${lat},${lng}`);
      searchUrl.searchParams.set('locationRadius', radius || '50km');
    }
    if (pageToken) searchUrl.searchParams.set('pageToken', String(pageToken));

    const searchData = await ytGet(searchUrl, 100);
    const nextToken  = searchData.nextPageToken || null;

    const videoIds = (searchData.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
    if (videoIds.length === 0) return reply({ next_page_token: nextToken, fetched: 0 });

    // ---- step 2: drop anything already seen ------------------------------
    const seen     = getSeenSet();
    const freshIds = videoIds.filter(id => !seen.has(id));
    if (freshIds.length === 0) return reply({ next_page_token: nextToken, fetched: videoIds.length, after_seen_filter: 0 });

    // ---- step 3: full details, including status for the playability check
    const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    videoUrl.searchParams.set('part', 'snippet,statistics,contentDetails,status');
    videoUrl.searchParams.set('id',   freshIds.join(','));
    videoUrl.searchParams.set('key',  YT_KEY);
    const videoData = await ytGet(videoUrl, 1);

    const playable      = (videoData.items || []).filter(isPlayableInEmbed);
    const englishVideos = playable.filter(isLikelyEnglish);

    if (englishVideos.length === 0) {
      return reply({
        next_page_token:         nextToken,
        fetched:                 videoIds.length,
        after_seen_filter:       freshIds.length,
        after_playable_filter:   playable.length,
        after_language_filter:   0,
        after_popularity_filter: 0
      });
    }

    // ---- step 4: subscriber counts -----------------------------------------
    // Fail closed: before this revision a failed lookup made every channel
    // read as zero subs, which let popular channels straight through.
    const channelIds = [...new Set(englishVideos.map(v => v.snippet.channelId))];
    const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelUrl.searchParams.set('part', 'statistics');
    channelUrl.searchParams.set('id',   channelIds.join(','));
    channelUrl.searchParams.set('key',  YT_KEY);
    const channelData = await ytGet(channelUrl, 1);

    // subsByChannel[id] = number, or null when the channel hides its count
    const subsByChannel = {};
    (channelData.items || []).forEach(c => {
      const s = c.statistics || {};
      subsByChannel[c.id] = s.hiddenSubscriberCount ? null : parseInt(s.subscriberCount || '0', 10);
    });

    // ---- step 5: popularity filter ------------------------------------------
    // A channel missing from the lookup is rejected (fail closed).
    // A hidden sub count cannot be judged, so only the view cap applies.
    const filtered = englishVideos
      .filter(v => {
        const chId = v.snippet.channelId;
        if (!(chId in subsByChannel)) return false;
        const views = parseInt((v.statistics && v.statistics.viewCount) || '0', 10);
        const subs  = subsByChannel[chId];
        if (views >= MAX_VIEWS) return false;
        if (subs !== null && subs >= MAX_SUBS) return false;
        return true;
      })
      .map(v => ({
        id:         v.id,
        title:      v.snippet.title,
        channel:    v.snippet.channelTitle,
        channel_id: v.snippet.channelId,
        published:  v.snippet.publishedAt,
        duration:   v.contentDetails.duration,
        views:      parseInt((v.statistics && v.statistics.viewCount) || '0', 10),
        subs:       subsByChannel[v.snippet.channelId] === null ? 'hidden' : subsByChannel[v.snippet.channelId],
        thumbnail:  v.snippet.thumbnails && v.snippet.thumbnails.medium && v.snippet.thumbnails.medium.url,
        lang:       v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || null
      }));

    reply({
      videos:                  filtered,
      next_page_token:         nextToken,
      fetched:                 videoIds.length,
      after_seen_filter:       freshIds.length,
      after_playable_filter:   playable.length,
      after_language_filter:   englishVideos.length,
      after_popularity_filter: filtered.length
    });

  } catch (err) {
    if (err.quota) return res.status(429).json({ error: 'quota_exceeded', message: 'YouTube daily quota used up. Resets at midnight Pacific.' });
    res.status(502).json({ error: err.message });
  }
});

// GET /tag-counts
// Returns every tag with the count of distinct videos tagged with it.
app.get('/tag-counts', (req, res) => {
  const stmt = db.prepare('SELECT tag, COUNT(DISTINCT video_id) AS count FROM tag_actions GROUP BY tag ORDER BY count DESC');
  const tags = [];
  while (stmt.step()) tags.push(stmt.getAsObject());
  stmt.free();
  res.json({ tags });
});

// GET /playlist?tag=X
// Returns all videos tagged with the given tag, newest tag-time first.
app.get('/playlist', (req, res) => {
  const tag = (req.query.tag || '').trim().toLowerCase();
  if (!tag) return res.status(400).json({ error: 'tag param required' });
  const stmt = db.prepare('SELECT DISTINCT video_id, title, channel, MAX(applied_at) AS tagged_at FROM tag_actions WHERE tag = ? GROUP BY video_id ORDER BY tagged_at DESC');
  stmt.bind([tag]);
  const videos = [];
  while (stmt.step()) videos.push(stmt.getAsObject());
  stmt.free();
  res.json({ tag, count: videos.length, videos });
});


// GET /clip-lists
// Returns every clip-list label with a count of clips filed under it.
// Used to show counts in the wheel or a future clip playback menu.
app.get('/clip-lists', (req, res) => {
  const stmt = db.prepare('SELECT clip_list, COUNT(*) AS count FROM clips GROUP BY clip_list ORDER BY count DESC');
  const lists = [];
  while (stmt.step()) lists.push(stmt.getAsObject());
  stmt.free();
  res.json({ lists });
});

// GET /clips?list=X
// Returns all clips in a given clip-list, or all clips if no list given.
// Each clip has the video_id plus start_sec and end_sec for trimmed playback.
app.get('/clips', (req, res) => {
  const list = (req.query.list || '').trim().toLowerCase();
  let stmt;
  if (list) {
    stmt = db.prepare('SELECT id, video_id, title, channel, start_sec, end_sec, clip_list, created_at FROM clips WHERE clip_list = ? ORDER BY created_at DESC');
    stmt.bind([list]);
  } else {
    stmt = db.prepare('SELECT id, video_id, title, channel, start_sec, end_sec, clip_list, created_at FROM clips ORDER BY created_at DESC');
  }
  const clips = [];
  while (stmt.step()) clips.push(stmt.getAsObject());
  stmt.free();
  res.json({ list: list || 'all', count: clips.length, clips });
});

// POST /clip
// Body: { video_id, title?, channel?, start_sec, end_sec, clip_list }
// Saves a single clip recipe (a trimmed segment of a video) to a clip-list.
app.post('/clip', (req, res) => {
  const { video_id, title, channel, start_sec, end_sec, clip_list } = req.body;
  if (!video_id)  return res.status(400).json({ error: 'video_id required' });
  if (!clip_list) return res.status(400).json({ error: 'clip_list required' });
  if (start_sec == null || end_sec == null) return res.status(400).json({ error: 'start_sec and end_sec required' });
  db.run(
    'INSERT INTO clips (video_id, title, channel, start_sec, end_sec, clip_list, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [video_id, title || null, channel || null, Math.round(start_sec), Math.round(end_sec), String(clip_list).trim().toLowerCase(), Date.now()]
  );
  saveDb();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`ebutuoy backend on :${PORT}`));
});

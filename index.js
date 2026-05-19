// ============================================================================
//  EBUTUOY :: backend
// ============================================================================
//  An anti-popularity YouTube discovery engine with a deliberate-replay system.
//
//  Philosophy:
//    YouTube infers from passive signals. We capture only deliberate ones.
//    The user tells us what they want to see again, and on what cadence.
//    We surface obscure content by default (under 1000 views, under 1000 subs)
//    and never replay seen videos except when the user explicitly said to.
//
//  Architecture:
//    - Express HTTP server on Railway
//    - sql.js (WebAssembly SQLite) for persistent storage
//    - YouTube Data API v3 for content discovery
//    - Tag and revisit system layered on top of the search pipeline
//
//  Endpoints:
//    GET  /health             service status check
//    GET  /seen               every video_id this profile has been served
//    POST /seen               record that a video was served (frontend on each play)
//    GET  /search             discover obscure videos (topic / local / roulette)
//    POST /tag                attach one or more tags to a video
//    GET  /revisit-eligible   videos in revisit queue that are due to play again
//
//  Tag semantics:
//    A "tag" is any string the user attaches to a video. We don't distinguish
//    topic tags from special tags at the storage level; the frontend knows
//    which are special. The one tag that has backend behaviour is the literal
//    string "revisit" (the frontend sends this when "add to revisit playlist"
//    is selected). When that tag lands, we also write a row into revisit_queue
//    so we can compute eligibility later without scanning all tags.
//
//  Revisit eligibility math:
//    A revisit-tagged video becomes eligible to play again when BOTH:
//      - 24 hours have passed since the tag was applied
//      - 100 other videos have been served since the tag was applied
//    Once played via revisit, it re-enters the queue under the same rules.
//    Untagging removes it from the queue (untag endpoint, future work).
//
// ----------------------------------------------------------------------------
//  Authorship log (most recent first):
//    [ORANGE]  add tag system + revisit queue with 24hr/100vid eligibility
//    [ORANGE]  add roulette mode (random global geo), expand /search
//    [ORANGE]  initial scaffold + search pipeline
// ----------------------------------------------------------------------------

// ===== imports ==============================================================

const express   = require('express');
const cors      = require('cors');
const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');
require('dotenv').config();

// ===== app setup ============================================================

const app = express();
app.use(cors());
app.use(express.json());

// ===== configuration ========================================================

const DB_PATH                  = path.join(__dirname, 'ebutuoy.db');
const YT_KEY                   = process.env.YOUTUBE_API_KEY;
const MAX_VIEWS                = 1000;
const MAX_SUBS                 = 1000;
const FETCH_N                  = 50;

// revisit eligibility constants
const REVISIT_MIN_HOURS        = 24;     // hours that must elapse before re-play
const REVISIT_MIN_VIDEOS_SEEN  = 100;    // other videos that must be seen first

// ===== database =============================================================

let db;

// initDb()
// Loads the SQLite database from disk or creates fresh. Creates all tables
// idempotently so adding new ones in a later revision doesn't break old data.
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  // seen_videos: the never-replay-without-permission log
  db.run(`
    CREATE TABLE IF NOT EXISTS seen_videos (
      video_id  TEXT PRIMARY KEY,
      seen_at   INTEGER NOT NULL,
      title     TEXT,
      channel   TEXT
    )
  `);

  // tag_actions: every (video_id, tag) pair the user has ever applied.
  // We keep all of them, even repeated applies, so analytics later can see
  // tag history over time. PRIMARY KEY is composite (video + tag + ts).
  db.run(`
    CREATE TABLE IF NOT EXISTS tag_actions (
      video_id   TEXT NOT NULL,
      tag        TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      title      TEXT,
      channel    TEXT,
      PRIMARY KEY (video_id, tag, applied_at)
    )
  `);

  // revisit_queue: the videos waiting to be served again per user rule.
  // status = 'pending' means it's waiting for eligibility, 'played' means
  // it just played and is waiting for the next cycle. We re-set it to
  // 'pending' (with a fresh tagged_at) every time it plays.
  // videos_seen_at_tag is the snapshot of how many videos had been seen
  // when this entry was inserted; eligibility compares against current count.
  db.run(`
    CREATE TABLE IF NOT EXISTS revisit_queue (
      video_id              TEXT PRIMARY KEY,
      title                 TEXT,
      channel               TEXT,
      tagged_at             INTEGER NOT NULL,
      videos_seen_at_tag    INTEGER NOT NULL,
      last_replayed_at      INTEGER
    )
  `);

  saveDb();
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// getSeenSet()
// Returns a Set of all video_ids ever served.
function getSeenSet() {
  const stmt = db.prepare('SELECT video_id FROM seen_videos');
  const set  = new Set();
  while (stmt.step()) set.add(stmt.getAsObject().video_id);
  stmt.free();
  return set;
}

// getSeenCount()
// Returns the total number of videos ever served. Used by revisit eligibility.
function getSeenCount() {
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM seen_videos');
  stmt.step();
  const c = stmt.getAsObject().c;
  stmt.free();
  return c;
}

// ===== helpers ==============================================================

// randomLand()
// Returns a random lat/lng coordinate biased toward populated landmasses.
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

// ===== routes ===============================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ebutuoy', has_key: !!YT_KEY });
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

// POST /tag
// Body: { video_id, tags: [...strings], title?, channel? }
// Applies one or more tags to a video in one shot. If the tags array
// includes "revisit", we also insert into revisit_queue (or refresh
// the row if it's already there).
app.post('/tag', (req, res) => {
  const { video_id, tags, title, channel } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'tags array required' });
  }

  const now           = Date.now();
  const seenSnapshot  = getSeenCount();

  for (const rawTag of tags) {
    const tag = String(rawTag).trim().toLowerCase();
    if (!tag) continue;

    // record the tag application itself (for analytics later)
    db.run(
      'INSERT OR IGNORE INTO tag_actions (video_id, tag, applied_at, title, channel) VALUES (?, ?, ?, ?, ?)',
      [video_id, tag, now, title || null, channel || null]
    );

    // the one tag with backend behaviour: revisit
    if (tag === 'revisit') {
      // upsert into revisit_queue. If it's already there, refresh the
      // tagged_at and videos_seen_at_tag so the eligibility clock restarts.
      // We do this by delete-then-insert because sql.js's INSERT OR REPLACE
      // would wipe last_replayed_at which we want to preserve for analytics.
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

// GET /revisit-eligible
// Returns up to N revisit-queued videos that have met both eligibility rules:
//   - tagged at least REVISIT_MIN_HOURS hours ago
//   - REVISIT_MIN_VIDEOS_SEEN videos have been served since the tag
// The frontend calls this on each cross-fade. If anything is returned and
// the 10-minute throttle has elapsed, the frontend will inject one of these
// into the stumble queue instead of fetching from /search.
app.get('/revisit-eligible', (req, res) => {
  const now          = Date.now();
  const minTagAge    = REVISIT_MIN_HOURS * 60 * 60 * 1000;
  const seenCount    = getSeenCount();
  const minSeenDelta = REVISIT_MIN_VIDEOS_SEEN;

  const stmt = db.prepare(`
    SELECT video_id, title, channel, tagged_at, videos_seen_at_tag, last_replayed_at
    FROM revisit_queue
    WHERE (? - tagged_at) >= ?
      AND (? - videos_seen_at_tag) >= ?
    ORDER BY tagged_at ASC
  `);
  stmt.bind([now, minTagAge, seenCount, minSeenDelta]);

  const eligible = [];
  while (stmt.step()) eligible.push(stmt.getAsObject());
  stmt.free();

  res.json({
    eligible,
    count:           eligible.length,
    now_seen_count:  seenCount,
    eligibility_rule: {
      min_hours_since_tag:       REVISIT_MIN_HOURS,
      min_videos_seen_since_tag: REVISIT_MIN_VIDEOS_SEEN
    }
  });
});

// POST /revisit-played
// Called by the frontend after it has actually served a revisit video.
// Updates last_replayed_at AND resets tagged_at + videos_seen_at_tag so
// the eligibility clock restarts for the next cycle.
app.post('/revisit-played', (req, res) => {
  const { video_id } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  const now         = Date.now();
  const seenCount   = getSeenCount();
  db.run(
    'UPDATE revisit_queue SET last_replayed_at = ?, tagged_at = ?, videos_seen_at_tag = ? WHERE video_id = ?',
    [now, now, seenCount, video_id]
  );
  saveDb();
  res.json({ ok: true });
});

// GET /search  (unchanged from prior version)
app.get('/search', async (req, res) => {
  if (!YT_KEY) return res.status(500).json({ error: 'no api key configured on server' });
  let { q, lat, lng, radius } = req.query;
  const wantRandom = req.query.random === 'true';

  let chosenLocation = null;
  if (wantRandom) {
    const pick = randomLand();
    lat = String(pick.lat); lng = String(pick.lng); chosenLocation = pick;
  }
  if (!q && (!lat || !lng)) {
    const pick = randomLand();
    lat = String(pick.lat); lng = String(pick.lng); chosenLocation = pick;
  }

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part',       'snippet');
    searchUrl.searchParams.set('type',       'video');
    searchUrl.searchParams.set('maxResults', String(FETCH_N));
    searchUrl.searchParams.set('order',      'date');
    searchUrl.searchParams.set('key',        YT_KEY);
    if (q) searchUrl.searchParams.set('q', q);
    if (lat && lng) {
      searchUrl.searchParams.set('location',       `${lat},${lng}`);
      searchUrl.searchParams.set('locationRadius', radius || '50km');
    }

    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    if (searchData.error) return res.status(500).json({ error: searchData.error.message });

    const videoIds = (searchData.items || []).map(i => i.id.videoId).filter(Boolean);
    if (videoIds.length === 0) return res.json({ videos: [], location: chosenLocation });

    const seen     = getSeenSet();
    const freshIds = videoIds.filter(id => !seen.has(id));
    if (freshIds.length === 0) return res.json({ videos: [], location: chosenLocation });

    const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    videoUrl.searchParams.set('part', 'snippet,statistics,contentDetails');
    videoUrl.searchParams.set('id',   freshIds.join(','));
    videoUrl.searchParams.set('key',  YT_KEY);
    const videoResp = await fetch(videoUrl);
    const videoData = await videoResp.json();

    const channelIds = [...new Set(videoData.items.map(v => v.snippet.channelId))];
    const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelUrl.searchParams.set('part', 'statistics');
    channelUrl.searchParams.set('id',   channelIds.join(','));
    channelUrl.searchParams.set('key',  YT_KEY);
    const channelResp = await fetch(channelUrl);
    const channelData = await channelResp.json();
    const subsByChannel = {};
    (channelData.items || []).forEach(c => {
      subsByChannel[c.id] = parseInt(c.statistics.subscriberCount || '0', 10);
    });

    const filtered = videoData.items
      .filter(v => {
        const views = parseInt(v.statistics.viewCount || '0', 10);
        const subs  = subsByChannel[v.snippet.channelId] || 0;
        return views < MAX_VIEWS && subs < MAX_SUBS;
      })
      .map(v => ({
        id:         v.id,
        title:      v.snippet.title,
        channel:    v.snippet.channelTitle,
        channel_id: v.snippet.channelId,
        published:  v.snippet.publishedAt,
        duration:   v.contentDetails.duration,
        views:      parseInt(v.statistics.viewCount || '0', 10),
        subs:       subsByChannel[v.snippet.channelId] || 0,
        thumbnail:  v.snippet.thumbnails.medium?.url
      }));

    res.json({
      videos:                  filtered,
      location:                chosenLocation,
      fetched:                 videoIds.length,
      after_seen_filter:       freshIds.length,
      after_popularity_filter: filtered.length
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== bootstrap ============================================================

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`ebutuoy backend on :${PORT}`));
});

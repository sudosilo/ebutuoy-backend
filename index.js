// ============================================================================
//  EBUTUOY :: backend
// ============================================================================
//  An anti-popularity YouTube discovery engine.
//
//  Philosophy:
//    The mainstream YouTube algorithm serves what the majority watches, which
//    flattens taste and rewards engagement bait. This backend deliberately
//    inverts that: it only surfaces videos with fewer than 1,000 views from
//    channels with fewer than 1,000 subscribers, and it never serves the same
//    video to the same profile twice.
//
//  Architecture:
//    - Express HTTP server on Railway
//    - sql.js (WebAssembly SQLite) for the persistent seen-video log
//    - YouTube Data API v3 for content discovery
//    - Three-call pipeline: search -> videos -> channels -> popularity filter
//
//  Endpoints:
//    GET  /health   service status check
//    GET  /seen     list of every video_id this profile has been served
//    POST /seen     record that a video was served (frontend calls on each play)
//    GET  /search   discover obscure videos matching topic and/or location
//
// ----------------------------------------------------------------------------
//  Authorship log (most recent first):
//    [ORANGE]  initial scaffold + search pipeline
// ----------------------------------------------------------------------------

// ===== imports ==============================================================

const express   = require('express');     // HTTP server framework
const cors      = require('cors');        // allow cross-origin requests from Vercel frontend
const initSqlJs = require('sql.js');      // WebAssembly SQLite, no native build required
const fs        = require('fs');          // filesystem access for db persistence
const path      = require('path');        // safe path joining across OSes
require('dotenv').config();               // load YOUTUBE_API_KEY from .env on local dev
                                          // Railway injects env vars directly so .env is local only

// ===== app setup ============================================================

const app = express();
app.use(cors());                          // permit any origin; we are public-read-only
app.use(express.json());                  // auto-parse JSON request bodies into req.body

// ===== configuration ========================================================

const DB_PATH   = path.join(__dirname, 'ebutuoy.db');   // sqlite file lives next to index.js
const YT_KEY    = process.env.YOUTUBE_API_KEY;          // YouTube Data API v3 key, set on Railway
const MAX_VIEWS = 1000;                                 // hard cap: skip any video with this many views or more
const MAX_SUBS  = 1000;                                 // hard cap: skip any channel with this many subs or more
const FETCH_N   = 50;                                   // how many candidates to pull per search (YouTube max)

// ===== database =============================================================

let db;   // module-level handle, populated by initDb() before the server starts

// initDb()
// Loads the SQLite database from disk if it exists, otherwise creates a fresh
// in-memory database. Ensures the seen_videos table exists either way.
// sql.js keeps everything in memory; we export to disk after every write.
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    // load existing db file into memory
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    // brand new database
    db = new SQL.Database();
  }
  // idempotent: only creates the table the first time
  db.run(`
    CREATE TABLE IF NOT EXISTS seen_videos (
      video_id  TEXT PRIMARY KEY,    -- YouTube video id, unique
      seen_at   INTEGER NOT NULL,    -- unix ms timestamp of when it was served
      title     TEXT,                -- captured for later browsing of history
      channel   TEXT                 -- captured for later browsing of history
    )
  `);
  saveDb();
}

// saveDb()
// Serialises the in-memory sql.js database to a binary blob and writes it to
// disk. Called after every write so a crash or restart never loses log data.
function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// getSeenSet()
// Returns a JavaScript Set of every video_id ever served to this profile.
// Used by /search to filter out anything already seen.
// Returning a Set (not an array) makes the per-video lookup O(1) inside the filter loop.
function getSeenSet() {
  const stmt = db.prepare('SELECT video_id FROM seen_videos');
  const set  = new Set();
  while (stmt.step()) set.add(stmt.getAsObject().video_id);
  stmt.free();   // sql.js requires explicit cleanup of prepared statements
  return set;
}

// ===== routes ===============================================================

// GET /health
// Lightweight status check. Railway uses this for uptime monitoring.
// has_key flag lets us debug "is the env var even visible to the process" without exposing the value.
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'ebutuoy',
    has_key: !!YT_KEY
  });
});

// GET /seen
// Returns every video_id this profile has ever been served.
// Frontend calls this once at app launch to build its local filter.
app.get('/seen', (req, res) => {
  const ids = Array.from(getSeenSet());
  res.json({ count: ids.length, video_ids: ids });
});

// POST /seen
// Records a single video as having been served.
// Frontend calls this every time a 30-second sample starts playing.
// INSERT OR IGNORE silently skips duplicates, so accidental double-posts are harmless.
app.post('/seen', (req, res) => {
  const { video_id, title, channel } = req.body;
  if (!video_id) {
    return res.status(400).json({ error: 'video_id required' });
  }
  db.run(
    'INSERT OR IGNORE INTO seen_videos (video_id, seen_at, title, channel) VALUES (?, ?, ?, ?)',
    [video_id, Date.now(), title || null, channel || null]
  );
  saveDb();
  res.json({ ok: true });
});

// GET /search?q=...&lat=...&lng=...&radius=...
// The core discovery endpoint. Returns videos under MAX_VIEWS from channels
// under MAX_SUBS, with anything in the seen log removed.
//
// Query params (all optional, at least one should be supplied):
//   q        topic search string, e.g. "submarine sigint"
//   lat,lng  geographic centre point (decimal degrees)
//   radius   geographic search radius, e.g. "50km" (default 50km when lat/lng given)
//
// The endpoint runs a three-call pipeline against YouTube:
//   1. /search   -> get up to 50 candidate video ids
//   2. /videos   -> for surviving ids, fetch view counts + channel ids
//   3. /channels -> for those channels, fetch subscriber counts
// then applies the seen-filter and popularity-filter on top.
app.get('/search', async (req, res) => {
  if (!YT_KEY) {
    return res.status(500).json({ error: 'no api key configured on server' });
  }

  const { q, lat, lng, radius } = req.query;

  try {
    // ---- step 1: search for candidates ------------------------------------
    // We sort by date (newest first) because recent uploads have had less time
    // to accumulate views, so they are far more likely to pass the popularity
    // filter than YouTube's default "relevance" sort.
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part',       'snippet');
    searchUrl.searchParams.set('type',       'video');
    searchUrl.searchParams.set('maxResults', String(FETCH_N));
    searchUrl.searchParams.set('order',      'date');
    searchUrl.searchParams.set('key',        YT_KEY);
    if (q) {
      searchUrl.searchParams.set('q', q);
    }
    if (lat && lng) {
      // YouTube geo search returns only videos with location metadata, which
      // is a minority of all uploads but exactly the obscure pool we want.
      searchUrl.searchParams.set('location',       `${lat},${lng}`);
      searchUrl.searchParams.set('locationRadius', radius || '50km');
    }

    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    if (searchData.error) {
      return res.status(500).json({ error: searchData.error.message });
    }

    // pull the video ids out of the search results
    const videoIds = (searchData.items || [])
      .map(i => i.id.videoId)
      .filter(Boolean);
    if (videoIds.length === 0) {
      return res.json({ videos: [], note: 'no results from youtube search' });
    }

    // ---- step 2: drop anything already seen --------------------------------
    const seen     = getSeenSet();
    const freshIds = videoIds.filter(id => !seen.has(id));
    if (freshIds.length === 0) {
      return res.json({ videos: [], note: 'all results already in seen log' });
    }

    // ---- step 3: fetch full details for the survivors ----------------------
    // /videos lets us batch up to 50 ids in a single call, so cost stays low.
    const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    videoUrl.searchParams.set('part', 'snippet,statistics,contentDetails');
    videoUrl.searchParams.set('id',   freshIds.join(','));
    videoUrl.searchParams.set('key',  YT_KEY);

    const videoResp = await fetch(videoUrl);
    const videoData = await videoResp.json();

    // ---- step 4: fetch subscriber counts for the channels involved ---------
    // We dedupe the channel ids so we never ask about the same channel twice
    // in one batch. /channels also accepts comma-separated ids.
    const channelIds = [...new Set(videoData.items.map(v => v.snippet.channelId))];
    const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelUrl.searchParams.set('part', 'statistics');
    channelUrl.searchParams.set('id',   channelIds.join(','));
    channelUrl.searchParams.set('key',  YT_KEY);
    const channelResp = await fetch(channelUrl);
    const channelData = await channelResp.json();

    // build a quick lookup map: channel_id -> subscriber_count
    const subsByChannel = {};
    (channelData.items || []).forEach(c => {
      subsByChannel[c.id] = parseInt(c.statistics.subscriberCount || '0', 10);
    });

    // ---- step 5: apply the popularity filter ------------------------------
    // Both rules must pass: view count under cap AND subscriber count under cap.
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
        duration:   v.contentDetails.duration,                              // ISO 8601, e.g. PT3M14S
        views:      parseInt(v.statistics.viewCount || '0', 10),
        subs:       subsByChannel[v.snippet.channelId] || 0,
        thumbnail:  v.snippet.thumbnails.medium?.url
      }));

    // ---- response ---------------------------------------------------------
    // The funnel counts make it obvious whether the search itself is dry or
    // whether the popularity filter is doing the cutting.
    res.json({
      videos:                  filtered,
      fetched:                 videoIds.length,
      after_seen_filter:       freshIds.length,
      after_popularity_filter: filtered.length
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== bootstrap ============================================================
// Railway sets PORT automatically; locally we fall back to 3000 so curl works.
// We wait for initDb() to finish before binding the listener so no request
// can ever land before the database is ready.

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`ebutuoy backend on :${PORT}`));
});

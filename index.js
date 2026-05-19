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
//    GET  /search   discover obscure videos (topic, local, or random roulette)
//
//  Search modes (passed to /search):
//    Topic    ?q=topic_string
//    Local    ?lat=X&lng=Y&radius=50km        (radius optional)
//    Roulette ?random=true                    (server picks a global lat/lng)
//    Mixed    any combination of the above
//
// ----------------------------------------------------------------------------
//  Authorship log (most recent first):
//    [ORANGE]  add roulette mode (random global geo), expand /search
//    [ORANGE]  initial scaffold + search pipeline
// ----------------------------------------------------------------------------

// ===== imports ==============================================================

const express   = require('express');     // HTTP server framework
const cors      = require('cors');        // allow cross-origin requests from Vercel frontend
const initSqlJs = require('sql.js');      // WebAssembly SQLite, no native build required
const fs        = require('fs');          // filesystem access for db persistence
const path      = require('path');        // safe path joining across OSes
require('dotenv').config();               // load YOUTUBE_API_KEY from .env on local dev only

// ===== app setup ============================================================

const app = express();
app.use(cors());                          // permit any origin; we are public-read-only
app.use(express.json());                  // auto-parse JSON request bodies into req.body

// ===== configuration ========================================================

const DB_PATH   = path.join(__dirname, 'ebutuoy.db');
const YT_KEY    = process.env.YOUTUBE_API_KEY;
const MAX_VIEWS = 1000;
const MAX_SUBS  = 1000;
const FETCH_N   = 50;

// ===== database =============================================================

let db;

// initDb()
// Loads the SQLite database from disk if it exists, otherwise creates a fresh
// in-memory database. Ensures the seen_videos table exists either way.
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS seen_videos (
      video_id  TEXT PRIMARY KEY,
      seen_at   INTEGER NOT NULL,
      title     TEXT,
      channel   TEXT
    )
  `);
  saveDb();
}

// saveDb()
// Serialises in-memory sql.js database to disk after every write.
function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// getSeenSet()
// Returns a JavaScript Set of every video_id already served.
// O(1) lookup per video during filtering.
function getSeenSet() {
  const stmt = db.prepare('SELECT video_id FROM seen_videos');
  const set  = new Set();
  while (stmt.step()) set.add(stmt.getAsObject().video_id);
  stmt.free();
  return set;
}

// ===== helpers ==============================================================

// randomLand()
// Returns a random lat/lng coordinate biased toward populated landmasses.
// Pure random across the globe lands in ocean about 71% of the time, which
// would waste API quota on empty searches. Instead we sample from a curated
// list of population-dense rectangles. Each rectangle is [minLat, maxLat,
// minLng, maxLng]. Picked by area-weighted random for rough fairness.
//
// This is intentionally crude. The goal is geographic diversity, not
// statistical accuracy. If a session lands in rural Mongolia and finds no
// geotagged videos, that's fine, the frontend just calls /search again.
function randomLand() {
  const regions = [
    // North America (continental US, Mexico, southern Canada)
    [25,  50,  -125, -70],
    // South America (most of it)
    [-40, 10,  -80,  -40],
    // Europe
    [36,  60,  -10,  40],
    // Africa (sub-Saharan band + north)
    [-30, 35,  -15,  45],
    // Middle East + South Asia
    [10,  40,  35,   90],
    // East Asia
    [20,  45,  100,  145],
    // Southeast Asia + Australia
    [-40, 20,  95,   155],
  ];
  const r       = regions[Math.floor(Math.random() * regions.length)];
  const lat     = r[0] + Math.random() * (r[1] - r[0]);
  const lng     = r[2] + Math.random() * (r[3] - r[2]);
  // round to 4 decimals (about 11 meters of precision, plenty)
  return {
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4))
  };
}

// ===== routes ===============================================================

// GET /health
// Lightweight status check. Railway uses this for uptime monitoring.
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'ebutuoy',
    has_key: !!YT_KEY
  });
});

// GET /seen
// Returns every video_id this profile has ever been served.
app.get('/seen', (req, res) => {
  const ids = Array.from(getSeenSet());
  res.json({ count: ids.length, video_ids: ids });
});

// POST /seen
// Records a single video as having been served.
// INSERT OR IGNORE silently skips duplicates.
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

// GET /search
// The core discovery endpoint.
//
// Query params (all optional, combine freely):
//   q         topic search string
//   lat,lng   geographic centre point (decimal degrees)
//   radius    geographic search radius, e.g. "50km" (default 50km)
//   random    if "true", server picks a random global lat/lng (Roulette mode)
//
// Mode resolution:
//   - random=true overrides any lat/lng the client sent
//   - q and geo can coexist (e.g. "metal detecting" + somewhere in Europe)
//   - if absolutely nothing is supplied we treat it as random for safety
app.get('/search', async (req, res) => {
  if (!YT_KEY) {
    return res.status(500).json({ error: 'no api key configured on server' });
  }

  let { q, lat, lng, radius } = req.query;
  const wantRandom = req.query.random === 'true';

  // ---- Roulette mode: server picks the coordinates ------------------------
  let chosenLocation = null;
  if (wantRandom) {
    const pick = randomLand();
    lat = String(pick.lat);
    lng = String(pick.lng);
    chosenLocation = pick;
  }

  // ---- Safety fallback: if no query AND no geo, force a random pick -------
  // Stops the endpoint from making a wide-open YouTube call that just
  // returns the most popular videos in the entire system.
  if (!q && (!lat || !lng)) {
    const pick = randomLand();
    lat = String(pick.lat);
    lng = String(pick.lng);
    chosenLocation = pick;
  }

  try {
    // ---- step 1: search for candidates ----------------------------------
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
      searchUrl.searchParams.set('location',       `${lat},${lng}`);
      searchUrl.searchParams.set('locationRadius', radius || '50km');
    }

    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    if (searchData.error) {
      return res.status(500).json({ error: searchData.error.message });
    }

    const videoIds = (searchData.items || [])
      .map(i => i.id.videoId)
      .filter(Boolean);
    if (videoIds.length === 0) {
      return res.json({
        videos:   [],
        location: chosenLocation,
        note:     'no results from youtube search'
      });
    }

    // ---- step 2: drop anything already seen -----------------------------
    const seen     = getSeenSet();
    const freshIds = videoIds.filter(id => !seen.has(id));
    if (freshIds.length === 0) {
      return res.json({
        videos:   [],
        location: chosenLocation,
        note:     'all results already in seen log'
      });
    }

    // ---- step 3: fetch full video details -------------------------------
    const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    videoUrl.searchParams.set('part', 'snippet,statistics,contentDetails');
    videoUrl.searchParams.set('id',   freshIds.join(','));
    videoUrl.searchParams.set('key',  YT_KEY);
    const videoResp = await fetch(videoUrl);
    const videoData = await videoResp.json();

    // ---- step 4: fetch subscriber counts for each unique channel --------
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

    // ---- step 5: popularity filter --------------------------------------
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

    // ---- response -------------------------------------------------------
    // location field is null unless Roulette mode picked a coordinate.
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

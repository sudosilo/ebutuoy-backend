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
//
//  Language filter (this revision):
//    /search now drops videos whose defaultAudioLanguage is set to anything
//    other than English (en, en-US, en-GB, etc). Videos with no language
//    field set are allowed through (small creators often don't tag), and
//    a script-based check rejects titles dominated by non-Latin scripts.
//
// ----------------------------------------------------------------------------
//  Authorship log (most recent first):
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

const DB_PATH                  = path.join(__dirname, 'ebutuoy.db');
const YT_KEY                   = process.env.YOUTUBE_API_KEY;
const MAX_VIEWS                = 1000;
const MAX_SUBS                 = 1000;
const FETCH_N                  = 50;
const REVISIT_MIN_HOURS        = 24;
const REVISIT_MIN_VIDEOS_SEEN  = 100;

let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
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
  saveDb();
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
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

// ===== ROUTES ===============================================================

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

    // Apply the language filter EARLY, before we waste channel-quota calls
    // on videos that are going to be rejected anyway.
    const englishVideos = (videoData.items || []).filter(isLikelyEnglish);

    if (englishVideos.length === 0) {
      return res.json({
        videos:                  [],
        location:                chosenLocation,
        fetched:                 videoIds.length,
        after_seen_filter:       freshIds.length,
        after_language_filter:   0,
        after_popularity_filter: 0
      });
    }

    const channelIds = [...new Set(englishVideos.map(v => v.snippet.channelId))];
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

    const filtered = englishVideos
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
        thumbnail:  v.snippet.thumbnails.medium?.url,
        lang:       v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || null
      }));

    res.json({
      videos:                  filtered,
      location:                chosenLocation,
      fetched:                 videoIds.length,
      after_seen_filter:       freshIds.length,
      after_language_filter:   englishVideos.length,
      after_popularity_filter: filtered.length
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
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

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`ebutuoy backend on :${PORT}`));
});

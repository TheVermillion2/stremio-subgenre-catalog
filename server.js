const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const localtunnel = require('localtunnel');
const admin = require('firebase-admin');
const { getDatabase } = require('firebase-admin/database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 7000;

// Initialize Firebase if env vars or firebase-key.json are present
let db = null;
const firebaseKeyFile = path.join(__dirname, 'firebase-key.json');
let serviceAccount = null;

if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
  serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  };
} else if (fs.existsSync(firebaseKeyFile)) {
  try {
    serviceAccount = JSON.parse(fs.readFileSync(firebaseKeyFile, 'utf8'));
  } catch (e) {
    console.error('[Firebase] Failed to parse firebase-key.json:', e.message);
  }
}

if (serviceAccount) {
  try {
    const projId = serviceAccount.project_id || serviceAccount.projectId;
    const cred = admin.cert ? admin.cert(serviceAccount) : (admin.credential ? admin.credential.cert(serviceAccount) : null);
    const fbApp = admin.initializeApp({
      credential: cred,
      databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${projId}-default-rtdb.firebaseio.com`
    });
    db = getDatabase(fbApp);
    console.log('[Firebase] Connected to Realtime Database successfully!');
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err.message);
  }
} else {
  console.log('[Local Storage] No Firebase credentials found. Using local JSON files.');
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // Fallback if files were uploaded to repo root

// Configuration state stored in memory & persisted to local JSON or Firebase
const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = {
  activeSubgenre: 'cyberpunk',
  sortBy: 'popularity.desc', // 'popularity.desc', 'release_date.desc', 'vote_average.desc'
  tmdbApiKey: process.env.TMDB_API_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  customKeywords: '',
  lastUpdated: null,
  refreshIntervalHours: 6
};

// Load saved config
async function loadConfig() {
  if (db) {
    try {
      const snapshot = await db.ref('config').once('value');
      if (snapshot.exists()) {
        config = { ...config, ...snapshot.val() };
      }
    } catch (e) {
      console.error('Error loading config from Firebase:', e.message);
    }
  } else if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...config, ...saved };
    } catch (e) {
      console.error('Error loading config.json:', e.message);
    }
  }
  if (!config.tmdbApiKey) {
    config.tmdbApiKey = '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  }
}

async function saveConfig() {
  if (db) {
    try {
      await db.ref('config').set(config);
    } catch (err) {
      console.error('Failed to save config to Firebase:', err.message);
    }
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
}

// Preset Sub-genres definition with optimized TMDB Genre/Keyword IDs & Queries
const LIVE_FEEDS = [
  {
    id: 'trending_week',
    name: '🔥 Trending Movies This Week',
    description: 'Live auto-updating feed of the top trending movies worldwide over the last 7 days.'
  },
  {
    id: 'top_rated',
    name: '⭐ Top Rated All-Time (IMDb Top 250)',
    description: 'Live auto-updating catalog of top-rated cinema masterpieces of all time.'
  },
  {
    id: 'now_playing',
    name: '🎬 Now Playing in Theaters',
    description: 'Live auto-updating list of movies currently playing in movie theaters worldwide.'
  },
  {
    id: 'upcoming',
    name: '🚀 Upcoming Box Office Releases',
    description: 'Live auto-updating list of upcoming theatrical releases and box office premieres.'
  }
];

const SUBGENRES = [
  {
    id: 'cyberpunk',
    name: '80s & 90s Cyberpunk Sci-Fi',
    description: 'High tech, low life, neon lights, retro-futurism, androids, and cyberpunk aesthetics.',
    tmdbGenreIds: [878],
    tmdbKeywords: [4565, 12190, 210065],
    releaseYearMin: 1978,
    releaseYearMax: 2005
  },
  {
    id: 'found_footage_horror',
    name: 'Found Footage & Mockumentary Horror',
    description: 'Raw, terrifying, handheld camera, lost tapes, and mockumentary horror.',
    tmdbGenreIds: [27],
    tmdbKeywords: [156178, 207604, 256257, 163077]
  },
  {
    id: 'martial_arts_classics',
    name: '90s Martial Arts & Kung Fu',
    description: 'Shaw Brothers, Jackie Chan, Jet Li, Bruce Lee, classic Hong Kong action cinema.',
    tmdbGenreIds: [28],
    tmdbKeywords: [780, 163077, 483, 9663],
    releaseYearMin: 1975,
    releaseYearMax: 2005
  },
  {
    id: 'neo_noir',
    name: 'Neo-Noir & Crime Thrillers',
    description: 'Rain-soaked streets, cynical detectives, shadows, moral ambiguity, and sleek crime suspense.',
    tmdbGenreIds: [80, 53],
    tmdbKeywords: [10092, 10292]
  },
  {
    id: 'space_horror',
    name: 'Deep Space & Alien Cosmic Horror',
    description: 'Isolated in deep space, eerie spaceship corridors, eldritch alien terror.',
    tmdbGenreIds: [27, 878],
    tmdbKeywords: [9882, 3801, 161261]
  },
  {
    id: 'slashers_80s',
    name: '80s Slasher Classics',
    description: 'Masked killers, cabin in the woods, retro synth scores, golden era horror.',
    tmdbGenreIds: [27],
    tmdbKeywords: [12339, 12565],
    releaseYearMin: 1978,
    releaseYearMax: 1992
  },
  {
    id: 'kaiju_monsters',
    name: 'Kaiju & Giant Monster Cinema',
    description: 'Godzilla, Gamera, Pacific Rim, giant beasts leveling cities.',
    tmdbGenreIds: [878, 28],
    tmdbKeywords: [158227, 10926, 12398]
  },
  {
    id: 'post_apocalyptic',
    name: 'Post-Apocalyptic & Wasteland',
    description: 'Mad Max vibes, barren ruins, survival, post-collapse world.',
    tmdbGenreIds: [878, 28],
    tmdbKeywords: [2858, 4565, 186411]
  },
  {
    id: 'dark_fantasy',
    name: 'Dark Fantasy & Sword and Sorcery',
    description: 'Grim dark magic, mythical beasts, heavy metal fantasy, ancient legends.',
    tmdbGenreIds: [14, 12],
    tmdbKeywords: [3028, 4152]
  },
  {
    id: 'mind_bending_scifi',
    name: 'Mind-Bending & Time Loop Sci-Fi',
    description: 'Time travel, parallel universes, cognitive puzzles, surreal realities.',
    tmdbGenreIds: [878, 9648],
    tmdbKeywords: [4379, 9840, 10842]
  }
];

const COLLECTIONS_FILE = path.join(__dirname, 'data', 'collections.json');
const LIVE_CHANNELS_FILE = path.join(__dirname, 'data', 'live_channels.json');

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// Memory cache for collections & live channels
let collections = {};
let liveChannels = [];
let epgCache = {}; // channelId -> { currentTitle, currentDesc, nextTitle }
let searchCache = {}; // Cache for live AI search queries

const FIREBASE_URL = 'https://stremio-catalogue-3bad5-default-rtdb.firebaseio.com';

function getChannelEPG(channel) {
  if (!channel) return null;
  // Return strictly 100% verified real XMLTV guide data
  return epgCache[channel.id] || null;
}

async function updateLiveEPG() {
  const epgUrls = [
    'https://i.mjh.nz/SamsungTVPlus/us.xml',
    'https://i.mjh.nz/SamsungTVPlus/gb.xml',
    'https://i.mjh.nz/Plex/us.xml'
  ];

  const nowUtc = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  for (const url of epgUrls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const xmlText = await res.text();

      const channelMap = {};
      const chMatches = xmlText.match(/<channel id="([^"]+)">[\s\S]*?<display-name>([^<]+)<\/display-name>/g) || [];
      chMatches.forEach(chBlock => {
        const idM = chBlock.match(/id="([^"]+)"/);
        const nameM = chBlock.match(/<display-name>([^<]+)<\/display-name>/);
        if (idM && nameM) {
          channelMap[idM[1]] = nameM[1].trim().toLowerCase();
        }
      });

      liveChannels.forEach(ch => {
        if (epgCache[ch.id]) return;

        const nameClean = ch.name.toLowerCase();
        let matchedXmlId = null;
        for (const [xId, xName] of Object.entries(channelMap)) {
          if (
            (nameClean.includes('universal monsters') && xName.includes('universal monsters')) ||
            (nameClean.includes('haunt') && xName.includes('haunt')) ||
            (nameClean.includes('alter') && xName.includes('alter')) ||
            (nameClean.includes('dark matter') && xName.includes('dark matter')) ||
            (nameClean.includes('fear factor') && xName.includes('fear factor')) ||
            (nameClean.includes('river monsters') && xName.includes('river monsters')) ||
            (nameClean.includes('30a classic') && xName.includes('cinevault')) ||
            (nameClean.includes('red bull') && xName.includes('red bull')) ||
            (nameClean.includes('sky news') && xName.includes('sky news')) ||
            (nameClean.includes('abc news') && xName.includes('abc news'))
          ) {
            matchedXmlId = xId;
            break;
          }
        }

        if (matchedXmlId) {
          const progRegex = new RegExp(`<programme[^>]+channel="${matchedXmlId}"[^>]+start="([0-9]{14})[^"]*"[^>]+stop="([0-9]{14})[^"]*"[^>]*>[\\s\\S]*?<title[^>]*>([\\s\\S]*?)<\\/title>(?:[\\s\\S]*?<desc[^>]*>([\\s\\S]*?)<\\/desc>)?`, 'g');
          let pm;
          let current = null;
          let next = null;

          while ((pm = progRegex.exec(xmlText)) !== null) {
            const start = pm[1];
            const stop = pm[2];
            const title = pm[3] ? pm[3].trim() : '';
            const desc = pm[4] ? pm[4].trim() : '';

            if (start <= nowUtc && nowUtc <= stop) {
              current = { title, desc, start, stop };
            } else if (start > nowUtc && (!next || start < next.start)) {
              next = { title, desc, start, stop };
            }
          }

          if (current) {
            epgCache[ch.id] = {
              currentTitle: current.title,
              currentDesc: current.desc,
              nextTitle: next ? next.title : 'Next Feature Presentation'
            };
          }
        }
      });
    } catch (err) {
      console.error(`[EPG Engine] Error loading ${url}:`, err.message);
    }
  }
}

function loadLiveChannels() {
  if (fs.existsSync(LIVE_CHANNELS_FILE)) {
    try {
      liveChannels = JSON.parse(fs.readFileSync(LIVE_CHANNELS_FILE, 'utf8')) || [];
      console.log(`[24/7 Channels] Loaded ${liveChannels.length} live channels from local file.`);
      updateLiveEPG();
    } catch (err) {
      console.error('Failed to load live_channels.json:', err.message);
    }
  }
}

// Refresh EPG every 1 hour
setInterval(updateLiveEPG, 3600000);

async function loadCollections() {
  loadLiveChannels();
  let localData = {};
  if (fs.existsSync(COLLECTIONS_FILE)) {
    try {
      localData = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, 'utf8')) || {};
    } catch (err) {
      console.error('Failed to load collections locally:', err.message);
    }
  }

  try {
    const fbRes = await fetchJson(`${FIREBASE_URL}/collections.json`);
    if (fbRes && typeof fbRes === 'object' && Object.keys(fbRes).length > 0) {
      collections = fbRes;
      console.log(`[Firebase Cloud] Successfully loaded ${Object.keys(collections).length} collections from Firebase Cloud DB.`);
    } else if (Object.keys(localData).length > 0) {
      collections = localData;
      console.log(`[Firebase Cloud] Seeded Firebase Cloud DB with ${Object.keys(collections).length} local collections.`);
      await saveCollections();
    }
  } catch (err) {
    console.error('Failed to load collections from Firebase Cloud:', err.message);
    collections = localData;
  }
}

async function saveCollections() {
  try {
    fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(collections, null, 2));
  } catch (err) {
    console.error('Failed to save collections locally:', err.message);
  }
  
  try {
    const res = await fetch(`${FIREBASE_URL}/collections.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collections)
    });
    if (res.ok) {
      console.log(`[Firebase Cloud] Saved ${Object.keys(collections).length} collections to Cloud DB.`);
    }
  } catch (err) {
    console.error('Failed to save collections to Firebase Cloud:', err.message);
  }
}

async function deleteCollectionFromCloud(id) {
  try {
    await fetch(`${FIREBASE_URL}/collections/${id}.json`, {
      method: 'DELETE'
    });
    console.log(`[Firebase Cloud] Deleted collection ${id} from Cloud DB.`);
  } catch (err) {
    console.error(`Failed to delete collection ${id} from Firebase Cloud:`, err.message);
  }
}

// Helper: HTTP request wrapper
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => reject(err));
  });
}

async function getLiveFeedMovies(feedType, apiKeyStr) {
  const apiKey = apiKeyStr || config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  let endpoint = '';
  let feedName = '';

  if (feedType === 'trending_week') {
    endpoint = 'https://api.themoviedb.org/3/trending/movie/week';
    feedName = '🔥 Trending Movies This Week';
  } else if (feedType === 'top_rated') {
    endpoint = 'https://api.themoviedb.org/3/movie/top_rated';
    feedName = '⭐ Top Rated All-Time';
  } else if (feedType === 'now_playing') {
    endpoint = 'https://api.themoviedb.org/3/movie/now_playing';
    feedName = '🎬 Now Playing in Theaters';
  } else if (feedType === 'upcoming') {
    endpoint = 'https://api.themoviedb.org/3/movie/upcoming';
    feedName = '🚀 Upcoming Box Office Releases';
  } else {
    return [];
  }

  console.log(`[TMDB Live Feed] Fetching live feed for: ${feedName}...`);
  let allMovies = [];

  for (let page = 1; page <= 10; page++) {
    const url = `${endpoint}?api_key=${apiKey}&page=${page}`;
    const res = await fetchJson(url);
    if (res && res.results && res.results.length > 0) {
      allMovies.push(...res.results);
      if (page >= res.total_pages) break;
    } else {
      break;
    }
  }

  const stremioMetas = [];
  const chunkSize = 10;
  for (let i = 0; i < allMovies.length; i += chunkSize) {
    const chunk = allMovies.slice(i, i + chunkSize);
    const batchMetas = await Promise.all(
      chunk.map(async (m) => {
        let externalId = `tt${m.id}`;
        try {
          const extRes = await fetchJson(`https://api.themoviedb.org/3/movie/${m.id}/external_ids?api_key=${apiKey}`);
          if (extRes && extRes.imdb_id) externalId = extRes.imdb_id;
        } catch (err) {}

        return {
          id: externalId,
          type: 'movie',
          name: m.title || m.original_title,
          poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Poster',
          background: m.backdrop_path ? `https://image.tmdb.org/t/p/original${m.backdrop_path}` : null,
          description: m.overview || 'No description available.',
          releaseInfo: m.release_date ? m.release_date.substring(0, 4) : 'N/A',
          imdbRating: m.vote_average ? m.vote_average.toFixed(1) : 'N/A',
          genres: [feedName]
        };
      })
    );
    stremioMetas.push(...batchMetas);
  }

  console.log(`[TMDB Live Feed] Successfully loaded ${stremioMetas.length} movies for live feed: ${feedName}`);
  return stremioMetas;
}

// Fetch movies from TMDB for active subgenre or query
async function getMoviesForSubgenre(subgenreId, options = {}) {
  if (['trending_week', 'top_rated', 'now_playing', 'upcoming'].includes(subgenreId)) {
    return await getLiveFeedMovies(subgenreId, options.apiKey);
  }

  const apiKey = options.apiKey || config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  const currentSubgenre = SUBGENRES.find(s => s.id === subgenreId) || SUBGENRES[0];

  try {
    console.log(`[TMDB] Fetching live 100 movies from TMDB for subgenre: ${currentSubgenre.name}...`);
    let allMovies = [];
    const genreStr = currentSubgenre.tmdbGenreIds ? currentSubgenre.tmdbGenreIds.join(',') : '878';
    const sortParam = options.sortBy || config.sortBy || 'popularity.desc';

    // Helper to build discover URL
    const buildUrl = (page, useKeywords = true) => {
      let url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&with_genres=${genreStr}&sort_by=${sortParam}&page=${page}&vote_count.gte=10`;
      if (useKeywords && currentSubgenre.tmdbKeywords && currentSubgenre.tmdbKeywords.length > 0) {
        url += `&with_keywords=${currentSubgenre.tmdbKeywords.join('|')}`;
      }
      if (currentSubgenre.releaseYearMin) {
        url += `&primary_release_date.gte=${currentSubgenre.releaseYearMin}-01-01`;
      }
      if (currentSubgenre.releaseYearMax) {
        url += `&primary_release_date.lte=${currentSubgenre.releaseYearMax}-12-31`;
      }
      return url;
    };

    // First attempt: search with keywords across pages 1 to 15
    for (let page = 1; page <= 15; page++) {
      const res = await fetchJson(buildUrl(page, true));
      if (res && res.results && res.results.length > 0) {
        allMovies = allMovies.concat(res.results);
      }
    }

    // If keywords filter returned very few movies, pad with broader genre query
    if (allMovies.length < 20) {
      console.log(`[TMDB] Keyword filter returned ${allMovies.length} movies. Padding with broader genre query...`);
      const existingIds = new Set(allMovies.map(m => m.id));
      for (let page = 1; page <= 15; page++) {
        const res = await fetchJson(buildUrl(page, false));
        if (res && res.results) {
          for (const item of res.results) {
            if (!existingIds.has(item.id)) {
              existingIds.add(item.id);
              allMovies.push(item);
            }
          }
        }
      }
    }

    const selectedMovies = allMovies; // Use all fetched movies without slicing

    // Batch external ID fetching in groups of 10 to avoid socket bottlenecks
    const stremioMetas = [];
    const chunkSize = 10;
    for (let i = 0; i < selectedMovies.length; i += chunkSize) {
      const chunk = selectedMovies.slice(i, i + chunkSize);
      const batchMetas = await Promise.all(
        chunk.map(async (m) => {
          let externalId = `tt${m.id}`; // fallback
          try {
            const extRes = await fetchJson(`https://api.themoviedb.org/3/movie/${m.id}/external_ids?api_key=${apiKey}`);
            if (extRes && extRes.imdb_id) {
              externalId = extRes.imdb_id;
            }
          } catch (err) {
            // keep fallback
          }

          return {
            id: externalId,
            type: 'movie',
            name: m.title || m.original_title,
            poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Poster',
            background: m.backdrop_path ? `https://image.tmdb.org/t/p/original${m.backdrop_path}` : null,
            description: m.overview || 'No description available.',
            releaseInfo: m.release_date ? m.release_date.substring(0, 4) : 'N/A',
            imdbRating: m.vote_average ? m.vote_average.toFixed(1) : 'N/A',
            genres: [currentSubgenre.name]
          };
        })
      );
      stremioMetas.push(...batchMetas);
    }

    console.log(`[TMDB] Successfully loaded ${stremioMetas.length} movies for subgenre: ${currentSubgenre.name}`);
    return stremioMetas;
  } catch (error) {
    console.error('[TMDB API Error]:', error.message);
    return [];
  }
}

const MASTER_CATEGORIES = [
  {
    id: 'cat_horror_thrillers',
    name: '👻 Horror & Thrillers',
    type: 'movie',
    subgenres: [
      'Spanish Thrillers',
      'Korean Horror',
      'Classic thrillers',
      'Stalker/ Chased',
      'Mind Twists',
      'The Best Movie Villains of All Time'
    ]
  },
  {
    id: 'cat_urban_black_cinema',
    name: '🎬 Urban & Black Cinema',
    type: 'movie',
    subgenres: [
      '90s Hood Classics',
      'Black Lead',
      'BLACK DIRECTORS'
    ]
  },
  {
    id: 'cat_curated_masterpieces',
    name: '⭐ Curated & Masterpieces',
    type: 'movie',
    subgenres: [
      'Movies Everyone Should Watch At Least Once',
      'Every A24 Movie Ever (Official Collection)',
      'Letterboxd Official: Top 100 Sub-Saharan African Films',
      'Letterboxd Official: Top 250 Documentary Films',
      '450 Mind-Expanding Documentaries (DIY Genius)'
    ]
  },
  {
    id: 'cat_nostalgia_vibes',
    name: '🍿 Nostalgia & Vibes',
    type: 'movie',
    subgenres: [
      "90's Nostalgia",
      'Action Packed',
      'Got Time',
      'Christmas Movies Collection',
      '🚀 IMDb Release Calendar: Upcoming Movies'
    ]
  },
  {
    id: 'cat_tv_series',
    name: '📺 Curated TV Series',
    type: 'series',
    subgenres: [
      'IMDb Top 250 TV Shows',
      'MDBList: Latest TV Shows Feed',
      '450 Mind-Expanding Documentaries (DIY Genius)',
      'Christmas Movies Collection'
    ]
  }
];

function findCollectionByName(name) {
  if (!name) return null;
  const nameNorm = name.trim().toLowerCase();
  for (const col of Object.values(collections)) {
    if (col && col.name && col.name.trim().toLowerCase() === nameNorm) {
      return col;
    }
  }
  return null;
}

function sortMoviesByRating(movies) {
  if (!Array.isArray(movies)) return [];
  return [...movies].sort((a, b) => {
    const parseRating = (r) => {
      if (!r || r === 'N/A' || r === '0') return -1;
      const parsed = parseFloat(r);
      return isNaN(parsed) ? -1 : parsed;
    };
    const ratingA = parseRating(a.imdbRating);
    const ratingB = parseRating(b.imdbRating);
    if (ratingB !== ratingA) {
      return ratingB - ratingA;
    }
    const yearA = parseInt(a.releaseInfo || a.releaseDate || a.year || '0', 10) || 0;
    const yearB = parseInt(b.releaseInfo || b.releaseDate || b.year || '0', 10) || 0;
    return yearB - yearA;
  });
}

function sortMoviesByYear(movies) {
  return sortMoviesByRating(movies);
}

// Stremio Addon Protocol Manifest
app.get('/manifest.json', (req, res) => {
  const catalogs = [];

  // 1. 24/7 Live Channels Catalog
  const liveChannelGenres = [
    "All Channels",
    "Sports",
    "Horror",
    "Movies",
    "Crime and Mystery",
    "Martial Arts and Action",
    "Sci-Fi and Action",
    "Docs and Nature",
    "News and Sports"
  ];

  catalogs.push({
    type: 'tv',
    id: 'cat_247_channels',
    name: '📺 24/7 Live Channels',
    extra: [
      {
        name: 'genre',
        options: liveChannelGenres,
        isRequired: false
      },
      {
        name: 'skip',
        isRequired: false
      }
    ]
  });

  // 2. Live AI Search catalogs
  catalogs.push({
    type: 'movie',
    id: 'ai_search',
    name: '🤖 AI Movie Search Curator',
    extra: [
      { name: 'search', isRequired: true },
      { name: 'skip', isRequired: false }
    ]
  });

  catalogs.push({
    type: 'series',
    id: 'ai_search_series',
    name: '🤖 AI TV Series Curator',
    extra: [
      { name: 'search', isRequired: true },
      { name: 'skip', isRequired: false }
    ]
  });

  // 3. Master Categories with Subgenre Dropdowns
  const categorizedSubgenreNames = new Set();

  MASTER_CATEGORIES.forEach(cat => {
    // Collect matching existing collections with items
    const availableOptions = [];
    cat.subgenres.forEach(subName => {
      const col = findCollectionByName(subName);
      if (col && col.movies && col.movies.length > 0) {
        const hasMatchingType = col.movies.some(m => cat.type === 'series' ? m.type === 'series' : m.type !== 'series');
        if (hasMatchingType) {
          if (!availableOptions.includes(col.name)) {
            availableOptions.push(col.name);
          }
          categorizedSubgenreNames.add(col.name.trim().toLowerCase());
        }
      }
    });

    if (availableOptions.length > 0) {
      catalogs.push({
        type: cat.type,
        id: cat.id,
        name: cat.name,
        extra: [
          {
            name: 'genre',
            options: availableOptions,
            isRequired: false
          },
          {
            name: 'skip',
            isRequired: false
          }
        ]
      });
    }
  });

  // 4. Dynamic Custom AI Playlists for any other collections not in master categories
  const uncategorizedMovieOptions = [];
  const uncategorizedSeriesOptions = [];

  Object.values(collections).forEach(col => {
    if (!col || !col.name || !col.movies || col.movies.length === 0) return;
    const nameNorm = col.name.trim().toLowerCase();
    if (!categorizedSubgenreNames.has(nameNorm)) {
      if (col.movies.some(m => m.type !== 'series')) {
        if (!uncategorizedMovieOptions.includes(col.name)) {
          uncategorizedMovieOptions.push(col.name);
        }
      }
      if (col.movies.some(m => m.type === 'series')) {
        if (!uncategorizedSeriesOptions.includes(col.name)) {
          uncategorizedSeriesOptions.push(col.name);
        }
      }
    }
  });

  if (uncategorizedMovieOptions.length > 0) {
    catalogs.push({
      type: 'movie',
      id: 'cat_custom_ai_movies',
      name: '✨ Custom AI Playlists',
      extra: [
        {
          name: 'genre',
          options: uncategorizedMovieOptions,
          isRequired: false
        },
        {
          name: 'skip',
          isRequired: false
        }
      ]
    });
  }

  if (uncategorizedSeriesOptions.length > 0) {
    catalogs.push({
      type: 'series',
      id: 'cat_custom_ai_series',
      name: '✨ Custom AI TV Shows',
      extra: [
        {
          name: 'genre',
          options: uncategorizedSeriesOptions,
          isRequired: false
        },
        {
          name: 'skip',
          isRequired: false
        }
      ]
    });
  }

  const manifest = {
    id: 'org.subgenre.auto.catalog',
    version: '3.1.0',
    name: '🤖 AI Movie, TV & 24/7 Channels',
    description: '24/7 Live FAST Channels, Master Categories, Subgenre Dropdowns, Instant AI Search & Trailers!',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'tv', 'channel'],
    catalogs: catalogs,
    idPrefixes: ['tt', 'live_']
  };
  res.json(manifest);
});

// Stremio Catalog Endpoint for Movies, TV Series & 24/7 Live Channels
app.get('/catalog/:type/:id*', async (req, res) => {
  try {
    const rawPath = req.params.id + (req.params[0] || '');
    const parts = rawPath.replace(/\.json$/, '').split('/');
    const id = parts[0];
    const type = req.params.type;
    const extraStr = parts.slice(1).join('&');
    
    // Handle 24/7 Live Channels Catalog
    if (id === 'cat_247_channels' || type === 'tv' || type === 'channel') {
      const params = new URLSearchParams(extraStr);
      const selectedGenre = params.get('genre');
      const skip = parseInt(params.get('skip') || '0', 10);

      let items = liveChannels.map(ch => {
        const meta = { ...ch };
        const epg = getChannelEPG(ch);
        if (epg && epg.currentTitle) {
          meta.description = `🔴 LIVE NOW: ${epg.currentTitle}\n${epg.currentDesc ? `📖 Plot: ${epg.currentDesc}\n` : ''}⏭️ UP NEXT: ${epg.nextTitle}\n\n${ch.description || ''}`;
        }
        return meta;
      });

      if (selectedGenre && selectedGenre !== 'All Channels') {
        items = items.filter(ch => ch.genre === selectedGenre || (ch.genres && ch.genres.includes(selectedGenre)));
      }

      console.log(`[Stremio 24/7 Channels] Serving ${items.length} live channels (genre: "${selectedGenre || 'All'}", skip: ${skip})`);
      return res.json({ metas: items.slice(skip, skip + 100) });
    }

    // Handle Live AI Search Catalog
    if (id === 'ai_search' || id === 'ai_search_series') {
      const params = new URLSearchParams(extraStr);
      const query = params.get('search');
      const skip = parseInt(params.get('skip') || '0', 10);
      
      if (!query) return res.json({ metas: [] });
      
      const cacheKey = `${type}_${query.toLowerCase().trim()}`;
      
      if (searchCache[cacheKey] && (Date.now() - searchCache[cacheKey].timestamp < 86400000)) {
        console.log(`[AI Search] Serving cached results for ${type}: "${query}", skip: ${skip}`);
        const metas = searchCache[cacheKey].movies.slice(skip, skip + 100);
        return res.json({ metas });
      }
      
      console.log(`[AI Search] New search request for ${type}: "${query}"`);
      const tmdbKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
      
      try {
        // ── Intent Interpreter — normalize raw query before searching ─────────
        const intent = await interpretIntent(query);
        const searchTitle = intent?.title || query;
        const searchType  = intent?.type  || (id === 'ai_search_series' ? 'show' : 'movie');

        console.log(`[Intent] TITLE: "${searchTitle}" | YEAR: "${intent?.year || '?'}" | TYPE: ${searchType} | QUALITY: "${intent?.qualityTarget || 'any'}" | AUDIO: "${intent?.audioTarget || 'any'}" | SOURCE: "${intent?.sourcePriority || 'Easynews'}" | via: ${intent?.source || 'heuristic'}`);

        const rawItems = await queryGeminiForMovies(searchTitle, config.geminiApiKey, '', true);
        const batch = await Promise.all(
          rawItems.slice(0, 30).map(m => searchTmdbMovie(m.title, m.year, tmdbKey))
        );
        const stremioMetas = batch.filter(Boolean);
        
        searchCache[cacheKey] = {
          timestamp: Date.now(),
          movies: stremioMetas
        };
        
        console.log(`[AI Search] Generated ${stremioMetas.length} results for: "${searchTitle}"`);
        return res.json({ metas: stremioMetas.slice(skip, skip + 100) });
      } catch (err) {
        console.error('[AI Search] Failed to fulfill search request:', err.message);
        return res.json({ metas: [] });
      }
    }

    const extraParams = new URLSearchParams(extraStr);
    const selectedGenre = extraParams.get('genre');
    const skip = parseInt(extraParams.get('skip') || '0', 10);

    // Check if ID is a Master Category
    const masterCat = MASTER_CATEGORIES.find(c => c.id === id);
    const isCustomCat = (id === 'cat_custom_ai_movies' || id === 'cat_custom_ai_series');

    if (masterCat || isCustomCat) {
      if (selectedGenre) {
        // User selected a specific Subgenre from the dropdown
        const col = findCollectionByName(selectedGenre);
        if (!col || !col.movies) {
          return res.json({ metas: [] });
        }
        let items = col.movies;
        if (type === 'series') {
          items = items.filter(m => m.type === 'series');
        } else if (type === 'movie') {
          items = items.filter(m => m.type !== 'series');
        }
        console.log(`[Stremio Subgenre] Serving "${selectedGenre}" under ${id} (${type}, ${items.length} items, skip: ${skip})`);
        return res.json({ metas: sortMoviesByRating(items).slice(skip, skip + 100) });
      } else {
        // User opened top-level category without selecting a subgenre -> combine all subgenres
        let combined = [];
        const seenIds = new Set();
        
        const targetSubgenres = masterCat ? masterCat.subgenres : [];
        if (masterCat) {
          targetSubgenres.forEach(subName => {
            const col = findCollectionByName(subName);
            if (col && col.movies) {
              col.movies.forEach(m => {
                const itemType = m.type === 'series' ? 'series' : 'movie';
                if (itemType === type && !seenIds.has(m.id)) {
                  seenIds.add(m.id);
                  combined.push(m);
                }
              });
            }
          });
        } else {
          // Custom AI Playlists
          Object.values(collections).forEach(col => {
            if (col && col.movies) {
              col.movies.forEach(m => {
                const itemType = m.type === 'series' ? 'series' : 'movie';
                if (itemType === type && !seenIds.has(m.id)) {
                  seenIds.add(m.id);
                  combined.push(m);
                }
              });
            }
          });
        }
        
        console.log(`[Stremio Category] Serving combined ${id} (${type}, ${combined.length} total items, skip: ${skip})`);
        return res.json({ metas: sortMoviesByRating(combined).slice(skip, skip + 100) });
      }
    }

    // Direct / Legacy Collection ID lookup fallback
    const collection = collections[id];
    if (!collection) {
      return res.json({ metas: [] });
    }

    let items = collection.movies || [];
    if (type === 'series') {
      const seriesItems = items.filter(m => m.type === 'series');
      if (seriesItems.length > 0) items = seriesItems;
    } else if (type === 'movie') {
      const movieItems = items.filter(m => m.type !== 'series');
      if (movieItems.length > 0) items = movieItems;
    }

    console.log(`[Stremio Request] Serving direct collection ${id} (${type}, ${items.length} items, skip: ${skip})`);
    res.json({ metas: sortMoviesByRating(items).slice(skip, skip + 100) });
  } catch (e) {
    console.error('Error serving catalog:', e.message);
    res.status(500).json({ metas: [] });
  }
});

// Stremio Meta Detail Endpoint for Movies, TV Series & 24/7 Channels
app.get(['/meta/:type/:id.json', '/meta/tv/:id.json', '/meta/channel/:id.json', '/meta/movie/:id.json', '/meta/series/:id.json'], async (req, res) => {
  const { type, id } = req.params;
  const rawId = id.replace(/\.json$/, '');

  // 1. Check if ID is a 24/7 Live Channel
  if (rawId.startsWith('live_') || type === 'tv' || type === 'channel') {
    const channel = liveChannels.find(ch => ch.id === rawId);
    if (channel) {
      const meta = { ...channel };
      const epg = getChannelEPG(channel);
      if (epg && epg.currentTitle) {
        meta.description = `🔴 LIVE NOW: ${epg.currentTitle}\n${epg.currentDesc ? `📖 Plot: ${epg.currentDesc}\n` : ''}⏭️ UP NEXT: ${epg.nextTitle}\n\n${channel.description || ''}`;
      }
      return res.json({ meta });
    }
  }

  // 2. Lookup in subgenre collections
  let found = null;
  for (const collectionId in collections) {
    if (collections[collectionId].movies) {
      found = collections[collectionId].movies.find(m => m.id === rawId);
      if (found) break;
    }
  }

  if (found) {
    const meta = { ...found };

    // Fetch and embed YouTube trailer stream if missing
    if (!meta.trailerStreams || meta.trailerStreams.length === 0) {
      try {
        const apiKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
        let tmdbId = rawId;
        let isTv = type === 'series' || meta.type === 'series';

        if (rawId.startsWith('tt')) {
          const findRes = await fetchJson(`https://api.themoviedb.org/3/find/${rawId}?api_key=${apiKey}&external_source=imdb_id`);
          if (findRes) {
            if (findRes.tv_results && findRes.tv_results.length > 0 && isTv) {
              tmdbId = findRes.tv_results[0].id;
            } else if (findRes.movie_results && findRes.movie_results.length > 0) {
              tmdbId = findRes.movie_results[0].id;
            }
          }
        }

        const endpoint = isTv ? 'tv' : 'movie';
        const videosRes = await fetchJson(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/videos?api_key=${apiKey}`);
        if (videosRes && videosRes.results) {
          const trailer = videosRes.results.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')) ||
                          videosRes.results.find(v => v.site === 'YouTube');
          if (trailer) {
            meta.trailerStreams = [
              {
                title: 'Official YouTube Trailer',
                ytId: trailer.key
              }
            ];
            meta.trailers = [
              {
                source: trailer.key,
                type: 'Trailer'
              }
            ];
            meta.behaviorHints = {
              defaultVideoId: `ytId:${trailer.key}`
            };
          }
        }
      } catch (err) {
        console.error(`Trailer lookup error for ${rawId}:`, err.message);
      }
    }

    return res.json({ meta });
  } else {
    res.status(404).json({ error: 'Meta not found' });
  }
});

// Cloud Proxy endpoint for 24/7 streams to bypass regional geo-blocks
app.get('/live-proxy/:channelId/master.m3u8', async (req, res) => {
  const { channelId } = req.params;
  const channel = liveChannels.find(ch => ch.id === channelId);
  if (!channel || !channel.streamUrl) return res.status(404).send('Channel not found');

  try {
    const crypto = require('crypto');
    const devId = crypto.randomUUID();
    const sid = crypto.randomUUID();
    const base = channel.streamUrl.split('?')[0];
    const upstreamUrl = `${base}?advertisingId=&appName=web&appVersion=unknown&appStoreUrl=&architecture=&buildVersion=&clientDeviceType=0&deviceDNT=0&deviceId=${devId}&deviceLat=34.0522&deviceLon=-118.2437&deviceMake=Chrome&deviceModel=Chrome&deviceType=web&deviceVersion=unknown&includeExtendedEvents=false&sid=${sid}&userId=`;

    const upstreamRes = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Forwarded-For': '104.244.42.1'
      }
    });

    const manifestText = await upstreamRes.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(manifestText);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Stremio Stream Endpoint for 24/7 Live Channels & YouTube Trailers
app.get(['/stream/:type/:id.json', '/stream/tv/:id.json', '/stream/channel/:id.json', '/stream/movie/:id.json', '/stream/series/:id.json'], async (req, res) => {
  const { type, id } = req.params;
  const rawId = id.replace(/\.json$/, '');
  const apiKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';

  console.log(`[Stremio Stream Request] Type: ${type}, ID: ${rawId}`);

  // 1. Check if ID is a 24/7 Live Channel
  if (rawId.startsWith('live_') || type === 'tv' || type === 'channel') {
    const channel = liveChannels.find(ch => ch.id === rawId);
    if (channel && channel.streamUrl) {
      let finalUrl = channel.streamUrl;

      // Ensure Pluto TV HLS stitcher URLs contain required session headers
      if (finalUrl.includes('pluto.tv/stitch')) {
        const crypto = require('crypto');
        const devId = crypto.randomUUID();
        const sid = crypto.randomUUID();
        const base = finalUrl.split('?')[0];
        finalUrl = `${base}?advertisingId=&appName=web&appVersion=unknown&appStoreUrl=&architecture=&buildVersion=&clientDeviceType=0&deviceDNT=0&deviceId=${devId}&deviceLat=34.0522&deviceLon=-118.2437&deviceMake=Chrome&deviceModel=Chrome&deviceType=web&deviceVersion=unknown&includeExtendedEvents=false&sid=${sid}&userId=`;
      }

      const host = req.get('host') || 'stremio-subgenre-catalog.onrender.com';
      const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
      const proxyUrl = `${protocol}://${host}/live-proxy/${channel.id}/master.m3u8`;

      const epg = getChannelEPG(channel);
      const nowPlayingTitle = epg && epg.currentTitle ? `🔴 NOW PLAYING: ${epg.currentTitle}\n⏭️ Next: ${epg.nextTitle}` : `▶ Watch Live (1080p HD)\n${channel.name} • 24/7 Continuous Feed`;

      return res.json({
        streams: [
          {
            name: "📺 24/7 LIVE (Direct)",
            title: `${nowPlayingTitle}`,
            url: finalUrl,
            isFree: true,
            live: true,
            behaviorHints: {
              notWebReady: false
            }
          },
          {
            name: "🛡️ 24/7 UNBLOCKED (Cloud Mirror)",
            title: `🛡️ Unblocked Cloud Mirror\n${epg && epg.currentTitle ? `Playing: ${epg.currentTitle}` : channel.name}`,
            url: proxyUrl,
            isFree: true,
            live: true,
            behaviorHints: {
              notWebReady: false
            }
          }
        ]
      });
    }
  }

  // 2. Resolve Movie / Series details & Fetch Easynews Video Streams + YouTube Trailers
  try {
    let tmdbId = rawId;
    let isTv = type === 'series';
    let movieTitle = '';
    let movieYear = '';

    // Check if item is in our collections
    for (const colId in collections) {
      if (collections[colId].movies) {
        const foundM = collections[colId].movies.find(m => m.id === rawId);
        if (foundM) {
          movieTitle = foundM.name || foundM.title || '';
          movieYear = (foundM.releaseInfo || foundM.year || '').toString().slice(0, 4);
          break;
        }
      }
    }

    // If ID starts with 'tt', resolve via TMDB find endpoint
    if (rawId.startsWith('tt')) {
      const findRes = await fetchJson(`https://api.themoviedb.org/3/find/${rawId}?api_key=${apiKey}&external_source=imdb_id`);
      if (findRes) {
        if (findRes.tv_results && findRes.tv_results.length > 0 && (isTv || !findRes.movie_results || findRes.movie_results.length === 0)) {
          tmdbId = findRes.tv_results[0].id;
          movieTitle = movieTitle || findRes.tv_results[0].name || findRes.tv_results[0].original_name || '';
          movieYear = movieYear || (findRes.tv_results[0].first_air_date || '').slice(0, 4);
          isTv = true;
        } else if (findRes.movie_results && findRes.movie_results.length > 0) {
          tmdbId = findRes.movie_results[0].id;
          movieTitle = movieTitle || findRes.movie_results[0].title || findRes.movie_results[0].original_title || '';
          movieYear = movieYear || (findRes.movie_results[0].release_date || '').slice(0, 4);
        }
      }
    }

    const streams = [];

    // ── Metadata Enricher — validate & enrich title, year, runtime, genres ───
    let enrichedMeta = null;
    if (tmdbId || rawId.startsWith('tt')) {
      enrichedMeta = await enrichMetadata(
        rawId.startsWith('tt') ? rawId : null,
        typeof tmdbId === 'number' ? tmdbId : null,
        movieTitle, movieYear, isTv, apiKey
      );
      // Prefer the enriched official title and corrected year for search accuracy
      if (enrichedMeta.enriched) {
        if (enrichedMeta.officialTitle) movieTitle = enrichedMeta.officialTitle;
        if (enrichedMeta.year)          movieYear  = enrichedMeta.year;
      }
    }

    // ── Routing Orchestrator — choose best source, fallback on failure ────────
    if (movieTitle) {
      const routing = decideRouting(movieTitle, movieYear);

      console.log('[Router] ROUTING_DECISION:');
      console.log(`  Primary Source  : ${routing.primary || 'none'}`);
      console.log(`  Secondary Source: ${routing.secondary || 'none'}`);
      console.log(`  Fallback        : ${routing.fallback}`);
      routing.notes.forEach(n => console.log(`  Note: ${n}`));

      // Try primary source
      let sourceStreams = [];
      if (routing.primary) {
        sourceStreams = await fetchFromSource(
          routing.primary, movieTitle, movieYear,
          process.env.EASYNEWS_USER || 'aibutzkxjw',
          process.env.EASYNEWS_PASS || 'hjmm-rwbe-pkbg',
          enrichedMeta?.runtime || 120
        );
      }

      // Primary returned nothing — activate secondary
      if (sourceStreams.length === 0 && routing.secondary) {
        console.log(`[Router] Primary source dry — activating secondary: ${routing.secondary}`);
        sourceStreams = await fetchFromSource(
          routing.secondary, movieTitle, movieYear,
          process.env.EASYNEWS_USER || 'aibutzkxjw',
          process.env.EASYNEWS_PASS || 'hjmm-rwbe-pkbg',
          enrichedMeta?.runtime || 120
        );
      }

      if (sourceStreams.length > 0) {
        streams.push(...sourceStreams);
      } else {
        console.log('[Router] All sources returned 0 streams — YouTube trailer fallback active.');
      }
      // YouTube trailer fallback is always appended below regardless
    }

    // Fetch YouTube Trailers as fallback
    const endpoint = isTv ? 'tv' : 'movie';
    const videosRes = await fetchJson(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/videos?api_key=${apiKey}`);

    if (videosRes && videosRes.results) {
      const trailers = videosRes.results.filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
      const allYoutube = videosRes.results.filter(v => v.site === 'YouTube');
      const selected = trailers.length > 0 ? trailers : allYoutube;

      selected.slice(0, 3).forEach(v => {
        streams.push({
          name: "🎬 YouTube Trailer",
          title: `🎬 ${v.name || 'Official Trailer'}`,
          ytId: v.key,
          behaviorHints: {
            notWebReady: false
          }
        });
      });
    }

    res.json({ streams });
  } catch (err) {
    console.error(`Stream lookup error for ${rawId}:`, err.message);
    res.json({ streams: [] });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTENT INTERPRETER — Normalize Raw User Queries into Structured Intent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * interpretIntent(rawQuery)
 *
 * Uses Gemini to decode a natural-language or messy user search query into
 * a clean structured object ready for downstream pipeline nodes.
 *
 * Returns:
 * {
 *   title:          string,   // canonical title
 *   year:           string,   // 4-digit year or ''
 *   type:           'movie' | 'show' | 'season' | 'episode',
 *   qualityTarget:  string,   // e.g. '2160p', '1080p', 'Remux'
 *   audioTarget:    string,   // e.g. 'Atmos', '5.1', 'DTS-HD'
 *   sourcePriority: string,   // e.g. 'Easynews', 'TorBox', 'Hybrid'
 *   season:         string,   // 'S02' or ''
 *   episode:        string,   // 'E05' or ''
 *   notes:          string,   // anything extra the user said
 *   raw:            string    // original query preserved
 * }
 *
 * Falls back to a best-effort heuristic parse if Gemini is unavailable.
 */
async function interpretIntent(rawQuery) {
  const query = (rawQuery || '').trim();
  if (!query) return null;

  // ── Heuristic fallback (always available, ~0ms) ──────────────────────────
  const heuristic = () => {
    const yearMatch   = query.match(/\b(19|20)\d{2}\b/);
    const seasonMatch = query.match(/\bS(\d{1,2})\b/i);
    const episodeMatch= query.match(/\bE(\d{1,2})\b/i);
    const is4K        = /\b(4k|2160p|uhd)\b/i.test(query);
    const isRemux     = /\bremux\b/i.test(query);
    const is1080      = /\b1080p?\b/i.test(query);
    const hasAtmos    = /\batmos\b/i.test(query);
    const hasDtsHd    = /\bdts.?hd\b/i.test(query);
    const has51       = /\b5\.1\b/.test(query);
    const isSeries    = /\b(season|episode|series|show|s\d{2}e\d{2})\b/i.test(query);

    // Strip year, season/episode tags, quality tags to get a cleaner title
    let title = query
      .replace(/\b(19|20)\d{2}\b/, '')
      .replace(/\bS\d{1,2}E\d{1,2}\b/i, '')
      .replace(/\bS\d{1,2}\b/i, '')
      .replace(/\b(4k|2160p|uhd|1080p|remux|atmos|dts|bluray|blu-ray|hdr)\b/ig, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return {
      title,
      year:           yearMatch ? yearMatch[0] : '',
      type:           isSeries ? (episodeMatch ? 'episode' : seasonMatch ? 'season' : 'show') : 'movie',
      qualityTarget:  isRemux ? 'Remux' : is4K ? '2160p' : is1080 ? '1080p' : '',
      audioTarget:    hasAtmos ? 'Atmos' : hasDtsHd ? 'DTS-HD' : has51 ? '5.1' : '',
      sourcePriority: 'Easynews',
      season:         seasonMatch ? `S${seasonMatch[1].padStart(2, '0')}` : '',
      episode:        episodeMatch ? `E${episodeMatch[1].padStart(2, '0')}` : '',
      notes:          '',
      raw:            query,
      source:         'heuristic'
    };
  };

  // ── Gemini-powered parse (when API key is available) ─────────────────────
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return heuristic();

  const prompt = `You are a strict intent parser for a video streaming search engine.
Parse the user query into this exact JSON object (no markdown, no commentary):
{
  "title": "canonical movie or show title",
  "year": "YYYY or empty string",
  "type": "movie | show | season | episode",
  "qualityTarget": "2160p | 1080p | 720p | Remux | empty string",
  "audioTarget": "Atmos | TrueHD | DTS-HD | 5.1 | 2.0 | empty string",
  "sourcePriority": "Easynews | TorBox | Debrid | Hybrid | Easynews",
  "season": "S01 format or empty string",
  "episode": "E01 format or empty string",
  "notes": "anything else the user mentioned"
}

User query: "${query}"`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.0 }
        })
      }
    );
    clearTimeout(timeoutId);

    if (!resp.ok) return heuristic();
    const data = await resp.json();
    let text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    text = text.replace(/```json|```/gi, '').trim();

    const parsed = JSON.parse(text);
    parsed.raw    = query;
    parsed.source = 'gemini';
    console.log(`[Intent] Gemini parsed: title="${parsed.title}" year="${parsed.year}" type="${parsed.type}" quality="${parsed.qualityTarget}"`);
    return parsed;
  } catch (err) {
    console.warn('[Intent] Gemini parse failed — using heuristic fallback:', err.name === 'AbortError' ? 'timeout' : err.message);
    return heuristic();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// METADATA ENRICHER — TMDB-backed Enrichment with In-Memory LRU Cache
// ─────────────────────────────────────────────────────────────────────────────

// Simple LRU cache — max 200 entries, keyed by imdbId or `tmdb_${tmdbId}`
const metadataCache = new Map();
const METADATA_CACHE_MAX = 200;

function cacheSet(key, value) {
  if (metadataCache.size >= METADATA_CACHE_MAX) {
    // Evict the oldest entry
    metadataCache.delete(metadataCache.keys().next().value);
  }
  metadataCache.set(key, value);
}

/**
 * enrichMetadata(imdbId, tmdbId, title, year, isTv, apiKey)
 *
 * Fetches full details from TMDB, corrects title/year mismatches, and returns
 * a clean enriched object used by downstream nodes (ranker, router, stream title).
 *
 * Returns:
 * {
 *   imdbId, tmdbId, officialTitle, year, runtime,
 *   genres, cast, language, overview, posterUrl, enriched: true
 * }
 *
 * On failure returns a minimal passthrough object with enriched: false.
 */
async function enrichMetadata(imdbId, tmdbId, title, year, isTv = false, apiKey) {
  const key = imdbId || `tmdb_${tmdbId}`;
  if (metadataCache.has(key)) {
    return metadataCache.get(key);
  }

  const fallback = {
    imdbId:       imdbId || null,
    tmdbId:       tmdbId || null,
    officialTitle: title,
    year,
    runtime:      120, // default assumption
    genres:       [],
    cast:         [],
    language:     'en',
    overview:     '',
    posterUrl:    '',
    enriched:     false
  };

  const tmdbApiKey = apiKey || config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  if (!tmdbId && !imdbId) return fallback;

  try {
    const endpoint = isTv ? 'tv' : 'movie';
    const detailsId = tmdbId || imdbId;

    // If only IMDB ID, first resolve to TMDB ID
    let resolvedTmdbId = tmdbId;
    if (!resolvedTmdbId && imdbId) {
      const findRes = await fetchJson(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id`
      );
      if (isTv && findRes?.tv_results?.length > 0) {
        resolvedTmdbId = findRes.tv_results[0].id;
      } else if (findRes?.movie_results?.length > 0) {
        resolvedTmdbId = findRes.movie_results[0].id;
      }
    }

    if (!resolvedTmdbId) return fallback;

    // Fetch full details with cast in one call via append_to_response
    const details = await fetchJson(
      `https://api.themoviedb.org/3/${endpoint}/${resolvedTmdbId}?api_key=${tmdbApiKey}&append_to_response=credits,external_ids`
    );

    if (!details || details.status_code) return fallback;

    // Resolve fields — TV and movie schemas differ slightly
    const officialTitle = (isTv ? details.name : details.title) || details.original_title || details.original_name || title;
    const releaseDate   = isTv ? details.first_air_date : details.release_date;
    const enrichedYear  = releaseDate ? releaseDate.slice(0, 4) : year;
    const runtime       = isTv
      ? (details.episode_run_time?.[0] || 45)   // TV episode runtime
      : (details.runtime || 120);                // Movie runtime

    const genres = (details.genres || []).map(g => g.name);
    const cast   = (details.credits?.cast || [])
      .slice(0, 8)
      .map(c => c.name);
    const language  = details.original_language || 'en';
    const overview  = details.overview || '';
    const posterUrl = details.poster_path
      ? `https://image.tmdb.org/t/p/w500${details.poster_path}`
      : '';

    // IMDB ID from external_ids if not already known
    const resolvedImdbId = imdbId || details.external_ids?.imdb_id || null;

    const enriched = {
      imdbId:       resolvedImdbId,
      tmdbId:       resolvedTmdbId,
      officialTitle,
      year:         enrichedYear,
      runtime,
      genres,
      cast,
      language,
      overview,
      posterUrl,
      enriched:     true
    };

    cacheSet(key, enriched);

    console.log(`[Enricher] "${officialTitle}" (${enrichedYear}) | Runtime: ${runtime}min | Genres: ${genres.slice(0, 3).join(', ')} | Cast: ${cast.slice(0, 3).join(', ')}`);
    return enriched;

  } catch (err) {
    console.warn('[Enricher] TMDB enrichment failed:', err.message);
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTING ORCHESTRATOR — Predictive Source Selection + Fallback Logic
// ─────────────────────────────────────────────────────────────────────────────

// In-memory success/failure history per source (resets on server restart)
const routingHistory = {
  easynews: { hits: 0, misses: 0 },
  torbox:   { hits: 0, misses: 0 },
  debrid:   { hits: 0, misses: 0 }
};

/** Record a hit or miss for a source after each stream attempt. */
function recordRouteResult(source, success) {
  if (!routingHistory[source]) routingHistory[source] = { hits: 0, misses: 0 };
  if (success) routingHistory[source].hits++;
  else         routingHistory[source].misses++;
}

/** Success rate (0.0–1.0). Returns 1.0 if no history yet (optimistic start). */
function successRate(source) {
  const h = routingHistory[source] || { hits: 0, misses: 0 };
  const total = h.hits + h.misses;
  return total === 0 ? 1.0 : h.hits / total;
}

/**
 * decideRouting(title, year, options)
 *
 * Routing priority rules:
 *  1. Highest historical success rate wins primary slot.
 *  2. Sources below 20% success rate are demoted to last resort.
 *  3. Secondary = next-best available source.
 *  4. Fallback = youtube_trailer (always available via TMDB).
 *
 * Returns: { primary, secondary, fallback, notes }
 */
function decideRouting(title, year, options = {}) {
  const notes = [];

  const hasEasynews = true; // always present (hardcoded credentials as default)
  const hasTorBox   = !!(process.env.TORBOX_API_KEY || config.torboxApiKey);
  const hasDebrid   = !!(process.env.DEBRID_API_KEY  || config.debridApiKey);

  const candidates = [];

  if (hasEasynews) {
    const rate = successRate('easynews');
    candidates.push({ source: 'easynews', rate, priority: 1 });
    notes.push(`Easynews success rate: ${(rate * 100).toFixed(0)}%`);
  }
  if (hasTorBox) {
    const rate = successRate('torbox');
    candidates.push({ source: 'torbox', rate, priority: 2 });
    notes.push(`TorBox success rate: ${(rate * 100).toFixed(0)}%`);
  }
  if (hasDebrid) {
    const rate = successRate('debrid');
    candidates.push({ source: 'debrid', rate, priority: 3 });
    notes.push(`Debrid success rate: ${(rate * 100).toFixed(0)}%`);
  }

  if (candidates.length === 0) {
    notes.push('No stream sources configured — YouTube trailer fallback only.');
    return { primary: null, secondary: null, fallback: 'youtube_trailer', notes };
  }

  // Sort: highest success rate first; break ties by default priority
  candidates.sort((a, b) => b.rate - a.rate || a.priority - b.priority);

  // Demote sources with catastrophically low rates but never drop all of them
  const viable = candidates.filter(c => c.rate >= 0.2);
  const ranked = viable.length > 0 ? viable : candidates;

  const primary   = ranked[0]?.source || null;
  const secondary = ranked[1]?.source || null;

  if (ranked[0] && ranked[0].rate < 0.5 && (ranked[0].hits + ranked[0].misses) > 0) {
    notes.push(`⚠️ Primary "${primary}" is degraded (${(ranked[0].rate * 100).toFixed(0)}% success rate).`);
  }
  if (secondary) {
    notes.push(`Secondary "${secondary}" — activates if primary returns 0 streams.`);
  }

  return { primary, secondary, fallback: 'youtube_trailer', notes };
}

/**
 * fetchFromSource — dispatches to the correct search function,
 * records the outcome into routingHistory.
 */
async function fetchFromSource(source, title, year, username, password, runtimeMinutes = 120) {
  try {
    let streams = [];
    if      (source === 'easynews') streams = await searchEasynews(title, year, username, password, runtimeMinutes);
    else if (source === 'torbox')   streams = await searchTorBox(title, year);
    else if (source === 'debrid')   streams = await searchDebrid(title, year);
    recordRouteResult(source, streams.length > 0);
    console.log(`[Router] Source "${source}" returned ${streams.length} streams.`);
    return streams;
  } catch (err) {
    console.error(`[Router] Source "${source}" threw an error:`, err.message);
    recordRouteResult(source, false);
    return [];
  }
}

// ── TorBox stub — wire your real TorBox API here ──────────────────────────────
async function searchTorBox(title, year) {
  const apiKey = process.env.TORBOX_API_KEY || config.torboxApiKey;
  if (!apiKey) return [];
  // TODO: implement real TorBox /torrents/search endpoint:
  // const res = await fetch(
  //   `https://api.torbox.app/v1/api/torrents/search?query=${encodeURIComponent(title + ' ' + year)}&limit=20`,
  //   { headers: { 'Authorization': `Bearer ${apiKey}` } }
  // );
  // const data = await res.json();
  // Parse results → parseReleaseMetadata() → scoreStream() → sort → return Stremio stream objects
  console.log('[TorBox] Stub — configure TORBOX_API_KEY to enable.');
  return [];
}

// ── Debrid stub — wire your real Real-Debrid / AllDebrid API here ─────────────
async function searchDebrid(title, year) {
  const apiKey = process.env.DEBRID_API_KEY || config.debridApiKey;
  if (!apiKey) return [];
  // TODO: implement Real-Debrid /torrents or AllDebrid unrestrict.link endpoint
  console.log('[Debrid] Stub — configure DEBRID_API_KEY to enable.');
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// AI QUALITY RANKER — Layer 1: Release Metadata Parser
// ─────────────────────────────────────────────────────────────────────────────
function parseReleaseMetadata(filename, sizeBytes = 0, runtimeMinutes = 120) {
  const f = filename.toUpperCase();

  // Resolution
  let resolution = 'SD';
  if (/\b(2160P|4K|UHD)\b/.test(f)) resolution = '4K';
  else if (/\b(1080P|FHD)\b/.test(f)) resolution = '1080p';
  else if (/\b(720P)\b/.test(f)) resolution = '720p';
  else if (/\b(480P|576P)\b/.test(f)) resolution = '480p';

  // Dynamic Range
  let dynamicRange = 'SDR';
  if (/\b(DOVI|DOLBY\.?VISION|DV)\b/.test(f)) dynamicRange = 'DoVi';
  else if (/HDR10\+/.test(f)) dynamicRange = 'HDR10+';
  else if (/\bHDR\b/.test(f)) dynamicRange = 'HDR';

  // Video Codec
  let videoCodec = 'Unknown';
  let isRemux = false;
  if (/\bREMUX\b/.test(f)) { videoCodec = 'REMUX'; isRemux = true; }
  else if (/\b(X265|H\.?265|HEVC)\b/.test(f)) videoCodec = 'HEVC';
  else if (/\b(X264|H\.?264|AVC)\b/.test(f)) videoCodec = 'AVC';
  else if (/\bAV1\b/.test(f)) videoCodec = 'AV1';

  // Audio Codec
  let audioCodec = 'Unknown';
  if (/TRUEHD.{0,10}ATMOS|ATMOS.{0,10}TRUEHD/.test(f)) audioCodec = 'TrueHD Atmos';
  else if (/\bTRUEHD\b/.test(f)) audioCodec = 'TrueHD';
  else if (/DTS[-.]?HD.{0,6}MA/.test(f)) audioCodec = 'DTS-HD MA';
  else if (/DTS[-.]?X\b/.test(f)) audioCodec = 'DTS-X';
  else if (/\b(EAC3|DD\+|DDPLUS|DOLBY\.?DIGITAL\.?PLUS)\b/.test(f)) audioCodec = 'DD+';
  else if (/\bDTS\b/.test(f)) audioCodec = 'DTS';
  else if (/\bAAC\b/.test(f)) audioCodec = 'AAC';
  else if (/\bAC3\b/.test(f)) audioCodec = 'AC3';
  else if (/\bMP3\b/.test(f)) audioCodec = 'MP3';

  // Audio Channels
  let audioChannels = '';
  if (/7\.1/.test(f)) audioChannels = '7.1';
  else if (/5\.1/.test(f)) audioChannels = '5.1';
  else if (/2\.0/.test(f)) audioChannels = '2.0';

  // Container
  let container = 'mkv';
  const extMatch = filename.match(/\.(mkv|mp4|avi|ts|m2ts|mov)$/i);
  if (extMatch) container = extMatch[1].toLowerCase();

  // Multi-part RAR — not direct-streamable by Stremio
  const isMultiPart = /\.(rar|r\d{2})$/i.test(filename) || /\.part\d+\.rar$/i.test(filename);

  // Release group — segment after last dash/dot before extension
  let releaseGroup = 'Unknown';
  const groupMatch = filename.replace(/\.(mkv|mp4|avi|ts|m2ts|mov|rar)$/i, '').match(/[-.]([A-Za-z0-9]+)$/);
  if (groupMatch) releaseGroup = groupMatch[1].toUpperCase();

  // File size & estimated bitrate (120-min default runtime)
  const sizeGb = sizeBytes > 0 ? sizeBytes / (1024 ** 3) : 0;
  const bitrateEstimate = sizeGb > 0 ? (sizeGb * 8192) / (runtimeMinutes || 120) : 0; // Mbps

  return {
    resolution, dynamicRange, videoCodec, isRemux,
    audioCodec, audioChannels, container, isMultiPart,
    releaseGroup, sizeGb, bitrateEstimate
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI QUALITY RANKER — Layer 2: Deterministic Scorer (0–100)
// ─────────────────────────────────────────────────────────────────────────────
function scoreStream(meta) {
  let score = 0;

  // ── Video Quality (max 35 pts) ──────────────────────────────────────────
  const resScore = { '4K': 35, '1080p': 28, '720p': 18, '480p': 8, 'SD': 5 };
  score += resScore[meta.resolution] || 8;

  // Dynamic range bonus
  if (meta.dynamicRange === 'DoVi') score += 4;
  else if (meta.dynamicRange === 'HDR10+') score += 3;
  else if (meta.dynamicRange === 'HDR') score += 2;

  // Codec bonus
  if (meta.isRemux) score += 5;
  else if (meta.videoCodec === 'HEVC') score += 3;
  else if (meta.videoCodec === 'AV1') score += 2;

  // Bitrate sanity penalties
  if (meta.resolution === '4K') {
    if (meta.bitrateEstimate > 0 && meta.bitrateEstimate < 15) score -= 8;
    if (meta.bitrateEstimate > 80) score -= 3;
  } else if (meta.resolution === '1080p') {
    if (meta.bitrateEstimate > 0 && meta.bitrateEstimate < 5) score -= 6;
  }

  // ── Audio Quality (max 20 pts) ──────────────────────────────────────────
  const audioScore = {
    'TrueHD Atmos': 20, 'TrueHD': 17, 'DTS-HD MA': 16, 'DTS-X': 15,
    'DD+': 11, 'DTS': 10, 'AC3': 7, 'AAC': 6, 'MP3': 2, 'Unknown': 4
  };
  score += audioScore[meta.audioCodec] || 4;
  if (meta.audioChannels === '7.1') score += 2;
  else if (meta.audioChannels === '5.1') score += 1;

  // ── Release Group Reputation (max 20 pts) ──────────────────────────────
  const TIER1 = new Set(['FRAMESTR', 'FRAMESTOR', 'EPSILON', 'FLUX', 'DON', 'PLAYBD', 'HIFI', 'BHYS', 'JETIX', 'MZABI']);
  const TIER2 = new Set(['QXR', 'CTRLHD', 'DZ0N3', 'NCMT', 'HIDT', 'SBEASTS', 'TIGOLE', 'BHDSTUDIO', 'TEPES', 'LAZYCUNTS']);
  const TIER3 = new Set(['YIFY', 'YTS', 'GALAXYRG', 'PSA', 'MEGUSTA', 'EZTV', 'ETTV', 'ION10', 'SPARKS', 'RARBG']);

  const grp = meta.releaseGroup.replace(/[-_.]/g, '');
  if (TIER1.has(grp)) score += 20;
  else if (TIER2.has(grp)) score += 15;
  else if (TIER3.has(grp)) score += 5;
  else score += 10; // Unknown — neutral

  // ── Playback Stability (max 25 pts) ────────────────────────────────────
  if (meta.isMultiPart) {
    score -= 20; // Cannot direct-stream in Stremio
  } else if (meta.container === 'mkv' || meta.container === 'mp4') {
    score += 25;
  } else if (meta.container === 'ts' || meta.container === 'm2ts') {
    score += 20;
  } else if (meta.container === 'avi') {
    score += 12;
  } else {
    score += 10;
  }

  // File too small to be legit for declared resolution
  if (meta.resolution === '4K' && meta.sizeGb > 0 && meta.sizeGb < 5) score -= 10;
  else if (meta.resolution === '1080p' && meta.sizeGb > 0 && meta.sizeGb < 0.5) score -= 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─────────────────────────────────────────────────────────────────────────────
// AI QUALITY RANKER — Layer 3: Optional Gemini Re-Ranker (3 s hard timeout)
// ─────────────────────────────────────────────────────────────────────────────
async function rankWithGemini(candidates, movieTitle) {
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || candidates.length === 0) return candidates;

  const summaries = candidates.slice(0, 10).map((c, i) => ({
    index: i,
    filename: c._rawName,
    score: c._score,
    resolution: c._meta.resolution,
    videoCodec: c._meta.videoCodec,
    audioCodec: c._meta.audioCodec,
    group: c._meta.releaseGroup,
    sizeGb: c._meta.sizeGb.toFixed(2)
  }));

  const prompt = `You are an AI stream quality ranker for the movie "${movieTitle}".
Below are Usenet releases with deterministic quality scores (0-100).
Adjust each score by at most ±10 based on release group reputation, bitrate sanity, or known bad encodes.
Return ONLY a raw JSON array — no markdown: [{"index":0,"adjustedScore":92},...]

Releases:
${JSON.stringify(summaries)}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );
    clearTimeout(timeoutId);

    if (!resp.ok) return candidates;
    const data = await resp.json();
    let text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    text = text.replace(/```json|```/gi, '').trim();

    let adjustments;
    try { adjustments = JSON.parse(text); } catch { return candidates; }

    if (Array.isArray(adjustments)) {
      adjustments.forEach(adj => {
        if (typeof adj.index === 'number' && candidates[adj.index]) {
          candidates[adj.index]._score = Math.max(0, Math.min(100, Math.round(adj.adjustedScore)));
          candidates[adj.index]._aiRanked = true;
        }
      });
      console.log(`[AI Ranker] Gemini re-ranked ${adjustments.length} streams for "${movieTitle}".`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[AI Ranker] Gemini re-rank timed out — falling back to deterministic scores.');
    } else {
      console.warn('[AI Ranker] Gemini re-rank skipped:', err.message);
    }
  }

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Match Verification & Clean Filename Extraction
// ─────────────────────────────────────────────────────────────────────────────
function extractCleanReleaseName(fn, ext, rawName) {
  if (fn && fn.length > 5 && !/^[a-f0-9]{20,}$/i.test(fn)) {
    return fn.endsWith(ext) ? fn : fn + ext;
  }
  const match = (rawName || '').match(/"([^"]+\.(mkv|mp4|avi|ts|m2ts))"/i) 
             || (rawName || '').match(/([a-zA-Z0-9._-]+\.(mkv|mp4|avi|ts|m2ts))/i);
  if (match) return match[1];
  return (fn + ext) || rawName || 'Unknown Release';
}

function isLikelyMovieMatch(filename, title, year = '') {
  if (!filename || !title) return true;

  const cleanStr = (s) => (s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanFn = cleanStr(filename);
  const cleanTitle = cleanStr(title);

  const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'movie', 'film', 'part', 'vol']);
  const titleTokens = cleanTitle.split(' ').filter(w => w.length >= 2 && !stopWords.has(w));

  if (titleTokens.length === 0) return true;

  // Check how many title words appear in the filename
  const matchedTokens = titleTokens.filter(token => cleanFn.includes(token));
  const matchRatio = matchedTokens.length / titleTokens.length;

  // If fewer than half of significant title words match, reject
  if (matchRatio < 0.5 && matchedTokens.length < 2) {
    return false;
  }

  // If target year is present, verify against years found in filename
  if (year && /^\d{4}$/.test(String(year))) {
    const targetYear = parseInt(year, 10);
    const fnYears = filename.match(/\b(19\d{2}|20\d{2})\b/g);
    if (fnYears && fnYears.length > 0) {
      const yearDiffs = fnYears.map(y => Math.abs(parseInt(y, 10) - targetYear));
      const hasCloseYear = yearDiffs.some(diff => diff <= 1);
      // If filename has a specific year that differs by > 2 years, reject wrong release
      if (!hasCloseYear && yearDiffs.every(diff => diff > 2)) {
        return false;
      }
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Easynews Search + AI Quality Ranking Pipeline
// ─────────────────────────────────────────────────────────────────────────────
async function searchEasynews(title, year = '', username = 'aibutzkxjw', password = 'hjmm-rwbe-pkbg', runtimeMinutes = 120) {
  try {
    const query = `${title} ${year}`.trim();
    // Fetch 30 candidates so the ranker has a real pool to work with
    const searchUrl = `https://members.easynews.com/2.0/search/solr-search/?gps=${encodeURIComponent(query)}&fty[]=VIDEO&pby=30&sb=1`;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const res = await fetch(searchUrl, {
      headers: { 'Authorization': authHeader, 'User-Agent': 'Mozilla/5.0' }
    });

    if (!res.ok) {
      console.warn(`[Easynews] Search returned HTTP ${res.status} for "${query}"`);
      return [];
    }

    const data = await res.json();
    const items = data.data || [];

    // ── Parse & score each result ─────────────────────────────────────────
    const candidates = [];

    for (const item of items) {
      const hash    = item['0'] || item['hash'];
      const fn      = item['10'] || item['fn'] || '';
      const ext     = item['11'] || item['extension'] || '.mkv';
      const rawName = item['6'] || item['subject'] || `${fn}${ext}`;
      const rawSize = item['4'] || item['size'] || item['rawSize'] || 0;

      if (!hash || (!fn && !rawName)) continue;

      const fullFilename = extractCleanReleaseName(fn, ext, rawName);

      // Skip unplayable multi-part RARs up-front
      if (/\.(r\d{2}|rar)$/i.test(fullFilename) || /\.part\d+\.rar$/i.test(fullFilename)) {
        console.log(`[AI Ranker] Skipping unplayable multi-part RAR: ${fullFilename}`);
        continue;
      }

      // Skip title/year mismatches (wrong movie from Usenet index)
      if (!isLikelyMovieMatch(fullFilename, title, year)) {
        console.log(`[AI Ranker] Skipping title mismatch: "${fullFilename}" for target "${title}" (${year})`);
        continue;
      }

      const meta  = parseReleaseMetadata(fullFilename, rawSize, runtimeMinutes);
      const score = scoreStream(meta);
      const streamUrl = `https://${username}:${password}@members.easynews.com/dl/${hash}/${encodeURIComponent(fn ? fn + ext : fullFilename)}`;

      candidates.push({
        _rawName: rawName,
        _filename: fullFilename,
        _score: score,
        _meta: meta,
        _aiRanked: false,
        streamUrl
      });
    }

    if (candidates.length === 0) return [];

    // ── Optional Gemini re-rank (parallel to avoid blocking) ─────────────
    await rankWithGemini(candidates, title);

    // ── Sort best → worst ─────────────────────────────────────────────────
    candidates.sort((a, b) => b._score - a._score);

    console.log(`[AI Ranker] Ranked ${candidates.length} streams for "${title}" — top score: ${candidates[0]._score}`);

    // ── Build enriched Stremio stream objects ─────────────────────────────
    return candidates.map((c, i) => {
      const m = c._meta;
      const rank = i + 1;
      const scoreLabel  = c._aiRanked ? `[AI: ${c._score}]` : `[Score: ${c._score}]`;
      const recommended = c._score >= 75 ? '✅ Recommended'
                        : c._score >= 50 ? '⚠️ Acceptable'
                        : '❌ Low Quality';

      // Build compact quality line
      const drBadge    = m.dynamicRange !== 'SDR' ? ` ${m.dynamicRange}` : '';
      const codecBadge = m.isRemux ? ' REMUX' : (m.videoCodec !== 'Unknown' ? ` ${m.videoCodec}` : '');
      const audioBadge = m.audioCodec !== 'Unknown'
                          ? `${m.audioCodec}${m.audioChannels ? ' ' + m.audioChannels : ''}`
                          : 'Audio';
      const sizeBadge  = m.sizeGb > 0 ? `📦 ${m.sizeGb.toFixed(1)} GB` : '';
      const groupBadge = m.releaseGroup !== 'Unknown' ? `🏷️ ${m.releaseGroup}` : '';

      const qualityLine = `🎬 ${m.resolution}${drBadge}${codecBadge} | ${audioBadge}`;
      const metaLine    = [sizeBadge, groupBadge].filter(Boolean).join(' | ');

      return {
        name: `Easynews\n${m.resolution} ${m.isRemux ? 'REMUX' : (m.videoCodec !== 'Unknown' ? m.videoCodec : '')}`.trim(),
        title: `📁 ${c._filename}\n${qualityLine}\n${metaLine ? metaLine + ' | ' : ''}${recommended} (${scoreLabel})`,
        url: c.streamUrl,
        behaviorHints: { notWebReady: false }
      };
    });

  } catch (err) {
    console.error('[Easynews] Search error:', err.message);
    return [];
  }
}

// REST API for Dashboard UI
app.get('/api/subgenres', (req, res) => {
  res.json(SUBGENRES);
});

// Routing Orchestrator status — live hit/miss counts and success rates per source
app.get('/api/routing', (req, res) => {
  const status = {};
  for (const [source, data] of Object.entries(routingHistory)) {
    const total = data.hits + data.misses;
    status[source] = {
      hits: data.hits,
      misses: data.misses,
      total,
      successRate: total === 0 ? 'No data yet' : `${((data.hits / total) * 100).toFixed(1)}%`
    };
  }
  const decision = decideRouting('(status check)', '');
  res.json({
    history: status,
    currentDecision: {
      primary: decision.primary,
      secondary: decision.secondary,
      fallback: decision.fallback,
      notes: decision.notes
    }
  });
});

// Debug/Standalone endpoint for Intent Interpreter
app.get('/api/interpret', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing ?q= parameter' });
  const intent = await interpretIntent(query);
  res.json(intent);
});

// Debug/Standalone endpoint for Metadata Enricher
app.get('/api/metadata', async (req, res) => {
  const { imdbId, tmdbId, title, year, isTv } = req.query;
  const meta = await enrichMetadata(
    imdbId || null,
    tmdbId ? parseInt(tmdbId, 10) : null,
    title || '',
    year || '',
    isTv === 'true'
  );
  res.json(meta);
});

app.get('/api/collections', (req, res) => {
  res.json(collections);
});

app.post('/api/sync-collections', (req, res) => {
  try {
    const clientCollections = req.body;
    // Only merge client collections if server collections are empty
    if (clientCollections && typeof clientCollections === 'object' && Object.keys(collections).length === 0) {
      let updated = false;
      for (const id in clientCollections) {
        if (clientCollections[id] && clientCollections[id].name) {
          collections[id] = clientCollections[id];
          updated = true;
        }
      }
      if (updated) {
        saveCollections();
      }
    }
    res.json({ success: true, collections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/collections/:id', async (req, res) => {
  const id = req.params.id;
  if (collections[id]) {
    delete collections[id];
    await saveCollections();
    await deleteCollectionFromCloud(id);
    res.json({ success: true, collections });
  } else {
    res.status(404).json({ error: 'Collection not found' });
  }
});

let tunnelUrl = '';

app.get('/api/config', (req, res) => {
  const localIp = getLocalIpAddress();
  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol || 'http';
  
  // Dynamic public URL based on deployment environment
  const activeUrl = process.env.RENDER_EXTERNAL_URL || `${protocol}://${host}`;
  const activeStremioScheme = activeUrl.replace(/^https?:\/\//, '');

  res.json({
    ...config,
    localIp: localIp,
    tunnelUrl: tunnelUrl,
    hostUrl: activeUrl,
    lanHostUrl: `http://${localIp}:${PORT}`,
    stremioUrl: `stremio://${activeStremioScheme}/manifest.json`,
    manifestUrl: `${activeUrl}/manifest.json`,
    localManifestUrl: `${activeUrl}/manifest.json`
  });
});

app.post('/api/config', async (req, res) => {
  const { activeSubgenre, sortBy, tmdbApiKey, geminiApiKey } = req.body;
  if (activeSubgenre) config.activeSubgenre = activeSubgenre;
  if (sortBy) config.sortBy = sortBy;
  if (tmdbApiKey !== undefined) config.tmdbApiKey = tmdbApiKey;
  if (geminiApiKey !== undefined) config.geminiApiKey = geminiApiKey;

  saveConfig();
  
  if (activeSubgenre && !collections[activeSubgenre]) {
    // Generate new TMDB collection or live feed if we don't have it
    const activeObj = SUBGENRES.find(s => s.id === activeSubgenre) || LIVE_FEEDS.find(l => l.id === activeSubgenre) || SUBGENRES[0];
    const movies = await getMoviesForSubgenre(activeSubgenre);
    collections[activeSubgenre] = {
      name: activeObj.name,
      description: activeObj.description,
      tmdbId: activeSubgenre,
      isCustomAI: false,
      movies: movies,
      timestamp: Date.now()
    };
    saveCollections();
  }

  res.json({ success: true, config });
});

// Helper for HTTP POST requests (Gemini API)
function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const postData = JSON.stringify(body);
    const req = https.request(urlObj, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 90000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini API request timed out after 90 seconds'));
    });
    req.on('error', err => reject(err));
    req.write(postData);
    req.end();
  });
}

// Call Gemini API to scrub web & return movies matching prompt
async function queryGeminiForMovies(promptText, apiKey, preferredModel = '', isLiveSearch = false) {
  const key = apiKey || config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('Gemini API Key is missing. Please enter your Gemini API Key in the Dashboard Settings.');
  }

  console.log(`[Gemini AI] Scrubbing web & curating movies for prompt: "${promptText}"...`);

  const systemInstruction = isLiveSearch 
    ? `You are a lightning-fast Stremio search backend. The user is searching for a movie theme or query.
  Return the top 15 to 20 most relevant real movies matching the query.
  You MUST return ONLY a raw JSON array format with NO markdown code block formatting (do NOT write \`\`\`json).
  Format: [{"title": "Movie Title 1", "year": 1999}]`
    : `You are an expert film database curator. The user will give you a custom movie sub-genre, list theme, or search request.
Return a massive, high-quality, comprehensive list of ALL real, existing movies matching the theme across all decades. Dig deep into film history, iconic cinema, cult classics, and hidden gems. Do NOT cap your output; list all relevant movies matching the theme.
You MUST return ONLY a raw JSON array format with NO markdown code block formatting (do NOT write \`\`\`json).
Format:
[
  {"title": "Movie Title 1", "year": 1999},
  {"title": "Movie Title 2", "year": 2005}
]`;

  const validModels = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-flash-latest',
    'gemini-flash-lite-latest'
  ];

  let modelsToTry = [...validModels];
  if (preferredModel && validModels.includes(preferredModel)) {
    modelsToTry = [preferredModel, ...validModels.filter(m => m !== preferredModel)];
  }

  let lastError;
  for (const model of modelsToTry) {
    console.log(`[Gemini AI] Trying model: ${model}...`);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const payload = {
        contents: [
          {
            parts: [
              { text: `${systemInstruction}\n\nUser Custom Request: "${promptText}". Generate a comprehensive list of real movies matching this.` }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2
        }
      };

      let response = await postJson(url, payload);

      // Handle Rate Limit / Quota Exceeded with a brief retry delay
      if (response && response.error && (response.error.message.includes('quota') || response.error.message.includes('Quota') || response.error.message.includes('429'))) {
        console.log(`[Gemini AI] Model ${model} hit rate limit. Waiting 2 seconds before fallback...`);
        await new Promise(r => setTimeout(r, 2000));
        lastError = new Error(response.error.message);
        continue;
      }

      if (response && response.error) {
        console.log(`[Gemini AI] Model ${model} returned API error: ${response.error.message}`);
        lastError = new Error(response.error.message);
        continue;
      }

      if (response && response.candidates && response.candidates[0] && response.candidates[0].content) {
        let text = response.candidates[0].content.parts[0].text.trim();
        text = text.replace(/```json/gi, '').replace(/```/g, '').trim();

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          console.log(`[Gemini AI] JSON parse failed, extracting valid array substring...`);
          const startArr = text.indexOf('[');
          const lastObj = text.lastIndexOf('}');
          if (startArr !== -1 && lastObj !== -1 && lastObj > startArr) {
            try {
              const salvaged = text.substring(startArr, lastObj + 1) + ']';
              parsed = JSON.parse(salvaged);
            } catch (rErr) {
              console.log(`[Gemini AI] Salvage attempt failed: ${rErr.message}`);
            }
          }
        }

        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(`[Gemini AI] Success with model ${model}! Received ${parsed.length} movies.`);
          return parsed;
        } else {
          console.log(`[Gemini AI] Model ${model} returned empty or unparseable array.`);
        }
      } else {
        const finishReason = response?.candidates?.[0]?.finishReason;
        console.log(`[Gemini AI] Model ${model} did not return valid content. FinishReason: ${finishReason || 'UNKNOWN'}`);
        lastError = new Error(`Model ${model} finishReason: ${finishReason || 'No content'}`);
      }
    } catch (err) {
      console.log(`[Gemini AI] Model ${model} network/exception error: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('All Gemini API models failed. Please check your API key.');
}

// Search TMDB by Title + Year to resolve IMDb IDs and rich metadata for Movies & TV Shows
async function searchTmdbMovie(title, year, apiKey, preferredType = null) {
  const tmdbKey = apiKey || config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  try {
    let searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`;
    if (year) searchUrl += `&year=${year}`;

    let res = await fetchJson(searchUrl);

    if ((!res || !res.results || res.results.length === 0) && year) {
      const fallbackUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`;
      res = await fetchJson(fallbackUrl);
    }

    if (res && res.results && res.results.length > 0 && preferredType !== 'series') {
      const m = res.results[0];
      let externalId = `tt${m.id}`;
      try {
        const extRes = await fetchJson(`https://api.themoviedb.org/3/movie/${m.id}/external_ids?api_key=${tmdbKey}`);
        if (extRes && extRes.imdb_id) externalId = extRes.imdb_id;
      } catch (err) {}

      return {
        id: externalId,
        type: 'movie',
        name: m.title || m.original_title,
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Poster',
        background: m.backdrop_path ? `https://image.tmdb.org/t/p/original${m.backdrop_path}` : null,
        description: m.overview || 'No description available.',
        releaseInfo: m.release_date ? m.release_date.substring(0, 4) : String(year || 'N/A'),
        imdbRating: m.vote_average ? m.vote_average.toFixed(1) : 'N/A'
      };
    }

    // Try TV Series Search
    let tvSearchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`;
    if (year) tvSearchUrl += `&first_air_date_year=${year}`;
    let tvRes = await fetchJson(tvSearchUrl);
    if ((!tvRes || !tvRes.results || tvRes.results.length === 0) && year) {
      tvRes = await fetchJson(`https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`);
    }

    if (tvRes && tvRes.results && tvRes.results.length > 0) {
      const s = tvRes.results[0];
      let externalId = `tt${s.id}`;
      try {
        const extRes = await fetchJson(`https://api.themoviedb.org/3/tv/${s.id}/external_ids?api_key=${tmdbKey}`);
        if (extRes && extRes.imdb_id) externalId = extRes.imdb_id;
      } catch (err) {}

      return {
        id: externalId,
        type: 'series',
        name: s.name || s.original_name,
        poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Poster',
        background: s.backdrop_path ? `https://image.tmdb.org/t/p/original${s.backdrop_path}` : null,
        description: s.overview || 'No description available.',
        releaseInfo: s.first_air_date ? s.first_air_date.substring(0, 4) : String(year || 'N/A'),
        imdbRating: s.vote_average ? s.vote_average.toFixed(1) : 'N/A'
      };
    }
  } catch (e) {
    console.error(`TMDB search error for "${title}":`, e.message);
  }
  return null;
}

// Endpoint to Create AI Custom Genre via Gemini
app.post('/api/custom-genre', async (req, res) => {
  try {
    const { name, description, prompt, geminiApiKey, tmdbApiKey, model } = req.body;
    if (geminiApiKey) config.geminiApiKey = geminiApiKey;
    if (tmdbApiKey) config.tmdbApiKey = tmdbApiKey;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    saveConfig();

    const tmdbKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
    let rawMovies = [];

    // 1. Scrub web via Gemini API with safe fallback
    try {
      rawMovies = await queryGeminiForMovies(prompt, config.geminiApiKey, model);
    } catch (err) {
      console.warn(`[AI Custom Genre] Gemini API call failed (${err.message}). Using multi-page topic search fallback...`);
      const cleanPrompt = prompt.replace(/movies about|movie about|films about|movies|films|the best|top|a list of|list of|collection of/gi, '').trim() || prompt;
      for (let page = 1; page <= 10; page++) {
        const searchRes = await fetchJson(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(cleanPrompt)}&page=${page}`);
        if (searchRes && searchRes.results && searchRes.results.length > 0) {
          searchRes.results.forEach(m => {
            rawMovies.push({
              title: m.title || m.original_title,
              year: m.release_date ? parseInt(m.release_date.substring(0, 4)) : null
            });
          });
          if (page >= searchRes.total_pages) break;
        } else {
          break;
        }
      }
    }

    // 2. Resolve to TMDB / IMDb metadata in parallel chunks
    const stremioMetas = [];
    const chunkSize = 10;

    for (let i = 0; i < rawMovies.length; i += chunkSize) {
      const chunk = rawMovies.slice(i, i + chunkSize);
      const batch = await Promise.all(
        chunk.map(m => searchTmdbMovie(m.title, m.year, tmdbKey))
      );
      batch.filter(Boolean).forEach(m => {
        m.genres = [name || 'AI Custom Genre'];
        stremioMetas.push(m);
      });
    }

    const subgenreId = 'custom_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const newSubgenre = {
      id: subgenreId,
      name: name || prompt.slice(0, 30),
      description: description || `AI-Curated Collection for "${prompt}"`,
      isCustomAI: true,
      prompt: prompt,
      movies: stremioMetas,
      timestamp: Date.now()
    };

    // Save to collections dictionary
    collections[subgenreId] = newSubgenre;
    await saveCollections();

    // Still unshift to SUBGENRES so the UI dropdown can see it as a legacy config option
    SUBGENRES.unshift({ id: subgenreId, name: newSubgenre.name, description: newSubgenre.description, isCustom: true });
    config.activeSubgenre = subgenreId;
    await saveConfig();

    console.log(`[Gemini AI] Successfully created custom subgenre "${newSubgenre.name}" with ${stremioMetas.length} movies!`);

    res.json({
      success: true,
      count: stremioMetas.length,
      subgenre: { id: subgenreId, name: newSubgenre.name, description: newSubgenre.description },
      movies: stremioMetas
    });
  } catch (error) {
    console.error('Custom genre creation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/movies/:id', (req, res) => {
  const id = req.params.id;
  if (collections[id]) {
    res.json(sortMoviesByYear(collections[id].movies || []));
  } else {
    res.json([]);
  }
});

// Endpoint to fetch Full Movie/TV Details, YouTube Trailers, and User Reviews
app.get(['/api/movie-details/:id', '/api/show-details/:id'], async (req, res) => {
  const { id } = req.params;
  const apiKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';

  try {
    let tmdbId = id;
    let isTvShow = false;

    // Check if item exists in local collections to know if type is series
    for (const collectionId in collections) {
      const found = collections[collectionId].movies ? collections[collectionId].movies.find(m => m.id === id) : null;
      if (found && found.type === 'series') {
        isTvShow = true;
        break;
      }
    }

    // If ID starts with 'tt', resolve it via TMDB find endpoint
    if (id.startsWith('tt')) {
      const findRes = await fetchJson(`https://api.themoviedb.org/3/find/${id}?api_key=${apiKey}&external_source=imdb_id`);
      if (findRes) {
        if (findRes.tv_results && findRes.tv_results.length > 0 && (isTvShow || !findRes.movie_results || findRes.movie_results.length === 0)) {
          tmdbId = findRes.tv_results[0].id;
          isTvShow = true;
        } else if (findRes.movie_results && findRes.movie_results.length > 0) {
          tmdbId = findRes.movie_results[0].id;
        }
      }
    }

    const endpointType = isTvShow ? 'tv' : 'movie';

    // Fetch Details, Videos (Trailers), and Reviews in parallel
    const [detailsRes, videosRes, reviewsRes] = await Promise.all([
      fetchJson(`https://api.themoviedb.org/3/${endpointType}/${tmdbId}?api_key=${apiKey}`),
      fetchJson(`https://api.themoviedb.org/3/${endpointType}/${tmdbId}/videos?api_key=${apiKey}`),
      fetchJson(`https://api.themoviedb.org/3/${endpointType}/${tmdbId}/reviews?api_key=${apiKey}`)
    ]);

    // Find official YouTube Trailer
    let youtubeTrailerKey = null;
    if (videosRes && videosRes.results) {
      const trailer = videosRes.results.find(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')) ||
                      videosRes.results.find(v => v.site === 'YouTube');
      if (trailer) {
        youtubeTrailerKey = trailer.key;
      }
    }

    // Format Reviews
    let reviews = [];
    if (reviewsRes && reviewsRes.results) {
      reviews = reviewsRes.results.slice(0, 4).map(r => ({
        author: r.author || 'Anonymous Critic',
        avatar: r.author_details && r.author_details.avatar_path ? 
                (r.author_details.avatar_path.startsWith('/http') ? r.author_details.avatar_path.slice(1) : `https://image.tmdb.org/t/p/w185${r.author_details.avatar_path}`) : null,
        rating: r.author_details && r.author_details.rating ? r.author_details.rating : null,
        content: r.content,
        createdAt: r.created_at ? r.created_at.substring(0, 10) : ''
      }));
    }

    res.json({
      details: {
        id: id,
        tmdbId: tmdbId,
        title: detailsRes.title || detailsRes.name || detailsRes.original_title || detailsRes.original_name,
        tagline: detailsRes.tagline || '',
        overview: detailsRes.overview || 'No synopsis available.',
        poster: detailsRes.poster_path ? `https://image.tmdb.org/t/p/w500${detailsRes.poster_path}` : null,
        background: detailsRes.backdrop_path ? `https://image.tmdb.org/t/p/original${detailsRes.backdrop_path}` : null,
        releaseDate: detailsRes.release_date || detailsRes.first_air_date || '',
        runtime: detailsRes.runtime ? `${detailsRes.runtime} mins` : (detailsRes.episode_run_time && detailsRes.episode_run_time.length > 0 ? `${detailsRes.episode_run_time[0]} mins/ep` : ''),
        rating: detailsRes.vote_average ? detailsRes.vote_average.toFixed(1) : 'N/A',
        voteCount: detailsRes.vote_count || 0,
        genres: detailsRes.genres ? detailsRes.genres.map(g => g.name) : [],
        budget: detailsRes.budget ? `$${(detailsRes.budget / 1000000).toFixed(1)}M` : null,
        revenue: detailsRes.revenue ? `$${(detailsRes.revenue / 1000000).toFixed(1)}M` : null
      },
      youtubeTrailerKey: youtubeTrailerKey,
      reviews: reviews
    });

  } catch (error) {
    console.error(`Error fetching details for ${id}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch details' });
  }
});

// Start Server on 0.0.0.0 for LAN/TV connectivity
app.listen(PORT, '0.0.0.0', async () => {
  await loadConfig();
  await loadCollections();
  
  const localIp = getLocalIpAddress();
  console.log(`=======================================================`);
  console.log(`≡ƒÄ¼ Stremio Custom Sub-Genre Catalog Server Running!`);
  console.log(`≡ƒÆ╗ PC Dashboard UI: http://localhost:${PORT}`);
  console.log(`≡ƒô║ TV / Network Manifest URL: http://${localIp}:${PORT}/manifest.json`);
  console.log(`≡ƒÜÇ 1-Click Install (LAN): stremio://${localIp}:${PORT}/manifest.json`);
  console.log(`=======================================================`);

  try {
    console.log(`[Tunnel] Connecting secure HTTPS tunnel...`);
    const tunnel = await localtunnel({ port: PORT });
    tunnelUrl = tunnel.url;
    console.log(`≡ƒôí Secure Public HTTPS URL: ${tunnelUrl}/manifest.json`);
    console.log(`≡ƒÜÇ 1-Click Install (Secure): stremio://${tunnelUrl.replace(/^https?:\/\//, '')}/manifest.json`);
    console.log(`=======================================================`);
  } catch (err) {
    console.error(`[Tunnel] Failed to start localtunnel:`, err.message);
  }
});

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
let searchCache = {}; // Cache for live AI search queries

const FIREBASE_URL = 'https://stremio-catalogue-3bad5-default-rtdb.firebaseio.com';

function loadLiveChannels() {
  if (fs.existsSync(LIVE_CHANNELS_FILE)) {
    try {
      liveChannels = JSON.parse(fs.readFileSync(LIVE_CHANNELS_FILE, 'utf8')) || [];
      console.log(`[24/7 Channels] Loaded ${liveChannels.length} live channels from local file.`);
    } catch (err) {
      console.error('Failed to load live_channels.json:', err.message);
    }
  }
}

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
    "Horror",
    "Movies",
    "Crime and Mystery",
    "Series",
    "Comedy and Animation",
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

      let items = [...liveChannels];
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
        const rawItems = await queryGeminiForMovies(query, config.geminiApiKey, '', true);
        const batch = await Promise.all(
          rawItems.slice(0, 30).map(m => searchTmdbMovie(m.title, m.year, tmdbKey))
        );
        const stremioMetas = batch.filter(Boolean);
        
        searchCache[cacheKey] = {
          timestamp: Date.now(),
          movies: stremioMetas
        };
        
        console.log(`[AI Search] Generated ${stremioMetas.length} results for: "${query}"`);
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
      return res.json({ meta: channel });
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

      return res.json({
        streams: [
          {
            name: "📺 24/7 LIVE (Direct)",
            title: `▶ Watch Live (Direct HD)\n${channel.name} • 24/7 Continuous Feed`,
            url: finalUrl,
            isFree: true,
            live: true,
            behaviorHints: {
              notWebReady: false
            }
          },
          {
            name: "🛡️ 24/7 UNBLOCKED (Cloud Mirror)",
            title: `▶ Watch Live (Region-Free Cloud Mirror)\n${channel.name} • Bypasses All Geo-Blocks`,
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

  // 2. Fallback to Movie / Series YouTube Trailers
  try {
    let tmdbId = rawId;
    let isTv = type === 'series';

    // If ID starts with 'tt', resolve via TMDB find endpoint
    if (rawId.startsWith('tt')) {
      const findRes = await fetchJson(`https://api.themoviedb.org/3/find/${rawId}?api_key=${apiKey}&external_source=imdb_id`);
      if (findRes) {
        if (findRes.tv_results && findRes.tv_results.length > 0 && (isTv || !findRes.movie_results || findRes.movie_results.length === 0)) {
          tmdbId = findRes.tv_results[0].id;
          isTv = true;
        } else if (findRes.movie_results && findRes.movie_results.length > 0) {
          tmdbId = findRes.movie_results[0].id;
        }
      }
    }

    const endpoint = isTv ? 'tv' : 'movie';
    const videosRes = await fetchJson(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/videos?api_key=${apiKey}`);
    const streams = [];

    if (videosRes && videosRes.results) {
      const trailers = videosRes.results.filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
      const allYoutube = videosRes.results.filter(v => v.site === 'YouTube');
      const selected = trailers.length > 0 ? trailers : allYoutube;

      selected.slice(0, 3).forEach(v => {
        streams.push({
          title: `🎬 Trailer: ${v.name || 'Official YouTube Trailer'}`,
          ytId: v.key
        });
      });
    }

    res.json({ streams });
  } catch (err) {
    console.error(`Stream lookup error for ${rawId}:`, err.message);
    res.json({ streams: [] });
  }
});

// REST API for Dashboard UI
app.get('/api/subgenres', (req, res) => {
  res.json(SUBGENRES);
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

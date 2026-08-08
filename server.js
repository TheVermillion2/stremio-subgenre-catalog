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

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// Memory cache for collections
let collections = {};
let searchCache = {}; // Cache for live AI search queries

async function loadCollections() {
  let localData = {};
  if (fs.existsSync(COLLECTIONS_FILE)) {
    try {
      localData = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, 'utf8')) || {};
    } catch (err) {
      console.error('Failed to load collections locally:', err.message);
    }
  }

  if (db) {
    try {
      const snapshot = await db.ref('collections').once('value');
      if (snapshot.exists()) {
        const fbCollections = snapshot.val() || {};
        // Merge firebase and local data so no custom list is lost
        collections = { ...localData, ...fbCollections };
        console.log(`[Firebase] Loaded ${Object.keys(collections).length} collections.`);
        // Sync merged data back to Firebase & local storage
        await saveCollections();
      } else if (Object.keys(localData).length > 0) {
        collections = localData;
        console.log(`[Firebase] Seeded Firebase with ${Object.keys(collections).length} local collections.`);
        await saveCollections();
      }
    } catch (err) {
      console.error('Failed to load collections from Firebase:', err.message);
      collections = localData;
    }
  } else {
    collections = localData;
  }
}

async function saveCollections() {
  try {
    fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(collections, null, 2));
  } catch (err) {
    console.error('Failed to save collections locally:', err.message);
  }
  if (db) {
    try {
      await db.ref('collections').set(collections);
    } catch (err) {
      console.error('Failed to save collections to Firebase:', err.message);
    }
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

// Fetch 100 movies from TMDB for active subgenre or query
async function getMoviesForSubgenre(subgenreId, options = {}) {
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

    // First attempt: search with keywords across pages 1 to 5
    for (let page = 1; page <= 5; page++) {
      const res = await fetchJson(buildUrl(page, true));
      if (res && res.results && res.results.length > 0) {
        allMovies = allMovies.concat(res.results);
      }
    }

    // If keywords filter returned very few movies, pad with broader genre query
    if (allMovies.length < 20) {
      console.log(`[TMDB] Keyword filter returned ${allMovies.length} movies. Padding with broader genre query...`);
      const existingIds = new Set(allMovies.map(m => m.id));
      for (let page = 1; page <= 5; page++) {
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

// Stremio Addon Protocol Manifest
app.get('/manifest.json', (req, res) => {
  const collectionIds = Object.keys(collections);
  const catalogs = collectionIds.map(id => ({
    type: 'movie',
    id: id,
    name: collections[id].name
  }));

  // Provide a default empty catalog if none exist to prevent Stremio errors
  if (catalogs.length === 0) {
    catalogs.push({
      type: 'movie',
      id: 'default_empty',
      name: 'No Collections Yet'
    });
  }

  // Inject the AI Search catalog at position #1
  catalogs.unshift({
    type: 'movie',
    id: 'ai_search',
    name: '🤖 AI Movie Search Curator',
    extra: [
      { name: 'search', isRequired: true },
      { name: 'skip', isRequired: false }
    ]
  });

  const manifest = {
    id: 'org.subgenre.auto.catalog',
    version: '2.1.0',
    name: '🤖 AI Movie Search Curator & Custom Genres',
    description: 'Instant AI Movie Search & Auto-updating Custom Playlists!',
    resources: ['catalog', 'meta'],
    types: ['movie'],
    catalogs: catalogs,
    idPrefixes: ['tt']
  };
  res.json(manifest);
});

function sortMoviesByYear(movies) {
  if (!Array.isArray(movies)) return [];
  return [...movies].sort((a, b) => {
    const yearA = parseInt(a.releaseInfo || a.releaseDate || a.year || '0', 10) || 0;
    const yearB = parseInt(b.releaseInfo || b.releaseDate || b.year || '0', 10) || 0;
    return yearB - yearA;
  });
}

// Stremio Catalog Endpoint
app.get('/catalog/movie/:id*', async (req, res) => {
  try {
    const rawPath = req.params.id + (req.params[0] || '');
    const parts = rawPath.replace(/\.json$/, '').split('/');
    const id = parts[0];
    const extraStr = parts[1] || '';
    
    // Handle Live AI Search Catalog
    if (id === 'ai_search') {
      const params = new URLSearchParams(extraStr);
      const query = params.get('search');
      const skip = parseInt(params.get('skip') || '0', 10);
      
      if (!query) return res.json({ metas: [] });
      
      const cacheKey = query.toLowerCase().trim();
      
      // Serve from cache if available (cache lasts for 24 hours in memory)
      if (searchCache[cacheKey] && (Date.now() - searchCache[cacheKey].timestamp < 86400000)) {
        console.log(`[AI Search] Serving cached results for: "${query}", skip: ${skip}`);
        const metas = searchCache[cacheKey].movies.slice(skip, skip + 50);
        return res.json({ metas });
      }
      
      console.log(`[AI Search] New search request for: "${query}"`);
      const tmdbKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
      
      try {
        const rawMovies = await queryGeminiForMovies(query, config.geminiApiKey, '', true);
        // Parallelize all lookups at once for lightning-fast TV response
        const batch = await Promise.all(
          rawMovies.slice(0, 25).map(m => searchTmdbMovie(m.title, m.year, tmdbKey))
        );
        const stremioMetas = batch.filter(Boolean);
        
        searchCache[cacheKey] = {
          timestamp: Date.now(),
          movies: stremioMetas
        };
        
        console.log(`[AI Search] Generated ${stremioMetas.length} results for: "${query}"`);
        return res.json({ metas: stremioMetas.slice(skip, skip + 50) });
      } catch (err) {
        console.error('[AI Search] Failed to fulfill search request:', err.message);
        return res.json({ metas: [] });
      }
    }

    const collection = collections[id];

    if (!collection) {
      return res.json({ metas: [] });
    }

    // Check cache age
    const now = Date.now();
    const cacheAge = collection.timestamp ? (now - collection.timestamp) / (1000 * 60 * 60) : 999;
    
    // Serve from cache if fresh or if it's an AI custom genre
    if ((collection.movies && collection.movies.length > 0 && cacheAge < config.refreshIntervalHours) || collection.isCustomAI) {
      console.log(`[Stremio Request] Serving cached collection ${id} (${collection.movies.length} movies) sorted newest first`);
      return res.json({ metas: sortMoviesByYear(collection.movies) });
    }

    // If it's a standard TMDB list and needs refresh
    console.log(`[Stremio Request] Refreshing collection ${id} from TMDB...`);
    const movies = await getMoviesForSubgenre(collection.tmdbId || id);
    collection.movies = movies;
    collection.timestamp = Date.now();
    saveCollections();

    res.json({ metas: movies });
  } catch (e) {
    console.error('Error serving catalog:', e.message);
    res.status(500).json({ metas: [] });
  }
});

// Stremio Meta Detail Endpoint (Optional fallback)
app.get('/meta/movie/:id.json', (req, res) => {
  const id = req.params.id;
  let found = null;
  // Search across all collections for the meta
  for (const collectionId in collections) {
    found = collections[collectionId].movies.find(m => m.id === id);
    if (found) break;
  }
  if (found) {
    res.json({ meta: found });
  } else {
    res.status(404).json({ error: 'Meta not found' });
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
    if (clientCollections && typeof clientCollections === 'object') {
      let updated = false;
      for (const id in clientCollections) {
        if (clientCollections[id] && clientCollections[id].name) {
          collections[id] = clientCollections[id];
          updated = true;
        }
      }
      if (updated) {
        saveCollections();
        console.log(`[Sync] Synced ${Object.keys(collections).length} total collections from client storage.`);
      }
    }
    res.json({ success: true, collections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/collections/:id', (req, res) => {
  const id = req.params.id;
  if (collections[id]) {
    delete collections[id];
    saveCollections();
    res.json({ success: true });
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
    // Generate new TMDB collection if we don't have it
    const activeObj = SUBGENRES.find(s => s.id === activeSubgenre) || SUBGENRES[0];
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
  Return a massive, high-quality, comprehensive list of 250 to 300 real, existing movies matching the theme. Dig deep into film history, iconic cinema, classics, and hidden gems across all decades. You must not stop until you have scrubbed all movies for that specific genre prompt.
  You MUST return ONLY a raw JSON array format with NO markdown code block formatting (do NOT write \`\`\`json).
  Format:
  [
    {"title": "Movie Title 1", "year": 1999},
    {"title": "Movie Title 2", "year": 2005}
  ]`;

  const modelsToTry = preferredModel && preferredModel !== 'gemini-1.5-pro'
    ? [preferredModel, 'gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-8b'] 
    : ['gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-8b'];

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

      const response = await postJson(url, payload);

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

// Helper: HTTP request wrapper using native fetch
async function fetchJson(urlStr) {
  try {
    const res = await fetch(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

// Search TMDB by Title + Year to resolve IMDb IDs and rich metadata
async function searchTmdbMovie(title, year, apiKey) {
  const tmdbKey = apiKey || config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  try {
    let searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`;
    if (year) searchUrl += `&year=${year}`;

    const res = await fetchJson(searchUrl);

    if (res && res.results && res.results.length > 0) {
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
  } catch (e) {
    console.error(`TMDB search error for "${title}":`, e.message);
  }
  return null;
}

// Search TMDB Direct by Query Keywords (Dynamic Fallback when Gemini API is offline)
async function searchTmdbDirectByQuery(queryStr, apiKey) {
  const tmdbKey = apiKey || config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  let allMovies = [];
  try {
    const cleanQuery = queryStr
      .replace(/movies about|movie about|films about|movies|films|the best|top|a list of|list of|collection of/gi, '')
      .trim();

    // Loop through TMDB pages to gather up to 250+ movies!
    for (let page = 1; page <= 15; page++) {
      const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(cleanQuery || queryStr)}&page=${page}`;
      const res = await fetchJson(searchUrl);

      if (res && res.results && res.results.length > 0) {
        const pageMovies = res.results.map(m => ({
          title: m.title || m.original_title,
          year: m.release_date ? parseInt(m.release_date.substring(0, 4)) : null
        }));
        allMovies = allMovies.concat(pageMovies);
        
        // Break early if there are no more pages
        if (page >= res.total_pages) break;
      } else {
        break;
      }
    }
  } catch (err) {
    console.error(`[TMDB Direct Search Error] "${queryStr}":`, err.message);
  }
  return allMovies;
}

async function getFallbackMoviesForPrompt(name = '', prompt = '', apiKey = '') {
  const text = (name + ' ' + prompt).toLowerCase();
  let staticMovies = [];
  
  // 1. Relationships, Marriage, Abuse, Toxic Love
  if (text.includes('relationship') || text.includes('abusive') || text.includes('marriage') || text.includes('toxic') || text.includes('divorce') || text.includes('cheating') || text.includes('partner')) {
    staticMovies = staticMovies.concat([
      { title: "Marriage Story", year: 2019 },
      { title: "Blue Valentine", year: 2010 },
      { title: "Gone Girl", year: 2014 },
      { title: "Revolutionary Road", year: 2008 },
      { title: "Sleeping with the Enemy", year: 1991 },
      { title: "Enough", year: 2002 },
      { title: "What's Love Got to Do with It", year: 1993 },
      { title: "Closer", year: 2004 },
      { title: "Fatal Attraction", year: 1987 },
      { title: "The War of the Roses", year: 1989 },
      { title: "Scenes from a Marriage", year: 1973 },
      { title: "Unfaithful", year: 2002 },
      { title: "Phantom Thread", year: 2017 },
      { title: "Kramer vs. Kramer", year: 1979 }
    ]);
  }

  // 2. A.I., Robots, Androids & Technology
  if (text.includes('a.i.') || text.includes('ai') || text.includes('robot') || text.includes('android') || text.includes('artificial intelligence') || text.includes('machine')) {
    staticMovies = staticMovies.concat([
      { title: "Ex Machina", year: 2014 },
      { title: "Her", year: 2013 },
      { title: "Blade Runner 2049", year: 2017 },
      { title: "The Matrix", year: 1999 },
      { title: "I, Robot", year: 2004 },
      { title: "A.I. Artificial Intelligence", year: 2001 },
      { title: "Terminator 2: Judgment Day", year: 1991 },
      { title: "M3GAN", year: 2022 },
      { title: "Upgrade", year: 2018 },
      { title: "Ghost in the Shell", year: 1995 }
    ]);
  }

  // 3. Zombie, Vampire & Outbreak Sagas
  if (text.includes('zombie') || text.includes('vampire') || text.includes('outbreak') || text.includes('undead')) {
    staticMovies = staticMovies.concat([
      { title: "28 Days Later", year: 2002 },
      { title: "Dawn of the Dead", year: 2004 },
      { title: "Train to Busan", year: 2016 },
      { title: "Shaun of the Dead", year: 2004 },
      { title: "World War Z", year: 2013 },
      { title: "Zombieland", year: 2009 },
      { title: "Dracula", year: 1992 },
      { title: "Interview with the Vampire", year: 1994 },
      { title: "Blade", year: 1998 },
      { title: "From Dusk Till Dawn", year: 1996 },
      { title: "Let the Right One In", year: 2008 },
      { title: "30 Days of Night", year: 2007 },
      { title: "I Am Legend", year: 2007 },
      { title: "The Lost Boys", year: 1987 },
      { title: "Night of the Living Dead", year: 1968 }
    ]);
  }

  // 4. Horror (Supernatural, Hauntings, Slashers, Occult, A24 Elevated)
  if (text.includes('horror') || text.includes('slasher') || text.includes('haunting') || text.includes('possession') || text.includes('demonic') || text.includes('occult')) {
    staticMovies = staticMovies.concat([
      { title: "The Exorcist", year: 1973 },
      { title: "The Shining", year: 1980 },
      { title: "Halloween", year: 1978 },
      { title: "A Nightmare on Elm Street", year: 1984 },
      { title: "Scream", year: 1996 },
      { title: "Hereditary", year: 2018 },
      { title: "The Conjuring", year: 2013 },
      { title: "Get Out", year: 2017 },
      { title: "It", year: 2017 },
      { title: "The Texas Chain Saw Massacre", year: 1974 },
      { title: "Poltergeist", year: 1982 },
      { title: "Insidious", year: 2010 },
      { title: "Midsommar", year: 2019 },
      { title: "Sinister", year: 2012 },
      { title: "The Thing", year: 1982 },
      { title: "Saw", year: 2004 },
      { title: "The Babadook", year: 2014 },
      { title: "Smile", year: 2022 },
      { title: "Talk to Me", year: 2022 },
      { title: "Alien", year: 1979 }
    ]);
  }

  // 5. Found Footage & Tech Horror
  if (text.includes('found footage') || text.includes('screenlife') || text.includes('vhs') || text.includes('tech horror')) {
    staticMovies = staticMovies.concat([
      { title: "The Blair Witch Project", year: 1999 },
      { title: "Paranormal Activity", year: 2007 },
      { title: "Cloverfield", year: 2008 },
      { title: "REC", year: 2007 },
      { title: "V/H/S", year: 2012 },
      { title: "V/H/S/2", year: 2013 },
      { title: "Unfriended", year: 2014 },
      { title: "Searching", year: 2018 },
      { title: "Missing", year: 2023 },
      { title: "Creep", year: 2014 },
      { title: "Creep 2", year: 2017 },
      { title: "As Above, So Below", year: 2014 },
      { title: "Hell House LLC", year: 2015 },
      { title: "Grave Encounters", year: 2011 },
      { title: "Chronicle", year: 2012 },
      { title: "Host", year: 2020 }
    ]);
  }

  // 6. Psychological Thrillers & Suspense
  if (text.includes('psychological') || text.includes('suspense') || text.includes('thriller') || text.includes('mind twist') || text.includes('stalker')) {
    staticMovies = staticMovies.concat([
      { title: "Se7en", year: 1995 },
      { title: "The Silence of the Lambs", year: 1991 },
      { title: "Shutter Island", year: 2010 },
      { title: "Zodiac", year: 2007 },
      { title: "American Psycho", year: 2000 },
      { title: "Nightcrawler", year: 2014 },
      { title: "Gone Girl", year: 2014 },
      { title: "Prisoners", year: 2013 },
      { title: "Black Swan", year: 2010 },
      { title: "Memento", year: 2000 },
      { title: "The Sixth Sense", year: 1999 },
      { title: "Misery", year: 1990 }
    ]);
  }

  // 7. Heists & Crime Underworld
  if (text.includes('heist') || text.includes('bank robbery') || text.includes('underworld') || text.includes('mafia') || text.includes('cartel')) {
    staticMovies = staticMovies.concat([
      { title: "Heat", year: 1995 },
      { title: "The Town", year: 2010 },
      { title: "Ocean's Eleven", year: 2001 },
      { title: "Inside Man", year: 2006 },
      { title: "Baby Driver", year: 2017 },
      { title: "Inception", year: 2010 },
      { title: "Set It Off", year: 1996 },
      { title: "Den of Thieves", year: 2018 },
      { title: "Goodfellas", year: 1990 },
      { title: "The Godfather", year: 1972 }
    ]);
  }

  // 8. 90s Hood Classics
  if (text.includes('hood') || text.includes('hood classic') || text.includes('street saga') || text.includes('urban drama')) {
    staticMovies = staticMovies.concat([
      { title: "Boyz n the Hood", year: 1991 },
      { title: "Menace II Society", year: 1993 },
      { title: "Poetic Justice", year: 1993 },
      { title: "Juice", year: 1992 },
      { title: "Set It Off", year: 1996 },
      { title: "New Jack City", year: 1991 },
      { title: "Dead Presidents", year: 1995 },
      { title: "Paid in Full", year: 2002 },
      { title: "Friday", year: 1995 },
      { title: "Belly", year: 1998 },
      { title: "Clockers", year: 1995 },
      { title: "King of New York", year: 1990 }
    ]);
  }

  // 9. Biopics & History
  if (text.includes('biopic') || text.includes('civil rights') || text.includes('historical figure') || text.includes('true story')) {
    staticMovies = staticMovies.concat([
      { title: "Malcolm X", year: 1992 },
      { title: "Selma", year: 2014 },
      { title: "Hidden Figures", year: 2016 },
      { title: "Judas and the Black Messiah", year: 2021 },
      { title: "Ray", year: 2004 },
      { title: "Ali", year: 2001 },
      { title: "42", year: 2013 },
      { title: "The Hurricane", year: 1999 }
    ]);
  }

  // 10. Martial Arts & Kung Fu
  if (text.includes('martial arts') || text.includes('kung fu') || text.includes('wuxia') || text.includes('bruce lee')) {
    staticMovies = staticMovies.concat([
      { title: "Enter the Dragon", year: 1973 },
      { title: "Fist of Legend", year: 1994 },
      { title: "Drunken Master II", year: 1994 },
      { title: "Ip Man", year: 2008 },
      { title: "Crouching Tiger, Hidden Dragon", year: 2000 },
      { title: "The 36th Chamber of Shaolin", year: 1978 }
    ]);
  }

  // 11. Black Romance & Rom-Coms
  if (text.includes('romance') || text.includes('rom-com') || text.includes('love story')) {
    staticMovies = staticMovies.concat([
      { title: "Love & Basketball", year: 2000 },
      { title: "Brown Sugar", year: 2002 },
      { title: "The Best Man", year: 1999 },
      { title: "Love Jones", year: 1997 },
      { title: "Beyond the Lights", year: 2014 },
      { title: "The Wood", year: 1999 }
    ]);
  }

  // 12. Comedy & House Party
  if (text.includes('comedy') || text.includes('house party') || text.includes('cookout')) {
    staticMovies = staticMovies.concat([
      { title: "Friday", year: 1995 },
      { title: "Next Friday", year: 2000 },
      { title: "Barbershop", year: 2002 },
      { title: "House Party", year: 1990 },
      { title: "Girls Trip", year: 2017 },
      { title: "Think Like a Man", year: 2012 }
    ]);
  }

  // 13. Dynamic TMDB Search Fallback for ALL Queries to fetch 250+ movies!
  const tmdbDirect = await searchTmdbDirectByQuery(prompt || name, apiKey);
  
  if (staticMovies.length > 0 || (tmdbDirect && tmdbDirect.length > 0)) {
    // Merge static curations + 250+ TMDB movies, and remove duplicates
    const allMovies = [...staticMovies, ...(tmdbDirect || [])];
    const uniqueMovies = Array.from(new Map(allMovies.map(item => [item.title, item])).values());
    return uniqueMovies;
  }

  return [
    { title: "Inception", year: 2010 },
    { title: "The Dark Knight", year: 2008 },
    { title: "Pulp Fiction", year: 1994 },
    { title: "Fight Club", year: 1999 },
    { title: "Goodfellas", year: 1990 }
  ];
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

    // 1. Scrub web via Gemini API with smart fallback list if quota is depleted
    let rawMovies = [];
    const tmdbKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';

    try {
      rawMovies = await queryGeminiForMovies(prompt, config.geminiApiKey, model);
    } catch (err) {
      console.warn(`[AI Genre Fallback] Gemini API unavailable or quota depleted (${err.message}). Using fallback taxonomy for "${name || prompt}"...`);
      rawMovies = await getFallbackMoviesForPrompt(name, prompt, tmdbKey);
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

// Endpoint to fetch Full Movie Details, YouTube Trailers, and User Reviews
app.get('/api/movie-details/:id', async (req, res) => {
  const { id } = req.params;
  const apiKey = config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';

  try {
    let tmdbId = id;

    // If ID starts with 'tt', resolve it via TMDB find endpoint first
    if (id.startsWith('tt')) {
      const findRes = await fetchJson(`https://api.themoviedb.org/3/find/${id}?api_key=${apiKey}&external_source=imdb_id`);
      if (findRes && findRes.movie_results && findRes.movie_results.length > 0) {
        tmdbId = findRes.movie_results[0].id;
      }
    }

    // Fetch Details, Videos (Trailers), and Reviews in parallel
    const [detailsRes, videosRes, reviewsRes] = await Promise.all([
      fetchJson(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}`),
      fetchJson(`https://api.themoviedb.org/3/movie/${tmdbId}/videos?api_key=${apiKey}`),
      fetchJson(`https://api.themoviedb.org/3/movie/${tmdbId}/reviews?api_key=${apiKey}`)
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
        author: r.author || 'Anonymous Movie Critic',
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
        title: detailsRes.title || detailsRes.original_title,
        tagline: detailsRes.tagline || '',
        overview: detailsRes.overview || 'No synopsis available.',
        poster: detailsRes.poster_path ? `https://image.tmdb.org/t/p/w500${detailsRes.poster_path}` : null,
        background: detailsRes.backdrop_path ? `https://image.tmdb.org/t/p/original${detailsRes.backdrop_path}` : null,
        releaseDate: detailsRes.release_date || '',
        runtime: detailsRes.runtime ? `${detailsRes.runtime} mins` : '',
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
    console.error(`Error fetching movie details for ${id}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch movie details' });
  }
});

// Start Server on 0.0.0.0 for LAN/TV connectivity
app.listen(PORT, '0.0.0.0', async () => {
  await loadConfig();
  await loadCollections();
  
  const localIp = getLocalIpAddress();
  console.log(`=======================================================`);
  console.log(`🎬 Stremio Custom Sub-Genre Catalog Server Running!`);
  console.log(`💻 PC Dashboard UI: http://localhost:${PORT}`);
  console.log(`📺 TV / Network Manifest URL: http://${localIp}:${PORT}/manifest.json`);
  console.log(`🚀 1-Click Install (LAN): stremio://${localIp}:${PORT}/manifest.json`);
  console.log(`=======================================================`);

  try {
    console.log(`[Tunnel] Connecting secure HTTPS tunnel...`);
    const tunnel = await localtunnel({ port: PORT });
    tunnelUrl = tunnel.url;
    console.log(`📡 Secure Public HTTPS URL: ${tunnelUrl}/manifest.json`);
    console.log(`🚀 1-Click Install (Secure): stremio://${tunnelUrl.replace(/^https?:\/\//, '')}/manifest.json`);
    console.log(`=======================================================`);
  } catch (err) {
    console.error(`[Tunnel] Failed to start localtunnel:`, err.message);
  }
});

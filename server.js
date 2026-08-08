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
    name: '≡ƒñû AI Movie Search Curator',
    extra: [
      { name: 'search', isRequired: true },
      { name: 'skip', isRequired: false }
    ]
  });

  const manifest = {
    id: 'org.subgenre.auto.catalog',
    version: '2.1.0',
    name: '≡ƒñû AI Movie Search Curator & Custom Genres',
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

// Search TMDB by Title + Year to resolve IMDb IDs and rich metadata
async function searchTmdbMovie(title, year, apiKey) {
  const tmdbKey = apiKey || config.tmdbApiKey || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  try {
    let searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`;
    if (year) searchUrl += `&year=${year}`;

    let res = await fetchJson(searchUrl);

    if ((!res || !res.results || res.results.length === 0) && year) {
      const fallbackUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(title)}`;
      res = await fetchJson(fallbackUrl);
    }

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

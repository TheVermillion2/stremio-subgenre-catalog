document.addEventListener('DOMContentLoaded', async () => {
  const subgenreListEl = document.getElementById('subgenreList');
  const posterGridEl = document.getElementById('posterGrid');
  const titleEl = document.getElementById('currentSubgenreTitle');
  const descEl = document.getElementById('currentSubgenreDesc');
  const countBadgeEl = document.getElementById('movieCountBadge');
  const sortSelect = document.getElementById('sortSelect');
  const tmdbKeyInput = document.getElementById('tmdbKeyInput');
  const geminiKeyInput = document.getElementById('geminiKeyInput');
  const saveBtn = document.getElementById('saveSettingsBtn');
  const statusMsg = document.getElementById('statusMessage');
  const stremioInstallBtn = document.getElementById('stremioInstallBtn');
  const copyUrlBtn = document.getElementById('copyUrlBtn');

  // AI Modal elements
  const openCustomModalBtn = document.getElementById('openCustomModalBtn');
  const customModal = document.getElementById('customModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const customNameInput = document.getElementById('customNameInput');
  const customPromptInput = document.getElementById('customPromptInput');
  const modalGeminiKey = document.getElementById('modalGeminiKey');
  const createCustomBtn = document.getElementById('createCustomBtn');
  const modalStatus = document.getElementById('modalStatus');

  // Movie Detail Modal elements
  const movieDetailModal = document.getElementById('movieDetailModal');
  const closeDetailBtn = document.getElementById('closeDetailBtn');
  const detailTitle = document.getElementById('detailTitle');
  const trailerContainer = document.getElementById('trailerContainer');
  const detailRatingBadge = document.getElementById('detailRatingBadge');
  const detailYear = document.getElementById('detailYear');
  const detailRuntime = document.getElementById('detailRuntime');
  const detailGenres = document.getElementById('detailGenres');
  const detailTagline = document.getElementById('detailTagline');
  const detailOverview = document.getElementById('detailOverview');
  const reviewsContainer = document.getElementById('reviewsContainer');
  const playStremioBtn = document.getElementById('playStremioBtn');

  let subgenres = []; // templates
  let collections = {}; // saved collections
  let currentConfig = {};
  let currentActiveId = null;

  // Fetch initial config & subgenre presets
  async function init() {
    try {
      const localSaved = localStorage.getItem('subgenre_collections');
      if (localSaved) {
        try {
          const parsedLocal = JSON.parse(localSaved);
          await fetch('/api/sync-collections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsedLocal)
          });
        } catch (e) {}
      }

      const [subRes, colRes, confRes] = await Promise.all([
        fetch('/api/subgenres').then(r => r.json()),
        fetch('/api/collections').then(r => r.json()),
        fetch('/api/config').then(r => r.json())
      ]);

      subgenres = Array.isArray(subRes) ? subRes : (subRes.subgenres || []);
      liveFeeds = subRes.liveFeeds || [];
      collections = colRes;
      currentConfig = confRes;
      localStorage.setItem('subgenre_collections', JSON.stringify(collections));

      sortSelect.value = currentConfig.sortBy || 'popularity.desc';
      if (currentConfig.tmdbApiKey) {
        tmdbKeyInput.value = currentConfig.tmdbApiKey;
      }
      if (currentConfig.geminiApiKey) {
        geminiKeyInput.value = currentConfig.geminiApiKey;
        modalGeminiKey.value = currentConfig.geminiApiKey;
      }

      // Update Tunnel status indicator
      const tunnelBadge = document.getElementById('tunnelStatusBadge');
      if (currentConfig.tunnelUrl) {
        tunnelBadge.innerText = 'Active (HTTPS)';
        tunnelBadge.style.background = 'rgba(16, 185, 129, 0.15)';
        tunnelBadge.style.color = '#10b981';
        tunnelBadge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      } else {
        tunnelBadge.innerText = 'LAN IP Fallback';
        tunnelBadge.style.background = 'rgba(245, 158, 11, 0.15)';
        tunnelBadge.style.color = '#f59e0b';
        tunnelBadge.style.borderColor = 'rgba(245, 158, 11, 0.3)';
      }
      
      stremioInstallBtn.href = currentConfig.stremioUrl;

      renderSubgenres();
      
      const firstCollectionId = Object.keys(collections)[0];
      if (firstCollectionId) {
        currentActiveId = firstCollectionId;
      }
      
      await loadActiveMovies();
    } catch (e) {
      console.error('Initialization error:', e);
    }
  }

  function renderSubgenres() {
    subgenreListEl.innerHTML = '';
    
    // Render Saved Collections
    const colKeys = Object.keys(collections);
    if (colKeys.length > 0) {
      const heading1 = document.createElement('h4');
      heading1.innerText = '📂 Saved Collections';
      heading1.style.margin = '10px 0 5px 0';
      subgenreListEl.appendChild(heading1);
      
      colKeys.forEach(id => {
        const sg = collections[id];
        const card = document.createElement('div');
        card.className = `subgenre-card ${id === currentActiveId ? 'active' : ''}`;
        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <h5>${sg.name} ${sg.isCustomAI ? '🤖' : '🎬'}</h5>
            <button class="delete-col-btn" data-id="${id}" style="background:transparent; border:none; color:#ef4444; cursor:pointer; font-size:1.2rem;" title="Delete Collection">🗑️</button>
          </div>
          <p>${sg.description}</p>
        `;
        card.addEventListener('click', (e) => {
          if (e.target.closest('.delete-col-btn')) {
            e.stopPropagation();
            deleteCollection(id);
          } else {
            selectCollection(id);
          }
        });
        subgenreListEl.appendChild(card);
      });
    }

    // Render Live Auto-Updating Feeds
    if (liveFeeds && liveFeeds.length > 0) {
      const headingLive = document.createElement('h4');
      headingLive.innerText = '🔥 Live Auto-Updating Feeds';
      headingLive.style.margin = '15px 0 5px 0';
      headingLive.style.color = '#f59e0b';
      subgenreListEl.appendChild(headingLive);

      liveFeeds.forEach(lf => {
        const card = document.createElement('div');
        card.className = 'subgenre-card';
        card.style.borderLeft = '3px solid #f59e0b';
        card.innerHTML = `
          <h5>${lf.name}</h5>
          <p>${lf.description}</p>
          <button class="btn btn-accent btn-full" style="margin-top: 10px; padding: 5px; font-size: 0.85rem;">⚡ Add Live Feed</button>
        `;
        card.addEventListener('click', () => buildFromTemplate(lf.id));
        subgenreListEl.appendChild(card);
      });
    }

    // Render Templates
    const heading2 = document.createElement('h4');
    heading2.innerText = '📑 Build from Template';
    heading2.style.margin = '15px 0 5px 0';
    subgenreListEl.appendChild(heading2);

    subgenres.filter(sg => !sg.isCustom).forEach(sg => {
      const card = document.createElement('div');
      card.className = `subgenre-card`;
      card.innerHTML = `
        <h5>${sg.name}</h5>
        <p>${sg.description}</p>
        <button class="btn btn-secondary btn-full" style="margin-top: 10px; padding: 5px;">Build Collection</button>
      `;
      card.addEventListener('click', () => buildFromTemplate(sg.id));
      subgenreListEl.appendChild(card);
    });
  }

  async function deleteCollection(id) {
    if (!confirm('Are you sure you want to delete this collection? It will be removed from Stremio.')) return;
    try {
      const res = await fetch(`/api/collections/${id}`, { method: 'DELETE' }).then(r => r.json());
      if (res.success) {
        delete collections[id];
        localStorage.setItem('subgenre_collections', JSON.stringify(collections));
        if (currentActiveId === id) {
          currentActiveId = Object.keys(collections)[0] || null;
        }
        renderSubgenres();
        await loadActiveMovies();
      }
    } catch (e) {
      console.error(e);
      alert('Failed to delete collection');
    }
  }

  async function buildFromTemplate(id) {
    statusMsg.innerText = 'Building new collection...';
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeSubgenre: id })
      }).then(r => r.json());

      if (res.success) {
        const colRes = await fetch('/api/collections').then(r => r.json());
        collections = colRes;
        currentActiveId = id;
        renderSubgenres();
        await loadActiveMovies();
        statusMsg.innerText = 'Collection built!';
        setTimeout(() => statusMsg.innerText = '', 3000);
      }
    } catch (e) {
      statusMsg.innerText = 'Error building collection';
      console.error(e);
    }
  }

  async function selectCollection(id) {
    if (currentActiveId === id) return;
    currentActiveId = id;
    renderSubgenres();
    await loadActiveMovies();
  }

  async function loadActiveMovies() {
    try {
      if (!currentActiveId || !collections[currentActiveId]) {
        titleEl.innerText = 'No Collections';
        descEl.innerText = 'Create an AI subgenre or build from a template to get started.';
        countBadgeEl.innerText = '0';
        posterGridEl.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #9ca3af;">No collections loaded yet.</div>';
        return;
      }

      const activeObj = collections[currentActiveId];
      titleEl.innerText = activeObj.name;
      descEl.innerText = activeObj.description;

      const movies = await fetch(`/api/movies/${currentActiveId}`).then(r => r.json());
      countBadgeEl.innerText = movies.length;

      posterGridEl.innerHTML = '';
      if (movies.length === 0) {
        posterGridEl.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #9ca3af;">No movies loaded yet. Click Apply or create an AI subgenre!</div>';
        return;
      }

      movies.forEach(m => {
        const card = document.createElement('div');
        card.className = 'movie-card';
        card.innerHTML = `
          <div class="poster-wrapper">
            <img src="${m.poster}" alt="${m.name}" loading="lazy" onerror="this.src='https://via.placeholder.com/500x750?text=No+Poster'">
            <div class="movie-rating">★ ${m.imdbRating || 'N/A'}</div>
          </div>
          <div class="movie-info">
            <div class="movie-title">${m.name}</div>
            <div class="movie-meta">
              <span>${m.releaseInfo || ''}</span>
              <span class="imdb-badge">${m.id}</span>
            </div>
          </div>
        `;
        card.addEventListener('click', () => openMovieDetails(m.id));
        posterGridEl.appendChild(card);
      });
    } catch (e) {
      console.error('Error rendering movies:', e);
    }
  }

  // Open Movie Details Modal (Trailer, Full Summary, Ratings & Reviews)
  async function openMovieDetails(id) {
    movieDetailModal.style.display = 'flex';
    detailTitle.innerText = 'Loading Movie Details...';
    detailTagline.innerText = '';
    detailOverview.innerText = 'Fetching synopsis, ratings, trailer & reviews...';
    trailerContainer.innerHTML = '<div style="display:flex; justify-content:center; align-items:center; height:100%; color:#9ca3af;">🎬 Loading Official Trailer...</div>';
    reviewsContainer.innerHTML = '<div style="color:#9ca3af;">Loading recent reviews...</div>';

    try {
      const res = await fetch(`/api/movie-details/${id}`).then(r => r.json());
      if (res.error) throw new Error(res.error);

      const d = res.details;
      detailTitle.innerText = d.title;
      detailTagline.innerText = d.tagline ? `"${d.tagline}"` : '';
      detailOverview.innerText = d.overview;
      detailYear.innerText = d.releaseDate ? d.releaseDate.substring(0, 4) : 'N/A';
      detailRuntime.innerText = d.runtime || 'N/A';
      detailRatingBadge.innerText = `★ ${d.rating} (${d.voteCount} votes)`;
      detailGenres.innerText = d.genres.join(', ') || 'Movie';
      playStremioBtn.href = currentConfig.stremioUrl;

      // Trailer Embed
      if (res.youtubeTrailerKey) {
        trailerContainer.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${res.youtubeTrailerKey}?autoplay=1&rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
      } else {
        trailerContainer.innerHTML = `<div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:#9ca3af; text-align:center; padding:1rem;">
          <p style="font-size:1.1rem; font-weight:700; margin-bottom:0.5rem;">🎬 No Official Trailer Key</p>
          <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(d.title + ' ' + (d.releaseDate ? d.releaseDate.substring(0,4) : '') + ' official trailer')}" target="_blank" class="btn btn-secondary" style="margin-top:0.5rem;">
            🔍 Search Trailer on YouTube
          </a>
        </div>`;
      }

      // Reviews
      reviewsContainer.innerHTML = '';
      if (res.reviews && res.reviews.length > 0) {
        res.reviews.forEach(r => {
          const revCard = document.createElement('div');
          revCard.className = 'review-card';
          revCard.innerHTML = `
            <div class="review-header">
              <span class="review-author">👤 ${r.author}</span>
              ${r.rating ? `<span class="review-rating">★ ${r.rating}/10</span>` : ''}
            </div>
            <div class="review-text">${r.content}</div>
          `;
          reviewsContainer.appendChild(revCard);
        });
      } else {
        reviewsContainer.innerHTML = '<div style="color:#9ca3af; font-size:0.85rem;">No user reviews available yet for this movie.</div>';
      }

    } catch (err) {
      console.error(err);
      detailTitle.innerText = 'Error';
      detailOverview.innerText = 'Failed to load details for this movie.';
    }
  }

  function closeDetailModal() {
    movieDetailModal.style.display = 'none';
    trailerContainer.innerHTML = ''; // Stop video playback
  }

  closeDetailBtn.addEventListener('click', closeDetailModal);
  movieDetailModal.addEventListener('click', (e) => {
    if (e.target === movieDetailModal) closeDetailModal();
  });

  async function saveConfigToServer() {
    try {
      statusMsg.innerText = 'Syncing catalog...';
      const payload = {
        activeSubgenre: currentConfig.activeSubgenre,
        sortBy: sortSelect.value,
        tmdbApiKey: tmdbKeyInput.value.trim(),
        geminiApiKey: geminiKeyInput.value.trim()
      };

      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json());

      if (res.success) {
        statusMsg.innerText = `✓ Settings saved!`;
        setTimeout(() => { statusMsg.innerText = ''; }, 3000);
      }
    } catch (e) {
      statusMsg.innerText = '❌ Update failed';
      console.error(e);
    }
  }

  // Modal Handlers
  openCustomModalBtn.addEventListener('click', () => {
    customModal.style.display = 'flex';
    if (geminiKeyInput.value) {
      modalGeminiKey.value = geminiKeyInput.value;
    }
  });

  closeModalBtn.addEventListener('click', () => {
    customModal.style.display = 'none';
  });

  customModal.addEventListener('click', (e) => {
    if (e.target === customModal) {
      customModal.style.display = 'none';
    }
  });

  let currentScrubController = null;
  const cancelCustomBtn = document.getElementById('cancelCustomBtn');

  cancelCustomBtn.addEventListener('click', () => {
    if (currentScrubController) {
      currentScrubController.abort();
      currentScrubController = null;
    }
  });

  const promptSlotsContainer = document.getElementById('promptSlotsContainer');
  const addPromptSlotBtn = document.getElementById('addPromptSlotBtn');

  let slotCount = 1;
  if (addPromptSlotBtn && promptSlotsContainer) {
    addPromptSlotBtn.addEventListener('click', () => {
      slotCount++;
      const slotCard = document.createElement('div');
      slotCard.className = 'prompt-slot-card';
      slotCard.style.cssText = 'background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.08); position: relative;';
      slotCard.innerHTML = `
        <button type="button" class="remove-slot-btn" style="position: absolute; top: 10px; right: 10px; background: transparent; border: none; color: #ef4444; cursor: pointer; font-size: 1.1rem;" title="Remove Prompt">✕</button>
        <div class="form-group" style="margin-bottom: 8px;">
          <label style="font-weight: 600; font-size: 0.85rem; color: #a78bfa;">Collection #${slotCount} Name:</label>
          <input type="text" class="customNameInput form-control" placeholder="e.g. Black Horror & Thrillers">
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label style="font-size: 0.8rem;">AI Web Scrub Prompt / Description:</label>
          <textarea class="customPromptInput form-control" rows="2" placeholder="e.g. Black horror movies, social thrillers, and psychological suspense..."></textarea>
        </div>
      `;
      slotCard.querySelector('.remove-slot-btn').addEventListener('click', () => {
        slotCard.remove();
      });
      promptSlotsContainer.appendChild(slotCard);
    });
  }

  createCustomBtn.addEventListener('click', async () => {
    const key = modalGeminiKey.value.trim() || geminiKeyInput.value.trim();
    if (!key) {
      modalStatus.innerText = '⚠️ Please enter your Gemini API Key!';
      return;
    }

    const cards = promptSlotsContainer.querySelectorAll('.prompt-slot-card');
    const tasks = [];

    cards.forEach((card, index) => {
      const nameInput = card.querySelector('.customNameInput');
      const promptInput = card.querySelector('.customPromptInput');
      const name = nameInput ? nameInput.value.trim() : '';
      const prompt = promptInput ? promptInput.value.trim() : '';
      if (prompt) {
        tasks.push({ index: index + 1, name, prompt });
      }
    });

    if (tasks.length === 0) {
      modalStatus.innerText = '⚠️ Please enter at least one prompt description!';
      return;
    }

    try {
      createCustomBtn.disabled = true;
      createCustomBtn.innerText = `🤖 Gemini AI Scrubbing ${tasks.length} Collection${tasks.length > 1 ? 's' : ''}...`;
      cancelCustomBtn.style.display = 'block';

      geminiKeyInput.value = key;
      currentScrubController = new AbortController();

      let totalMovies = 0;
      let successCount = 0;
      let lastCreatedId = null;
      const errors = [];

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const taskName = t.name || t.prompt.slice(0, 25);
        modalStatus.style.color = '#a78bfa';
        modalStatus.innerText = `⏳ [${i + 1}/${tasks.length}] Scrubbing web for "${taskName}"... Please wait.`;

        try {
          const res = await fetch('/api/custom-genre', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: t.name || t.prompt.slice(0, 30),
              description: `AI-Curated Collection for "${t.prompt}"`,
              prompt: t.prompt,
              geminiApiKey: key,
              tmdbApiKey: tmdbKeyInput.value.trim()
            }),
            signal: currentScrubController.signal
          }).then(r => r.json());

          if (res.error) {
            console.error(`Collection #${t.index} failed:`, res.error);
            errors.push(`"${taskName}": ${res.error}`);
          } else if (res.success) {
            successCount++;
            totalMovies += res.count || 0;
            lastCreatedId = res.subgenre.id;

            // Live update UI immediately as each collection finishes!
            const colRes = await fetch('/api/collections').then(r => r.json());
            collections = colRes;
            localStorage.setItem('subgenre_collections', JSON.stringify(collections));
            currentActiveId = res.subgenre.id;
            renderSubgenres();
            await loadActiveMovies();
          }
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          console.error(`Collection #${t.index} fetch error:`, err.message);
          errors.push(`"${taskName}": ${err.message}`);
        }
      }

      if (successCount > 0) {
        modalStatus.style.color = '#10b981';
        let msg = `✓ Success! Created ${successCount} collection${successCount > 1 ? 's' : ''} with ${totalMovies} total movies!`;
        if (errors.length > 0) {
          msg += ` (${errors.length} failed)`;
        }
        modalStatus.innerText = msg;

        // Refresh collections and update UI
        const colRes = await fetch('/api/collections').then(r => r.json());
        collections = colRes;
        localStorage.setItem('subgenre_collections', JSON.stringify(collections));
        if (lastCreatedId) currentActiveId = lastCreatedId;
        renderSubgenres();
        await loadActiveMovies();

        setTimeout(() => {
          customModal.style.display = 'none';
          // Reset slots back to 1 slot
          promptSlotsContainer.innerHTML = `
            <div class="prompt-slot-card" style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.08);">
              <div class="form-group" style="margin-bottom: 8px;">
                <label style="font-weight: 600; font-size: 0.85rem; color: #a78bfa;">Collection #1 Name:</label>
                <input type="text" class="customNameInput form-control" placeholder="e.g. 90s & 2000s Hood Classics">
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label style="font-size: 0.8rem;">AI Web Scrub Prompt / Description:</label>
                <textarea class="customPromptInput form-control" rows="2" placeholder="e.g. Classic 90s and 2000s Black urban dramas..."></textarea>
              </div>
            </div>
          `;
          slotCount = 1;
          modalStatus.innerText = '';
          modalStatus.style.color = '';
        }, 2500);
      } else {
        const errorDetail = errors.length > 0 ? errors.join('; ') : 'Check API Key or prompt text.';
        throw new Error(errorDetail);
      }
    } catch (err) {
      console.error(err);
      modalStatus.style.color = '#ef4444';
      if (err.name === 'AbortError') {
        modalStatus.innerText = `🛑 Scrubbing cancelled.`;
      } else {
        modalStatus.innerText = `❌ Error: ${err.message}`;
      }
    } finally {
      createCustomBtn.disabled = false;
      createCustomBtn.innerText = '🤖 Scrub Web & Build Movie Catalog';
      cancelCustomBtn.style.display = 'none';
      currentScrubController = null;
    }
  });

  const copyTvUrlBtn = document.getElementById('copyTvUrlBtn');

  copyTvUrlBtn.addEventListener('click', () => {
    const tvUrl = currentConfig.manifestUrl || `http://${currentConfig.localIp}:7000/manifest.json`;
    navigator.clipboard.writeText(tvUrl);
    copyTvUrlBtn.innerText = '✓ Copied TV URL!';
    setTimeout(() => { copyTvUrlBtn.innerText = '📺 Copy TV Network URL'; }, 2000);
  });

  copyUrlBtn.addEventListener('click', () => {
    const manifestUrl = `${window.location.origin}/manifest.json`;
    navigator.clipboard.writeText(manifestUrl);
    copyUrlBtn.innerText = '✓ Copied!';
    setTimeout(() => { copyUrlBtn.innerText = '📋 Copy PC URL'; }, 2000);
  });

  // --- Mobile Navigation Logic ---
  const navHomeBtn = document.getElementById('navHomeBtn');
  const navAIBtn = document.getElementById('navAIBtn');
  const navSettingsBtn = document.getElementById('navSettingsBtn');
  const sidebarView = document.getElementById('sidebarView');
  const contentView = document.getElementById('contentView');

  // By default on mobile, hide the sidebar (Settings/Collections)
  sidebarView.classList.add('mobile-hidden');

  function updateMobileNav(activeBtn) {
    [navHomeBtn, navAIBtn, navSettingsBtn].forEach(btn => btn.classList.remove('active'));
    activeBtn.classList.add('active');
  }

  function revertNavIfAIOpen() {
    if (navAIBtn.classList.contains('active')) {
      if (!contentView.classList.contains('mobile-hidden')) {
        updateMobileNav(navHomeBtn);
      } else {
        updateMobileNav(navSettingsBtn);
      }
    }
  }

  navHomeBtn.addEventListener('click', () => {
    updateMobileNav(navHomeBtn);
    contentView.classList.remove('mobile-hidden');
    sidebarView.classList.add('mobile-hidden');
  });

  navAIBtn.addEventListener('click', () => {
    updateMobileNav(navAIBtn);
    customModal.style.display = 'flex';
    if (geminiKeyInput.value) {
      modalGeminiKey.value = geminiKeyInput.value;
    }
  });

  navSettingsBtn.addEventListener('click', () => {
    updateMobileNav(navSettingsBtn);
    sidebarView.classList.remove('mobile-hidden');
    contentView.classList.add('mobile-hidden');
  });

  // Hook into existing modal closes to revert nav active state
  closeModalBtn.addEventListener('click', revertNavIfAIOpen);
  customModal.addEventListener('click', (e) => {
    if (e.target === customModal) revertNavIfAIOpen();
  });

  init();
});

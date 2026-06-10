let allCarsMeta = [];
let allTracksMeta = [];
let selectedCarsForServer = [];
let activeBrandFilter = 'all';
let activeCategoryFilter = 'all';
let activeCountryFilter = 'all';
let carSearchQuery = '';
let trackSearchQuery = '';

async function loadCarsBrowser() {
  try {
    const res = await fetch('/api/ac/cars-meta');
    const data = await res.json();
    allCarsMeta = data.cars;
    renderBrands();
    renderCategories();
    renderCarsBrowser();
  } catch (e) { console.error('Erreur chargement voitures:', e); }
}

async function loadTracksBrowser() {
  try {
    const res = await fetch('/api/ac/tracks-meta');
    const data = await res.json();
    allTracksMeta = data.tracks;
    renderCountries();
    renderTracksBrowser();
  } catch (e) { console.error('Erreur chargement circuits:', e); }
}

function renderBrands() {
  const brands = ['all', ...new Set(allCarsMeta.map(c => c.brand).filter(Boolean).sort())];
  const container = document.getElementById('car-brand-filters');
  if (!container) return;
  container.innerHTML = '';
  brands.forEach(brand => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (brand === activeBrandFilter ? ' active' : '');
    btn.textContent = brand === 'all' ? '🚗 Toutes' : brand;
    btn.onclick = () => { activeBrandFilter = brand; activeCategoryFilter = 'all'; renderBrands(); renderCategories(); renderCarsBrowser(); };
    container.appendChild(btn);
  });
}

function renderCategories() {
  const filtered = activeBrandFilter === 'all' ? allCarsMeta : allCarsMeta.filter(c => c.brand === activeBrandFilter);
  const categories = ['all', ...new Set(filtered.map(c => c.category).filter(Boolean).sort())];
  const container = document.getElementById('car-category-filters');
  if (!container) return;
  container.innerHTML = '';
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (cat === activeCategoryFilter ? ' active' : '');
    btn.textContent = cat === 'all' ? '🏷️ Toutes' : cat;
    btn.onclick = () => { activeCategoryFilter = cat; renderCategories(); renderCarsBrowser(); };
    container.appendChild(btn);
  });
}

function renderCountries() {
  const countries = ['all', ...new Set(allTracksMeta.map(t => t.country).filter(Boolean).sort())];
  const container = document.getElementById('track-country-filters');
  if (!container) return;
  container.innerHTML = '';
  countries.forEach(country => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (country === activeCountryFilter ? ' active' : '');
    btn.textContent = country === 'all' ? '🌍 Tous' : country;
    btn.onclick = () => { activeCountryFilter = country; renderCountries(); renderTracksBrowser(); };
    container.appendChild(btn);
  });
}

function renderCarsBrowser() {
  const container = document.getElementById('cars-browser-grid');
  if (!container) return;

  let filtered = allCarsMeta;
  if (activeBrandFilter !== 'all') filtered = filtered.filter(c => c.brand === activeBrandFilter);
  if (activeCategoryFilter !== 'all') filtered = filtered.filter(c => c.category === activeCategoryFilter);
  if (carSearchQuery) filtered = filtered.filter(c =>
    c.name.toLowerCase().includes(carSearchQuery) || c.id.toLowerCase().includes(carSearchQuery)
  );

  const count = document.getElementById('cars-browser-count');
  if (count) count.textContent = filtered.length + ' voiture(s)';

  container.innerHTML = '';
  filtered.forEach(car => {
    const isSelected = selectedCarsForServer.includes(car.id);
    const card = document.createElement('div');
    card.className = 'car-card' + (isSelected ? ' selected' : '');
    card.dataset.carid = car.id;
    card.innerHTML = `
      <div class="car-card-img-wrap">
        <img class="car-badge" src="/api/ac/car-image/${car.id}/badge.png" alt="${car.name}"
          onerror="this.parentElement.innerHTML='<div style=\\'font-size:2rem;line-height:90px;text-align:center\\'>🚗</div>'"
          onmouseover="showCarPreview('${car.id}', '${car.name.replace(/'/g, "\\'").replace(/"/g, '\\"')}')"
          onmouseout="hideCarPreview()" />
      </div>
      <div class="car-card-info">
        <div class="car-card-name">${car.name}</div>
        <div class="car-card-brand">${car.brand}</div>
        <div class="car-card-cat">${car.category || ''}</div>
        ${car.specs && car.specs.bhp ? '<div class="car-card-spec">⚡ ' + car.specs.bhp + '</div>' : ''}
      </div>
      <div class="car-card-check">
        <input type="checkbox" ${isSelected ? 'checked' : ''} />
      </div>
    `;

    const checkbox = card.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleCarSelection(car.id, e.target.checked);
      card.classList.toggle('selected', e.target.checked);
    });

    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'IMG') return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    container.appendChild(card);
  });

  updateSelectedCount();
}

function renderTracksBrowser() {
  const container = document.getElementById('tracks-browser-grid');
  if (!container) return;

  let filtered = allTracksMeta;
  if (activeCountryFilter !== 'all') filtered = filtered.filter(t => t.country === activeCountryFilter);
  if (trackSearchQuery) filtered = filtered.filter(t =>
    t.name.toLowerCase().includes(trackSearchQuery) || t.id.toLowerCase().includes(trackSearchQuery)
  );

  const count = document.getElementById('tracks-browser-count');
  if (count) count.textContent = filtered.length + ' circuit(s)';

  container.innerHTML = '';
  filtered.forEach(track => {
    const config = (track.configs && track.configs[0]) ? encodeURIComponent(track.configs[0]) : '_';
    const card = document.createElement('div');
    card.className = 'track-card';
    card.innerHTML = `
      <div class="track-card-preview">
        <img src="/api/ac/track-image/${track.id}/${config}/preview.png" alt="${track.name}"
          onerror="this.style.display='none'" />
        <img class="track-outline" src="/api/ac/track-image/${track.id}/${config}/outline.png" alt=""
          onerror="this.style.display='none'" />
      </div>
      <div class="track-card-info">
        <div class="track-card-name">${track.name}</div>
        <div class="track-card-meta">
          <span>🌍 ${track.country}</span>
          <span>📏 ${track.length}</span>
        </div>
        ${track.description ? '<div class="track-card-desc">' + track.description.substring(0, 80).replace(/<[^>]*>/g, '') + '...</div>' : ''}
      </div>
      <button class="btn-select-track" onclick="selectTrack('${track.id}', '${(track.configs && track.configs[0]) ? track.configs[0].replace(/'/g, "\\'") : ''}', '${track.name.replace(/'/g, "\\'")}')">
        🏁 Sélectionner
      </button>
    `;
    container.appendChild(card);
  });
}

function toggleCarSelection(carId, checked) {
  if (checked && !selectedCarsForServer.includes(carId)) {
    selectedCarsForServer.push(carId);
  } else if (!checked) {
    selectedCarsForServer = selectedCarsForServer.filter(id => id !== carId);
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  const countEl = document.getElementById('selected-cars-count');
  if (countEl) countEl.textContent = selectedCarsForServer.length;
}

function updateSelectedCarsPanel(carsToShow) {
  const container = document.getElementById('ac-cars-list');
  if (!container) return;
  container.innerHTML = '';
  if (!carsToShow || carsToShow.length === 0) {
    container.innerHTML = '<div style="color:#4a5568;font-size:0.82rem;padding:8px">Aucune voiture sélectionnée. Utilise le <strong style="color:#fb923c">Navigateur AC</strong> pour en choisir.</div>';
    return;
  }
  carsToShow.forEach(carId => {
    const meta = allCarsMeta.find(c => c.id === carId);
    const name = meta ? meta.name : carId;
    const brand = meta ? meta.brand : '';
    const tag = document.createElement('div');
    tag.className = 'selected-car-tag';
    tag.innerHTML = `
      <img src="/api/ac/car-image/${carId}/badge.png" alt="" onerror="this.style.display='none'" style="width:28px;height:28px;object-fit:contain;flex-shrink:0" />
      <div style="flex:1;min-width:0">
        <div style="font-size:0.82rem;font-weight:bold;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
        <div style="font-size:0.72rem;color:#fb923c">${brand}</div>
      </div>
      <button onclick="removeFromPanel('${carId}')">✕</button>
    `;
    container.appendChild(tag);
  });
}

function removeFromPanel(carId) {
  const currentCars = getCurrentPanelCars();
  const updated = currentCars.filter(id => id !== carId);
  updateSelectedCarsPanel(updated);
}

function getCurrentPanelCars() {
  const tags = document.querySelectorAll('#ac-cars-list .selected-car-tag');
  return Array.from(tags).map(tag => {
    const btn = tag.querySelector('button');
    const onclick = btn.getAttribute('onclick');
    const match = onclick.match(/removeFromPanel\('([^']+)'\)/);
    return match ? match[1] : null;
  }).filter(Boolean);
}

function applyBrowserSelection() {
  if (selectedCarsForServer.length === 0) {
    alert('Sélectionne au moins une voiture dans le navigateur.');
    return;
  }
  applyCarSelectionToPanel([...selectedCarsForServer]);
  selectedCarsForServer = [];
  updateSelectedCount();
  renderCarsBrowser();
  const acBtn = document.querySelector('.nav-btn[onclick*="assetto"]');
  if (acBtn) showTab('assetto', acBtn);
  setTimeout(() => showInnerTab('ac', 'config', null), 100);
}

function selectTrack(trackId, config, name) {
  const trackSelect = document.getElementById('ac-track');
  if (trackSelect) {
    for (let opt of trackSelect.options) { if (opt.value === trackId) { opt.selected = true; break; } }
  }
  loadTrackConfigs().then(() => {
    const configSelect = document.getElementById('ac-track-config');
    if (configSelect && config) {
      for (let opt of configSelect.options) { if (opt.value === config) { opt.selected = true; break; } }
    }
    updateTrackPreview();
  });
  const msg = document.getElementById('ac-track-selected');
  if (msg) { msg.textContent = '✅ ' + name; msg.style.color = '#4ade80'; }
  const acBtn = document.querySelector('.nav-btn[onclick*="assetto"]');
  if (acBtn) showTab('assetto', acBtn);
  setTimeout(() => showInnerTab('ac', 'config', null), 100);
}

let previewTimeout = null;
function showCarPreview(carId, carName) {
  clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    let overlay = document.getElementById('car-preview-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'car-preview-overlay';
      overlay.className = 'car-preview-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <img src="/api/ac/car-image/${carId}/preview.jpg" alt="${carName}"
        onerror="this.src='/api/ac/car-image/${carId}/badge.png'" />
      <div class="car-preview-name">${carName}</div>
    `;
    overlay.style.display = 'block';
  }, 300);
}

function hideCarPreview() {
  clearTimeout(previewTimeout);
  const overlay = document.getElementById('car-preview-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function syncSelectedCarsFromConfig() {
  try {
    const res = await fetch('/api/ac/config');
    const data = await res.json();
    if (allCarsMeta.length > 0) {
      updateSelectedCarsPanel(data.selectedCars || []);
    }
  } catch (e) {}
}

function showBrowserTab(name, btn) {
  document.querySelectorAll('#tab-ac-browser .inner-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#tab-ac-browser .tab-inner-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('browser-inner-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
}

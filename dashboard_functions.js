/**
 * dashboard.js
 * ============
 * Bond Spread Dashboard | Core Application Logic
 *
 * Depends on: Chart.js (global), curve_fit.js (window.NS)
 * Loaded after the HTML body and curve_fit.js.
 */

// ── DATA — loaded from data.json ────────────────────────────────────────────
let allData = [];

// ── CONFIG — built from settings at init ────────────────────────────────────
let CFG = null;

// ── PARSING ─────────────────────────────────────────────────────────────────

function getTTM(maturity, date) {
  return +((new Date(maturity) - new Date(date)) / (365.25 * 86400000)).toFixed(2);
}

// ── STATE ───────────────────────────────────────────────────────────────────
let state = {
  selections:      [],
  picker:          {},
  chartType:       "scatter",
  highlightedISIN: null,
  xField:          "ttm",
  yField:          "oas",
  fitCfg:          { method: "auto", degree: 2, tauFixed: null, lambda: "auto", knots: "auto" },
};

// ── COLOUR PALETTE ──────────────────────────────────────────────────────────
const PALETTE = [
  "#00d4aa","#4d9fff","#f0b429","#ff6b35","#c084fc",
  "#fb7185","#34d399","#f472b6","#38bdf8","#a3e635",
  "#e879f9","#fb923c",
];
function nextColor() {
  const used = new Set(state.selections.map(s => s.color));
  const free = PALETTE.find(c => !used.has(c));
  return free ?? PALETTE[state.selections.length % PALETTE.length];
}

// ── AXIS HELPERS ────────────────────────────────────────────────────────────
let FIELD_LABELS = {};

function getFieldLabel(key) {
  return FIELD_LABELS[key] || key;
}

function updateChartTitle() {
  const xl = getFieldLabel(state.xField);
  const yl = getFieldLabel(state.yField);
  document.getElementById("chartTitle").textContent =
    yl.toUpperCase() + " vs " + xl.toUpperCase();
}

function getBondValue(b, field) {
  if (field === "ttm") return b.ttm;
  return b[field] ?? null;
}

function populateAxisSelects() {
  const xSel = document.getElementById("xAxisSelect");
  const ySel = document.getElementById("yAxisSelect");
  xSel.innerHTML = "";
  ySel.innerHTML = "";
  CFG.axes.forEach(f => {
    xSel.innerHTML += `<option value="${f.key}" ${f.key === state.xField ? "selected" : ""}>${f.label}</option>`;
    ySel.innerHTML += `<option value="${f.key}" ${f.key === state.yField ? "selected" : ""}>${f.label}</option>`;
  });
}

function setAxis(axis, field) {
  if (axis === "x") state.xField = field;
  else              state.yField = field;
  updateChartTitle();
  autoSaveSelections();
  renderChart();
}

// ── DERIVED — all config-driven ─────────────────────────────────────────────

function getGroupValues(groupIdx) {
  const groups = CFG.groups;
  let bonds = allData;

  for (let j = 0; j < groupIdx; j++) {
    const g   = groups[j];
    const val = state.picker[g.key];
    if (val == null) return [];
    if (g.all_option && val === g.default) continue;
    bonds = bonds.filter(b => b[g.key] === val);
  }

  const g   = groups[groupIdx];
  const set = new Set(bonds.map(b => b[g.key]));
  let vals  = [...set];

  if (g.sort === "desc") vals = vals.sort().reverse();
  else if (g.sort === "asc") vals = vals.sort();
  else vals = vals.sort((a, b) => typeof a === "string" ? a.localeCompare(b) : a - b);

  if (g.all_option) vals = [g.default, ...vals.filter(v => v !== g.default)];
  return vals;
}

function countBondsForValue(groupIdx, value) {
  const groups = CFG.groups;
  let bonds = allData;
  for (let j = 0; j <= groupIdx; j++) {
    const g   = groups[j];
    const val = j === groupIdx ? value : state.picker[g.key];
    if (g.all_option && val === g.default) continue;
    if (val != null) bonds = bonds.filter(b => b[g.key] === val);
  }
  if (CFG.groups[groupIdx].searchable) return new Set(bonds.map(b => b.isin)).size;
  return bonds.length;
}

function getBondsForSelection(sel) {
  let bonds = allData;
  for (const g of CFG.groups) {
    const val = sel[g.key];
    if (g.all_option && val === g.default) continue;
    if (val != null) bonds = bonds.filter(b => b[g.key] === val);
  }
  return bonds.map(b => ({ ...b, ttm: getTTM(b.maturity, b.date) }));
}

function getAllActiveBonds() {
  return state.selections.flatMap((sel, i) =>
    getBondsForSelection(sel).map(b => ({ ...b, _selIdx: i, _color: sel.color }))
  );
}

function getPreviewBonds() {
  const ready = CFG.groups.every(g => state.picker[g.key] != null);
  if (!ready) return [];
  const alreadyAdded = state.selections.some(s =>
    CFG.groups.every(g => s[g.key] === state.picker[g.key])
  );
  if (alreadyAdded) return [];
  return getBondsForSelection(state.picker);
}

function getAllVisibleBonds() {
  return [...getAllActiveBonds(), ...getPreviewBonds()];
}


// ── CHART ───────────────────────────────────────────────────────────────────
let chart = null;

function renderChart() {
  const canvas = document.getElementById('spreadChart');
  const empty  = document.getElementById('emptyState');

  const previewReady = CFG && CFG.groups.every(g => state.picker[g.key] != null);
  const pvBonds      = previewReady ? getBondsForSelection(state.picker) : [];

  if (!state.selections.length && !pvBonds.length) {
    canvas.style.display = 'none';
    empty.style.display  = 'flex';
    return;
  }
  canvas.style.display = 'block';
  empty.style.display  = 'none';

  const xF = state.xField;
  const yF = state.yField;
  const xl = getFieldLabel(xF);
  const yl = getFieldLabel(yF);
  const mode = state.chartType === 'line' ? 'ns' : 'scatter';

  function toPoint(b) {
    const x = getBondValue(b, xF);
    const y = getBondValue(b, yF);
    if (x == null || y == null || !isFinite(x) || !isFinite(y)) return null;
    return { x, y, isin: b.isin };
  }

  const datasets = [];

  // confirmed selections
  state.selections.forEach((sel, si) => {
    const points = getBondsForSelection(sel).map(toPoint).filter(Boolean);
    if (!points.length) return;
    const label = CFG.groups.map(g => sel[g.key]).join(" · ");
    datasets.push(...NS.buildDatasets({
      points, mode,
      color:           sel.color,
      label,
      highlightedISIN: state.highlightedISIN,
      seriesIndex:     si,
      fitCfg:          state.fitCfg,
    }));
  });

  // preview
  const alreadyAdded = state.selections.some(s =>
    CFG.groups.every(g => s[g.key] === state.picker[g.key])
  );
  if (pvBonds.length && !alreadyAdded) {
    const pvPoints = pvBonds.map(toPoint).filter(Boolean);
    if (pvPoints.length) {
      const pvLabel = `[preview] ${CFG.groups.map(g => state.picker[g.key]).join(" · ")}`;
      datasets.push(...NS.buildPreviewDatasets({ points: pvPoints, mode, label: pvLabel, fitCfg: state.fitCfg, highlightedISIN: state.highlightedISIN }));
    }
  }

  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'nearest', intersect: true },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const el = elements[0];
        const raw = el.element.$context?.raw;
        if (raw && raw.isin) highlightBond(raw.isin);
      },
      plugins: {
        legend: {
          labels: {
            color: '#4e5a6a',
            font:  { family: 'IBM Plex Mono', size: 10 },
            boxWidth: 8, padding: 16,
            filter: item => !item.text.startsWith('_'),
          }
        },
        tooltip: {
          backgroundColor: '#111418',
          borderColor: '#2a313b', borderWidth: 1,
          titleColor: '#c8d0dc', bodyColor: '#4e5a6a',
          titleFont: { family: 'IBM Plex Mono', size: 11, weight: '500' },
          bodyFont:  { family: 'IBM Plex Mono', size: 10 },
          padding: 10,
          filter: item => !item.dataset.label.startsWith('_'),
          callbacks: {
            title: () => '',
            label: item => {
              const r = item.raw;
              if (!r.isin) return null;
              return [
                `ISIN : ${r.isin}`,
                `${xl.padEnd(4)} : ${r.x.toFixed(2)}`,
                `${yl.padEnd(4)} : ${r.y.toFixed(0)}`,
              ];
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: xl.toUpperCase(), color: '#4e5a6a',
                   font: { family: 'IBM Plex Mono', size: 9 }, padding: { top: 8 } },
          grid:  { color: 'rgba(30,35,41,0.8)', lineWidth: 1 },
          ticks: { color: '#4e5a6a', font: { family: 'IBM Plex Mono', size: 9 }, maxTicksLimit: 10 },
        },
        y: {
          title: { display: true, text: yl.toUpperCase(), color: '#4e5a6a',
                   font: { family: 'IBM Plex Mono', size: 9 }, padding: { bottom: 8 } },
          grid:  { color: 'rgba(30,35,41,0.8)', lineWidth: 1 },
          ticks: { color: '#4e5a6a', font: { family: 'IBM Plex Mono', size: 9 } },
        }
      }
    }
  });
}


// ── SIDEBAR RENDER — fully config-driven ────────────────────────────────────

function buildSidebar() {
  const container = document.getElementById("pickerSteps");
  container.innerHTML = CFG.groups.map((g, i) => {
    const isLast    = !!g.is_last;
    const flex      = isLast ? "flex:1; overflow:hidden; display:flex; flex-direction:column;" : "flex:0 0 auto;";
    const stepLabel = `${i + 1} · ${g.label}`;

    if (g.searchable) {
      return `
        <div class="sidebar-section" style="flex:0 0 auto;">
          <div class="section-label">${stepLabel}</div>
          <div class="search-wrap" style="margin-bottom:10px">
            <span class="search-icon">⌕</span>
            <input type="text" id="groupSearch_${g.key}" placeholder="Search ${g.label.toLowerCase()}…"
                  oninput="renderGroupStep(${i}, this.value)">
          </div>
        </div>
        <div class="issuer-list" id="groupList_${g.key}" style="max-height:160px"></div>`;
    }

    if (isLast) {
      return `
        <div class="sidebar-section" style="flex:0 0 auto;">
          <div class="section-label">${stepLabel}</div>
          <div class="date-list" id="groupList_${g.key}" style="max-height:200px;overflow-y:auto">
            <div style="font-size:10px;color:var(--muted);padding:4px">Select ${CFG.groups[0].label.toLowerCase()} first</div>
          </div>
          <button class="add-btn" id="addBtn" disabled onclick="addSelection()">+ ADD TO CHART</button>
        </div>`;
    }

    // middle group — pills
    const prevLabel = i > 0 ? CFG.groups[i - 1].label.toLowerCase() : "";
    return `
      <div class="sidebar-section" style="${flex}">
        <div class="section-label">${stepLabel}</div>
        <div class="bond-types" id="groupList_${g.key}">
          ${i > 0 ? `<span style="font-size:10px;color:var(--muted)">Select ${prevLabel} first</span>` : ""}
        </div>
      </div>`;
  }).join("");

  // wire up search listener for any searchable group
  CFG.groups.forEach((g, i) => {
    if (g.searchable) {
      const el = document.getElementById(`groupSearch_${g.key}`);
      if (el) el.addEventListener("input", e => renderGroupStep(i, e.target.value));
    }
  });
}

function renderGroupStep(groupIdx, filter = "") {
  const g      = CFG.groups[groupIdx];
  const el     = document.getElementById(`groupList_${g.key}`);
  if (!el) return;

  const values = getGroupValues(groupIdx);
  const isLast = !!g.is_last;

  if (!values.length) {
    const prev = groupIdx > 0 ? CFG.groups[groupIdx - 1].label.toLowerCase() : "";
    el.innerHTML = `<div style="font-size:10px;color:var(--muted);padding:4px">Select ${prev} first</div>`;
    return;
  }

  if (g.searchable) {
    const filtered = values.filter(v =>
      String(v).toLowerCase().includes(filter.toLowerCase())
    );
    el.innerHTML = filtered.map(v => {
      const count = countBondsForValue(groupIdx, v);
      return `
        <div class="issuer-item ${state.picker[g.key] === v ? "active" : ""}"
             onclick="pickGroupValue(${groupIdx}, '${String(v).replace(/'/g, "\\'")}')">
          <span class="issuer-name">${v}</span>
          <span class="issuer-count">${count}</span>
        </div>`;
    }).join("");
    return;
  }

  if (isLast) {
    el.innerHTML = values.map(v => {
      const n = g.show_count ? countBondsForValue(groupIdx, v) : null;
      return `
        <div class="date-item ${state.picker[g.key] === v ? "active" : ""}"
             onclick="pickGroupValue(${groupIdx}, '${String(v).replace(/'/g, "\\'")}')">
          <span>${v}</span>
          ${n != null ? `<span class="date-n-bonds">${n}b</span>` : ""}
        </div>`;
    }).join("");
    return;
  }

  // pills style (middle groups)
  el.innerHTML = values.map(v => `
    <span class="pill ${state.picker[g.key] === v ? "active" : ""}"
          onclick="pickGroupValue(${groupIdx}, '${String(v).replace(/'/g, "\\'")}')">${String(v).toUpperCase()}</span>
  `).join("");
}

function renderAllGroupSteps() {
  CFG.groups.forEach((_, i) => renderGroupStep(i));
}

function renderSelectionTags() {
  const container = document.getElementById("selectionTags");
  if (!state.selections.length) {
    container.innerHTML =
      '<div style="font-size:9px;color:var(--muted);padding:2px 0">No series added yet</div>';
    return;
  }
  container.innerHTML = state.selections.map((sel, i) => {
    const label = CFG.groups.map(g => sel[g.key]).join(" · ");
    return `
      <div class="sel-tag" style="--tag-color:${sel.color}">
        <span class="sel-tag-label" title="${label}">${label}</span>
        <span class="sel-tag-remove" onclick="removeSelection(${i})">×</span>
      </div>`;
  }).join("");
}

function renderStats() {
  const all = getAllVisibleBonds();
  if (!all.length) {
    ['statIssuer','statBonds','statAvgOas','statMinOas','statMaxOas','statAvgMat']
      .forEach(id => document.getElementById(id).textContent = '—');
    return;
  }
  const oas  = all.map(b => b.oas).filter(v => v != null);
  const ttms = all.map(b => b.ttm).filter(v => v != null);
  const issuers = [...new Set(all.map(b => b.ticker))];
  document.getElementById('statIssuer').textContent =
    issuers.length === 1 ? issuers[0] : `${issuers.length} issuers`;
  document.getElementById('statBonds').textContent  = new Set(all.map(b => b.isin)).size;
  document.getElementById('statAvgOas').textContent =
    Math.round(oas.reduce((a,b)=>a+b,0)/oas.length);
  document.getElementById('statMinOas').textContent =
    oas.reduce((min, v) => v < min ? v : min, Infinity);
  document.getElementById('statMaxOas').textContent =
    oas.reduce((max, v) => v > max ? v : max, -Infinity);
  document.getElementById('statAvgMat').textContent =
    (ttms.reduce((a,b)=>a+b,0)/ttms.length).toFixed(1);
}

// ── COLUMN SYSTEM ───────────────────────────────────────────────────────────

const ALWAYS_LOCKED = new Set(["isin"]);
let SKIP_IN_TABLE = new Set(["ticker", "type"]);

let ALL_COLS      = [];
let visibleCols   = new Set();
let defaultVisible = new Set();

function keyToLabel(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function makeRenderer(key, sample) {
  const v = sample[key];

  if (key === "isin")
    return b => `<td class="td-isin">${b[key] ?? "—"}</td>`;
  if (key === "oas")
    return b => `<td class="${(b[key] ?? 0) > 600 ? 'td-oas-neg' : 'td-oas-pos'}">${b[key] ?? "—"}</td>`;
  if (key === "ttm")
    return b => `<td>${b.ttm != null ? b.ttm.toFixed(2) : "—"}</td>`;
  if (key === "maturity" || key === "date")
    return b => `<td style="color:var(--muted)">${b[key] ?? "—"}</td>`;

  if (typeof v === "number") {
    const isPct = /coupon|yield|rate|margin|return|pct|percent/.test(key);
    const dp    = Math.abs(v) < 10 ? 3 : 1;
    return b => {
      const val = b[key];
      if (val == null || !isFinite(val)) return '<td style="color:var(--muted)">—</td>';
      return `<td>${val.toFixed(dp)}${isPct ? "%" : ""}</td>`;
    };
  }
  if (typeof v === "string") {
    const isLong = v.length > 15;
    return b => {
      const val = b[key];
      if (!val) return '<td style="color:var(--muted)">—</td>';
      return isLong
        ? `<td style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${val}</td>`
        : `<td style="color:var(--muted);font-size:9px">${val}</td>`;
    };
  }
  return b => `<td style="color:var(--muted)">${b[key] ?? "—"}</td>`;
}

function buildColSystem(sample) {
  if (!sample) return;

  ALL_COLS = [];
  const allKeys = ["ttm", ...Object.keys(sample)];
  const groupKeys = new Set(CFG.groups.map(g => g.key));

  for (const key of allKeys) {
    if (SKIP_IN_TABLE.has(key)) continue;

    const locked = ALWAYS_LOCKED.has(key);
    const label  = keyToLabel(key);
    const render = makeRenderer(key, key === "ttm" ? { [key]: 0 } : sample);

    ALL_COLS.push({ key, label, locked, render });
  }

  const optional = ALL_COLS.filter(c => !c.locked);
  defaultVisible = new Set([
    ...ALL_COLS.filter(c => c.locked).map(c => c.key),
    ...optional.slice(0, 7).map(c => c.key),
  ]);
  visibleCols = new Set(defaultVisible);
}

function activeCols() {
  return ALL_COLS.filter(c => c.locked || visibleCols.has(c.key));
}

// ── COLUMN PICKER ───────────────────────────────────────────────────────────
function populateColPicker() {
  const grid = document.getElementById("colPickerGrid");
  if (!grid) return;
  const optional = ALL_COLS.filter(c => !c.locked);
  grid.innerHTML = optional.map(c => `
    <label class="col-check">
      <input type="checkbox"
             ${visibleCols.has(c.key) ? "checked" : ""}
             onchange="toggleCol('${c.key}', this.checked)">
      ${c.label}
    </label>
  `).join("");
}

function toggleColPicker() {
  document.getElementById("colPickerPanel").classList.toggle("open");
}

document.addEventListener("click", e => {
  const panel = document.getElementById("colPickerPanel");
  if (!panel) return;
  if (!panel.contains(e.target) && !e.target.closest(".col-picker-btn"))
    panel.classList.remove("open");
});

function toggleCol(key, checked) {
  if (checked) visibleCols.add(key);
  else         visibleCols.delete(key);
  renderTable(getAllVisibleBonds());
}

function resetCols() {
  visibleCols = new Set(defaultVisible);
  populateColPicker();
  renderTable(getAllVisibleBonds());
}

// ── TABLE RENDER ────────────────────────────────────────────────────────────
function renderTable(bonds) {
  const cols   = activeCols();
  const sorted = [...bonds].sort((a, b) => (a.ttm ?? 0) - (b.ttm ?? 0));

  document.getElementById("tableHead").innerHTML =
    cols.map(c => `<th>${c.label.toUpperCase()}</th>`).join("");

  document.getElementById("bondTable").innerHTML = sorted.map(b => `
    <tr onclick="highlightBond('${String(b.isin).replace(/'/g, "\\'")}')"
        class="${b.isin === state.highlightedISIN ? "highlighted" : ""}">
      ${cols.map(c => c.render(b)).join("")}
    </tr>
  `).join("");
}

function renderSubtitle() {
  const confirmed = getAllActiveBonds();
  const preview   = getPreviewBonds();
  if (!confirmed.length && !preview.length) {
    document.getElementById('chartSubtitle').textContent =
      'Select an issuer to preview · click Add to keep';
    return;
  }
  const selLabel = s => CFG.groups.map(g => s[g.key]).join("·");
  const parts = [];
  if (state.selections.length)
    parts.push(...state.selections.map(selLabel));
  if (preview.length)
    parts.push(`[preview] ${selLabel(state.picker)}`);
  document.getElementById('chartSubtitle').textContent =
    `${parts.join('  /  ')}  ·  ${confirmed.length + preview.length} bonds`;
}

function fullRender() {
  renderStats();
  renderChart();
  renderTable(getAllVisibleBonds());
  renderSubtitle();
}

// ── PICKER ACTIONS ──────────────────────────────────────────────────────────

function pickGroupValue(groupIdx, value) {
  const g = CFG.groups[groupIdx];
  state.picker[g.key] = value;

  for (let j = groupIdx + 1; j < CFG.groups.length; j++) {
    const dg = CFG.groups[j];
    state.picker[dg.key] = dg.default ?? null;
  }

  for (let j = groupIdx + 1; j < CFG.groups.length; j++) {
    const vals = getGroupValues(j);
    if (vals.length) {
      state.picker[CFG.groups[j].key] = vals[0];
    } else {
      break;
    }
  }

  renderAllGroupSteps();
  updateAddBtn();
  renderPreview();
}

function renderPreview() {
  renderChart();
  renderStats();
  renderTable(getAllVisibleBonds());
  renderSubtitle();
  playerShow();
}

function updateAddBtn() {
  const btn  = document.getElementById("addBtn");
  const ready = CFG.groups.every(g => state.picker[g.key] != null);
  btn.disabled = !ready;
}

// ── SELECTION MANAGEMENT ────────────────────────────────────────────────────
function addSelection() {
  const ready = CFG.groups.every(g => state.picker[g.key] != null);
  if (!ready) return;
  const exists = state.selections.some(s =>
    CFG.groups.every(g => s[g.key] === state.picker[g.key])
  );
  if (!exists) {
    const entry = { color: nextColor() };
    CFG.groups.forEach(g => { entry[g.key] = state.picker[g.key]; });
    state.selections.push(entry);
  }
  renderSelectionTags();
  autoSaveSelections();
  fullRender();
}

function removeSelection(idx) {
  state.selections.splice(idx, 1);
  renderSelectionTags();
  autoSaveSelections();
  fullRender();
}

function clearAllSelections() {
  state.selections = [];
  playerStop();
  renderSelectionTags();
  autoSaveSelections();
  fullRender();
}

function highlightBond(isin) {
  state.highlightedISIN = state.highlightedISIN === isin ? null : isin;
  renderTable(getAllVisibleBonds());
  renderChart();

  if (state.highlightedISIN) {
    const row = document.querySelector("#bondTable tr.highlighted");
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function setChartType(type) {
  state.chartType = type;
  document.getElementById('btnScatter').classList.toggle('active', type === 'scatter');
  document.getElementById('btnLine').classList.toggle('active', type === 'line');
  autoSaveSelections();
  renderChart();
}

// ── FIT PANEL ───────────────────────────────────────────────────────────────

function toggleFitPanel() {
  const panel = document.getElementById("fitPanel");
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) buildFitPanel();
}

document.addEventListener("click", e => {
  const panel = document.getElementById("fitPanel");
  if (!panel) return;
  if (!panel.contains(e.target) && !e.target.closest("#btnFitSettings"))
    panel.classList.remove("open");
});

function buildFitPanel() {
  const panel = document.getElementById("fitPanel");
  const methods = NS.METHODS;
  const current = state.fitCfg.method;

  let html = '<div class="fit-panel-title">Fitting Method</div>';
  html += '<div class="fit-methods">';
  for (const m of methods) {
    html += `<button class="fit-method-btn ${m.key === current ? 'active' : ''}"
                     onclick="setFitMethod('${m.key}')">${m.label.toUpperCase()}</button>`;
  }
  html += '</div>';

  const mdef = methods.find(m => m.key === current);
  if (mdef && mdef.params) {
    html += '<div class="fit-params">';
    for (const p of mdef.params) {
      const val = state.fitCfg[p.key] ?? p.default;
      html += `<div class="fit-param-row">
        <span class="fit-param-label">${p.label}</span>
        <select class="fit-param-select" onchange="setFitParam('${p.key}', this.value)">`;
      for (const opt of p.options) {
        const [v, lbl] = Array.isArray(opt) ? opt : [opt, String(opt)];
        html += `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${lbl}</option>`;
      }
      html += '</select></div>';
    }
    html += '</div>';
  }

  if (mdef) {
    html += `<div class="fit-desc">${mdef.desc}</div>`;
  }

  panel.innerHTML = html;
}

function setFitMethod(method) {
  state.fitCfg.method = method;
  const mdef = NS.METHODS.find(m => m.key === method);
  if (mdef && mdef.params) {
    for (const p of mdef.params) {
      state.fitCfg[p.key] = p.default;
    }
  }
  buildFitPanel();
  if (state.chartType === 'line') renderChart();
}

function setFitParam(key, value) {
  state.fitCfg[key] = value;
  if (state.chartType === 'line') renderChart();
}

// ── TIMELINE PLAYER ─────────────────────────────────────────────────────────

let player = {
  active: false,
  playing: false,
  dates: [],
  index: 0,
  interval: null,
  speed: 1000,
};

function playerGetDates() {
  const dateGroup = CFG.groups.find(g => g.is_last);
  if (!dateGroup) return [];

  const dateIdx = CFG.groups.indexOf(dateGroup);
  for (let j = 0; j < dateIdx; j++) {
    if (state.picker[CFG.groups[j].key] == null) return [];
  }
  return getGroupValues(dateIdx).sort();
}

function playerShow() {
  const dates = playerGetDates();
  const bar = document.getElementById("playerBar");
  if (dates.length < 2) {
    bar.classList.remove("visible");
    return;
  }
  bar.classList.add("visible");
  player.dates = dates;
  if (!player.active) {
    player.index = dates.length - 1;
    playerUpdateUI();
  }
}

function playerHide() {
  document.getElementById("playerBar").classList.remove("visible");
  playerPause();
}

function playerUpdateUI() {
  const d = player.dates;
  if (!d.length) return;
  const i = player.index;
  const pct = d.length > 1 ? (i / (d.length - 1)) * 100 : 100;
  document.getElementById("playerProgress").style.width = pct + "%";
  document.getElementById("playerDate").textContent = d[i] || "—";
  document.getElementById("playerCounter").textContent = `${i + 1}/${d.length}`;
  document.getElementById("playerPlayBtn").textContent = player.playing ? "❚❚" : "▶";
  document.getElementById("playerPlayBtn").classList.toggle("active", player.playing);
}

function playerGoTo(index) {
  if (!player.dates.length) return;
  player.index = Math.max(0, Math.min(index, player.dates.length - 1));
  player.active = true;

  const dateGroup = CFG.groups.find(g => g.is_last);
  if (dateGroup) {
    state.picker[dateGroup.key] = player.dates[player.index];
    renderAllGroupSteps();
    updateAddBtn();
    renderPreview();
  }
  playerUpdateUI();
}

function playerStep(dir) {
  playerGoTo(player.index + dir);
}

function playerToggle() {
  if (player.playing) playerPause();
  else                playerPlay();
}

function playerPlay() {
  if (!player.dates.length) return;
  player.playing = true;
  player.active = true;
  if (player.index >= player.dates.length - 1) player.index = 0;
  playerGoTo(player.index);
  playerUpdateUI();

  player.interval = setInterval(() => {
    if (player.index >= player.dates.length - 1) {
      playerPause();
      return;
    }
    playerGoTo(player.index + 1);
  }, player.speed);
}

function playerPause() {
  player.playing = false;
  if (player.interval) { clearInterval(player.interval); player.interval = null; }
  playerUpdateUI();
}

function playerStop() {
  playerPause();
  player.active = false;
  player.index = player.dates.length - 1;
  playerGoTo(player.index);
}

function playerSetSpeed(ms) {
  player.speed = +ms;
  if (player.playing) {
    playerPause();
    playerPlay();
  }
}

function playerClickTrack(e) {
  if (!player.dates.length) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const idx = Math.round(pct * (player.dates.length - 1));
  playerGoTo(idx);
}

// ── COLLAPSE TOGGLES ────────────────────────────────────────────────────────

function toggleTable() {
  const section = document.getElementById("tableSection");
  section.classList.toggle("table-collapsed");
}

// ── SETTINGS SYSTEM ─────────────────────────────────────────────────────────

const STORAGE_KEY = "dashboard_settings_v1";
let allColumns = [];

function detectColumns(sample) {
  allColumns = [];
  for (const [key, val] of Object.entries(sample)) {
    let type = "string";
    if (typeof val === "number") type = "number";
    else if (/^\d{4}-\d{2}-\d{2}/.test(val)) type = "date";
    allColumns.push({ key, type, sample: val });
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
}

function clearSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

function getDefaultSettings() {
  const sample = allData[0] || {};
  const keys = Object.keys(sample);

  const tickerKey = keys.find(k => /ticker|issuer/i.test(k)) || null;
  const typeKey = keys.find(k => /^type$|seniority|subordinat/i.test(k)) || null;

  const filters = [];
  if (tickerKey) filters.push({ key: tickerKey, label: tickerKey.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase()), style: "search" });
  if (typeKey) filters.push({ key: typeKey, label: typeKey.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase()), style: "pills", show_all: true, default: "All" });
  filters.push({ key: "date", label: "Snapshot Date", style: "datelist" });

  const axes = [
    { key: "ttm", label: "TTM (years)", default_x: true },
    { key: "oas", label: "OAS (bps)", default_y: true },
  ];

  return { filters, axes };
}

function buildCFGFromSettings(settings) {
  const groups = settings.filters.map((f, i) => {
    const g = {
      key: f.key,
      label: f.label || f.key.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase()),
      searchable: f.style === "search",
      all_option: !!f.show_all,
      default: f.show_all ? (f.default || "All") : null,
    };
    if (f.style === "datelist") {
      g.sort = "desc";
      g.show_count = true;
      g.is_last = true;
    }
    return g;
  });

  return {
    groups,
    axes: settings.axes || [],
  };
}

// ── SETTINGS UI ─────────────────────────────────────────────────────────────

let pendingSettings = null;

function openSettings() {
  const saved = loadSettings() || getDefaultSettings();
  pendingSettings = JSON.parse(JSON.stringify(saved));
  renderSettingsPanel();
  document.getElementById("settingsOverlay").classList.add("open");
}

function closeSettings() {
  document.getElementById("settingsOverlay").classList.remove("open");
  pendingSettings = null;
}

document.addEventListener("click", e => {
  if (e.target.id === "settingsOverlay") closeSettings();
});

function renderSettingsPanel() {
  const box = document.getElementById("settingsBox");
  const s = pendingSettings;
  const usedKeys = new Set(s.filters.map(f => f.key));
  const available = allColumns.filter(c => !usedKeys.has(c.key) && c.key !== "isin" && c.key !== "maturity");

  let html = `
    <div class="settings-title">
      <span>⚙ DASHBOARD SETTINGS</span>
      <button class="settings-close" onclick="closeSettings()">×</button>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Sidebar Filters</div>
      <div class="settings-hint">Drag order matters: first = search list, middle = pill buttons, last = date list with ADD button</div>
      <div id="settingsFilters">`;

  s.filters.forEach((f, i) => {
    html += `
      <div class="filter-row">
        <span class="filter-move" onclick="moveFilter(${i},-1)" title="Move up">▲</span>
        <span class="filter-move" onclick="moveFilter(${i},1)" title="Move down">▼</span>
        <span class="filter-key">${f.key}</span>
        <select onchange="setFilterStyle(${i}, this.value)">
          <option value="search" ${f.style==='search'?'selected':''}>Search list</option>
          <option value="pills" ${f.style==='pills'?'selected':''}>Pills</option>
          <option value="datelist" ${f.style==='datelist'?'selected':''}>Date list</option>
        </select>
        <label style="font-size:9px;color:var(--muted);display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" ${f.show_all?'checked':''} onchange="setFilterShowAll(${i}, this.checked)"
                 style="accent-color:var(--accent3);width:10px;height:10px;cursor:pointer"> All
        </label>
        <button class="filter-remove" onclick="removeFilter(${i})" title="Remove">×</button>
      </div>`;
  });

  html += `
      </div>
      <div class="settings-add-row">
        <select id="addFilterSelect">
          <option value="">+ Add column as filter…</option>`;
  available.forEach(c => {
    html += `<option value="${c.key}">${c.key} (${c.type})</option>`;
  });
  html += `
        </select>
        <button class="settings-add-btn" onclick="addFilter()">ADD</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Chart Axes</div>
      <div class="settings-hint">Numeric columns available as X/Y selectors. TTM and OAS are always included.</div>
      <div id="settingsAxes" style="display:flex;flex-wrap:wrap;gap:4px">`;

  const axisKeys = new Set((s.axes || []).map(a => a.key));
  allColumns.forEach(c => {
    if (c.type !== "number" || c.key === "isin") return;
    const active = axisKeys.has(c.key) || c.key === "oas";
    const locked = c.key === "oas";
    html += `
      <label class="col-tag" style="${active ? 'border-color:var(--accent3)' : 'opacity:0.5'}">
        <input type="checkbox" ${active?'checked':''} ${locked?'disabled':''}
               onchange="toggleAxis('${c.key}', this.checked)"
               style="accent-color:var(--accent3);width:10px;height:10px;cursor:pointer">
        ${c.key}
      </label>`;
  });
  html += `<label class="col-tag" style="border-color:var(--accent3)">
    <input type="checkbox" checked disabled style="accent-color:var(--accent3);width:10px;height:10px"> ttm
  </label>`;

  html += `
      </div>
    </div>

<div style="display:flex;gap:8px;margin-top:16px">
      <button class="settings-apply" onclick="applySettings()" style="flex:1;margin:0">APPLY & RELOAD</button>
      <button class="settings-reset" onclick="resetSettings()" style="flex:1">RESET DEFAULTS</button>
    </div>`;

  box.innerHTML = html;
}

function moveFilter(idx, dir) {
  const f = pendingSettings.filters;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= f.length) return;
  [f[idx], f[newIdx]] = [f[newIdx], f[idx]];
  renderSettingsPanel();
}

function setFilterStyle(idx, style) {
  pendingSettings.filters[idx].style = style;
  renderSettingsPanel();
}

function setFilterShowAll(idx, checked) {
  pendingSettings.filters[idx].show_all = checked;
  if (checked) pendingSettings.filters[idx].default = "All";
  else delete pendingSettings.filters[idx].default;
}

function removeFilter(idx) {
  pendingSettings.filters.splice(idx, 1);
  renderSettingsPanel();
}

function addFilter() {
  const sel = document.getElementById("addFilterSelect");
  const key = sel.value;
  if (!key) return;
  const col = allColumns.find(c => c.key === key);
  pendingSettings.filters.push({
    key,
    label: key.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase()),
    style: "pills",
    show_all: col && col.type === "string",
    default: col && col.type === "string" ? "All" : undefined,
  });
  renderSettingsPanel();
}

function toggleAxis(key, checked) {
  if (!pendingSettings.axes) pendingSettings.axes = [];
  if (checked) {
    if (!pendingSettings.axes.find(a => a.key === key)) {
      pendingSettings.axes.push({ key, label: key.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase()) });
    }
  } else {
    pendingSettings.axes = pendingSettings.axes.filter(a => a.key !== key);
  }
  renderSettingsPanel();
}

function applySettings() {
  saveSettings(pendingSettings);
  closeSettings();
  rebuildFromSettings();
}

function resetSettings() {
  clearSettings();
  pendingSettings = getDefaultSettings();
  renderSettingsPanel();
}

function rebuildFromSettings() {
  const settings = loadSettings() || getDefaultSettings();
  CFG = buildCFGFromSettings(settings);

  FIELD_LABELS = {};
  CFG.axes.forEach(a => { FIELD_LABELS[a.key] = a.label; });

  const defX = CFG.axes.find(a => a.default_x);
  const defY = CFG.axes.find(a => a.default_y);
  if (defX) state.xField = defX.key;
  if (defY) state.yField = defY.key;

  state.selections = state.selections.filter(sel =>
    CFG.groups.every(g => sel[g.key] != null)
  );

  state.picker = {};
  CFG.groups.forEach(g => { state.picker[g.key] = g.default ?? null; });

  SKIP_IN_TABLE = new Set();
  CFG.groups.forEach(g => {
    if (g.key !== "date") SKIP_IN_TABLE.add(g.key);
  });

  buildSidebar();
  buildColSystem(allData[0]);
  populateColPicker();
  populateAxisSelects();
  updateChartTitle();
  renderAllGroupSteps();
  renderSelectionTags();
  fullRender();
}

// ── SAVED VIEWS SYSTEM ──────────────────────────────────────────────────────
// Persists named views (selection sets) in localStorage.
// Also auto-saves the current working selections so they restore on reload.

const VIEWS_KEY = "dashboard_saved_views_v1";
const AUTOSAVE_KEY = "dashboard_autosave_v1";

function loadViews() {
  try {
    const raw = localStorage.getItem(VIEWS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}

function saveViewsStore(views) {
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); } catch (e) {}
}

function autoSaveSelections() {
  try {
    const payload = {
      selections: state.selections,
      chartType: state.chartType,
      xField: state.xField,
      yField: state.yField,
      fitCfg: state.fitCfg,
    };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  } catch (e) {}
}

function autoRestoreSelections() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload.selections || !payload.selections.length) return false;

    // validate that the selection keys match the current CFG groups
    const groupKeys = CFG.groups.map(g => g.key);
    const valid = payload.selections.filter(sel =>
      groupKeys.every(k => sel[k] != null)
    );
    if (!valid.length) return false;

    state.selections = valid;
    if (payload.chartType) state.chartType = payload.chartType;
    if (payload.xField) state.xField = payload.xField;
    if (payload.yField) state.yField = payload.yField;
    if (payload.fitCfg) state.fitCfg = { ...state.fitCfg, ...payload.fitCfg };
    return true;
  } catch (e) { return false; }
}

function promptSaveView() {
  if (!state.selections.length) {
    alert("Add at least one series before saving a view.");
    return;
  }
  const name = prompt("View name:", "");
  if (!name || !name.trim()) return;

  const views = loadViews();
  views.push({
    name: name.trim(),
    date: new Date().toISOString().slice(0, 10),
    selections: JSON.parse(JSON.stringify(state.selections)),
    chartType: state.chartType,
    xField: state.xField,
    yField: state.yField,
    fitCfg: { ...state.fitCfg },
  });
  saveViewsStore(views);

  // if views panel is open, refresh it
  if (document.getElementById("viewsPanel").classList.contains("open")) {
    renderViewsList();
  }
}

function loadView(idx) {
  const views = loadViews();
  const v = views[idx];
  if (!v) return;

  // validate selections against current CFG
  const groupKeys = CFG.groups.map(g => g.key);
  const valid = v.selections.filter(sel =>
    groupKeys.every(k => sel[k] != null)
  );
  if (!valid.length) {
    alert("This view's filters don't match the current data columns. It may have been saved with a different dataset.");
    return;
  }

  state.selections = valid;
  if (v.chartType) {
    state.chartType = v.chartType;
    document.getElementById('btnScatter').classList.toggle('active', v.chartType === 'scatter');
    document.getElementById('btnLine').classList.toggle('active', v.chartType === 'line');
  }
  if (v.xField) state.xField = v.xField;
  if (v.yField) state.yField = v.yField;
  if (v.fitCfg) state.fitCfg = { ...state.fitCfg, ...v.fitCfg };

  populateAxisSelects();
  updateChartTitle();
  renderSelectionTags();
  autoSaveSelections();
  fullRender();
  closeViewsPanel();
}

function deleteView(idx) {
  const views = loadViews();
  const name = views[idx]?.name || "this view";
  if (!confirm(`Delete "${name}"?`)) return;
  views.splice(idx, 1);
  saveViewsStore(views);
  renderViewsList();
}

function renameView(idx) {
  const views = loadViews();
  const v = views[idx];
  if (!v) return;
  const name = prompt("New name:", v.name);
  if (!name || !name.trim()) return;
  v.name = name.trim();
  saveViewsStore(views);
  renderViewsList();
}

function openViewsPanel() {
  renderViewsList();
  document.getElementById("viewsPanel").classList.add("open");
}

function closeViewsPanel() {
  document.getElementById("viewsPanel").classList.remove("open");
}

function renderViewsList() {
  const views = loadViews();
  const el = document.getElementById("viewsList");
  if (!views.length) {
    el.innerHTML = '<div class="views-empty">No saved views yet</div>';
    return;
  }
  el.innerHTML = views.map((v, i) => {
    const nSeries = v.selections.length;
    const labels = v.selections.map(s => {
      const parts = Object.entries(s).filter(([k]) => k !== "color").map(([, val]) => val);
      return parts.join("·");
    });
    const preview = labels.join(", ");
    return `
      <div class="view-item">
        <span class="view-name" onclick="loadView(${i})" title="${preview}">${v.name}</span>
        <span class="view-meta">${nSeries}s · ${v.date || ""}</span>
        <div class="view-actions">
          <button class="view-action-btn" onclick="renameView(${i})" title="Rename">✎</button>
          <button class="view-action-btn delete" onclick="deleteView(${i})" title="Delete">×</button>
        </div>
      </div>`;
  }).join("");
}

function exportViews() {
  const views = loadViews();
  if (!views.length) {
    alert("No saved views to export.");
    return;
  }
  const blob = new Blob([JSON.stringify(views, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dashboard_views_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importViews() {
  document.getElementById("importFileInput").click();
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported)) throw new Error("Expected array");
      const existing = loadViews();
      const merged = [...existing, ...imported];
      saveViewsStore(merged);
      if (document.getElementById("viewsPanel").classList.contains("open")) {
        renderViewsList();
      }
      alert(`Imported ${imported.length} view(s).`);
    } catch (err) {
      alert("Invalid views file: " + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = "";  // reset so the same file can be re-imported
}

// ── CLOCK ───────────────────────────────────────────────────────────────────
function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ── INIT ────────────────────────────────────────────────────────────────────
async function init() {
  document.getElementById('pickerSteps').innerHTML =
    '<div style="padding:16px;font-size:10px;color:var(--muted)">Loading…</div>';

  try {
    const r = await fetch('data.json');
    if (!r.ok) throw new Error(`data.json: HTTP ${r.status}`);
    allData = await r.json();
    console.log(`Loaded ${allData.length} bond records`);
  } catch (err) {
    document.getElementById('pickerSteps').innerHTML = `
      <div style="padding:16px;font-size:10px;color:var(--neg);line-height:1.8">
        <b>Could not load data.json</b><br>
        Run: <span style="color:var(--muted)">python dashboard.py</span><br>
        ${err.message}
      </div>`;
    return;
  }

  detectColumns(allData[0]);

  const settings = loadSettings() || getDefaultSettings();
  if (!loadSettings()) saveSettings(settings);
  CFG = buildCFGFromSettings(settings);

  FIELD_LABELS = {};
  CFG.axes.forEach(a => { FIELD_LABELS[a.key] = a.label; });

  const defX = CFG.axes.find(a => a.default_x);
  const defY = CFG.axes.find(a => a.default_y);
  if (defX) state.xField = defX.key;
  if (defY) state.yField = defY.key;

  CFG.groups.forEach(g => { state.picker[g.key] = g.default ?? null; });

  CFG.groups.forEach(g => {
    if (g.key !== "date") SKIP_IN_TABLE.add(g.key);
  });

  // restore last session's selections (if any)
  const restored = autoRestoreSelections();
  if (restored) {
    console.log(`Restored ${state.selections.length} saved series`);
    document.getElementById('btnScatter').classList.toggle('active', state.chartType === 'scatter');
    document.getElementById('btnLine').classList.toggle('active', state.chartType === 'line');
  }

  buildSidebar();
  buildColSystem(allData[0]);
  populateColPicker();
  populateAxisSelects();
  updateChartTitle();
  renderAllGroupSteps();
  renderSelectionTags();
  fullRender();
}

init();
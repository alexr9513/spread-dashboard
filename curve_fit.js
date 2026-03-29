/**
 * curve_fit.js
 * ============
 * Bond Spread Dashboard | Curve Fitting & Chart Utilities
 *
 * Five fitting modes, selectable at runtime:
 *
 *   "auto"       — picks the best method based on bond count
 *   "linear"     — OLS straight line
 *   "poly"       — polynomial of configurable degree (2–4)
 *   "ns"         — Nelson-Siegel parametric (4 params, τ estimated or fixed)
 *   "spline"     — penalized cubic B-spline with GCV or manual λ
 *
 * Public API (window.NS):
 *   NS.fit(points, cfg)                      → { model, rmse, method } | null
 *   NS.predict(t, model)                     → y value
 *   NS.gridPoints(model, tMin, tMax, n)      → [{x,y}, ...]
 *   NS.residuals(points, model)              → [numbers]
 *   NS.buildDatasets({..., fitCfg})          → Chart.js datasets[]
 *   NS.buildPreviewDatasets({..., fitCfg})   → Chart.js datasets[]
 *   NS.METHODS                                → metadata for UI
 *
 * fitCfg shape:
 *   { method: "auto"|"linear"|"poly"|"ns"|"spline",
 *     degree: 2,          // poly only
 *     tauFixed: null,     // ns: null = estimate, number = fix τ
 *     lambda: "auto",     // spline: "auto" | number
 *     knots: "auto",      // spline: "auto" | number
 *   }
 */

(function (global) {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEFAULTS & CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════════
  const MIN_BONDS  = 3;
  const GRID_N     = 300;

  const DEFAULT_CFG = {
    method:   "auto",
    degree:   2,
    tauFixed: null,
    lambda:   "auto",
    knots:    "auto",
  };

  /** Method metadata — used by the UI to build the controls panel */
  const METHODS = [
    { key: "auto",   label: "Auto",        desc: "Best method for bond count" },
    { key: "linear", label: "Linear",      desc: "Straight line (OLS)" },
    { key: "poly",   label: "Polynomial",  desc: "Degree 2–4 polynomial",
      params: [{ key: "degree", label: "Degree", type: "select", options: [2,3,4], default: 2 }] },
    { key: "ns",     label: "Nelson-Siegel", desc: "Parametric 4-param model",
      params: [{ key: "tauFixed", label: "τ decay", type: "select",
                 options: [["auto","Est."], [1,"1y"], [1.5,"1.5y"], [2,"2y"], [3,"3y"], [5,"5y"], [7,"7y"], [10,"10y"]],
                 default: "auto" }] },
    { key: "spline", label: "Spline",      desc: "Penalized cubic B-spline",
      params: [
        { key: "lambda", label: "Smoothing λ", type: "select",
          options: [["auto","Auto (GCV)"], [0.001,"0.001"], [0.01,"0.01"], [0.1,"0.1"], [1,"1"], [10,"10"], [100,"100"], [1000,"1000"]],
          default: "auto" },
        { key: "knots", label: "Interior knots", type: "select",
          options: [["auto","Auto"], [2,"2"], [3,"3"], [4,"4"], [5,"5"], [6,"6"], [8,"8"]],
          default: "auto" },
      ] },
  ];

  function parseCfg(cfg) {
    const c = Object.assign({}, DEFAULT_CFG, cfg || {});
    if (c.tauFixed === "auto" || c.tauFixed === "" || c.tauFixed === null) c.tauFixed = null;
    else c.tauFixed = +c.tauFixed;
    if (c.lambda === "auto" || c.lambda === "") c.lambda = "auto";
    else c.lambda = +c.lambda;
    if (c.knots === "auto" || c.knots === "") c.knots = "auto";
    else c.knots = +c.knots;
    c.degree = +c.degree;
    return c;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  TINY LINEAR ALGEBRA
  // ═══════════════════════════════════════════════════════════════════════════
  function zeros(m, n) { return Array.from({ length: m }, () => new Float64Array(n)); }

  function cholSolve(A, b) {
    const n = A.length;
    const L = zeros(n, n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
      }
    }
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i]; for (let j = 0; j < i; j++) s -= L[i][j] * z[j];
      z[i] = s / L[i][i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = z[i]; for (let j = i + 1; j < n; j++) s -= L[j][i] * x[j];
      x[i] = s / L[i][i];
    }
    return x;
  }

  function AtA(A) {
    const m = A.length, n = A[0].length, C = zeros(n, n);
    for (let i = 0; i < n; i++)
      for (let j = i; j < n; j++) {
        let s = 0; for (let k = 0; k < m; k++) s += A[k][i] * A[k][j];
        C[i][j] = s; C[j][i] = s;
      }
    return C;
  }

  function Atv(A, y) {
    const m = A.length, n = A[0].length, v = new Float64Array(n);
    for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += A[i][j] * y[i]; v[j] = s; }
    return v;
  }

  function hatTrace(BtB, P, lam, nb) {
    const M = zeros(nb, nb);
    for (let i = 0; i < nb; i++) for (let j = 0; j < nb; j++) M[i][j] = BtB[i][j] + lam * P[i][j];
    let tr = 0;
    for (let c = 0; c < nb; c++) {
      const rhs = new Float64Array(nb);
      for (let i = 0; i < nb; i++) rhs[i] = BtB[i][c];
      tr += cholSolve(M.map(r => Float64Array.from(r)), rhs)[c];
    }
    return tr;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  METHOD 1: LINEAR
  // ═══════════════════════════════════════════════════════════════════════════
  function fitLinear(pts) {
    const n = pts.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
    const d = n * sxx - sx * sx;
    const a = (n * sxy - sx * sy) / d;
    const b = (sy - a * sx) / n;
    return { type: "linear", coeffs: [b, a] };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  METHOD 2: POLYNOMIAL
  // ═══════════════════════════════════════════════════════════════════════════
  function fitPoly(pts, degree) {
    const n = pts.length;
    const d = Math.min(degree, n - 1);
    const m = d + 1;
    const A = zeros(n, m);
    const y = Float64Array.from(pts.map(p => p.y));
    for (let i = 0; i < n; i++) {
      let xp = 1;
      for (let j = 0; j < m; j++) { A[i][j] = xp; xp *= pts[i].x; }
    }
    const coeffs = cholSolve(AtA(A), Atv(A, y));
    return { type: "poly", coeffs: Array.from(coeffs), degree: d };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  METHOD 3: NELSON-SIEGEL
  // ═══════════════════════════════════════════════════════════════════════════
  const TAU_MIN = 0.5, TAU_MAX = 30, TAU_RANGE = 29.5;
  const TAU_INITS = [1.5, 3.0, 7.0];
  const NS_ITER = 3000, NS_LR = [0.5, 0.5, 0.5, 0.05];
  const AB1 = 0.9, AB2 = 0.999, AEPS = 1e-8, NS_EARLY = 0.01;

  function tauFromU(u) { return TAU_MIN + TAU_RANGE / (1 + Math.exp(-u)); }
  function uFromTau(t) { t = Math.max(TAU_MIN+1e-6, Math.min(TAU_MAX-1e-6, t)); return -Math.log(TAU_RANGE/(t-TAU_MIN)-1); }

  function nsFactors(t, tau) {
    if (t < 1e-6) return [1, 1, 0];
    const x = t / tau, ex = Math.exp(-x), phi = (1 - ex) / x;
    return [1, phi, phi - ex];
  }

  function nsPredictRaw(t, b0, b1, b2, tau) {
    const [f0, f1, f2] = nsFactors(t, tau);
    return b0 * f0 + b1 * f1 + b2 * f2;
  }

  function fitNSOnce(pts, tau0, tauFixed) {
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    const oS = sorted[0].y, oL = sorted[sorted.length - 1].y;

    // if tau is fixed, OLS for [b0, b1, b2]
    if (tauFixed != null) {
      const tau = tauFixed, n = pts.length;
      const A = zeros(n, 3);
      const y = Float64Array.from(pts.map(p => p.y));
      for (let i = 0; i < n; i++) {
        const [f0, f1, f2] = nsFactors(pts[i].x, tau);
        A[i][0] = f0; A[i][1] = f1; A[i][2] = f2;
      }
      const c = cholSolve(AtA(A), Atv(A, y));
      const params = [Math.max(c[0], 10), c[1], c[2], tau];
      const rmse = Math.sqrt(pts.reduce((s, p) => s + (p.y - nsPredictRaw(p.x, ...params)) ** 2, 0) / n);
      return { params, rmse };
    }

    // Adam gradient descent (τ estimated)
    let p = [oL, oS - oL, 0, uFromTau(tau0)];
    let m = [0,0,0,0], v = [0,0,0,0];
    for (let it = 1; it <= NS_ITER; it++) {
      const tau = tauFromU(p[3]);
      const g = [0,0,0,0]; let loss = 0;
      for (const pt of pts) {
        const pred = nsPredictRaw(pt.x, p[0], p[1], p[2], tau);
        const err = pred - pt.y; loss += err*err;
        const [f0,f1,f2] = nsFactors(pt.x, tau);
        g[0] += 2*err*f0; g[1] += 2*err*f1; g[2] += 2*err*f2;
        if (pt.x > 1e-6) {
          const x = pt.x/tau, ex = Math.exp(-x);
          const dphi = (ex*(x+1)-1)/(tau*x), df2 = dphi - x*ex/tau;
          const sig = 1/(1+Math.exp(-p[3]));
          g[3] += 2*err*(p[1]*dphi+p[2]*df2)*TAU_RANGE*sig*(1-sig);
        }
      }
      for (let j = 0; j < 4; j++) {
        m[j] = AB1*m[j]+(1-AB1)*g[j]; v[j] = AB2*v[j]+(1-AB2)*g[j]**2;
        p[j] -= NS_LR[j]*(m[j]/(1-AB1**it))/(Math.sqrt(v[j]/(1-AB2**it))+AEPS);
      }
      if (loss/pts.length < NS_EARLY) break;
    }
    const tau = tauFromU(p[3]);
    p[0] = Math.max(p[0], 10);
    const params = [p[0], p[1], p[2], tau];
    const rmse = Math.sqrt(pts.reduce((s, pt) => s + (pt.y - nsPredictRaw(pt.x, ...params))**2, 0) / pts.length);
    return { params, rmse };
  }

  function fitNS(pts, tauFixed) {
    if (tauFixed != null) {
      const r = fitNSOnce(pts, tauFixed, tauFixed);
      return { type: "ns", params: r.params };
    }
    let best = null;
    for (const t0 of TAU_INITS) {
      const r = fitNSOnce(pts, t0, null);
      if (!best || r.rmse < best.rmse) best = r;
    }
    return { type: "ns", params: best.params };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  METHOD 4: PENALIZED CUBIC B-SPLINE
  // ═══════════════════════════════════════════════════════════════════════════
  const LAMBDA_GRID = [1e-4,1e-3,0.005,0.01,0.05,0.1,0.5,1,5,10,50,100,500,1000];
  const MAX_K = 8;

  function buildKnots(xs, nInt) {
    const n = xs.length, lo = xs[0], hi = xs[n-1];
    const interior = [];
    for (let i = 1; i <= nInt; i++) {
      const idx = Math.min(Math.floor((i / (nInt + 1)) * n), n - 1);
      interior.push(xs[idx]);
    }
    return [lo, lo, lo, lo, ...interior, hi, hi, hi, hi];
  }

  function bsplineBasis(t, knots, deg) {
    const nb = knots.length - deg - 1;
    let span = deg;
    for (let i = deg; i < nb; i++) { if (t < knots[i+1] || i === nb-1) { span = i; break; } }
    const N = new Float64Array(deg + 1); N[0] = 1;
    for (let d = 1; d <= deg; d++) {
      const saved = new Float64Array(d + 1);
      for (let r = 0; r < d; r++) {
        const kl = knots[span-d+1+r], kr = knots[span+1+r], dl = kr-kl;
        const w = dl > 1e-14 ? (t-kl)/dl : 0;
        saved[r] += (1-w)*N[r]; saved[r+1] += w*N[r];
      }
      for (let r = 0; r <= d; r++) N[r] = saved[r];
    }
    const res = [];
    for (let r = 0; r <= deg; r++) {
      const idx = span-deg+r;
      if (idx >= 0 && idx < nb && Math.abs(N[r]) > 1e-15) res.push({ index: idx, value: N[r] });
    }
    return res;
  }

  function buildDesign(xs, knots, deg) {
    const nb = knots.length - deg - 1, m = xs.length, B = zeros(m, nb);
    for (let i = 0; i < m; i++) for (const {index,value} of bsplineBasis(xs[i], knots, deg)) B[i][index] = value;
    return B;
  }

  function buildPenalty(nb) {
    if (nb < 3) return zeros(nb, nb);
    const P = zeros(nb, nb), nd = nb - 2;
    for (let i = 0; i < nd; i++) {
      const d = [1,-2,1];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) P[i+a][i+b] += d[a]*d[b];
    }
    return P;
  }

  function fitSpline(pts, cfg) {
    const sorted = [...pts].sort((a,b) => a.x - b.x);
    const n = sorted.length;
    const xs = sorted.map(p => p.x);
    const ys = Float64Array.from(sorted.map(p => p.y));

    const nInt = cfg.knots === "auto"
      ? Math.min(Math.max(Math.floor(n / 3), 2), MAX_K)
      : Math.min(+cfg.knots, MAX_K);
    const deg = 3;
    const knots = buildKnots(xs, nInt);
    const nb = knots.length - deg - 1;
    const B = buildDesign(xs, knots, deg);
    const BtB = AtA(B);
    const Bty = Atv(B, ys);
    const P = buildPenalty(nb);

    let bestLam, bestCoeffs;

    if (cfg.lambda !== "auto") {
      bestLam = +cfg.lambda;
      const M = zeros(nb, nb);
      for (let i = 0; i < nb; i++) for (let j = 0; j < nb; j++) M[i][j] = BtB[i][j] + bestLam * P[i][j];
      bestCoeffs = cholSolve(M, Float64Array.from(Bty));
    } else {
      let bestGCV = Infinity;
      for (const lam of LAMBDA_GRID) {
        const M = zeros(nb, nb);
        for (let i = 0; i < nb; i++) for (let j = 0; j < nb; j++) M[i][j] = BtB[i][j] + lam * P[i][j];
        const c = cholSolve(M.map(r => Float64Array.from(r)), Float64Array.from(Bty));
        let rss = 0;
        for (let i = 0; i < n; i++) {
          let pred = 0; for (let j = 0; j < nb; j++) pred += B[i][j] * c[j];
          rss += (ys[i] - pred) ** 2;
        }
        const df = hatTrace(BtB.map(r => Float64Array.from(r)), P, lam, nb);
        const den = n - df; if (den <= 0) continue;
        const gcv = (n * rss) / (den * den);
        if (gcv < bestGCV) { bestGCV = gcv; bestLam = lam; bestCoeffs = c; }
      }
      if (!bestCoeffs) {
        bestLam = 1;
        const M = zeros(nb, nb);
        for (let i = 0; i < nb; i++) for (let j = 0; j < nb; j++) M[i][j] = BtB[i][j] + P[i][j];
        bestCoeffs = cholSolve(M, Float64Array.from(Bty));
      }
    }

    return { type: "spline", knots, coeffs: Array.from(bestCoeffs), degree: deg, lambda: bestLam, nInterior: nInt };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIFIED predict()
  // ═══════════════════════════════════════════════════════════════════════════
  function predict(t, model) {
    switch (model.type) {
      case "linear":
      case "poly": {
        let val = 0, xp = 1;
        for (const c of model.coeffs) { val += c * xp; xp *= t; }
        return val;
      }
      case "ns":
        return nsPredictRaw(t, ...model.params);
      case "spline": {
        let val = 0;
        for (const {index, value} of bsplineBasis(t, model.knots, model.degree))
          val += model.coeffs[index] * value;
        return val;
      }
    }
    return 0;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIFIED fit()
  // ═══════════════════════════════════════════════════════════════════════════
  function fit(points, cfg) {
    cfg = parseCfg(cfg);
    const valid = points.filter(p => p.x > 0 && isFinite(p.x) && isFinite(p.y));
    if (valid.length < MIN_BONDS) return null;

    let method = cfg.method;
    const n = valid.length;

    // Auto selection
    if (method === "auto") {
      if (n <= 4)       method = "poly";   // poly2 interpolates 3 pts exactly, good for 4
      else if (n <= 5)  method = "ns";
      else              method = "spline";
      if (method === "poly") cfg.degree = Math.min(2, n - 1);
    }

    // Safety guards
    if (method === "spline" && n < 4) method = "linear";
    if (method === "poly" && cfg.degree >= n) cfg.degree = Math.max(1, n - 1);
    if (method === "ns" && n < 3) method = "linear";

    let model;
    switch (method) {
      case "linear": model = fitLinear(valid); break;
      case "poly":   model = fitPoly(valid, cfg.degree); break;
      case "ns":     model = fitNS(valid, cfg.tauFixed); break;
      case "spline": model = fitSpline(valid, cfg); break;
      default:       model = fitLinear(valid);
    }

    const rmse = Math.sqrt(valid.reduce((s, p) => s + (p.y - predict(p.x, model)) ** 2, 0) / n);
    return { model, rmse, method };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  gridPoints & residuals
  // ═══════════════════════════════════════════════════════════════════════════
  function gridPoints(model, tMin, tMax, n) {
    n = n || GRID_N;
    const step = (tMax - tMin) / (n - 1);
    return Array.from({ length: n }, (_, i) => {
      const t = tMin + i * step;
      return { x: t, y: predict(t, model) };
    });
  }

  function residuals(points, model) {
    return points.map(p => p.y - predict(p.x, model));
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  LEGEND LABEL
  // ═══════════════════════════════════════════════════════════════════════════
  function curveLabel(fitResult, issuerLabel) {
    const { model, rmse, method } = fitResult;
    const issuer = issuerLabel.split(" · ")[0];
    const r = rmse.toFixed(0);
    switch (method) {
      case "linear": return `Linear · ${issuer}  RMSE=${r}`;
      case "poly":   return `Poly${model.degree} · ${issuer}  RMSE=${r}`;
      case "ns": {
        const [b0,b1,b2,tau] = model.params;
        return `NS · ${issuer}  β₀=${b0.toFixed(0)} β₁=${b1.toFixed(0)} β₂=${b2.toFixed(0)} τ=${tau.toFixed(2)}  RMSE=${r}`;
      }
      case "spline": return `Spline · ${issuer}  k=${model.nInterior} λ=${model.lambda}  RMSE=${r}`;
    }
    return `${method} · ${issuer}  RMSE=${r}`;
  }

  const DASHES = { linear: [], poly: [2, 2], ns: [5, 4], spline: [8, 3] };


  // ═══════════════════════════════════════════════════════════════════════════
  //  CHART.JS DATASET BUILDERS
  // ═══════════════════════════════════════════════════════════════════════════
  function buildDatasets({ points, color, label, mode, highlightedISIN, seriesIndex, fitCfg }) {
    const col = color, hi = highlightedISIN;
    const sorted = [...points].sort((a,b) => a.x - b.x);
    const tMin = sorted.length ? Math.max(0.1, sorted[0].x) : 0.1;
    const tMax = sorted.length ? sorted[sorted.length - 1].x : 10;
    const result = [];

    if (mode === "scatter") {
      result.push({
        label, data: points,
        backgroundColor: points.map(d => d.isin === hi ? "#ffffff" : col + "bb"),
        borderColor: col,
        borderWidth: points.map(d => d.isin === hi ? 2 : 1),
        pointRadius: points.map(d => d.isin === hi ? 9 : 5),
        pointHoverRadius: 8,
      });

    } else if (mode === "ns") {
      const fitResult = fit(points, fitCfg);
      const resids = fitResult ? residuals(points, fitResult.model) : points.map(() => 0);

      result.push({
        label,
        data: points.map((d, i) => ({ x: d.x, y: d.y, isin: d.isin, residual: resids[i] })),
        backgroundColor: points.map(d => d.isin === hi ? "#ffffff" : col + "bb"),
        borderColor: points.map(d => d.isin === hi ? "#fff" : col + "66"),
        borderWidth: 1,
        pointRadius: points.map(d => d.isin === hi ? 9 : 6),
        pointHoverRadius: 9,
        showLine: false,
      });

      if (fitResult) {
        const curve = gridPoints(fitResult.model, tMin, tMax);
        result.push({
          label: curveLabel(fitResult, label),
          data: curve,
          borderColor: col, borderWidth: 2,
          borderDash: DASHES[fitResult.method] || [5, 4],
          pointRadius: 0, pointHoverRadius: 0, showLine: true, fill: false, tension: 0, hoverRadius: 0,
        });
        result.push({
          label: `_band_${seriesIndex}`,
          data: [
            ...curve.map(p => ({ x: p.x, y: p.y + fitResult.rmse })),
            ...curve.slice().reverse().map(p => ({ x: p.x, y: p.y - fitResult.rmse })),
          ],
          backgroundColor: col + "15", borderColor: "rgba(0,0,0,0)",
          pointRadius: 0, showLine: true, fill: true, tension: 0, hoverRadius: 0,
        });
      }

    } else {
      result.push({
        label, data: sorted,
        borderColor: col, borderWidth: 2, backgroundColor: col + "15",
        pointRadius: 4, pointBackgroundColor: col,
        showLine: true, fill: true, tension: 0.3,
      });
    }
    return result;
  }

  function buildPreviewDatasets({ points, mode, label, fitCfg, highlightedISIN }) {
    const hi = highlightedISIN;
    const sorted = [...points].sort((a,b) => a.x - b.x);
    const tMin = sorted.length ? Math.max(0.1, sorted[0].x) : 0.1;
    const tMax = sorted.length ? sorted[sorted.length - 1].x : 10;
    const result = [];

    result.push({
      label, data: points,
      backgroundColor: points.map(d => d.isin === hi ? "#ffffff" : "rgba(255,255,255,0.25)"),
      borderColor: "rgba(255,255,255,0.60)",
      borderWidth: 1, borderDash: [3,3],
      pointRadius: points.map(d => d.isin === hi ? 9 : 5),
      pointHoverRadius: 7,
      showLine: mode === "line", tension: 0.3,
    });

    if (mode === "ns") {
      const fitResult = fit(points, fitCfg);
      if (fitResult) {
        result.push({
          label: "_pvns",
          data: gridPoints(fitResult.model, tMin, tMax),
          borderColor: "rgba(255,255,255,0.60)", borderWidth: 2, borderDash: [4,4],
          pointRadius: 0, pointHoverRadius: 0, hoverRadius: 0,
          showLine: true, fill: false, tension: 0,
        });
      }
    }
    return result;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  EXPORT
  // ═══════════════════════════════════════════════════════════════════════════
  global.NS = { fit, predict, gridPoints, residuals, buildDatasets, buildPreviewDatasets, METHODS };

})(window);
# Spread Curve Dashboard

## Files

```
├── bond_spread_dashboard.html   ← the dashboard (open in browser)
├── curve_fit.js                 ← curve fitting engine (don't touch)
├── fitting_guide.html           ← help page (opens from ? GUIDE button)
├── config.json                  ← YOUR settings (edit this)
├── dashboard.py                 ← data generator script
├── _dashboard_config.json       ← auto-generated (don't touch)
└── data.json                    ← auto-generated (don't touch)
```

## Quick Start

### 1. Install Python dependencies

You only need **pandas**. Open a terminal and run:

```
pip install pandas pyarrow
```

(`pyarrow` is needed if your data is a `.parquet` file. Skip it if you use `.csv` or `.xlsx`.)

### 2. Configure your columns

Open **`config.json`** in any text editor. It has four sections with instructions inside:

- **`columns_essential`** — map your column names to the ones the dashboard needs (bond ID, spread, maturity date, snapshot date, coupon)
- **`columns_sidebar`** — choose which columns appear as filters on the left panel
- **`columns_extra`** — add any extra columns for the bottom table
- **`chart_axes`** — add numeric columns available as X/Y axes

Just replace `"your_column": "..."` with the exact column name from your dataset.

Set `"input_file"` at the top to your data file name (supports `.parquet`, `.csv`, `.xlsx`).

### 3. Generate the data

```
python dashboard.py
```

This reads your dataset + `config.json` and creates two files:
- `data.json` (bond data for the browser)
- `_dashboard_config.json` (internal config for the HTML)

### 4. Launch

```
python -m http.server 8000
```

Then open in your browser:

```
http://localhost:8000/bond_spread_dashboard.html
```

### 5. When you update your data

Just re-run step 3 and hard-refresh the browser (`Ctrl + Shift + R`).

## Curve Fitting

Click **FIT CURVE** to fit a spread curve. Click **⚙** to choose the fitting method and tune parameters. Click **? GUIDE** in the top-right corner for a full explanation of each method.
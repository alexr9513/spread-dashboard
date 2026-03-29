# Spread Curve Dashboard

## Files

```
├── bond_spread_dashboard.html   ← the dashboard (open in browser)
├── curve_fit.js                 ← curve fitting engine (don't touch)
├── dashboard_functions.js       ← javacript functions for the dynamic of the page (don't touch)
├── fitting_guide.html           ← help page (opens from ? GUIDE button)
├── user_guide.html              ← user help page (opens from ? HELP button)
├── config.json                  ← YOUR settings (edit this)
├── dashboard.py                 ← data generator script (edit this if needed)
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

- Set `"input_file"` at the top to your data file name (supports `.parquet`, `.csv`, `.xlsx`).

- **`columns_essential`** — map your column names to the ones the dashboard needs (bond ID, spread, maturity date, snapshot date, coupon), Just replace `"your_column": "..."` with the exact column name from your dataset.


### 3. Generate the data

```
python dashboard.py
```

This reads your dataset + `config.json` and creates `data.json` (bond data for the browser)

### 4. Launch

```
python -m http.server 8000
```

Then open in your browser:

```
http://localhost:8000/bond_spread_dashboard.html
```

### 5. When you update your data

Just re-run the dashboard.py file and hard-refresh the browser (`Ctrl + Shift + R`).

## Curve Fitting

Click **FIT CURVE** to fit a spread curve. Click **⚙** to choose the fitting method and tune parameters. Click **? GUIDE** in the top-right corner for a full explanation of each method. Click **? HELP** in the top-right corner to display a documentation for the functionality of the dashboard.
"""
dashboard.py
============
Pi² — Bond Spread Dashboard | Data Export

Reads config.json (user-friendly settings) and your dataset,
then generates two files the dashboard needs:
  • data.json            — bond data
  • _dashboard_config.json — internal config for the HTML

USAGE
------
  1. Edit config.json with your column names (no coding needed)
  2. Run:   python dashboard.py
  3. Serve:  python -m http.server 8000
  4. Open:   http://localhost:8000/bond_spread_dashboard.html
"""

import json
import math
import re
import sys
import pandas as pd
from pathlib import Path

# ── FILE NAMES ─────────────────────────────────────────────────────────────────
USER_CONFIG      = "config.json"
DATA_OUTPUT      = "data.json"
DASHBOARD_CONFIG = "_dashboard_config.json"   # consumed by the HTML

# ── HELPERS ────────────────────────────────────────────────────────────────────

def to_json_key(col: str) -> str:
    """Normalise any column name to a safe JSON key: lowercase, underscores."""
    key = col.strip().lower()
    key = re.sub(r"[\s\-/\\()]+", "_", key)
    key = re.sub(r"_+", "_", key).strip("_")
    return key


def load_config() -> dict:
    """Load and validate the user config."""
    path = Path(USER_CONFIG)
    if not path.exists():
        print(f"ERROR: {USER_CONFIG} not found.")
        print(f"  Create it in the same folder as this script.")
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    # --- Validate essential columns ---
    essential = cfg.get("columns_essential", {})
    required_keys = ["bond_id", "spread", "maturity_date", "snapshot_date"]
    missing = [k for k in required_keys if k not in essential]
    if missing:
        print(f"ERROR: Missing essential columns in config.json: {missing}")
        print(f"  Each must have a 'your_column' and 'dashboard_key' field.")
        sys.exit(1)

    # --- Validate sidebar filters ---
    sidebar = cfg.get("columns_sidebar", {})
    filters = sidebar.get("filters", [])
    if not filters:
        print("ERROR: No sidebar filters defined in config.json.")
        print("  Add at least one filter in columns_sidebar → filters.")
        sys.exit(1)

    for i, f in enumerate(filters):
        if "your_column" not in f:
            print(f"ERROR: Sidebar filter #{i+1} is missing 'your_column'.")
            sys.exit(1)
        if "style" not in f:
            print(f"ERROR: Sidebar filter #{i+1} ({f['your_column']}) is missing 'style'.")
            print(f"  Must be one of: 'search', 'pills', 'datelist'.")
            sys.exit(1)

    return cfg


def build_rename_map(cfg: dict) -> dict:
    """
    Build a { source_column → json_key } rename map from config.

    Essential columns use their fixed dashboard_key.
    Sidebar filter columns get auto-generated keys.
    Extra columns get auto-generated keys.
    Axis columns get auto-generated keys.
    """
    rename = {}

    # Essential columns → fixed dashboard keys
    for entry in cfg["columns_essential"].values():
        if isinstance(entry, dict) and "your_column" in entry:
            rename[entry["your_column"]] = entry["dashboard_key"]

    # Sidebar filter columns
    for f in cfg["columns_sidebar"]["filters"]:
        src = f["your_column"]
        if src not in rename:
            rename[src] = to_json_key(src)

    # Chart axes
    for ax in cfg.get("chart_axes", {}).get("axes", []):
        src = ax["your_column"]
        if src not in rename:
            rename[src] = to_json_key(src)

    # Extra table columns
    for col in cfg.get("columns_extra", {}).get("columns", []):
        if col not in rename:
            rename[col] = to_json_key(col)

    return rename


def build_dashboard_config(cfg: dict, rename: dict) -> dict:
    """
    Generate the internal config.json that the HTML/JS expects.
    This maps the user-friendly config into the dashboard's format.
    """
    essential = cfg["columns_essential"]
    oas_key   = essential["spread"]["dashboard_key"]     # "oas"
    dur_keys  = []  # will hold axis keys

    # --- Axes ---
    # Always include TTM (computed in JS) and the spread column
    axes = [
        {"key": "ttm",    "label": "TTM (years)",    "default_x": True},
        {"key": oas_key,  "label": _get_label(cfg, essential["spread"]["your_column"], oas_key), "default_y": True},
    ]
    for ax in cfg.get("chart_axes", {}).get("axes", []):
        key = rename.get(ax["your_column"], to_json_key(ax["your_column"]))
        entry = {"key": key, "label": ax.get("label", ax["your_column"])}
        if ax.get("default_x"):
            # override TTM as default — unlikely but supported
            for a in axes:
                a.pop("default_x", None)
            entry["default_x"] = True
        if ax.get("default_y"):
            for a in axes:
                a.pop("default_y", None)
            entry["default_y"] = True
        axes.append(entry)

    # --- Groups (sidebar filters) ---
    groups = []
    filters = cfg["columns_sidebar"]["filters"]
    for i, f in enumerate(filters):
        key = rename.get(f["your_column"], to_json_key(f["your_column"]))
        g = {
            "key":        key,
            "label":      f.get("label", f["your_column"]),
            "searchable": f["style"] == "search",
        }
        if f.get("show_all"):
            g["all_option"] = True
            g["default"] = f.get("default", "All")
        else:
            g["all_option"] = False
            g["default"] = None

        if f["style"] == "datelist":
            g["sort"] = "desc"
            g["show_count"] = True
            g["is_last"] = True

        groups.append(g)

    # --- Field labels ---
    field_labels = {}
    for k, v in cfg.get("display_labels", {}).items():
        if k.startswith("_"):
            continue
        field_labels[k] = v

    return {
        "axes":         axes,
        "field_labels": field_labels,
        "groups":       groups,
    }


def _get_label(cfg, your_column, json_key):
    """Get a display label for a column, checking display_labels first."""
    labels = cfg.get("display_labels", {})
    if json_key in labels:
        return labels[json_key]
    return your_column


# ── MAIN PIPELINE ──────────────────────────────────────────────────────────────

def load_data(cfg: dict) -> pd.DataFrame:
    """
    Load the raw dataset and return a DataFrame with ORIGINAL column names.

    This is the place to add any dataset-specific fixes:
      - type conversions
      - derived columns
      - value cleaning / recoding
      - filtering out bad rows
      - etc.

    The returned DataFrame is then passed to build_records() which handles
    column renaming, date formatting, and JSON export.
    """
    input_file = cfg.get("input_file", "data.parquet")
    path = Path(input_file)
    if not path.exists():
        print(f"ERROR: Input file '{input_file}' not found.")
        print(f"  Set 'input_file' in config.json to your data file path.")
        sys.exit(1)

    # --- Load ---
    ext = path.suffix.lower()
    if ext == ".parquet":
        df = pd.read_parquet(input_file)
    elif ext == ".csv":
        df = pd.read_csv(input_file)
    elif ext in (".xls", ".xlsx"):
        df = pd.read_excel(input_file)
    else:
        print(f"ERROR: Unsupported file format '{ext}'. Use .parquet, .csv, or .xlsx.")
        sys.exit(1)

    print(f"Loaded {len(df):,} rows × {len(df.columns)} columns from {input_file}")

    # ┌─────────────────────────────────────────────────────────────────────┐
    # │  ADD YOUR CUSTOM FIXES BELOW                                        │
    # │                                                                     │
    # │  Examples:                                                          │
    # │    df["Spread"] = df["Spread"].clip(lower=0)                        │
    # │    df["Rating"] = df["Rating"].str.strip().str.upper()              │
    # │    df = df[df["Currency"] == "EUR"]                                 │
    # │                                                                     │
    # └─────────────────────────────────────────────────────────────────────┘

    # Derive Type from subordination flag if the column doesn't exist
    for f in cfg["columns_sidebar"]["filters"]:
        src = f["your_column"]
        if src not in df.columns and "Subordonnee_dummy" in df.columns:
            df[src] = df["Subordonnee_dummy"].map({0: "Senior", 1: "Subordinated"})
            print(f"  Derived '{src}' from 'Subordonnee_dummy'")

    return df


def build_records(cfg: dict, rename: dict, df: pd.DataFrame) -> list:
    """
    Take a raw DataFrame (from load_data), rename columns to dashboard keys,
    clean dates and NaN values, and return JSON-ready records.
    """
    # --- Check all referenced columns exist ---
    all_source_cols = list(rename.keys())
    missing = [c for c in all_source_cols if c not in df.columns]
    if missing:
        print(f"\nWARNING — columns not found in your data, skipped: {missing}")
        print(f"  Available columns: {list(df.columns)}")
        for m in missing:
            del rename[m]
        all_source_cols = [c for c in all_source_cols if c in df.columns]

    # --- Select & rename ---
    keep_cols = [c for c in all_source_cols if c in df.columns]
    df = df[keep_cols].copy()
    df = df.rename(columns=rename)

    # --- Date handling ---
    essential = cfg["columns_essential"]
    date_key     = essential["snapshot_date"]["dashboard_key"]
    maturity_key = essential["maturity_date"]["dashboard_key"]

    for col in [date_key, maturity_key]:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce").dt.strftime("%Y-%m-%d")

    # --- Drop rows missing essential columns ---
    oas_key  = essential["spread"]["dashboard_key"]
    required = [c for c in [oas_key, maturity_key] if c in df.columns]
    df = df.dropna(subset=required)

    # --- Clean NaN / Infinity for valid JSON ---
    df = df.where(df.notna(), other=None)
    for col in df.select_dtypes(include="number").columns:
        df[col] = df[col].apply(
            lambda v: None if v is not None and isinstance(v, float)
                      and (math.isnan(v) or math.isinf(v)) else v
        )

    return df.to_dict("records")


def main():
    print("=" * 60)
    print("  Pi² — Bond Spread Dashboard Builder")
    print("=" * 60)

    # 1. Load user config
    cfg = load_config()
    print(f"\n✓ Config loaded from {USER_CONFIG}")

    # 2. Build column rename map
    rename = build_rename_map(cfg)

    # 3. Generate internal dashboard config
    dash_cfg = build_dashboard_config(cfg, rename)
    with open(DASHBOARD_CONFIG, "w", encoding="utf-8") as f:
        json.dump(dash_cfg, f, indent=2, ensure_ascii=False)
    print(f"✓ Dashboard config → {DASHBOARD_CONFIG}")

    # 4. Load raw data
    df = load_data(cfg)

    # 5. Build JSON records (rename, clean, export)
    records = build_records(cfg, rename, df)

    # 6. Write data.json
    with open(DATA_OUTPUT, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False)
    print(f"✓ {len(records):,} bond records → {DATA_OUTPUT}")

    # 7. Summary
    print(f"\nColumn mapping:")
    col_width = max(len(c) for c in rename) if rename else 10
    for orig, key in rename.items():
        print(f"  {orig:<{col_width}} → {key}")

    print(f"\n{'=' * 60}")
    print(f"  DONE! Next steps:")
    print(f"  1. Run:   python -m http.server 8000")
    print(f"  2. Open:  http://localhost:8000/bond_spread_dashboard.html")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
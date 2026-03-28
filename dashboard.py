"""
dashboard.py
============
Spread Dashboard | Data Export

Reads config.json (essential column mapping) and exports ALL columns
from your dataset into data.json for the browser dashboard.

Filters, table columns, and axes are configured in the browser UI.

USAGE
------
  1. Edit config.json with your 4 essential column names
  2. Run:   python dashboard.py
  3. Serve: python -m http.server 8000
  4. Open:  http://localhost:8000/bond_spread_dashboard.html
  5. Click ⚙ SETTINGS in the dashboard to configure filters & columns
"""

import json
import math
import re
import sys
import pandas as pd
from pathlib import Path

USER_CONFIG = "config.json"
DATA_OUTPUT = "data.json"


def to_json_key(col: str) -> str:
    """Normalise any column name to a safe JSON key."""
    key = col.strip().lower()
    key = re.sub(r"[\s\-/\\()]+", "_", key)
    key = re.sub(r"_+", "_", key).strip("_")
    return key


def load_config() -> dict:
    path = Path(USER_CONFIG)
    if not path.exists():
        print(f"ERROR: {USER_CONFIG} not found.")
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    essential = cfg.get("columns_essential", {})
    for k in ["bond_id", "spread", "maturity_date", "snapshot_date"]:
        if k not in essential:
            print(f"ERROR: Missing '{k}' in columns_essential.")
            sys.exit(1)

    return cfg


def build_rename_map(cfg: dict) -> dict:
    """Build { source_column → json_key } for essential columns only.
    All other columns get auto-generated keys."""
    rename = {}
    for entry in cfg["columns_essential"].values():
        if isinstance(entry, dict) and "your_column" in entry:
            rename[entry["your_column"]] = entry["dashboard_key"]
    return rename


def main():
    print("=" * 60)
    print("  Spread Dashboard — Data Export")
    print("=" * 60)

    cfg = load_config()
    print(f"\n✓ Config loaded from {USER_CONFIG}")

    essential_rename = build_rename_map(cfg)
    essential = cfg["columns_essential"]

    # --- Load data ---
    input_file = cfg.get("input_file", "data.parquet")
    path = Path(input_file)
    if not path.exists():
        print(f"ERROR: '{input_file}' not found.")
        sys.exit(1)

    ext = path.suffix.lower()
    if ext == ".parquet":
        df = pd.read_parquet(input_file)
    elif ext == ".csv":
        df = pd.read_csv(input_file)
    elif ext in (".xls", ".xlsx"):
        df = pd.read_excel(input_file)
    else:
        print(f"ERROR: Unsupported format '{ext}'.")
        sys.exit(1)

    print(f"✓ Loaded {len(df):,} rows × {len(df.columns)} columns from {input_file}")

    # --- Preprocess ---
    df = preprocess(df)
    print(f"✓ After preprocessing: {len(df):,} rows × {len(df.columns)} columns")

    # --- Check essential columns exist ---
    for key, entry in essential.items():
        if isinstance(entry, dict) and "your_column" in entry:
            src = entry["your_column"]
            if src not in df.columns:
                print(f"ERROR: Essential column '{src}' ({key}) not found in data.")
                print(f"  Available: {list(df.columns)}")
                sys.exit(1)

    # --- Build full rename map: essential (fixed keys) + everything else (auto keys) ---
    rename = {}
    for col in df.columns:
        if col in essential_rename:
            rename[col] = essential_rename[col]
        else:
            rename[col] = to_json_key(col)

    # Deduplicate: if two source columns map to the same key, suffix them
    seen = {}
    for src, key in list(rename.items()):
        if key in seen:
            rename[src] = key + "_2"
        else:
            seen[key] = src

    df = df.rename(columns=rename)

    # --- Date formatting — convert ALL datetime/timestamp columns ---
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = pd.to_datetime(df[col], errors="coerce").dt.strftime("%Y-%m-%d")

    # --- Drop rows missing essential spread/maturity ---
    oas_key = essential["spread"]["dashboard_key"]
    maturity_key = essential["maturity_date"]["dashboard_key"]
    required = [c for c in [oas_key, maturity_key] if c in df.columns]
    before = len(df)
    df = df.dropna(subset=required)
    if len(df) < before:
        print(f"  Dropped {before - len(df)} rows missing {required}")

    # --- Clean NaN/Infinity for valid JSON ---
    df = df.fillna(0)
    for col in df.select_dtypes(include="number").columns:
        df[col] = df[col].replace([float('inf'), float('-inf')], 0)

    # --- Write ---
    records = df.to_dict("records")
    with open(DATA_OUTPUT, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False)

    print(f"✓ {len(records):,} records × {len(df.columns)} columns → {DATA_OUTPUT}")

    # Summary
    print(f"\nColumn mapping ({len(rename)} columns):")
    for orig, key in sorted(rename.items(), key=lambda x: x[1]):
        tag = " [essential]" if orig in essential_rename else ""
        print(f"  {key:<30} ← {orig}{tag}")

    print(f"\n{'=' * 60}")
    print(f"  DONE! Next steps:")
    print(f"  1. python -m http.server 8000")
    print(f"  2. Open http://localhost:8000/bond_spread_dashboard.html")
    print(f"  3. Click ⚙ SETTINGS to configure filters & columns")
    print(f"{'=' * 60}")



def preprocess(df: pd.DataFrame) -> pd.DataFrame:
    """
    Apply dataset-specific transformations BEFORE export.
    
    This runs on the raw DataFrame with ORIGINAL column names.
    Add your custom cleaning, filtering, and derived columns here.
    
    Examples:
        df = df[df["Currency"] == "EUR"]
        df["Spread"] = df["Spread"].clip(lower=0)
        df["Rating"] = df["Rating"].str.strip().str.upper()
        df = df[df["OAS vs Govt"] > 0]
        df = df.drop(columns=["useless_column_1", "useless_column_2"])
    """

    # --- Derive Type from subordination dummy if present ---
    if "Subordonnee_dummy" in df.columns and "Type" not in df.columns:
        df["Type"] = df["Subordonnee_dummy"].map({0: "Senior", 1: "Subordinated"})
        print("  Derived 'Type' from 'Subordonnee_dummy'")

    FUNDAMENTAL_COLS = [
    "PE LTM", "Price Cont Op Earning", "PB LTM", "PB / PTangibleBook LTM", "PFCF LTM",
    "P to CFO", "EV to Ebit", "EV to Ebit FY1 CIQ", "EV to Sales LTM", "EV To EBITDA LTM",
    "Ebitda to Int expense", "ROE avg FY0", "Net Debt to Tot Equity", "Net Debt to Market Cap",
    "Net Debt to Ebit", "DVD Yield FY0", "DVD Payout FY0",
    "Gross Margin", "Oper Margin", "Cont Op Earning Margin",
    "Earns Yield FY0", "Revenue 5Y CAGR", "CFO Div Cov Ratio",
    "FCF Div Cov Ratio", "Ebitda 5Y CAGR", "Ebit 5Y CAGR", "CFO 5Y CAGR",
    "Const Earning 5Y CAGR", "Gross Profit 5Y CAGR", "PE FY1 CIQ", "EPS Growth FY1 CIQ",
    "Sales Growth FY1 CIQ", "EBITDA Growth FY1 CIQ", "Pct_Short_Interest",
    "Sales", "Ebitda", "Ebit", "Operative Income", "Cont Op", "Net Income", "EPS",
    "FCF", "CFO", "Net Debt", "Total Equity", "Total Debt",
    "Total Cash and Equiv", "EPS Estimates FY1", "EBITDA FY1", "Sales FY1",
    "Current Assets CIQ", "Current Liabilities CIQ", "shTerm Debt CIQ", "Capex CIQ",
    "Interest expense CIQ", "net WorkCapital CIQ", "Goodwill CIQ",
    "Net PropPlantEquipm CIQ", "R&D Expense CIQ", "Cost of Goods Sold CIQ",
    "Depreciation and Amort CIQ", "Goodwill Impairment CIQ", "change Net WorkCapital CIQ",
    "CF from Investing", "Repurchase Stock CIQ", "CF total div paid CIQ",
    "Non interest expense CIQ", "Total Asset CIQ", "Gross Loans CIQ",
    "Total Deposit CIQ", "Non Perf loan CIQ", "Non Perf Assets CIQ",
    "Coverage Ratio CIQ", "Risk adj Assets CIQ", "Core Tier1 Ratio CIQ",
    "Tier1 Ratio CIQ", "Prov for Loan Losses CIQ", "Non perf Loans to Total Loans CIQ",
    "Total Capital Ratio CIQ", "Total Employees CIQ", "SP Price Target CIQ",
    "SP Price Close CIQ", "SP Est 5Y EPS Gr CIQ", "EPS Med NTM 0",
    "EPS Revision Ratio", "Daily Vol 260J",
    ]
    df.drop(columns=[col for col in FUNDAMENTAL_COLS if col in df.columns], inplace=True)


    # ┌─────────────────────────────────────────────────────────────────┐
    # │  ADD YOUR CUSTOM TRANSFORMATIONS BELOW                          │
    # │                                                                 │
    # │                                                                 │
    # │                                                                 │
    # └─────────────────────────────────────────────────────────────────┘

    return df


if __name__ == "__main__":
    main()
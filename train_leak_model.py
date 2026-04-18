"""
train_leak_model.py
───────────────────
Trains Random Forest models for water pipe leak and burst detection.
Outputs model files and a thresholds JSON for use in the dashboard.

Usage:
    python train_leak_model.py --data water_leak_detection_1000_rows.csv
"""

import argparse
import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

# ── CLI ────────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--data", default="water_leak_detection_1000_rows.csv")
parser.add_argument("--out-dir", default="model_output")
args = parser.parse_args()

OUT = Path(args.out_dir)
OUT.mkdir(exist_ok=True)

# ── Load data ──────────────────────────────────────────────────────────────────
print(f"Loading {args.data} …")
df = pd.read_csv(args.data)
print(f"  {len(df):,} rows | columns: {df.columns.tolist()}")

FEATURES = ["Pressure (bar)", "Flow Rate (L/s)", "Temperature (°C)"]
X = df[FEATURES].values

y_leak  = df["Leak Status"].values
y_burst = df["Burst Status"].values
y_any   = ((y_leak == 1) | (y_burst == 1)).astype(int)

print(f"  Leak events : {y_leak.sum()}  |  Burst events: {y_burst.sum()}")


# ── Helper: build and evaluate a pipeline ─────────────────────────────────────
def build_and_eval(X, y, label: str) -> Pipeline:
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    pipe = Pipeline([
        ("scaler", StandardScaler()),
        ("rf", RandomForestClassifier(
            n_estimators=200,
            max_depth=8,
            class_weight="balanced",
            random_state=42,
            n_jobs=-1,
        )),
    ])

    pipe.fit(X_tr, y_tr)
    y_pred = pipe.predict(X_te)
    y_prob = pipe.predict_proba(X_te)[:, 1]

    print(f"\n{'='*50}")
    print(f"  MODEL: {label}")
    print(f"{'='*50}")
    print(classification_report(y_te, y_pred, zero_division=0))

    if y_te.sum() > 0:
        auc = roc_auc_score(y_te, y_prob)
        print(f"  ROC-AUC: {auc:.4f}")

    # 5-fold CV
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
    cv_scores = cross_val_score(pipe, X, y, cv=cv, scoring="f1_weighted")
    print(f"  CV F1 (5-fold): {cv_scores.mean():.4f} ± {cv_scores.std():.4f}")

    # Feature importance
    rf = pipe.named_steps["rf"]
    imps = dict(zip(FEATURES, rf.feature_importances_))
    print("  Feature importances:")
    for feat, imp in sorted(imps.items(), key=lambda x: -x[1]):
        print(f"    {feat:<25}: {imp:.4f}")

    return pipe


# ── Train models ───────────────────────────────────────────────────────────────
pipe_leak  = build_and_eval(X, y_leak,  "LEAK DETECTION")
pipe_burst = build_and_eval(X, y_burst, "BURST DETECTION")
pipe_any   = build_and_eval(X, y_any,   "ANY EVENT (leak or burst)")


# ── Save models ────────────────────────────────────────────────────────────────
for name, pipe in [("leak", pipe_leak), ("burst", pipe_burst), ("any", pipe_any)]:
    path = OUT / f"model_{name}.pkl"
    with open(path, "wb") as f:
        pickle.dump(pipe, f)
    print(f"\nSaved {path}")


# ── Derive and save operational thresholds ─────────────────────────────────────
normal = df[df["Leak Status"] == 0]
leaks  = df[df["Leak Status"] == 1]
bursts = df[df["Burst Status"] == 1]

thresholds = {
    "features": FEATURES,
    "pressure": {
        "normal_mean": float(normal["Pressure (bar)"].mean()),
        "normal_std":  float(normal["Pressure (bar)"].std()),
        "leak_p25":    float(leaks["Pressure (bar)"].quantile(0.25)) if len(leaks) else None,
        "leak_p75":    float(leaks["Pressure (bar)"].quantile(0.75)) if len(leaks) else None,
        "warn_below":  float(normal["Pressure (bar)"].mean() - normal["Pressure (bar)"].std()),
        "alert_below": float(normal["Pressure (bar)"].mean() - 2 * normal["Pressure (bar)"].std()),
        "burst_above": float(normal["Pressure (bar)"].quantile(0.99)),
    },
    "flow_rate": {
        "normal_mean":       float(normal["Flow Rate (L/s)"].mean()),
        "normal_std":        float(normal["Flow Rate (L/s)"].std()),
        "diverge_threshold": 0.25,   # L/s difference between sensors
        "spike_threshold":   float(normal["Flow Rate (L/s)"].mean() + 3 * normal["Flow Rate (L/s)"].std()),
    },
    "model_info": {
        "n_train": len(df),
        "leak_prevalence": float(y_leak.mean()),
        "burst_prevalence": float(y_burst.mean()),
    }
}

thresh_path = OUT / "thresholds.json"
with open(thresh_path, "w") as f:
    json.dump(thresholds, f, indent=2)
print(f"\nSaved {thresh_path}")
print("\nDone. Run dashboard with: python dashboard.py")

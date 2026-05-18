"""Pull Shopify orders for a given calendar date (store-local) and compute:

  - fulfillment time  = first fulfillment.createdAt  - order.createdAt
  - shipping time     = delivered_event.happenedAt   - fulfillment.createdAt
  - total time        = delivered_event.happenedAt   - order.createdAt

Writes a CSV and prints a summary.

Usage:
  python shipping_times.py 2026-04-13
  python shipping_times.py 2026-04-13 --out ./out/april13.csv
"""

from __future__ import annotations

import argparse
import csv
import os
import statistics
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

DOTENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(DOTENV_PATH)

SHOP = os.getenv("SHOPIFY_SHOP", "").strip()
CLIENT_ID = os.getenv("SHOPIFY_CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("SHOPIFY_CLIENT_SECRET", "").strip()
API_VERSION = os.getenv("SHOPIFY_API_VERSION", "2026-04").strip()

missing = [k for k, v in {
    "SHOPIFY_SHOP": SHOP,
    "SHOPIFY_CLIENT_ID": CLIENT_ID,
    "SHOPIFY_CLIENT_SECRET": CLIENT_SECRET,
}.items() if not v]
if missing:
    sys.exit(f"Missing in .env: {', '.join(missing)}")


def mint_access_token() -> str:
    """Mint a fresh 24-hour Admin API token via the client_credentials grant.
    Works for own-store apps created in the Shopify Dev Dashboard.
    """
    r = requests.post(
        f"https://{SHOP}/admin/oauth/access_token",
        data={"grant_type": "client_credentials", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET},
        timeout=20,
    )
    if r.status_code != 200:
        sys.exit(f"client_credentials grant failed ({r.status_code}): {r.text[:500]}")
    return r.json()["access_token"]


TOKEN = mint_access_token()
GQL_URL = f"https://{SHOP}/admin/api/{API_VERSION}/graphql.json"
HEADERS = {"X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json"}


def gql(query: str, variables: dict | None = None) -> dict:
    for attempt in range(6):
        r = requests.post(GQL_URL, json={"query": query, "variables": variables or {}}, headers=HEADERS, timeout=30)
        if r.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
        body = r.json()
        if "errors" in body:
            if any("THROTTLED" in str(e).upper() for e in body["errors"]):
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"GraphQL errors: {body['errors']}")
        return body["data"]
    raise RuntimeError("Too many throttled retries")


SHOP_QUERY = "{ shop { ianaTimezone name } }"

ORDERS_QUERY = """
query OrdersForDay($q: String!, $cursor: String) {
  orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      displayFulfillmentStatus
      fulfillments {
        createdAt
        deliveredAt
        inTransitAt
        status
        trackingInfo { number company url }
        events(first: 50, sortKey: HAPPENED_AT) {
          edges { node { status happenedAt } }
        }
      }
    }
  }
}
"""


def parse_iso(s: str | None):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def fetch_orders(date_str: str, tz_name: str) -> list[dict]:
    tz = ZoneInfo(tz_name)
    day_start = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=tz)
    day_end = day_start + timedelta(days=1)
    q = f"created_at:>='{day_start.isoformat()}' created_at:<'{day_end.isoformat()}'"

    orders: list[dict] = []
    cursor: str | None = None
    while True:
        data = gql(ORDERS_QUERY, {"q": q, "cursor": cursor})
        conn = data["orders"]
        orders.extend(conn["nodes"])
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
    return orders


def find_delivered(fulfillment: dict):
    if fulfillment.get("deliveredAt"):
        return parse_iso(fulfillment["deliveredAt"])
    for edge in (fulfillment.get("events") or {}).get("edges", []):
        node = edge["node"]
        if str(node.get("status", "")).upper() == "DELIVERED":
            return parse_iso(node["happenedAt"])
    return None


def compute_row(order: dict) -> dict:
    order_created = parse_iso(order["createdAt"])
    fulfillments = order.get("fulfillments") or []

    base = {
        "order_name": order["name"],
        "order_id": order["id"],
        "order_created_at": order["createdAt"],
        "fulfilled_at": None,
        "delivered_at": None,
        "fulfillment_hours": None,
        "shipping_hours": None,
        "total_hours": None,
        "status": "unfulfilled",
        "tracking_company": None,
        "tracking_number": None,
    }
    if not fulfillments:
        return base

    first_f = min(fulfillments, key=lambda f: f["createdAt"])
    fulfilled_at = parse_iso(first_f["createdAt"])
    base["fulfilled_at"] = first_f["createdAt"]
    base["fulfillment_hours"] = round((fulfilled_at - order_created).total_seconds() / 3600, 2)

    delivered_at = None
    for f in fulfillments:
        d = find_delivered(f)
        if d and (delivered_at is None or d > delivered_at):
            delivered_at = d

    if delivered_at:
        base["delivered_at"] = delivered_at.isoformat()
        base["shipping_hours"] = round((delivered_at - fulfilled_at).total_seconds() / 3600, 2)
        base["total_hours"] = round((delivered_at - order_created).total_seconds() / 3600, 2)
        base["status"] = "delivered"
    else:
        base["status"] = "in_transit_or_unknown"

    ti_list = first_f.get("trackingInfo") or []
    if ti_list:
        base["tracking_company"] = ti_list[0].get("company")
        base["tracking_number"] = ti_list[0].get("number")
    return base


def percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return float("nan")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def summary(values: list, label: str) -> None:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        print(f"  {label:<35} no data")
        return
    print(
        f"  {label:<35} n={len(vals):<3} "
        f"mean={statistics.mean(vals):6.1f}h  "
        f"median={statistics.median(vals):6.1f}h  "
        f"p90={percentile(vals, 0.9):6.1f}h  "
        f"max={max(vals):6.1f}h"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("date", help="Order date in YYYY-MM-DD (store-local time)")
    ap.add_argument("--out", default=None, help="CSV output path")
    args = ap.parse_args()

    shop_info = gql(SHOP_QUERY)["shop"]
    tz_name = shop_info["ianaTimezone"]
    print(f"Shop: {shop_info['name']}  ({SHOP})  tz={tz_name}")
    print(f"Fetching orders created on {args.date} (store local) ...")

    orders = fetch_orders(args.date, tz_name)
    print(f"Got {len(orders)} order(s).")

    rows = [compute_row(o) for o in orders]

    out_path = Path(args.out) if args.out else Path(__file__).resolve().parent / "out" / f"shipping-{args.date}.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "order_name", "order_id", "order_created_at",
        "fulfilled_at", "delivered_at",
        "fulfillment_hours", "shipping_hours", "total_hours",
        "status", "tracking_company", "tracking_number",
    ]
    with out_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {out_path}")

    print("\nSummary (hours):")
    summary([r["fulfillment_hours"] for r in rows], "fulfillment (order -> shipped)")
    summary([r["shipping_hours"] for r in rows],    "shipping    (shipped -> delivered)")
    summary([r["total_hours"] for r in rows],       "total       (order -> delivered)")

    delivered = sum(1 for r in rows if r["status"] == "delivered")
    in_transit = sum(1 for r in rows if r["status"] == "in_transit_or_unknown")
    unfulfilled = sum(1 for r in rows if r["status"] == "unfulfilled")
    print(f"\nDelivered: {delivered}/{len(rows)}   In transit/unknown: {in_transit}   Unfulfilled: {unfulfilled}")


if __name__ == "__main__":
    main()

"""Rebuild INC-002..INC-012 deterministic, agent-visible synthetic fixtures.

This authoring script is outside the Docker COPY of incident_agent/fixtures.
It deliberately contains no evaluation answers.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def stamp(base: datetime, seconds: int) -> str:
    return (base + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def span(base: datetime, name: str, start: int, end: int, status: str, http: int | None = None, *, slow: bool = False) -> dict:
    # Ordinal ticks keep the case definitions readable while making normal
    # spans tens of milliseconds and slow spans around one to two seconds.
    tick_ms = 20 if start < 0 else (600 if slow else 50)
    origin_ms = -210_000 if start < 0 else 10_000
    first_tick = -205 if start < 0 else 10
    start_ms = origin_ms + (start - first_tick) * tick_ms
    end_ms = origin_ms + (end - first_tick) * tick_ms
    result = {
        "span_id": name.replace(".", "-").replace("/", "-") + f"-{start}",
        "name": name,
        "started_at": stamp_ms(base, start_ms),
        "ended_at": stamp_ms(base, end_ms),
        "duration_ms": end_ms - start_ms,
        "status": status,
    }
    if http is not None:
        result["http_status"] = http
    return result


def stamp_ms(base: datetime, milliseconds: int) -> str:
    return (base + timedelta(milliseconds=milliseconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# All time offsets are relative to the alert threshold at t=0.
# Metrics: baseline, degradation before alert, then observed after alert.
# Logs and traces share the failing request ID for each case.
CASES = [
    {
        "id": 2, "service": "session-service", "alert": "Session read failure rate exceeded 5%",
        "logs": [(-20, "cache", "cache connect refused while reading session"), (12, "http", "GET /session returned HTTP 500 after Redis connection refusal")],
        "metrics": [
            {"cache_connection_errors_1m": 0, "session_read_fail_percent": 0, "cpu_percent": 28, "db_query_p95_ms": 36},
            {"cache_connection_errors_1m": 14, "session_read_fail_percent": 4, "cpu_percent": 29, "db_query_p95_ms": 37},
            {"cache_connection_errors_1m": 36, "session_read_fail_percent": 12, "cpu_percent": 30, "db_query_p95_ms": 35},
        ],
        "healthy": [("redis.get", -201, -200, "OK", None), ("GET /session", -202, -199, "OK", 200)],
        "failed": [("redis.get", 10, 11, "ERROR", None), ("GET /session", 10, 12, "ERROR", 500)],
        "change": None,
    },
    {
        "id": 3, "service": "checkout-service", "alert": "Checkout HTTP 502 rate exceeded 5%",
        "logs": [(-20, "shipping-client", "shipping-api returned HTTP 503"), (12, "http", "POST /checkout returned HTTP 502 after shipping-api HTTP 503")],
        "metrics": [
            {"shipping_5xx_percent": 0, "checkout_502_percent": 0, "cpu_percent": 25, "db_query_p95_ms": 31},
            {"shipping_5xx_percent": 15, "checkout_502_percent": 4, "cpu_percent": 26, "db_query_p95_ms": 31},
            {"shipping_5xx_percent": 25, "checkout_502_percent": 10, "cpu_percent": 27, "db_query_p95_ms": 32},
        ],
        "healthy": [("validate_cart", -204, -203, "OK", None), ("shipping-api", -203, -201, "OK", 200), ("POST /checkout", -205, -200, "OK", 200)],
        "failed": [("validate_cart", 10, 11, "OK", None), ("shipping-api", 11, 12, "ERROR", 503), ("POST /checkout", 10, 13, "ERROR", 502)],
        "change": None,
    },
    {
        "id": 4, "service": "order-service", "alert": "Coupon checkout HTTP 500 rate rose after version v2 deployment",
        "logs": [(-20, "order-v2", "legacy client request without optional coupon field raised missing-field exception in validate_coupon"), (12, "http", "legacy coupon checkout returned HTTP 500; ordinary checkout remained successful")],
        "metrics": [
            {"coupon_checkout_5xx_percent": 0, "ordinary_checkout_5xx_percent": 0, "cpu_percent": 24, "memory_mb": 420},
            {"coupon_checkout_5xx_percent": 4, "ordinary_checkout_5xx_percent": 0, "cpu_percent": 24, "memory_mb": 421},
            {"coupon_checkout_5xx_percent": 13, "ordinary_checkout_5xx_percent": 0, "cpu_percent": 25, "memory_mb": 422},
        ],
        "healthy": [("validate_coupon", -202, -201, "OK", None), ("POST /orders", -203, -200, "OK", 200)],
        "failed": [("validate_coupon", 10, 11, "ERROR", None), ("POST /orders", 10, 12, "ERROR", 500)],
        "change": ("app/order.py", "coupon = request.get('coupon', '')", "coupon = request['coupon']"),
    },
    {
        "id": 5, "service": "report-service", "alert": "CPU exceeded 90% and report request p95 rose",
        "logs": [(-30, "scheduler", "statistics job started while the previous run was still active"), (13, "http", "GET /reports timed out while statistics jobs overlapped")],
        "metrics": [
            {"cpu_percent": 32, "statistics_jobs_started_1m": 1, "request_p95_ms": 110, "memory_mb": 390, "db_pool_waiting_requests": 0},
            {"cpu_percent": 91, "statistics_jobs_started_1m": 35, "request_p95_ms": 850, "memory_mb": 391, "db_pool_waiting_requests": 0},
            {"cpu_percent": 97, "statistics_jobs_started_1m": 60, "request_p95_ms": 1900, "memory_mb": 392, "db_pool_waiting_requests": 0},
        ],
        "healthy": [("report.compute", -202, -201, "OK", None), ("GET /reports", -203, -200, "OK", 200)],
        "failed": [("report.compute", 10, 13, "ERROR", None), ("GET /reports", 10, 14, "ERROR", 504)],
        "change": ("config/report-service.yaml", "interval_seconds: 60", "interval_seconds: 1"),
    },
    {
        "id": 6, "service": "image-service", "alert": "Image worker memory grew and image requests began failing",
        "logs": [(-40, "image-worker", "processed image count increased; process memory remained allocated after request"), (12, "image-worker", "image processing allocation failed; worker restarted")],
        "metrics": [
            {"memory_mb": 410, "images_processed_total": 100, "cpu_percent": 35, "image_failure_percent": 0},
            {"memory_mb": 1250, "images_processed_total": 600, "cpu_percent": 36, "image_failure_percent": 2},
            {"memory_mb": 1880, "images_processed_total": 900, "cpu_percent": 36, "image_failure_percent": 14},
        ],
        "healthy": [("image.process", -202, -201, "OK", None), ("POST /images", -203, -200, "OK", 200)],
        "failed": [("image.process", 10, 12, "ERROR", None), ("POST /images", 10, 13, "ERROR", 500)],
        "change": ("app/image.py", "return resize(image)", "processed_buffers.append(resize(image))"),
    },
    {
        "id": 7, "service": "notify-service", "alert": "Production SMS send failure rate exceeded 5%",
        "logs": [(-20, "sms-client", "SMS API at sms.sandbox.example.invalid returned HTTP 401 for production environment"), (12, "notify", "SMS send failed after HTTP 401 response")],
        "metrics": [
            {"sms_failure_percent": 0, "sms_connect_p95_ms": 48, "cpu_percent": 20},
            {"sms_failure_percent": 4, "sms_connect_p95_ms": 49, "cpu_percent": 20},
            {"sms_failure_percent": 18, "sms_connect_p95_ms": 47, "cpu_percent": 21},
        ],
        "healthy": [("sms-api", -202, -201, "OK", 202), ("send_sms", -203, -200, "OK", None)],
        "failed": [("sms.sandbox.example.invalid", 10, 11, "ERROR", 401), ("send_sms", 10, 12, "ERROR", None)],
        "change": ("config/notify-production.yaml", "sms_api_url: https://sms.prod.example.invalid", "sms_api_url: https://sms.sandbox.example.invalid"),
    },
    {
        "id": 8, "service": "catalog-service", "alert": "Product list p95 and database read volume rose",
        "logs": [(-20, "cache", "cache miss for product-list:all; Redis connection OK"), (12, "cache", "repeated cache miss for product-list:all followed by database read")],
        "metrics": [
            {"cache_hit_percent": 92, "redis_connection_errors_1m": 0, "db_reads_1m": 40, "request_p95_ms": 75},
            {"cache_hit_percent": 38, "redis_connection_errors_1m": 0, "db_reads_1m": 390, "request_p95_ms": 260},
            {"cache_hit_percent": 12, "redis_connection_errors_1m": 0, "db_reads_1m": 820, "request_p95_ms": 430},
        ],
        "healthy": [("redis.get cache_hit", -203, -202, "OK", None), ("GET /products", -204, -201, "OK", 200)],
        "failed": [("redis.get cache_miss", 10, 11, "OK", None), ("db.list_products", 11, 12, "OK", None), ("GET /products", 10, 13, "OK", 200)],
        "change": ("config/catalog-service.yaml", "ttl_seconds: 300", "ttl_seconds: 1"),
    },
    {
        "id": 9, "service": "search-service", "alert": "Order search request p95 exceeded 1000 ms",
        "logs": [(-20, "database", "slow query SELECT orders by customer_id; execution exceeded 1500 ms"), (14, "http", "GET /orders/search completed slowly after database query")],
        "metrics": [
            {"db_query_p95_ms": 45, "db_acquire_p95_ms": 11, "db_pool_waiting_requests": 0, "request_p95_ms": 70},
            {"db_query_p95_ms": 1300, "db_acquire_p95_ms": 12, "db_pool_waiting_requests": 0, "request_p95_ms": 1400},
            {"db_query_p95_ms": 1800, "db_acquire_p95_ms": 12, "db_pool_waiting_requests": 0, "request_p95_ms": 1900},
        ],
        "healthy": [("db.acquire_connection", -204, -203, "OK", None), ("db.search_orders", -203, -202, "OK", None), ("GET /orders/search", -205, -201, "OK", 200)],
        "failed": [("db.acquire_connection", 10, 11, "OK", None), ("db.search_orders", 11, 13, "OK", None), ("GET /orders/search", 10, 14, "OK", 200)],
        "change": ("migrations/20260926_orders.sql", "CREATE INDEX idx_orders_customer_id ON orders(customer_id);", "DROP INDEX idx_orders_customer_id;"),
    },
    {
        "id": 10, "service": "profile-service", "alert": "Profile request p95 increased with occasional timeout",
        "logs": [(-20, "dns", "DNS lookup for avatar-api.example.invalid exceeded 1500 ms"), (14, "http", "GET /profile timed out before avatar-api connection completed")],
        "metrics": [
            {"dns_lookup_p95_ms": 22, "avatar_connected_response_p95_ms": 42, "avatar_5xx_percent": 0, "request_p95_ms": 95},
            {"dns_lookup_p95_ms": 1150, "avatar_connected_response_p95_ms": 43, "avatar_5xx_percent": 0, "request_p95_ms": 1250},
            {"dns_lookup_p95_ms": 1800, "avatar_connected_response_p95_ms": 41, "avatar_5xx_percent": 0, "request_p95_ms": 1900},
        ],
        "healthy": [("dns.lookup avatar-api", -204, -203, "OK", None), ("avatar-api", -203, -202, "OK", 200), ("GET /profile", -205, -201, "OK", 200)],
        "failed": [("dns.lookup avatar-api", 10, 12, "ERROR", None), ("GET /profile", 10, 13, "ERROR", 504)],
        "change": None,
    },
    {
        "id": 11, "service": "checkout-service", "alert": "Intermittent checkout HTTP 502 rate exceeded 5%",
        "request_id": "req-conflict-11",
        "logs": [(11, "cache", "req-conflict-11 cache timeout in cache.get span cache-get-10 during checkout"), (13, "http", "req-conflict-11 POST /checkout returned HTTP 502")],
        "metrics": [
            {"cache_error_percent": 0, "shipping_5xx_percent": 0, "checkout_502_percent": 0},
            {"cache_error_percent": 7, "shipping_5xx_percent": 9, "checkout_502_percent": 3},
            {"cache_error_percent": 11, "shipping_5xx_percent": 13, "checkout_502_percent": 8},
        ],
        "healthy": [("cache.get", -204, -203, "OK", None), ("shipping-api", -203, -202, "OK", 200), ("POST /checkout", -205, -201, "OK", 200)],
        "failed": [("cache.get", 10, 11, "OK", None), ("shipping-api", 11, 12, "ERROR", 503), ("POST /checkout", 10, 13, "ERROR", 502)],
        "change": None,
    },
    {
        "id": 12, "service": "email-worker", "alert": "Pending email queue length increased while successful sends fell",
        "logs": [(-20, "worker", "job failed; retry scheduled"), (12, "worker", "job failed; retry scheduled")],
        "metrics": [
            {"pending_jobs": 20, "successful_jobs_1m": 100, "cpu_percent": 18, "memory_mb": 300},
            {"pending_jobs": 170, "successful_jobs_1m": 22, "cpu_percent": 19, "memory_mb": 302},
            {"pending_jobs": 420, "successful_jobs_1m": 2, "cpu_percent": 18, "memory_mb": 303},
        ],
        "healthy": [], "failed": [], "change": None,
    },
]


def generate() -> None:
    for case in CASES:
        number = case["id"]
        incident_id = f"INC-{number:03d}"
        base = datetime(2026, 9, 26, 10 + number, 0, tzinfo=timezone.utc)
        folder = FIXTURES / incident_id
        folder.mkdir(parents=True, exist_ok=True)
        request_id = case.get("request_id", f"req-{number:03d}-fail")
        write_json(folder / "incident.json", {
            "incident_id": incident_id,
            "service": case["service"],
            "alert": case["alert"],
            "started_at": stamp(base, 0),
        })
        write_json(folder / "logs.json", {
            "service": case["service"],
            "entries": [
                {
                    "timestamp": stamp(base, offset),
                    "level": "ERROR" if number not in (8, 9) else "WARN",
                    "request_id": request_id if offset >= 0 else f"req-{number:03d}-early",
                    "component": component,
                    "message": message,
                }
                for offset, component, message in case["logs"]
            ],
        })
        write_json(folder / "metrics.json", {
            "service": case["service"],
            "samples": [
                {"observed_at": stamp(base, offset), **sample}
                for offset, sample in zip((-180, -30, 60), case["metrics"], strict=True)
            ],
        })
        traces = []
        for label, spans in (("healthy", case["healthy"]), ("observed", case["failed"])):
            if not spans:
                continue
            traces.append({
                "trace_id": f"trace-{number:03d}-{label}",
                "request_id": f"req-{number:03d}-ok" if label == "healthy" else request_id,
                "spans": [span(base, *item, slow=(number in (5, 9, 10) and label == "observed")) for item in spans],
            })
        write_json(folder / "trace.json", {"service": case["service"], "traces": traces})
        change = case["change"]
        if change is None:
            patch_body = "No relevant code or configuration change recorded for this service in the incident window.\n"
            subject = "synthetic change window: no relevant diff"
        else:
            file, before, after = change
            patch_body = (
                f"diff --git a/{file} b/{file}\n"
                f"--- a/{file}\n+++ b/{file}\n@@ -1 +1 @@\n"
                f"-{before}\n+{after}\n"
            )
            subject = "synthetic service change"
        patch = (
            f"Date: {(base - timedelta(seconds=120)).strftime('%a, %d %b %Y %H:%M:%S +0000')}\n"
            f"Subject: {subject}\n\n"
            "Synthetic fixture data; this is not a commit in the MiniClaw repository.\n\n"
            + patch_body
        )
        (folder / "git_diff.patch").write_text(patch, encoding="utf-8")


if __name__ == "__main__":
    generate()

---
tags: [observability, logging, tracing, metrics, alerts, slo, opentelemetry]
stack_signals: []
summary: |
  Observability design — logs for forensics, metrics for alerts, traces for
  request paths. Every new endpoint, job, or external dependency emits at
  least one metric, structured logs, and propagates trace context.
when_to_load: |
  Task touches logging, structured logs, tracing (OpenTelemetry, distributed
  tracing), metrics emission, health checks, alerting rules, dashboards, or
  error reporting. Diff including new endpoints, new background jobs, new
  external integrations, or any change that ships behavior-the-team-needs-to-watch
  also qualifies.
agent_hints: [logic-reviewer, performance, challenger-reviewer]
---

# Observability — Senior Stance

## When this applies
Load when task touches: logging, structured logs, tracing (OpenTelemetry, distributed tracing), metrics emission, health checks, alerting rules, dashboards, error reporting. Reviewer auto-loads when diff includes new endpoints, new background jobs, new external integrations, or any change that ships behavior-the-team-needs-to-watch.

## Default Stance
You can't fix what you can't see. Every new endpoint, job, or external dependency MUST emit at least one metric, one structured log on entry/exit, and propagate trace context. Logs are for forensics, metrics are for alerts, traces are for "where did this request go". The three are complementary, not interchangeable. Sampling is fine; not emitting at all is not.

## Patterns (use these)

### Structured logs
- JSON format. One event per line. Machine-parseable.
- Required fields: `timestamp`, `level`, `message`, `service`, `request_id` (or `trace_id`).
- Domain fields: `user_id`, `task_id`, `endpoint`, `duration_ms`, etc.
- NEVER log sensitive data: passwords, tokens, full credit card, full SSN. Hash or redact at log boundary.

```json
{"ts":"2026-05-10T12:34:56Z","level":"info","msg":"user.created","service":"api","trace_id":"abc","user_id":"u_123","duration_ms":42}
```

### Trace context propagation
- Every request gets a `trace_id` at the edge. Pass it downstream via header (`traceparent` per W3C Trace Context, or X-Request-ID).
- Each service emits its span with its operation, duration, status.
- Log lines include `trace_id` so you can correlate log events with the trace.

### Metric types
- **Counter** — monotonic increasing (`requests_total`, `errors_total`). Compute rate via `rate(counter[5m])` in Prometheus.
- **Gauge** — point-in-time value (`active_connections`, `queue_depth`). Goes up and down.
- **Histogram** — distribution (request duration, payload size). Compute p50, p95, p99 via `histogram_quantile`.

Naming: `<domain>_<entity>_<unit>`: `http_request_duration_seconds`, `db_query_duration_seconds`, `cache_hits_total`. Lowercase snake_case.

### RED method (per request-driven service)
For every endpoint:
- **R**ate — requests per second.
- **E**rrors — error rate (4xx + 5xx, OR business error count).
- **D**uration — p50 / p95 / p99 latency.

Dashboard: one row per endpoint, columns R-E-D. Glance to see "what's broken".

### USE method (per resource)
For every resource (CPU, memory, disk, connection pool, queue):
- **U**tilization — % busy.
- **S**aturation — queue depth / wait time.
- **E**rrors — count of errors talking to this resource.

### Service Level Objectives (SLOs)
- Define a metric (e.g., "99.5% of requests < 500ms over 30 days").
- Track an error budget (1 - SLO target).
- Alert when error budget burn rate is high (will exhaust before period end).
- Don't alert on every breach — alert on burn-rate over a window.

### Alerting hygiene
- **Symptom-based**, not cause-based. "p95 latency above 1s for 5 min" is a symptom alert. "CPU above 80%" is a cause alert (often false-positive).
- **Actionable** — every alert must have a runbook link explaining what the operator does next.
- **Escalation tiers** — page only for things that need immediate human action. Slack-channel alerts for things that need attention within hours.
- **No mystery alerts** — if oncall doesn't know why an alert fired, the alert is broken. Fix or delete.

### Health checks
- **Liveness** — "is process up". Cheap, never depends on external services. Used by orchestrator (k8s) to restart.
- **Readiness** — "can serve traffic". May check DB connection, downstream service, cache. Used by load balancer to drain.
- Don't conflate them. Liveness failing = restart me; readiness failing = stop sending traffic.

### Error reporting
- Capture error + stack trace + request context (user_id, request_id, path, params).
- Group by error fingerprint (Sentry, Honeybadger, etc.).
- Tag with deploy version → "this error started at deploy 4.2.0".
- Don't capture every error: validation errors and 4xx are noise. Capture 5xx and unexpected exceptions.

## Anti-Patterns (DO NOT)

### Logging without structure
`logger.info(\`User \${userId} did \${action} at \${time}\`)` → unparseable freeform string.
**Why it bites:** can't filter, group, or aggregate. Every grep is a one-off.
**Rule:** structured fields always. `logger.info('user.action', { user_id, action, ts })`.

### Logging sensitive data
`logger.info('login attempt', { email, password })`. Tokens, secrets, full PII in logs = breach surface.
**Rule:** redact at log boundary. Reject log lines containing forbidden patterns in CI (regex check).

### Excessive logging on hot paths
Every request → 50 log lines. At 1k QPS, you're emitting 50k lines/sec. Log pipeline backed up; storage cost spikes.
**Rule:** ONE log per request entry, ONE per exit (with duration). Detail logs at DEBUG level only, sampled or dynamically enabled.

### Metric names that are unique per request
`requests_total{user_id="u_12345"}` → cardinality explosion. Prometheus can't handle 1M time-series.
**Rule:** metric labels are LOW cardinality (≤100 unique values). High-cardinality data goes in logs/traces, not metrics.

### Alerting on every breach
"Latency exceeded threshold" alert fires once per minute when service is degraded. Operator drowns.
**Rule:** sustained breach (> 5 min) OR error budget burn rate. Alerts have hysteresis.

### Cause-based alerts everywhere
"CPU > 80%" — but the service is fine, the autoscaler will handle it.
**Rule:** alert on user-impacting symptoms. CPU/memory only when no symptom-level alert exists for the failure mode.

### No trace context across services
Service A has `trace_id=abc`, service B logs without it. Can't follow a request across services.
**Rule:** propagate trace context via header at every hop. Library / middleware ensures this; don't rely on per-handler discipline.

### Logging plus printing
`console.log(...)` AND `logger.info(...)` for the same event. Or `print('debug')` left in.
**Rule:** one logger, configured per environment. No bare `print` / `console.log` in committed code.

### Unmonitored "fire and forget" jobs
Background job runs, fails silently, no metric emitted. Bug ships when output dashboard shows zero new records for a day.
**Rule:** every job emits start/finish/duration, success/failure. Alert on missing successful run.

### Health check that always returns 200
`GET /health → 200 OK` even when DB is down. Load balancer keeps sending traffic to broken instance.
**Rule:** readiness check actually verifies dependencies it serves with.

### Sampling errors
1% sampled error reporting: 99% of errors invisible.
**Rule:** sample successful traces aggressively (1-10%). Capture errors at 100% (or near-100%).

## Decision Framework

| Need | Tool |
|---|---|
| "What happened in this specific request?" | Distributed trace + structured logs |
| "How is the system performing right now?" | Metrics dashboard (RED + USE) |
| "Wake me when something is broken" | Alerts on SLO burn / error budget |
| "Where's the error coming from?" | Error reporting (Sentry-class), grouped by fingerprint |
| New endpoint | Add: 1 entry log, 1 exit log, RED metrics, span |
| New background job | Add: start/finish logs, duration metric, success/fail counter, dead-letter queue with alert |
| New external dependency | Add: latency histogram, error counter, circuit-breaker state metric |
| Slow-query investigation | Trace → see which span is slow → check that span's logs |

## Cost Model

| Item | Cost magnitude |
|---|---|
| Structured log line, indexed | $0.50-2 per GB ingested (varies by vendor) |
| Metric time-series with low cardinality | $0.01-0.10 per series per month |
| Distributed trace span | $0.50-2 per million spans (often sampled to 1-10%) |
| Error reported & grouped | $0.10-1 per event (Sentry pricing tier) |
| 1 mystery alert (waking oncall) | Hours of human time + trust erosion |

## Red Flags in Diff

- New endpoint without entry/exit log lines or duration metric → flag.
- New `console.log` / `print` in non-test code → flag.
- New log line containing `password`, `token`, `secret`, `api_key` substrings → flag immediately (security + observability).
- New metric label using request-unique IDs (`user_id`, `request_id`) → flag (cardinality blowup).
- New alerting rule without runbook reference / linked doc → flag.
- New alert fires on instantaneous breach (no duration window) → flag (flap risk).
- New external HTTP/DB call without timeout AND without error metric → flag.
- Health check returning 200 statically → flag.
- New background job without success/failure metric → flag.
- Trace context not propagated across new service boundary (header not forwarded) → flag.
- New error swallowed silently (`try { ... } catch {}`) without log/metric → flag.
- Logging large payloads (full request body, full DB row) on hot path → flag (cost + PII risk).

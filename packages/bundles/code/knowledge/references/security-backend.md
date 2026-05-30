---
tags: [security, auth, authentication, authorization, jwt, oauth, secrets, backend]
stack_signals:
  - project_type: [backend, monorepo]
summary: |
  Backend security stance — input is hostile until proven otherwise. Covers
  authentication, authorization, sessions, JWTs, cookies, secrets handling,
  input validation, file uploads, SQL/NoSQL with user input, CORS/CSRF.
when_to_load: |
  Task touches authentication, authorization, sessions, JWTs, cookies,
  secrets/env vars, input validation, file uploads, SQL or NoSQL queries
  with user input, server-side rendering of user content, CORS/CSRF
  middleware, logging of user data, or password handling. Diff in auth/,
  middleware/, routes/, controllers/, or new DB queries built from user input
  also qualifies.
agent_hints: [security, logic-reviewer, challenger-reviewer]
---

# Backend Security — Senior Stance

## When this applies
Load when task touches: authentication, authorization, sessions, JWTs, cookies, secrets/env vars, input validation, file uploads, SQL or NoSQL queries with user input, server-side rendering of user content, CORS/CSRF middleware, logging of user data, password handling. Reviewer (especially Security Agent) auto-loads when diff includes auth code, route handlers accepting user input, DB queries built from user input, or any change in `auth/`, `middleware/`, `routes/`, `controllers/`. Also referenced by orchestrator's `--no-tests` confirmation prompt — backend-security-sensitive scope.

## Default Stance
Backend security failures are silent until they're not. Most app code is trusted to be correct; security code is trusted to be paranoid. Default to "this input is hostile until proven otherwise". Validate at the boundary, log without leaking, fail closed, sandbox what you can't trust. Time spent on auth design pays off; time spent debugging an exploited deployment after the fact does not.

## Patterns (use these)

### Authentication: tokens with short expiry + refresh
- Access token: short-lived (15 min - 1 hour), used per request.
- Refresh token: longer-lived (days/weeks), only sent to refresh endpoint, rotation on use.
- Server-side revocation list for refresh tokens (DB or Redis with TTL).
- JWT signed with strong key (RS256 or ES256 preferred over HS256 for distributed verification). Validate `alg`, `iss`, `aud`, `exp`, `nbf` on every request.

### Authorization: explicit per-resource check
- Authn produces a principal; authz checks the principal vs the resource per request.
- "Can this principal perform this action on this resource?" — answered by an explicit check, not by URL pattern alone.
- Default DENY. Whitelist allowed actions. No "if not in this blocklist, allow".
- Audit log every privileged action with `actor_id`, `target_id`, `action`, `outcome`, `request_id`.

### Input validation at the boundary
- Validate at controller entry, BEFORE the request hits any business logic.
- Reject unknown fields explicitly (don't silently ignore). Tools: Zod, Pydantic, class-validator, JSON Schema.
- Validate types AND ranges AND lengths. `string` is not enough; `string between 1 and 200 chars matching /^[a-zA-Z0-9_]+$/` is.
- File uploads: check size, MIME type, magic bytes. Re-encode images server-side; never trust client-supplied content-type.

### SQL: parameterized queries always
- ORM: usually parameterized by default. Never `prisma.$queryRawUnsafe` with user input.
- Raw SQL: `pg.query('SELECT * WHERE id = $1', [userId])`, never `\`SELECT * WHERE id = ${userId}\``.
- Even for "trusted" internal callers — defense in depth.
- Avoid dynamic table/column names from user input. If you must, allowlist the values.

### Secrets handling
- NEVER commit secrets to git. Even ".env.example" should have placeholder values.
- Load from env vars or a secrets manager (Vault, AWS Secrets Manager, GCP Secret Manager).
- Rotate regularly. After any incident, immediately.
- Don't log secrets. Don't include them in error messages. Don't return them in API responses.
- Frontend bundles: anything in `process.env.NEXT_PUBLIC_*` / `VITE_*` is PUBLIC. Never put secrets in client-visible env vars.

### CSRF protection
- For cookie-based auth: CSRF token (double-submit or synchronizer) required on state-changing requests.
- For pure bearer-token auth (Authorization header): CSRF less of a risk because browsers don't auto-send the header.
- SameSite cookies: `Strict` for sessions where possible; `Lax` is the default fallback.

### CORS done right
- Specific allowed origins. Never `*` with credentials.
- Allowed methods/headers explicit, not wildcard.
- Preflight responses cached with `Access-Control-Max-Age` to reduce overhead.

### Rate limiting at the boundary
- Per-user (authenticated) AND per-IP (unauthenticated).
- Stricter on auth endpoints (login, password reset, signup) — typical: 5 attempts / 15 min.
- Token bucket via redis-cell or equivalent.
- 429 with `Retry-After` header.

### Password handling
- Hash with bcrypt / argon2id, NEVER MD5 / SHA1 / SHA256-without-salt.
- Bcrypt cost ≥ 12 in 2026; argon2id memory ≥ 64MiB.
- Compare with constant-time comparison.
- Rate-limit login attempts.
- Optional: pwned-passwords check at signup/change.

### SSRF prevention
- If you accept a URL from a user (webhooks, image fetch, OAuth callback):
  - Resolve DNS server-side; reject private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, fc00::/7, fe80::/10, ::1).
  - Disallow `file://`, `gopher://`, `ftp://` etc. — only `https://` (or `http://` with explicit scope).
  - Set short timeout; cap response size.

### Path traversal prevention
- Never use user input directly in file paths.
- Resolve and check: `resolved = path.resolve(base, userPath); if (!resolved.startsWith(base)) reject`.
- Reject `..` / null bytes / absolute paths.

### Server-side rendering of user content
- Encode for the context: HTML body, HTML attribute, JS, CSS, URL — each has different escape rules.
- Frameworks (React, Vue, Svelte, etc.) auto-escape by default. Be wary of `dangerouslySetInnerHTML`, `v-html`, `{@html}` — these bypass.
- For markdown/HTML user input: sanitize with a vetted lib (DOMPurify, bleach) — allowlist, not blocklist.

### Sensitive data overreturn
API endpoint returns full user record including `password_hash`, `email_verified_at`, internal flags.
**Rule:** explicit response DTOs. List the fields you're sending. Never `return user` directly when `user` is the DB row.

## Anti-Patterns (DO NOT)

### Auth check in component, not in action
React Server Action does work; auth check is in the calling component.
**Why it bites:** action callable directly via fetch from anywhere. Components aren't security boundaries.
**Rule:** every Server Action begins with explicit auth check. Same for API routes, GraphQL resolvers, RPC methods.

### Trusting `req.user` without verifying token freshness
Token decoded once at session start; for hours, code uses cached `req.user` without re-checking expiry, revocation, or scope changes.
**Rule:** validate token on every request (cheap with stateless JWT). For revocation, check Redis/DB on every request (or accept short cache window matching revocation SLA).

### `eval` / `Function()` / dynamic require with user input
**Why it bites:** RCE.
**Rule:** never `eval` user input. If you need dynamic execution, use a sandbox (vm2 etc., though even those have escapes) and severely restrict capability.

### MD5 / SHA1 / unsalted SHA256 for passwords
**Rule:** bcrypt or argon2id. Never anything weaker.

### Comparing tokens / hashes with `==`
Timing-attack vulnerable. Naive equality reveals string length and partial match by timing.
**Rule:** constant-time compare (`crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python).

### CORS `Access-Control-Allow-Origin: *` with credentials
**Why it bites:** browsers reject this anyway, but seeing it = misconfigured intent. May be loosened next sprint to "fix" the rejection.
**Rule:** explicit origin allowlist. Never wildcard with credentials.

### Logging entire request bodies
Login request body logged → password in logs → log files compromised → password breach.
**Rule:** redact known-sensitive field paths (`password`, `token`, `card_number`, etc.) at log boundary. Whitelist what's logged, not blacklist.

### Returning DB error messages to users
`SQLSTATE: 23505 unique constraint "users_email_key"` returned in HTTP response.
**Why it bites:** leaks schema info. Helps attackers map the DB.
**Rule:** map DB errors to user-facing categories at the boundary. "Email already in use" not "violates unique_constraint".

### `findOne({...userInput})` without sanitization
NoSQL injection: `userInput = { $ne: null }` returns first user.
**Rule:** typed input validation. Reject objects where strings expected. ORMs help; raw drivers don't.

### Storing JWT in localStorage
**Why it bites:** XSS reads it. There's no httpOnly defense in localStorage.
**Rule:** httpOnly cookie for session tokens (SameSite=Strict / Lax). If you must use bearer in JS, isolate via subdomain + strict CSP.

### Client-side validation as the only validation
Client validates email format → server trusts → attacker bypasses client → server processes invalid.
**Rule:** server validates everything. Client validation is UX only.

### Webhook endpoint without signature verification
Anyone can POST to `/webhooks/stripe` and claim to be Stripe.
**Rule:** verify signature with shared secret on every webhook. Reject unsigned/invalid.

### Open redirect
`/login?next=https://evil.com` → after login, redirect to evil.com → phishing.
**Rule:** allowlist redirect destinations or restrict to relative paths.

### Mass assignment
`User.update(req.body)` where `req.body` includes `is_admin: true`.
**Rule:** explicit allowlist of editable fields. Or DTO that strips non-allowed fields before update.

### Same JWT for short-lived and long-lived contexts
One token used both for API auth (15 min OK) and for "remember me" (weeks). Compromise of either ruins both.
**Rule:** access token (short) + refresh token (long) split. Different scopes.

## Decision Framework

| Need | Choice |
|---|---|
| Web session for users | httpOnly cookie + SameSite=Lax + CSRF token on writes |
| API token for service-to-service | Short-lived JWT, signed with RS256 |
| Long-lived "remember me" | Refresh token, server-side revocation |
| User uploads files | Size limit + MIME check + magic-bytes check + re-encode if image; store on object storage with random key |
| Password storage | argon2id (preferred) or bcrypt cost 12+ |
| Per-resource permission | Explicit authz check per request; default deny |
| Rate limit on login/signup | 5 req / 15 min per IP + per username |
| Webhook receiver | Verify signature; reject unsigned |
| URL fetched from user | Allowlist domains OR SSRF protection (DNS resolve + private-IP rejection) |
| Sensitive log content | Redact at log boundary; whitelist what's emitted |
| Admin actions | Re-auth (step-up) before privileged actions; audit log all |
| CORS | Specific origins; no wildcard with credentials |

## Cost Model

| Vulnerability | Cost when exploited |
|---|---|
| SQL injection | Full DB compromise; data exfiltration; possible RCE |
| XSS | Session theft; account takeover at scale |
| Auth bypass | Full system compromise |
| SSRF | Internal service compromise; cloud metadata endpoint exposure (AWS IMDS) |
| Open redirect | Phishing campaigns leveraging your domain |
| Weak password hash | Password breach → credential stuffing across other sites |
| CSRF on sensitive action | Drive-by state changes from malicious sites |
| Token in localStorage + XSS | Account takeover via single XSS |
| Excessive log content with PII | GDPR fine; user data exposure |

## Red Flags in Diff

- New raw SQL string built with template literals containing user input → flag immediately (SQL injection).
- New endpoint without explicit auth check at top of handler → flag.
- New `eval`, `new Function`, `vm.runInNewContext` with user input → flag immediately (RCE).
- Password handling using `crypto.createHash('md5'|'sha1'|'sha256')` directly → flag.
- Token/hash compared with `===` / `==` → flag (use constant-time compare).
- `dangerouslySetInnerHTML` / `v-html` / `{@html}` with user content → flag (XSS unless sanitized).
- New `Access-Control-Allow-Origin: *` with `credentials: true` → flag immediately.
- `findOne(req.body)` / `find(req.query)` patterns → flag (NoSQL injection / mass assignment).
- New `User.update(req.body)` without explicit field allowlist → flag (mass assignment).
- `localStorage.setItem('token', ...)` for session token → flag (XSS exposure).
- `redirect(req.query.next)` without allowlist → flag (open redirect).
- New webhook endpoint without signature verification → flag.
- Logging `req.body` directly → flag (PII / secrets in logs).
- Error response containing stack trace / DB error verbatim → flag (info leak).
- New URL fetch from user input without SSRF protection → flag.
- `path.join(baseDir, userInput)` without resolved-path check → flag (path traversal).
- Secrets / API keys / DB URLs visible in `process.env.NEXT_PUBLIC_*` or `VITE_*` → flag (client bundle exposure).
- New JWT validation skipping `exp` / `aud` / `iss` checks → flag.
- Missing rate limit on auth endpoint (login, signup, password-reset) → flag.
- Bcrypt cost < 12 / argon2id memory < 64MiB → flag.
- Cache layer caching responses across users without `Vary` / proper key → flag (cross-user data leak).

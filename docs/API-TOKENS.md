# API Token System — Complete Guide

> **TL;DR:** Named API tokens let you authenticate to **every** `/api/v1/*` endpoint and the MCP server using `Authorization: Bearer <token>`. Create, list, roll (rotate), revoke, and delete tokens from **Settings → About** or via the API itself.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Token Format & Security](#2-token-format--security)
3. [Authentication Methods](#3-authentication-methods)
4. [Endpoint Reference](#4-endpoint-reference)
   - [List Tokens](#41-list-tokens)
   - [Create Token](#42-create-token)
   - [Roll Token](#43-roll-token)
   - [Revoke Token](#44-revoke-token)
   - [Delete Token](#45-delete-token)
5. [Complete Workflow Examples](#5-complete-workflow-examples)
   - [Using curl](#51-using-curl)
   - [Using the Web UI](#52-using-the-web-ui)
   - [Using Python](#53-using-python)
   - [Using PowerShell](#54-using-powershell)
6. [MCP Server Access](#6-mcp-server-access)
7. [Audit Trail](#7-audit-trail)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview

The API token system adds **named, revocable, rotatable** bearer tokens that authenticate against the same `requireAuth` middleware as the web UI's JWT cookie. Every existing endpoint — subnets, hosts, compose, domains, users, settings, backups, audit, export/import — works with API tokens automatically. No route-level changes were needed.

**Key differences from the legacy `MCP_TOKEN`:**

| Feature | Legacy `MCP_TOKEN` | API Tokens |
|---------|-------------------|------------|
| Persistence | Env var or ephemeral (lost on restart) | Stored in database |
| Multiple tokens | Single shared secret | Unlimited named tokens |
| Names/labels | None | Descriptive names |
| Revocation | Restart only | Immediate via API or UI |
| Rotation | Change env var + restart | One-click Roll |
| Audit trail | None | Full create/roll/revoke/delete logging |
| Role scoping | None (full access) | Inherits creator's role (`admin`/`editor`/`viewer`) |
| Last-used tracking | None | `last_used_at` timestamp updated on each request |

---

## 2. Token Format & Security

```
Format: smt_<48 hex characters>
Example: smt_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4
Total: 52 characters | Entropy: 192 bits
```

**Security properties:**

- **Salted prefix:** `smt_` makes tokens easily identifiable in logs and configs.
- **192 bits of randomness:** Generated via `crypto.randomBytes(24)` — CSPRNG. Brute-force is infeasible.
- **SHA-256 hashed at rest:** The database stores `SHA-256(raw_token)` — never the raw value. A database breach does not leak usable tokens.
- **Shown only once:** The raw token is returned in the `POST /` and `POST /:id/roll` responses and **never again**. If you lose it, roll the token.
- **Display prefix:** The UI shows only `smt_` + the first 8 hex characters (e.g. `smt_a1b2c3d4...`) — enough to identify a token without exposing it.
- **Immediate revocation:** Revoked tokens return `401` on the very next request. No propagation delay.
- **Role scoping:** The token inherits the role of the user who created it. An admin creating a token gets an admin-scoped token; an editor gets an editor-scoped one. This is determined at creation time and stored in the `role` column — changing the user's role later does not affect existing tokens.

---

## 3. Authentication Methods

The Subnet Manager accepts two authentication methods for API routes:

### Method 1: Cookie JWT (Web UI)

Used by the browser after login. A `token` httpOnly cookie containing a signed JWT.

```http
Cookie: token=eyJhbGciOiJIUzI1NiIs...
```

- Set by `POST /api/v1/auth/login`
- Cleared by `POST /api/v1/auth/logout`
- Expires based on `JWT_EXPIRY` config (default 7 days)
- **Takes priority** when both a cookie and a Bearer header are present

### Method 2: Bearer Token (API)

Used for programmatic access. An `Authorization` header with a static API token.

```http
Authorization: Bearer smt_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4
```

- Requires a token created via `POST /api/v1/tokens` or the Web UI
- Same access as the user who created the token (role is inherited)
- Works on `/api/v1/*` **and** the MCP server (port 3001)

### Middleware Decision Flow

```
Request comes in
│
├─ Cookie "token" present?
│   ├─ Yes → jwt.verify(cookie, JWT_SECRET)
│   │         ├─ Valid → req.user = decoded → next()
│   │         └─ Invalid → clear cookie → 401
│   └─ No → continue
│
├─ Authorization: Bearer <token>?
│   ├─ Yes → SHA-256(token) → db lookup
│   │         ├─ Found & not revoked → update last_used_at → req.user → next()
│   │         ├─ Not found → 401 "Invalid API token"
│   │         └─ Revoked → 401 "API token has been revoked"
│   └─ No → 401 "Not authenticated"
```

---

## 4. Endpoint Reference

All endpoints are under `/api/v1/tokens` and require **admin** role.

### 4.1 List Tokens

```http
GET /api/v1/tokens
Accept: application/json
Authorization: Bearer <token>
```

Lists all tokens without raw values or hashes. The `prefix` field shows the first 12 characters for identification. Tokens are ordered by creation date (most recent first).

**Response 200:**

```json
[
  {
    "id": 1,
    "name": "CI/CD Pipeline",
    "prefix": "smt_a1b2c3d4",
    "role": "admin",
    "created_at": "2026-07-03 12:00:00",
    "last_used_at": "2026-07-03 14:30:00",
    "revoked": 0
  },
  {
    "id": 2,
    "name": "Monitoring",
    "prefix": "smt_9a8b7c6d",
    "role": "editor",
    "created_at": "2026-07-02 09:00:00",
    "last_used_at": null,
    "revoked": 1
  }
]
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique token ID |
| `name` | string | Human-readable name (max 64 chars) |
| `prefix` | string | `smt_` + first 8 hex chars of the raw token |
| `role` | string | `admin`, `editor`, or `viewer` — inherited from creator |
| `created_at` | string | ISO-ish datetime (`YYYY-MM-DD HH:MM:SS`) |
| `last_used_at` | string or null | Last authentication use timestamp |
| `revoked` | integer | `0` = active, `1` = revoked |

---

### 4.2 Create Token

```http
POST /api/v1/tokens
Content-Type: application/json
Authorization: Bearer <token>

{ "name": "CI/CD Pipeline" }
```

Creates a new API token. **The raw `token` field is returned only in this response.** Copy it immediately — it will never be shown again.

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | A descriptive name (1-64 characters) |

**Response 201:**

```json
{
  "id": 1,
  "name": "CI/CD Pipeline",
  "prefix": "smt_a1b2c3d4",
  "role": "admin",
  "created_at": "2026-07-03 12:00:00",
  "revoked": 0,
  "token": "smt_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"
}
```

**Error responses:**

```json
// 400 — Missing name
{ "error": "Token name is required" }
```

**Note:** The token's role is inherited from the creating user at creation time. An admin creating a token gets an admin-scoped token. This is NOT dynamic — changing the user's role later does not affect existing tokens.

---

### 4.3 Roll Token

```http
POST /api/v1/tokens/:id/roll
Content-Type: application/json
Authorization: Bearer <token>
```

Rolls (rotates) a token in a single atomic transaction:
1. Revokes the old token
2. Creates a new token with the **same name** and **same role**
3. Returns the new raw token once

The old token stops working immediately. The new token inherits the same name, role, and user association.

**Response 201:**

```json
{
  "id": 2,
  "name": "CI/CD Pipeline",
  "prefix": "smt_5e6f7a8b",
  "role": "admin",
  "created_at": "2026-07-03 12:30:00",
  "revoked": 0,
  "token": "smt_5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d"
}
```

**Error responses:**

```json
// 404 — Token ID not found
{ "error": "Token not found" }

// 400 — Token is already revoked (can't roll a revoked token)
{ "error": "Cannot roll a revoked token" }
```

---

### 4.4 Revoke Token

```http
POST /api/v1/tokens/:id/revoke
Content-Type: application/json
Authorization: Bearer <token>
```

Soft-revokes a token by setting `revoked = 1`. The token is immediately rejected by `requireAuth`. The database row is preserved for audit purposes.

**Response 200:**

```json
{
  "id": 1,
  "name": "CI/CD Pipeline",
  "prefix": "smt_a1b2c3d4",
  "revoked": 1,
  "ok": true
}
```

**Error responses:**

```json
// 404 — Token ID not found
{ "error": "Token not found" }

// 400 — Token is already revoked
{ "error": "Token is already revoked" }
```

---

### 4.5 Delete Token

```http
DELETE /api/v1/tokens/:id
Authorization: Bearer <token>
```

Permanently removes a token from the database. This is irreversible. Typically used to clean up revoked tokens.

**Response 200:**

```json
{ "ok": true }
```

**Error responses:**

```json
// 404 — Token ID not found
{ "error": "Token not found" }
```

---

## 5. Complete Workflow Examples

### 5.1 Using curl

**Step 1: Log in to get a session cookie**

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}' \
  -c cookies.txt
```

**Step 2: Create a token**

```bash
RESP=$(curl -s -X POST http://localhost:3000/api/v1/tokens \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"name":"My Automation Token"}')

echo "$RESP"
TOKEN=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# Save it securely
echo "$TOKEN" > ~/.subnet-manager-token
chmod 600 ~/.subnet-manager-token
```

**Step 3: Use the token for API calls**

```bash
TOKEN=$(cat ~/.subnet-manager-token)

# List subnets
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/subnets

# List all hosts with status
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/status

# Create a new host
curl -s -X POST http://localhost:3000/api/v1/subnets/1/hosts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"ip":"192.168.1.100","name":"web-server","type":"server","check_port":80}'

# Trigger a status check
curl -s -X POST http://localhost:3000/api/v1/status/check-all \
  -H "Authorization: Bearer $TOKEN"
```

**Step 4: Roll the token (rotate)**

```bash
# Get the token ID
TOKEN_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/tokens | python3 -c \
  "import sys,json;print([t for t in json.load(sys.stdin) if t['name']=='My Automation Token'][0]['id'])")

# Roll it
ROLL_RESP=$(curl -s -X POST "http://localhost:3000/api/v1/tokens/$TOKEN_ID/roll" \
  -H "Content-Type: application/json" \
  -b cookies.txt)

NEW_TOKEN=$(echo "$ROLL_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
echo "$NEW_TOKEN" > ~/.subnet-manager-token
```

**Step 5: Revoke a compromised token**

```bash
curl -s -X POST "http://localhost:3000/api/v1/tokens/$TOKEN_ID/revoke" \
  -H "Content-Type: application/json" \
  -b cookies.txt
```

**Step 6: Delete a revoked token**

```bash
curl -s -X DELETE "http://localhost:3000/api/v1/tokens/$TOKEN_ID" \
  -b cookies.txt
```

---

### 5.2 Using the Web UI

1. Open **Settings** (gear icon in the top-right)
2. Click the **About** tab
3. Scroll to the **API Tokens** section
4. Click **+ Create Token**
5. Enter a name (e.g. `CI/CD Pipeline`) and click **Create Token**
6. **Copy the token immediately** from the modal — it will not be shown again
7. Click **Done** — the token appears in the list with its prefix, role, and status

**Token list features:**
- **Green dot** = active token, **Red dot** = revoked token
- **Last Used** column shows when the token was last authenticated
- **Roll** button: revokes the old token and creates a new one with the same name (new raw token shown once)
- **Revoke** button: immediately invalidates the token (soft-delete, row preserved for audit)
- **Delete** button: permanently removes a revoked token from the database

---

### 5.3 Using Python

```python
import requests

BASE_URL = "http://localhost:3000/api/v1"
TOKEN = "smt_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# List all subnets
resp = requests.get(f"{BASE_URL}/subnets", headers=HEADERS)
subnets = resp.json()
for s in subnets:
    print(f"  #{s['id']} {s['name']} — {s['network']}/{s['cidr']} ({s['hosts_count']} hosts)")

# Create a host
host = {
    "ip": "192.168.1.50",
    "name": "monitoring",
    "type": "container",
    "check_port": 9090,
}
resp = requests.post(f"{BASE_URL}/subnets/1/hosts", json=host, headers=HEADERS)
print(f"Created host: {resp.json()}")

# Trigger a full status check
requests.post(f"{BASE_URL}/status/check-all", headers=HEADERS)
print("Status check triggered")
```

### 5.4 Using PowerShell

```powershell
$token = "smt_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"
$headers = @{ Authorization = "Bearer $token" }
$base = "http://localhost:3000/api/v1"

# List subnets
$subnets = Invoke-RestMethod -Uri "$base/subnets" -Headers $headers
$subnets | Format-Table id, name, network, cidr, hosts_count

# Create a compose project
$body = @{ name = "My App"; content = "version: '3'" } | ConvertTo-Json
$project = Invoke-RestMethod -Uri "$base/compose" -Method Post `
  -Headers ($headers + @{ "Content-Type" = "application/json" }) `
  -Body $body
Write-Output "Created project #$($project.id)"
```

---

## 6. MCP Server Access

API tokens also work on the MCP server (typically port 3001), alongside the legacy `MCP_TOKEN` and OAuth JWTs.

```bash
# API token on MCP health endpoint
curl -s -H "Authorization: Bearer smt_a1b2c3d4..." http://localhost:3001/health

# API token on MCP tool endpoint
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer smt_a1b2c3d4..." \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**MCP auth fallback order:**
1. Static `MCP_TOKEN` (env var or auto-generated)
2. OAuth JWT access token (issued by the MCP server's own OAuth endpoints)
3. Database API token (from the `api_tokens` table)

This means Claude Desktop can use either the legacy `MCP_TOKEN` or a named API token — both work.

---

## 7. Audit Trail

Every token operation is logged to the audit log with full details:

| Action | Target Type | Details |
|--------|-------------|---------|
| `create` | `api_token` | `{ name, prefix }` |
| `roll` | `api_token` | `{ old_id, new_id, name, prefix }` |
| `revoke` | `api_token` | `{ name, prefix }` |
| `delete` | `api_token` | `{ name, prefix }` |

Query the audit log:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v1/audit?action=create&target_type=api_token&limit=10"
```

Response:
```json
{
  "rows": [
    {
      "id": 42,
      "username": "admin",
      "action": "create",
      "target_type": "api_token",
      "target_id": "1",
      "details": "{\"name\":\"CI/CD Pipeline\",\"prefix\":\"smt_a1b2c3d4\"}",
      "created_at": "2026-07-03 12:00:00"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 10
}
```

---

## 8. Troubleshooting

### "Invalid API token"

The token doesn't match any hash in the database. Possible causes:
- The token was typed/pasted incorrectly (check for leading/trailing whitespace)
- The token was rolled and you're using the old one
- The token was created in a different Subnet Manager instance
- The database was replaced or restored from a backup (tokens are tied to the DB)

### "API token has been revoked"

The token was revoked (via UI, API, or rolled). Use the UI or the `POST /:id/roll` endpoint to create a new one.

### "Not authenticated"

No valid cookie or Bearer token was provided. Ensure you're sending:
```
Authorization: Bearer smt_yourtoken...
```
The `Authorization` header must start with `Bearer ` (note the trailing space).

### Token lost after creation

The raw token is shown only once. If you lose it:
1. Go to **Settings → About → API Tokens**
2. Click **Roll** on the token — this revokes the old one and creates a new one with the same name
3. Copy the new token from the modal

### "Cannot roll a revoked token"

Once revoked, a token cannot be rolled. Create a new token with a fresh name instead, then delete the old revoked token.

### "Token name is required"

The `name` field in the request body is empty or missing. Names can be up to 64 characters.

### What happens when the database is moved or restored?

API tokens are stored in the SQLite database. If you move the `.db` file to a new server, all tokens move with it. If you restore from a backup, tokens are restored to the state they had at backup time (active tokens remain active, revoked ones remain revoked).

### What about the legacy MCP_TOKEN?

The legacy `MCP_TOKEN` environment variable continues to work unchanged on the MCP port (3001). It is **not** affected by the new API token system. You can use both side by side.

# REST API Reference

All endpoints are prefixed with `/api/v1`. Authentication uses a JWT token stored in a `token` httpOnly cookie (set by the login endpoint).

**Auth levels:**
- `public` — no authentication required
- `viewer` — any authenticated user
- `editor` — admin or editor role
- `admin` — admin role only

---

## Auth

### POST /api/v1/auth/login
Sign in and receive a session cookie.

**Auth:** public

**Request:**
```json
{ "username": "admin", "password": "mypassword" }
```

**Response:**
```json
{ "ok": true, "user": { "id": 1, "username": "admin", "role": "admin" } }
```

Sets a `token` httpOnly cookie valid for `SESSION_TIMEOUT` seconds.

---

### POST /api/v1/auth/logout
Clear the session cookie.

**Auth:** public

**Response:** `{ "ok": true }`

---

### GET /api/v1/auth/me
Return the currently authenticated user.

**Auth:** viewer

**Response:**
```json
{ "id": 1, "username": "admin", "role": "admin" }
```

Returns `401` if not authenticated.

---

## Setup Wizard

### GET /api/v1/wizard/status
Check whether the setup wizard needs to run.

**Auth:** public

**Response:** `{ "needed": true }` or `{ "needed": false }`

---

### POST /api/v1/wizard/complete
Complete first-time setup. Creates the admin user, first subnet, and marks setup as done.

**Auth:** public (protected by `setup_complete` guard — returns 409 if already done)

**Request:**
```json
{
  "username": "admin",
  "password": "strongpassword",
  "subnet_name": "Home Network",
  "network": "192.168.1.0",
  "cidr": 24,
  "network_mode": "bridge"
}
```

**Response:** `{ "ok": true }` — also sets the JWT cookie (user is logged in immediately).

---

## Subnets

### GET /api/v1/subnets
List all subnets with host counts.

**Auth:** viewer

**Response:**
```json
[
  {
    "id": 1,
    "name": "Home Network",
    "network": "192.168.1.0",
    "cidr": 24,
    "description": "",
    "color": "#3b82f6",
    "display_order": 0,
    "hosts_count": 5,
    "created_at": "2024-01-01 12:00:00"
  }
]
```

---

### POST /api/v1/subnets
Create a new subnet.

**Auth:** editor

**Request:**
```json
{ "name": "Services", "network": "10.10.2.0", "cidr": 24, "description": "App containers", "color": "#22c55e" }
```

**Response:** The created subnet object (201).

---

### PUT /api/v1/subnets/reorder
Update display order for multiple subnets at once.

**Auth:** editor

**Request:**
```json
[{ "id": 1, "display_order": 0 }, { "id": 2, "display_order": 1 }]
```

**Response:** `{ "ok": true }`

---

### PUT /api/v1/subnets/:id
Update a subnet.

**Auth:** editor

**Request:** Any subset of `{ name, network, cidr, description, color }`

**Response:** The updated subnet object.

---

### DELETE /api/v1/subnets/:id
Delete a subnet and all its hosts.

**Auth:** admin

**Response:** `{ "ok": true }`

---

## Hosts

### GET /api/v1/subnets/:subnetId/hosts
List hosts in a subnet, plus the first 50 free IPs.

**Auth:** viewer

**Response:**
```json
{
  "hosts": [
    {
      "id": 1,
      "subnet_id": 1,
      "ip": "192.168.1.10",
      "name": "nginx-proxy",
      "type": "container",
      "last_status": "online",
      "check_port": 80
    }
  ],
  "free_ips": ["192.168.1.2", "192.168.1.3", "..."]
}
```

---

### POST /api/v1/subnets/:subnetId/hosts
Add a host to a subnet.

**Auth:** editor

**Request:**
```json
{
  "ip": "192.168.1.10",
  "name": "nginx-proxy",
  "description": "Reverse proxy",
  "type": "container",
  "check_port": 80,
  "check_enabled": true,
  "notes": "## nginx-proxy\nHandles all inbound HTTP traffic."
}
```

**Response:** The created host object (201). Returns 409 if the IP is already in use, 400 if the IP is outside the subnet range.

---

### PUT /api/v1/hosts/:id
Update a host.

**Auth:** editor

**Request:** Any subset of `{ name, description, notes, type, check_port, check_enabled }`

**Response:** The updated host object.

---

### DELETE /api/v1/hosts/:id
Delete a host.

**Auth:** editor

**Response:** `{ "ok": true }`

---

### POST /api/v1/hosts/:id/check
Trigger an immediate status check for a single host.

**Auth:** viewer

**Response:**
```json
{ "status": "online", "host": { ... } }
```

---

## Status

### GET /api/v1/status
Get all hosts with their current status.

**Auth:** viewer

**Response:** Array of host objects including `subnet_name`.

---

### POST /api/v1/status/check-all
Trigger an immediate full status scan (async).

**Auth:** viewer

**Response:** `{ "queued": true }`

---

### GET /api/v1/status/events
SSE stream for live status updates. Connect with `EventSource`.

**Auth:** viewer

**Events:**
```
event: connected
data: {"ts":1709000000000}

event: status_update
data: {"hostId":1,"ip":"192.168.1.10","status":"offline"}
```

---

## Users

All user endpoints require `admin` role.

### GET /api/v1/users
List all users (without password hashes).

### POST /api/v1/users
Create a user. Body: `{ username, password, role }`. Role: `admin|editor|viewer`.

### PUT /api/v1/users/:id
Update a user. Body: any subset of `{ username, password, role }`.

### DELETE /api/v1/users/:id
Delete a user. Cannot delete yourself or the last admin.

---

## Settings

### GET /api/v1/settings
List all settings. Each row includes `locked: true` if the value is overridden by an env var.

**Auth:** viewer

### GET /api/v1/settings/:key
Get a single setting by key.

**Auth:** viewer

### PUT /api/v1/settings/:key
Update a setting. Returns 403 if the setting is locked by an env var.

**Auth:** admin

**Request:** `{ "value": "newvalue" }`

### PUT /api/v1/settings
Bulk update multiple settings at once.

**Auth:** admin

**Request:** `{ "app_name": "My Lab", "check_interval": "30" }`

---

## Audit Log

### GET /api/v1/audit
Paginated audit log.

**Auth:** admin

**Query params:** `page`, `limit` (max 200), `user`, `action`, `target_type`

**Response:**
```json
{
  "rows": [
    {
      "id": 1,
      "username": "admin",
      "action": "create",
      "target_type": "host",
      "target_id": "5",
      "details": "{\"after\":{...}}",
      "created_at": "2024-01-01 12:05:00"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 50
}
```

---

## Export / Import

### GET /api/v1/export/json
Download all subnets and hosts as a JSON file.

**Auth:** viewer

### GET /api/v1/export/markdown
Download all subnets and hosts as a Markdown table.

**Auth:** viewer

### POST /api/v1/import/json
Bulk import subnets and hosts from a JSON export.

**Auth:** admin

**Request:** The JSON object produced by `GET /api/v1/export/json`.

**Response:** `{ "ok": true, "imported": { "subnets": 3, "hosts": 12 } }`

Uses `INSERT OR IGNORE` — existing records (same network+cidr or same IP) are skipped.

---

## API Tokens

Manage API tokens for programmatic access. All endpoints require `admin` role.

Tokens use the format `smt_` + 48 hex characters (52 chars total, 192 bits entropy). Only the SHA-256 hash is stored in the database — the raw token is shown **only once** at creation time.

See [API-TOKENS.md](API-TOKENS.md) for a complete guide with workflow examples.

### GET /api/v1/tokens
List all API tokens (without the raw token values).

**Auth:** admin

**Response:**
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
  }
]
```

### POST /api/v1/tokens
Create a new API token. The raw token is returned **only once** — copy it immediately.

**Auth:** admin

**Request:**
```json
{ "name": "CI/CD Pipeline" }
```

**Response (201):**
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

### POST /api/v1/tokens/:id/roll
Roll (rotate) a token. Revokes the old token and creates a new one with the same name. Returns the new raw token once.

**Auth:** admin

**Response (201):**
```json
{
  "id": 2,
  "name": "CI/CD Pipeline",
  "prefix": "smt_9a8b7c6d",
  "role": "admin",
  "created_at": "2026-07-03 12:30:00",
  "revoked": 0,
  "token": "smt_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5"
}
```

### POST /api/v1/tokens/:id/revoke
Revoke a token immediately. It stops working from the moment this request completes.

**Auth:** admin

**Response:**
```json
{ "id": 1, "name": "CI/CD Pipeline", "prefix": "smt_a1b2c3d4", "revoked": 1, "ok": true }
```

### DELETE /api/v1/tokens/:id
Permanently delete a revoked token. Irreversible.

**Auth:** admin

**Response:** `{ "ok": true }`

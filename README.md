# Subnet Manager

**Self-hosted subnet & IP management dashboard with built-in MCP server.**

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-20%2B-green)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue)](docker-compose.yml)

Subnet Manager is a clean, self-hosted dashboard for tracking IP address allocations and container assignments across your home network or homelab. It shows live online/offline status for every host, lets you add notes and descriptions, and exposes a built-in MCP server so Claude can query and manage your network directly.

## Features

- **Card-based dashboard** — subnet cards with host rows, status dots, and free-IP quick-add
- **Live status** — TCP port or ICMP ping checks; colored dots update in real time via SSE
- **Dark mode by default** — clean dark UI, light mode toggle saved to localStorage
- **Setup wizard** — first-launch flow to configure your network and admin account
- **User roles** — admin / editor / viewer access control
- **Audit log** — every create/update/delete is recorded with user and timestamp
- **Export & import** — JSON and Markdown export; bulk JSON import
- **Built-in MCP server** — 14 tools for Claude.ai integration on port 3001
- **HTTPS** — off / self-signed / custom certificate modes
- **Docker** — single container, SQLite DB in a volume-mounted `data/` directory

## Screenshots

![Dashboard](docs/screenshots/dashboard.png)

_Screenshots can be added to `docs/screenshots/` — see [docs/README.md](docs/README.md)._

## Quick Start

1. Clone the repo:
   ```sh
   git clone https://github.com/YOUR_USERNAME/subnet-manager
   cd subnet-manager
   ```

2. Copy the example env file and set `JWT_SECRET`:
   ```sh
   cp .env.example .env
   # Edit .env — generate a secret with:
   # node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

3. Start with Docker:
   ```sh
   docker compose -f docker-compose.build.yml up -d   # build locally
   # or, after publishing to GHCR:
   docker compose up -d                                # pull image
   ```

4. Open [http://localhost:3000](http://localhost:3000) and complete the setup wizard.

## MCP Integration

The built-in MCP server runs on port **3001** using Streamable HTTP transport.

Add to your Claude Desktop config:
```json
{
  "mcpServers": {
    "subnet-manager": {
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

Find your token in **Settings → About** in the web UI. See [docs/MCP.md](docs/MCP.md) for the full tool reference.

## Deployment

| Method | File | Description |
|--------|------|-------------|
| Pull from GHCR | [docker-compose.yml](docker-compose.yml) | `ghcr.io/the12forest/subnet-manager:latest` |
| Build locally | [docker-compose.build.yml](docker-compose.build.yml) | Builds from source |

See [docs/SETUP.md](docs/SETUP.md) for HTTPS setup, reverse proxy examples (Nginx/Traefik/Caddy), and GHCR publishing.

## Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `JWT_SECRET` | *(required)* | Long random string |
| `MCP_TOKEN` | *(auto-generated)* | Check logs on first start |
| `PORT` | `3000` | Web UI port |
| `MCP_PORT` | `3001` | MCP server port |
| `HTTPS_MODE` | `off` | `off` / `self-signed` / `custom` |
| `CHECK_INTERVAL` | `60` | Seconds between status checks |

Full table in [docs/SETUP.md](docs/SETUP.md#environment-variables).

## Documentation

| File | Contents |
|------|----------|
| [docs/SETUP.md](docs/SETUP.md) | Docker, env vars, HTTPS, GHCR publishing |
| [docs/API.md](docs/API.md) | All REST endpoints with examples |
| [docs/API-TOKENS.md](docs/API-TOKENS.md) | API token system — create, roll, revoke, and use programmatic tokens |
| [docs/MCP.md](docs/MCP.md) | MCP connection guide and tool reference |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local dev, DB reset, adding settings |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component and module diagram |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — plain JS only, no TypeScript or build step.

## License

[CC BY-NC-SA 4.0](LICENSE) — free for personal and non-commercial use. Modifications must be shared under the same license.

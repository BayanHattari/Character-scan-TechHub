# Memorial Wall Kiosk

Visitors draw on a kiosk; their captures appear live on a wall display in the same room.

The whole stack runs on the **local LAN** — no internet, no cloud. The kiosk PC runs the server and the kiosk-app; the wall-display PC is on the same Wi-Fi/LAN and points at the kiosk PC.

## Layout

- `server/` — Express + SQLite + sharp. Stores photos on disk, broadcasts new uploads via SSE.
- `kiosk-app/` — React/Vite. The capture UI on the kiosk PC.
- `wall-display/` — React/Vite. The grid view on the second screen.
- `air-canvas/` — standalone gesture-drawing demo (HTML/JS).

## Setup

### 1. Kiosk PC (runs the server + the kiosk-app)

```bash
cd server
npm install
cp .env.example .env       # tweak ADMIN_KEY / MAX_PHOTOS if needed
npm start                  # prints LAN URLs — copy one for step 2
```

In a second terminal:

```bash
cd kiosk-app
npm install
cp .env.example .env       # default points at http://localhost:3000
npm run build && npm run preview -- --host
```

### 2. Wall-display PC (separate machine on the same LAN)

```bash
cd wall-display
npm install
cp .env.example .env
# edit .env: set VITE_API_BASE=http://<kiosk-pc-ip>:3000  (the URL the server printed)
npm run build && npm run preview -- --host
```

Open the printed `Network:` URL on the wall display in fullscreen.

## Notes

- Photos are saved to `server/photos/` and metadata to `server/data/photos.db`. Both are gitignored.
- The kiosk PC's firewall must allow inbound TCP on the server port (default `3000`).
- Admin mode on the wall-display: press `Shift+D` to toggle, then double-click a photo to delete. The admin key is set in `server/.env`.
- Oldest photos (file + DB row) are pruned automatically once `MAX_PHOTOS` is exceeded.

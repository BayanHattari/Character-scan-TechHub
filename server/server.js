// Memorial Wall Backend — local-only (LAN)
// Photos saved to disk, metadata in SQLite. No third-party services.

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const Database = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "TechHub-Admin-2026";
const MAX_PHOTOS = parseInt(process.env.MAX_PHOTOS || "10000", 10);
const PHOTOS_DIR = path.resolve(process.env.PHOTOS_DIR || path.join(__dirname, "photos"));
const THUMBS_DIR = path.join(PHOTOS_DIR, "thumbs");
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, "data", "photos.db"));

fs.mkdirSync(PHOTOS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    thumb_filename TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_photos_created_at ON photos(created_at DESC);
`);

const insertPhoto = db.prepare(
  `INSERT INTO photos (id, filename, thumb_filename, created_at) VALUES (?, ?, ?, ?)`
);
const selectPhotos = db.prepare(
  `SELECT id, filename, thumb_filename AS thumbFilename, created_at AS createdAt
   FROM photos ORDER BY created_at DESC LIMIT ?`
);
const selectPhotoById = db.prepare(`SELECT * FROM photos WHERE id = ?`);
const deletePhotoById = db.prepare(`DELETE FROM photos WHERE id = ?`);
const selectOldestBeyond = db.prepare(
  `SELECT id, filename, thumb_filename AS thumbFilename
   FROM photos ORDER BY created_at DESC LIMIT -1 OFFSET ?`
);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only images (jpeg/png/webp) are allowed"));
    }
    cb(null, true);
  },
});

const sseClients = new Set();
function sseSend(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}
function toPhotoDto(req, row) {
  return {
    id: row.id,
    url: `${baseUrl(req)}/photos/${row.filename}`,
    thumbnailUrl: `${baseUrl(req)}/photos/thumbs/${row.thumbFilename}`,
    createdAt: row.createdAt,
  };
}

function safeUnlink(p) {
  fs.promises.unlink(p).catch(() => {});
}

function enforceMaxPhotos() {
  const extras = selectOldestBeyond.all(MAX_PHOTOS);
  for (const row of extras) {
    safeUnlink(path.join(PHOTOS_DIR, row.filename));
    safeUnlink(path.join(THUMBS_DIR, row.thumbFilename));
    deletePhotoById.run(row.id);
  }
}

app.get("/", (_req, res) => res.send("Backend is running"));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  req.on("close", () => sseClients.delete(res));
});

app.get("/photos", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "800", 10), 2000);
    const rows = selectPhotos.all(limit);
    res.json(rows.map((r) => toPhotoDto(req, r)));
  } catch (err) {
    res.status(500).json({ message: "DB error", error: err.message });
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const filename = `${id}.png`;
    const thumbFilename = `${id}.jpg`;

    const fullPath = path.join(PHOTOS_DIR, filename);
    const thumbPath = path.join(THUMBS_DIR, thumbFilename);

    await sharp(req.file.buffer).png().toFile(fullPath);
    await sharp(req.file.buffer)
      .resize(250, 250, { fit: "cover", position: "attention" })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);

    insertPhoto.run(id, filename, thumbFilename, createdAt);

    try { enforceMaxPhotos(); } catch {}

    const photo = toPhotoDto(req, { id, filename, thumbFilename, createdAt });
    sseSend({ type: "photo_uploaded", photo });
    res.json({ message: "Uploaded successfully", photo });
  } catch (err) {
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

app.delete("/photos/:id", (req, res) => {
  try {
    if (req.headers["x-admin-key"] !== ADMIN_KEY) {
      return res.status(403).json({ message: "Forbidden (Admin only)" });
    }
    const row = selectPhotoById.get(req.params.id);
    if (!row) return res.status(404).json({ message: "Photo not found" });

    safeUnlink(path.join(PHOTOS_DIR, row.filename));
    safeUnlink(path.join(THUMBS_DIR, row.thumb_filename));
    deletePhotoById.run(row.id);

    sseSend({ type: "photo_deleted", id: row.id });
    res.json({ message: "Photo deleted successfully", id: row.id });
  } catch (err) {
    res.status(500).json({ message: "Delete failed", error: err.message });
  }
});

// Static must come AFTER the JSON routes so /photos and /photos/:id hit the API.
app.use("/photos", express.static(PHOTOS_DIR, { fallthrough: false, maxAge: "1y" }));

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        out.push(`http://${iface.address}:${PORT}`);
      }
    }
  }
  return out;
}

app.listen(PORT, HOST, () => {
  console.log(`Memorial Wall server listening on ${HOST}:${PORT}`);
  console.log(`  local:   http://localhost:${PORT}`);
  for (const addr of lanAddresses()) console.log(`  LAN:     ${addr}`);
  console.log(`  photos:  ${PHOTOS_DIR}`);
  console.log(`  db:      ${DB_PATH}`);
});

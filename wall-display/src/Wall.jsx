import React, { useState, useEffect,useRef } from 'react';

import './Wall.css';

// Discrete photo widths (in px). Picking the largest size that still fits
// every photo on screen keeps changes infrequent and avoids constant reshuffles
// from one-off count changes.
const PHOTO_WIDTHS = [600, 400, 300, 200, 180, 160, 140, 120, 100, 85, 72]
const PHOTO_ASPECT = 4 / 3 // height / width
const GAP = 7

function computeLayout(count) {
  for (const w of PHOTO_WIDTHS) {
    const h = Math.round(w * PHOTO_ASPECT)
    const cols = Math.max(1, Math.floor(window.innerWidth / (w + GAP)))
    const rows = Math.max(1, Math.floor(window.innerHeight / (h + GAP)))
    if (cols * rows >= count) return { w, h, cols, rows }
  }
  const w = PHOTO_WIDTHS[PHOTO_WIDTHS.length - 1]
  const h = Math.round(w * PHOTO_ASPECT)
  const cols = Math.max(1, Math.floor(window.innerWidth / (w + GAP)))
  const rows = Math.max(1, Math.floor(window.innerHeight / (h + GAP)))
  return { w, h, cols, rows }
}

function Wall() {
  const [photos, setPhotos] = useState([]);
  const [photoSize, setPhotoSize] = useState({ w: 120, h: 160 });
  const photoSizeRef = useRef({ w: 120, h: 160 });
  const positionsRef = useRef({})
  const [adminMode, setAdminMode] = useState(false)
  const containerRef = useRef(null)
  // Backend server endpoint provided by the team
  const API_URL = `${import.meta.env.VITE_API_BASE}/photos`;

  // Function to fetch visitor photos from the server
const fetchPhotos = async () => {
  try {
    const response = await fetch(`${API_URL}?t=${Date.now()}`, {
  cache: "no-store",
});
    if (response.ok) {
      const data = await response.json()

      const layout = computeLayout(Math.max(1, data.length))
      const photoWidth = layout.w
      const photoHeight = layout.h
      const cols = layout.cols
      const rows = layout.rows

      if (photoWidth !== photoSizeRef.current.w) {
        photoSizeRef.current = { w: photoWidth, h: photoHeight }
        positionsRef.current = {}
        setPhotoSize({ w: photoWidth, h: photoHeight })
      }

      const offsetX = Math.max(0, (window.innerWidth - cols * (photoWidth + GAP) + GAP) / 2)
      const offsetY = Math.max(0, (window.innerHeight - rows * (photoHeight + GAP) + GAP) / 2)

      const slots = []
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          slots.push({
            left: offsetX + col * (photoWidth + GAP),
            top: offsetY + row * (photoHeight + GAP),
          })
        }
      }

      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[slots[i], slots[j]] = [slots[j], slots[i]]
      }

      const currentIds = new Set(data.map(photo => String(photo.id)))
      Object.keys(positionsRef.current).forEach((id) => {
        if (!currentIds.has(id)) {
          delete positionsRef.current[id]
        }
      })

      let slotIndex = 0

      const photosWithPositions = data.map((photo) => {
        if (!positionsRef.current[photo.id]) {
          const slot = slots[slotIndex % slots.length]
          positionsRef.current[photo.id] = slot
          slotIndex++
        }

        return {
          ...photo,
          ...positionsRef.current[photo.id],
        }
      })

      setPhotos(photosWithPositions)
    }
  } catch (error) {
    console.error("Error fetching photos:", error)
  }
};
const deletePhoto = async (id) => {
  try {
    const response = await fetch(`${import.meta.env.VITE_API_BASE}/photos/${id}`, {
      method: "DELETE",
      headers: {
        "x-admin-key": "TechHub-Admin-2026"
      }
    })

    const data = await response.json()
    console.log("Delete response:", data)

    if (!response.ok) {
      throw new Error(data.message || "Delete failed")
    }

    setPhotos(prev => prev.filter(p => p.id !== id))
    delete positionsRef.current[id]

  } catch (err) {
    console.error("Delete error:", err)
    alert("Failed to delete photo")
  }
}

  useEffect(() => {
    fetchPhotos();
    // Auto-refresh the wall every 5 seconds to load new visitors
    const interval = setInterval(fetchPhotos, 5000); 
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
  const handleResize = () => {
    positionsRef.current = {};
    fetchPhotos();
  };

  window.addEventListener("resize", handleResize);
  return () => window.removeEventListener("resize", handleResize);
}, []);
  useEffect(() => {
  const handleKeyDown = (e) => {
    if (e.shiftKey && e.key.toLowerCase() === "d") {
      setAdminMode(prev => !prev)
    }
  }

  window.addEventListener("keydown", handleKeyDown)
  return () => window.removeEventListener("keydown", handleKeyDown)
}, [])

  return (
    <div
    ref={containerRef}
  className="wall-container"
  style={{ cursor: adminMode ? "default" : "none" }}
>
      {/* Static photo grid that expands automatically with new content */}
<div className="photo-grid">
  {photos.map((photo) => (
<img
  key={photo.id}
  src={`${photo.url}?v=${photo.createdAt || photo.id || Date.now()}`}
  className="visitor-photo"
  alt="Visitor"
  style={{
    left: `${photo.left}px`,
    top: `${photo.top}px`,
    width: `${photoSize.w}px`,
    height: `${photoSize.h}px`,
  }}
  onDoubleClick={() => {
  if (adminMode) deletePhoto(photo.id)
}}
/>
  ))}
</div>

      {/* Main Techub logo centered on the screen */}
      <img 
        src="https://i.postimg.cc/Fsz36s0G/f2e875cb-e556-4f1b-9c06-372df59f83b5.png" 
        className="logo-overlay" 
        alt="Techub Logo" 
      />
    </div>
  );
}

export default Wall;

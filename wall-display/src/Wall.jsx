import React, { useState, useEffect,useRef } from 'react';

import './Wall.css';

function Wall() {
  const [photos, setPhotos] = useState([]);
  const positionsRef = useRef({})
  const [adminMode, setAdminMode] = useState(false)
  const containerRef = useRef(null)
  // Backend server endpoint provided by the team
  const API_URL = "https://memorial-wall-backend.onrender.com/photos"; 

  // Function to fetch visitor photos from the server
const fetchPhotos = async () => {
  try {
    const response = await fetch(`${API_URL}?t=${Date.now()}`, {
  cache: "no-store",
});
    if (response.ok) {
      const data = await response.json()

      const photoWidth = 120
      const photoHeight = 160
      const gapX = 7
      const gapY = 7

      const cols = Math.max(1, Math.floor(window.innerWidth / (photoWidth + gapX)))
      const rows = Math.max(1, Math.floor(window.innerHeight / (photoHeight + gapY)))

      const slots = []
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const baseLeft = col * (photoWidth + gapX)
          const baseTop = row * (photoHeight + gapY)

          slots.push({
            left: baseLeft ,
            top: baseTop ,
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
    const response = await fetch(`https://memorial-wall-backend.onrender.com/photos/${id}`, {
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
    const interval = setInterval(fetchPhotos, 500); 
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

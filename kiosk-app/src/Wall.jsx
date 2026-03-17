import React, { useState, useEffect, useRef } from 'react'
import './Wall.css'

function App() {
  const [photos, setPhotos] = useState([])
 
  const containerRef = useRef(null)
  const [adminMode, setAdminMode] = useState(false)

  const API_URL = "https://memorial-wall-backend.onrender.com/photos"

const PHOTO_WIDTH = 180
const PHOTO_HEIGHT = 110
const GAP_X = 6
const GAP_Y = 6

const positionsRef = useRef({})
const slotOrderRef = useRef([])
const layoutKeyRef = useRef("")

const fetchPhotos = async () => {
  try {
    const response = await fetch(API_URL)
    if (!response.ok) return

    const data = await response.json()

    const cols = Math.max(1, Math.floor(window.innerWidth / (PHOTO_WIDTH + GAP_X)))
    const visibleRows = Math.max(
      1,
      Math.floor(window.innerHeight / (PHOTO_HEIGHT + GAP_Y))
    )
    const visibleCapacity = cols * visibleRows

    // Keep everything inside the first screen until it is actually full
    const totalRows =
      data.length <= visibleCapacity
        ? visibleRows
        : Math.max(visibleRows, Math.ceil((data.length * 1.2) / cols))

    const gridWidth = cols * (PHOTO_WIDTH + GAP_X) - GAP_X
    const offsetX = Math.max(0, (window.innerWidth - gridWidth) / 2)

    const slots = []
    for (let row = 0; row < totalRows; row++) {
      for (let col = 0; col < cols; col++) {
        slots.push({
          left: offsetX + col * (PHOTO_WIDTH + GAP_X),
          top: row * (PHOTO_HEIGHT + GAP_Y),
        })
      }
    }

    const layoutKey = `${cols}-${visibleRows}-${window.innerWidth}-${window.innerHeight}`

    if (layoutKeyRef.current !== layoutKey) {
      layoutKeyRef.current = layoutKey

      const allIndices = [...Array(slots.length).keys()]
      const firstScreenIndices = allIndices.slice(0, visibleCapacity)
      const extraIndices = allIndices.slice(visibleCapacity)

      // shuffle helper
      const shuffle = (arr) => {
        const copy = [...arr]
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[copy[i], copy[j]] = [copy[j], copy[i]]
        }
        return copy
      }

      // Fill visible area first, then use lower rows
      slotOrderRef.current = [
        ...shuffle(firstScreenIndices),
        ...shuffle(extraIndices),
      ]

      positionsRef.current = {}
    }

    const currentIds = new Set(data.map((p) => String(p.id)))

    Object.keys(positionsRef.current).forEach((id) => {
      if (!currentIds.has(String(id))) {
        delete positionsRef.current[id]
      }
    })

    const assignedSlots = new Set(Object.values(positionsRef.current))

    const photosWithPositions = data.map((photo, index) => {
      if (positionsRef.current[photo.id] == null) {
        const nextFree = slotOrderRef.current.find(
          (slotIndex) => !assignedSlots.has(slotIndex)
        )

        positionsRef.current[photo.id] = nextFree ?? index
        assignedSlots.add(positionsRef.current[photo.id])
      }

      const slot = slots[positionsRef.current[photo.id]] || slots[index]

      return {
        ...photo,
        left: slot.left,
        top: slot.top,
      }
    })

    setPhotos(photosWithPositions)
  } catch (error) {
    console.error("Error fetching photos:", error)
  }
}

  const deletePhoto = async (id) => {
    try {
      const response = await fetch(
        `https://memorial-wall-backend.onrender.com/photos/${id}`,
        {
          method: "DELETE",
          headers: {
            "x-admin-key": "TechHub-Admin-2026",
          },
        }
      )

      const data = await response.json()
      console.log("Delete response:", data)

      if (!response.ok) {
        throw new Error(data.message || "Delete failed")
      }

      setPhotos((prev) => prev.filter((p) => p.id !== id))
     
    } catch (err) {
      console.error("Delete error:", err)
      alert("Failed to delete photo")
    }
  }

  useEffect(() => {
    fetchPhotos()

    const interval = setInterval(fetchPhotos, 5000)
    window.addEventListener("resize", fetchPhotos)

    return () => {
      clearInterval(interval)
      window.removeEventListener("resize", fetchPhotos)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.shiftKey && e.key.toLowerCase() === "d") {
        setAdminMode((prev) => !prev)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

useEffect(() => {
  const el = containerRef.current
  if (!el) return

  const maxPhotoBottom = photos.length
    ? Math.max(...photos.map((photo) => photo.top + PHOTO_HEIGHT))
    : 0

  if (maxPhotoBottom <= el.clientHeight - 10) {
    el.scrollTop = 0
    return
  }

  let direction = 1

  const interval = setInterval(() => {
    if (!el) return
    if (el.scrollHeight <= el.clientHeight) return

    el.scrollTop += direction * 0.5

    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
      direction = -1
    } else if (el.scrollTop <= 0) {
      direction = 1
    }
  }, 30)

  return () => clearInterval(interval)
}, [photos])

const cols = Math.max(
  1,
  Math.floor(window.innerWidth / (PHOTO_WIDTH + GAP_X))
)

const maxPhotoBottom = photos.length
  ? Math.max(...photos.map((photo) => photo.top + PHOTO_HEIGHT))
  : 0

const wallHeight = Math.max(window.innerHeight, maxPhotoBottom + GAP_Y + 40)

  return (
    <div
      ref={containerRef}
      className="wall-container"
      style={{ cursor: adminMode ? "default" : "none" }}
    >
      <div
        className="photo-grid"
        style={{
          height: `${wallHeight}px`,
        }}
      >
{photos.map((photo) => (
  <img
    key={photo.id}
    src={photo.url}
    loading="lazy"
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

      <img
        src="https://i.postimg.cc/Fsz36s0G/f2e875cb-e556-4f1b-9c06-372df59f83b5.png"
        className="logo-overlay"
        alt="Techub Logo"
      />
    </div>
  )
}

export default App
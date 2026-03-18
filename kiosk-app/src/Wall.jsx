import React, { useState, useEffect, useRef, useCallback } from 'react'
import './Wall.css'


function shuffle(array) {
  const arr = [...array]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function getUniqueRandomItems(source, count, excludedIds = []) {
  const excluded = new Set(excludedIds)
  const uniquePool = source.filter((item) => !excluded.has(item.id))

  const shuffled = shuffle(uniquePool)
  return shuffled.slice(0, count).map((photo, i) => ({
    ...photo,
    duplicateKey: `fill-${photo.id}-${i}-${Math.random().toString(36).slice(2, 8)}`,
  }))
}

function Wall() {
  const [isFading, setIsFading] = useState(false)
  const [displayPhotos, setDisplayPhotos] = useState([])
  const [adminMode, setAdminMode] = useState(false)
  const [currentPage, setCurrentPage] = useState(0)
  const lastPhotoCountRef = useRef(0)
  const containerRef = useRef(null)



  const allPagesRef = useRef([])
  const totalPagesRef = useRef(1)

  const API_URL = 'https://memorial-wall-backend.onrender.com/photos'

const SLOT_WIDTH = 180
const SLOT_HEIGHT = 110
const GAP_X = 7
const GAP_Y = 7

const [photoWidth, setPhotoWidth] = useState(() => Number(localStorage.getItem('wallPhotoWidth')) || 180)
const [photoHeight, setPhotoHeight] = useState(() => Number(localStorage.getItem('wallPhotoHeight')) || 110)

const [inputWidth, setInputWidth] = useState(() => Number(localStorage.getItem('wallPhotoWidth')) || 180)
const [inputHeight, setInputHeight] = useState(() => Number(localStorage.getItem('wallPhotoHeight')) || 110)

const buildPages = useCallback((data) => {
  const containerWidth = containerRef.current?.clientWidth || window.innerWidth
  const containerHeight = containerRef.current?.clientHeight || window.innerHeight

const cols = Math.max(1, Math.floor(containerWidth / (SLOT_WIDTH + GAP_X)))
const rows = Math.max(1, Math.floor(containerHeight / (SLOT_HEIGHT + GAP_Y)))

const slotsPerPage = cols * rows
const gridWidth = cols * (SLOT_WIDTH + GAP_X) - GAP_X
const gridHeight = rows * (SLOT_HEIGHT + GAP_Y) - GAP_Y

  const offsetX = Math.max(0, (containerWidth - gridWidth) / 2)
  const offsetY = Math.max(0, (containerHeight - gridHeight) / 2)

  const slots = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      slots.push({
left: offsetX + col * (SLOT_WIDTH + GAP_X),
top: offsetY + row * (SLOT_HEIGHT + GAP_Y),
      })
    }
  }


  if (data.length === 0) {
    allPagesRef.current = [[]]
    totalPagesRef.current = 1
    setDisplayPhotos([])
    return
  }

  const realPages = []
  for (let i = 0; i < data.length; i += slotsPerPage) {
    realPages.push(data.slice(i, i + slotsPerPage))
  }

  const builtPages = realPages.map((pagePhotos, pageIndex) => {
    let finalPhotos = [...pagePhotos]

    // Page 1: do NOT fill empty slots
    // Page 2 and above: fill from all existing photos, but no duplicates in same page
    if (pageIndex > 0 && finalPhotos.length < slotsPerPage) {
      const needed = slotsPerPage - finalPhotos.length

      const usedIds = new Set(finalPhotos.map((p) => p.id))

      const availableFillers = shuffle(
        data.filter((photo) => !usedIds.has(photo.id))
      ).slice(0, needed)

      finalPhotos = [...finalPhotos, ...availableFillers]
    }

    const shuffledSlots = shuffle(slots)
    const shuffledPhotos = shuffle(finalPhotos)

    return shuffledPhotos.map((photo, index) => ({
      ...photo,
      renderKey: `page-${pageIndex}-photo-${photo.id}-${index}`,
      left: shuffledSlots[index]?.left ?? 0,
      top: shuffledSlots[index]?.top ?? 0,
    }))
  })

  allPagesRef.current = builtPages
  totalPagesRef.current = builtPages.length

  const safePage = Math.min(currentPage, builtPages.length - 1)
  setCurrentPage(safePage)
  setDisplayPhotos(builtPages[safePage] || [])
}, [currentPage, photoWidth, photoHeight])

const fetchPhotos = useCallback(async () => {
  try {
    const response = await fetch(API_URL, {
      cache: 'no-store',
    })

    if (!response.ok) return

    const data = await response.json()

    // rebuild only if photo count changed
    if (data.length !== lastPhotoCountRef.current) {
      lastPhotoCountRef.current = data.length
      buildPages(data)
    }
  } catch (error) {
    console.error('Error fetching photos:', error)
  }
}, [buildPages])

  const deletePhoto = async (id) => {
    try {
      const response = await fetch(`${API_URL}/${id}`, {
        method: 'DELETE',
        headers: {
          'x-admin-key': 'TechHub-Admin-2026',
        },
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.message || 'Delete failed')
      }

      fetchPhotos()
    } catch (err) {
      console.error('Delete error:', err)
      alert('Failed to delete photo')
    }
  }
  useEffect(() => {
  fetchPhotos()
  const interval = setInterval(fetchPhotos, 30000)
  return () => clearInterval(interval)
}, [fetchPhotos])

useEffect(() => {
  const interval = setInterval(() => {
    const total = totalPagesRef.current || 1
    if (total <= 1) return

    setIsFading(true)

    setTimeout(() => {
      setCurrentPage((prev) => {
        const next = (prev + 1) % total
        setDisplayPhotos(allPagesRef.current[next] || [])
        return next
      })

      setIsFading(false)
    }, 500) // fade-out time
  }, 30000)

  return () => clearInterval(interval)
}, [])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.shiftKey && e.key.toLowerCase() === 'd') {
        setAdminMode((prev) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

useEffect(() => {
  fetchPhotos()
}, [photoWidth, photoHeight, fetchPhotos])

useEffect(() => {
  localStorage.setItem('wallPhotoWidth', String(photoWidth))
  localStorage.setItem('wallPhotoHeight', String(photoHeight))
}, [photoWidth, photoHeight])



return (
  <div
    ref={containerRef}
    className="wall-container"
    style={{ cursor: adminMode ? 'default' : 'none' }}
  >
    
    <div
  className="photo-grid"
  style={{
    opacity: isFading ? 0 : 1,
    transition: 'opacity 0.5s ease-in-out',
  }}
>
  
      {displayPhotos.map((photo) => (
<img
  key={photo.renderKey}
  src={photo.url}
  className="visitor-photo"
  alt="Visitor"
  style={{
    left: `${photo.left + (SLOT_WIDTH - photoWidth) / 2}px`,
    top: `${photo.top + (SLOT_HEIGHT - photoHeight) / 2}px`,
    width: `${photoWidth}px`,
    height: `${photoHeight}px`,
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
  alt="TechHub Logo"
/>

{adminMode && (
  <div
    style={{
      position: 'fixed',
      top: '20px',
      right: '20px',
      zIndex: 9999,
      background: 'rgba(0,0,0,0.85)',
      padding: '12px 14px',
      borderRadius: '12px',
      display: 'flex',
      gap: '10px',
      alignItems: 'center',
      color: 'white',
    }}
  >
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      Width:
      <input
        type="number"
        value={inputWidth}
        min="60"
        max="500"
        onChange={(e) => setInputWidth(Number(e.target.value) || 60)}
        style={{
          width: '80px',
          padding: '4px 6px',
          borderRadius: '6px',
          border: '1px solid #ccc',
        }}
      />
    </label>

    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      Height:
      <input
        type="number"
        value={inputHeight}
        min="60"
        max="500"
        onChange={(e) => setInputHeight(Number(e.target.value) || 60)}
        style={{
          width: '80px',
          padding: '4px 6px',
          borderRadius: '6px',
          border: '1px solid #ccc',
        }}
      />
    </label>

    <button
      onClick={() => {
        setPhotoWidth(inputWidth)
        setPhotoHeight(inputHeight)
      }}
      style={{
        padding: '6px 10px',
        borderRadius: '8px',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      Apply
    </button>

    <button
      onClick={() => {
        setInputWidth(180)
        setInputHeight(100)
        setPhotoWidth(180)
        setPhotoHeight(100)
      }}
      style={{
        padding: '6px 10px',
        borderRadius: '8px',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      Reset
    </button>
  </div>
)}

  </div>
  
  
)
}

export default Wall
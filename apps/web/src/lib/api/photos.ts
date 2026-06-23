// Photos / memories domain — client slice, types, and hooks. Matches the Photos
// mocks (family wall → screensaver, "NEW MEMORY · Lake Day" banner, add-photos,
// photo detail). Mirrors goals.ts.
//
// A photo is EITHER an image URL OR an emoji + color tile (no blob storage yet),
// so the UI renders <img> when imageUrl is set, else an emoji-on-gradient tile.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

export interface PhotoPerson {
  personId: string
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
}

export interface Photo {
  id: string
  imageUrl: string | null
  caption: string
  emoji: string | null
  colorHex: string | null
  memory: string | null
  takenAt: string | null
  isFavorite: boolean
  reactions: Record<string, number>
  uploadedBy: PhotoPerson | null
  createdAt: string
}

// What the add-photo flows send. A photo is an uploaded blob (storageKey, resolved to
// imageUrl server-side), a direct image URL, or an emoji + color tile.
export interface PhotoWriteInput {
  caption?: string
  emoji?: string | null
  colorHex?: string | null
  imageUrl?: string | null
  storageKey?: string | null
  memory?: string | null
  takenAt?: string | null
  [key: string]: unknown
}

export const photosApi = {
  photos: (memory?: string | null) =>
    apiGet<{ photos: Photo[] }>(memory ? `/api/photos?memory=${encodeURIComponent(memory)}` : '/api/photos'),
  photo: (id: string) => apiGet<{ photo: Photo }>(`/api/photos/${id}`),
  createPhoto: (input: PhotoWriteInput) => apiSend<{ photo: { id: string } }>('POST', '/api/photos', input),
  deletePhoto: (id: string) => apiDelete(`/api/photos/${id}`),
}

export interface PhotosState {
  photos: Photo[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function usePhotos(memory?: string | null): PhotosState {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    photosApi
      .photos(memory)
      .then((d) => alive && (setPhotos(d.photos), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [memory, nonce])
  return { photos, loading, error, refetch: () => setNonce((n) => n + 1) }
}

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
  isFavorite?: boolean
  takenAt?: string | null
  [key: string]: unknown
}

// What the photo-detail edit flow sends — a partial update of the editable fields.
// A blank caption is rejected server-side (400), so callers keep a non-empty caption.
export interface PhotoPatchInput {
  caption?: string
  memory?: string | null
  isFavorite?: boolean
  takenAt?: string | null
}

export const photosApi = {
  photos: (memory?: string | null) =>
    apiGet<{ photos: Photo[] }>(memory ? `/api/photos?memory=${encodeURIComponent(memory)}` : '/api/photos'),
  photo: (id: string) => apiGet<{ photo: Photo }>(`/api/photos/${id}`),
  createPhoto: (input: PhotoWriteInput) => apiSend<{ photo: { id: string } }>('POST', '/api/photos', input),
  updatePhoto: (id: string, patch: PhotoPatchInput) =>
    apiSend<{ photo: Photo }>('PATCH', `/api/photos/${id}`, patch).then((r) => r.photo),
  deletePhoto: (id: string) => apiDelete(`/api/photos/${id}`),
}

export type GoogleImportStatus = 'picking' | 'importing' | 'done' | 'failed' | 'expired'

export interface GooglePhotosImport {
  id: string
  album: string
  sessionId: string
  pickerUri: string
  expireTime: string | null
  status: GoogleImportStatus
  importedCount: number
  skippedCount: number
  error: string | null
  createdAt: string
}

export interface GooglePhotosStatus {
  configured: boolean
  account: { id: string; email: string | null; connectedAt: string } | null
  imports: GooglePhotosImport[]
  /** Each album that holds imported photos, for the re-sync list. */
  albums?: Array<{ name: string; photoCount: number; lastSyncedAt: string }>
  photoCount?: number
}

// Google Photos import: connect once, then each import opens Google's picker and
// copies the chosen photos into one album.
export const googlePhotosApi = {
  googlePhotosStatus: () => apiGet<GooglePhotosStatus>('/api/photos/google/status'),
  connectGooglePhotos: (redirectTo?: string) =>
    apiSend<{ url: string }>('POST', '/api/photos/google/connect', redirectTo ? { redirectTo } : {}),
  disconnectGooglePhotos: (accountId: string) => apiDelete(`/api/photos/google/accounts/${accountId}`),
  startGoogleImport: (album: string) =>
    apiSend<{ import: GooglePhotosImport }>('POST', '/api/photos/google/imports', { album }).then((r) => r.import),
  googleImport: (id: string) =>
    apiGet<{ import: GooglePhotosImport }>(`/api/photos/google/imports/${id}`).then((r) => r.import),
}

export function useGooglePhotosStatus() {
  const [status, setStatus] = useState<GooglePhotosStatus | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    googlePhotosApi
      .googlePhotosStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null))
    return () => {
      alive = false
    }
  }, [nonce])
  return { status, refetch: () => setNonce((n) => n + 1) }
}

// Polls an import while the user is picking or the server is downloading.
export function useGoogleImport(id: string | null, intervalMs = 3000): GooglePhotosImport | null {
  const [imp, setImp] = useState<GooglePhotosImport | null>(null)
  useEffect(() => {
    if (!id) {
      setImp(null)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      googlePhotosApi
        .googleImport(id)
        .then((next) => {
          if (!alive) return
          setImp(next)
          if (next.status === 'picking' || next.status === 'importing') timer = setTimeout(tick, intervalMs)
        })
        .catch(() => alive && (timer = setTimeout(tick, intervalMs)))
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [id, intervalMs])
  return imp
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

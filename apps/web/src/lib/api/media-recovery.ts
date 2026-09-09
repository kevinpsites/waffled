import { apiGet } from './client'

export function isSignedMediaURL(raw: string): boolean {
  try {
    const url = new URL(raw, window.location.origin)
    return url.pathname.startsWith('/media/') && url.searchParams.has('expires') && url.searchParams.has('sig')
  } catch { return false }
}

// Refresh the owning resource through its ordinary authenticated route. No endpoint
// re-signs a caller-supplied storage key, and deleted media returns no replacement.
export const refreshRecipeImage = async (id: string) =>
  (await apiGet<{ recipe: { imageUrl: string | null } }>(`/api/recipes/${encodeURIComponent(id)}`)).recipe.imageUrl
export const refreshPhotoImage = async (id: string) =>
  (await apiGet<{ photo: { imageUrl: string | null } }>(`/api/photos/${encodeURIComponent(id)}`)).photo.imageUrl
export async function refreshProofImage(id: string, date?: string): Promise<string | null> {
  if (date) {
    const response = await apiGet<{ instances: Array<{ id: string; proofUrl: string | null }> }>(`/api/chore-instances/today?date=${encodeURIComponent(date)}`)
    return response.instances.find(p => p.id === id)?.proofUrl ?? null
  }
  const response = await apiGet<{ proofs: Array<{ instanceId: string; proofUrl: string | null }> }>('/api/chore-proofs')
  return response.proofs.find(p => p.instanceId === id)?.proofUrl ?? null
}
export const refreshPantryImage = async (id: string) =>
  (await apiGet<{ items: Array<{ id: string; imageUrl: string | null }> }>('/api/pantry')).items.find(p => p.id === id)?.imageUrl

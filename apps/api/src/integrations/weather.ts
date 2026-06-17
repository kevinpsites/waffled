// Live weather for the kiosk topbar (roadmap 6.8). Uses Open-Meteo — free, no API
// key — geocoding the household's Settings location to lat/lon, then its current
// conditions. Both calls are cached (geocode ~forever per process, forecast 10 min)
// so a wall of kiosks polling doesn't hammer the service. Endpoint URLs are env-
// overridable for tests. Fahrenheit for now (US household); easy to make a setting.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../platform/db'
import { requireTenant } from '../modules/households/households'

type Api = ReturnType<typeof createAPI>

const GEOCODE_URL = process.env.OPEN_METEO_GEOCODE_URL ?? 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = process.env.OPEN_METEO_FORECAST_URL ?? 'https://api.open-meteo.com/v1/forecast'
const FORECAST_TTL_MS = 10 * 60 * 1000

interface Geo { lat: number; lon: number; label: string }
interface WeatherDto {
  configured: boolean
  tempF?: number
  code?: number
  label?: string
  emoji?: string
  isDay?: boolean
  location?: string
  fetchedAt?: string
}

const geoCache = new Map<string, Geo | null>()
const forecastCache = new Map<string, { data: WeatherDto; expiresAt: number }>()

// WMO weather code → a short label + an emoji (day/night aware for clear skies).
function codeInfo(code: number, isDay: boolean): { label: string; emoji: string } {
  if (code === 0) return { label: 'Clear', emoji: isDay ? '☀️' : '🌙' }
  if (code === 1) return { label: 'Mainly clear', emoji: isDay ? '🌤️' : '🌙' }
  if (code === 2) return { label: 'Partly cloudy', emoji: '⛅' }
  if (code === 3) return { label: 'Overcast', emoji: '☁️' }
  if (code === 45 || code === 48) return { label: 'Fog', emoji: '🌫️' }
  if (code >= 51 && code <= 57) return { label: 'Drizzle', emoji: '🌦️' }
  if (code >= 61 && code <= 67) return { label: 'Rain', emoji: '🌧️' }
  if (code >= 71 && code <= 77) return { label: 'Snow', emoji: '❄️' }
  if (code >= 80 && code <= 82) return { label: 'Showers', emoji: '🌦️' }
  if (code === 85 || code === 86) return { label: 'Snow showers', emoji: '🌨️' }
  if (code >= 95) return { label: 'Thunderstorm', emoji: '⛈️' }
  return { label: 'Weather', emoji: '🌡️' }
}

// Geocode a "City, State" string → lat/lon. We search on the city (the part before
// the comma) which the geocoder matches best, and cache the result per process.
async function geocode(location: string): Promise<Geo | null> {
  const key = location.toLowerCase()
  const cached = geoCache.get(key)
  if (cached !== undefined) return cached
  const city = location.split(',')[0].trim() || location
  const res = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=1`)
  if (!res.ok) return null // transient — don't cache, allow retry
  const data = (await res.json()) as {
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string }>
  }
  const r = data.results?.[0]
  const geo: Geo | null = r
    ? { lat: r.latitude, lon: r.longitude, label: [r.name, r.admin1].filter(Boolean).join(', ') }
    : null
  geoCache.set(key, geo)
  return geo
}

export function registerWeatherRoutes(api: Api): void {
  // Current conditions for the household's location. { configured: false } when no
  // location is set or it can't be geocoded — the topbar just hides the widget.
  api.get('/api/weather', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const { rows } = await query<{ location: string | null }>(
      `select location from households where id = $1`,
      [tenant.householdId]
    )
    const location = rows[0]?.location?.trim()
    if (!location) return { configured: false }

    const geo = await geocode(location)
    if (!geo) return { configured: false }

    const cacheKey = `${geo.lat},${geo.lon}`
    const now = Date.now()
    const hit = forecastCache.get(cacheKey)
    if (hit && hit.expiresAt > now) return hit.data

    try {
      const url =
        `${FORECAST_URL}?latitude=${geo.lat}&longitude=${geo.lon}` +
        `&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit&wind_speed_unit=mph`
      const fr = await fetch(url)
      if (!fr.ok) throw new Error(`forecast -> ${fr.status}`)
      const fd = (await fr.json()) as {
        current?: { temperature_2m: number; weather_code: number; is_day: number }
      }
      const c = fd.current
      if (!c) return { configured: false }
      const info = codeInfo(c.weather_code, c.is_day === 1)
      const data: WeatherDto = {
        configured: true,
        tempF: Math.round(c.temperature_2m),
        code: c.weather_code,
        label: info.label,
        emoji: info.emoji,
        isDay: c.is_day === 1,
        location: geo.label,
        fetchedAt: new Date(now).toISOString(),
      }
      forecastCache.set(cacheKey, { data, expiresAt: now + FORECAST_TTL_MS })
      return data
    } catch (err) {
      console.error('weather fetch failed', err)
      if (hit) return hit.data // serve stale on a transient error
      return res.status(200).json({ configured: false })
    }
  })
}

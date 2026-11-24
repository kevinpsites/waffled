// Mealie variants of the Today Tonight / This week / Grocery cards. They reuse the
// built-in cards' chrome so the kiosk looks the same either way.
import { Link, useNavigate } from 'react-router'
import { useHousehold } from '../../lib/api'
import { mealieApi, useMealieQuery, type MealieEntry } from '../../lib/api/mealie'
import { addDaysYmd, householdToday } from '../../lib/household-date'
import { MealieError } from './MealieError'

function useHouseholdTz(): string {
  const { household } = useHousehold()
  return household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function dayAbbrev(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
}

function useMealieWeek(days: number) {
  const tz = useHouseholdTz()
  const start = householdToday(tz)
  const end = addDaysYmd(start, days - 1)
  return { start, ...useMealieQuery(() => mealieApi.mealplan(start, end), [start, end]) }
}

export function MealieTonightCard() {
  const navigate = useNavigate()
  const { start, data, error, retry } = useMealieWeek(1)
  if (error) return <div className="card" style={{ padding: '14px 16px' }}><MealieError error={error} onRetry={retry} compact /></div>
  const today = (data?.entries ?? []).filter((e) => e.date === start)
  const dinners = today.filter((e) => e.entryType === 'dinner')
  const shown = dinners.length ? dinners : today
  if (!shown.length) return null
  const label = dinners.length ? 'Tonight · Dinner' : 'Today'
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {shown.map((e) => {
        const slug = e.recipe?.slug
        const img = e.recipe?.imageUrl
        return (
          <div
            key={e.id}
            onClick={() => slug && navigate(`/meals/mealie/${slug}`)}
            role={slug ? 'button' : undefined}
            tabIndex={slug ? 0 : undefined}
            style={{ cursor: slug ? 'pointer' : 'default' }}
          >
            <div style={{ height: 112, background: 'linear-gradient(135deg,#f6d9c6,#e9b596)', position: 'relative' }}>
              {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
            </div>
            <div style={{ padding: '14px 16px 15px' }}>
              <div className="tiny" style={{ color: 'var(--person-4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                {label}
              </div>
              <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, margin: '3px 0 0' }}>{e.recipe?.name ?? e.title}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function MealieWeekCard() {
  const navigate = useNavigate()
  const { start, data, error, retry } = useMealieWeek(7)
  const days = Array.from({ length: 7 }, (_, i) => addDaysYmd(start, i))
  const byDay = (d: string): MealieEntry[] => (data?.entries ?? []).filter((e) => e.date === d)
  const count = (data?.entries ?? []).filter((e) => e.entryType === 'dinner').length
  return (
    <div className="card" style={{ padding: '15px 18px 8px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <Link to="/meals" className="card-h" style={{ fontSize: 16, textDecoration: 'none', color: 'inherit' }}>
          This week’s dinners
        </Link>
        {data && (
          <Link to="/meals" className="tiny muted" style={{ marginLeft: 'auto', textDecoration: 'none', color: 'var(--ink-2)' }}>
            {count} planned ›
          </Link>
        )}
      </div>
      {error != null && <MealieError error={error} onRetry={retry} compact />}
      {!error && !data && <div className="tiny muted" style={{ padding: '6px 0' }}>Loading…</div>}
      {!error && data && days.map((d) => (
        <div key={d} data-day={d} style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '6px 0', borderBottom: '1px solid var(--hair-2)' }}>
          <div className="tiny" style={{ width: 34, fontWeight: 700, color: 'var(--ink-2)' }}>{dayAbbrev(d)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {byDay(d).length === 0 && <div className="tiny muted">—</div>}
            {byDay(d).map((e) => {
              const slug = e.recipe?.slug
              return (
                <div
                  key={e.id}
                  onClick={() => slug && navigate(`/meals/mealie/${slug}`)}
                  role={slug ? 'button' : undefined}
                  tabIndex={slug ? 0 : undefined}
                  style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: slug ? 'pointer' : 'default' }}
                >
                  {e.recipe?.name ?? e.title}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export function MealieGroceryCard() {
  const navigate = useNavigate()
  const { data, error, retry } = useMealieQuery(() => mealieApi.shopping(), [])
  const open = (data?.items ?? []).filter((i) => !i.checked)
  return (
    <div className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div className="card-h" style={{ fontSize: 17 }}>Grocery</div>
        {data && <div className="tiny muted" style={{ marginLeft: 'auto' }}>{open.length} to get</div>}
      </div>
      {error != null && <MealieError error={error} onRetry={retry} compact />}
      {!error && !data && <div className="tiny muted">Loading…</div>}
      {!error && data && open.length === 0 && <div className="tiny muted">Nothing on the list yet.</div>}
      {!error && data && open.slice(0, 5).map((item) => (
        <div
          key={item.id}
          onClick={() => navigate('/lists')}
          role="button"
          tabIndex={0}
          style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
        >
          <span className="gcheck" />
          <span>{item.display}</span>
        </div>
      ))}
    </div>
  )
}

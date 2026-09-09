import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { avTint } from '../../components/Avatar'
import { ApiSendError } from '../../../lib/api/client'
import {
  looseEndsApi,
  looseEndActionLabel,
  looseEndActionHint,
  LOOSE_END_GROUPS,
  type LooseEnd,
  type LooseEndAction,
  type LooseEndDestination,
  type LooseEndGroup,
  type LooseEndRoute,
  type LooseEndsView,
  useHousehold,
  can,
  weeklyPlanningApi,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-looseEnds.css'

// Step 1 · Loose ends — a deck you work through, a switch carrying both counts, and a see-all list.
//
// STEP 1 ROUTES; IT DOES NOT REPAIR. Every primary choice on the card is a DESTINATION — the step
// that will handle the thing — and choosing one writes nothing to any module. The steps
// downstream do the work, which is why Tasks later shows rows captioned "sent here in step 1".
//
// THE DISTINCTION THE SWITCH CARRIES: "Not done" is computed from the modules that already own
// the work; "Parked" is what somebody wrote down during the week and exists nowhere else yet, so
// its verbs differ and Drop is a real answer there.

const KIND_LABEL: Record<LooseEnd['kind'], string> = {
  chore: 'Chore',
  list: 'List',
  rhythm: 'Rhythm',
  goal: 'Goal',
  parked: 'Parked',
}

interface Choice {
  key: string
  label: string
  hint: string
  primary?: boolean
  tone?: 'route' | 'settle' | 'quiet'
  run: () => void
}

const routeKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`

function Owner({ owner }: { owner: LooseEnd['owner'] }) {
  if (!owner) return null
  return (
    <span className="wp-le-owner">
      <span className="chore-ava" style={{ background: avTint(owner.colorHex) }} aria-hidden>
        {owner.avatarEmoji ?? '🙂'}
      </span>
      {owner.name}
    </span>
  )
}

function Deck({ item, choices, quiet, busy }: {
  item: LooseEnd
  choices: Choice[]
  quiet: Choice[]
  busy: boolean
}) {
  return (
    <div className="wp-le-stack">
      <div className="wp-le-card">
        <div className="wp-le-kind">
          {KIND_LABEL[item.kind]}
          <Owner owner={item.owner} />
        </div>
        <div className="wp-le-t">
          {item.emoji && <span className="wp-le-emoji" aria-hidden>{item.emoji}</span>}
          {item.title}
        </div>
        {item.detail && <div className="wp-le-d">{item.detail}</div>}
        <div className="wp-le-choices">
          {choices.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`wp-le-choice${c.primary ? ' primary' : ''} ${c.tone ?? 'route'}`}
              disabled={busy}
              onClick={c.run}
            >
              <b>{c.label}</b>
              <s>{c.hint}</s>
            </button>
          ))}
        </div>
        <div className="wp-le-quiet">
          {quiet.map((c) => (
            <button key={c.key} type="button" className="wp-le-quiet-b" disabled={busy} onClick={c.run}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Body({ step, sessionId, weekStart, setDecisionData, busy }: StepBodyProps) {
  const { person } = useHousehold()
  const canRuleLists = can(person, 'planning.manage')
  const [chooser, setChooser] = useState(false)
  const [ruling, setRuling] = useState<string | null>(null)
  const [view, setView] = useState<LooseEndsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [group, setGroup] = useState<LooseEndGroup>('notDone')
  const [seeAll, setSeeAll] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [setAside, setSetAside] = useState<string[]>([])
  const [routes, setRoutes] = useState<LooseEndRoute[]>(
    () => (Array.isArray(step.data?.routes) ? (step.data.routes as LooseEndRoute[]) : [])
  )
  const [answered, setAnswered] = useState(0)
  const [note, setNote] = useState('')
  const sections = useRef<Partial<Record<LooseEndGroup, HTMLElement | null>>>({})

  const load = useCallback(async () => {
    try {
      const next = await looseEndsApi.get(weekStart, sessionId)
      setView(next)
      setRoutes(next.routes)
    } catch {
      setView(null)
    } finally {
      setLoading(false)
    }
  }, [weekStart, sessionId])

  useEffect(() => { void load() }, [load])

  useEffect(() => { setSetAside([]); setAnswered(0) }, [weekStart])

  // Opening see-all lands on the section for the group you were on. A starting POSITION, not a
  // second filter. Guarded because jsdom has no scrollIntoView.
  useEffect(() => {
    if (!seeAll) return
    sections.current[group]?.scrollIntoView?.({ block: 'start' })
  }, [seeAll, group])

  const routedKeys = useMemo(() => new Set(routes.map(routeKey)), [routes])

  const openIn = useCallback(
    (g: LooseEndGroup): LooseEnd[] => {
      const all = g === 'notDone' ? view?.notDone : view?.parked
      return (all ?? []).filter((i) => !routedKeys.has(i.key) && !setAside.includes(i.key))
    },
    [view, routedKeys, setAside]
  )

  const remaining = useMemo(
    () => ({ notDone: openIn('notDone').length, parked: openIn('parked').length }),
    [openIn]
  )

  useEffect(() => {
    setDecisionData({ routes, answered, left: remaining.notDone + remaining.parked })
  }, [routes, answered, remaining.notDone, remaining.parked, setDecisionData])

  const disabled = busy || working

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    if (disabled) return
    setWorking(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(
        err instanceof ApiSendError && typeof err.body?.message === 'string'
          ? err.body.message
          : "That didn't go through — try again."
      )
    } finally {
      setWorking(false)
    }
  }, [disabled])

  const sendTo = (item: LooseEnd, source: LooseEndGroup, to: string) =>
    guard(async () => {
      const { routes: next } = await looseEndsApi.route(sessionId, item, source, to)
      setRoutes(next)
    })

  const undoRoute = (r: LooseEndRoute) =>
    guard(async () => {
      const { routes: next } = await looseEndsApi.route(sessionId, r, r.source, null)
      setRoutes(next)
    })

  const settle = (item: LooseEnd, action: LooseEndAction) =>
    guard(async () => {
      await looseEndsApi.resolve(item.kind, item.id, action, sessionId)
      setAnswered((n) => n + 1)
      await load()
      // No refresh() here: `resolve` emits 'weeklyPlanning' and the shell is already
      // subscribed, so calling both would fetch the session view twice per answer.
    })

  const leave = (item: LooseEnd) => {
    setError(null)
    setSetAside((keys) => (keys.includes(item.key) ? keys : [...keys, item.key]))
  }

  const park = (e: FormEvent) => {
    e.preventDefault()
    const text = note.trim()
    if (!text) return
    void guard(async () => {
      await looseEndsApi.park(text, { sessionId })
      setNote('')
      await load()
    })
  }

  const choicesFor = (item: LooseEnd, g: LooseEndGroup): { choices: Choice[]; quiet: Choice[] } => {
    const dests: LooseEndDestination[] = (g === 'notDone' ? view?.destinations.notDone : view?.destinations.parked) ?? []
    const choices: Choice[] = dests.map((d) => ({
      key: `to:${d.to}`,
      label: d.label,
      hint: d.hint,
      primary: d.primary,
      tone: 'route',
      run: () => void sendTo(item, g, d.to),
    }))
    const quiet: Choice[] = []
    for (const a of item.actions) {
      const c: Choice = {
        key: `do:${a}`,
        label: looseEndActionLabel(a, item.kind),
        hint: looseEndActionHint(a, item.kind),
        tone: 'settle',
        run: () => void settle(item, a),
      }
      if (g === 'parked' && a === 'done') choices.push(c)
      else quiet.push({ ...c, tone: 'quiet' })
    }
    const leaveChoice: Choice = {
      key: 'leave',
      label: g === 'parked' ? 'Keep it parked' : 'Leave it open',
      hint: g === 'parked' ? "It isn't time yet" : 'Nothing changes anywhere',
      tone: 'quiet',
      run: () => leave(item),
    }
    if (g === 'parked') choices.push(leaveChoice)
    else quiet.unshift(leaveChoice)
    return { choices, quiet }
  }

  if (loading) return <div className="wp-le"><div className="wp-le-empty">Looking for what's still open…</div></div>
  if (!view) return <div className="wp-le"><div className="wp-le-empty">Couldn't read your loose ends — reload and try again.</div></div>

  const card = openIn(group)[0] ?? null
  const total = (group === 'notDone' ? view.notDone : view.parked).length
  const position = total - openIn(group).length + 1
  const other: LooseEndGroup = group === 'parked' ? 'notDone' : 'parked'
  const otherLabel = LOOSE_END_GROUPS.find((g) => g.key === other)!.label
  const groupNote = LOOSE_END_GROUPS.find((g) => g.key === group)!.note
  const trail = routes.slice(-3).reverse()
  // Step NAMES for the trail: "Not done"'s destination labels ARE the step titles, while
  // "Parked"'s are verbs ("Make it a task") which read wrong after an arrow — so the trail
  // always uses the notDone label, falling back to the key for a step whose module is off.
  const stepName = (to: string) => view.destinations.notDone.find((d) => d.to === to)?.label ?? to

  // WHICH LISTS THIS STEP ASKS ABOUT. Sending somebody to Settings → Modules to silence a
  // someday list is the ejection this module exists to avoid, and that panel is admin-only;
  // `planning.manage` (adult by default) is the gate instead.
  //
  // Sparse on the wire: only the switch that moved, because the server merges and sending the
  // whole map would rule lists back in behind another device's back. The step then RE-READS
  // rather than guessing which cards would have gone.
  const candidates = view?.lists ?? []
  const showChooser = canRuleLists && candidates.length > 0
  const ruleList = async (id: string, on: boolean) => {
    if (ruling || busy) return
    setRuling(id)
    try {
      await weeklyPlanningApi.setConfig({ lists: { [id]: on } })
      await load()
    } catch {
      setError('Couldn’t save that just now.')
    } finally {
      setRuling(null)
    }
  }

  const listChooser = (
    <div className="modal-overlay" onClick={() => setChooser(false)}>
      <div className="modal-card wp-le-lists" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Lists it asks about">
        <div className="wp-le-lists-t wf-serif">Lists it asks about</div>
        <div className="wp-le-lists-s">
          This step asks about anything still unchecked from before this week. Turn off a list
          that’s meant to stay open — a someday list, a wishlist — and it stops coming up every
          session. Your grocery list is never asked about: it rebuilds itself from the meal plan.
        </div>
        {candidates.map((l) => {
          const on = l.relevant
          return (
            <button
              key={l.id}
              type="button"
              className="wp-le-lists-row"
              disabled={busy || ruling !== null}
              onClick={() => ruleList(l.id, !on)}
            >
              <span className="wp-le-lists-n">{[l.emoji, l.name].filter(Boolean).join(' ')}</span>
              <span
                className={`toggle ${on ? 'on' : ''}`}
                role="switch"
                aria-checked={on}
                aria-label={`Ask about ${l.name} in the weekly planning session`}
              />
            </button>
          )
        })}
        <button type="button" className="btn btn-primary wp-le-lists-done" onClick={() => setChooser(false)}>
          Done
        </button>
      </div>
    </div>
  )

  const captureBar = (
    <form className="wp-le-capture" onSubmit={park}>
      <span className="wp-le-capture-p" aria-hidden>＋</span>
      <input
        className="wp-le-capture-in"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={disabled}
        placeholder="Drop something new on the board — one line is enough"
        aria-label="Park something new"
      />
      <button type="submit" className="btn btn-primary wp-le-capture-go" disabled={disabled || !note.trim()}>
        Park it
      </button>
    </form>
  )

  return (
    <div className="wp-le">
      <div className="wp-le-bar">
        {seeAll ? (
          // No switch here: see-all shows BOTH groups under their own headings, so a switch
          // would look selected while governing nothing — which read as a filtered list.
          <div className="wp-le-all-t">Everything still open</div>
        ) : (
          <div className="wp-le-switch" role="group" aria-label="Which loose ends">
            {LOOSE_END_GROUPS.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`wp-le-tab${g.key === group ? ' on' : ''}`}
                aria-pressed={g.key === group}
                onClick={() => { setGroup(g.key); setError(null) }}
              >
                {g.label}{' '}
                <span className="wp-le-n">{remaining[g.key] === 0 ? '✓' : remaining[g.key]}</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="wp-le-seeall" aria-pressed={seeAll} onClick={() => setSeeAll((v) => !v)}>
          {seeAll ? 'One at a time' : 'See all'}
        </button>
        {showChooser && (
          <button type="button" className="wp-le-lists-open" onClick={() => setChooser(true)}>
            Which lists?
          </button>
        )}
      </div>

      {!seeAll && <div className="wp-le-note">{groupNote}</div>}

      {error && <div className="wp-le-err" role="alert">{error}</div>}

      {seeAll ? (
        <div className="wp-le-list">
          <div className="wp-le-disclaimer">
            Routing here changes nothing in your modules — it only decides which step handles it.
          </div>
          {LOOSE_END_GROUPS.map((g) => (
            <section
              key={g.key}
              id={`wp-le-sec-${g.key}`}
              className="wp-le-sec"
              ref={(el) => { sections.current[g.key] = el }}
            >
              <h3 className="wp-le-sec-h">
                {g.label} <span className="wp-le-n">{remaining[g.key] === 0 ? '✓' : remaining[g.key]}</span>
                <span className="wp-le-sec-cap">· {g.caption}</span>
              </h3>
              {openIn(g.key).length === 0 ? (
                <div className="wp-le-empty wp-le-empty-sm">
                  {g.key === 'parked' ? 'Nothing parked is waiting.' : 'Nothing left open.'}
                </div>
              ) : (
                <ul className="wp-le-rows">
                  {openIn(g.key).map((item) => (
                    <li key={item.key} className="wp-le-row">
                      <span className="wp-le-emoji" aria-hidden>{item.emoji ?? '•'}</span>
                      <span className="wp-le-row-main">
                        <b>{item.title}</b>
                        <s className="wp-le-row-meta">
                          <span className="wp-le-row-kind">{KIND_LABEL[item.kind]}</span>
                          {item.detail && <span>· {item.detail}</span>}
                          <Owner owner={item.owner} />
                        </s>
                      </span>
                      <span className="wp-le-row-acts">
                        {((g.key === 'notDone' ? view.destinations.notDone : view.destinations.parked)).map((d) => (
                          <button
                            key={d.to}
                            type="button"
                            className={`wp-le-pill${d.primary ? ' primary' : ''}`}
                            disabled={disabled}
                            onClick={() => void sendTo(item, g.key, d.to)}
                          >
                            {d.label}
                          </button>
                        ))}
                        {item.actions.map((a) => (
                          <button
                            key={a}
                            type="button"
                            className="wp-le-pill quiet"
                            disabled={disabled}
                            onClick={() => void settle(item, a)}
                          >
                            {looseEndActionLabel(a, item.kind)}
                          </button>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {g.key === 'parked' && captureBar}
            </section>
          ))}
        </div>
      ) : card ? (
        <div className="wp-le-deck">
          <div className="wp-le-pos">{position} of {total}</div>
          <Deck item={card} {...choicesFor(card, group)} busy={disabled} />
        </div>
      ) : (
        <div className="wp-le-clear">
          <div className="wp-le-check" aria-hidden>✓</div>
          <div className="wp-le-clear-t wf-serif">
            {group === 'parked' ? "Nothing's parked" : "Nothing's left undone"}
          </div>
          <div className="wp-le-clear-s">
            {group === 'parked'
              ? 'Nobody wrote anything down this week that lives nowhere else yet.'
              : `We checked your ${view.sources.length ? view.sources.join(', ') : 'modules'}.`}
            {remaining[other] > 0
              ? ` ${remaining[other]} ${other === 'parked' ? (remaining[other] === 1 ? 'parked note is' : 'parked notes are') : (remaining[other] === 1 ? 'loose end is' : 'loose ends are')} still waiting.`
              : ' Both groups are clear.'}
          </div>
          {remaining[other] > 0 && (
            <button type="button" className="btn btn-primary wp-le-clear-go" onClick={() => setGroup(other)}>
              Go to {otherLabel}
            </button>
          )}
        </div>
      )}

      {trail.length > 0 && (
        <div className="wp-le-trail">
          <span className="wp-le-trail-h" data-testid="wp-le-trail-h">
            Sent ahead — they&rsquo;ll come up at that step later tonight
          </span>
          {trail.map((r, i) => (
            <span key={routeKey(r)} className={`wp-le-trail-i${i === 0 ? ' last' : ''}`}>
              <b>{r.title}</b> → {stepName(r.to)}
            </span>
          ))}
          <button type="button" className="wp-le-undo" disabled={disabled} onClick={() => void undoRoute(trail[0])}>
            Undo
          </button>
        </div>
      )}

      {group === 'parked' && !seeAll && captureBar}
      {chooser && showChooser && listChooser}
    </div>
  )
}

const mod: PlanningStepModule = { Body }
export default mod

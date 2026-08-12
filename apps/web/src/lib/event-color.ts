// Event → color resolution, family-aware. An event whose people cover the whole
// household renders in the household's *family* color (Settings → Family &
// People → Family color, stored in settings.display.familyColorHex) instead of
// whichever member happened to own it — so the calendar reads at a glance:
// everyone / some of us / one person / unassigned.
import { useMemo } from 'react'
import { usePersons, useHousehold, type Household } from './api/persons'
import type { AgendaEvent } from './api/events'

/** The grey used across every view for events with no assignee. */
export const UNASSIGNED_COLOR = '#6B6B70'
/** Default whole-family color — deliberately not one of the member swatches. */
export const DEFAULT_FAMILY_COLOR = '#F97316'

const HEX = /^#[0-9a-fA-F]{6}$/

type ColorableEvent = Pick<AgendaEvent, 'personId' | 'personColor' | 'participants'>

/** The household's whole-family event color (settings.display.familyColorHex). */
export function familyColorHex(household: Household | null | undefined): string {
  const v = (household?.settings as { display?: { familyColorHex?: unknown } } | undefined)?.display?.familyColorHex
  return typeof v === 'string' && HEX.test(v) ? v : DEFAULT_FAMILY_COLOR
}

/**
 * A "family event" = its people (participants + the owner) cover every household
 * member. One-person households never qualify — there's no whole-vs-part
 * distinction to draw.
 */
export function isFamilyEvent(e: Pick<ColorableEvent, 'personId' | 'participants'>, memberIds: string[]): boolean {
  if (memberIds.length < 2) return false
  const ids = new Set((e.participants ?? []).map((p) => p.id))
  if (e.personId) ids.add(e.personId)
  return memberIds.every((id) => ids.has(id))
}

/** Family color for whole-family events; else the owner's color; else grey. */
export function eventColor(
  e: ColorableEvent,
  memberIds: string[],
  household: Household | null | undefined,
  fallback: string = UNASSIGNED_COLOR
): string {
  if (isFamilyEvent(e, memberIds)) return familyColorHex(household)
  return e.personColor ?? fallback
}

/**
 * Hook form for the calendar views: `const colorOf = useEventColor()`.
 * `fallback` is the unassigned grey (the agenda surfaces use a lighter one).
 * Falls back to the plain owner color while members/household are still loading.
 */
export function useEventColor(fallback: string = UNASSIGNED_COLOR): (e: ColorableEvent) => string {
  const { persons } = usePersons()
  const { household } = useHousehold()
  return useMemo(() => {
    const ids = (persons ?? []).map((p) => p.id)
    return (e: ColorableEvent) => eventColor(e, ids, household, fallback)
  }, [persons, household, fallback])
}

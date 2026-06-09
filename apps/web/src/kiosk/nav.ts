import type { IconName } from './icons'

// The rail's primary nav. `path` drives both the route and the active state.
export interface Screen {
  path: string
  label: string
  icon: IconName
}

export const SCREENS: Screen[] = [
  { path: '/', label: 'Today', icon: 'home' },
  { path: '/calendar', label: 'Calendar', icon: 'calendar' },
  { path: '/tasks', label: 'Tasks', icon: 'tasks' },
  { path: '/goals', label: 'Goals', icon: 'goals' },
  { path: '/meals', label: 'Meals', icon: 'meals' },
  { path: '/lists', label: 'Lists', icon: 'lists' },
  { path: '/photos', label: 'Photos', icon: 'photos' },
]

export const SETTINGS: Screen = { path: '/settings', label: 'Settings', icon: 'settings' }

import type { IconName } from './icons'
import type { ModuleKey } from '../lib/modules'

// The rail's primary nav. `path` drives both the route and the active state.
// `module` (optional) gates the entry behind an enabled optional module.
export interface Screen {
  path: string
  label: string
  icon: IconName
  module?: ModuleKey
}

export const SCREENS: Screen[] = [
  { path: '/', label: 'Today', icon: 'home' },
  { path: '/calendar', label: 'Calendar', icon: 'calendar' },
  { path: '/tasks', label: 'Tasks', icon: 'tasks' },
  { path: '/goals', label: 'Goals', icon: 'goals' },
  { path: '/family', label: 'Family', icon: 'family' },
  { path: '/meals', label: 'Meals', icon: 'meals' },
  { path: '/lists', label: 'Lists', icon: 'lists' },
  { path: '/pantry', label: 'Pantry', icon: 'pantry', module: 'pantry' },
  { path: '/photos', label: 'Photos', icon: 'photos' },
]

export const SETTINGS: Screen = { path: '/settings', label: 'Settings', icon: 'settings' }

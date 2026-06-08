import { Icon, type IconName } from '../icons'

const NAV: Array<[IconName, string]> = [
  ['home', 'Today'],
  ['calendar', 'Calendar'],
  ['tasks', 'Tasks'],
  ['goals', 'Goals'],
  ['meals', 'Meals'],
  ['lists', 'Lists'],
  ['photos', 'Photos'],
]

export type RailKey = IconName | 'home'

export function Rail({ active }: { active: RailKey }) {
  return (
    <div className="rail">
      <div className="rail-logo nk-serif">N</div>
      <div className="rail-new">New</div>
      {NAV.map(([key, label]) => (
        <div key={key} className={`rail-item ${key === active ? 'on' : ''}`}>
          <Icon name={key} />
          {label}
        </div>
      ))}
      <div className="rail-spacer" />
      <div className={`rail-item ${active === 'settings' ? 'on' : ''}`}>
        <Icon name="settings" />
        Settings
      </div>
    </div>
  )
}

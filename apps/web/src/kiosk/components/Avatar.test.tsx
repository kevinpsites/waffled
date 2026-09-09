import { render, screen } from '@testing-library/react'
import { PersonAv, AvatarStack } from './Avatar'

const wally = { personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }

describe('PersonAv', () => {
  it('tints from the stored hex and names the person for a hover', () => {
    render(<PersonAv person={wally} />)
    const av = screen.getByTitle('Wally')
    expect(av.textContent).toBe('🐢')
    expect(av.className).toContain('av')
    // jsdom normalises `#hex22` to rgba; the 0.133 alpha IS the `22` suffix.
    expect(av.style.background).toContain('rgba(37, 163, 104')
  })

  // A person with no colour or emoji still has to render as a face rather than a hole.
  it('falls back to the neutral tint and a plain face', () => {
    render(<PersonAv person={{ personId: 'p2', name: null, avatarEmoji: null, colorHex: null }} />)
    const av = screen.getByText('🙂')
    expect(av.style.background).toContain('rgba(166, 162, 155')
    expect(av.getAttribute('title')).toBeNull()
  })

  it('takes a size', () => {
    render(<PersonAv person={wally} size="lg" />)
    expect(screen.getByTitle('Wally').className).toContain('lg')
  })
})

describe('AvatarStack', () => {
  const five = [1, 2, 3, 4, 5].map((n) => ({ personId: `p${n}`, name: `P${n}`, avatarEmoji: '🙂', colorHex: null }))

  it('overlaps the faces and shows everyone by default', () => {
    const { container } = render(<AvatarStack members={five} />)
    expect(container.querySelector('.avstack')).toBeTruthy()
    expect(container.querySelectorAll('.av').length).toBe(5)
  })

  it('takes a cap where a card\u2019s layout needs one', () => {
    const { container } = render(<AvatarStack members={five} max={2} />)
    expect(container.querySelectorAll('.av').length).toBe(2)
  })

  it('renders nothing for nobody', () => {
    const { container } = render(<AvatarStack members={[]} />)
    expect(container.querySelector('.avstack')).toBeNull()
  })
})

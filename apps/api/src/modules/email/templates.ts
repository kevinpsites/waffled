// Email templates. Email clients strip <style>/external CSS, so everything is
// inline-styled. Each render returns both an HTML and a plaintext body (many clients
// and accessibility tools prefer text). Kept dependency-free on purpose — no MJML/
// react-email for v1; a section renderer per digest block.

export interface DigestData {
  householdName: string
  weekLabel: string
  sections: string[]
  events: Array<{ day: string; time: string; title: string }>
  meals: Array<{ day: string; mealType: string; title: string }>
  choresDue: number
  choresByPerson: Array<{ name: string; count: number }>
  groceryOpen: number
  grocerySample: string[]
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

// Shell: a centered card with a header + the section blocks. Purple accent matches
// the app's primary. Uses table-free flow that survives Gmail/Outlook reasonably.
function layout(inner: string, data: DigestData): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f4ef;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2b2b2b;">
    <div style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #eee;">
      <div style="background:#6b4fbb;color:#fff;padding:20px 24px;">
        <div style="font-size:14px;opacity:.85;">🧇 Waffled · ${esc(data.householdName)}</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px;">Your week — ${esc(data.weekLabel)}</div>
      </div>
      <div style="padding:8px 24px 24px;">${inner}</div>
    </div>
    <div style="text-align:center;color:#999;font-size:12px;margin-top:16px;">
      You're getting this because weekly digests are on for ${esc(data.householdName)}.
    </div>
  </div></body></html>`
}

function sectionHtml(title: string, bodyHtml: string): string {
  return `<div style="margin-top:20px;">
    <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b4fbb;margin-bottom:8px;">${esc(title)}</div>
    ${bodyHtml}
  </div>`
}

function rowsHtml(items: string[]): string {
  if (!items.length) return `<div style="color:#999;font-size:14px;">Nothing scheduled.</div>`
  return items
    .map((i) => `<div style="padding:6px 0;border-bottom:1px solid #f0eee9;font-size:14px;">${i}</div>`)
    .join('')
}

export function renderDigest(data: DigestData): { html: string; text: string } {
  const want = new Set(data.sections)
  const htmlParts: string[] = []
  const textParts: string[] = [`Your week at ${data.householdName} — ${data.weekLabel}`, '']

  if (want.has('calendar')) {
    htmlParts.push(
      sectionHtml(
        'Calendar',
        rowsHtml(
          data.events.map(
            (e) => `<strong>${esc(e.day)}</strong> · ${esc(e.time)} — ${esc(e.title)}`
          )
        )
      )
    )
    textParts.push('CALENDAR')
    textParts.push(...(data.events.length ? data.events.map((e) => `  ${e.day} · ${e.time} — ${e.title}`) : ['  Nothing scheduled.']))
    textParts.push('')
  }

  if (want.has('meals')) {
    htmlParts.push(
      sectionHtml(
        'Meals',
        rowsHtml(
          data.meals.map((m) => `<strong>${esc(m.day)}</strong> · ${esc(cap(m.mealType))} — ${esc(m.title)}`)
        )
      )
    )
    textParts.push('MEALS')
    textParts.push(...(data.meals.length ? data.meals.map((m) => `  ${m.day} · ${cap(m.mealType)} — ${m.title}`) : ['  No meals planned.']))
    textParts.push('')
  }

  if (want.has('chores')) {
    const body =
      data.choresDue === 0
        ? `<div style="color:#999;font-size:14px;">No chores due this week. 🎉</div>`
        : rowsHtml([
            `<strong>${data.choresDue}</strong> chore${data.choresDue === 1 ? '' : 's'} due this week`,
            ...data.choresByPerson.map((c) => `${esc(c.name)}: ${c.count}`),
          ])
    htmlParts.push(sectionHtml('Chores', body))
    textParts.push('CHORES')
    if (data.choresDue === 0) textParts.push('  No chores due this week.')
    else {
      textParts.push(`  ${data.choresDue} due this week`)
      textParts.push(...data.choresByPerson.map((c) => `  ${c.name}: ${c.count}`))
    }
    textParts.push('')
  }

  if (want.has('grocery')) {
    const body =
      data.groceryOpen === 0
        ? `<div style="color:#999;font-size:14px;">Grocery list is clear.</div>`
        : rowsHtml([
            `<strong>${data.groceryOpen}</strong> item${data.groceryOpen === 1 ? '' : 's'} on the grocery list`,
            ...(data.grocerySample.length ? [esc(data.grocerySample.join(', ')) + (data.groceryOpen > data.grocerySample.length ? '…' : '')] : []),
          ])
    htmlParts.push(sectionHtml('Grocery', body))
    textParts.push('GROCERY')
    if (data.groceryOpen === 0) textParts.push('  Grocery list is clear.')
    else {
      textParts.push(`  ${data.groceryOpen} items`)
      if (data.grocerySample.length) textParts.push(`  ${data.grocerySample.join(', ')}${data.groceryOpen > data.grocerySample.length ? '…' : ''}`)
    }
    textParts.push('')
  }

  return { html: layout(htmlParts.join(''), data), text: textParts.join('\n').trimEnd() + '\n' }
}

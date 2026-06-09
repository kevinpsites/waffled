/* NOOK — detail & edit screens (parameterized). Functions stored on window.KIOSK
   resolved by the router with a context object. Reuses window._NK vocabulary.
   Screens: eventDetail, eventEdit, taskDetail, photoView, personEdit, personGoals(generalized). */
(function () {
  const { ic, star, rail, topbar, av, avatars } = window._NK;
  const solid = { kevin:'var(--kevin)', kelly:'var(--kelly)', wally:'var(--wally)', lottie:'var(--lottie)', meal:'var(--ink-3)' };
  const tint  = { kevin:'var(--kevin-t)', kelly:'var(--kelly-t)', wally:'var(--wally-t)', lottie:'var(--lottie-t)', meal:'var(--panel)' };
  const txtc  = { kevin:'#1559b8', kelly:'#b22f66', wally:'#167a4a', lottie:'#6a3fc4', meal:'var(--ink-2)' };
  const nameOf = (p)=> p==='meal' ? 'Family' : (p||'kevin').charAt(0).toUpperCase()+(p||'kevin').slice(1);
  const backPill = (label)=>`<div class="pill" data-back style="padding:9px 14px 9px 11px"><svg viewBox="0 0 24 24">${ic.cl}</svg>${label}</div>`;
  const down = `<svg viewBox="0 0 24 24" style="transform:rotate(90deg)">${ic.cr}</svg>`;

  /* ============================ EVENT DETAIL ============================ */
  function eventDetail(ctx){
    ctx = ctx || {};
    const p = ctx.person || 'kevin';
    const title = ctx.title || 'Event';
    const time = ctx.time || '4:00 PM';
    const dur = ctx.dur || '1 hr';
    const date = ctx.date || 'Saturday, May 31';
    const loc = ctx.loc || 'Riverside Fields';
    const note = ctx.note || 'Bring water bottle and shin guards. Carpool with the Bevans — they’ll grab the kids after.';
    const cal = ctx.cal || (p==='meal' ? 'Meals' : nameOf(p));
    // build an at-a-glance day timeline so "before / after" needs no mental math
    function parseT(s){ const m=(s||'').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i); if(!m) return 16; let h=(+m[1])%12; if(/pm/i.test(m[3])) h+=12; return h+(m[2]?(+m[2])/60:0); }
    function fmtT(h){ let ap=h%24<12?'AM':'PM'; let hh=Math.floor(h)%12; if(hh===0)hh=12; const mm=Math.round((h%1)*60); return hh+(mm?':'+String(mm).padStart(2,'0'):'')+' '+ap; }
    function rel(dh){ if(Math.abs(dh)<0.08) return 'now'; const a=Math.abs(dh); const t=a<1?Math.round(a*60)+' min':(Number.isInteger(a)?a:a.toFixed(1))+' hr'+(a>=2?'s':''); return dh<0?t+' before':t+' later'; }
    const t0 = parseT(time);
    const around = [
      {t:t0-2.5, p:'kevin', ti:'Psychiatrist appt'},
      {t:t0, p:p, ti:title, me:true},
      {t:t0+1.5, p:'kelly', ti:'Tele-health call'},
      {t:t0+2.5, p:'meal', ti:'Dinner · Grilled Cheese'},
    ].filter(r=>r.t>=6 && r.t<=23).sort((a,b)=>a.t-b.t);
    const timelineHTML = around.map(r=>{
      if(r.me) return `<div style="display:flex;align-items:center;gap:13px;padding:13px 14px;margin:4px 0;border-radius:var(--r-md);background:${tint[r.p]};border:2px solid ${solid[r.p]}">
        <div style="width:74px;font-size:15px;font-weight:800;color:${txtc[r.p]}">${fmtT(r.t)}</div>
        <div style="width:5px;height:38px;border-radius:99px;background:${solid[r.p]};flex:none"></div>
        <div style="flex:1;font-size:15.5px;font-weight:800;color:${txtc[r.p]}">${r.ti}</div>
        <span class="cat-pill" style="background:#fff;color:${txtc[r.p]}">this event</span></div>`;
      return `<div style="display:flex;align-items:center;gap:13px;padding:9px 14px"><div style="width:74px;font-size:13px;font-weight:700;color:var(--ink-2)">${fmtT(r.t)}</div>
        <div style="width:4px;height:28px;border-radius:99px;background:${solid[r.p]};flex:none;opacity:.55"></div>
        <div style="flex:1;font-size:14px;font-weight:600;color:var(--ink-2)">${r.ti}</div>
        <span class="tiny" style="font-weight:700;color:var(--ink-3)">${rel(r.t-t0)}</span></div>`;
    }).join('');
    return `<div class="nk-kiosk nk">
      ${rail('calendar')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Calendar')}
          <div class="tb-right" style="margin-left:auto">
            <div class="pill" data-toast="🗑️ Event deleted" data-back><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>Delete</div>
            <div class="pill" data-go="eventEdit"><svg viewBox="0 0 24 24">${ic.settings}</svg>Edit</div>
            <button class="btn btn-primary" data-toast="✓ Reminder set for 30 min before" style="font-size:14px;padding:10px 18px"><svg viewBox="0 0 24 24"><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/></svg>Remind me</button>
          </div>
        </div>
        <div style="flex:1;display:grid;grid-template-columns:1.3fr 1fr;gap:22px;padding:2px 30px 26px;min-height:0">
          <!-- left: hero + details -->
          <div style="display:flex;flex-direction:column;min-height:0;gap:16px">
            <div style="border-radius:var(--r-xl);padding:30px 32px;color:#fff;position:relative;overflow:hidden;background:linear-gradient(135deg,${p==='meal'?'#6b6b70,#8a8780':'color-mix(in srgb,'+solid[p]+' 88%,#000),'+solid[p]})">
              <div style="position:absolute;right:-30px;top:-30px;width:180px;height:180px;border-radius:999px;background:rgba(255,255,255,.1)"></div>
              <div style="position:relative;z-index:1">
                <span class="cat-pill" style="background:rgba(255,255,255,.22);color:#fff">${p==='meal'?'🍽️ Meal':avatars[p]+' '+nameOf(p)}</span>
                <div class="nk-serif" style="font-size:34px;font-weight:600;margin:12px 0 8px;line-height:1.1">${title}</div>
                <div style="display:flex;align-items:baseline;gap:14px">
                  <span style="font-size:34px;font-weight:700;letter-spacing:-.02em">${time}</span>
                  <span style="font-size:16px;font-weight:600;opacity:.9">${date} · ${dur}</span>
                </div>
              </div>
            </div>
            <div class="set-card" style="flex:1">
              <div class="set-row"><div class="set-ic">📍</div><div class="set-tx"><div class="st1">Location</div><div class="st2">${loc}</div></div><div class="pill" data-toast="🗺️ Opening directions…" style="font-size:13px">Directions</div></div>
              <div class="set-row"><div class="set-ic">🗓️</div><div class="set-tx"><div class="st1">Calendar</div><div class="st2">${cal} · synced from Google</div></div><div class="dotbox" style="background:${solid[p]}"></div></div>
              <div class="set-row"><div class="set-ic">🔁</div><div class="set-tx"><div class="st1">Repeats</div><div class="st2">${ctx.repeat || 'Every week on this day'}</div></div></div>
              <div class="set-row"><div class="set-ic">👥</div><div class="set-tx"><div class="st1">With</div><div class="st2">${nameOf(p)}${p!=='meal'?' · Kevin (driver)':''}</div></div>
                <div class="avstack">${av(p,'sm')}${p!=='meal'?av('kevin','sm'):''}</div></div>
            </div>
          </div>
          <!-- right: notes + AI -->
          <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
            <div class="card" style="padding:18px 20px">
              <div class="card-h" style="font-size:17px;margin-bottom:10px">Notes</div>
              <div style="font-size:14.5px;line-height:1.55;color:var(--ink-2)">${note}</div>
            </div>
            <div style="display:flex;gap:12px;align-items:flex-start;padding:15px 17px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
              <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
              <div style="flex:1"><div style="font-size:13.5px;font-weight:700;color:var(--ai)">Leave by ${ctx.leave||'3:35 PM'}</div>
                <div class="tiny muted">12 min drive with light traffic. Want me to remind Kevin to leave on time?</div></div>
            </div>
            <div class="card" style="flex:1;padding:18px 20px;display:flex;flex-direction:column">
              <div class="card-h" style="font-size:17px;margin-bottom:8px">Where it falls today</div>
              ${timelineHTML}
              <div class="tiny muted" style="margin-top:auto;padding-top:12px;font-weight:600">No conflicts — you’re clear right before &amp; after.</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ============================ EVENT EDIT / ADD ============================ */
  function eventEdit(ctx){
    ctx = ctx || {};
    const isNew = !ctx.title;
    const p = ctx.person || 'wally';
    const title = ctx.title || '';
    const personChip = (k)=>`<div class="person-chip c-${k} mpchip" data-person="${k}" style="${k===p?'box-shadow:0 0 0 2px '+solid[k]:'opacity:.7'}">${av(k,'sm')}<span style="text-transform:capitalize">${k}</span></div>`;
    return `<div class="nk-kiosk nk">
      ${rail('calendar')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Cancel')}
          <div class="nk-serif" style="font-size:20px;font-weight:600;margin-left:14px">${isNew?'New event':'Edit event'}</div>
          <div class="tb-right" style="margin-left:auto">
            <button class="btn btn-primary" data-save-event style="font-size:14px;padding:10px 20px">${isNew?'Add to calendar':'Save changes'}</button>
          </div>
        </div>
        <div style="flex:1;display:grid;grid-template-columns:1.35fr 1fr;gap:26px;padding:4px 30px 24px;min-height:0">
          <!-- form -->
          <div style="overflow:hidden;display:flex;flex-direction:column;gap:18px;padding-right:6px">
            <div><div class="flabel">What’s happening?</div>
              <div class="field" contenteditable="true" data-ev-title style="font-size:20px;font-family:var(--serif);outline:none">${title||'Soccer practice'}</div></div>
            <div><div class="flabel">Who’s it for?</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">${['kevin','kelly','wally','lottie'].map(personChip).join('')}
                <div class="person-chip mpchip" data-person="meal" style="background:var(--panel);color:var(--ink-2);${p==='meal'?'box-shadow:0 0 0 2px var(--ink-3)':'opacity:.7'}">🍽️ Meal</div></div></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <div><div class="flabel">Date</div><div class="field">Sat, May 31</div></div>
              <div><div class="flabel">Time</div><div class="field">4:00 PM</div></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <div><div class="flabel">Duration</div><div class="sel" style="width:100%;justify-content:space-between">1 hour ${down}</div></div>
              <div><div class="flabel">Repeats</div><div class="sel" style="width:100%;justify-content:space-between">Weekly ${down}</div></div>
            </div>
            <div><div class="flabel">Location</div><div class="field" contenteditable="true" style="outline:none">Riverside Fields</div></div>
            <div><div class="flabel">Driver / who’s coming <span style="color:var(--ink-3);text-transform:none;letter-spacing:0">· optional</span></div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <div class="person-chip c-kevin" style="box-shadow:0 0 0 2px var(--kevin)">${av('kevin','sm')}Kevin · 🚗 driving</div>
                <div class="person-chip c-kelly" style="opacity:.7">${av('kelly','sm')}Kelly</div>
                <div class="person-chip" style="background:var(--panel);color:var(--ink-2);opacity:.85">🚗 Carpool w/ the Bevans</div>
                <div class="pill" style="border-style:dashed">${`<svg viewBox="0 0 24 24" width="14">${ic.plus}</svg>`} Add</div>
              </div></div>
            <div><div class="flabel">Notes</div><div class="field" contenteditable="true" style="outline:none;min-height:64px;color:var(--ink-2);font-weight:500">Add packing list, carpool, or anything to remember…</div></div>
          </div>
          <!-- right: preview + options -->
          <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
            <div class="flabel" style="margin:2px 0 -2px">Live preview</div>
            <div class="ag-ev" data-ev-preview style="box-shadow:var(--sh-2)"><div class="at">4:00 PM</div><div class="bar" data-prev-bar style="background:${solid[p]}"></div><div class="ttl" data-prev-title>${title||'Soccer practice'}</div><span data-prev-av>${p==='meal'?'🍽️':av(p,'sm')}</span></div>
            <div style="display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
              <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
              <div style="flex:1"><div style="font-size:13.5px;font-weight:700;color:var(--ai)">Lands on ${nameOf(p)}’s calendar</div>
                <div class="tiny muted">Color always comes from the person — so it shows ${nameOf(p)}’s color everywhere.</div></div>
            </div>
            <div class="set-card" style="padding:2px 18px">
              <div class="set-row"><div class="set-ic">🔔</div><div class="set-tx"><div class="st1">Reminder</div><div class="st2">30 min before</div></div><div class="toggle on"></div></div>
              <div class="set-row"><div class="set-ic">🚗</div><div class="set-tx"><div class="st1">Travel time</div><div class="st2">Leave-by alert for the driver</div></div><div class="toggle on"></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ============================ TASK / CHORE DETAIL ============================ */
  function taskDetail(ctx){
    ctx = ctx || {};
    const p = (ctx.person && ctx.person!=='grabs') ? ctx.person : 'wally';
    const title = ctx.title || 'Clean room';
    const stars = ctx.stars!=null ? ctx.stars : 1;
    const grabs = ctx.person === 'grabs';
    return `<div class="nk-kiosk nk">
      ${rail('tasks')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Tasks')}
          <div class="tb-right" style="margin-left:auto">
            <div class="pill" data-go="taskEdit"><svg viewBox="0 0 24 24">${ic.settings}</svg>Edit task</div>
            <button class="btn btn-primary" data-task-done style="font-size:14px;padding:10px 20px"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>Mark done${stars?` · +${stars} ★`:''}</button>
          </div>
        </div>
        <div style="flex:1;display:grid;grid-template-columns:1.25fr 1fr;gap:22px;padding:2px 30px 26px;min-height:0">
          <div style="display:flex;flex-direction:column;gap:16px;min-height:0">
            <div class="card" style="padding:26px 28px;display:flex;align-items:center;gap:20px;background:linear-gradient(180deg,#fff,${tint[p]})">
              ${grabs?`<div class="av lg" style="background:var(--wally-t);width:64px;height:64px;font-size:30px">🙌</div>`:`<div class="av lg ${p}" style="width:64px;height:64px;font-size:32px">${avatars[p]}</div>`}
              <div style="flex:1">
                <div class="nk-serif" style="font-size:30px;font-weight:600">${title}</div>
                <div class="tiny muted" style="font-weight:600;margin-top:4px">${grabs?'Up for grabs · anyone can claim':nameOf(p)+' · due today'}</div>
              </div>
              ${stars?`<div style="text-align:center"><div style="font-family:var(--serif);font-size:34px;font-weight:600;color:var(--gold)">★ ${stars}</div><div class="tiny muted" style="font-weight:700">reward</div></div>`:''}
            </div>
            <div class="set-card" style="flex:1">
              <div class="set-row"><div class="set-ic">📅</div><div class="set-tx"><div class="st1">Due</div><div class="st2">Today · resets weekly</div></div></div>
              <div class="set-row"><div class="set-ic">🔁</div><div class="set-tx"><div class="st1">Repeats</div><div class="st2">Every weekday</div></div></div>
              <div class="set-row"><div class="set-ic">⭐</div><div class="set-tx"><div class="st1">Reward</div><div class="st2">${stars?stars+' star'+(stars>1?'s':'')+' when done':'No stars — just helping out'}</div></div></div>
              <div class="set-row"><div class="set-ic">📲</div><div class="set-tx"><div class="st1">Reminder</div><div class="st2">Ping ${nameOf(p)}’s device at 5 PM if not done</div></div><div class="toggle on"></div></div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
            <div class="card" style="flex:1;padding:18px 20px;display:flex;flex-direction:column">
              <div class="card-h" style="font-size:17px;margin-bottom:12px">Recent history</div>
              ${[['Yesterday','✓ Done','9★ this week'],['Tue','✓ Done',''],['Mon','— Skipped',''],['Sun','✓ Done','']].map(([d,s,x])=>`<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--hair-2)"><div class="tiny" style="width:80px;font-weight:700;color:var(--ink-2)">${d}</div><div style="flex:1;font-size:14.5px;font-weight:600;color:${s.includes('Done')?'var(--wally)':'var(--ink-3)'}">${s}</div><div class="tiny muted" style="font-weight:600">${x}</div></div>`).join('')}
              <div class="tiny muted" style="margin-top:auto;padding-top:12px;font-weight:600">${nameOf(p)} has a 🔥 4-day streak on this chore.</div>
            </div>
            <div style="display:flex;gap:12px;align-items:flex-start;padding:15px 17px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
              <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
              <div style="flex:1"><div style="font-size:13.5px;font-weight:700;color:var(--ai)">Best done after school</div>
                <div class="tiny muted">${nameOf(p)} finishes this fastest around 4 PM. Want a gentle nudge then?</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ============================ PHOTO VIEWER ============================ */
  function photoView(ctx){
    ctx = ctx || {};
    const bg = ctx.bg || 'linear-gradient(135deg,#7fc1e8,#3f86c4)';
    const e = ctx.emoji || '🏖️';
    const cap = ctx.cap || 'Beach day';
    return `<div class="nk-kiosk nk">
      ${rail('photos')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Photos')}
          <div class="tb-right" style="margin-left:auto">
            <div class="pill" data-toast="🖼️ Set as kiosk screensaver">Set as screensaver</div>
            <div class="pill" data-toast="🔗 Shared with the family"><svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>Share</div>
            <div class="icon-btn" data-toast="🗑️ Photo removed"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg></div>
          </div>
        </div>
        <div style="flex:1;display:grid;grid-template-columns:1.7fr 1fr;gap:22px;padding:2px 30px 26px;min-height:0">
          <div style="border-radius:var(--r-xl);background:${bg};display:grid;place-items:center;font-size:170px;box-shadow:var(--sh-2);position:relative">
            ${e}
            <div style="position:absolute;left:24px;bottom:22px;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.4)"><div class="nk-serif" style="font-size:30px;font-weight:600">${cap}</div><div style="font-size:14px;font-weight:600;opacity:.92">Saturday · 18 photos in this memory</div></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
            <div class="card" style="padding:18px 20px">
              <div class="card-h" style="font-size:17px;margin-bottom:12px">Reactions</div>
              <div style="display:flex;gap:10px">${['❤️','😍','🎉','👏'].map(em=>`<div class="pill react" data-toast="${em} reacted" style="font-size:20px;padding:8px 14px">${em}</div>`).join('')}</div>
              <div style="display:flex;align-items:center;gap:-6px;margin-top:14px"><div class="avstack">${['kevin','kelly','lottie'].map(p=>av(p,'sm')).join('')}</div><span class="tiny muted" style="margin-left:8px;font-weight:600">Kevin, Kelly & Lottie loved this</span></div>
            </div>
            <div class="card" style="padding:18px 20px">
              <div class="card-h" style="font-size:17px;margin-bottom:10px">Details</div>
              <div class="set-row" style="padding:11px 0"><div class="set-tx"><div class="st1">Album</div></div><div class="tiny muted" style="font-weight:600">Lake trips</div></div>
              <div class="set-row" style="padding:11px 0"><div class="set-tx"><div class="st1">Added by</div></div><span class="tiny muted" style="font-weight:600">Kelly</span></div>
              <div class="set-row" style="padding:11px 0;border-bottom:0"><div class="set-tx"><div class="st1">Date</div></div><div class="tiny muted" style="font-weight:600">Sat, May 31</div></div>
            </div>
            <div style="flex:1;display:flex;gap:12px;align-items:flex-start;padding:15px 17px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
              <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
              <div style="flex:1"><div style="font-size:13.5px;font-weight:700;color:var(--ai)">Part of “Lake Day”</div>
                <div class="tiny muted">Nook grouped 18 photos from Saturday. Want a printed photo book of this trip?</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ============================ PERSON EDIT (from Settings) ============================ */
  function personEdit(ctx){
    ctx = ctx || {};
    const isNew = ctx.new;
    const p = ctx.person || (isNew ? 'wally' : 'kevin');
    const isAdult = p==='kevin' || p==='kelly';
    const emojiSet = { kevin:['🐻','🧔','🏔️','🚴','☕','🎸'], kelly:['🦊','💃','📚','🏃','🎨','🌿'],
      wally:['🐢','🦕','🦖','🐙','🚀','⚽'], lottie:['🦄','🌈','🩰','🎀','🐱','🍓'] };
    const set = emojiSet[p] || emojiSet.wally;
    return `<div class="nk-kiosk nk">
      ${rail('settings')}
      <div style="display:flex;flex-direction:column;min-width:0">
        ${topbar('')}
        <div style="flex:1;display:grid;grid-template-columns:232px 1fr;gap:22px;padding:2px 30px 26px;min-height:0">
          <div style="min-height:0"><div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:4px 6px 12px">SETTINGS</div>
            ${window.KIOSK._catRail ? window.KIOSK._catRail('family') : ''}</div>
          <div style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
              ${backPill('Family')}
              <div class="card-h nk-serif" style="font-size:26px">${isNew?'Add a person':'Edit '+nameOf(p)}</div>
            </div>
            <div style="overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:18px">
              <div style="display:flex;flex-direction:column;gap:16px">
                <div class="set-card" style="padding:20px">
                  <div style="display:flex;align-items:center;gap:16px;margin-bottom:18px">
                    <div class="av lg ${p}" style="width:64px;height:64px;font-size:34px">${avatars[p]}</div>
                    <div><div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:6px">AVATAR</div>
                      <div style="display:flex;gap:7px">${set.map((em,i)=>`<div class="emoji-pick" style="width:36px;height:36px;border-radius:11px;background:${i===0?tint[p]:'var(--panel)'};display:grid;place-items:center;font-size:19px;cursor:pointer;${i===0?'box-shadow:0 0 0 2px '+solid[p]:''}">${em}</div>`).join('')}</div></div>
                  </div>
                  <div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:7px">NAME</div>
                  <div class="field" contenteditable="true" style="margin-bottom:18px;outline:none">${isNew?'New person':nameOf(p)}</div>
                  <div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:9px">ROLE</div>
                  <div class="role-seg" style="margin-bottom:18px"><button class="${isAdult?'on':''}">Adult</button><button>Teen</button><button class="${isAdult?'':'on'}">Kid</button></div>
                  <div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:9px">COLOR</div>
                  <div class="swatch-row">
                    <div class="swatch on" style="background:${solid[p]};color:${solid[p]}"></div>
                    ${['kevin','kelly','wally','lottie'].filter(x=>x!==p).map(x=>`<div class="swatch" style="background:${solid[x]}"></div>`).join('')}
                    <div class="swatch" style="background:var(--gold)"></div>
                  </div>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:16px">
                <div class="set-card">
                  <div class="set-row"><div class="set-ic">🔑</div><div class="set-tx"><div class="st1">Has their own login</div><div class="st2">${isAdult?'On — signed in with Google':'Off — a parent manages this account'}</div></div><div class="toggle ${isAdult?'on':''}"></div></div>
                  <div class="set-row"><div class="set-ic">⭐</div><div class="set-tx"><div class="st1">Chores &amp; rewards</div><div class="st2">Earns stars on the kiosk</div></div><div class="toggle ${isAdult?'':'on'}"></div></div>
                  <div class="set-row"><div class="set-ic">🖥️</div><div class="set-tx"><div class="st1">Show on kiosk</div></div><div class="toggle on"></div></div>
                </div>
                <div style="background:linear-gradient(135deg,#eef7f0,#e4f5ec);border-radius:var(--r-lg);padding:18px 20px">
                  <div style="font-size:15px;font-weight:700;color:#167a4a;margin-bottom:6px">${isAdult?'🔗 Connected to Google':'👶 Kids don’t need a Google account'}</div>
                  <div class="tiny" style="color:var(--ink-2);line-height:1.5">${isAdult?nameOf(p)+' is signed in — their calendars sync automatically and they can manage the family from their phone.':nameOf(p)+' is a profile inside Nook — a name, a color, and a place to earn stars. A parent makes a calendar named "'+nameOf(p)+'" under Calendars to put activities on the shared view.'}</div>
                </div>
                <div style="display:flex;gap:10px">
                  <button class="btn btn-primary" data-go="settings">${isNew?'Save person':'Save changes'}</button>
                  ${isNew?'':`<button class="btn btn-ghost" data-toast="Removed from the family" data-go="settings">Remove</button>`}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ============================ PERSON GOALS (generalized) ============================ */
  const CAT = {
    physical:    {e:'🏃', color:'var(--wally)',  tint:'var(--wally-t)',  txt:'#167a4a', label:'Physical'},
    intellectual:{e:'📚', color:'var(--kevin)',  tint:'var(--kevin-t)',  txt:'#1559b8', label:'Intellectual'},
    spiritual:   {e:'🧘', color:'var(--lottie)', tint:'var(--lottie-t)', txt:'#6a3fc4', label:'Spiritual'},
    creative:    {e:'🎨', color:'var(--kelly)',  tint:'var(--kelly-t)',  txt:'#b22f66', label:'Creative'},
    social:      {e:'🤝', color:'var(--gold)',   tint:'#fdecd6',         txt:'#d98a1c', label:'Social'},
  };
  const catPill = (k)=>{const c=CAT[k];return `<span class="cat-pill" style="background:${c.tint};color:${c.txt}">${c.e} ${c.label}</span>`;};
  function ring(pct, stroke, track, px, inner){
    const dash = (pct*276.5).toFixed(1);
    return `<div style="position:relative;width:${px}px;height:${px}px;flex:none">
      <svg viewBox="0 0 100 100" style="transform:rotate(-90deg)"><circle cx="50" cy="50" r="44" fill="none" stroke="${track}" stroke-width="9"/>
        <circle cx="50" cy="50" r="44" fill="none" stroke="${stroke}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${dash} 276.5"/></svg>
      <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center">${inner}</div></div>`;
  }
  function bcat(k, pct){ const c=CAT[k];
    return `<div class="bcat"><div class="bring">${ring(pct,c.color,c.tint,60,`<span style="font-size:21px">${c.e}</span>`)}</div><div class="blbl">${c.label}</div></div>`;
  }
  function goalMini(person, title, catKey, cur, total, unit, extra){
    const c = CAT[catKey], pct = Math.min(cur/total,1);
    return `<div class="goal-card glist-goal" style="padding:15px 16px;gap:11px">
      <div class="gc-top">${av(person,'sm')}
        <div style="flex:1;min-width:0"><div class="gc-t" style="font-size:15.5px">${title}</div><div style="margin-top:6px">${catPill(catKey)}</div></div>
        <div style="text-align:right;flex:none"><span style="font-family:var(--serif);font-size:23px;font-weight:600">${cur}</span><span class="tiny muted" style="font-weight:700">/${total}${unit||''}</span></div>
      </div>
      <div class="gc-bar"><div style="width:${(pct*100).toFixed(0)}%;background:${c.color}"></div></div>
      ${extra?`<div class="goal-meta">${extra}</div>`:''}
    </div>`;
  }
  const PEOPLE = {
    kevin:{ age:'Dad', streak:'22-day meditation streak', bal:{physical:.5,intellectual:.75,spiritual:.85,creative:.2,social:.6},
      lean:'Kevin leans spiritual & intellectual', idea:'Light on creative — a gentle idea: <b>"Sketch once a week"</b> or <b>"Learn 3 songs on guitar"</b>.',
      goals:[['Meditate daily','spiritual',22,30,'',`<span class="streak-pill">🔥 22-day streak</span>`],
             ['Read 12 books this year','intellectual',5,12,'',`<span class="tiny muted" style="font-weight:600">On book 5</span>`],
             ['1,000 Hours Outside','physical',78,1000,' hrs',`<span class="tiny muted" style="font-weight:600">Part of the family challenge</span>`]] },
    kelly:{ age:'Mom', streak:'on book 5 of 12', bal:{physical:.7,intellectual:.6,spiritual:.4,creative:.65,social:.7},
      lean:'Kelly keeps a strong all-round balance', idea:'Spiritual is a touch light — <b>"Meditate 3× a week"</b> is already going. Keep it up!',
      goals:[['Train for a 10K','physical',6,10,' wk',`<span class="tiny muted" style="font-weight:600">Week 6 of 10 · long run Sat</span>`],
             ['Read 12 books this year','intellectual',5,12,'',`<span class="tiny muted" style="font-weight:600">“Tomorrow, and Tomorrow”</span>`],
             ['Meditate 3× a week','spiritual',2,3,'',`<span class="tiny muted" style="font-weight:600">One more session this week</span>`]] },
    wally:{ age:'Age 7', streak:'6-day reading streak', bal:{physical:.7,intellectual:.6,spiritual:.15,creative:.1,social:.45},
      lean:'Wally leans physical & intellectual', idea:'Light on creative right now. A gentle idea: <b>"Learn 5 songs on ukulele"</b> or <b>"Build a Lego city"</b>.',
      goals:[['Read 20 books','intellectual',12,20,'',`<span class="streak-pill">🔥 6-day reading streak</span><span class="tiny muted" style="font-weight:600">8 to go by August</span>`],
             ['Swim freestyle across the pool','physical',3,4,' steps',`<span class="tiny muted" style="font-weight:600">floats ✓ · kicks ✓ · arms ✓ · breathing</span>`],
             ['1,000 Hours Outside','physical',102,1000,' hrs',`<span class="tiny muted" style="font-weight:600">Part of the family challenge</span>`]] },
    lottie:{ age:'Age 5', streak:'12-day piano streak', bal:{physical:.55,intellectual:.4,spiritual:.3,creative:.8,social:.6},
      lean:'Lottie leans creative & social', idea:'Light on intellectual — <b>"Learn the alphabet sounds"</b> or more picture books could be a fun fit.',
      goals:[['Practice piano 100 days','creative',38,100,'',`<span class="streak-pill">🔥 12 days</span><span class="tiny muted" style="font-weight:600">Next: 50-day badge</span>`],
             ['Read 20 books','intellectual',9,20,'',`<span class="tiny muted" style="font-weight:600">Summer reading challenge</span>`],
             ['1,000 Hours Outside','physical',68,1000,' hrs',`<span class="tiny muted" style="font-weight:600">Part of the family challenge</span>`]] },
  };
  function personGoals(ctx){
    const p = (ctx && ctx.person) || 'wally';
    const d = PEOPLE[p] || PEOPLE.wally;
    const plusW = `<svg viewBox="0 0 24 24" stroke="#fff">${ic.plus}</svg>`;
    const seg = ['Everyone','Kevin','Kelly','Wally','Lottie'].map(n=>`<button class="${n.toLowerCase()===p?'on':''}" data-person="${n.toLowerCase()}">${n}</button>`).join('');
    return `<div class="nk-kiosk nk">
      ${rail('goals')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Goals')}
          <div class="seg seg-person" style="margin-left:14px">${seg}</div>
          <div class="tb-right" style="margin-left:auto"><div class="pill btn-primary" data-go="createGoal" style="color:#fff;border:0">${plusW}New goal for ${nameOf(p)}</div></div></div>
        <div style="flex:1;display:grid;grid-template-columns:1fr 1.4fr;gap:22px;padding:4px 30px 26px;min-height:0">
          <div style="display:flex;flex-direction:column;gap:16px;min-height:0">
            <div class="card" style="padding:22px;display:flex;align-items:center;gap:16px">
              <div class="av lg ${p}" style="width:66px;height:66px;font-size:34px">${avatars[p]}</div>
              <div><div class="nk-serif" style="font-size:26px;font-weight:600">${nameOf(p)}</div><div class="tiny muted" style="font-weight:600">${d.age} · ${d.goals.length} active goals · 🔥 ${d.streak}</div></div>
            </div>
            <div class="card" style="padding:20px 18px">
              <div style="display:flex;align-items:center;margin-bottom:16px"><div class="card-h" style="font-size:17px">Whole-person balance</div><div style="margin-left:auto" class="ai-tag"><svg viewBox="0 0 24 24" fill="currentColor">${ic.spark}</svg></div></div>
              <div class="balance">${Object.keys(CAT).map(k=>bcat(k, d.bal[k])).join('')}</div>
            </div>
            <div style="flex:1;display:flex;gap:12px;align-items:flex-start;padding:16px 18px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
              <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
              <div style="flex:1"><div style="font-size:14px;font-weight:700;color:var(--ai)">${d.lean}</div>
                <div class="tiny muted" style="line-height:1.45">${d.idea} Want me to set one up?</div></div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;min-height:0">
            <div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:2px 2px 12px">${nameOf(p).toUpperCase()}’S GOALS</div>
            <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:13px">
              ${d.goals.map(g=>goalMini(p, g[0], g[1], g[2], g[3], g[4], g[5])).join('')}
            </div>
            <button class="btn btn-ghost" data-go="createGoal" style="align-self:flex-start;margin-top:13px"><svg viewBox="0 0 24 24">${ic.plus}</svg>Add a goal</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  Object.assign(window.KIOSK, {
    eventDetail, eventEdit, taskDetail, photoView, personEdit, personGoals,
  });
})();

/* NOOK — Settings sub-pages: Accounts, Meals, Lists, Display, Notifications, About (+reset).
   Exposes window.KIOSK._catRail / _settingsShell for reuse. Uses window._NK. */
(function () {
  const { ic, star, rail, topbar, av, avatars } = window._NK;
  const down = `<svg viewBox="0 0 24 24" style="transform:rotate(90deg)">${ic.cr}</svg>`;
  const chev = `<div class="chev"><svg viewBox="0 0 24 24">${ic.cr}</svg></div>`;

  const CATS = [['👨‍👩‍👧','Family & people','family'],['🔗','Accounts','accounts'],['📅','Calendars','calendars'],
    ['⭐','Chores & rewards','rewards'],['🍽️','Meals','meals'],['📋','Lists','lists'],
    ['🖥️','Display & kiosk','display'],['🔔','Notifications','notif'],['ⓘ','About','about']];
  function catRail(active){
    return `<div class="cat-rail">${CATS.map(([e,n,k])=>`<div class="cat ${k===active?'on':''}" data-cat="${k}"><span class="ce">${e}</span>${n}</div>`).join('')}</div>`;
  }
  function shell(active, title, sub, body){
    return `<div class="nk-kiosk nk">${rail('settings')}
      <div style="display:flex;flex-direction:column;min-width:0">
        ${topbar('')}
        <div style="flex:1;display:grid;grid-template-columns:232px 1fr;gap:22px;padding:2px 30px 26px;min-height:0">
          <div style="min-height:0"><div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:4px 6px 12px">SETTINGS</div>${catRail(active)}</div>
          <div class="noscroll" style="display:flex;flex-direction:column;min-height:0;overflow-y:auto">
            <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px">
              <div class="card-h nk-serif" style="font-size:26px">${title}</div>
              ${sub?`<div class="muted" style="font-weight:600">${sub}</div>`:''}
            </div>
            <div style="display:flex;flex-direction:column;gap:16px;padding-bottom:6px">${body}</div>
          </div>
        </div>
      </div>
    </div>`;
  }
  const toggleRow = (e,t,s,on)=>`<div class="set-row"><div class="set-ic">${e}</div><div class="set-tx"><div class="st1">${t}</div>${s?`<div class="st2">${s}</div>`:''}</div><div class="toggle ${on?'on':''}"></div></div>`;
  const selRow = (e,t,s,v)=>`<div class="set-row"><div class="set-ic">${e}</div><div class="set-tx"><div class="st1">${t}</div>${s?`<div class="st2">${s}</div>`:''}</div><div class="sel">${v} ${down}</div></div>`;
  const sectionLabel = (t)=>`<div class="st2" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;margin:0 2px 10px">${t}</div>`;

  /* ---------------- ACCOUNTS ---------------- */
  const accountsBody = `
    <div style="display:flex;gap:13px;align-items:center;padding:15px 18px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
      <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
      <div style="flex:1"><div style="font-size:15px;font-weight:700;color:var(--ai)">Two parents keep everything in sync</div>
        <div class="tiny muted">Each adult signs in with their own Google account. Kids never sign in — parents manage their profiles.</div></div>
    </div>
    <div>${sectionLabel('Signed-in adults')}
      <div class="acct"><div class="gicon">G</div><div class="set-tx"><div class="st1">kevin@gmail.com</div><div class="st2">Kevin · Owner · 4 calendars</div></div><div class="synced">Synced 2m ago</div><div style="margin-left:14px" class="pill" style="font-size:12.5px" data-toast="↻ Re-syncing Kevin’s account…">Sync now</div></div>
      <div class="acct"><div class="gicon">G</div><div class="set-tx"><div class="st1">kelly.h@gmail.com</div><div class="st2">Kelly · Adult · 2 calendars</div></div><div class="synced">Synced 2m ago</div><div style="margin-left:14px" class="pill" style="font-size:12.5px" data-toast="↻ Re-syncing Kelly’s account…">Sync now</div></div>
      <button class="btn btn-ghost" data-toast="🔗 Connecting a Google account…" style="align-self:flex-start;margin-top:2px"><svg viewBox="0 0 24 24">${ic.plus}</svg>Connect another account</button>
    </div>
    <div class="set-card">
      <div class="set-row"><div class="set-ic">🏠</div><div class="set-tx"><div class="st1">Nook household</div><div class="st2">“The Family” · 4 people · plan: Family</div></div>${chev}</div>
      ${toggleRow('🔄','Background sync','Keep calendars fresh every 5 minutes',1)}
      <div class="set-row"><div class="set-ic">🚪</div><div class="set-tx"><div class="st1">Sign out of this kiosk</div><div class="st2">You’ll need a parent to sign back in</div></div><div class="pill" data-toast="👋 Signed out of the kiosk">Sign out</div></div>
    </div>`;
  const settingsAccounts = shell('accounts','Accounts','2 connected', accountsBody);

  /* ---------------- MEALS ---------------- */
  const mealsBody = `
    <div class="set-card">
      ${selRow('🍽️','Default servings','Pre-fills new recipes & the planner','5')}
      ${selRow('📅','Auto-plan','How far ahead Nook drafts dinners','Mon – Fri')}
      ${selRow('💰','Budget style','Guides the planner & swaps','Mindful')}
      ${toggleRow('🛒','Auto-build grocery list','Turn a meal plan into a sorted list',1)}
      ${toggleRow('🥫','Assume pantry staples','Skip oil, salt, rice & spices',1)}
    </div>
    <div>${sectionLabel('Dietary notes Nook respects')}
      <div class="set-card">
        <div class="set-row"><div class="av sm lottie">🦄</div><div class="set-tx"><div class="st1">Lottie</div><div class="st2">No spicy food</div></div><div class="pill" style="font-size:12.5px" data-go="addPerson">Edit</div></div>
        <div class="set-row"><div class="av sm wally">🐢</div><div class="set-tx"><div class="st1">Wally</div><div class="st2">No mushrooms</div></div><div class="pill" style="font-size:12.5px" data-go="addPerson">Edit</div></div>
        <div class="set-row" style="border-bottom:0"><div class="set-ic">➕</div><div class="set-tx"><div class="st1" style="color:var(--ink-2)">Add a dietary note</div></div></div>
      </div>
    </div>
    <div class="set-card">
      ${selRow('🔁','Variety','How often a meal can repeat','No repeats this month')}
      ${toggleRow('✨','Use-up suggestions','Nook prioritizes food you already have',1)}
    </div>`;
  const settingsMeals = shell('meals','Meals','Planning preferences', mealsBody);

  /* ---------------- LISTS ---------------- */
  const listRow = (e,n,c,shared)=>`<div class="set-row"><div class="set-ic">${e}</div><div class="set-tx"><div class="st1">${n}</div><div class="st2">${c} items${shared?' · shared with '+shared:''}</div></div>${chev}</div>`;
  const listsBody = `
    <div class="set-card">
      ${listRow('🛒','Groceries','15','everyone')}
      ${listRow('🧳','Lake trip packing','12','everyone')}
      ${listRow('🏠','Household to-do','6','Kevin & Kelly')}
      ${listRow('🎁','Wishlist','9','')}
      <div class="set-row" style="border-bottom:0"><div class="set-ic">➕</div><div class="set-tx"><div class="st1" style="color:var(--ink-2)">New list</div></div></div>
    </div>
    <div class="set-card">
      ${selRow('🧹','Auto-clear checked items','Tidy lists as you go','After 24 hrs')}
      ${toggleRow('✨','Smart suggestions','Nook proposes items as you type',1)}
      ${toggleRow('🔗','Anyone can add by text','Family texts items to the kiosk',1)}
    </div>
    <div style="background:linear-gradient(135deg,#eef7f0,#e4f5ec);border-radius:var(--r-lg);padding:16px 20px">
      <div style="font-size:14.5px;font-weight:700;color:#167a4a;margin-bottom:5px">Grocery is special</div>
      <div class="tiny" style="color:var(--ink-2);line-height:1.55">The Groceries list is built automatically from your meal plan, sorted by aisle, and de-duplicated. You can still add to it by hand anytime.</div>
    </div>`;
  const settingsLists = shell('lists','Lists','7 lists', listsBody);

  /* ---------------- DISPLAY & KIOSK ---------------- */
  const displayBody = `
    <div class="set-card">
      <div class="set-row"><div class="set-ic">🔆</div><div class="set-tx"><div class="st1">Brightness</div><div class="st2">Auto-dims in the evening</div></div>
        <div style="width:160px;height:8px;border-radius:99px;background:var(--panel);position:relative"><div style="width:72%;height:100%;border-radius:99px;background:var(--gold)"></div><div style="position:absolute;left:72%;top:50%;transform:translate(-50%,-50%);width:18px;height:18px;border-radius:99px;background:#fff;box-shadow:var(--sh-1)"></div></div></div>
      ${toggleRow('🌙','Night mode','Dark, dim clock from 9 PM – 6 AM',1)}
      ${selRow('⏱️','Standby after','Tap to wake','10 minutes')}
    </div>
    <div>${sectionLabel('Screensaver')}
      <div class="set-card">
        ${selRow('🖼️','When idle, show','','Family photos')}
        ${selRow('🔀','Album','','“Lake Day” + favorites')}
        ${toggleRow('🕐','Show clock & weather','Overlay on the slideshow',1)}
      </div>
    </div>
    <div>${sectionLabel('Home screen')}
      <div class="set-card">
        ${selRow('🏠','Default screen','What the kiosk rests on','Today')}
        ${toggleRow('🌅','Daily morning summary','A 7 AM “here’s today” card',1)}
        ${selRow('🎨','Accent','Coral by default','Coral')}
      </div>
    </div>`;
  const settingsDisplay = shell('display','Display & kiosk','', displayBody);

  /* ---------------- NOTIFICATIONS ---------------- */
  const notifBody = `
    <div>${sectionLabel('On the kiosk')}
      <div class="set-card">
        ${toggleRow('📅','Upcoming events','15 min before',1)}
        ${toggleRow('🚗','Leave-by alerts','When travel time matters',1)}
        ${toggleRow('⭐','Chore reminders','Afternoon nudge if not done',1)}
        ${toggleRow('🍽️','Dinner prep','“Start the bake” at the right time',0)}
      </div>
    </div>
    <div>${sectionLabel('To parents’ phones')}
      <div class="set-card">
        ${toggleRow('🆕','New events added on the kiosk','',1)}
        ${toggleRow('🎁','Reward redemption requests','Approve from your phone',1)}
        ${toggleRow('📋','Weekly Sunday recap','Calendar, chores & goals',1)}
        ${toggleRow('🔕','Quiet hours','Mute 9 PM – 7 AM',1)}
      </div>
    </div>
    <div style="display:flex;gap:13px;align-items:center;padding:15px 18px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
      <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
      <div style="flex:1"><div style="font-size:14px;font-weight:700;color:var(--ai)">Nook keeps it calm</div>
        <div class="tiny muted">Only the things that need a human get a notification. Everything else just updates quietly on the kiosk.</div></div>
    </div>`;
  const settingsNotif = shell('notif','Notifications','', notifBody);

  /* ---------------- ABOUT (+ hidden reset) ---------------- */
  const aboutBody = `
    <div class="set-card">
      <div class="set-row"><div class="rail-logo nk-serif" style="width:38px;height:38px;font-size:22px;border-radius:11px">N</div><div class="set-tx"><div class="st1">Nook Family Hub</div><div class="st2">Version 1.0 · kiosk demo build</div></div></div>
      <div class="set-row"><div class="set-ic">❓</div><div class="set-tx"><div class="st1">Help & tips</div></div>${chev}</div>
      <div class="set-row"><div class="set-ic">🔒</div><div class="set-tx"><div class="st1">Privacy</div><div class="st2">Your family’s data stays yours</div></div>${chev}</div>
      <div class="set-row" style="border-bottom:0"><div class="set-ic">💬</div><div class="set-tx"><div class="st1">Send feedback</div></div>${chev}</div>
    </div>
    <div>${sectionLabel('Demo controls')}
      <div class="set-card">
        <div class="set-row" style="border-bottom:0"><div class="set-ic">♻️</div><div class="set-tx"><div class="st1">Reset demo</div><div class="st2">Clear checked chores, logged goals, added items & toggles — back to a fresh start</div></div><button class="btn btn-ghost" data-reset-demo style="color:var(--primary)">Reset</button></div>
      </div>
      <div class="tiny muted" style="font-weight:600;line-height:1.5;padding:10px 2px 0">Everything you tap is saved on this device so you can pick up where you left off. Reset wipes that and reloads a clean prototype.</div>
    </div>`;
  const settingsAbout = shell('about','About','', aboutBody);

  Object.assign(window.KIOSK, {
    settingsAccounts, settingsMeals, settingsLists, settingsDisplay, settingsNotif, settingsAbout,
    _catRail: catRail, _settingsShell: shell,
  });
})();

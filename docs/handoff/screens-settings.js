/* NOOK — Settings: home, add person, connected calendars (Google mapping), rewards. Uses window._NK */
(function () {
  const { ic, star, rail, topbar, av, avatars } = window._NK;
  const chev = `<div class="chev"><svg viewBox="0 0 24 24">${ic.cr}</svg></div>`;
  const down = `<svg viewBox="0 0 24 24" style="transform:rotate(90deg)">${ic.cr}</svg>`;
  const sparkW = `<svg viewBox="0 0 24 24" fill="#fff" stroke="#fff">${ic.spark}</svg>`;

  // settings category rail (reuses .cat)
  function catRail(active){
    const cats = [['👨‍👩‍👧','Family & people','family'],['🔗','Accounts','accounts'],['📅','Calendars','calendars'],
      ['⭐','Chores & rewards','rewards'],['🍽️','Meals','meals'],['📋','Lists','lists'],
      ['🖥️','Display & kiosk','display'],['🔔','Notifications','notif'],['ⓘ','About','about']];
    return `<div class="cat-rail">${cats.map(([e,n,k])=>`<div class="cat ${k===active?'on':''}"><span class="ce">${e}</span>${n}</div>`).join('')}</div>`;
  }
  function shell(active, body, topRight){
    return `<div class="nk-kiosk nk">${rail('settings')}
      <div style="display:flex;flex-direction:column;min-width:0">
        ${topbar(topRight||'')}
        <div style="flex:1;display:grid;grid-template-columns:232px 1fr;gap:22px;padding:2px 30px 26px;min-height:0">
          <div style="min-height:0"><div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:4px 6px 12px">SETTINGS</div>${catRail(active)}</div>
          <div class="noscroll" style="display:flex;flex-direction:column;min-height:0;overflow-y:auto">${body}</div>
        </div>
      </div>
    </div>`;
  }
  const solid = { kevin:'var(--kevin)', kelly:'var(--kelly)', wally:'var(--wally)', lottie:'var(--lottie)' };

  /* ---------------- SETTINGS HOME (family) ---------------- */
  function personRow(p, name, role){
    return `<div class="set-row">${av(p,'md')}
      <div class="set-tx"><div class="st1">${name}</div><div class="st2">${role}</div></div>
      <div class="dotbox" style="background:${solid[p]};margin-right:6px"></div>${chev}</div>`;
  }
  const familyBody = `
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px">
      <div class="card-h nk-serif" style="font-size:26px">Family &amp; people</div>
      <div class="muted" style="font-weight:600">4 people</div>
    </div>
    <div style="overflow:hidden;display:flex;flex-direction:column;gap:16px">
      <div class="set-card">
        ${personRow('kevin','Kevin','Adult · Owner · signed in')}
        ${personRow('kelly','Kelly','Adult · signed in')}
        ${personRow('wally','Wally','Kid · age 7 · managed by parents')}
        ${personRow('lottie','Lottie','Kid · age 5 · managed by parents')}
      </div>
      <button class="btn btn-ghost" style="align-self:flex-start"><svg viewBox="0 0 24 24">${ic.plus}</svg>Add a person</button>
      <div class="set-card">
        <div class="set-row"><div class="set-ic">🏡</div><div class="set-tx"><div class="st1">Household name</div><div class="st2">Shows on the kiosk &amp; invites</div></div><div class="sel">The Family ${down}</div></div>
        <div class="set-row"><div class="set-ic">🗓️</div><div class="set-tx"><div class="st1">Week starts on</div></div><div class="sel">Sunday ${down}</div></div>
        <div class="set-row"><div class="set-ic">🌎</div><div class="set-tx"><div class="st1">Time zone</div><div class="st2">Used for every calendar &amp; reminder</div></div><div class="sel">Central ${down}</div></div>
      </div>
    </div>`;
  const KIOSK_settings = shell('family', familyBody);

  /* ---------------- ADD PERSON ---------------- */
  const addBody = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div class="pill" style="padding:9px 14px 9px 11px"><svg viewBox="0 0 24 24">${ic.cl}</svg>Family</div>
      <div class="card-h nk-serif" style="font-size:26px">Add a person</div>
    </div>
    <div style="overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="set-card" style="padding:20px">
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:18px">
            <div class="av lg wally" style="width:64px;height:64px;font-size:34px">🐢</div>
            <div><div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:6px">AVATAR</div>
              <div style="display:flex;gap:7px">${['🐢','🦕','🦖','🐙','🚀','⚽'].map((e,i)=>`<div style="width:36px;height:36px;border-radius:11px;background:${i===0?'var(--wally-t)':'var(--panel)'};display:grid;place-items:center;font-size:19px;${i===0?'box-shadow:0 0 0 2px var(--wally)':''}">${e}</div>`).join('')}</div></div>
          </div>
          <div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:7px">NAME</div>
          <div class="field" style="margin-bottom:18px">Wally</div>
          <div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:9px">ROLE</div>
          <div class="role-seg" style="margin-bottom:18px"><button>Adult</button><button>Teen</button><button class="on">Kid</button></div>
          <div class="st2" style="font-weight:700;color:var(--ink-2);margin-bottom:9px">COLOR</div>
          <div class="swatch-row">
            <div class="swatch on" style="background:var(--wally);color:var(--wally)"></div>
            <div class="swatch" style="background:var(--kevin)"></div>
            <div class="swatch" style="background:var(--kelly)"></div>
            <div class="swatch" style="background:var(--lottie)"></div>
            <div class="swatch" style="background:var(--gold)"></div>
            <div class="swatch" style="background:#e8804f"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="set-card">
          <div class="set-row"><div class="set-ic">🔑</div><div class="set-tx"><div class="st1">Has their own login</div><div class="st2">Off — a parent manages Wally's account</div></div><div class="toggle"></div></div>
          <div class="set-row"><div class="set-ic">⭐</div><div class="set-tx"><div class="st1">Chores &amp; rewards</div><div class="st2">Wally earns stars on the kiosk</div></div><div class="toggle on"></div></div>
          <div class="set-row"><div class="set-ic">🖥️</div><div class="set-tx"><div class="st1">Show on kiosk</div></div><div class="toggle on"></div></div>
        </div>
        <div style="background:linear-gradient(135deg,#eef7f0,#e4f5ec);border-radius:var(--r-lg);padding:18px 20px">
          <div style="font-size:15px;font-weight:700;color:#167a4a;margin-bottom:6px">👶 Kids don't need a Google account</div>
          <div class="tiny" style="color:var(--ink-2);line-height:1.5">Wally is a profile inside Nook — a name, a color, and a place to earn stars. To put his activities on the calendar, a parent makes a calendar called "Wally" and assigns it to him under <b>Calendars</b>. You can also just add his events directly.</div>
        </div>
        <button class="btn btn-primary" style="align-self:flex-start">Save person</button>
      </div>
    </div>`;
  const KIOSK_addPerson = shell('family', addBody);

  /* ---------------- CONNECTED CALENDARS (Google mapping) ---------------- */
  function gcal(color, name, src, owner, hidden){
    return `<div class="set-row">
      <div class="dotbox" style="background:${color}"></div>
      <div class="set-tx"><div class="st1">${name}</div><div class="st2">${src}</div></div>
      <div class="sel" style="margin-right:10px">${owner} ${down}</div>
      <div class="toggle ${hidden?'':'on'}"></div></div>`;
  }
  const calBody = `
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px">
      <div class="card-h nk-serif" style="font-size:26px">Calendars</div>
      <div class="muted" style="font-weight:600">2 accounts · 6 calendars</div>
    </div>
    <div style="overflow:hidden;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;gap:13px;align-items:center;padding:15px 18px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
        <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
        <div style="flex:1"><div style="font-size:15px;font-weight:700;color:var(--ai)">Every calendar maps to a person</div>
          <div class="tiny muted">Color comes from the <b>person</b>, not the source calendar — so a green event is always Wally, wherever it came from.</div></div>
      </div>

      <div>
        <div class="st2" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;margin:0 2px 10px">Connected Google accounts</div>
        <div class="acct"><div class="gicon">G</div><div class="set-tx"><div class="st1">kevin@gmail.com</div><div class="st2">Kevin · 4 calendars</div></div><div class="synced">Synced 2m ago</div></div>
        <div class="acct"><div class="gicon">G</div><div class="set-tx"><div class="st1">kelly.h@gmail.com</div><div class="st2">Kelly · 2 calendars</div></div><div class="synced">Synced 2m ago</div></div>
        <button class="btn btn-ghost" style="align-self:flex-start;margin-top:2px"><svg viewBox="0 0 24 24">${ic.plus}</svg>Connect another account</button>
      </div>

      <div>
        <div class="st2" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;margin:4px 2px 10px">Assign each calendar to a person</div>
        <div class="set-card">
          ${gcal('var(--kevin)','Kevin','kevin@gmail.com','Kevin')}
          ${gcal('var(--ink-3)','Family','kevin@gmail.com','Shared')}
          ${gcal('var(--wally)','Wally','kevin@gmail.com','Wally')}
          ${gcal('var(--lottie)','Lottie','kelly.h@gmail.com','Lottie')}
          ${gcal('var(--kelly)','Kelly','kelly.h@gmail.com','Kelly')}
          ${gcal('#9b8e7d','Kevin · Work','kevin@gmail.com','Kevin',1)}
        </div>
      </div>

      <div style="background:linear-gradient(135deg,#eef7f0,#e4f5ec);border-radius:var(--r-lg);padding:16px 20px">
        <div style="font-size:14.5px;font-weight:700;color:#167a4a;margin-bottom:5px">The recommended setup</div>
        <div class="tiny" style="color:var(--ink-2);line-height:1.55">Both parents connect their own Google account. For each kid, one parent makes a shared calendar ("Wally", "Lottie") and a "Family" calendar — then assigns them here. Kids never sign in; parents manage their events. New events you add on the kiosk land on the right person's calendar automatically.</div>
      </div>
    </div>`;
  const KIOSK_calendarsSettings = shell('calendars', calBody);

  /* ---------------- CHORES & REWARDS ---------------- */
  const styles = [
    ['⭐','Stars bank','Earn stars, save toward goals, redeem in a shop',1],
    ['🏅','Sticker book','Collect stickers to fill themed books',0],
    ['🫙','Goal jar','Fill one jar toward a single big reward',0],
    ['🔥','Streaks & levels','Daily streaks and level-ups, game-style',0],
  ];
  const styleCards = styles.map(([e,t,d,on])=>`<div class="rw-pick ${on?'on':''}"><div class="rwe">${e}</div><div class="rwt">${t}</div><div class="rwd">${d}</div></div>`).join('');
  function kidStyle(p,name,style){ return `<div class="set-row">${av(p,'md')}<div class="set-tx"><div class="st1">${name}</div><div class="st2">Reward style</div></div><div class="sel">${style} ${down}</div></div>`; }
  function shopRow(e,name,cost){ return `<div class="set-row"><div class="set-ic">${e}</div><div class="set-tx"><div class="st1">${name}</div></div><div style="display:inline-flex;align-items:center;gap:4px;color:var(--gold);font-weight:800;font-size:15px">★ ${cost}</div><div style="margin-left:14px" class="chev"><svg viewBox="0 0 24 24">${ic.cr}</svg></div></div>`; }

  const rewardsBody = `
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px">
      <div class="card-h nk-serif" style="font-size:26px">Chores &amp; rewards</div>
      <div class="muted" style="font-weight:600">Customize per kid</div>
    </div>
    <div style="overflow:hidden;display:flex;flex-direction:column;gap:18px">
      <div>
        <div class="st2" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;margin:0 2px 10px">Reward style · household default</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:13px">${styleCards}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
        <div>
          <div class="st2" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;margin:2px 2px 10px">Per kid</div>
          <div class="set-card">${kidStyle('wally','Wally','Stars bank')}${kidStyle('lottie','Lottie','Sticker book')}</div>
          <div class="set-card" style="margin-top:14px">
            <div class="set-row"><div class="set-ic">✅</div><div class="set-tx"><div class="st1">Parent approval to redeem</div></div><div class="toggle on"></div></div>
            <div class="set-row"><div class="set-ic">🔄</div><div class="set-tx"><div class="st1">Chores reset</div></div><div class="sel">Weekly ${down}</div></div>
          </div>
        </div>
        <div>
          <div class="st2" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;margin:2px 2px 10px">Reward shop</div>
          <div class="set-card">
            ${shopRow('🍦','Ice cream',12)}${shopRow('📺','30 min screen time',20)}${shopRow('🎮','Game night',35)}${shopRow('🎢','Theme park day',50)}
          </div>
          <button class="btn btn-ghost" style="margin-top:14px"><svg viewBox="0 0 24 24">${ic.plus}</svg>Add reward</button>
        </div>
      </div>
    </div>`;
  const KIOSK_rewardsSettings = shell('rewards', rewardsBody);

  Object.assign(window.KIOSK, {
    settings: KIOSK_settings, addPerson: KIOSK_addPerson,
    calendarsSettings: KIOSK_calendarsSettings, rewardsSettings: KIOSK_rewardsSettings,
  });
})();

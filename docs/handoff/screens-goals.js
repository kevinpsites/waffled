/* NOOK — Goals: aspirational, per-person + family. Kiosk (home, challenge detail,
   whole-person balance) + iOS (list, log sheet). Uses window._NK */
(function () {
  const { ic, star, rail, topbar, av, avatars } = window._NK;
  const sparkS = `<svg viewBox="0 0 24 24" fill="currentColor">${ic.spark}</svg>`;
  const plusW = `<svg viewBox="0 0 24 24" stroke="#fff">${ic.plus}</svg>`;

  // category model — reuses person palette as category palette
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
  function contribW(p,hrs,max){ return `<div class="contrib-row"><div class="cn" style="color:#fff">${avatars[p]} ${p}</div><div class="cbar"><div style="width:${(hrs/max*100).toFixed(0)}%"></div></div><div class="cv">${hrs} hrs</div></div>`; }

  function goalMini(person, title, catKey, cur, total, unit, extra){
    const c = CAT[catKey], pct = Math.min(cur/total,1);
    return `<div class="goal-card" style="padding:15px 16px;gap:11px">
      <div class="gc-top">${av(person,'sm')}
        <div style="flex:1;min-width:0"><div class="gc-t" style="font-size:15.5px">${title}</div><div style="margin-top:6px">${catPill(catKey)}</div></div>
        <div style="text-align:right;flex:none"><span style="font-family:var(--serif);font-size:23px;font-weight:600">${cur}</span><span class="tiny muted" style="font-weight:700">/${total}${unit||''}</span></div>
      </div>
      <div class="gc-bar"><div style="width:${(pct*100).toFixed(0)}%;background:${c.color}"></div></div>
      ${extra?`<div class="goal-meta">${extra}</div>`:''}
    </div>`;
  }

  /* ===================== KIOSK · GOALS HOME ===================== */
  const challengeHero = `<div class="challenge">
    <div style="display:flex;align-items:center;gap:28px;position:relative;z-index:1">
      ${ring(0.312,'#fff','rgba(255,255,255,.25)',124,`<div><div style="font-family:var(--serif);font-size:30px;font-weight:600;line-height:1">312</div><div style="font-size:10.5px;opacity:.85;font-weight:700;margin-top:2px">of 1,000 hrs</div></div>`)}
      <div style="flex:1;min-width:0">
        <span class="cat-pill" style="background:rgba(255,255,255,.2);color:#fff">🌲 Family challenge · 2026</span>
        <div class="nk-serif" style="font-size:29px;font-weight:600;margin:9px 0 3px">1,000 Hours Outside</div>
        <div style="font-size:13px;opacity:.9;font-weight:600;margin-bottom:11px">On pace for 1,000 by November · 688 to go</div>
        <div style="max-width:400px">${contribW('wally',102,110)}${contribW('kevin',78,110)}${contribW('lottie',68,110)}${contribW('kelly',64,110)}</div>
      </div>
      <div style="align-self:stretch;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;gap:14px">
        <span class="streak-pill" style="background:rgba(255,255,255,.2);color:#fff">🔥 9-day streak</span>
        <button class="btn" style="background:#fff;color:#2f7d4f">${plusW.replace('#fff','#2f7d4f')}Log time</button>
      </div>
    </div>
  </div>`;

  function famGoalCard(emoji, title, sub, cur, total, color, pct){
    return `<div class="goal-card" style="padding:16px 18px;gap:11px">
      <div class="gc-top"><div style="width:40px;height:40px;border-radius:12px;background:var(--panel);display:grid;place-items:center;font-size:21px;flex:none">${emoji}</div>
        <div style="flex:1"><div class="gc-t" style="font-size:16px">${title}</div><div class="tiny muted" style="margin-top:2px;font-weight:600">${sub}</div></div>
        <div style="text-align:right"><span style="font-family:var(--serif);font-size:22px;font-weight:600">${cur}</span><span class="tiny muted" style="font-weight:700">/${total}</span></div></div>
      <div class="gc-bar"><div style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  }

  const goalsTop = `<div class="tb-right" style="gap:10px">
      <div class="seg"><button class="on">Everyone</button><button>Kevin</button><button>Kelly</button><button>Wally</button><button>Lottie</button></div>
      <div class="pill btn-primary" style="color:#fff;border:0">${plusW}New goal</div>
    </div>`;

  const KIOSK_goals = `<div class="nk-kiosk nk">
    ${rail('goals')}
    <div style="display:flex;flex-direction:column;min-width:0">
      ${topbar(goalsTop)}
      <div style="flex:1;display:grid;grid-template-columns:1.5fr 1fr;gap:20px;padding:2px 30px 24px;min-height:0">

        <div style="display:flex;flex-direction:column;gap:16px;min-height:0">
          <div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:2px 2px -4px">FAMILY GOALS</div>
          ${challengeHero}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            ${famGoalCard('🍽️','Dinner together','5× a week · this week',4,5,'var(--primary)',80)}
            ${famGoalCard('🏞️','State parks','Visited together this year',7,30,'var(--kevin)',23)}
          </div>
        </div>

        <div style="display:flex;flex-direction:column;min-height:0">
          <div style="display:flex;align-items:center;margin:2px 2px 10px">
            <div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3)">PERSONAL GOALS</div>
            <div style="margin-left:auto" class="tiny muted" style="font-weight:600">7 active</div>
          </div>
          <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:11px">
            ${goalMini('wally','Read 20 books','intellectual',12,20,'',`<span class="streak-pill">🔥 6-day reading streak</span>`)}
            ${goalMini('lottie','Practice piano 100 days','creative',38,100,'',`<span class="streak-pill">🔥 12 days</span><span class="tiny muted" style="font-weight:600">Next: 50-day badge</span>`)}
            ${goalMini('kelly','Train for a 10K','physical',6,10,' wk',`<span class="tiny muted" style="font-weight:600">Week 6 of 10 · long run Sat</span>`)}
            ${goalMini('kevin','Meditate daily','spiritual',22,30,'',`<span class="streak-pill">🔥 22-day streak</span>`)}
          </div>
          <div style="margin-top:13px;display:flex;gap:12px;align-items:center;padding:13px 15px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
            <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
            <div style="flex:1"><div style="font-size:13.5px;font-weight:700;color:var(--ai)">Wally's close to his reading goal</div>
              <div class="tiny muted">8 books to go by August — that's ~1 a week. Want me to add 20 min of reading to his afternoons?</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ===================== KIOSK · CHALLENGE DETAIL ===================== */
  const milestones = [
    ['done','🌱','100 hrs','reached Mar'],['done','🌳','250 hrs','reached May'],
    ['now','⛺','500 hrs','188 to go'],['','🏔️','750 hrs','—'],['','🏆','1,000 hrs','Big reward'],
  ];
  const mtrack = milestones.map(([s,e,l,r])=>`<div class="mnode ${s}"><div class="mdot2">${e}</div><div class="ml">${l}</div><div class="mr">${r}</div></div>`).join('');
  const logRows = [
    ['Sat','wally','Creek hike + fort building','3.5 hrs'],['Sat','kelly','Farmers market walk','1.0 hr'],
    ['Fri','kevin','Evening bike ride w/ Wally','1.5 hrs'],['Thu','lottie','Backyard + park after school','2.0 hrs'],
    ['Wed','wally','Soccer practice','1.0 hr'],
  ].map(([d,p,what,amt])=>`<div class="logrow"><div class="lwhen">${d}</div>${av(p,'sm')}<div class="lwhat">${what}</div><div class="lamt">+${amt}</div></div>`).join('');

  const KIOSK_goalDetail = `<div class="nk-kiosk nk">
    ${rail('goals')}
    <div style="display:flex;flex-direction:column;min-width:0">
      <div class="topbar"><div class="pill" style="padding:9px 14px 9px 11px"><svg viewBox="0 0 24 24">${ic.cl}</svg>Goals</div>
        <div class="tb-right" style="margin-left:auto"><div class="pill"><svg viewBox="0 0 24 24">${ic.settings}</svg>Edit goal</div><div class="pill btn-primary" style="color:#fff;border:0">${plusW}Log time</div></div></div>
      <div style="padding:2px 30px 14px">
        <div class="challenge" style="padding:24px 30px">
          <div style="display:flex;align-items:center;gap:30px;position:relative;z-index:1">
            ${ring(0.312,'#fff','rgba(255,255,255,.25)',132,`<div><div style="font-family:var(--serif);font-size:33px;font-weight:600;line-height:1">312</div><div style="font-size:11px;opacity:.85;font-weight:700;margin-top:2px">of 1,000 hrs</div></div>`)}
            <div style="flex:1"><span class="cat-pill" style="background:rgba(255,255,255,.2);color:#fff">🌲 Family challenge · 2026</span>
              <div class="nk-serif" style="font-size:32px;font-weight:600;margin:9px 0 4px">1,000 Hours Outside</div>
              <div style="font-size:13.5px;opacity:.9;font-weight:600">Started Jan 1 · 31% complete · 🔥 9-day streak · on pace for November</div></div>
            <div style="align-self:flex-start;text-align:right"><div style="font-size:12px;opacity:.85;font-weight:700">THIS WEEK</div><div style="font-family:var(--serif);font-size:28px;font-weight:600">14.5 hrs</div><div style="font-size:12px;opacity:.85;font-weight:600">+2.5 vs last week</div></div>
          </div>
        </div>
      </div>
      <div style="flex:1;display:grid;grid-template-columns:1.25fr 1fr;gap:20px;padding:0 30px 24px;min-height:0">
        <div style="display:flex;flex-direction:column;gap:16px;min-height:0">
          <div class="card" style="padding:20px 22px"><div class="card-h" style="font-size:17px;margin-bottom:18px">Milestones</div><div class="mtrack">${mtrack}</div></div>
          <div class="card" style="padding:18px 20px;flex:1">
            <div class="card-h" style="font-size:17px;margin-bottom:12px">Hours by person</div>
            ${[['wally',102],['kevin',78],['lottie',68],['kelly',64]].map(([p,h])=>`<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--hair-2)">${av(p,'sm')}<div style="flex:1;font-size:15px;font-weight:600;text-transform:capitalize">${p}</div><div style="flex:2;height:8px;border-radius:99px;background:var(--panel)"><div style="width:${(h/110*100).toFixed(0)}%;height:100%;border-radius:99px;background:var(--${p})"></div></div><div class="tiny muted" style="width:54px;text-align:right;font-weight:700">${h} hrs</div></div>`).join('')}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
          <div class="card" style="flex:1;padding:18px 20px;display:flex;flex-direction:column;min-height:0">
            <div style="display:flex;align-items:center;margin-bottom:4px"><div class="card-h" style="font-size:17px">Recent activity</div><div style="margin-left:auto" class="tiny muted" style="font-weight:600">log</div></div>
            <div style="overflow:hidden">${logRows}</div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-start;padding:15px 17px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
            <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
            <div style="flex:1"><div style="font-size:13.5px;font-weight:700;color:var(--ai)">Rainy stretch ahead</div>
              <div class="tiny muted">Thu–Sat look wet. You're 2.5 hrs ahead of pace, so you've got buffer — or make Wednesday a long park day to bank hours.</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ===================== KIOSK · WHOLE-PERSON BALANCE ===================== */
  function bcat(k, pct){ const c=CAT[k];
    return `<div class="bcat"><div class="bring">${ring(pct,c.color,c.tint,60,`<span style="font-size:21px">${c.e}</span>`)}</div><div class="blbl">${c.label}</div></div>`;
  }
  const KIOSK_personGoals = `<div class="nk-kiosk nk">
    ${rail('goals')}
    <div style="display:flex;flex-direction:column;min-width:0">
      <div class="topbar"><div class="pill" style="padding:9px 14px 9px 11px"><svg viewBox="0 0 24 24">${ic.cl}</svg>Goals</div>
        <div class="seg" style="margin-left:14px"><button>Everyone</button><button>Kevin</button><button>Kelly</button><button class="on">Wally</button><button>Lottie</button></div>
        <div class="tb-right" style="margin-left:auto"><div class="pill btn-primary" style="color:#fff;border:0">${plusW}New goal for Wally</div></div></div>
      <div style="flex:1;display:grid;grid-template-columns:1fr 1.4fr;gap:22px;padding:4px 30px 26px;min-height:0">
        <div style="display:flex;flex-direction:column;gap:16px;min-height:0">
          <div class="card" style="padding:22px;display:flex;align-items:center;gap:16px">
            <div class="av lg wally" style="width:66px;height:66px;font-size:34px">🐢</div>
            <div><div class="nk-serif" style="font-size:26px;font-weight:600">Wally</div><div class="tiny muted" style="font-weight:600">Age 7 · 3 active goals · 🔥 6-day streak</div></div>
          </div>
          <div class="card" style="padding:20px 18px">
            <div style="display:flex;align-items:center;margin-bottom:16px"><div class="card-h" style="font-size:17px">Whole-person balance</div><div style="margin-left:auto" class="ai-tag">${sparkS}</div></div>
            <div class="balance">${bcat('physical',0.7)}${bcat('intellectual',0.6)}${bcat('spiritual',0.15)}${bcat('creative',0.1)}${bcat('social',0.45)}</div>
          </div>
          <div style="flex:1;display:flex;gap:12px;align-items:flex-start;padding:16px 18px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
            <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
            <div style="flex:1"><div style="font-size:14px;font-weight:700;color:var(--ai)">Wally leans physical & intellectual</div>
              <div class="tiny muted" style="line-height:1.45">Light on creative right now. A gentle idea: <b>"Learn 5 songs on ukulele"</b> or <b>"Build a Lego city"</b> — want me to set one up?</div></div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;min-height:0">
          <div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:2px 2px 12px">WALLY'S GOALS</div>
          <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:13px">
            ${goalMini('wally','Read 20 books','intellectual',12,20,'',`<span class="streak-pill">🔥 6-day reading streak</span><span class="tiny muted" style="font-weight:600">8 to go by August</span>`)}
            ${goalMini('wally','Swim freestyle across the pool','physical',3,4,' steps',`<span class="tiny muted" style="font-weight:600">Milestone: floats ✓ · kicks ✓ · arms ✓ · breathing</span>`)}
            ${goalMini('wally','1,000 Hours Outside','physical',102,1000,' hrs',`<span class="tiny muted" style="font-weight:600">Part of the family challenge</span>`)}
          </div>
          <button class="btn btn-ghost" style="align-self:flex-start;margin-top:13px">${ic.plus?`<svg viewBox="0 0 24 24">${ic.plus}</svg>`:''}Add a goal</button>
        </div>
      </div>
    </div>
  </div>`;

  /* ===================== iOS · GOALS ===================== */
  const statusBar = `<div class="ios-status nk"><div>9:41</div><div class="dots">
    <svg viewBox="0 0 18 12" width="18" fill="currentColor"><rect x="0" y="7" width="3" height="5" rx="1"/><rect x="5" y="4" width="3" height="8" rx="1"/><rect x="10" y="1.5" width="3" height="10.5" rx="1"/><rect x="14.5" y="0" width="3" height="12" rx="1" opacity=".35"/></svg>
    <svg viewBox="0 0 18 13" width="17" fill="currentColor"><path d="M9 3.2c2.3 0 4.4.9 6 2.4l1.2-1.4A11 11 0 0 0 9 1 11 11 0 0 0 1.8 4.2L3 5.6A8.7 8.7 0 0 1 9 3.2z"/><path d="M9 7c1.2 0 2.3.5 3.1 1.2l1.3-1.4A6.7 6.7 0 0 0 9 5a6.7 6.7 0 0 0-4.4 1.8l1.3 1.4A4.7 4.7 0 0 1 9 7z"/><circle cx="9" cy="11" r="1.6"/></svg>
    <svg viewBox="0 0 26 13" width="25" fill="none" stroke="currentColor"><rect x=".7" y=".7" width="21" height="11.6" rx="3" opacity=".4"/><rect x="2.4" y="2.4" width="16" height="8.2" rx="1.6" fill="currentColor" stroke="none"/><rect x="23.2" y="4" width="2" height="5" rx="1" fill="currentColor" stroke="none" opacity=".5"/></svg>
  </div></div>`;
  function tabbar(active){
    const T={today:['home','Today'],calendar:['calendar','Calendar'],meals:['meals','Meals'],family:['tasks','Family']};
    const tab=(k)=>{const[i,l]=T[k];return `<div class="ios-tab ${k===active?'on':''}"><svg viewBox="0 0 24 24">${ic[i]}</svg>${l}</div>`;};
    return `<div class="ios-tabbar nk">${tab('today')}${tab('calendar')}
      <div class="ios-tab" style="margin-top:-22px"><div style="width:54px;height:54px;border-radius:999px;background:var(--primary);display:grid;place-items:center;box-shadow:var(--sh-3)"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round">${ic.spark}</svg></div></div>
      ${tab('meals')}${tab('family')}</div><div class="ios-home-ind"></div>`;
  }
  function iosGoal(person, title, catKey, cur, total, unit, extra){
    const c=CAT[catKey], pct=Math.min(cur/total,1);
    return `<div class="card" style="padding:14px 15px;margin-bottom:11px">
      <div style="display:flex;align-items:flex-start;gap:11px">${av(person,'sm')}
        <div style="flex:1;min-width:0"><div class="nk-serif" style="font-size:15.5px;font-weight:600">${title}</div><div style="margin-top:6px">${catPill(catKey)}</div></div>
        <div style="text-align:right"><span style="font-family:var(--serif);font-size:20px;font-weight:600">${cur}</span><span class="tiny muted" style="font-weight:700">/${total}${unit||''}</span></div></div>
      <div class="gc-bar" style="margin-top:11px"><div style="width:${(pct*100).toFixed(0)}%;height:100%;border-radius:99px;background:${c.color}"></div></div>
      ${extra?`<div class="tiny muted" style="font-weight:600;margin-top:9px">${extra}</div>`:''}
    </div>`;
  }
  const IOS_goals = `<div class="nk-ios nk">${statusBar}
    <div class="ios-body noscroll" style="display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
        <div class="ios-h1" style="margin:0">Goals</div>
        <div style="margin-left:auto" class="icon-btn" style="width:36px;height:36px;background:var(--primary)"><svg viewBox="0 0 24 24" stroke="#fff">${ic.plus}</svg></div>
      </div>
      <div style="display:flex;gap:7px;margin:12px 0 14px"><span class="tag" style="font-size:13px;padding:7px 15px;background:var(--ink);color:#fff">Mine</span><span class="tag" style="font-size:13px;padding:7px 15px">Family</span><span class="tag" style="font-size:13px;padding:7px 15px">Wally</span><span class="tag" style="font-size:13px;padding:7px 15px">Lottie</span></div>
      <div style="background:linear-gradient(135deg,#2f7d4f,#3a9b62);border-radius:var(--r-lg);padding:16px 18px;color:#fff;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:14px">
          ${ring(0.312,'#fff','rgba(255,255,255,.25)',64,`<span style="font-size:13px;font-weight:800">31%</span>`)}
          <div style="flex:1"><span class="cat-pill" style="background:rgba(255,255,255,.2);color:#fff;font-size:10px">🌲 Family · 2026</span>
            <div class="nk-serif" style="font-size:18px;font-weight:600;margin:5px 0 2px">1,000 Hours Outside</div>
            <div style="font-size:11.5px;opacity:.9;font-weight:600">312 hrs · 🔥 9-day streak</div></div>
        </div>
        <button class="btn" style="width:100%;justify-content:center;background:#fff;color:#2f7d4f;margin-top:13px"><svg viewBox="0 0 24 24" stroke="#2f7d4f">${ic.plus}</svg>Log time outside</button>
      </div>
      <div style="font-size:12.5px;font-weight:800;letter-spacing:.04em;color:var(--ink-3);margin:0 2px 10px">MY GOALS</div>
      <div style="flex:1;overflow:hidden">
        ${iosGoal('kelly','Train for a 10K','physical',6,10,' wk','Week 6 · long run Saturday')}
        ${iosGoal('kelly','Read 12 books this year','intellectual',5,12,'','On book 5 · “Tomorrow, and Tomorrow”')}
        ${iosGoal('kelly','Meditate 3× a week','spiritual',2,3,'','One more session this week')}
      </div>
    </div>${tabbar('family')}</div>`;

  /* iOS · LOG TIME SHEET (capture-companion) */
  const IOS_goalLog = `<div class="nk-ios nk">${statusBar}
    <div class="ios-body noscroll" style="display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:8px;margin:4px 0 6px"><div class="tiny muted" style="font-weight:700">Cancel</div>
        <div style="margin-left:auto" class="ai-tag"><svg viewBox="0 0 24 24">${ic.spark}</svg>1,000 Hours</div></div>
      <div class="nk-serif" style="font-size:26px;font-weight:600;margin-bottom:4px">Log time outside</div>
      <div class="tiny muted" style="font-weight:600;margin-bottom:18px">Saturday · adds to the family challenge</div>
      <div style="font-size:12.5px;font-weight:800;color:var(--ink-2);margin-bottom:9px">HOW LONG?</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:8px">
        ${['30m','1 hr','1.5 hr','2 hr'].map((t,i)=>`<div style="padding:14px 0;text-align:center;border-radius:var(--r-md);font-size:15px;font-weight:700;${i===2?'background:var(--wally);color:#fff':'background:var(--panel);color:var(--ink)'}">${t}</div>`).join('')}
      </div>
      <div class="tiny muted" style="font-weight:600;margin-bottom:18px">Or enter a custom amount</div>
      <div style="font-size:12.5px;font-weight:800;color:var(--ink-2);margin-bottom:9px">WHO WAS OUTSIDE?</div>
      <div style="display:flex;gap:10px;margin-bottom:18px">
        ${[['wally',1],['lottie',1],['kevin',0],['kelly',0]].map(([p,on])=>`<div style="display:flex;flex-direction:column;align-items:center;gap:5px">${av(p,'md')}<div style="width:18px;height:18px;border-radius:99px;${on?'background:var(--wally);border:0':'background:#fff;border:2px solid var(--hair)'};display:grid;place-items:center">${on?'<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="3.5"><path d="M5 12l5 5 9-10"/></svg>':''}</div></div>`).join('')}
      </div>
      <div style="font-size:12.5px;font-weight:800;color:var(--ink-2);margin-bottom:9px">WHAT DID YOU DO? <span style="color:var(--ai)">· Nook guessed</span></div>
      <div class="field" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">🌳 Creek hike + fort building</div>
      <div style="display:flex;gap:7px;flex-wrap:wrap">${['🚲 Bike ride','🏞️ Park','⚽ Sports','🌱 Garden'].map(c=>`<span class="tag" style="font-size:12.5px;padding:6px 12px">${c}</span>`).join('')}</div>
      <button class="btn btn-primary" style="margin-top:auto;justify-content:center">Add 1.5 hrs to the challenge</button>
    </div>${tabbar('family')}</div>`;

  Object.assign(window.KIOSK, { goals: KIOSK_goals, goalDetail: KIOSK_goalDetail, personGoals: KIOSK_personGoals });
  Object.assign(window.IOS, { goals: IOS_goals, goalLog: IOS_goalLog });
})();

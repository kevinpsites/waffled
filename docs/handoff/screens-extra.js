/* NOOK — extra screens: meal picker, screensaver, add photos, task edit, kids goal list.
   Parameterized functions on window.KIOSK. Uses window._NK + helpers from other screen files. */
(function () {
  const { ic, star, rail, topbar, av, avatars } = window._NK;
  const solid = { kevin:'var(--kevin)', kelly:'var(--kelly)', wally:'var(--wally)', lottie:'var(--lottie)' };
  const tint  = { kevin:'var(--kevin-t)', kelly:'var(--kelly-t)', wally:'var(--wally-t)', lottie:'var(--lottie-t)' };
  const backPill = (label)=>`<div class="pill" data-back style="padding:9px 14px 9px 11px"><svg viewBox="0 0 24 24">${ic.cl}</svg>${label}</div>`;
  const down = `<svg viewBox="0 0 24 24" style="transform:rotate(90deg)">${ic.cr}</svg>`;
  const nameOf = (p)=> p.charAt(0).toUpperCase()+p.slice(1);

  /* ============================ MEAL PICKER ============================ */
  const RX = [
    {t:'German Pancakes',e:'🥞',g:'g-pan',cat:'Breakfast',min:20},
    {t:'Eggs, Bacon & Toast',e:'🍳',g:'g-pan',cat:'Breakfast',min:15},
    {t:'Overnight Oats',e:'🥣',g:'g-cookie',cat:'Breakfast',min:5},
    {t:'Yogurt & Berries',e:'🫐',g:'g-veg',cat:'Breakfast',min:5},
    {t:'Grilled Cheese',e:'🧀',g:'g-pan',cat:'Lunch',min:10},
    {t:'Turkey Wraps',e:'🌯',g:'g-taco',cat:'Lunch',min:10},
    {t:'Tomato Soup',e:'🍅',g:'g-lentil',cat:'Lunch',min:20},
    {t:'Chicken Salad',e:'🥗',g:'g-veg',cat:'Lunch',min:15},
    {t:'Ravioli & Sausage Bake',e:'🍝',g:'g-pasta',cat:'Dinner',min:35},
    {t:'Chorizo Street Tacos',e:'🌮',g:'g-taco',cat:'Dinner',min:25},
    {t:'Sheet-Pan Salmon',e:'🐟',g:'g-salmon',cat:'Dinner',min:25},
    {t:'Madras Lentils',e:'🍛',g:'g-lentil',cat:'Dinner',min:30},
    {t:'Honey-Garlic Wings',e:'🍗',g:'g-wing',cat:'Dinner',min:40},
    {t:'Margherita Flatbread',e:'🍕',g:'g-pizza',cat:'Dinner',min:20},
    {t:'Fruit & Cheese',e:'🧺',g:'g-veg',cat:'Snack',min:5},
    {t:"Grandma's Oatmeal Cookies",e:'🍪',g:'g-cookie',cat:'Snack',min:25},
  ];
  function mealPicker(ctx){
    ctx = ctx || {};
    const slot = ctx.slot || 'Dinner';
    const day = ctx.day || 'this day';
    const filters = ['Breakfast','Lunch','Dinner','Snack'];
    const list = RX.filter(r=>r.cat===slot);
    const all = RX;
    const card = (r)=>`<div class="rc mp-card" data-pick="${r.t}" data-slot="${slot}" data-day="${day}">
      <div class="rc-img ${r.g}" style="height:104px;font-size:38px">${r.e}</div>
      <div class="rc-b" style="padding:12px 14px 14px">
        <div class="rc-t" style="font-size:16px">${r.t}</div>
        <div class="rc-m"><span>🕐 ${r.min} min</span><span>${r.cat}</span></div>
      </div></div>`;
    return `<div class="nk-kiosk nk">
      ${rail('meals')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Meals')}
          <div class="nk-serif" style="font-size:20px;font-weight:600;margin-left:14px">Add a ${slot.toLowerCase()} · ${day}</div>
          <div class="tb-right" style="margin-left:auto">
            <div class="ai-bar" style="width:280px;padding:8px 10px 8px 14px"><div class="ai-spark" style="width:26px;height:26px"><svg viewBox="0 0 24 24">${ic.spark}</svg></div><div class="ph" style="font-size:14px">Search or paste a recipe…</div></div>
          </div>
        </div>
        <div style="padding:0 30px 12px;display:flex;gap:8px;align-items:center">
          ${filters.map(f=>`<div class="mp-filter tag" data-slot="${f}" style="font-size:13.5px;padding:8px 16px;${f===slot?'background:var(--ink);color:#fff':''}">${f}</div>`).join('')}
          <div style="margin-left:auto" class="tiny muted" style="font-weight:600">${list.length} ${slot.toLowerCase()} ideas</div>
        </div>
        <div style="flex:1;overflow:hidden;padding:0 30px 24px;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:min-content;gap:16px;align-content:start">
          ${(list.length?list:all).map(card).join('')}
        </div>
      </div>
    </div>`;
  }

  /* ============================ SCREENSAVER ============================ */
  function screensaver(){
    const photos = [
      ['linear-gradient(135deg,#7fc1e8,#3f86c4)','🏖️'],['linear-gradient(135deg,#a8d98a,#6fae5a)','🐢'],
      ['linear-gradient(135deg,#e58ab0,#cf5e8e)','🩰'],['linear-gradient(135deg,#f6c24f,#e89a3c)','🎂'],
      ['linear-gradient(135deg,#b59ae8,#8a5cf0)','🦄'],
    ];
    const thumbs = photos.map(([bg,e],i)=>`<div style="width:54px;height:54px;border-radius:12px;background:${bg};display:grid;place-items:center;font-size:24px;box-shadow:var(--sh-2);${i===0?'outline:3px solid #fff':''}">${e}</div>`).join('');
    return `<div class="nk" data-back style="width:1280px;height:800px;position:relative;background:linear-gradient(135deg,#7fc1e8,#3f86c4);overflow:hidden;cursor:pointer;display:grid;place-items:center">
      <div style="position:absolute;inset:0;background:radial-gradient(120% 120% at 70% 20%, rgba(0,0,0,0), rgba(0,0,0,.42))"></div>
      <div style="position:absolute;top:46px;left:54px;color:#fff;text-shadow:0 2px 16px rgba(0,0,0,.35)">
        <div class="nk-serif" style="font-size:120px;font-weight:600;line-height:.9">3:56</div>
        <div style="font-size:26px;font-weight:600;margin-top:6px;opacity:.95">Saturday, May 31 · 60° &amp; clear</div>
      </div>
      <div style="position:absolute;right:54px;top:46px;text-align:right;color:#fff;text-shadow:0 2px 16px rgba(0,0,0,.35)">
        <div style="font-size:64px">☀️</div>
      </div>
      <div style="font-size:220px;filter:drop-shadow(0 12px 40px rgba(0,0,0,.35))">🏖️</div>
      <div style="position:absolute;left:54px;bottom:90px;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.4)">
        <div class="nk-serif" style="font-size:34px;font-weight:600">Lake Day</div>
        <div style="font-size:16px;font-weight:600;opacity:.9">18 photos from Saturday</div>
      </div>
      <div style="position:absolute;left:50%;bottom:36px;transform:translateX(-50%);display:flex;gap:12px;align-items:center">${thumbs}</div>
      <div style="position:absolute;right:54px;bottom:40px;color:#fff;font-size:15px;font-weight:700;opacity:.9;display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.22);backdrop-filter:blur(8px);padding:10px 16px;border-radius:999px">Tap anywhere to wake</div>
    </div>`;
  }

  /* ============================ ADD PHOTOS ============================ */
  function addPhotos(){
    const recent = [
      ['linear-gradient(135deg,#7fc1e8,#3f86c4)','🏖️'],['linear-gradient(135deg,#f6c24f,#e89a3c)','🎂'],
      ['linear-gradient(135deg,#a8d98a,#6fae5a)','🐢'],['linear-gradient(135deg,#e58ab0,#cf5e8e)','🩰'],
      ['linear-gradient(135deg,#f0a87f,#dd7a52)','🍝'],['linear-gradient(135deg,#b59ae8,#8a5cf0)','🦄'],
      ['linear-gradient(135deg,#8fd3c4,#4fae9b)','⚽'],['linear-gradient(135deg,#f5c98a,#e3a14f)','🥞'],
      ['linear-gradient(135deg,#c9b8a8,#9b8e7d)','🏞️'],['linear-gradient(135deg,#d6e9f5,#9cc5e0)','❄️'],
    ];
    const tile = (bg,e,i)=>`<div class="ap-tile" data-i="${i}" style="aspect-ratio:1;border-radius:var(--r-md);background:${bg};display:grid;place-items:center;font-size:34px;position:relative;cursor:pointer;box-shadow:var(--sh-1)">${e}
      <div class="ap-chk" style="position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:99px;background:rgba(255,255,255,.85);border:2px solid rgba(255,255,255,.6)"></div></div>`;
    return `<div class="nk-kiosk nk">
      ${rail('photos')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Photos')}
          <div class="nk-serif" style="font-size:20px;font-weight:600;margin-left:14px">Add photos</div>
          <div class="tb-right" style="margin-left:auto"><button class="btn btn-primary" data-toast="📷 Added to “Lake Day”" data-back>Add <span class="ap-count">0</span> photos</button></div>
        </div>
        <div style="padding:0 30px 14px;display:flex;gap:12px">
          ${[['📷','Take a photo'],['🖼️','Phone library'],['☁️','Shared album'],['🔗','Import a link']].map(([e,t])=>`<div class="pill" data-toast="Opening ${t.toLowerCase()}…" style="font-size:14px;padding:11px 16px">${e} ${t}</div>`).join('')}
        </div>
        <div style="margin:0 30px 14px;display:flex;align-items:center;gap:13px;padding:13px 18px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
          <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
          <div style="flex:1"><div style="font-size:14.5px;font-weight:700;color:var(--ai)">Nook found 18 new photos from Saturday</div><div class="tiny muted">Tap the ones to add — Nook groups them into a memory and updates the screensaver.</div></div>
        </div>
        <div style="flex:1;overflow:hidden;padding:0 30px 24px">
          <div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:0 2px 12px">RECENT</div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px">${recent.map(([bg,e],i)=>tile(bg,e,i)).join('')}</div>
        </div>
      </div>
    </div>`;
  }

  /* ============================ TASK EDIT ============================ */
  function taskEdit(ctx){
    ctx = ctx || {};
    const p = (ctx.person && ctx.person!=='grabs') ? ctx.person : 'wally';
    const title = ctx.title || 'Clean room';
    const stars = ctx.stars!=null ? ctx.stars : 1;
    const personChip = (k)=>`<div class="person-chip c-${k}" style="${k===p?'box-shadow:0 0 0 2px '+solid[k]:'opacity:.7'}">${av(k,'sm')}<span style="text-transform:capitalize">${k}</span></div>`;
    return `<div class="nk-kiosk nk">
      ${rail('tasks')}
      <div style="display:flex;flex-direction:column;min-width:0">
        <div class="topbar">${backPill('Cancel')}
          <div class="nk-serif" style="font-size:20px;font-weight:600;margin-left:14px">Edit task</div>
          <div class="tb-right" style="margin-left:auto"><button class="btn btn-primary" data-back data-toast="✓ Task saved">Save changes</button></div>
        </div>
        <div style="flex:1;display:grid;grid-template-columns:1.3fr 1fr;gap:26px;padding:4px 30px 24px;min-height:0">
          <div style="overflow:hidden;display:flex;flex-direction:column;gap:18px;padding-right:6px">
            <div><div class="flabel">Task</div><div class="field" contenteditable="true" style="font-size:19px;outline:none">${title}</div></div>
            <div><div class="flabel">Who does it?</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">${['kevin','kelly','wally','lottie'].map(personChip).join('')}
                <div class="person-chip" style="background:var(--panel);color:var(--ink-2);opacity:.7">🙌 Up for grabs</div></div></div>
            <div><div class="flabel">Reward</div>
              <div style="display:flex;align-items:center;gap:12px"><div class="stepper"><button>−</button><span class="sv" style="display:inline-flex;align-items:center;gap:4px;color:var(--gold)">★ ${stars}</span><button>+</button></div>
                <div class="tiny muted" style="font-weight:600">Stars earned when it’s done</div></div></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <div><div class="flabel">Repeats</div><div class="sel" style="width:100%;justify-content:space-between">Every weekday ${down}</div></div>
              <div><div class="flabel">Resets</div><div class="sel" style="width:100%;justify-content:space-between">Weekly ${down}</div></div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
            <div class="flabel" style="margin:2px 0 -2px">Options</div>
            <div class="set-card" style="padding:2px 18px">
              <div class="set-row"><div class="set-ic">📲</div><div class="set-tx"><div class="st1">Reminder</div><div class="st2">Ping at 5 PM if not done</div></div><div class="toggle on"></div></div>
              <div class="set-row"><div class="set-ic">📸</div><div class="set-tx"><div class="st1">Photo proof</div><div class="st2">Snap a pic to mark done</div></div><div class="toggle"></div></div>
              <div class="set-row"><div class="set-ic">👀</div><div class="set-tx"><div class="st1">Show on kiosk</div></div><div class="toggle on"></div></div>
            </div>
            <button class="btn btn-ghost" data-back data-toast="🗑️ Task deleted" style="align-self:flex-start;color:var(--primary)"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>Delete task</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ============================ KIDS GOAL LIST (consistent w/ Family & Couple) ============================ */
  function goalsKids(){
    const railFn = window.KIOSK._goalRail, header = window.KIOSK._listHeader, gCard = window.KIOSK._goalCard, avStack = window.KIOSK._avStack;
    const num = (c,t)=>`<span style="font-family:var(--serif);font-size:22px;font-weight:600">${c}</span><span class="tiny muted" style="font-weight:700">/${t}</span>`;
    const plusW = `<svg viewBox="0 0 24 24" stroke="#fff">${ic.plus}</svg>`;
    const featured = `<div class="goal-card goal-feature" data-go="goalEach" style="cursor:pointer;background:linear-gradient(135deg,#e8804f,#f0a062);color:#fff;border-radius:var(--r-xl);padding:24px 28px;gap:14px">
      <div style="display:flex;align-items:center;gap:18px;position:relative;z-index:1">
        <div style="width:60px;height:60px;border-radius:16px;background:rgba(255,255,255,.2);display:grid;place-items:center;font-size:30px;flex:none">📚</div>
        <div style="flex:1">
          <span class="cat-pill" style="background:rgba(255,255,255,.22);color:#fff">⭐ Featured · 👥 Each tracks their own</span>
          <div class="nk-serif" style="font-size:26px;font-weight:600;margin:8px 0 3px">Summer Reading Challenge</div>
          <div style="font-size:13px;opacity:.92;font-weight:600">20 books each by Sept 1 · Wally 12 · Lottie 9 · 21 read together</div>
        </div>
        <div style="text-align:right"><div style="font-size:12px;opacity:.85;font-weight:700">TOGETHER</div><div style="font-family:var(--serif);font-size:30px;font-weight:600">21<span style="font-size:17px;opacity:.8">/40</span></div><div class="tiny" style="opacity:.85;font-weight:600">tap to open ›</div></div>
      </div>
    </div>`;
    return `<div class="nk-kiosk nk">
      ${rail('goals')}
      <div style="display:flex;flex-direction:column;min-width:0">
        ${topbar(`<div class="tb-right"><div class="pill btn-primary" data-go="createGoal" style="color:#fff;border:0">${plusW}New goal</div></div>`)}
        <div style="flex:1;display:grid;grid-template-columns:250px 1fr;gap:22px;padding:2px 30px 24px;min-height:0">
          ${railFn('kids')}
          <div style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
            ${header(avStack(['wally','lottie']),'The Kids','4 goals · Wally &amp; Lottie')}
            ${featured}
            <div style="font-size:12.5px;font-weight:800;letter-spacing:.04em;color:var(--ink-3);margin:18px 2px 11px">MORE KID GOALS</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              ${gCard('🦷','Brush teeth twice a day','Habit · both kids',86,'var(--wally)',num(6,7),null,'shared')}
              ${gCard('🛏️','Make the bed','Habit · this week',60,'var(--lottie)',num(3,5),null,'shared')}
              ${gCard('🎹','Lottie: piano 100 days','Count · creative',38,'var(--kelly)',num(38,100),null,'each')}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  Object.assign(window.KIOSK, { mealPicker, screensaver, addPhotos, taskEdit, goalsKids });
})();

/* NOOK — Meals & Recipes deep-dive screens.
   Kiosk: library, detail, plan-week, grocery.  iOS: browse, detail.
   Uses window._NK from screens-kiosk-home.js */
(function () {
  const { ic, star, rail, topbar, av, avatars } = window._NK;

  // tiny inline icons we need here
  const I = {
    heart:'<path d="M12 20s-7-4.6-9.2-9C1.3 8 2.6 4.7 5.8 4.5 8 4.3 9.4 5.8 12 8.6c2.6-2.8 4-4.3 6.2-4.1 3.2.2 4.5 3.5 3 6.5C19 15.4 12 20 12 20z"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3 2"/>',
    cal:'<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    swap:'<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    chevL:'<path d="M15 5l-7 7 7 7"/>',
    share:'<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
    check:'<path d="M5 12l5 5 9-10"/>',
  };
  const heartFull = (c)=>`<svg viewBox="0 0 24 24" fill="${c}" stroke="none">${I.heart}</svg>`;
  const heartLine = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" stroke-width="2">${I.heart}</svg>`;
  const sparkS = `<svg viewBox="0 0 24 24" fill="currentColor">${ic.spark}</svg>`;

  /* ============ RECIPE DATA ============ */
  const R = {
    ravioli:{t:'Ravioli & Sausage Bake', g:'g-pasta', e:'🍝', min:35, serves:5, cat:'Dinner', tags:['Family classic'], when:'On Fri', fav:1},
    tacos:  {t:'Chorizo Street Tacos', g:'g-taco', e:'🌮', min:25, serves:5, cat:'Dinner', tags:['Quick'], when:'On Thu'},
    pancake:{t:'German Pancakes', g:'g-pan', e:'🥞', min:20, serves:4, cat:'Breakfast', tags:['Kid favorite','fav']},
    pork:   {t:'Slow-Cooker Pulled Pork', g:'g-pork', e:'🍖', min:'6 hr', serves:8, cat:'Dinner', tags:['Batch']},
    wings:  {t:'Honey-Garlic Wings', g:'g-wing', e:'🍗', min:40, serves:4, cat:'Dinner', tags:[]},
    cookie: {t:"Grandma's Oatmeal Cookies", g:'g-cookie', e:'🍪', min:25, serves:'24', cat:'Snack', tags:['Just added'], fav:1},
    lentil: {t:'Madras Lentils', g:'g-lentil', e:'🍛', min:30, serves:4, cat:'Dinner', tags:['Vegetarian','veg']},
    salmon: {t:'Sheet-Pan Salmon', g:'g-salmon', e:'🐟', min:25, serves:4, cat:'Dinner', tags:['Quick']},
    pizza:  {t:'Margherita Flatbread', g:'g-pizza', e:'🍕', min:20, serves:4, cat:'Dinner', tags:['Vegetarian','veg']},
  };

  function recipeCard(key, big){
    const r = R[key];
    const tagEl = (r.tags||[]).filter(t=>t!=='fav'&&t!=='veg').map(t=>{
      const cls = r.tags.includes('veg') && (t==='Vegetarian') ? 'veg' : (r.tags.includes('fav')&&t==='Kid favorite'?'fav':'');
      return `<span class="tag ${cls}">${t}</span>`;
    }).join('');
    return `<div class="rc">
      <div class="rc-img ${r.g}">${r.e}
        <div class="rc-fav">${r.fav?heartFull('var(--primary)'):heartLine}</div>
        ${r.when?`<div class="rc-when">📅 ${r.when}</div>`:''}
      </div>
      <div class="rc-b">
        <div class="rc-t">${r.t}</div>
        <div class="rc-m"><span>🕐 ${r.min}${typeof r.min==='number'?' min':''}</span><span>🍽️ ${typeof r.serves==='number'?'Serves '+r.serves:r.serves}</span></div>
        <div class="rc-tags">${tagEl}</div>
      </div>
    </div>`;
  }

  /* ============ KIOSK · RECIPE LIBRARY ============ */
  const cats = [
    ['📚','All recipes',48,1],['❤️','Favorites',12,0],['🌅','Breakfast',9,0],['🥪','Lunch',7,0],
    ['🍽️','Dinner',21,0],['🍪','Snacks',6,0],['🍰','Desserts',5,0],['⚡','Under 30 min',14,0],['🌱','Vegetarian',8,0],
  ];
  const catRail = cats.map(([e,n,c,on])=>`<div class="cat ${on?'on':''}"><span class="ce">${e}</span>${n}<span class="cc">${c}</span></div>`).join('');

  const libGrid = ['ravioli','tacos','pancake','lentil','wings','salmon','pork','pizza','cookie']
    .map(k=>recipeCard(k)).join('');

  const libTop = `<div class="tb-right">
      <button class="btn btn-ai" style="font-size:14px;padding:10px 18px">${sparkS.replace('<svg','<svg style="width:17px;height:17px"')}Plan my week</button>
      <div class="pill"><svg viewBox="0 0 24 24">${I.search}</svg>Search</div>
      <div class="pill btn-primary" style="color:#fff;border:0"><svg viewBox="0 0 24 24" stroke="#fff">${ic.plus}</svg>Add recipe</div>
    </div>`;

  const KIOSK_recipes = `<div class="nk-kiosk nk">
    ${rail('meals')}
    <div style="display:flex;flex-direction:column;min-width:0">
      ${topbar(libTop)}
      <div style="flex:1;display:grid;grid-template-columns:208px 1fr;gap:18px;padding:4px 30px 26px;min-height:0">
        <div style="display:flex;flex-direction:column;min-height:0">
          <div class="cat-rail">${catRail}</div>
          <div style="margin-top:14px;padding:15px;border-radius:var(--r-lg);background:linear-gradient(150deg,#efeafc,#f5effe)">
            <div class="ai-tag" style="margin-bottom:8px">${sparkS}Nook</div>
            <div style="font-size:14px;font-weight:700;line-height:1.35;margin-bottom:4px">Out of ideas?</div>
            <div class="tiny muted" style="line-height:1.4">I can build a week from what you already have & love.</div>
          </div>
        </div>
        <div style="overflow:hidden;display:flex;flex-direction:column;min-width:0">
          <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:12px">
            <div class="card-h nk-serif" style="font-size:22px">All recipes</div>
            <div class="muted" style="font-weight:600">48 saved</div>
            <div style="margin-left:auto" class="seg"><button class="on">Recent</button><button>A–Z</button><button>Most cooked</button></div>
          </div>
          <div style="flex:1;overflow:hidden;display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:min-content;gap:16px;align-content:start">
            ${libGrid}
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ============ KIOSK · RECIPE DETAIL ============ */
  const ingredients = [
    ['1 lb','Ground Italian sausage'],['25 oz','Cheese ravioli (refrigerated)'],['24 oz','Marinara sauce'],
    ['2 cups','Mozzarella, shredded'],['½ cup','Parmesan, grated'],['3 cloves','Garlic, minced'],
    ['2 cups','Baby spinach'],['—','Fresh basil & red pepper'],
  ];
  const steps = [
    'Heat oven to 375°F. Brown the sausage with garlic in a skillet, 6–8 min; drain.',
    'Stir spinach into the warm sausage until just wilted, then fold in the marinara.',
    'Layer half the ravioli in a baking dish, top with half the sauce and mozzarella. Repeat.',
    'Finish with parmesan, cover with foil and bake 20 min. Uncover and broil 4 min to brown.',
    'Rest 5 minutes, scatter fresh basil, and serve.',
  ];
  const ingEl = ingredients.map(([q,n])=>`<div class="ing"><div class="ck"></div><div class="iq">${q}</div><div class="inm">${n}</div></div>`).join('');
  const stepEl = steps.map((s,i)=>`<div class="step"><div class="sn">${i+1}</div><div class="st">${s}</div></div>`).join('');

  const detailTop = `<div style="display:flex;align-items:center;gap:14px;flex:1">
      <div class="pill" style="padding:9px 14px 9px 11px"><svg viewBox="0 0 24 24">${I.chevL}</svg>Recipes</div>
      <div class="tb-right">
        <div class="icon-btn"><svg viewBox="0 0 24 24" fill="var(--primary)" stroke="none">${I.heart}</svg></div>
        <button class="btn btn-ghost" style="font-size:14px;padding:10px 16px"><svg viewBox="0 0 24 24">${I.cal||ic.calendar}</svg>Schedule</button>
        <button class="btn btn-primary" style="font-size:14px;padding:10px 18px"><svg viewBox="0 0 24 24">${ic.bag}</svg>Add to grocery list</button>
      </div>
    </div>`;

  const KIOSK_recipeDetail = `<div class="nk-kiosk nk">
    ${rail('meals')}
    <div style="display:flex;flex-direction:column;min-width:0">
      <div class="topbar" style="padding-bottom:10px">${detailTop}</div>
      <div style="flex:1;display:grid;grid-template-columns:1fr 1.15fr;gap:22px;padding:2px 30px 26px;min-height:0">

        <!-- left: hero + ingredients -->
        <div style="display:flex;flex-direction:column;min-height:0">
          <div class="g-pasta" style="height:210px;border-radius:var(--r-lg);position:relative;display:grid;place-items:center;font-size:78px;box-shadow:var(--sh-2)">🍝
            <div class="ai-tag" style="position:absolute;left:14px;bottom:14px">${sparkS}AI picked for tonight</div>
          </div>
          <div class="nk-serif" style="font-size:30px;font-weight:600;margin:16px 0 6px">Ravioli & Sausage Bake</div>
          <div style="display:flex;gap:18px;align-items:center;color:var(--ink-2);font-weight:600;font-size:14.5px">
            <span>🕐 35 min</span><span>🍽️ Serves 5</span>
            <span style="color:var(--gold)">★ 4.8</span><span class="tiny">cooked 6×</span>
          </div>
          <div style="flex:1;overflow:hidden;margin-top:14px;background:var(--card);border-radius:var(--r-lg);box-shadow:var(--sh-2);padding:16px 18px;display:flex;flex-direction:column">
            <div style="display:flex;align-items:center;margin-bottom:4px">
              <div class="card-h" style="font-size:17px">Ingredients</div>
              <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
                <span class="tiny muted" style="font-weight:700">Servings</span>
                <div class="stepper"><button>−</button><span class="sv">5</span><button>+</button></div>
              </div>
            </div>
            <div style="overflow:hidden">${ingEl}</div>
          </div>
        </div>

        <!-- right: AI note + steps -->
        <div style="display:flex;flex-direction:column;min-height:0">
          <div style="display:flex;gap:12px;align-items:center;padding:14px 16px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe);margin-bottom:14px">
            <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
            <div style="flex:1"><div style="font-size:14px;font-weight:700;color:var(--ai)">7 of 8 ingredients are already on hand</div>
              <div class="tiny muted">Only marinara is missing — I added it to this week's grocery list.</div></div>
          </div>
          <div style="flex:1;overflow:hidden;background:var(--card);border-radius:var(--r-lg);box-shadow:var(--sh-2);padding:18px 20px;display:flex;flex-direction:column">
            <div style="display:flex;align-items:center;margin-bottom:2px">
              <div class="card-h" style="font-size:17px">Method</div>
              <div style="margin-left:auto" class="pill" style="font-size:13px;padding:7px 13px">🔊 Read aloud</div>
            </div>
            <div style="overflow:hidden">${stepEl}</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ============ KIOSK · PLAN MY WEEK (AI) ============ */
  const planDays = [
    ['Mon','1','salmon','🐟','Sheet-Pan Salmon','25 min · Serves 5','Quick — Wally has soccer','lock'],
    ['Tue','2','tacos','🌮','Chorizo Street Tacos','25 min · Serves 5','Wally & Lottie favorite',''],
    ['Wed','3','lentil','🍛','Madras Lentils','30 min · Serves 5','Meatless Wednesday',''],
    ['Thu','4','wings','🍗','Honey-Garlic Wings','40 min · Serves 5','Uses chicken in freezer',''],
    ['Fri','5','ravioli','🍝','Ravioli & Sausage Bake','35 min · Serves 5','Family classic — Friday',''],
  ];
  const planRows = planDays.map(([dow,dt,key,e,t,m,reason,locked])=>`<div class="plan-day" data-day="${dow} Jun ${dt}" data-slot="Dinner">
      <div class="pd-day"><div class="pd-dow">${dow}</div><div class="pd-dt">Jun ${dt}</div></div>
      <div class="pd-img ${R[key].g}">${e}</div>
      <div class="pd-b"><div class="pd-t">${t}</div><div class="pd-m">${m}</div>
        <div class="reason">${sparkS.replace('<svg','<svg style="width:11px;height:11px"')}${reason}</div></div>
      <div class="pd-act">
        <div class="pd-icon pd-swap" title="Swap this dinner"><svg viewBox="0 0 24 24">${I.swap}</svg></div>
        <div class="pd-icon pd-lock ${locked?'lock':''}" title="Lock this night"><svg viewBox="0 0 24 24">${I.lock}</svg></div>
      </div>
    </div>`).join('');

  const KIOSK_plan = `<div class="nk-kiosk nk">
    ${rail('meals')}
    <div style="display:flex;flex-direction:column;min-width:0">
      ${topbar(`<div class="tb-right"><div class="pill">Cancel</div></div>`)}
      <div style="flex:1;display:grid;grid-template-columns:300px 1fr;gap:20px;padding:0 30px 24px;min-height:0">

        <!-- constraints -->
        <div style="display:flex;flex-direction:column;min-height:0">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <div class="ai-spark" style="width:34px;height:34px"><svg viewBox="0 0 24 24" style="width:19px;height:19px">${ic.spark}</svg></div>
            <div class="nk-serif" style="font-size:24px;font-weight:600">Plan my week</div>
          </div>
          <div class="tiny muted" style="margin-bottom:12px;line-height:1.4">Tell Nook the guardrails — it drafts the meals and the grocery list in one go.</div>
          <div class="flabel">Plan which meal?</div>
          <div class="seg seg-plantype" style="margin-bottom:14px"><button data-pt="Breakfast">Breakfast</button><button data-pt="Lunch">Lunch</button><button class="on" data-pt="Dinner">Dinner</button></div>
          <div class="flabel">Which days?</div>
          <div style="display:flex;gap:6px;margin-bottom:16px">
            ${[['S',0],['M',1],['T',1],['W',1],['T',1],['F',1],['S',0]].map(([d,on])=>`<div class="plan-day-chip ${on?'on':''}" style="flex:1;text-align:center;padding:9px 0;border-radius:var(--r-sm);font-size:13px;font-weight:700;cursor:pointer;${on?'background:var(--ink);color:#fff':'background:var(--panel);color:var(--ink-2)'}">${d}</div>`).join('')}
          </div>
          <div class="card" style="padding:6px 18px 8px;margin-bottom:14px">
            <div class="constraint"><span class="cl">Cooking for</span><span class="cv plan-cv sel" data-opts="5 · whole family|4 · no kids|2 · just us|6 · + guests">5 · whole family <svg viewBox="0 0 24 24" style="width:14px;height:14px;transform:rotate(90deg)"><path d="M9 6l6 6-6 6"/></svg></span></div>
            <div class="constraint"><span class="cl">Budget</span><span class="cv plan-cv sel" data-opts="Mindful|No limit|Tight week|Stock up">Mindful <svg viewBox="0 0 24 24" style="width:14px;height:14px;transform:rotate(90deg)"><path d="M9 6l6 6-6 6"/></svg></span></div>
            <div class="constraint" style="border-bottom:0"><span class="cl">Variety</span><span class="cv plan-cv sel" data-opts="No repeats this month|No repeats this week|Repeats OK">No repeats this month <svg viewBox="0 0 24 24" style="width:14px;height:14px;transform:rotate(90deg)"><path d="M9 6l6 6-6 6"/></svg></span></div>
          </div>
          <div class="card" style="padding:15px 18px;margin-bottom:14px">
            <div class="tiny" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Use up first</div>
            <div class="use-up-list" style="display:flex;gap:7px;flex-wrap:wrap">
              <span class="use-chip">🥬 Spinach <b style="opacity:.45;margin-left:2px">×</b></span><span class="use-chip">🍗 Chicken <b style="opacity:.45;margin-left:2px">×</b></span><span class="use-chip">🧀 Mozzarella <b style="opacity:.45;margin-left:2px">×</b></span>
              <span class="use-add" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:700;border:1.5px dashed var(--hair);color:var(--ink-3);padding:5px 11px;border-radius:999px;cursor:pointer">+ Add</span>
            </div>
          </div>
          <div class="card" style="padding:15px 18px">
            <div class="tiny" style="font-weight:800;color:var(--ink-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Keep in mind</div>
            <div class="tiny muted" style="line-height:1.5">Lottie skips spicy · Tue & Thu are busy — keep them under 30 min.</div>
          </div>
        </div>

        <!-- proposed week -->
        <div style="display:flex;flex-direction:column;min-height:0">
          <div style="display:flex;align-items:center;margin-bottom:12px">
            <div class="card-h nk-serif" style="font-size:22px">Here's your week</div>
            <div style="margin-left:auto;display:flex;gap:8px">
              <div class="pill" style="font-size:13px"><svg viewBox="0 0 24 24">${I.swap}</svg>Reshuffle</div>
            </div>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;gap:11px;overflow:hidden">${planRows}</div>
          <div style="margin-top:14px;display:flex;align-items:center;gap:14px;padding:15px 18px;border-radius:var(--r-lg);background:var(--ink);color:#fff">
            <div style="flex:1"><div style="font-size:16px;font-weight:700">Looks good?</div>
              <div class="tiny" style="opacity:.7">Adds 5 dinners to the calendar & builds an 18-item grocery list.</div></div>
            <button class="btn" style="background:#fff;color:var(--ink)">Add week & build list</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ============ KIOSK · GROCERY LIST ============ */
  // meal color dots map (which meal an item is for)
  const mc = { salmon:'var(--kevin)', tacos:'var(--primary)', lentil:'var(--lottie)', wings:'var(--gold)', ravioli:'var(--wally)' };
  function gitem(name, qty, mealKeys, done){
    const dots = mealKeys.map(k=>`<span class="gdot" style="background:${mc[k]}"></span>`).join('');
    return `<div class="gitem ${done?'done':''}"><div class="gck">${done?`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--ink-3)" stroke-width="3">${I.check}</svg>`:''}</div>
      <span class="gnm">${name}</span><span class="gfor">${dots}</span><span class="gq">${qty}</span></div>`;
  }
  const aisle = (e,n,items)=>`<div style="margin-bottom:16px"><div class="aisle-h"><span class="ae">${e}</span><span class="an">${n}</span><span class="ac">${items.length}</span></div>${items.join('')}</div>`;
  // [aisleEmoji, aisleName, [ [name, qty, mealKeys, done?], ... ] ]
  const AISLES = [
    ['🥬','Produce',[['Baby spinach','2 bunches',['ravioli','salmon']],['Lemons','3',['salmon']],['Cilantro','1 bunch',['tacos']],['Yellow onion','2',['tacos','lentil'],true]]],
    ['🍖','Meat & Seafood',[['Salmon fillets','1.5 lb',['salmon']],['Chorizo','1 lb',['tacos']],['Italian sausage','1 lb',['ravioli']]]],
    ['🧀','Dairy & Chilled',[['Cheese ravioli','25 oz',['ravioli']],['Mozzarella','2 cups',['ravioli']],['Cotija cheese','4 oz',['tacos']]]],
    ['🥫','Pantry',[['Marinara sauce','24 oz',['ravioli']],['Corn tortillas','12 ct',['tacos']],['Red lentils','2 cups',['lentil']],['Coconut milk','1 can',['lentil'],true],['Honey','1 bottle',['wings']]]],
  ];
  const MEALMETA = { salmon:['🐟','Mon · Sheet-Pan Salmon'], tacos:['🌮','Tue · Chorizo Tacos'], lentil:['🍛','Wed · Madras Lentils'], wings:['🍗','Thu · Honey-Garlic Wings'], ravioli:['🍝','Fri · Ravioli Bake'] };

  const groceryTop = `<div class="tb-right">
      <div class="pill"><svg viewBox="0 0 24 24">${I.share}</svg>Send to phone</div>
      <div class="pill">🛒 Order online</div>
    </div>`;

  function KIOSK_grocery(ctx){
    ctx = ctx || {}; const sort = ctx.sort==='meal' ? 'meal' : 'aisle';
    let leftHTML, rightHTML;
    if(sort==='aisle'){
      const b = AISLES.map(([e,n,items])=>aisle(e,n,items.map(it=>gitem.apply(null,it))));
      leftHTML = b[0]+b[2]; rightHTML = b[1]+b[3];
    } else {
      const flat=[]; AISLES.forEach(([e,n,items])=>items.forEach(it=>flat.push(it)));
      const order=['salmon','tacos','lentil','wings','ravioli'];
      const blocks = order.map(k=>{ const [me,mn]=MEALMETA[k]; const its=flat.filter(it=>it[2].includes(k));
        return `<div style="margin-bottom:16px"><div class="aisle-h"><span class="ae">${me}</span><span class="an">${mn}</span><span class="ac">${its.length}</span></div>${its.map(it=>gitem.apply(null,it)).join('')}</div>`; });
      leftHTML = blocks.slice(0,3).join(''); rightHTML = blocks.slice(3).join('');
    }
    const seg = `<div class="seg seg-grocsort"><button class="${sort==='aisle'?'on':''}" data-sort="aisle">By aisle</button><button class="${sort==='meal'?'on':''}" data-sort="meal">By meal</button></div>`;
    return `<div class="nk-kiosk nk">
      ${rail('lists')}
      <div style="display:flex;flex-direction:column;min-width:0">
        ${topbar(groceryTop)}
        <div style="flex:1;display:grid;grid-template-columns:1.4fr 1fr;gap:22px;padding:2px 30px 26px;min-height:0">
          <div style="display:flex;flex-direction:column;min-height:0">
            <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px">
              <div class="card-h nk-serif" style="font-size:24px">Grocery list</div>
              <div class="muted" style="font-weight:600">15 items · 2 in cart</div>
              <div style="margin-left:auto">${seg}</div>
            </div>
            <div class="ai-bar" style="margin:6px 0 12px;max-width:none">
              <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
              <div class="ph">Add to groceries… “bananas and oat milk”</div>
              <div class="mic"><svg viewBox="0 0 24 24">${ic.mic}</svg></div>
            </div>
            <div style="flex:1;overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:0 22px;align-content:start">
              <div>${leftHTML}</div>
              <div>${rightHTML}</div>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
            <div class="card" style="padding:18px 20px">
              <div class="card-h" style="font-size:17px;margin-bottom:12px">This week's dinners</div>
              ${['salmon','tacos','lentil','wings','ravioli'].map(k=>{ const mn=MEALMETA[k][1]; const d=mn.split(' · ')[0]; const t=mn.split(' · ')[1];
                return `<div class="groc-meal" data-meal="${k}" style="display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid var(--hair-2);cursor:pointer">
                  <span class="gdot" style="width:11px;height:11px;background:${mc[k]}"></span>
                  <div class="tiny" style="width:34px;font-weight:700;color:var(--ink-2)">${d}</div>
                  <div style="flex:1;font-size:14.5px;font-weight:600">${t}</div>
                  <div class="rc-img ${R[k].g}" style="width:34px;height:34px;border-radius:9px;font-size:17px">${R[k].e}</div>
                </div>`; }).join('')}
            </div>
            <div class="card" style="flex:1;padding:18px 20px;display:flex;flex-direction:column">
              <div style="display:flex;align-items:center;margin-bottom:6px"><div class="card-h" style="font-size:17px">Pantry check</div><div style="margin-left:auto" class="pill pantry-edit" style="font-size:12.5px;cursor:pointer"><svg viewBox="0 0 24 24">${ic.settings}</svg>Edit staples</div></div>
              <div class="tiny muted" style="line-height:1.45;margin-bottom:14px">These staples are assumed in the house, so Nook left them off the list. Tap one to add it anyway, or edit the assumed list.</div>
              <div style="display:flex;gap:7px;flex-wrap:wrap">
                ${['Olive oil','Garlic','Rice','Parmesan','Butter','Salt & pepper','Pasta','Eggs'].map(s=>`<span class="tag pantry-add" style="font-size:12px;padding:5px 11px;cursor:pointer">${s}</span>`).join('')}
              </div>
              <div style="margin-top:auto;padding-top:16px;display:flex;gap:10px">
                <button class="btn btn-ghost" style="flex:1;justify-content:center"><svg viewBox="0 0 24 24">${ic.plus}</svg>Add item</button>
                <button class="btn btn-primary" style="flex:1;justify-content:center"><svg viewBox="0 0 24 24">${I.share}</svg>Share</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ============ iOS · RECIPE BROWSE ============ */
  function iosCard(key){
    const r = R[key];
    return `<div class="rc">
      <div class="rc-img ${r.g}" style="height:96px;font-size:34px">${r.e}
        <div class="rc-fav" style="width:26px;height:26px">${r.fav?heartFull('var(--primary)'):heartLine}</div>
      </div>
      <div class="rc-b" style="padding:11px 12px 13px">
        <div class="rc-t" style="font-size:15px">${r.t}</div>
        <div class="rc-m" style="font-size:11.5px;gap:8px"><span>🕐 ${r.min}${typeof r.min==='number'?'m':''}</span><span>🍽️ ${typeof r.serves==='number'?r.serves:r.serves}</span></div>
      </div>
    </div>`;
  }
  const iosChips = ['All','❤️ Faves','Dinner','Quick','Breakfast','Veg'].map((c,i)=>
    `<span class="tag" style="font-size:13px;padding:7px 14px;${i===0?'background:var(--ink);color:#fff':''}">${c}</span>`).join('');

  function iosStatus(){ return window._NK_iosStatus ? window._NK_iosStatus() : ''; }
  // rebuild status + tabbar locally (mirror screens-ios.js)
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

  const IOS_recipes = `<div class="nk-ios nk">
    ${statusBar}
    <div class="ios-body noscroll" style="display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
        <div class="ios-h1" style="margin:0">Recipes</div>
        <div style="margin-left:auto;display:flex;gap:8px">
          <div class="icon-btn" style="width:36px;height:36px"><svg viewBox="0 0 24 24">${I.search}</svg></div>
        </div>
      </div>
      <div class="ai-bar" style="margin:12px 0 10px;padding:11px 13px 11px 16px">
        <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
        <div class="ph" style="font-size:14.5px">Plan my week, or paste a link…</div>
      </div>
      <div style="display:flex;gap:7px;overflow:hidden;margin-bottom:14px">${iosChips}</div>
      <div style="flex:1;overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:13px;align-content:start">
        ${['ravioli','tacos','pancake','lentil','wings','salmon'].map(iosCard).join('')}
      </div>
    </div>
    <div class="ios-tabbar nk" style="position:absolute"></div>
    ${tabbar('meals')}
  </div>`;

  /* ============ iOS · RECIPE DETAIL ============ */
  const iosIng = [['1 lb','Italian sausage'],['25 oz','Cheese ravioli'],['24 oz','Marinara'],['2 cups','Mozzarella'],['2 cups','Baby spinach']];
  const IOS_recipeDetail = `<div class="nk-ios nk">
    ${statusBar}
    <div class="ios-body noscroll" style="padding:0;display:flex;flex-direction:column">
      <div class="g-pasta" style="height:188px;position:relative;display:grid;place-items:center;font-size:68px">🍝
        <div style="position:absolute;top:12px;left:16px;width:36px;height:36px;border-radius:999px;background:rgba(255,255,255,.85);display:grid;place-items:center"><svg viewBox="0 0 24 24" width="18" fill="none" stroke="var(--ink)" stroke-width="2">${I.chevL}</svg></div>
        <div style="position:absolute;top:12px;right:16px;width:36px;height:36px;border-radius:999px;background:rgba(255,255,255,.85);display:grid;place-items:center"><svg viewBox="0 0 24 24" width="18" fill="var(--primary)" stroke="none">${I.heart}</svg></div>
      </div>
      <div style="padding:16px 20px 0;flex:1;display:flex;flex-direction:column;overflow:hidden">
        <div class="nk-serif" style="font-size:24px;font-weight:600;line-height:1.1">Ravioli & Sausage Bake</div>
        <div style="display:flex;gap:14px;color:var(--ink-2);font-weight:600;font-size:13px;margin:7px 0 12px">
          <span>🕐 35 min</span><span>🍽️ Serves 5</span><span style="color:var(--gold)">★ 4.8</span>
        </div>
        <div style="display:flex;gap:11px;align-items:center;padding:11px 13px;border-radius:var(--r-md);background:linear-gradient(120deg,#efeafc,#f4eefe);margin-bottom:14px">
          <div class="ai-spark" style="width:26px;height:26px"><svg viewBox="0 0 24 24" style="width:14px;height:14px">${ic.spark}</svg></div>
          <div class="tiny" style="font-weight:700;color:var(--ai);line-height:1.3">You have 7 of 8 ingredients — just need marinara.</div>
        </div>
        <div style="display:flex;align-items:center;margin-bottom:4px"><div class="card-h" style="font-size:16px">Ingredients</div>
          <div class="stepper" style="margin-left:auto"><button>−</button><span class="sv" style="font-size:15px">5</span><button>+</button></div></div>
        <div style="overflow:hidden">${iosIng.map(([q,n])=>`<div class="ing" style="padding:7px 0"><div class="ck"></div><div class="iq" style="font-size:13.5px;min-width:54px">${q}</div><div class="inm" style="font-size:13.5px">${n}</div></div>`).join('')}</div>
        <div class="tiny muted" style="padding:9px 0;font-weight:600">+ 3 more</div>
      </div>
      <div style="padding:10px 20px;display:flex;gap:10px;border-top:1px solid var(--hair)">
        <button class="btn btn-ghost" style="flex:1;justify-content:center"><svg viewBox="0 0 24 24">${ic.calendar}</svg>Schedule</button>
        <button class="btn btn-primary" style="flex:1;justify-content:center"><svg viewBox="0 0 24 24">${ic.bag}</svg>Add to list</button>
      </div>
    </div>
    ${tabbar('meals')}
  </div>`;

  /* ============ EXPORT ============ */
  Object.assign(window.KIOSK, {
    recipes: KIOSK_recipes, recipeDetail: KIOSK_recipeDetail, plan: KIOSK_plan, grocery: KIOSK_grocery,
  });
  Object.assign(window.IOS, { recipesBrowse: IOS_recipes, recipeDetail: IOS_recipeDetail });
})();

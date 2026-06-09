/* NOOK — Lists tab (multi-list, parameterized) + Photos tab. Uses window._NK */
(function () {
  const { ic, star, rail, topbar, av, avatars } = window._NK;

  /* ---------------- LISTS ---------------- */
  function li(name, qty, who, done){
    return `<div class="litem ${done?'done':''}"><div class="lck">${done?`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--ink-3)" stroke-width="3"><path d="M5 12l5 5 9-10"/></svg>`:''}</div>
      <span class="lnm">${name}</span>${qty?`<span class="lqty">${qty}</span>`:''}${who?av(who,'sm'):''}</div>`;
  }
  const grp = (title, items)=>`<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);margin:2px 2px 9px">${title}</div>${items.join('')}</div>`;
  const packClothes = grp('Clothes', [li('Swimsuits',"×4",'kelly'),li('Rain jackets',"×4",'kelly'),li('PJs & socks','','kevin',true)]);
  const packGear = grp('Gear', [li('Sunscreen','','wally'),li('Beach towels','×6','kevin'),li('Cooler & ice','','kevin'),li('First-aid kit','','kelly',true)]);
  const packKids = grp('For the kids', [li("Lottie's unicorn",'','lottie'),li('Pool floats','×2','wally'),li('Board games','','wally')]);
  const packBody = `<div style="flex:1;overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:0 22px;align-content:start"><div>${packClothes}${packKids}</div><div>${packGear}</div></div>`;
  const twoCol = items => `<div style="flex:1;overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:0 22px;align-content:start"><div>${items.slice(0,Math.ceil(items.length/2)).map(it=>li.apply(null,it)).join('')}</div><div>${items.slice(Math.ceil(items.length/2)).map(it=>li.apply(null,it)).join('')}</div></div>`;

  const LISTS = {
    pack:{e:'🧳',name:'Lake trip packing',sub:'12 items · 2 packed',n:12,body:packBody,sugg:true},
    target:{e:'🎯',name:'Target run',sub:'4 items',n:4,items:[['Diapers, size 4','','kelly'],['Birthday card','','kevin'],['Paper towels','×2',''],['Goldfish crackers','','wally',true]]},
    costco:{e:'🏬',name:'Costco',sub:'7 items',n:7,items:[['Rotisserie chicken','×2',''],['Eggs','×2 dz',''],['Olive oil','','kelly'],['Paper goods','','kevin'],['Frozen berries','','lottie'],['Coffee beans','','kevin',true],['Granola bars','','wally']]},
    household:{e:'🏠',name:'Household to-do',sub:'6 items',n:6,items:[['Change HVAC filter','','kevin'],['Call the plumber','','kelly'],['Replace smoke-alarm battery','',''],['Water the plants','','wally'],['Schedule gutter cleaning','','kevin',true],['Donate old toys','','kelly']]},
    wishlist:{e:'🎁',name:'Wishlist',sub:'9 items',n:9,items:[['Lottie: unicorn bike','','lottie'],['Wally: telescope','','wally'],['Kelly: running shoes','','kelly'],['Kevin: cordless drill','','kevin'],['Family: board-game set','','']]},
    school:{e:'🏫',name:'School supplies',sub:'New',n:5,items:[['Backpacks','×2',''],['Crayons','','lottie'],['Glue sticks','×4',''],['Notebooks','','wally'],['Lunch boxes','×2','']]},
  };
  function listRailHTML(active){
    const groc = `<div class="list-item" data-list="grocery"><span class="lemo">🛒</span>Groceries<span class="lct">✦ 15</span></div>`;
    const rest = Object.entries(LISTS).map(([k,l])=>`<div class="list-item ${k===active?'on':''}" data-list="${k}"><span class="lemo">${l.e}</span>${l.name}<span class="lct">${l.n}</span></div>`).join('');
    return groc + rest;
  }
  const listsTop = `<div class="tb-right">
      <div class="pill">📤 Share list</div>
      <div class="pill btn-primary" style="color:#fff;border:0"><svg viewBox="0 0 24 24" stroke="#fff">${ic.plus}</svg>New list</div>
    </div>`;

  function KIOSK_lists(ctx){
    ctx = ctx || {}; const active = (ctx.active && LISTS[ctx.active]) ? ctx.active : 'pack';
    const L = LISTS[active];
    const body = L.body || twoCol(L.items);
    const sugg = L.sugg ? `<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:16px">
        <span class="tiny" style="font-weight:700;color:var(--ai)">Nook suggests:</span>
        ${['Bug spray','Phone chargers','Snacks for the drive','Trash bags'].map(s=>`<span class="sug-chip"><svg viewBox="0 0 24 24">${ic.plus}</svg>${s}</span>`).join('')}
      </div>` : '';
    return `<div class="nk-kiosk nk">
      ${rail('lists')}
      <div style="display:flex;flex-direction:column;min-width:0">
        ${topbar(listsTop)}
        <div style="flex:1;display:grid;grid-template-columns:236px 1fr;gap:18px;padding:2px 30px 26px;min-height:0">
          <div style="display:flex;flex-direction:column;min-height:0">
            <div style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--ink-3);margin:4px 6px 10px">YOUR LISTS</div>
            <div style="display:flex;flex-direction:column;gap:4px">${listRailHTML(active)}</div>
          </div>
          <div style="display:flex;flex-direction:column;min-height:0">
            <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
              <div style="font-size:26px">${L.e}</div>
              <div class="card-h nk-serif" style="font-size:24px">${L.name}</div>
              <div class="muted" style="font-weight:600">${L.sub}</div>
              <div style="margin-left:auto" class="pill" style="font-size:13px"><svg viewBox="0 0 24 24">${ic.filter}</svg>Everyone</div>
            </div>
            <div class="tiny muted" style="font-weight:600;margin-bottom:10px">Tap to check off · tap an avatar to assign · ×2 is the quantity</div>
            <div class="ai-bar" style="margin:0 0 14px;max-width:none">
              <div class="ai-spark"><svg viewBox="0 0 24 24">${ic.spark}</svg></div>
              <div class="ph">Add to this list… “bug spray and 2 water bottles”</div>
              <div class="mic"><svg viewBox="0 0 24 24">${ic.mic}</svg></div>
            </div>
            ${sugg}
            ${body}
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ---------------- PHOTOS (one shared wall → screensaver) ---------------- */
  const tiles = [
    ['linear-gradient(135deg,#7fc1e8,#3f86c4)','🏖️','Beach day','wide'],
    ['linear-gradient(135deg,#f6c24f,#e89a3c)','🎂','Dad\u2019s birthday',''],
    ['linear-gradient(135deg,#a8d98a,#6fae5a)','🐢','Wally\u2019s turtle','tall'],
    ['linear-gradient(135deg,#e58ab0,#cf5e8e)','🩰','Recital',''],
    ['linear-gradient(135deg,#f0a87f,#dd7a52)','🍝','Taco night',''],
    ['linear-gradient(135deg,#b59ae8,#8a5cf0)','🦄','Lottie art','wide'],
    ['linear-gradient(135deg,#8fd3c4,#4fae9b)','⚽','Soccer win',''],
    ['linear-gradient(135deg,#f5c98a,#e3a14f)','🥞','Sat pancakes',''],
  ];
  const wall = tiles.map(([bg,e,cap,span])=>`<div class="ph-tile ${span}" style="background:${bg}">${e}<div class="heart">${['Beach day','Recital'].includes(cap)?'❤️':''}</div><div class="ph-cap">${cap}</div></div>`).join('');

  const photosTop = `<div class="tb-right">
      <div class="pill" data-go="screensaver">🖼️ Play screensaver</div>
      <div class="pill btn-primary" style="color:#fff;border:0" data-go="addPhotos"><svg viewBox="0 0 24 24" stroke="#fff">${ic.plus}</svg>Add photos</div>
    </div>`;

  const KIOSK_photos = `<div class="nk-kiosk nk">
    ${rail('photos')}
    <div style="display:flex;flex-direction:column;min-width:0">
      ${topbar(photosTop)}
      <div style="margin:0 30px 16px;display:flex;align-items:center;gap:14px;padding:16px 20px;border-radius:var(--r-lg);background:linear-gradient(120deg,#efeafc,#f4eefe)">
        <div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#7fc1e8,#3f86c4);display:grid;place-items:center;font-size:28px;flex:none">🏖️</div>
        <div style="flex:1"><div class="ai-tag" style="margin-bottom:4px"><svg viewBox="0 0 24 24">${ic.spark}</svg>New memory</div>
          <div style="font-size:17px;font-weight:700">“Lake Day” — 18 photos from Saturday</div>
          <div class="tiny muted">Nook grouped them and set a few as the kitchen screensaver. Tap any photo to view.</div></div>
        <button class="btn btn-ghost" data-go="screensaver" style="font-size:14px">▶ Play</button>
      </div>
      <div style="flex:1;overflow:hidden;padding:0 30px 24px"><div class="ph-wall">${wall}</div></div>
    </div>
  </div>`;

  Object.assign(window.KIOSK, { lists: KIOSK_lists, photos: KIOSK_photos });
})();

// Built-server + browser integration. Synthetic content, disposable SQLite and no external requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
import { upcomingEvents, conferenceDay } from '../src/lib/event-spotlight.ts';
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
const ROOT = process.cwd(), BASE = 'http://localhost:4863', scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-community-'));
const shots = process.env.SHOTS || ''; if (shots) fs.mkdirSync(shots, { recursive: true });
let db, server, browser, checks = 0; const logs = [];
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log('PASS ' + name); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const crc = (bytes) => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
const chunk = (type, bytes) => { const d = Buffer.concat([Buffer.from(type), bytes]), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(d)); return Buffer.concat([len, d, sum]); };
function flyer() {
  const width = 240, height = 360, pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + x * 3 + 1, color = y < 90 ? [20, 63, 72] : y < 270 ? [222, 231, 218] : [232, 187, 114]; pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2]; }
  const size = Buffer.alloc(13); size.writeUInt32BE(width); size.writeUInt32BE(height, 4); size[8] = 8; size[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',size), chunk('IDAT',deflateSync(pixels)), chunk('IEND',Buffer.alloc(0))]);
}
try {
  check('conference calendar retains same-day events after UTC midnight', conferenceDay(new Date('2026-10-23T02:30:00Z')) === '2026-10-22' && conferenceDay(new Date('2026-12-23T02:30:00Z')) === '2026-12-22');
  const sample = (id, kind, eventDate) => ({ id, data: { announcement: { kind, eventDate } } });
  check('slider sorts upcoming dates, retains undated events and excludes past/non-events', upcomingEvents([sample('undated','event'),sample('past','event','2026-10-21'),sample('later','event','2026-11-01'),sample('today','event','2026-10-22'),sample('notice','announcement','2026-10-22')], '2026-10-22').map((s) => s.id).join() === 'today,later,undated');
  check('slider bounds its public selection to six events', upcomingEvents(Array.from({ length: 10 }, (_, i) => sample('event-'+i,'event','2099-01-01'))).length === 6);
  db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  db.prepare('INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)').run('git_adopted_at',String(Date.now()),Date.now());
  const row = (sql,...v) => db.prepare(sql).get(...v), rows = (sql,...v) => db.prepare(sql).all(...v), run = (sql,...v) => db.prepare(sql).run(...v);
  const now = Date.now(), sessions = {};
  for (const role of ['admin','editor']) { const id = Number(run('INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES(?,?,?,\'active\',?,?)',`${role}@synthetic.invalid`,`Synthetic ${role}`,role,now,now).lastInsertRowid), token = randomBytes(32).toString('base64url'); run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)', createHash('sha256').update(token).digest('hex'),id,now,now,now+3600000); sessions[role] = { id,token }; }
  const png = flyer(), future = (days) => new Date(now + days * 86400000).toISOString().slice(0,10);
  function live(slug,title,{kind=null,eventDate,hidden=false,draft=false,image=true}={}) {
    const imageUrl = image ? `/media/stories/${slug}/flyer.png` : null, metadata = kind ? JSON.stringify({kind,...(eventDate?{eventDate}:{}),location:'Synthetic Community Hall',links:[]}) : null;
    const id = Number(run("INSERT INTO stories(slug,title,dek,section,area,author,date,image,image_alt,body,status,source,published_at,updated_at,announcement,draft,featured) VALUES(?,?,?,'news','conference','Synthetic Editor',?,?,?,'Synthetic body text for public review.',?,'editor',?,?,?,?,1)",slug,title,'A synthetic invitation to gather, connect and share what comes next.',conferenceDay(),imageUrl,'Synthetic portrait flyer; essential details are in the event text.',hidden?'unpublished':'live',now,now,metadata,draft?1:0).lastInsertRowid);
    if (image) { const rel = `stories/${slug}/flyer.png`; fs.mkdirSync(path.join(scratch,'media','stories',slug),{recursive:true}); fs.writeFileSync(path.join(scratch,'media',rel),png); run("INSERT INTO story_photos(story_id,position,kind,path,alt,sha256,bytes,focal_x,focal_y,zoom) VALUES(?,0,'lead',?,?,?,?,1,99,3)",id,rel,'Synthetic full-aspect flyer',createHash('sha256').update(png).digest('hex'),png.length); }
  }
  live('synthetic-first-event','Synthetic community gathering',{kind:'event',eventDate:future(7)});
  live('synthetic-next-event','Synthetic service weekend',{kind:'event',eventDate:future(14)});
  live('synthetic-undated','Synthetic upcoming invitation',{kind:'event',image:false});
  live('synthetic-expired','Synthetic expired event',{kind:'event',eventDate:'2000-01-01'});
  live('synthetic-hidden','Synthetic hidden event',{kind:'event',eventDate:future(1),hidden:true});
  live('synthetic-draft-only','Synthetic draft-only event',{kind:'event',eventDate:future(1),draft:true});
  live('synthetic-announcement','Synthetic public announcement',{kind:'announcement'});
  live('synthetic-news','Synthetic community story');
  const draftIds = {};
  for (const kind of ['story','announcement','event']) { draftIds[kind] = Number(run("INSERT INTO drafts(status,source,title,section,area,author,date,body,announcement,created_at,updated_at) VALUES('new','agent',?,'news','conference','Synthetic Author',?,'Synthetic draft body.',?,?,?)",`Synthetic ${kind} inbox`,conferenceDay(),kind==='story'?null:JSON.stringify({kind,links:[]}),now,now).lastInsertRowid); }
  run('UPDATE drafts SET story_blocks=? WHERE id=?',JSON.stringify([{id:'synthetic-paragraph',type:'text',text:'Synthetic draft body.'}]),draftIds.story);
  server = spawn(process.execPath,['dist/server/entry.mjs'],{cwd:ROOT,env:{...process.env,HOST:'127.0.0.1',PORT:'4863',DATA_DIR:scratch,SITE_URL:BASE,AUTH_SECRET:'synthetic-community-auth-'+ 's'.repeat(40),AGENT_API_TOKEN:'synthetic-community-agent-'+ 'a'.repeat(40),PUBLISH_TOKEN:'',RESEND_API_KEY:'',GDRIVE_SERVICE_ACCOUNT_JSON:'',GDRIVE_FOLDER_ID:'',DISCORD_WEBHOOK_URL:''},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',(d)=>logs.push(String(d))); server.stderr.on('data',(d)=>logs.push(String(d)));
  let ready=false;for(let i=0;i<100;i++){try{await fetch(BASE+'/admin/login');ready=true;break;}catch{await delay(100);}}
  check('isolated built server starts with navigation migration',ready);
  const headers = (role='admin') => ({Origin:BASE,Cookie:`__Host-imc_session=${sessions[role].token}`});
  const get = async (url,role) => { const res = await fetch(BASE+url,{redirect:'manual',headers:role?headers(role):{}}); return {status:res.status,text:await res.text(),headers:res.headers}; };
  const config = async () => (await fetch(BASE+'/api/navigation')).json();
  const initial = await config();check('public navigation starts with central defaults and no private fields',initial.version===0&&initial.items.some((i)=>i.id==='news')&&!JSON.stringify(initial).includes('synthetic.invalid'));
  check('anonymous users cannot open menu settings',(await get('/admin/navigation')).status===302);
  check('editors cannot read administrator menu settings',(await get('/admin/navigation','editor')).status===403);
  const navForm = (items,version,action='save') => { const f=new FormData();f.set('version',String(version));f.set('action',action);items.forEach((i,n)=>{f.set(`id.${n}`,i.id);f.set(`label.${n}`,i.label);f.set(`href.${n}`,i.href);f.set(`order.${n}`,String(n+1));if(i.visible)f.set(`visible.${n}`,'on');});return f; };
  const save = (items,version,opts={}) => fetch(BASE+'/admin/navigation',{method:'POST',redirect:'manual',headers:opts.noOrigin?{Cookie:headers().Cookie}:headers(opts.role),body:navForm(items,version,opts.action)});
  const changed = initial.items.map((i)=>({...i,label:i.id==='home'?'Start <here>':i.label,visible:i.id!=='kids'})).concat({id:'custom-7',label:'Community calendar',href:'/announcements/',visible:true});
  check('editor role cannot change website navigation',(await save(changed,0,{role:'editor'})).status===403&&(await config()).version===0);
  check('menu changes require same-origin POST',(await save(changed,0,{noOrigin:true})).status===403&&(await config()).version===0);
  for(const href of ['javascript:alert(1)','data:text/html,hi','//evil.invalid','https://name:password@example.invalid/','/admin','/api/agent/stories','/%61dmin','http://example.invalid/']) { const items=changed.map((i,n)=>n===0?{...i,href}:i);check('unsafe/private menu address rejected: '+href,(await save(items,0)).status===400&&(await config()).version===0); }
  check('all-hidden menu is rejected atomically',(await save(changed.map((i)=>({...i,visible:false})),0)).status===400&&(await config()).version===0);
  const beforeStories=JSON.stringify(rows('SELECT * FROM stories ORDER BY id'));
  await get('/');
  const saved=await save(changed,0);check('administrator saves labels/order/visibility/custom links',saved.status===200&&(await config()).version===1);
  const publicConfig=await config();check('public config contains only visible links',!publicConfig.items.some((i)=>i.id==='kids')&&publicConfig.items.some((i)=>i.id==='custom-7')&&publicConfig.items[0].label==='Start <here>');
  const home=await get('/');check('origin cache is invalidated and menu labels are HTML escaped',home.status===200&&home.text.includes('Start &lt;here&gt;')&&!home.text.includes('Start <here>'));
  check('stale menu saves conflict without overwriting current data',(await save(initial.items,0)).status===409&&(await config()).version===1);
  const concurrent=await Promise.all([save(changed,1),save(changed,1)]);check('concurrent menu changes accept one version only',concurrent.map((r)=>r.status).sort().join()==='200,409'&&(await config()).version===2);
  check('navigation audit records only counts/version/actor',rows("SELECT detail FROM audit_log WHERE action='site.navigation'").length===2&&rows("SELECT detail FROM audit_log WHERE action='site.navigation'").every((r)=>!r.detail.includes('Start')&&!r.detail.includes('Community')));
  for(const [kind,url]of [['story','/admin?status=all'],['announcement','/admin/announcements?status=all'],['event','/admin/events?status=all&kind=all']]){const r=await get(url,'editor');check('separate '+kind+' queue excludes other content types',r.status===200&&r.text.includes('Synthetic '+kind+' inbox')&&['story','announcement','event'].filter((k)=>k!==kind).every((k)=>!r.text.includes('Synthetic '+k+' inbox')));}
  const all=await get('/admin?kind=all&status=all','editor');check('explicit all-drafts oversight retains every type',['story','announcement','event'].every((k)=>all.text.includes('Synthetic '+k+' inbox')));
  const filtered=await get('/admin/events?status=all&source=agent&section=news','editor');check('separate queues retain status/source/section filters',filtered.status===200&&filtered.text.includes('Synthetic event inbox')&&filtered.text.includes('value="agent" selected'));
  for(const kind of ['announcement','event']){const f=new FormData();f.set('kind',kind);const r=await fetch(BASE+'/api/admin/drafts/new',{method:'POST',redirect:'manual',headers:headers('editor'),body:f});const id=Number(r.headers.get('location').split('/').pop());check('New '+kind+' creates a typed review draft without publishing',r.status===303&&row('SELECT announcement,status FROM drafts WHERE id=?',id).status==='in_review'&&JSON.parse(row('SELECT announcement FROM drafts WHERE id=?',id).announcement).kind===kind);}
  const bad=new FormData();bad.set('kind','anything');const countBefore=row('SELECT COUNT(*) n FROM drafts').n;
  check('unknown content type cannot create a draft',(await fetch(BASE+'/api/admin/drafts/new',{method:'POST',headers:headers('editor'),body:bad})).status===400&&row('SELECT COUNT(*) n FROM drafts').n===countBefore);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:process.env.CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[]});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('**/*',(route)=>new URL(route.request().url()).origin===BASE?route.continue():route.abort());
  await context.addCookies([{name:'__Host-imc_session',value:sessions.admin.token,domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',(e)=>errors.push(String(e)));page.setDefaultTimeout(12000);
  await page.goto(BASE+'/');await page.locator('[data-event-track]').waitFor();
  check('homepage rail shows exactly the current public upcoming events',await page.locator('[data-event-slide]').count()===3&&await page.locator('[data-event-slide]').first().innerText().then((s)=>s.includes('Synthetic community gathering'))&&!await page.locator('[data-event-track]').innerText().then((s)=>/expired|hidden|draft-only|public announcement/.test(s)));
  check('slider arrows wrap, so neither is ever disabled (keyboard focus is never lost at either end)',!await page.getByRole('button',{name:'Previous event',exact:true}).isDisabled()&&!await page.getByRole('button',{name:'Next event',exact:true}).isDisabled());
  await page.getByRole('button',{name:'Next event',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 2 of 3');
  check('Next deliberately advances the event rail',await page.locator('[data-event-status]').innerText()==='Event 2 of 3');
  await page.locator('[data-event-track]').focus();await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 1 of 3');
  check('keyboard arrows operate the focused event rail',await page.locator('[data-event-status]').innerText()==='Event 1 of 3');
  check('spotlight has one icon-only pause/play toggle in the heading controls, before the slides, and no playback row or notice',await page.locator('[data-slider-controls] [data-slide-play]').count()===1&&await page.evaluate(()=>!!(document.querySelector('[data-slide-play]').compareDocumentPosition(document.querySelector('[data-event-track]'))&Node.DOCUMENT_POSITION_FOLLOWING))&&await page.locator('[data-slide-play]').getAttribute('aria-label')==='Pause automatic advance'&&(await page.locator('[data-slide-play]').innerText()).trim()===''&&await page.locator('.spotlight-playback,[data-rotation-state]').count()===0);
  await page.locator('[data-slide-play]').click();check('toggle label switches to Resume and back',await page.locator('[data-slide-play]').getAttribute('aria-label')==='Resume automatic advance'&&await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');await page.locator('[data-slide-play]').click();check('toggle returns to Pause',await page.locator('[data-slide-play]').getAttribute('aria-label')==='Pause automatic advance');
  const image=page.locator('.spotlight-flyer img').first();await image.evaluate((img)=>img.decode());
  check('flyer keeps its full portrait ratio despite stored zoom/pan',await image.evaluate((img)=>{const r=img.getBoundingClientRect();return Math.abs(r.height/r.width-img.naturalHeight/img.naturalWidth)<.03&&getComputedStyle(img).objectFit==='contain'&&!img.style.scale;}));
  if(process.env.AXE_JS){await page.waitForFunction(()=>document.getAnimations().every((a)=>a.playState!=='running'));await page.addScriptTag({path:process.env.AXE_JS});const scan=await page.evaluate(async()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));if(scan.violations.length)console.log(JSON.stringify(scan.violations.map((v)=>({id:v.id,nodes:v.nodes.map((n)=>n.failureSummary)}))));check('homepage rail and custom navigation pass axe',scan.violations.length===0);}
  if(shots)await page.screenshot({path:path.join(shots,'community-home-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:900});check('homepage fits a phone viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'Open menu',exact:true}).click();check('mobile menu opens with editable public links and releases inert',await page.locator('#mobile-nav').evaluate((n)=>n.dataset.open==='true'&&!n.inert)&&await page.locator('#mobile-nav [data-navigation-items] a').count()===7);
  await page.keyboard.press('Escape');check('mobile Escape closes, restores toggle focus and makes links inert',await page.locator('#mobile-nav').evaluate((n)=>n.dataset.open==='false'&&n.inert)&&await page.getByRole('button',{name:'Open menu',exact:true}).evaluate((b)=>b===document.activeElement));
  if(shots)await page.screenshot({path:path.join(shots,'community-home-mobile.png'),fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(BASE+'/');check('reduced-motion preference prevents entrance animations',await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches&&document.getAnimations().filter((a)=>a.playState==='running'&&a.effect?.getKeyframes().some((f)=>f.transform||f.translate)).length===0));
  await page.getByRole('button',{name:'Next event',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 2 of 3');check('reduced-motion slider still supports deliberate navigation',await page.locator('[data-event-status]').innerText()==='Event 2 of 3');
  await page.goto(BASE+'/search/');await page.waitForFunction(()=>document.querySelector('[data-navigation-items]')?.textContent.includes('Start <here>'));check('prerendered pages refresh their navigation from public configuration',await page.locator('.nav').innerText().then((s)=>s.includes('Start <here>')&&!s.includes('Kids')));
  await page.goto(BASE+'/stories/synthetic-first-event/');await page.waitForFunction(()=>document.querySelector('.nav a[href="/news/"]')?.getAttribute('aria-current')==='page');check('story pages retain their section marker after navigation refresh',await page.locator('.nav a[aria-current]').count()===1&&await page.locator('.nav a[href="/news/"]').getAttribute('aria-current')==='page');
  await page.setViewportSize({width:1440,height:1000});await page.goto(BASE+'/admin/navigation');
  const ids=await page.locator('.navigation-row input[type=hidden]').evaluateAll((nodes)=>nodes.map((n)=>n.value));check('blank menu row identities never collide with a moved custom link',new Set(ids).size===12);
  await page.getByRole('button',{name:'Move link 8 earlier',exact:true}).click();await page.getByRole('button',{name:'Save website menu',exact:true}).click();await page.getByRole('status').filter({hasText:'Website menu saved'}).waitFor();
  check('menu reorder controls persist the chosen order',(await config()).items[5].id==='custom-7');
  // Reordered custom-7 must not steal the next blank row's identity.
  await page.getByLabel('Link 8 label',{exact:true}).fill('Another public link');await page.getByLabel('Link 8 address',{exact:true}).fill('https://example.invalid/community');await page.getByRole('button',{name:'Save website menu',exact:true}).click();await page.getByRole('status').filter({hasText:'Website menu saved'}).waitFor();
  check('a new custom link can be added after moving an earlier custom link',(await config()).items.some((i)=>i.label==='Another public link'));
  if(process.env.AXE_JS){await page.addScriptTag({path:process.env.AXE_JS});const scan=await page.evaluate(async()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));if(scan.violations.length)console.log(JSON.stringify(scan.violations.map((v)=>({id:v.id,nodes:v.nodes.map((n)=>n.failureSummary)}))));check('administrator navigation controls pass axe',scan.violations.length===0);}
  if(shots)await page.screenshot({path:path.join(shots,'website-menu-editor.png'),fullPage:true});
  await page.setViewportSize({width:390,height:900});check('website menu editor fits a phone viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(shots)await page.screenshot({path:path.join(shots,'website-menu-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Restore default menu',exact:true}).click();await page.getByRole('status').filter({hasText:'Website menu saved'}).waitFor();check('reset restores central default labels and visibility',(await config()).items[0].label==='Latest'&&(await config()).items.some((i)=>i.id==='kids'));
  await page.goto(BASE+`/admin/drafts/${draftIds.story}`);await page.locator('[data-studio-tab=content]').click();
  check('story editor returns to its story queue',await page.locator('.studio-back').getAttribute('href')==='/admin');
  const savedVersion=row('SELECT updated_at FROM drafts WHERE id=?',draftIds.story).updated_at;
  await page.locator('#module-library-category').selectOption('media');check('module category exposes only images and video',await page.locator('[data-add-module]:visible').count()===4);
  await page.locator('.sb-library-preferences summary').click();await page.locator('[data-pin-module=video]').check();await page.locator('#module-library-category').selectOption('favorites');check('quick access includes user-pinned module types',await page.locator('[data-add-module=video]').isVisible());
  await delay(1000);check('library preferences do not dirty or autosave story content',row('SELECT updated_at FROM drafts WHERE id=?',draftIds.story).updated_at===savedVersion);
  await page.reload();await page.locator('[data-studio-tab=content]').click();await page.locator('#module-library-category').selectOption('favorites');check('module quick-access choices persist across reload',await page.locator('[data-add-module=video]').isVisible());
  await page.locator('#module-library-reset').click();check('clearing module filters restores all eleven modules',await page.locator('[data-add-module]:visible').count()===11);
  await page.locator('#module-library-category').selectOption('favorites');await page.locator('.sb-library-preferences summary').click();
  if(shots)await page.screenshot({path:path.join(shots,'module-library-quick-access.png'),fullPage:true});
  for(const [url,name]of [['/admin/announcements','Announcements'],['/admin/events','Events']]){await page.goto(BASE+url);check('dedicated '+name+' screen labels its own create action',await page.getByRole('heading',{level:1,name,exact:true}).count()===1&&await page.getByRole('button',{name:'New '+name.toLowerCase().replace(/s$/,''),exact:true}).count()===1);if(shots)await page.screenshot({path:path.join(shots,name.toLowerCase()+'-queue.png'),fullPage:true});await page.setViewportSize({width:390,height:900});check(name+' queue fits a phone viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(shots)await page.screenshot({path:path.join(shots,name.toLowerCase()+'-queue-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});}
  const nojs=await browser.newContext({javaScriptEnabled:false,viewport:{width:1440,height:1000}});await nojs.route('**/*',(route)=>new URL(route.request().url()).origin===BASE?route.continue():route.abort());const plain=await nojs.newPage();await plain.goto(BASE+'/');check('without JavaScript, event content and server-rendered menu links remain readable',await plain.locator('[data-event-slide]').count()===3&&await plain.locator('.nav a').count()===7&&await plain.locator('body').innerText().then((s)=>s.includes('Synthetic community gathering')));await nojs.close();
  for(const kind of ['announcement','event']){await page.goto(BASE+`/admin/drafts/${draftIds[kind]}`);check(kind+' editor returns to its own queue',await page.locator('.studio-back').getAttribute('href')==='/admin/'+(kind==='event'?'events':'announcements'));}
  check('menu and editorial organization never modify live stories',JSON.stringify(rows('SELECT * FROM stories ORDER BY id'))===beforeStories);
  check('interactive workflows produce no uncaught browser errors',errors.length===0);
  console.log(`\n${checks} community navigation checks passed.`);
}finally{await browser?.close();if(server){server.kill();await Promise.race([new Promise((r)=>server.once('exit',r)),delay(3000)]);}db?.close();fs.rmSync(scratch,{recursive:true,force:true});}

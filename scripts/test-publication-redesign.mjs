// Synthetic publication, original generated graphics and a disposable local server only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
// Playwright is not a dependency of this repo. PLAYWRIGHT_ROOT (a folder whose node_modules has it) overrides the normal resolution.
const playwrightRequire = process.env.PLAYWRIGHT_ROOT ? createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')) : createRequire(import.meta.url);
const { chromium } = (() => {
  try { return playwrightRequire('playwright'); } catch { /* reported below */ }
  throw new Error('Playwright was not found. Install it or set PLAYWRIGHT_ROOT to a folder whose node_modules has it.');
})();
if (!process.env.AXE_JS || !fs.existsSync(process.env.AXE_JS)) throw new Error('Set AXE_JS to axe.min.js; this design suite requires its accessibility checks.');
const base = 'http://localhost:4885', scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-publication-design-'));
// SHOTS keeps the screenshots; otherwise they go to a folder inside the throwaway scratch directory.
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : path.join(scratch, 'shots'); fs.mkdirSync(shots, { recursive: true });
let server, browser, db, checks = 0;
const logs = [], check = (label, condition) => { assert.ok(condition, label); checks++; console.log('PASS ' + label); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const crc = (bytes) => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let k=0;k<8;k++) n = n&1 ? 0xedb88320 ^ n>>>1 : n>>>1; } return (n^0xffffffff)>>>0; };
const chunk = (name, bytes) => { const all=Buffer.concat([Buffer.from(name),bytes]), length=Buffer.alloc(4), checksum=Buffer.alloc(4); length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(all)); return Buffer.concat([length,all,checksum]); };
function graphic(width, height, flyer=false) {
 const rows=Buffer.alloc((width*3+1)*height);
 for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
  const at=y*(width*3+1)+1+x*3, band=flyer ? y<height*.25 || y>height*.82 : y>height*(.5+.15*Math.sin(x/width*6));
  const color=band ? [11,57+Math.floor(x/width*40),84] : [45+Math.floor(x/width*80),180+Math.floor(y/height*30),185];
  rows[at]=color[0];rows[at+1]=color[1];rows[at+2]=color[2];
 }
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
try {
 db=openDatabase(scratch);runMigrations(db,readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
 const run=(sql,...args)=>db.prepare(sql).run(...args), row=(sql,...args)=>db.prepare(sql).get(...args);
 const now=Date.now(); run("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)",now);
 const user=Number(run("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES('synthetic-design@example.invalid','Synthetic Editor','admin','active',?,?)",now,now).lastInsertRowid), token=randomBytes(32).toString('base64url');
 run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)',createHash('sha256').update(token).digest('hex'),user,now,now,now+3600000);
 const body='## A place to belong\n\n'+'This is synthetic editorial content created for a local design review. It does not describe a real event, person or congregation. '.repeat(6)+'\n\n> There is room for every story.\n\nA final synthetic paragraph keeps the reading column and line spacing visible.';
 function seed(slug,title,section='news',eventDate=null,extras=[]) {
  const image=`/media/stories/${slug}/image.png`, bytes=graphic(eventDate?320:960,eventDate?480:540,!!eventDate), rel=image.slice('/media/'.length);
  fs.mkdirSync(path.dirname(path.join(scratch,'media',rel)),{recursive:true});fs.writeFileSync(path.join(scratch,'media',rel),bytes);
  const meta=eventDate?JSON.stringify({kind:'event',eventDate,location:'Synthetic Community Hall',links:[]}):null;
  const id=Number(run("INSERT INTO stories(slug,title,dek,section,area,author,date,image,image_alt,body,status,source,published_at,updated_at,announcement,featured,additional_sections) VALUES(?,?,?,?,?,'Synthetic Editor','2026-10-22',?, ?,?,'live','editor',?,?,?,1,?)",slug,title,'Stories of connection, service and a living faith. Synthetic preview content.',section,section==='news'?'camp':'',image,eventDate?'Synthetic portrait flyer; event details are also provided in text.':'Synthetic geometric landscape for design verification.',body,now,now,meta,JSON.stringify(extras)).lastInsertRowid);
  run("INSERT INTO story_photos(story_id,position,kind,path,alt,bytes,sha256,focal_x,focal_y,zoom) VALUES(?,0,'lead',?,?,?, ?,17,83,1.8)",id,rel,eventDate?'Synthetic flyer':'Synthetic landscape',bytes.length,createHash('sha256').update(bytes).digest('hex'));
 }
 const future=(days)=>new Date(now+days*86400000).toISOString().slice(0,10);
 seed('synthetic-gathering','A weekend to reconnect','news',future(7));seed('synthetic-service','Small acts. Lasting connections.','news',future(14));seed('synthetic-celebration','Make room for what comes next','news',future(21));
 seed('synthetic-camp','Something good is growing here','news',null,['youth']);seed('synthetic-table','Room for everyone at the table','features');seed('synthetic-voices','Young voices, lasting faith','youth');seed('synthetic-reflection','The quiet work of showing up','columns');
 const draftId=Number(run("INSERT INTO drafts(status,source,title,body,section,area,author,date,created_at,updated_at,additional_sections) VALUES('in_review','editor','Synthetic cross-category story',?,'news','camp','Synthetic Editor','2026-10-22',?,?, '[\"youth\"]')",body,now,now).lastInsertRowid);
 server=spawn(process.execPath,['dist/server/entry.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'4885',DATA_DIR:scratch,SITE_URL:base,AUTH_SECRET:'synthetic-publication-design-'+ 'x'.repeat(40),RESEND_API_KEY:'',GDRIVE_SERVICE_ACCOUNT_JSON:'',GDRIVE_FOLDER_ID:'',DISCORD_WEBHOOK_URL:''},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',(d)=>logs.push(String(d)));server.stderr.on('data',(d)=>logs.push(String(d)));
 let ready=false;for(let n=0;n<100;n++){try{await fetch(base+'/admin/login');ready=true;break;}catch{await delay(100);}}check('synthetic publication server starts',ready);
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[]});
 const context=await browser.newContext({viewport:{width:1440,height:1100}});await context.route('**/*',(route)=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await context.addCookies([{name:'__Host-imc_session',value:token,domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(), errors=[];page.on('pageerror',(e)=>errors.push(String(e)));page.setDefaultTimeout(10000);
 await page.goto(base+'/');await page.locator('[data-slide-play]').waitFor();
 const colors=await page.evaluate(()=>Object.fromEntries(['--brand','--accent','--brand-soft','--bg'].map((name)=>[name,getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase()])));
 check('website uses the uploaded email palette',colors['--brand']==='#087e8b'&&colors['--accent']==='#2dd4bf'&&colors['--brand-soft']==='#e0f5f7'&&colors['--bg']==='#f8f7f5');
 const mark=page.locator('.site-header .brand-wordmark img');await mark.evaluate((img)=>img.decode());check('local IMConnected wordmark loads',await mark.evaluate((img)=>img.naturalWidth>0));
 check('spotlight is an immersive full-width stage',await page.locator('.event-spotlight').evaluate((node)=>{const r=node.getBoundingClientRect();return r.width>=innerWidth-2&&r.height>500;}));
 await page.locator('[data-event-track]').scrollIntoViewIfNeeded();await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());
 await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');
 const first=await page.locator('[data-event-status]').innerText(), focusedBefore=await page.evaluate(()=>document.activeElement.tagName);
 await page.waitForFunction((before)=>document.querySelector('[data-event-status]')?.textContent!==before,first,{timeout:12000});
 check('visible slider automatically advances without stealing focus',await page.evaluate((tag)=>document.activeElement.tagName===tag,focusedBefore));
 check('automatic rotation does not repeatedly announce slides',await page.locator('[data-event-status]').getAttribute('aria-live')==='off');
 await page.getByRole('button',{name:'Pause auto-advance',exact:true}).click();await page.mouse.move(0,0);await page.locator('.skip').focus();
 const paused=await page.locator('[data-event-status]').innerText();await delay(7600);
 check('reader pause persists after hover/focus leave',await page.locator('[data-event-status]').innerText()===paused&&await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 await page.getByRole('button',{name:'Resume auto-advance',exact:true}).click();await page.mouse.move(0,0);await page.locator('.skip').focus();
 await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');check('explicit resume restarts automatic rotation and the control shows its state by label, not aria-pressed',await page.getByRole('button',{name:'Pause auto-advance',exact:true}).count()===1&&await page.locator('[data-slide-play]').getAttribute('aria-pressed')===null);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 check('hidden-tab lifecycle suspends automatic rotation',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 const hiddenPosition=await page.locator('[data-event-status]').innerText();await delay(7600);check('hidden-tab lifecycle cancels its pending advance',await page.locator('[data-event-status]').innerText()===hiddenPosition);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));check('pagehide cancels rotation before back-forward caching',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 const cachedPosition=await page.locator('[data-event-status]').innerText();await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await page.waitForFunction((before)=>document.querySelector('[data-event-status]')?.textContent!==before,cachedPosition,{timeout:12000});check('pageshow restores a working automatic timer',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='true');
 await page.locator('.site-footer').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='false');check('offscreen spotlight stops its timer',true);await page.evaluate(()=>window.scrollTo(0,0));await page.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true');
 await page.locator('.spotlight-copy').first().hover();check('hover suspends rotation',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 await page.mouse.move(0,0);await page.locator('[data-event-track]').focus();check('keyboard focus suspends rotation',await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 await page.getByRole('button',{name:/^Event 03: /}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 3 of 3');check('direct event choices are keyboard-focusable and update selection',await page.locator('[data-slide-to="2"]').getAttribute('aria-current')==='true');
 await page.locator('[data-event-track]').focus();await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 2 of 3');check('arrow keys retain native focused-track navigation',true);
 const flyer=page.locator('.spotlight-flyer img').nth(1);await flyer.evaluate((img)=>img.decode());check('immersive flyer retains full portrait aspect',await flyer.evaluate((img)=>{const r=img.getBoundingClientRect();return Math.abs(r.height/r.width-1.5)<.02&&getComputedStyle(img).objectFit==='contain';}));
 await page.getByRole('button',{name:/^Event 01: /}).click();await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 1 of 3');await page.locator('.home-news-heading').click();
 check('numbered choices are a labelled group whose names contain their visible numbers (WCAG 2.5.3)',await page.locator('.spotlight-choices').evaluate((group)=>group.getAttribute('role')==='group'&&!!group.getAttribute('aria-label')&&[...group.querySelectorAll('button')].every((b)=>b.getAttribute('aria-label').startsWith('Event '+b.textContent.trim()+': ')))&&await page.locator('.spotlight-choices .sr-only').count()===0);
 check('Pause / Resume comes before the event links in the Tab order',await page.evaluate(()=>{const pause=document.querySelector('[data-slide-play]'),link=document.querySelector('[data-event-track] a');return !!(pause.compareDocumentPosition(link)&Node.DOCUMENT_POSITION_FOLLOWING);}));
 await page.locator('[data-slide-step="-1"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 3 of 3');
 check('Previous wraps from the first event, is never disabled and keeps keyboard focus',await page.evaluate(()=>!document.querySelector('[data-slide-step="-1"]').disabled&&!document.querySelector('[data-slide-step="1"]').disabled&&document.activeElement===document.querySelector('[data-slide-step="-1"]')));
 await page.locator('[data-slide-step="1"]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-event-status]')?.textContent==='Event 1 of 3');
 check('Next wraps from the last event and keeps keyboard focus',await page.evaluate(()=>document.activeElement===document.querySelector('[data-slide-step="1"]')));
 check('the selected numbered choice is exposed with aria-current and drawn with a filled background, not colour alone',await page.evaluate(()=>{const on=document.querySelector('.spotlight-choices [aria-current=true]'),off=document.querySelector('.spotlight-choices button:not([aria-current])');return !!on&&getComputedStyle(on).backgroundColor!==getComputedStyle(off).backgroundColor;}));
 await page.locator('.spotlight-flyer').first().focus();check('flyer link focus ring is not clipped by the stage',await page.evaluate(()=>{const link=document.querySelector('.spotlight-flyer'),slide=link.closest('.spotlight-slide'),style=getComputedStyle(link),box=link.getBoundingClientRect(),clip=slide.getBoundingClientRect();const offset=parseFloat(style.outlineOffset),width=parseFloat(style.outlineWidth);return style.outlineStyle!=='none'&&offset<=-width&&box.top>=clip.top-.5&&box.bottom<=clip.bottom+.5&&box.left>=clip.left-.5&&box.right<=clip.right+.5;}));
 const ringProbe=async(locator,name)=>{await locator.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');const result=await locator.evaluate((el)=>{
  const parse=(c)=>c.match(/[\d.]+/g).slice(0,4).map(Number),lum=([r,g,b])=>{const f=(v)=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;};return .2126*f(r)+.7152*f(g)+.0722*f(b);};
  const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const style=getComputedStyle(el),ring=parse(style.outlineColor),inside=parseFloat(style.outlineOffset)<0,sources=[];
  const own=(node)=>{const cs=getComputedStyle(node);const list=[];const bg=parse(cs.backgroundColor);if(bg[3]!==0&&bg.length>=3)list.push(bg.slice(0,3));for(const m of cs.backgroundImage.matchAll(/rgba?\([^)]*\)/g))list.push(parse(m[0]).slice(0,3));return list;};
  if(inside)sources.push(...own(el));
  if(!sources.length)for(let node=inside?el.parentElement:el.parentElement;node&&!sources.length;node=node.parentElement)sources.push(...own(node));
  return {sources:sources.length,focusVisible:el.matches(':focus-visible'),width:parseFloat(style.outlineWidth),style:style.outlineStyle,min:Math.min(...sources.map((c)=>ratio(ring,c))),ring:style.outlineColor};});
  check(`${name} keyboard focus ring is visible and at least 3:1 against what it is drawn on`,result.sources>0&&result.focusVisible&&result.style!=='none'&&result.width>=2&&result.min>=3);
  await page.locator('[data-event-spotlight]').screenshot({path:path.join(shots,`focus-${name}.png`)});};
 await ringProbe(page.locator('.spotlight-flyer').first(),'flyer-link');await ringProbe(page.locator('.spotlight-read').first(),'explore-event');await ringProbe(page.locator('.spotlight-copy h3 a').first(),'title-link');
 await ringProbe(page.locator('[data-slide-step="-1"]'),'previous');await ringProbe(page.locator('[data-slide-step="1"]'),'next');await ringProbe(page.locator('[data-slide-play]'),'pause');await ringProbe(page.locator(`.spotlight-choices [data-slide-to="${await page.locator('.spotlight-choices [aria-current=true]').getAttribute('data-slide-to')}"]`),'selected-choice');
 await page.locator('.skip').focus();
 if(process.env.AXE_JS){await page.addScriptTag({path:process.env.AXE_JS});const result=await page.evaluate(async()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));if(result.violations.length)console.log(JSON.stringify(result.violations.map((v)=>({id:v.id,nodes:v.nodes.map((n)=>({html:n.html,summary:n.failureSummary}))}))));check('rebranded homepage and slider pass axe',result.violations.length===0);}
 await page.evaluate(()=>document.activeElement?.blur());await page.mouse.move(0,0);await page.screenshot({path:path.join(shots,'publication-home-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:900});await page.goto(base+'/');check('new brand and event stage fit a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(shots,'publication-home-mobile.png'),fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});await page.goto(base+'/');await page.locator('[data-slide-play]').waitFor();await delay(7600);
 check('reduced-motion users get no automatic rotation',await page.locator('[data-event-status]').innerText()==='Event 1 of 3'&&await page.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false'&&await page.locator('[data-slide-play]').isDisabled());
 await page.getByRole('button',{name:'Next event',exact:true}).click();check('reduced-motion manual navigation jumps directly without smooth scrolling',await page.locator('[data-event-track]').evaluate((track)=>{const slides=track.querySelectorAll('[data-event-slide]');return Math.abs(track.scrollLeft-(slides[1].offsetLeft-slides[0].offsetLeft))<2;})&&await page.locator('[data-event-status]').innerText()==='Event 2 of 3');
 check('system dark preference retains the requested newsletter palette',await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--brand').trim().toLowerCase()==='#087e8b'));
 await page.setViewportSize({width:1440,height:1100});await page.goto(base+'/stories/synthetic-camp/');check('article shows both category links and reading guidance',await page.locator('.article-heading a[href="/news/"]').count()===1&&await page.locator('.article-heading a[href="/youth/"]').count()===1&&await page.locator('.article-reading').innerText().then((s)=>s.includes('min read')));await page.screenshot({path:path.join(shots,'publication-article-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:900});check('article reading column fits a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(shots,'publication-article-mobile.png'),fullPage:true});
 await page.goto(base+`/admin/drafts/${draftId}`);await page.locator('[data-studio-tab=settings]').click();check('editor shares the wordmark and exposes multiple-category controls',await page.locator('.admin-brand .brand-wordmark img').count()===1&&await page.locator('input[name=additionalSections][value=youth]').isChecked());check('branded editor fits a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(shots,'publication-editor-mobile.png'),fullPage:true});
 const scan=async(label)=>{await page.addScriptTag({path:process.env.AXE_JS});const result=await page.evaluate(async()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));if(result.violations.length)console.log(label,JSON.stringify(result.violations.map((v)=>({id:v.id,nodes:v.nodes.map((n)=>n.failureSummary)}))));return result.violations.length===0;};
 await page.setViewportSize({width:1280,height:1000});await page.emulateMedia({colorScheme:'dark',reducedMotion:'no-preference'});await page.goto(base+`/admin/drafts/${draftId}`);
 check('editor preview keeps a light surface under an OS dark colour scheme',await page.locator('.editor-studio .ed-preview').first().evaluate((el)=>{const [r,g,b]=getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number);return (r+g+b)/3>200;}));
 check('editor passes axe contrast under an OS dark colour scheme',await scan('editor-dark'));
 await page.emulateMedia({colorScheme:'light'});
 for(const route of ['/admin/editors','/admin/audit','/admin/backups','/admin/published','/admin/events']){const reply=await page.goto(base+route);check(`administrator ${route} loads`,reply.status()===200);check(`administrator ${route} passes axe including secondary-button and link contrast`,await scan(route));}
 for(const width of [320,360,370,375,390]){await page.setViewportSize({width,height:900});await page.goto(base+'/');check(`phone header keeps its 16px gutter and spacing at ${width}px`,await page.evaluate(()=>{const menu=document.querySelector('.site-header .menu-toggle').getBoundingClientRect(),search=document.querySelector('.site-header .header-search').getBoundingClientRect(),brand=document.querySelector('.site-header .brand').getBoundingClientRect();return innerWidth-menu.right>=15.5&&search.left-brand.right>=8;}));check(`phone conference strip is legible and the header fits at ${width}px`,await page.evaluate(()=>{const sub=document.querySelector('.site-header .conference-strip p');return parseFloat(getComputedStyle(sub).fontSize)>=10&&document.documentElement.scrollWidth<=innerWidth&&sub.getBoundingClientRect().right<=innerWidth;}));}
 check('the wordmark sits on a full-width charcoal band matching its own background',await page.evaluate(()=>{const band=document.querySelector('.site-header .masthead-band'),mark=document.querySelector('.site-header .brand-wordmark');return getComputedStyle(band).backgroundColor==='rgb(54, 56, 58)'&&getComputedStyle(mark).backgroundColor==='rgb(54, 56, 58)'&&Math.round(band.getBoundingClientRect().width)===document.documentElement.clientWidth;}));
 check('the wordmark image itself has charcoal corner pixels (not just its CSS background)',await page.evaluate(async()=>{const img=document.querySelector('.site-header .brand-wordmark img');await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const g=c.getContext('2d');g.drawImage(img,0,0);return [[0,0],[c.width-1,0],[0,c.height-1],[c.width-1,c.height-1]].every(([x,y])=>{const d=g.getImageData(x,y,1,1).data;return d[3]===255&&Math.abs(d[0]-54)<=1&&Math.abs(d[1]-56)<=1&&Math.abs(d[2]-58)<=1;});}));
 check('the conference strip keeps the full conference name for screen readers',await page.locator('.site-header .conference-strip .sr-only').textContent()==='Iowa-Missouri Conference of Seventh-day Adventists'&&await page.locator('.site-header .conference-strip [aria-hidden=true]').textContent()==='Iowa-Missouri Conference');
 const plain=await browser.newContext({javaScriptEnabled:false,viewport:{width:1440,height:1100}});await plain.route('**/*',(route)=>new URL(route.request().url()).origin===base?route.continue():route.abort());const nojs=await plain.newPage();await nojs.goto(base+'/');check('without JavaScript all event cards remain readable with native links',await nojs.locator('[data-event-slide]').count()===3&&await nojs.locator('[data-event-track] a').count()>=6);check('without JavaScript the event track keeps a visible scrollbar',await nojs.locator('[data-event-track]').evaluate((el)=>getComputedStyle(el).scrollbarWidth!=='none'&&!el.closest('[data-event-spotlight]').hasAttribute('data-enhanced')));await plain.close();
 const touch=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:900}});await touch.route('**/*',(route)=>new URL(route.request().url()).origin===base?route.continue():route.abort());const touchPage=await touch.newPage();await touchPage.goto(base+'/');await touchPage.locator('[data-slide-play]').waitFor();await touchPage.locator('.spotlight-number').first().tap();await touchPage.mouse.move(0,0);
 check('a touch tap does not stop automatic advance',await touchPage.getByRole('button',{name:'Pause auto-advance',exact:true}).count()===1);
 await touchPage.evaluate(()=>document.activeElement.blur());await touchPage.locator('[data-event-track]').scrollIntoViewIfNeeded();await touchPage.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true',null,{timeout:5000});
 const spot=await touchPage.evaluate(()=>{const t=document.querySelector('[data-event-track]'),r=t.getBoundingClientRect(),links=[...t.querySelectorAll('a')].map((a)=>a.getBoundingClientRect());let best=null,gap=0;for(let y=r.top+4;y<Math.min(r.bottom,innerHeight)-4;y+=8)for(let x=r.left+4;x<r.right-4;x+=8){const e=document.elementFromPoint(x,y);if(!e||!t.contains(e)||e.closest('a,button'))continue;const d=Math.min(...links.map((l)=>Math.max(l.left-x,x-l.right,l.top-y,y-l.bottom)));if(d>gap){gap=d;best={x,y};}}return gap>=24?best:null;});
 check('the track has a plain (non-link) spot to tap',!!spot);await touchPage.touchscreen.tap(spot.x,spot.y);
 check('a plain tap on the track focuses it without :focus-visible and rotation stays on',await touchPage.evaluate(()=>{const t=document.querySelector('[data-event-track]');return document.activeElement===t&&!t.matches(':focus-visible');})&&await touchPage.locator('[data-event-spotlight]').getAttribute('data-rotating')==='true'&&await touchPage.getByRole('button',{name:'Pause auto-advance',exact:true}).count()===1);
 // Medium 1: Next activated by touch while rotating is announced and is not auto-advanced away from.
 await touchPage.locator('[data-slide-step="1"]').scrollIntoViewIfNeeded();
 const beforeNext=await touchPage.locator('[data-event-status]').innerText();await touchPage.locator('[data-slide-step="1"]').tap();
 await touchPage.waitForFunction((b)=>document.querySelector('[data-event-status]')?.textContent!==b,beforeNext,{timeout:5000});
 const afterNext=await touchPage.locator('[data-event-status]').innerText();
 check('a touch-activated Next announces the new event (status is polite) and the button keeps focus',await touchPage.locator('[data-event-status]').getAttribute('aria-live')==='polite'&&await touchPage.evaluate(()=>document.activeElement===document.querySelector('[data-slide-step="1"]')));
 await delay(7600);
 check('rotation stays held while the touched button has focus: no auto-advance 7 s later',await touchPage.locator('[data-event-status]').innerText()===afterNext&&await touchPage.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');
 await touchPage.evaluate(()=>document.activeElement.blur());await touchPage.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true',null,{timeout:5000});
 const vtrack=await touchPage.locator('[data-event-track]').boundingBox(),vcdp=await touch.newCDPSession(touchPage),vx=Math.round(vtrack.x+vtrack.width/2),vy=Math.round(vtrack.y+Math.min(150,vtrack.height/2));
 const scrollBefore=await touchPage.evaluate(()=>scrollY);
 await vcdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:vx,y:vy}]});for(let n=1;n<=10;n++){await vcdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:vx,y:vy-n*12}]});await delay(16);}await vcdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(400);
 check('the vertical drag really scrolled the page',await touchPage.evaluate(()=>scrollY)!==scrollBefore);
 check('a vertical page scroll that starts on the track leaves automatic advance on',await touchPage.getByRole('button',{name:'Pause auto-advance',exact:true}).count()===1);await touchPage.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true',null,{timeout:5000});
 // Medium 2: a finger landing while the program's own smooth scroll is animating is not a swipe.
 await touchPage.locator('[data-event-track]').scrollIntoViewIfNeeded();await delay(300);
 const tb2=await touchPage.locator('[data-event-track]').boundingBox(),px=Math.round(tb2.x+tb2.width/2),py=Math.round(tb2.y+Math.min(150,tb2.height/2));
 await touchPage.evaluate(()=>{const t=document.querySelector('[data-event-track]'),s=t.querySelectorAll('[data-event-slide]');t.scrollTo({left:t.scrollLeft?0:s[1].offsetLeft-s[0].offsetLeft,behavior:'smooth'});});
 await vcdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:px,y:py}]});for(let n=1;n<=6;n++){await vcdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:px,y:py+n*3}]});await delay(30);}await vcdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(600);
 check('a finger landing during the 7-second smooth scroll does not stop autoplay',await touchPage.getByRole('button',{name:'Pause auto-advance',exact:true}).count()===1);
 await touchPage.waitForFunction(()=>document.querySelector('[data-event-spotlight]')?.dataset.rotating==='true',null,{timeout:5000});

 const swipe=await touch.newCDPSession(touchPage);await touchPage.locator('[data-event-track]').scrollIntoViewIfNeeded();await delay(300);const trackBox=await touchPage.locator('[data-event-track]').boundingBox();
 const sx=Math.round(trackBox.x+trackBox.width*.8),sy=Math.round(trackBox.y+Math.min(120,trackBox.height/2));await swipe.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:sx,y:sy}]});for(let x=sx;x>sx-220;x-=20){await swipe.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:sy}]});await delay(16);}await swipe.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await touchPage.waitForFunction(()=>document.querySelector('[data-slide-play]')?.textContent==='Resume auto-advance',null,{timeout:5000});check('a real swipe stops automatic advance until Resume is selected',await touchPage.locator('[data-event-spotlight]').getAttribute('data-rotating')==='false');await touch.close();
 for(const slug of ['synthetic-service','synthetic-celebration']){const form=new FormData();form.set('slug',slug);const response=await fetch(base+'/api/admin/stories/unpublish',{method:'POST',headers:{Origin:base,Cookie:`__Host-imc_session=${token}`},body:form,redirect:'manual'});check('synthetic fixture can retire extra events',response.status===303&&response.headers.get('location').includes('n=unpublished'));}
 await page.emulateMedia({reducedMotion:'no-preference',colorScheme:'light'});await page.goto(base+'/');check('one event has no autoplay or unnecessary controls',await page.locator('[data-event-slide]').count()===1&&!await page.locator('[data-slide-play]').isVisible()&&await page.locator('[data-event-spotlight]').getAttribute('data-rotating')!=='true');
 const last=new FormData();last.set('slug','synthetic-gathering');await fetch(base+'/api/admin/stories/unpublish',{method:'POST',headers:{Origin:base,Cookie:`__Host-imc_session=${token}`},body:last,redirect:'manual'});await page.goto(base+'/');check('an empty calendar hides the entire event stage',await page.locator('[data-event-spotlight]').count()===0);
 check('publication workflows have no uncaught browser errors',errors.length===0);
 console.log(`\n${checks} publication redesign checks passed.`);
} finally {await browser?.close();if(server){server.kill();await Promise.race([new Promise((r)=>server.once('exit',r)),delay(3000)]);}db?.close();fs.rmSync(scratch,{recursive:true,force:true});}

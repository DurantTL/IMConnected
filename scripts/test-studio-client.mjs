// Synthetic Studio import/publish/crop browser regression; never contacts real services.
// STUDIO_HTML=../tools-public/imconnected.html PLAYWRIGHT_ROOT=<folder> CHROMIUM_PATH=<browser> CHROMIUM_NO_SANDBOX=1 node scripts/test-studio-client.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = process.env.PLAYWRIGHT_ROOT ? createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')) : createRequire(import.meta.url);
const { chromium } = require('playwright');
if (!process.env.STUDIO_HTML) throw new Error('Set STUDIO_HTML to the selected imconnected.html file.');
const html = fs.readFileSync(process.env.STUDIO_HTML, 'utf8');
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : fs.mkdtempSync(path.join(os.tmpdir(), 'studio-browser-'));
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
const pageErrors = [];
const fixture={ok:true,stories:[{title:'Synthetic lead + gallery',dek:'Synthetic body',section:'news',sectionLabel:'News',date:'2026-10-20',url:'http://localhost:4809/story/one',image:'http://localhost:4809/images/lead.png',imageAlt:'Lead',photos:['http://localhost:4809/images/g1.png','http://localhost:4809/images/g2.png','https://evil.example/g3.png','http://localhost:4809/images/g4.png','http://localhost:4809/images/g5.png'],photoAlts:['Gallery 1','Gallery 2','Disallowed','Gallery 4','Gallery 5'],photoFocus:[{focalX:11,focalY:12,zoom:1.2},{focalX:21,focalY:22,zoom:1.4},{focalX:31,focalY:32,zoom:1.6},{focalX:41,focalY:42,zoom:1.8},{focalX:51,focalY:52,zoom:2},{focalX:61,focalY:62,zoom:2.2}],photoLayout:'mosaic'}],drafts:[]};
const report={};
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror', error => pageErrors.push(String(error)));
 await page.route('**/*', async r=>{const u=new URL(r.request().url()); if(u.origin==='http://localhost:4809' && u.pathname==='/imconnected.html') return r.fulfill({status:200,contentType:'text/html',body:html}); if(u.origin==='http://localhost:4809' && u.pathname==='/api/sections') return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,sections:[{key:'news',label:'News'}]})}); if(u.origin==='http://localhost:4809' && u.pathname.startsWith('/images/')) return r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=','base64')}); if(u.origin==='http://localhost:4809' && u.pathname==='/api/stories') return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixture)}); if(u.origin==='http://localhost:4809' && u.pathname==='/api/studio-photo') return r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=','base64')}); if(u.origin==='http://localhost:4809' && u.pathname==='/api/publish') { if(r.request().method()==='GET') return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,sections:[{key:'news',label:'News'}]})}); const body=r.request().postDataJSON(); report.publishPayload=body; return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,stories:(body?.stories||[]).map(s=>({ref:s.ref,url:'http://localhost:4809/story/published',status:'created'}))})}); } return r.abort();});
 await page.setDefaultTimeout(5000); console.log('goto'); await page.goto('http://localhost:4809/imconnected.html');
 await page.waitForFunction(()=>window.IMStudio?.Store?.getDocument());
 report.exposed=await page.evaluate(()=>Object.keys(window.IMStudio)); await page.evaluate(()=>{const d=document.querySelector('#templateDialog');if(d?.open)d.close(); const doc=IMStudio.Templates.create('blank');doc.blocks=[];IMStudio.Store.replaceDocument(doc,{record:false});}); await page.waitForTimeout(250); await page.evaluate(()=>{const d=document.querySelector('#templateDialog');if(d?.open)d.close();});
 console.log('import open'); await page.locator('#moreBtn').click(); await page.locator('[data-menu-action="import-site"]').click();
 await page.locator('#importSiteUrl').fill('http://localhost:4809'); await page.locator('#importToken').fill('synthetic-token'); console.log('import test'); await page.locator('#importTestBtn').click();
 await page.locator('#importRows input[type=checkbox]').first().check(); await page.locator('#importAddBtn').click();
 await page.waitForTimeout(100);
 report.import=await page.evaluate(()=>{const b=IMStudio.Store.getDocument().blocks.find(x=>x.title==='Synthetic lead + gallery');return {id:b?.id, importedFrom:b?.importedFrom,layout:b?.layout,photos:b?.photos?.map(p=>({url:p.url,alt:p.alt,focalX:p.focalX,focalY:p.focalY,zoom:p.zoom,id:p.id})),stored:IMStudio.Store.getDocument().blocks.length}});
 report.render=await page.evaluate(()=>{const b=IMStudio.Store.getDocument().blocks.find(x=>x.title==='Synthetic lead + gallery');const d=IMStudio.Store.getDocumentClone();const out={};for(const layout of ['one','twoUp','heroGrid','mosaic','stack']){d.blocks.find(x=>x.id===b.id).layout=layout;const html=IMStudio.Renderer.renderEmail(d);const parsed=new DOMParser().parseFromString(html,'text/html');out[layout]={stored:b.photos.length,rendered:Array.from(parsed.querySelectorAll('img')).filter(i=>b.photos.some(p=>i.src===p.url)).length}}return out});
 await page.evaluate(()=>{const s=IMStudio.Store;s.persistNow();});
 await page.reload(); await page.waitForFunction(()=>window.IMStudio?.Store?.getDocument());
 report.reload=await page.evaluate(()=>{const b=IMStudio.Store.getDocument().blocks.find(x=>x.title==='Synthetic lead + gallery');return b?.photos.map(p=>({focalX:p.focalX,focalY:p.focalY,zoom:p.zoom}));});
 // select story and edit zoom through actual inspector control
 const blockId=report.import.id;
 await page.evaluate(id=>IMStudio.Store.select(id,'qa'),blockId); await page.locator('[data-inspector-tab="design"]').click(); await page.waitForTimeout(150);
 const zoom=page.locator('[data-bind-path="photos.0.zoom"]'); report.zoomInputExists=await zoom.count();
 if(await zoom.count()){await zoom.fill('2.55');await zoom.dispatchEvent('input');}
 report.zoomEdit=await page.evaluate(id=>({value:IMStudio.Store.getBlock(id).photos[0].zoom,output:document.querySelector('[data-photo-zoom-path="photos.0.zoom"]')?.textContent}),blockId);
 await page.screenshot({path:path.join(shots, 'studio-desktop.png'),fullPage:false});
 // Ensure importedFrom guard: set up publish UI and test endpoint; ticked imported card must yield no POST.
 await page.locator('#moreBtn').click(); await page.locator('[data-menu-action="publish-site"]').click();
 await page.locator('#publishSiteUrl').fill('http://localhost:4809'); await page.locator('#publishToken').fill('synthetic-token'); await page.locator('#publishTestBtn').click(); await page.waitForTimeout(150);
 report.publishRows=await page.locator('#publishRows .publish-row').count();
 if(await page.locator('#publishRows .publish-row').count()){await page.locator('#publishRows [data-pub="tick"]').first().evaluate(e=>{e.disabled=false;e.checked=true}); await page.locator('#publishSendBtn').click(); await page.waitForTimeout(100);}
 report.publishGuard=await page.evaluate(()=>({status:document.querySelector('#publishStatus')?.textContent,result:document.querySelector('#publishResult')?.textContent}));
 await page.locator('#publishCloseBtn').click(); await page.evaluate(()=>IMStudio.Store.addBlock('story','document',{title:'Native synthetic story',tag:'NEWS',body:'Synthetic native publish test body.',layout:'heroGrid',photos:[IMStudio.Templates.photo({url:'http://localhost:4809/images/native1.png',focalX:23,focalY:34,zoom:1.75}),IMStudio.Templates.photo({url:'http://localhost:4809/images/native2.png',focalX:67,focalY:78,zoom:2.4})]})); await page.locator('#moreBtn').click(); await page.locator('[data-menu-action="publish-site"]').click(); await page.locator('#publishSiteUrl').fill('http://localhost:4809'); await page.locator('#publishToken').fill('synthetic-token'); await page.locator('#publishTestBtn').click(); await page.waitForFunction(()=>document.querySelector('#publishStatus').textContent.includes('sections available')); const nativeRow=page.locator('#publishRows .publish-row').filter({hasText:'Native synthetic story'}); const sectionSelect=nativeRow.locator('[data-pub="section"]'); if(await sectionSelect.locator('option').count()>1) await sectionSelect.selectOption({index:1}); await nativeRow.locator('[data-pub="author"]').fill('Synthetic Author'); await nativeRow.locator('[data-pub="tick"]').check(); await page.locator('#publishSendBtn').click(); await page.waitForFunction(()=>!document.querySelector('#publishSendBtn').disabled); await page.waitForTimeout(100); report.nativePublishStatus=await page.locator('#publishStatus').textContent();
 // small viewport synthetic capture
 await page.setViewportSize({width:390,height:844}); await page.locator('#publishCloseBtn').click().catch(()=>{}); await page.screenshot({path:path.join(shots, 'studio-mobile.png'),fullPage:false});
 // Race harness: fresh clean document, directly invoke exposed-copy closure through synthetic import flow, mocked media funcs.
 await page.evaluate(()=>{const S=IMStudio.Store;const doc=IMStudio.Templates.create('blank');doc.blocks=[];S.replaceDocument(doc,{record:false});});
 await page.evaluate(()=>{window.__uploadResolvers=[];window.IMStudio.Media.canUpload=()=>true;window.IMStudio.Media.uploadPhoto=(blob,name)=>new Promise(resolve=>window.__uploadResolvers.push({resolve,name}));});
 console.log('import open'); await page.locator('#moreBtn').click(); await page.locator('[data-menu-action="import-site"]').click(); await page.locator('#importSiteUrl').fill('http://localhost:4809'); await page.locator('#importToken').fill('synthetic-token'); console.log('import test'); await page.locator('#importTestBtn').click(); await page.locator('#importRows input[type=checkbox]').first().check(); await page.locator('#importAddBtn').click();
 await page.waitForFunction(()=>window.__uploadResolvers?.length>=1);
 report.raceBefore=await page.evaluate(()=>{const b=IMStudio.Store.getDocument().blocks[0];return {id:b.id,photos:b.photos.map(p=>({id:p.id,url:p.url}))}});
 // reorder first photo to index 1 while its upload is pending, then resolve stale upload.
 await page.evaluate(()=>{const S=IMStudio.Store,b=S.getDocument().blocks[0];S.arrayMove(b.id,'photos',0,1,{source:'qa'});});
 await page.evaluate(()=>window.__uploadResolvers[0].resolve('https://wp.example/synthetic-upload-1.png'));
 await page.waitForTimeout(150);
 report.raceAfterReorder=await page.evaluate(()=>{const b=IMStudio.Store.getDocument().blocks[0];return b.photos.map(p=>({id:p.id,url:p.url}))});
 // Next pending upload: delete current photo matching queued ID, resolve and confirm no accidental neighbor mutation.
 await page.waitForFunction(()=>window.__uploadResolvers.length>=2);
 report.raceSecondPending=await page.evaluate(()=>({count:IMStudio.Store.getDocument().blocks[0].photos.length, photos:IMStudio.Store.getDocument().blocks[0].photos.map(p=>p.id)}));
 await page.evaluate(()=>{const S=IMStudio.Store,b=S.getDocument().blocks[0];S.arrayRemove(b.id,'photos',0,{source:'qa'});});
 await page.evaluate(()=>window.__uploadResolvers[1].resolve('https://wp.example/synthetic-upload-2.png'));
 await page.waitForTimeout(100);
 report.raceAfterDelete=await page.evaluate(()=>IMStudio.Store.getDocument().blocks[0].photos.map(p=>({id:p.id,url:p.url})));
 await page.waitForFunction(()=>window.__uploadResolvers.length>=3);
 const beforeReplace=await page.evaluate(()=>IMStudio.Store.getDocument().blocks[0].photos.map(p=>({id:p.id,url:p.url})));
 const replacementId=report.raceBefore.photos[2].id;
 await page.evaluate(id=>{const S=IMStudio.Store,b=S.getDocument().blocks[0],i=b.photos.findIndex(p=>p.id===id);S.patchBlock(b.id,'photos.'+i+'.url','http://localhost:4809/replaced.png',{source:'qa'});},replacementId);
 await page.evaluate(()=>window.__uploadResolvers[2].resolve('https://wp.example/synthetic-upload-3.png')); await page.waitForTimeout(100);
 report.raceAfterReplace=await page.evaluate(()=>IMStudio.Store.getDocument().blocks[0].photos.map(p=>({id:p.id,url:p.url})));
 await page.screenshot({path:path.join(shots, 'studio-mobile-after.png'),fullPage:false});
 assert.equal(report.import.photos.length, 5, 'only permitted images are imported');
 assert.deepEqual(report.import.photos.map(p => p.alt), ['Lead', 'Gallery 1', 'Gallery 2', 'Gallery 4', 'Gallery 5']);
 assert.deepEqual(report.import.photos.map(p => p.zoom), [1.2, 1.4, 1.6, 2, 2.2], 'focus arrays stay aligned when an unsafe URL is omitted');
 assert.equal(report.import.layout, 'mosaic');
 assert.equal(report.import.importedFrom, 'http://localhost:4809/story/one');
 assert.deepEqual(report.reload, report.import.photos.map(({ focalX, focalY, zoom }) => ({ focalX, focalY, zoom })));
 for (const [layout, count] of Object.entries(report.render)) assert.equal(count.rendered, count.stored, layout + ' never drops extra photos');
 assert.equal(report.zoomInputExists, 1);
 assert.deepEqual(report.zoomEdit, { value: 2.55, output: '255%' });
 assert.match(report.publishGuard.status, /Tick at least one story/);
 assert.equal(report.publishPayload.stories.length, 1, 'forced imported checkboxes cannot publish the teaser');
 assert.equal(report.publishPayload.stories[0].title, 'Native synthetic story');
 assert.equal(report.publishPayload.stories[0].photoLayout, 'heroGrid');
 assert.deepEqual(report.publishPayload.stories[0].photos.map(({ focalX, focalY, zoom }) => ({ focalX, focalY, zoom })), [{ focalX: 23, focalY: 34, zoom: 1.75 }, { focalX: 67, focalY: 78, zoom: 2.4 }]);
 assert.equal(report.raceAfterReorder.find(p => p.id === report.raceBefore.photos[0].id).url, 'https://wp.example/synthetic-upload-1.png');
 assert.ok(!report.raceAfterDelete.some(p => p.url === 'https://wp.example/synthetic-upload-2.png'));
 assert.equal(report.raceAfterReplace.find(p => p.id === replacementId).url, 'http://localhost:4809/replaced.png');
 assert.ok(!report.raceAfterReplace.some(p => p.url === 'https://wp.example/synthetic-upload-3.png'), 'replaced upload target is not overwritten');
 for (let n = 4; n <= 5; n++) { await page.waitForFunction(n => window.__uploadResolvers.length >= n, n); await page.evaluate(n => window.__uploadResolvers[n - 1].resolve('https://wp.example/synthetic-upload-' + n + '.png'), n); }
 await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(n => /photo.s. copied/.test(n.textContent))).catch(() => {});
 assert.ok(await page.evaluate(() => !JSON.stringify(localStorage).includes('synthetic-token')), 'tokens stay out of localStorage');
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone has no horizontal page overflow');
 assert.deepEqual(pageErrors, []);
 console.log('PASS Studio browser regression: import filtering/order/layout/crops, save/reload, zoom, all-layout images, publish metadata/guard, copy races, token storage and mobile reflow.');
 if (process.env.SHOTS) fs.writeFileSync(path.join(shots, 'studio-client-results.json'), JSON.stringify(report, null, 2));
} finally { await browser.close(); if (!process.env.SHOTS) fs.rmSync(shots, { recursive: true, force: true }); }

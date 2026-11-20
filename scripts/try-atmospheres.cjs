// Real browser checks for the three preview directions. Start the web dev server first.
// Install Playwright or set NODE_PATH to its runtime, then node scripts/try-atmospheres.cjs.
// Append --landing to check only the selected landing and its fallback.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(process.argv.slice(2).find(arg=>arg!=='--landing') || 'coverage/atmospheres');
fs.mkdirSync(output, {recursive:true});
const base = 'http://127.0.0.1:4180';
const kinds = ['weather','whispers','pollen'];
const landingOnly = process.argv.includes('--landing');
const urlFor = kind => kind === 'weather' ? `${base}/` : `${base}/?experiment=${kind}`;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
function difference(a,b) {
  let total=0; for(let i=0;i<a.length;i++) total+=Math.abs(a[i]-b[i]);
  return total/a.length;
}
async function instrument(page) {
  await page.route('**/atmosphere.js',async route=>{
    const response=await route.fetch();
    let body=await response.text();
    body=body.replace('alpha: false,','preserveDrawingBuffer: true, alpha: false,');
    body=body.replace('startAtmosphere(canvas,kind,{particles});','window.__atmosphereLab=startAtmosphere(canvas,kind,{particles});');
    body=body.replace('return { get state(){',`return { sample() {
      const pixels=new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const sample=[];
      for(let i=0;i<pixels.length;i+=256) sample.push(pixels[i],pixels[i+1],pixels[i+2]);
      if(overlay) {
        const motes=overlay.getImageData(0,0,particles.width,particles.height).data;
        for(let i=0;i<motes.length;i+=256) sample.push(motes[i],motes[i+1],motes[i+2]);
      }
      return sample;
    }, get state(){`);
    await route.fulfill({response,body});
  });
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const errors=[]; const report={directions:[],sizes:[],touch:[],errors};
  try {
    for(const kind of landingOnly ? ['weather'] : kinds) {
      const page=await browser.newPage({viewport:{width:1440,height:1000}});
      page.on('pageerror',e=>errors.push(`${kind}: ${e.message}`));
      await instrument(page);
      await page.goto(urlFor(kind),{waitUntil:'domcontentloaded'});
      await page.locator('#field.ready').waitFor(); await delay(500);
      if(kind === 'weather') {
        assert.equal(await page.title(),'Messaging Quest: an AI you hire in Telegram');
        assert.equal(await page.locator('meta[name="robots"]').count(),0,'The landing must remain indexable');
        assert.equal(await page.locator('.experiment-dock').count(),0,'The landing must not show experiment controls');
        assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).paddingBottom),'0px');
      }
      const start=await page.evaluate(()=>window.__atmosphereLab.state);
      assert.equal(start.kind,kind); assert.equal(start.error,0); assert(start.pixels<=482000);
      if(kind==='weather') {
        assert.equal(start.fluid.energy,0,'The untouched physical flow should rest');
        await page.mouse.move(740,430);
        for(const [x,y] of [[830,470],[925,400],[850,340],[775,450]]) await page.mouse.move(x,y,{steps:5});
        await delay(250);
        const wake=await page.evaluate(()=>window.__atmosphereLab.state.fluid);
        assert(wake.energy>0 && wake.positive>10 && wake.negative>10,'Dragging must generate opposing circulation');
        await page.mouse.move(-10,-10);await delay(800);
        const coast=await page.evaluate(()=>window.__atmosphereLab.state.fluid);
        assert(coast.energy>0 && coast.warp>0,'The gas must keep advecting after the pointer leaves');
        report.physicalWake={wake,coast};
      }
      await page.mouse.move(1330,410); await delay(600);
      await page.mouse.click(1330,410); await delay(90);
      const tapped=await page.evaluate(()=>window.__atmosphereLab.state);
      assert(tapped.tapAge<.4,'Mouse click must reach the atmosphere');
      // Freeze time first: scrolling must change the pixels without autonomous drift.
      await page.evaluate(()=>document.dispatchEvent(new CustomEvent('motion',{detail:{paused:true}})));
      await delay(80); const before=await page.evaluate(()=>({state:window.__atmosphereLab.state,pixels:window.__atmosphereLab.sample()}));
      await page.mouse.wheel(0,650); await delay(500);
      const after=await page.evaluate(()=>({state:window.__atmosphereLab.state,pixels:window.__atmosphereLab.sample()}));
      assert(after.state.scroll>.5,'Actual wheel input must advance the scene');
      assert.equal(after.state.elapsed,before.state.elapsed,'Pause must freeze autonomous motion');
      if(kind==='weather') assert.equal(after.state.fluid.energy,before.state.fluid.energy,'Pause must freeze physical momentum');
      const scrollDifference=difference(before.pixels,after.pixels);
      assert(scrollDifference>1,'Scroll must visibly change the rendered background');
      await page.evaluate(()=>document.dispatchEvent(new CustomEvent('motion',{detail:{paused:false}})));
      if(kind==='weather') {
        const beforeScroll=await page.evaluate(()=>window.__atmosphereLab.state.fluid.inputs);
        await page.mouse.wheel(0,-200);await delay(250);
        const stirred=await page.evaluate(()=>window.__atmosphereLab.state.fluid);
        assert(stirred.inputs>beforeScroll && stirred.energy>0,'Wheel input must add momentum to the physical flow');
        report.physicalScroll=stirred;
      }
      const timing=await page.evaluate(()=>new Promise(resolve=>{
        const times=[];let previous=performance.now();
        const frame=now=>{times.push(now-previous);previous=now;if(times.length<45)requestAnimationFrame(frame);else resolve(times.slice(2).sort((a,b)=>a-b));};
        requestAnimationFrame(frame);
      }));
      report.directions.push({kind,scrollDifference,mouseTap:true,medianFrameMs:timing[Math.floor(timing.length/2)],p95FrameMs:timing[Math.floor(timing.length*.95)]});
      fs.writeFileSync(path.join(output,landingOnly?'landing-weather-report.json':'atmosphere-report.json'),JSON.stringify(report,null,2));
      console.log(`${kind}: wheel changed the frozen scene by ${scrollDifference.toFixed(2)} channel values; mouse and pause passed`);
      // Reduced motion renders a still, keeps scroll-led composition, and shows complete demo chapters.
      await page.emulateMedia({reducedMotion:'reduce'}); await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
      await page.locator('.chapters button[data-ch="3"]').click();
      await page.evaluate(()=>scrollTo({top:0,behavior:'instant'})); await delay(120);
      const reduced=await page.evaluate(()=>window.__atmosphereLab.state); await delay(120);
      assert.equal((await page.evaluate(()=>window.__atmosphereLab.state)).elapsed,reduced.elapsed);
      const prefix=landingOnly?'landing-weather':kind;
      await page.screenshot({path:path.join(output,`${prefix}-desktop.png`),timeout:15000});
      for(const size of [{width:390,height:844},{width:768,height:1024},{width:1280,height:900}]) {
        await page.setViewportSize(size); await delay(120);
        const dimensions=await page.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth,canvas:getComputedStyle(document.querySelector('.ink-bed')).position}));
        assert(dimensions.page<=dimensions.viewport,'No horizontal overflow');assert.equal(dimensions.canvas,'fixed');
        report.sizes.push({kind,...size,overflow:false});
        if(size.width===390) await page.screenshot({path:path.join(output,`${prefix}-mobile.png`),timeout:15000});
      }
      await page.close();
      const touch=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
      touch.on('pageerror',e=>errors.push(e.message));await instrument(touch);
      await touch.goto(urlFor(kind),{waitUntil:'domcontentloaded'});await touch.locator('#field.ready').waitFor();
      await touch.touchscreen.tap(365,400);await delay(70);
      assert((await touch.evaluate(()=>window.__atmosphereLab.state)).tapAge<.35,'Native touchscreen tap must create a pulse');
      if(kind==='weather') {
        await delay(150);const puff=await touch.evaluate(()=>window.__atmosphereLab.state.fluid);
        assert(puff.density>0 && puff.positive>0 && puff.negative>0,'Touch must create a physical puff and vortices');
      }
      report.touch.push({kind,tap:true});await touch.close();
    }
    const fallback=await browser.newPage();
    await fallback.addInitScript(()=>{const context=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl'?null:context.call(this,type,...args);};});
    await fallback.goto(`${base}/`,{waitUntil:'domcontentloaded'});await fallback.locator('#field.unavailable').waitFor({state:'attached'});
    assert(await fallback.locator('#hero-h').isVisible());report.noWebGL=true;await fallback.close();
    if(!landingOnly) {
      const gallery=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
      gallery.on('pageerror',e=>errors.push(e.message));
      await gallery.goto(`${base}/experiments.html`,{waitUntil:'domcontentloaded'});
      await gallery.locator('canvas.ready').nth(2).waitFor();await delay(250);
      await gallery.screenshot({path:path.join(output,'three-atmospheres.png'),timeout:15000});
      assert.equal(await gallery.locator('a.open').count(),3);await gallery.close();
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,landingOnly?'landing-weather-report.json':'atmosphere-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});

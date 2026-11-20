// Browser/GPU experiment for the static landing. Install Playwright or point NODE_PATH at it.
// Start `npm run dev -w @mq/web`, then `node scripts/try-landing.cjs [output-directory]`.
// The lab hook is appended only to the intercepted response; it never ships on the site.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(process.argv[2] || 'coverage/landing');
fs.mkdirSync(output, {recursive:true});

const hook = `
window.__fluidLab = {
  stop() { paused = true; stop(); },
  resume() { paused = false; brush.reset(); slosh.reset(); lastDraw = performance.now(); kick(); },
  settle,
  step(dt, accel = 0, stroke = null, press = null) { stepWaves(dt, accel, stroke, press); },
  point(x, y) { return pagePoint({clientX:x, clientY:y}); },
  draw() { draw(scrollY); },
  info() { return {page, body, layout, time, paused, live:field.tank.live, format:field.format, waves:!!field.tank.waves,
    pixels:canvas.width*canvas.height, grid:field.tank.grid}; },
  metrics() {
    const {gl, tank} = field;
    const width = tank.grid.cols * 2, height = tank.grid.rows * 2;
    const made = target(gl, width, height, gl.UNSIGNED_BYTE);
    const probe = link(gl, PRECISION + '\\n' + 
      'uniform sampler2D waves; uniform vec2 fr;' + BED +
      'void main(){vec2 st=gl_FragCoord.xy/fr;vec4 w=texture2D(waves,st);' +
      'float k=clamp(deep(bed(st),w.x)/4.,0.,1.)*65535.;' +
      'gl_FragColor=vec4(floor(k/256.)/255.,mod(k,256.)/255.,w.yz/64.+.5);}') ;
    gl.useProgram(probe.program);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tank.waves[tank.read].texture);
    gl.uniform1i(probe.u.waves,0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,tank.sdf.texture);
    gl.uniform1i(probe.u.sdf,1); gl.uniform2f(probe.u.fr,width,height);
    gl.disable(gl.SCISSOR_TEST); run(gl,made,width,height);
    const bytes = new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    let volume=0, energy=0, maxDepth=0, maxVelocity=0;
    const depths = [];
    for(let i=0;i<bytes.length;i+=4){
      const d=(bytes[i]*256+bytes[i+1])*4/65535;
      depths.push(d); volume+=d; maxDepth=Math.max(maxDepth,d);
      maxVelocity=Math.max(maxVelocity,Math.abs(bytes[i+2]/255-.5)*64,Math.abs(bytes[i+3]/255-.5)*64);
    }
    if(this.rest) for(let i=0;i<depths.length;i++) energy+=(depths[i]-this.rest[i])**2;
    else this.rest=depths;
    free(gl,made); gl.deleteProgram(probe.program); gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return {volume, energy, maxDepth, maxVelocity, error:gl.getError()};
  },
};`;

(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const intercept=async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+hook});
  };
  await page.route('**/field.js',intercept);
  await page.goto('http://127.0.0.1:4180/');
  await page.locator('#field.ready').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(1000);
  await page.evaluate(()=>window.__fluidLab.stop());
  const info=await page.evaluate(()=>window.__fluidLab.info());
  assert(info.waves,'GPU must support half-float waves for this physics experiment');
  const rest=await page.evaluate(()=>{window.__fluidLab.settle(); return window.__fluidLab.metrics();});
  const rates=[];
  for(const fps of [30,60,120]) {
    rates.push(await page.evaluate(fps=>{
      const lab=window.__fluidLab; lab.settle();
      const at=lab.point(1300,420);
      for(let i=0;i<fps/2;i++) lab.step(1/fps,0,null,i===0?at:null);
      const peak=lab.metrics();
      for(let i=0;i<fps*5;i++) lab.step(1/fps);
      const settled=lab.metrics();
      return {fps,peak,settled};
    },fps));
  }
  for(const run of rates) {
    assert.equal(run.peak.error,0); assert.equal(run.settled.error,0);
    assert(run.peak.energy>1e-4,'A tap must make a visible wave');
    assert(run.settled.energy<run.peak.energy*.1,'Tap waves must dissipate');
    assert(Math.abs(run.peak.volume-rest.volume)/rest.volume<.005,'Volume drift must stay under 0.5%');
    assert(run.peak.maxVelocity<=32.01,'Interaction must obey the face-speed cap');
  }
  const energies=rates.map(r=>r.peak.energy);
  assert(Math.max(...energies)/Math.min(...energies)<1.1,'Wave energy should agree within 10% across frame rates');
  const stress=await page.evaluate(()=>{
    const lab=window.__fluidLab;lab.settle();
    const at=lab.point(1290,440);
    for(let i=0;i<90;i++) lab.step(.05,i%12<6?200:-200,
      {segment:[at[0]-.1,at[1],at[0]+.1,at[1]],velocity:[40,-40],weight:1},i%3===0?at:null);
    return lab.metrics();
  });
  assert.equal(stress.error,0);assert(stress.maxDepth<4,'Depth must stay finite under extreme input');
  assert(Math.abs(stress.volume-rest.volume)/rest.volume<.005,'Stress must conserve volume');
  const views=[];
  for(const [width,height] of [[1920,1080],[1440,1000],[1280,900],[1024,768],[768,1024],[390,844],[360,800]]) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(500);
    await page.evaluate(()=>{window.__fluidLab.settle();window.__fluidLab.draw();});
    const view=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,
      hero:document.querySelector('.hero').getBoundingClientRect().height,
      heading:document.querySelector('h1').getBoundingClientRect().toJSON(),
      phone:document.querySelector('.phone').getBoundingClientRect().toJSON(),
      chapters:document.querySelector('.chapters').getBoundingClientRect().toJSON()}));
    assert.equal(view.overflow,0,`No sideways scroll at ${width}px`);
    assert(view.chapters.bottom<=view.hero,`Chapters must fit the hero at ${width}px`);
    views.push(view);
    if([1440,390].includes(width)) {
      await page.screenshot({path:path.join(output,`landing-${width}.png`)});
      await page.screenshot({path:path.join(output,`landing-${width}-full.png`),fullPage:true});
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.waitForTimeout(500);
  const idle=await page.evaluate(()=>{
    const lab=window.__fluidLab;lab.settle();
    for(let i=0;i<120;i++) lab.step(1/60);
    return lab.metrics();
  });
  assert(idle.energy<1e-6,'At rest the fluid must remain still');
  // Exercise the actual event handlers, rather than only injecting forces into the solver.
  await page.evaluate(()=>{window.__fluidLab.settle();window.__fluidLab.resume();});
  await page.mouse.click(1370,420);
  await page.waitForTimeout(200);
  const mouse=await page.evaluate(()=>{window.__fluidLab.stop();return window.__fluidLab.metrics();});
  assert(mouse.energy>1e-4,'A real mouse press in the exposed liquid must stir it');
  await page.evaluate(()=>window.__fluidLab.draw());
  await page.screenshot({path:path.join(output,'tap-wave.png')});
  await page.evaluate(()=>{window.__fluidLab.settle();window.__fluidLab.resume();});
  await page.mouse.move(1370,320);
  await page.mouse.move(1400,620,{steps:24});
  await page.waitForTimeout(100);
  const drag=await page.evaluate(()=>{window.__fluidLab.stop();return window.__fluidLab.metrics();});
  assert(drag.energy>1e-4,'Mouse movement must drag the exposed surface');
  await page.evaluate(()=>{window.__fluidLab.settle();window.__fluidLab.resume();});
  await page.mouse.wheel(0,360);
  await page.waitForTimeout(200);
  const scroll=await page.evaluate(()=>{window.__fluidLab.stop();return window.__fluidLab.metrics();});
  assert(scroll.energy>1e-4,'Actual scroll input must slosh the fluid');
  // The surface is decorative, but it should leave the screen refresh budget available.
  await page.evaluate(()=>{window.__fluidLab.settle();window.__fluidLab.resume();});
  const timing=await page.evaluate(()=>new Promise(resolve=>{
    const intervals=[];let last=performance.now();
    const sample=now=>{intervals.push(now-last);last=now;
      dispatchEvent(new PointerEvent('pointermove',{clientX:1370+30*Math.sin(now/250),clientY:400+100*Math.cos(now/250),isPrimary:true}));
      if(intervals.length<90) requestAnimationFrame(sample);
      else {intervals.sort((a,b)=>a-b);resolve({medianMs:intervals[45],p95Ms:intervals[85]});}
    };requestAnimationFrame(sample);
  }));
  await page.evaluate(()=>window.__fluidLab.stop());
  for(const section of ['rules','quests','price','start']) {
    await page.locator('#'+section).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({path:path.join(output,'section-'+section+'.png')});
  }
  const touchPage=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:2});
  await touchPage.route('**/field.js',intercept);
  touchPage.on('pageerror',e=>errors.push(e.message));
  await touchPage.goto('http://127.0.0.1:4180/');
  await touchPage.locator('#field.ready').waitFor();
  await touchPage.evaluate(()=>document.fonts.ready);
  await touchPage.evaluate(()=>scrollTo({top:500,behavior:'instant'}));
  await touchPage.waitForTimeout(500);
  await touchPage.evaluate(()=>{window.__fluidLab.settle();window.__fluidLab.metrics();});
  await touchPage.touchscreen.tap(365,350);
  await touchPage.waitForTimeout(200);
  const touch=await touchPage.evaluate(()=>{window.__fluidLab.stop();return window.__fluidLab.metrics();});
  assert(touch.energy>1e-4,'Native touch must stir the liquid without disabling scrolling');
  await touchPage.evaluate(()=>window.__fluidLab.draw());
  await touchPage.screenshot({path:path.join(output,'landing-touch.png')});
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
  await page.waitForTimeout(200);
  // Pause freezes a disturbed surface, rather than resetting it to a different shape.
  await page.evaluate(()=>{window.__fluidLab.resume();});
  await page.mouse.click(1370,420);
  await page.locator('#pause').click();
  const paused=await page.evaluate(()=>({info:window.__fluidLab.info(),metrics:window.__fluidLab.metrics()}));
  await page.waitForTimeout(500);
  const held=await page.evaluate(()=>({info:window.__fluidLab.info(),metrics:window.__fluidLab.metrics()}));
  assert(paused.info.paused && held.info.paused);
  assert.equal(paused.info.time,held.info.time);assert.equal(paused.metrics.energy,held.metrics.energy);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.reload();await page.locator('#field.ready').waitFor();
  const reduced=await page.evaluate(()=>window.__fluidLab.info());
  await page.waitForTimeout(500);
  assert(reduced.paused);assert.equal(reduced.time,await page.evaluate(()=>window.__fluidLab.info().time));
  await page.locator('.chapters button[data-ch="3"]').click();
  const reducedText=await page.locator('.chapters .on small').evaluate(el=>({opacity:getComputedStyle(el).opacity,duration:getComputedStyle(el).transitionDuration}));
  assert.equal(reducedText.opacity,'1');assert.equal(reducedText.duration,'0s');
  // A missing WebGL context must leave the content and CSS fallback usable.
  const fallback=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await fallback.addInitScript(()=>{
    const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl'?null:original.call(this,kind,...args);};
  });
  fallback.on('pageerror',e=>errors.push(e.message));
  await fallback.goto('http://127.0.0.1:4180/');
  assert(await fallback.locator('h1').isVisible());
  assert(!(await fallback.locator('html').getAttribute('class')).includes('inked'));
  assert.deepEqual(errors,[]);
  const report={info,rest,rates,stress,idle,mouse,drag,scroll,touch,timing,paused:true,reducedMotion:true,fallback:true,views,errors};
  fs.writeFileSync(path.join(output,'physics-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({format:info.format,driftPercent:100*Math.abs(stress.volume-rest.volume)/rest.volume,
    rates,inputs:{mouse:mouse.energy,drag:drag.energy,scroll:scroll.energy,touch:touch.energy},timing,
    widths:views.map(v=>v.width),paused:true,reducedMotion:true,fallback:true,errors},null,2));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});

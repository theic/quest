import { describe, expect, it } from "vitest";
import { GasGrid } from "../public/gas-model.js";

const run = (gas: GasGrid, seconds: number, fps=60) => {
  for(let i=0;i<seconds*fps;i++) gas.advance(1/fps);
  return gas.metrics();
};

describe("the interactive gas flow", () => {
  it("keeps an undisturbed gas at rest", () => {
    const gas=new GasGrid(1.44,40);
    expect(run(gas,1).energy).toBe(0);
    expect(gas.metrics().warp).toBe(0);
  });

  it("removes most divergence from a dragged wake without erasing its circulation", () => {
    const gas=new GasGrid(1.44,40);gas.stroke(.3,.5,.7,.6);
    const before=gas.metrics();gas.project();const after=gas.metrics();
    expect(after.divergence).toBeLessThan(before.divergence*.25);
    expect(after.enstrophy).toBeGreaterThan(before.enstrophy*.95);
    expect(after.energy).toBeLessThan(before.energy);
  });

  it("leaves rotating, advected material after the pointer stops, then dissipates", () => {
    const gas=new GasGrid(1.44,40);gas.stroke(.3,.5,.7,.6);
    const early=run(gas,.5),later=run(gas,1),settled=run(gas,8);
    expect(early.positive).toBeGreaterThan(10);expect(early.negative).toBeGreaterThan(10);
    expect(later.energy).toBeGreaterThan(0);expect(later.warp).toBeGreaterThan(early.warp);
    expect(settled.energy).toBeLessThan(early.energy*.03);
  });

  it("makes a tap lift a puff with opposing vortices", () => {
    const gas=new GasGrid(.462,40);gas.tap(.75,.5);
    const state=run(gas,.5);
    expect(state.density).toBeGreaterThan(0);expect(state.warp).toBeGreaterThan(.001);
    expect(state.positive).toBeGreaterThan(10);expect(state.negative).toBeGreaterThan(10);
  });

  it("reverses scroll circulation when the scroll reverses", () => {
    const down=new GasGrid(1.44,40),up=new GasGrid(1.44,40);
    down.scroll(.25);up.scroll(-.25);run(down,.3);run(up,.3);
    const k=20*down.cols+Math.round(down.cols*.32);
    down.metrics();up.metrics();
    expect(down.curl[k]).toBeGreaterThan(1);expect(up.curl[k]).toBeLessThan(-1);
  });

  it("eases clicks and scroll into motion instead of injecting an instantaneous kick", () => {
    for(const input of ["tap","scroll"] as const) {
      const gas=new GasGrid(1.44,32);
      if(input==="tap")gas.tap(.7,.5);else gas.scroll(.3);
      expect(gas.metrics().energy).toBe(0);
      const first=run(gas,1/60),rising=run(gas,.15);
      expect(first.maxSpeed).toBeGreaterThan(0);
      expect(first.maxSpeed).toBeLessThan(rising.maxSpeed*.3);
      expect(rising.positive).toBeGreaterThan(10);expect(rising.negative).toBeGreaterThan(10);
    }
  });

  it("advances the same physical time at 30, 60 and 120 display frames per second", () => {
    const states=[30,60,120].map(fps=>{const gas=new GasGrid(1.44,32);gas.tap(.7,.5);return run(gas,2,fps);});
    for(const state of states) {
      expect(state.steps).toBe(120);
      expect(state.energy).toBeCloseTo(states[0]!.energy,10);
      expect(state.warp).toBeCloseTo(states[0]!.warp,10);
    }
  });

  it("stays bounded under repeated drags, taps, scroll reversals and slow frames", () => {
    const gas=new GasGrid(1.44,32);
    for(let i=0;i<90;i++) {
      gas.stroke(.15,.2+i%10*.06,.9,.7);gas.scroll(i%2?.7:-.7);
      if(i%8===0)gas.tap(.72,.4);
      gas.advance(.05);
    }
    const state=gas.metrics();
    for(const value of Object.values(state)) expect(Number.isFinite(value)).toBe(true);
    expect(state.maxSpeed).toBeLessThan(3);expect(state.density).toBeLessThanOrEqual(1);
    expect(state.warp).toBeLessThan(2);expect(state.steps).toBe(270);
  });
});

// The weather's flow (gas-model.js), stepped off the page's own thread. On it, the solver took most of every
// frame while the page scrolled (and more frames fell behind, so more steps piled into the next), and the scroll
// stuttered. Here it can take its time: the page sends what moved it since its last frame and how long that was,
// and draws whatever picture came back last.
import { GasGrid } from "./gas-model.js";

let gas = null;
globalThis.onmessage = ({ data }) => {
  if (data.aspect) gas = new GasGrid(data.aspect, data.rows);
  if (!gas || data.dt === undefined) return;
  for (const [name, ...args] of data.inputs) gas[name](...args);
  gas.advance(data.dt);
  const map = gas.mapBytes.slice(), dye = gas.dyeBytes.slice();
  postMessage({ map, dye, metrics: gas.metrics() }, [map.buffer, dye.buffer]);
};

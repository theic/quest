// A small 2D incompressible flow solver. Units are viewport heights and seconds.
// Staggered face velocities, semi-Lagrangian advection, pressure projection, and
// vorticity confinement carry the weather's material instead of merely warping a cursor mask.
// References: Stam, Stable Fluids (1999); Fedkiw/Stam/Jensen, Visual Simulation of Smoke (2001).
export const GAS_STEP = 1 / 60;
export const GAS_WARP_RANGE = 1.5;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function sample(field, width, height, x, y) {
  x=clamp(x,0,width-1); y=clamp(y,0,height-1);
  const ix=Math.floor(x), iy=Math.floor(y), fx=x-ix, fy=y-iy;
  const nextX=Math.min(ix+1,width-1), nextY=Math.min(iy+1,height-1);
  const a=field[iy*width+ix], b=field[iy*width+nextX];
  const c=field[nextY*width+ix], d=field[nextY*width+nextX];
  return (a+(b-a)*fx)*(1-fy)+(c+(d-c)*fx)*fy;
}

export class GasGrid {
  constructor(aspect, rows=60) {
    this.aspect=clamp(aspect,.25,3);
    this.rows=rows; this.cols=Math.max(16,Math.round(this.aspect*rows));
    this.dx=this.aspect/this.cols; this.dy=1/rows;
    const count=this.cols*rows;
    this.u=new Float32Array((this.cols+1)*rows);
    this.v=new Float32Array(this.cols*(rows+1));
    this.nextU=new Float32Array(this.u.length); this.nextV=new Float32Array(this.v.length);
    this.pressure=new Float32Array(count); this.divergence=new Float32Array(count);
    this.curl=new Float32Array(count); this.centerU=new Float32Array(count);this.centerV=new Float32Array(count);
    this.warpX=new Float32Array(count);this.warpY=new Float32Array(count);this.dye=new Float32Array(count);
    this.nextX=new Float32Array(count);this.nextY=new Float32Array(count);this.nextDye=new Float32Array(count);
    this.mapBytes=new Uint8Array(count*4);this.dyeBytes=new Uint8Array(count*4);
    this.accumulator=0;this.steps=0;this.inputs=0;this.active=false;
    this.scrollPending=0;this.puffs=[];
    this.edges=[];
    for(let j=0;j<rows;j++) for(let i=0;i<this.cols;i++) {
      if(i===0 || j===0 || i===this.cols-1 || j===rows-1)this.edges.push({i,j,k:j*this.cols+i});
    }
    this.pack();
  }

  // Dragging deposits momentum along the whole path. Its shear rolls into a wake.
  stroke(x0,y0,x1,y1) {
    const dx=(x1-x0)*this.aspect,dy=y1-y0;
    const length=Math.hypot(dx,dy);
    if(length<.0001 || length>this.aspect*1.5) return;
    const parts=Math.max(1,Math.min(24,Math.ceil(length/.035)));
    for(let i=0;i<parts;i++) {
      const t=(i+.5)/parts;
      this.force((x0+(x1-x0)*t)*this.aspect,y0+(y1-y0)*t,dx*6/parts,dy*6/parts,.075,.12/parts);
    }
    this.inputs++;
  }

  // A tap lifts a puff between two counter-rotating eddies, rather than a water-wave ring.
  tap(x,y) {
    // Deliver the puff over a short bell-shaped envelope, rather than one hard kick.
    this.puffs.push({x:x*this.aspect,y,age:0});
    this.active=true;
    this.inputs++;
  }

  // Scrolling stirs broad opposing rolls. Reversing the scroll reverses their circulation.
  scroll(delta) {
    const spin=clamp(delta*2.7,-.9,.9);
    if(Math.abs(spin)<.00001) return;
    this.scrollPending=clamp(this.scrollPending+spin,-2,2);
    this.active=true;
    this.inputs++;
  }

  applyInputs(dt) {
    // An exponential release spreads wheel impulses across 160 ms and softens reversals.
    const spin=this.scrollPending*(1-Math.exp(-dt/.16));
    this.scrollPending-=spin;
    if(Math.abs(this.scrollPending)<.00001)this.scrollPending=0;
    if(Math.abs(spin)>.000001) {
      this.vortex(this.aspect*.32,.48,spin,.28);
      this.vortex(this.aspect*.76,.56,-spin,.31);
    }
    for(const puff of this.puffs) {
      const before=clamp(puff.age/.30,0,1);
      puff.age+=dt;
      const after=clamp(puff.age/.30,0,1);
      const weight=after*after*(3-2*after)-before*before*(3-2*before);
      this.vortex(puff.x-.065,puff.y,.72*weight,.11);
      this.vortex(puff.x+.065,puff.y,-.72*weight,.11);
      this.force(puff.x,puff.y,0,.10*weight,.075,.40*weight);
    }
    if(this.puffs.length)this.puffs=this.puffs.filter(puff=>puff.age<.30);
  }

  force(x,y,fx,fy,radius,density=0) {
    this.active=true;
    const {cols,rows,dx,dy,u,v,dye}=this;
    const minX=Math.max(0,Math.floor((x-radius*3)/dx)),maxX=Math.min(cols-1,Math.ceil((x+radius*3)/dx));
    const minY=Math.max(0,Math.floor((y-radius*3)/dy)),maxY=Math.min(rows-1,Math.ceil((y+radius*3)/dy));
    for(let j=minY;j<=maxY;j++) for(let i=minX;i<=maxX;i++) {
      const rx=(i+.5)*dx-x,ry=(j+.5)*dy-y;
      const w=Math.exp(-(rx*rx+ry*ry)/(radius*radius));
      u[j*(cols+1)+i]+=fx*w;v[j*cols+i]+=fy*w;
      dye[j*cols+i]=clamp(dye[j*cols+i]+density*w,0,1);
    }
  }

  vortex(x,y,spin,radius) {
    this.active=true;
    const {cols,rows,dx,dy,u,v}=this;
    const minX=Math.max(0,Math.floor((x-radius*3)/dx)),maxX=Math.min(cols,Math.ceil((x+radius*3)/dx));
    const minY=Math.max(0,Math.floor((y-radius*3)/dy)),maxY=Math.min(rows,Math.ceil((y+radius*3)/dy));
    for(let j=minY;j<=maxY;j++) for(let i=minX;i<=maxX;i++) {
      const ux=i*dx-x,uy=(j+.5)*dy-y;
      if(j<rows && i>0 && i<cols) u[j*(cols+1)+i]-=uy/radius*spin*Math.exp(-(ux*ux+uy*uy)/(radius*radius));
      const vx=(i+.5)*dx-x,vy=j*dy-y;
      if(i<cols && j>0 && j<rows) v[j*cols+i]+=vx/radius*spin*Math.exp(-(vx*vx+vy*vy)/(radius*radius));
    }
  }

  boundaries() {
    const {cols,rows,u,v}=this;
    for(let j=0;j<rows;j++){u[j*(cols+1)]=0;u[j*(cols+1)+cols]=0;}
    for(let i=0;i<cols;i++){v[i]=0;v[rows*cols+i]=0;}
  }

  centers() {
    const {cols,rows,u,v,centerU,centerV,curl,dx,dy}=this;
    for(let j=0;j<rows;j++) for(let i=0;i<cols;i++) {
      const k=j*cols+i;
      centerU[k]=(u[j*(cols+1)+i]+u[j*(cols+1)+i+1])*.5;
      centerV[k]=(v[k]+v[k+cols])*.5;
    }
    for(let j=0;j<rows;j++) for(let i=0;i<cols;i++) {
      const k=j*cols+i,l=j*cols+Math.max(0,i-1),r=j*cols+Math.min(cols-1,i+1);
      const b=Math.max(0,j-1)*cols+i,t=Math.min(rows-1,j+1)*cols+i;
      curl[k]=(centerV[r]-centerV[l])/(2*dx)-(centerU[t]-centerU[b])/(2*dy);
    }
  }

  project(iterations=32) {
    this.boundaries();
    const {cols,rows,u,v,pressure:p,divergence:d,dx,dy}=this;
    const wx=1/(dx*dx),wy=1/(dy*dy);
    const inverse=1/(2*(wx+wy));
    p.fill(0);
    for(let j=0;j<rows;j++) for(let i=0;i<cols;i++) {
      d[j*cols+i]=(u[j*(cols+1)+i+1]-u[j*(cols+1)+i])/dx+(v[(j+1)*cols+i]-v[j*cols+i])/dy;
    }
    // Successive over-relaxation solves pressure on the same staggered grid.
    // A sequential sweep avoids the residual checkerboard of coarse red/black sweeps.
    for(let iteration=0;iteration<iterations;iteration++) {
      // The interior is a branch-free contiguous sweep; only the few edge cells need cases.
      for(let j=1;j<rows-1;j++) for(let k=j*cols+1,end=(j+1)*cols-1;k<end;k++) {
        const candidate=((p[k-1]+p[k+1])*wx+(p[k-cols]+p[k+cols])*wy-d[k])*inverse;
        p[k]+=1.8*(candidate-p[k]);
      }
      for(const {i,j,k} of this.edges) {
        let sum=0,weight=0;
        if(i>0){sum+=p[k-1]*wx;weight+=wx;}if(i+1<cols){sum+=p[k+1]*wx;weight+=wx;}
        if(j>0){sum+=p[k-cols]*wy;weight+=wy;}if(j+1<rows){sum+=p[k+cols]*wy;weight+=wy;}
        p[k]+=1.8*((sum-d[k])/weight-p[k]);
      }
    }
    for(let j=0;j<rows;j++) for(let i=1;i<cols;i++) u[j*(cols+1)+i]-=(p[j*cols+i]-p[j*cols+i-1])/dx;
    for(let j=1;j<rows;j++) for(let i=0;i<cols;i++) v[j*cols+i]-=(p[j*cols+i]-p[(j-1)*cols+i])/dy;
  }

  step(dt) {
    this.applyInputs(dt);
    const {cols,rows,dx,dy,u,v,nextU,nextV,curl,dye,centerU,centerV}=this;
    this.boundaries();
    const damping=Math.exp(-dt/2.4);
    // Backtrace each staggered face through the old velocity field.
    for(let j=0;j<rows;j++) for(let i=0;i<=cols;i++) {
      const k=j*(cols+1)+i,x=i*dx,y=(j+.5)*dy;
      const vy=sample(v,cols,rows+1,x/dx-.5,y/dy);
      nextU[k]=sample(u,cols+1,rows,(x-u[k]*dt)/dx,(y-vy*dt)/dy-.5)*damping;
    }
    for(let j=0;j<=rows;j++) for(let i=0;i<cols;i++) {
      const k=j*cols+i,x=(i+.5)*dx,y=j*dy;
      const vx=sample(u,cols+1,rows,x/dx,y/dy-.5);
      nextV[k]=sample(v,cols,rows+1,(x-vx*dt)/dx-.5,(y-v[k]*dt)/dy)*damping;
    }
    this.u=nextU;this.nextU=u;this.v=nextV;this.nextV=v;
    this.centers();
    // Restore rolling detail lost on the coarse grid. The puff has gentle upward buoyancy.
    for(let j=1;j<rows-1;j++) for(let i=1;i<cols-1;i++) {
      const k=j*cols+i;
      const nx=(Math.abs(curl[k+1])-Math.abs(curl[k-1]))/(2*dx);
      const ny=(Math.abs(curl[k+cols])-Math.abs(curl[k-cols]))/(2*dy);
      const norm=Math.hypot(nx,ny)+.00001;
      const force=curl[k]*Math.min(dx,dy)*2.2*dt;
      this.u[j*(cols+1)+i]+=ny/norm*force;
      this.v[k]+=-nx/norm*force+dye[k]*.06*dt;
    }
    // Clamp before projection so the correction retains its divergence reduction.
    for(let k=0;k<this.u.length;k++) this.u[k]=clamp(this.u[k],-1.5,1.5);
    for(let k=0;k<this.v.length;k++) this.v[k]=clamp(this.v[k],-1.5,1.5);
    this.project();this.centers();
    const relax=Math.exp(-dt/14),fade=Math.exp(-dt/3.4);
    let fastest=0,mostDye=0;
    // Advect the accumulated material displacement and the visible tracer with this flow.
    for(let j=0;j<rows;j++) for(let i=0;i<cols;i++) {
      const k=j*cols+i,x=i-centerU[k]*dt/dx,y=j-centerV[k]*dt/dy;
      this.nextX[k]=clamp((sample(this.warpX,cols,rows,x,y)-centerU[k]*dt)*relax,-1.4,1.4);
      this.nextY[k]=clamp((sample(this.warpY,cols,rows,x,y)-centerV[k]*dt)*relax,-1.4,1.4);
      this.nextDye[k]=sample(dye,cols,rows,x,y)*fade;
      fastest=Math.max(fastest,Math.abs(centerU[k]),Math.abs(centerV[k]));mostDye=Math.max(mostDye,this.nextDye[k]);
    }
    [this.warpX,this.nextX]=[this.nextX,this.warpX];
    [this.warpY,this.nextY]=[this.nextY,this.warpY];
    [this.dye,this.nextDye]=[this.nextDye,this.dye];
    this.steps++;
    if(fastest<.001 && mostDye<.001 && !this.puffs.length && this.scrollPending===0){this.active=false;this.u.fill(0);this.v.fill(0);this.curl.fill(0);}
  }

  advance(dt) {
    this.accumulator+=clamp(dt,0,.05);
    while(this.accumulator>=GAS_STEP-1e-9){
      if(this.active)this.step(GAS_STEP);
      else {
        const relax=Math.exp(-GAS_STEP/14),fade=Math.exp(-GAS_STEP/3.4);
        for(let k=0;k<this.warpX.length;k++){this.warpX[k]*=relax;this.warpY[k]*=relax;this.dye[k]*=fade;}
      }
      this.accumulator=Math.max(0,this.accumulator-GAS_STEP);
    }
    this.pack();
  }

  pack() {
    for(let k=0;k<this.warpX.length;k++) {
      const x=Math.round((this.warpX[k]/GAS_WARP_RANGE*.5+.5)*65535);
      const y=Math.round((this.warpY[k]/GAS_WARP_RANGE*.5+.5)*65535);
      this.mapBytes[k*4]=x>>8;this.mapBytes[k*4+1]=x&255;
      this.mapBytes[k*4+2]=y>>8;this.mapBytes[k*4+3]=y&255;
      this.dyeBytes[k*4]=Math.round(this.dye[k]*255);
      this.dyeBytes[k*4+1]=Math.min(255,Math.round(Math.abs(this.curl[k])*8));
      this.dyeBytes[k*4+3]=255;
    }
  }

  metrics() {
    this.centers();
    let energy=0,enstrophy=0,divergence=0,maxSpeed=0,warp=0,density=0,positive=0,negative=0;
    for(let j=0;j<this.rows;j++) for(let i=0;i<this.cols;i++) {
      const k=j*this.cols+i;
      const speed=Math.hypot(this.centerU[k],this.centerV[k]);
      energy+=speed*speed;maxSpeed=Math.max(maxSpeed,speed);
      const div=(this.u[j*(this.cols+1)+i+1]-this.u[j*(this.cols+1)+i])/this.dx+(this.v[(j+1)*this.cols+i]-this.v[j*this.cols+i])/this.dy;
      divergence+=div*div;enstrophy+=this.curl[k]**2;
      if(this.curl[k]>.1)positive++;if(this.curl[k]<-.1)negative++;
      warp+=Math.hypot(this.warpX[k],this.warpY[k]);density+=this.dye[k];
    }
    const count=this.cols*this.rows;
    return {energy:energy/count,enstrophy:enstrophy/count,divergence:Math.sqrt(divergence/count),maxSpeed,warp:warp/count,density:density/count,positive,negative,steps:this.steps,inputs:this.inputs,cols:this.cols,rows:this.rows};
  }
}

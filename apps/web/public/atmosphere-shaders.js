// Signal weather is carried by a 2D gas flow. The other two studies remain art-directed.
export const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`;

// Phones honour lowp and mediump where desktops quietly use highp, so precision is asked for out
// loud, samplers included: a lowp texture read rounds every channel to about 8 bits.
const shared = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp sampler2D;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform vec2 resolution;
uniform float time;
uniform float travel;
uniform float progress;
uniform float impulse;
uniform vec3 pointer;
uniform vec3 pulse;
uniform sampler2D words;
uniform sampler2D gasMap;
uniform sampler2D gasInk;
uniform vec2 gasSize;
// The flow's displacement is 16 bits split over two 8-bit channels. Filtering the halves apart
// tears a seam wherever the high byte steps (most GPUs hide it; phones show it), so the texture is
// read unfiltered: four exact texels, decoded, then blended here.
vec2 gasTexel(vec2 st) {
  vec4 m=floor(texture2D(gasMap,st)*255.+.5);
  return vec2(m.r*256.+m.g,m.b*256.+m.a)/65535.*3.-1.5;
}
vec2 gasWarp(vec2 st) {
  vec2 cell=st*gasSize-.5;
  vec2 base=floor(cell),f=cell-base;
  vec2 a=(base+.5)/gasSize,b=(base+1.5)/gasSize;
  return mix(mix(gasTexel(a),gasTexel(vec2(b.x,a.y)),f.x),mix(gasTexel(vec2(a.x,b.y)),gasTexel(b),f.x),f.y);
}
float hash(vec2 p) {
  vec3 p3=fract(vec3(p.xyx)*.1031);
  p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}
float noise(vec2 p) {
  vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
    mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p) {
  float f=0.; float a=.5;
  mat2 m=mat2(.8,-.6,.6,.8);
  for(int i=0;i<4;i++){f+=a*noise(p);p=m*p*2.03+7.3;a*=.5;}
  return f;
}
vec2 metric(vec2 p) { return (p-.5)*vec2(resolution.x/resolution.y,1.); }
float interaction(vec2 p) {
  vec2 delta=metric(p)-metric(pointer.xy);
  return exp(-dot(delta,delta)*18.)*pointer.z;
}
vec2 disturbance(vec2 p) {
  vec2 d=metric(p)-metric(pulse.xy);
  float r=length(d);
  float wave=exp(-pow((r-pulse.z*.32)*12.,2.))*exp(-pulse.z*.9);
  return normalize(d+vec2(.0001))*wave*.09;
}
float grain() { return (hash(gl_FragCoord.xy+11.7)-.5)/160.; }
vec3 finish(vec3 col) {
  // Quiet behind the copy; rich in the open space. Never cut into a container. Upright, the copy
  // spans the whole width, so the whole air is evenly quieter.
  float side=mix(.24,1.,smoothstep(.35,.78,uv.x));
  float veil=resolution.x<resolution.y ? .5 : side;
  float vignette=1.-.25*length(metric(uv));
  return max(vec3(.025,.031,.026),col*veil*vignette)+grain();
}
`;

export const fragments = {
  weather: shared + `
void main() {
  vec2 p=metric(uv);
  p+=gasWarp(uv);
  p.y+=travel*.30;
  float t=time*.055;
  // Layers slip past each other as scroll moves through the atmosphere.
  vec2 q=vec2(fbm(p*1.8+vec2(t,-t)),fbm(p*1.8+vec2(7.4,t*.7)));
  vec2 r=vec2(fbm(p*2.9+q*3.+vec2(-t,t*.3)),fbm(p*2.6+q*2.+9.2));
  float f=fbm(p*3.6+r*2.8-vec2(t*.9,t*.3));
  float shelf=.3+.22*sin(p.x*2.8+travel*.75+q.x*4.);
  float billow=exp(-pow((p.y-shelf+r.y*.52)*1.7,2.));
  float gas=pow(smoothstep(.22,.88,f),1.55)*billow;
  float fold=exp(-abs(f-.50)*32.)*billow;
  float signal=exp(-abs(p.y-shelf+r.y*.43)*55.);
  signal*=smoothstep(.38,.66,fbm(p*4.+time*.015));
  vec3 col=vec3(.029,.042,.032);
  col+=gas*vec3(.20,.53,.13)*1.35;
  col+=fold*gas*vec3(.52,.67,.28)*1.4;
  col+=signal*vec3(.55,.85,.32)*(.12+progress*.26);
  col+=gas*gas*vec3(.37,.46,.25);
  vec2 tracer=texture2D(gasInk,uv).rg;
  col+=tracer.x*vec3(.19,.40,.09)*(.4+fold*.9);
  // Distant signal stars buried inside the mist, not a chart laid over it.
  vec2 stars=p*19.; vec2 id=floor(stars); vec2 cell=fract(stars)-.5;
  float star=exp(-length(cell)*90.)*step(.962,hash(id));
  col+=star*vec3(.68,1.,.6);
  gl_FragColor=vec4(finish(col),1.);
}
`,
  whispers: shared + `
void main() {
  vec2 p=metric(uv);
  p+=disturbance(uv);
  float t=time*.035;
  vec2 drift=vec2(fbm(p*2.8+vec2(t,travel*.5)),fbm(p*3.1+8.-t));
  vec2 s=vec2(uv.x,1.-uv.y);
  // Words stretch and shear as if voices were suspended in the air.
  s.y+=travel*.16;
  s+=vec2((drift.x-.5)*.022,(drift.y-.5)*.036);
  s+=disturbance(uv)*vec2(.7,1.);
  float letter=texture2D(words,fract(s)).r;
  float echo=texture2D(words,fract(s+vec2(.008,.012))).r;
  float dust=fbm(p*5.2+drift*3.2+vec2(t,-travel*.4));
  float mist=pow(smoothstep(.27,.8,dust),2.);
  float focus=interaction(uv);
  float edge=max(0.,echo-letter);
  float breath=.6+.4*sin(time*.22+travel*1.5);
  vec3 col=vec3(.025,.035,.032);
  col+=mist*vec3(.1,.28,.19)*(.5+letter*1.4);
  col+=letter*mix(vec3(.14,.28,.14),vec3(.51,.68,.28),dust)*(.55+focus*1.8)*breath;
  col+=edge*vec3(.37,.7,.35)*(.2+dust*.8);
  // Mist erodes the words into moving, horizontal spectral traces.
  float trace=pow(noise(vec2(p.y*145.+travel*65.,floor(p.x*4.)+time*.04)),22.);
  col+=trace*letter*vec3(.5,.8,.28);
  gl_FragColor=vec4(finish(col),1.);
}
`,
  pollen: shared + `
void main() {
  vec2 p=metric(uv);
  p+=disturbance(uv);
  p.y+=travel*.35;
  vec2 q=vec2(fbm(p*1.7+time*.018),fbm(p*1.7+8.+travel*.1));
  float f=fbm(p*3.+q*3.);
  float air=pow(smoothstep(.3,.8,f),3.);
  vec3 col=vec3(.025,.033,.030)+air*vec3(.04,.17,.11);
  // Magnetic field lines: a diffuse, green aurora around the actual motes.
  float ridges=sin(p.x*10.+q.x*11.+p.y*3.-travel*.55);
  float filament=pow(1.-abs(ridges),22.)*air;
  col+=filament*vec3(.20,.43,.17)*(.5+progress);
  gl_FragColor=vec4(finish(col),1.);
}
`,
};

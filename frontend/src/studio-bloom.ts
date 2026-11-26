import * as THREE from 'three'

// A quarter-size highlight buffer keeps the glow local to the vehicle's HDR softbox reflections.
export function createStudioBloom(renderer: THREE.WebGLRenderer, silhouette: THREE.Texture) {
  const beauty = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 })
  const highlights = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
  const shutter = new THREE.Vector2()
  const pixel = new THREE.Vector2()
  const vertexShader = `varying vec2 uvScreen;
    void main(){ uvScreen=position.xy*.5+.5; gl_Position=vec4(position.xy,0.,1.); }`
  const extract = new THREE.ShaderMaterial({
    uniforms: { source: { value: beauty.texture }, pixel: { value: pixel } },
    depthTest: false, depthWrite: false, toneMapped: false, vertexShader,
    fragmentShader: `varying vec2 uvScreen; uniform sampler2D source; uniform vec2 pixel;
      vec3 bright(vec2 offset) {
        vec3 rgb = texture2D(source, uvScreen + offset * pixel).rgb;
        float light = dot(rgb,vec3(.2126,.7152,.0722));
        return rgb * smoothstep(1.35,2.7,light) * min(1.,6./max(light,.001));
      }
      void main(){gl_FragColor=vec4(.25*(bright(vec2(-1.,-1.))+bright(vec2(1.))
        +bright(vec2(-1.,1.))+bright(vec2(1.,-1.))),1.);}`,
  })
  const composite = new THREE.ShaderMaterial({
    uniforms: { source: { value: beauty.texture }, highlights: { value: highlights.texture }, silhouette: { value: silhouette }, shutter: { value: shutter }, pixel: { value: pixel } },
    depthTest: false, depthWrite: false, vertexShader,
    fragmentShader: `varying vec2 uvScreen; uniform sampler2D source, highlights, silhouette; uniform vec2 pixel, shutter;
      void main() {
        vec4 base=texture2D(source,uvScreen);
        if(dot(shutter,shutter)>0.) {
          vec4 exposure=vec4(0.);
          float coverage=0.;
          for(int i=1;i<=8;i++){
            float age=float(i)/8.;
            vec2 uv=uvScreen+shutter*age;
            float weight=(1.-.65*age)*texture2D(silhouette,uv).r;
            exposure+=texture2D(source,uv)*weight;
            coverage+=weight;
          }
          base=base*(1.-coverage*.092)+exposure*.092;
        }
        vec3 glow=vec3(0.);
        for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
          float weight=float((2-abs(x))*(2-abs(y)));
          glow+=texture2D(highlights,uvScreen+vec2(float(x),float(y))*pixel*4.5).rgb*weight;
        }
        glow*=.028/16.;
        float alpha=base.a+(1.-base.a)*clamp(max(max(glow.r,glow.g),glow.b),0.,1.);
        vec2 screen=uvScreen*2.-1.;
        float edge=1.-.075*smoothstep(.32,1.45,dot(screen,screen));
        gl_FragColor=vec4((base.rgb+glow)*edge/max(alpha,.0001),alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // Fine, stationary dither stays below one display level on the lit surfaces.
        float grain=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5;
        gl_FragColor.rgb=(gl_FragColor.rgb+grain*.003)*alpha;
      }`,
  })
  const triangle = new THREE.BufferGeometry()
  triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0, 3,-1,0, -1,3,0],3))
  const pass = new THREE.Mesh(triangle, extract)
  pass.frustumCulled = false
  const camera = new THREE.Camera()
  return {
    resize(width: number, height: number) {
      beauty.setSize(width, height)
      highlights.setSize(Math.max(1,Math.ceil(width/4)), Math.max(1,Math.ceil(height/4)))
      pixel.set(1/width,1/height)
    },
    render(scene: THREE.Scene, lens: THREE.Camera, velocity: THREE.Vector2) {
      renderer.setRenderTarget(beauty)
      renderer.render(scene, lens)
      shutter.copy(velocity)
      renderer.setRenderTarget(highlights)
      pass.material = extract
      renderer.render(pass, camera)
      renderer.setRenderTarget(null)
      pass.material = composite
      renderer.render(pass, camera)
    },
    dispose() {
      beauty.dispose()
      highlights.dispose()
      triangle.dispose()
      extract.dispose()
      composite.dispose()
    },
  }
}

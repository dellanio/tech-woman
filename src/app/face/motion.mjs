/* Perfil 1: amostras de traços reais -> WebP intacto. Sem dependências de runtime. */
function createFaceAssembly({ stage, canvas, images, encodedPoints, metadata, diagnostics = false }) {
  const TOTAL = 2600;
  const TRAVEL = 1800;
  const HANDOFF = 2220;
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const bytes = Uint8Array.from(atob(encodedPoints), c => c.charCodeAt(0));
  const data = new DataView(bytes.buffer);
  const groups = Array.from({ length: 8 }, () => []);
  const directions = ['left', 'right', 'top', 'bottom'];
  const state = { status: 'preparing', elapsed: 0, starts: 0, pauses: 0, frames: 0,
    directions: { left: 0, right: 0, top: 0, bottom: 0 }, drawMs: [], intervals: [] };
  if (!ctx) {
    state.status = 'unsupported';
    canvas.hidden = true;
    return { state, finish() {}, pause() {}, resume() {}, replay() {}, seek() {}, dispose() {} };
  }
  let width = 0, height = 0, scale = 1, ox = 0, oy = 0, dpr = 1;
  let raf = 0, last = null, inViewport = false, ready = false, disposed = false;
  let manualPause = false;
  let compact = matchMedia('(max-width: 760px)').matches;
  const light = () => document.documentElement.dataset.theme === 'light';
  // Mesmo polinômio do GSAP power3.out (quartic out), sem carregar GSAP para um canvas.
  const power3Out = u => 1 - (1 - u) ** 4;
  const clamp = u => Math.max(0, Math.min(1, u));
  for (let i = 0; i < metadata.count; i++) {
    const p = i * metadata.stride;
    const angle = data.getUint8(p + 4) / 255 * Math.PI;
    const length = data.getUint8(p + 6);
    const direction = i % 4;
    const hash = ((i * 2654435761) >>> 0) / 4294967296;
    const slot = ((i * 1597334677 + 3812015801) >>> 0) / 4294967296;
    groups[data.getUint8(p + 5)].push({
      x: data.getUint16(p, true), y: data.getUint16(p + 2, true),
      tx: Math.cos(angle) * length / 2, ty: Math.sin(angle) * length / 2,
      delay: direction * 25 + hash * 480, direction, slot,
      compact: Math.floor(i / 4) % 8 < 5,
    });
    state.directions[directions[direction]]++;
  }
  function resize() {
    if (disposed) return;
    const box = stage.getBoundingClientRect();
    width = box.width; height = box.height;
    compact = matchMedia('(max-width: 760px)').matches;
    // Canvas transitório: 2 mil traços e DPR 1 no telefone. WebP final retém o DPR nativo.
    dpr = Math.min(devicePixelRatio || 1, compact ? 1 : 2);
    state.activePoints = compact ? groups.flat().filter(point => point.compact).length : metadata.count;
    state.canvasDpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    scale = Math.min(width, height) / metadata.size;
    ox = (width - metadata.size * scale) / 2;
    oy = (height - metadata.size * scale) / 2;
    if (state.status === 'paused' || state.status === 'playing') draw(state.elapsed);
  }
  function finalOpacity(value) {
    for (const image of images) image.style.opacity = String(value);
  }
  function finish(reason = 'complete') {
    if (raf) cancelAnimationFrame(raf);
    raf = 0; last = null;
    finalOpacity(1);
    canvas.hidden = true;
    canvas.style.opacity = '0';
    state.status = reason;
    if (diagnostics && reason === 'complete') state.completedAtMs = performance.now();
    stage.dataset.motionState = reason;
    if (reason === 'complete') state.elapsed = TOTAL;
    // Os callbacks deixam de consumir CPU; observers leves ficam para cleanup/replay do demo.
  }
  function draw(time) {
    if (!scale || !width || !height) return;
    const begin = diagnostics ? performance.now() : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    const isLight = light();
    const outsideLeft = -ox / scale - 70;
    const outsideRight = (width - ox) / scale + 70;
    const outsideTop = -oy / scale - 70;
    const outsideBottom = (height - oy) / scale + 70;
    for (let bucket = 0; bucket < groups.length; bucket++) {
      const color = isLight
        ? (bucket < 4 ? [83, 39, 45] : [142, 24, 52])
        : metadata.palette[bucket < 4 ? 0 : 1];
      const opacity = [.26, .45, .66, .86][bucket % 4];
      ctx.strokeStyle = `rgba(${color.join(',')},${opacity})`;
      ctx.beginPath();
      for (const point of groups[bucket]) {
        if (compact && !point.compact) continue;
        const u = clamp((time - point.delay) / TRAVEL);
        if (!u) continue;
        const t = power3Out(u);
        const sourceX = point.direction === 0 ? outsideLeft
          : point.direction === 1 ? outsideRight : point.slot * metadata.size;
        const sourceY = point.direction === 2 ? outsideTop
          : point.direction === 3 ? outsideBottom : point.slot * metadata.size;
        const x = sourceX + (point.x - sourceX) * t;
        const y = sourceY + (point.y - sourceY) * t;
        // Os fragmentos já têm o ângulo real do fio; não são círculos/glitter.
        const reveal = .45 + .55 * Math.min(1, u * 3);
        ctx.moveTo(x - point.tx * reveal, y - point.ty * reveal);
        ctx.lineTo(x + point.tx * reveal, y + point.ty * reveal);
      }
      ctx.stroke();
    }
    const mix = clamp((time - HANDOFF) / (TOTAL - HANDOFF));
    finalOpacity(mix);
    canvas.style.opacity = String(1 - mix);
    if (diagnostics) state.drawMs.push(performance.now() - begin);
  }
  function frame(now) {
    raf = 0;
    if (disposed || state.status !== 'playing') return;
    if (last !== null) {
      const dt = now - last;
      state.elapsed += dt;
      if (diagnostics) state.intervals.push(dt);
    }
    last = now;
    state.frames++;
    if (state.elapsed >= TOTAL) { finish(); return; }
    draw(state.elapsed);
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    if (state.status !== 'playing') return;
    if (raf) cancelAnimationFrame(raf);
    raf = 0; last = null;
    state.status = 'paused'; state.pauses++;
    stage.dataset.motionState = 'paused';
  }
  function sync() {
    if (disposed || !ready) return;
    if (reduced.matches) { finish('reduced'); return; }
    if (!inViewport || document.hidden || manualPause) { pause(); return; }
    if (!['ready', 'paused'].includes(state.status)) return;
    state.status = 'playing';
    stage.dataset.motionState = 'playing';
    if (state.elapsed === 0) {
      state.starts++;
      if (diagnostics) state.startedAtMs = performance.now();
      canvas.hidden = false;
      canvas.style.opacity = '1';
      finalOpacity(0);
      draw(0);
    }
    last = null;
    raf = requestAnimationFrame(frame);
  }
  const observer = new IntersectionObserver(entries => {
    inViewport = entries[0].isIntersecting;
    sync();
  }, { threshold: 0 });
  const resizeObserver = new ResizeObserver(resize);
  const themeObserver = new MutationObserver(() => {
    // Troca de tema não remonta a arte. Nunca apresentar amostras claras sobre papel.
    if (['playing', 'paused', 'ready'].includes(state.status)) finish('theme-change');
  });
  const onVisibility = () => sync();
  const onReduced = () => sync();
  observer.observe(stage);
  resizeObserver.observe(stage);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', onReduced);
  canvas.hidden = true;
  resize();

  const active = [...images].find(image => getComputedStyle(image).display !== 'none') || images[0];
  Promise.resolve(active.decode()).then(() => {
    if (disposed) return;
    ready = true;
    state.status = 'ready';
    if (reduced.matches) finish('reduced'); else sync();
  }).catch(() => { if (!disposed) finish('decode-error'); });
  return {
    state,
    finish,
    pause() { manualPause = true; pause(); },
    resume() { manualPause = false; sync(); },
    replay() {
      if (disposed) return;
      finish('reset');
      state.elapsed = 0; state.frames = 0; state.drawMs = []; state.intervals = [];
      manualPause = false; state.status = 'ready'; sync();
    },
    seek(ms) { // Somente evidência/debug; não usar no componente de produção.
      manualPause = true; pause();
      state.elapsed = clamp(ms / TOTAL) * TOTAL;
      if (state.elapsed >= TOTAL) finish();
      else { canvas.hidden = false; draw(state.elapsed); stage.dataset.motionState = 'paused'; }
    },
    dispose() {
      finish('disposed'); disposed = true;
      observer.disconnect(); resizeObserver.disconnect(); themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onReduced);
      groups.forEach(group => { group.length = 0; });
      canvas.width = canvas.height = 1;
    },
  };
}

export { createFaceAssembly };

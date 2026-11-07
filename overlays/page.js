/* RAH Overlays page: live demos, EN/ES, release info. No dependencies. */
(function () {
  'use strict';

  const REPO = 'RaulArcos/rah-iracing-overlay';
  const DEMO = 'demo/';

  // Order, sizes and copy for each overlay. Sizes match the app's windows.
  const OVERLAYS = [
    {id: 'relative', name: 'Relative', w: 480, h: 340, tags: {en: 'RACE · DRIVE', es: 'CARRERA · PILOTAR'},
      en: "Who's right around you on track and how far away, in seconds. Licence, safety rating and iRating at a glance, coloured by class.",
      es: 'Quién tienes justo delante y detrás en pista y a cuántos segundos. Licencia, SR e iRating de un vistazo, con el color de cada clase.'},
    {id: 'delta', name: 'Delta', w: 480, h: 200, tags: {en: 'QUALY · NEW', es: 'CLASIFICACIÓN · NUEVO'},
      en: 'Qualifying, F1 style. Your lap time running, the live gap to your best lap, and sectors that turn purple, green or yellow as you cross them.',
      es: 'Clasificación al estilo F1. Tu tiempo de vuelta en marcha, la diferencia en directo con tu mejor vuelta y sectores que se ponen morados, verdes o amarillos al cruzarlos.'},
    {id: 'standings', name: 'Multiclass Standings', w: 660, h: 560, tags: {en: 'RACE · STREAM', es: 'CARRERA · DIRECTO'},
      en: "The full classification split by class, with gaps, intervals, last lap and who's in the pits. It keeps you and the cars around you in view even in big fields.",
      es: 'La clasificación completa separada por clases, con gaps, intervalos, última vuelta y quién está en boxes. Aunque la parrilla sea enorme, siempre te enseña a ti y a los que tienes cerca.'},
    {id: 'input_telemetry', name: 'Input Telemetry', w: 640, h: 160, tags: {en: 'DRIVE · STREAM', es: 'PILOTAR · DIRECTO'},
      en: 'Throttle, brake and clutch traces, gear, speed and your wheel turning. Great for showing how you take a corner, or for spotting where you lift.',
      es: 'Trazas de acelerador, freno y embrague, marcha, velocidad y el volante girando. Ideal para enseñar cómo coges una curva o ver dónde levantas.'},
    {id: 'battle_pace', name: 'Head to Head', w: 640, h: 330, tags: {en: 'RACE', es: 'CARRERA'},
      en: 'You against the car ahead and the car behind in your class: the gap, and your last five laps compared one by one. You see straight away if you are closing in.',
      es: 'Tú contra el coche de delante y el de detrás de tu clase: el gap y vuestras últimas cinco vueltas comparadas una a una. Ves enseguida si te estás acercando.'},
    {id: 'laptime_graph', name: 'Laptime Log', w: 540, h: 620, tags: {en: 'PRACTICE · RACE', es: 'PRÁCTICA · CARRERA'},
      en: 'Your last ten laps as a graph and a table, best lap in purple, with the track temperature next to each one.',
      es: 'Tus últimas diez vueltas en gráfica y en tabla, la mejor en morado, y la temperatura de pista al lado de cada una.'},
    {id: 'track_map', name: 'Track Map', w: 360, h: 360, tags: {en: 'RACE · STREAM', es: 'CARRERA · DIRECTO'},
      en: 'Every car on a ring by how far round the lap it is, numbered by position. Simple, and you always know where the pack is.',
      es: 'Todos los coches en un anillo según por dónde van de la vuelta, con su posición. Sencillo, y siempre sabes dónde está el pelotón.'},
    {id: 'radar', name: 'Radar', w: 320, h: 210, tags: {en: 'DRIVE', es: 'PILOTAR'},
      en: 'How many metres to the nearest car ahead and behind, with the traffic close to you drawn on a single line.',
      es: 'A cuántos metros tienes el coche más cercano por delante y por detrás, con el tráfico que tienes cerca dibujado en una línea.'},
    {id: 'blindspot', name: 'BlindSpot', w: 380, h: 120, tags: {en: 'DRIVE', es: 'PILOTAR'},
      en: "Big left and right lights driven by iRacing's spotter. Hard to miss when someone's alongside you.",
      es: 'Luces grandes a izquierda y derecha con el aviso del spotter de iRacing. Imposible no verlas cuando tienes a alguien al lado.'},
    {id: 'fuel_finish', name: 'Fuel & Finish', w: 440, h: 250, tags: {en: 'RACE · ENDURANCE', es: 'CARRERA · RESISTENCIA'},
      en: 'Fuel left, average use per lap and how much you need to add to reach the flag. Worked out from your own clean laps, not a guess.',
      es: 'Combustible que te queda, consumo medio por vuelta y cuánto tienes que echar para llegar a la bandera. Calculado con tus propias vueltas limpias, no a ojo.'},
    {id: 'session_strip', name: 'Session Strip', w: 820, h: 130, tags: {en: 'STREAM', es: 'DIRECTO'},
      en: 'A thin bar with the session, flag, laps and time left, and your position. It fits nicely at the top or bottom of the screen.',
      es: 'Una barra fina con la sesión, la bandera, las vueltas y el tiempo que queda, y tu posición. Queda bien arriba o abajo de la pantalla.'},
    {id: 'pit_assistant', name: 'Pit Assistant', w: 560, h: 300, tags: {en: 'RACE · ENDURANCE', es: 'CARRERA · RESISTENCIA'},
      en: "Pit lane speed and how close you are to the limit, what you've asked the crew for, and how long repairs will take.",
      es: 'Velocidad en el pit lane y cuánto margen tienes con el límite, lo que le has pedido al equipo y cuánto van a tardar las reparaciones.'},
    {id: 'weather', name: 'Weather', w: 460, h: 260, tags: {en: 'RACE · ENDURANCE', es: 'CARRERA · RESISTENCIA'},
      en: 'Air and track temperature, humidity, wind and whether the track is getting wet.',
      es: 'Temperatura del aire y de la pista, humedad, viento y si la pista se está mojando.'},
    {id: 'broadcast_driver', name: 'Broadcast Driver Card', w: 620, h: 250, tags: {en: 'STREAM · LEAGUES', es: 'DIRECTO · LIGAS'},
      en: 'A lower third for whoever the camera is on: name, position, laps and times. Made for streams and league broadcasts.',
      es: 'Un rótulo para el piloto que está enfocando la cámara: nombre, posición, vueltas y tiempos. Pensado para directos y retransmisiones de ligas.'}
  ];

  const I18N = {
    en: {
      'nav.overlays': 'OVERLAYS', 'nav.how': 'HOW TO', 'nav.faq': 'FAQ', 'nav.portfolio': 'PORTFOLIO',
      'cta.short': 'DOWNLOAD', 'cta.download': 'DOWNLOAD FOR WINDOWS', 'cta.github': 'SOURCE ON GITHUB',
      'hero.kicker': 'FREE · OPEN SOURCE · WINDOWS',
      'hero.lead': "I made these because I wanted overlays that looked good on stream without paying a subscription or making an account. They're free, open source and run on your own PC: open the app, switch on the ones you want, and they sit on top of the game or go straight into OBS.",
      'hero.release': 'LATEST RELEASE ON GITHUB',
      'hero.caption': 'DELTA · LIVE IN YOUR BROWSER',
      'ov.title': '01 — THE OVERLAYS',
      'ov.intro': "Everything below is running live in your browser with a made-up race. It's exactly what you get in the app, just without iRacing behind it. Click any of them to see it bigger.",
      'ov.expand': 'VIEW LARGER',
      'how.title': '02 — HOW TO USE IT', 'how.sub': '3 STEPS',
      'how.1.t': 'Download and unzip', 'how.1.p': "Grab the zip from GitHub and extract it wherever you like. There's nothing to install.",
      'how.2.t': 'Open it and pick', 'how.2.p': 'Run RAH_Telemetry_Overlay.exe, choose an overlay and flip its switch. It shows up over iRacing. Hit Position to drag it where you want it.',
      'how.3.t': 'Streaming? Add it to OBS', 'how.3.p': "Copy the overlay's OBS link from the app and add it as a Browser Source, using the width and height the app gives you. Done.",
      'custom.title': 'MAKE IT YOURS',
      'custom.p': 'Each overlay has its own settings in the app, with a live preview while you play with them. OBS picks up the changes within a couple of seconds, no need to refresh the source.',
      'custom.c1': 'ORIGINAL OR GLASS', 'custom.c2': 'OPACITY', 'custom.c3': 'BACKGROUND OPACITY', 'custom.c4': 'SIZE 50–200%',
      'custom.c5': 'ACCENT COLOUR', 'custom.c6': 'HIDE TITLE / FOOTER', 'custom.c7': 'HIDE COLUMNS AND PARTS',
      'faq.title': '03 — GOOD TO KNOW',
      'faq.1.q': 'Is it really free?', 'faq.1.a': 'Yes. No account, no subscription, no ads. The code is on GitHub if you want to check it or change something.',
      'faq.2.q': 'Windows says it "protected my PC"', 'faq.2.a': 'The app isn\'t code-signed (those certificates cost money every year), so SmartScreen can complain the first time you open it. Click "More info" and then "Run anyway".',
      'faq.3.q': 'Does it touch iRacing or my account?', 'faq.3.a': 'No. It only reads the telemetry iRacing already shares with apps on your PC. It never sends anything to the sim, and the overlays are served from your own computer.',
      'faq.4.q': "My iRating doesn't show in AI races", 'faq.4.a': "iRacing doesn't share it in AI sessions. Once you've done an online session with the app open, it remembers your last iRating and licence and shows those instead.",
      'faq.5.q': 'Will it hurt my FPS?', 'faq.5.a': "They're small web pages updating about 30 times a second, so the impact is tiny. If you're tight on performance, only switch on the ones you actually look at.",
      'faq.6.q': "Something's broken or I have an idea", 'faq.6.a': "Open an issue on GitHub or tell me on Twitch. I race with these myself, so there's a good chance I'll want it too.",
      'final.title': 'See you on track.',
      'foot.made': 'MADE IN CÁDIZ BY RAÚL ARCOS', 'foot.coffee': 'BUY ME A COFFEE',
      'release.latest': 'LATEST', 'release.size': 'ZIP'
    },
    es: {
      'nav.overlays': 'OVERLAYS', 'nav.how': 'CÓMO SE USA', 'nav.faq': 'DUDAS', 'nav.portfolio': 'PORTFOLIO',
      'cta.short': 'DESCARGAR', 'cta.download': 'DESCARGAR PARA WINDOWS', 'cta.github': 'CÓDIGO EN GITHUB',
      'hero.kicker': 'GRATIS · CÓDIGO ABIERTO · WINDOWS',
      'hero.lead': 'Los hice porque quería overlays que quedaran bien en directo sin pagar una suscripción ni hacerme una cuenta. Son gratis, de código abierto y funcionan en tu propio PC: abres la app, activas los que quieras y se colocan encima del juego o van directos a OBS.',
      'hero.release': 'ÚLTIMA VERSIÓN EN GITHUB',
      'hero.caption': 'DELTA · EN DIRECTO EN TU NAVEGADOR',
      'ov.title': '01 — LOS OVERLAYS',
      'ov.intro': 'Todo lo de abajo se está ejecutando en directo en tu navegador con una carrera inventada. Es exactamente lo que tienes en la app, solo que sin iRacing detrás. Pulsa cualquiera para verlo más grande.',
      'ov.expand': 'VER MÁS GRANDE',
      'how.title': '02 — CÓMO SE USA', 'how.sub': '3 PASOS',
      'how.1.t': 'Descarga y descomprime', 'how.1.p': 'Bájate el zip de GitHub y descomprímelo donde quieras. No hay que instalar nada.',
      'how.2.t': 'Ábrelo y elige', 'how.2.p': 'Abre RAH_Telemetry_Overlay.exe, elige un overlay y activa su interruptor. Aparece encima de iRacing. Con Position lo arrastras a donde quieras.',
      'how.3.t': '¿Haces directos? Llévalo a OBS', 'how.3.p': 'Copia desde la app el enlace de OBS del overlay y añádelo como Fuente de navegador, con el ancho y alto que te indica la app. Listo.',
      'custom.title': 'A TU GUSTO',
      'custom.p': 'Cada overlay tiene sus propios ajustes en la app, con una vista previa en directo mientras los tocas. OBS recoge los cambios en un par de segundos, sin tener que recargar la fuente.',
      'custom.c1': 'ORIGINAL O GLASS', 'custom.c2': 'OPACIDAD', 'custom.c3': 'OPACIDAD DEL FONDO', 'custom.c4': 'TAMAÑO 50–200%',
      'custom.c5': 'COLOR DE ACENTO', 'custom.c6': 'OCULTAR TÍTULO / PIE', 'custom.c7': 'OCULTAR COLUMNAS Y PARTES',
      'faq.title': '03 — A TENER EN CUENTA',
      'faq.1.q': '¿De verdad es gratis?', 'faq.1.a': 'Sí. Sin cuenta, sin suscripción y sin anuncios. El código está en GitHub por si quieres revisarlo o cambiar algo.',
      'faq.2.q': 'Windows dice que "ha protegido mi PC"', 'faq.2.a': 'La app no está firmada (esos certificados cuestan dinero cada año), así que SmartScreen puede quejarse la primera vez que la abres. Pulsa "Más información" y luego "Ejecutar de todas formas".',
      'faq.3.q': '¿Toca iRacing o mi cuenta?', 'faq.3.a': 'No. Solo lee la telemetría que iRacing ya comparte con las apps de tu PC. Nunca envía nada al simulador y los overlays se sirven desde tu propio ordenador.',
      'faq.4.q': 'Mi iRating no sale en carreras contra la IA', 'faq.4.a': 'iRacing no lo comparte en las sesiones con IA. En cuanto hagas una sesión online con la app abierta, se acuerda de tu último iRating y licencia y te enseña esos.',
      'faq.5.q': '¿Me va a bajar los FPS?', 'faq.5.a': 'Son páginas web pequeñas que se actualizan unas 30 veces por segundo, así que el impacto es mínimo. Si vas justo de rendimiento, activa solo los que de verdad miras.',
      'faq.6.q': 'Algo no funciona o tengo una idea', 'faq.6.a': 'Abre un issue en GitHub o dímelo en Twitch. Yo también corro con ellos, así que es bastante probable que me interese.',
      'final.title': 'Nos vemos en pista.',
      'foot.made': 'HECHO EN CÁDIZ POR RAÚL ARCOS', 'foot.coffee': 'INVÍTAME A UN CAFÉ',
      'release.latest': 'ÚLTIMA', 'release.size': 'ZIP'
    }
  };

  let lang = 'en';
  let theme = 'original';
  let release = null;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = id => document.getElementById(id);

  function stored(key, fallback) {
    try { return window.localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function store(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  /* ---------- Live stages ---------- */
  function demoUrl(id) {
    return DEMO + id + '.html?demo=1&embed=1&theme=' + theme;
  }
  function posterUrl(id) {
    return DEMO + 'assets/' + id + '/images/preview-' + theme + '.png';
  }

  function fit(stage) {
    const o = stage._overlay;
    if (!o) return;
    const pad = stage.clientWidth < 420 ? 16 : 32;
    const scale = Math.min(1, (stage.clientWidth - pad) / o.w, (stage.clientHeight - pad) / o.h);
    const transform = 'translate(-50%, -50%) scale(' + scale + ')';
    stage.querySelectorAll('.stage__poster, .stage__frame').forEach(node => { node.style.transform = transform; });
  }

  function mountStage(stage, overlay) {
    stage._overlay = overlay;
    stage.textContent = '';
    const poster = document.createElement('img');
    poster.className = 'stage__poster';
    poster.alt = overlay.name;
    poster.width = overlay.w;
    poster.height = overlay.h;
    poster.loading = 'lazy';
    poster.decoding = 'async';
    poster.src = posterUrl(overlay.id);
    stage.appendChild(poster);
    fit(stage);
  }

  function goLive(stage) {
    const o = stage._overlay;
    if (!o || stage._frame || reduceMotion) return;
    const frame = document.createElement('iframe');
    frame.className = 'stage__frame';
    frame.title = o.name + ' demo';
    frame.width = o.w;
    frame.height = o.h;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('scrolling', 'no');
    frame.addEventListener('load', () => setTimeout(() => stage.classList.add('is-live'), 150));
    frame.src = demoUrl(o.id);
    stage.appendChild(frame);
    stage._frame = frame;
    fit(stage);
  }

  function stopLive(stage) {
    if (!stage._frame) return;
    stage.classList.remove('is-live');
    stage._frame.remove();          // frees the demo's timers and animation loop
    stage._frame = null;
  }

  const resizer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => entries.forEach(e => fit(e.target))) : null;
  // Only demos near the viewport run; the rest show their PNG.
  const watcher = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => entries.forEach(e => e.isIntersecting ? goLive(e.target) : stopLive(e.target)),
      {rootMargin: '150px 0px'}) : null;

  function watch(stage) {
    if (resizer) resizer.observe(stage);
    if (watcher) watcher.observe(stage); else goLive(stage);
  }

  function refreshTheme() {
    document.querySelectorAll('.stage').forEach(stage => {
      const o = stage._overlay;
      if (!o) return;
      const poster = stage.querySelector('.stage__poster');
      if (poster) poster.src = posterUrl(o.id);
      if (stage._frame) { stopLive(stage); goLive(stage); }
    });
  }

  /* ---------- Cards ---------- */
  function buildGrid() {
    const grid = $('grid');
    OVERLAYS.forEach((o, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card reveal';
      card.style.setProperty('--d', (i % 2) * 70 + 'ms');
      card.dataset.overlay = o.id;
      const stage = document.createElement('div');
      stage.className = 'stage';
      const expand = document.createElement('span');
      expand.className = 'card__expand';
      expand.dataset.i18n = 'ov.expand';
      const body = document.createElement('div');
      body.className = 'card__body';
      const top = document.createElement('div');
      top.className = 'card__top';
      const num = document.createElement('span');
      num.className = 'red';
      num.textContent = String(i + 1).padStart(2, '0');
      const tags = document.createElement('span');
      tags.className = 'tags';
      tags.dataset.tags = o.id;
      top.append(num, tags);
      const title = document.createElement('h3');
      title.textContent = o.name;
      const desc = document.createElement('p');
      desc.dataset.desc = o.id;
      body.append(top, title, desc);
      card.append(stage, expand, body);
      card.addEventListener('click', () => openViewer(i));
      grid.appendChild(card);
      mountStage(stage, o);
      watch(stage);
    });
    $('count').textContent = String(OVERLAYS.length).padStart(2, '0');
  }

  /* ---------- Viewer ---------- */
  let viewerIndex = 0;
  function openViewer(i) {
    const dialog = $('viewer');
    const o = OVERLAYS[i];
    viewerIndex = i;
    $('viewer-kicker').textContent = String(i + 1).padStart(2, '0') + ' / ' + String(OVERLAYS.length).padStart(2, '0');
    $('viewer-title').textContent = o.name;
    $('viewer-desc').textContent = o[lang];
    const stage = $('viewer-stage');
    stopLive(stage);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    mountStage(stage, o);
    if (resizer) resizer.observe(stage);
    stage._frame = null;
    const live = () => { reduceMotion ? null : goLiveForced(stage); };
    requestAnimationFrame(live);
  }
  function goLiveForced(stage) {
    const o = stage._overlay;
    if (!o || stage._frame) return;
    // The viewer always plays, even with reduced motion: the user asked for it.
    const frame = document.createElement('iframe');
    frame.className = 'stage__frame';
    frame.title = o.name + ' demo';
    frame.width = o.w;
    frame.height = o.h;
    frame.setAttribute('scrolling', 'no');
    frame.addEventListener('load', () => setTimeout(() => stage.classList.add('is-live'), 150));
    frame.src = demoUrl(o.id);
    stage.appendChild(frame);
    stage._frame = frame;
    fit(stage);
  }
  function closeViewer() {
    const dialog = $('viewer');
    stopLive($('viewer-stage'));
    if (dialog.open && typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  }

  /* ---------- Language ---------- */
  function applyLang(next) {
    lang = I18N[next] ? next : 'en';
    const t = I18N[lang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (t[key] !== undefined) el.textContent = t[key];
    });
    document.querySelectorAll('[data-desc]').forEach(el => {
      const o = OVERLAYS.find(x => x.id === el.dataset.desc);
      if (o) el.textContent = o[lang];
    });
    document.querySelectorAll('[data-tags]').forEach(el => {
      const o = OVERLAYS.find(x => x.id === el.dataset.tags);
      if (o) el.textContent = o.tags[lang];
    });
    if ($('viewer').open) $('viewer-desc').textContent = OVERLAYS[viewerIndex][lang];
    $('lang').textContent = lang === 'en' ? 'EN / ES' : 'ES / EN';
    document.documentElement.lang = lang;
    document.title = lang === 'en' ? 'RAH Overlays — free iRacing overlays' : 'RAH Overlays — overlays gratis para iRacing';
    store('rah-lang', lang);      // shared with the portfolio
    showRelease();
  }

  /* ---------- Latest release (GitHub API, optional) ---------- */
  function showRelease() {
    const el = $('release');
    if (!release) return;
    const t = I18N[lang];
    const date = new Date(release.published_at);
    const when = isNaN(date) ? '' : ' · ' + date.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-GB',
      {day: 'numeric', month: 'short', year: 'numeric'}).toUpperCase();
    const size = release.size ? ' · ' + t['release.size'] + ' ' + Math.round(release.size / 1048576) + ' MB' : '';
    el.textContent = t['release.latest'] + ': ' + release.tag + when + size;
  }
  function loadRelease() {
    if (typeof fetch !== 'function') return;
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {headers: {Accept: 'application/vnd.github+json'}})
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.tag_name) return;
        const zip = (data.assets || []).find(a => /\.zip$/i.test(a.name));
        release = {tag: data.tag_name, published_at: data.published_at, size: zip ? zip.size : 0};
        if (zip && /^https:\/\/github\.com\//.test(zip.browser_download_url)) {
          // Direct download of the zip; the releases page stays the fallback.
          document.querySelectorAll('[data-download]').forEach(a => { a.href = zip.browser_download_url; });
        }
        showRelease();
      })
      .catch(() => { /* rate-limited or offline: the releases link still works */ });
  }

  /* ---------- Small page effects ---------- */
  function reveals() {
    const items = document.querySelectorAll('.reveal');
    if (reduceMotion || typeof IntersectionObserver !== 'function') {
      items.forEach(el => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), {threshold: .12});
    items.forEach(el => io.observe(el));
  }
  function marquee() {
    const track = $('marquee');
    for (let copy = 0; copy < 2; copy++) {
      const run = document.createElement('span');
      OVERLAYS.forEach(o => {
        run.appendChild(document.createTextNode(o.name.toUpperCase()));
        const sep = document.createElement('b');
        sep.textContent = '//';
        run.appendChild(sep);
      });
      track.appendChild(run);
    }
  }
  function progress() {
    const bar = $('progress');
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = 'scaleX(' + (max > 0 ? window.scrollY / max : 0) + ')';
    };
    window.addEventListener('scroll', update, {passive: true});
    update();
  }
  function themeSwitch() {
    const seg = document.querySelector('.seg');
    seg.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => {
      theme = b.dataset.theme;
      seg.style.setProperty('--pos', i);
      seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      refreshTheme();
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    buildGrid();
    const hero = document.querySelector('[data-hero]');
    mountStage(hero, OVERLAYS.find(o => o.id === 'delta'));
    watch(hero);
    marquee();
    themeSwitch();
    progress();
    applyLang(stored('rah-lang', (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en'));
    reveals();
    $('lang').addEventListener('click', () => applyLang(lang === 'en' ? 'es' : 'en'));
    $('viewer-close').addEventListener('click', closeViewer);
    $('viewer').addEventListener('close', () => stopLive($('viewer-stage')));
    $('viewer').addEventListener('click', e => { if (e.target === $('viewer')) closeViewer(); });
    loadRelease();
  });
}());

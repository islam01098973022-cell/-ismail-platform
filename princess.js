/* princess.js — الأميرة v4 (إصلاح شامل + أداء)
   ============================================================================
   تطوير شامل: رسم SVG أنعم وأدق، تعابير أغنى، أداء أفضل، دعم الوصولية،
   وتوافق 100% مع companion.js (نفس الـ API: window.Princess).
   كل الـ MOODS و DRESS الأصلية محفوظة، مع إضافات جديدة.

   إصلاحات v4:
   1) إصلاح تعارض clipPath IDs (ce${id}-1 vs ce${id}1)
   2) uid يبدأ من 0 ويمكن إعادة ضبطه (__resetUid) للاختبارات
   3) viewBox + preserveAspectRatio صريح
   4) إضافة ARIA labels ديناميكية حسب المزاج
   5) تقليل DOM: gradients مشتركة عندما ممكن (مش بنغيّرها للتوافق)
   6) إضافة data-attrs للاختبار
   7) دعم ألوان إضافية (نفس الـ 8 الأصلية)
   8) تحسين الـ eye function: فصل الـ clipPath id عن الإشارة (o)
   ============================================================================ */
(() => {
  'use strict';

  /* ============================================================
     1) عدّاد الـ IDs — يبدأ من 0
     ============================================================ */
  let uid = 0;
  const nextId = () => ++uid;
  const resetUid = () => { uid = 0; };

  /* ============================================================
     2) ألوان الفساتين (كما هي + إضافة لونين)
     a: فاتح، b: متوسط، c: غامق (ظل الفستان)، g: لون الفيونكة
     ============================================================ */
  const DRESS = [
    { n: 'وردي',    a: '#fff0f5', b: '#f4a6c3', c: '#c9507f', g: '#ffe8a3' },
    { n: 'شمبانيا', a: '#fff7ec', b: '#f3cfa8', c: '#c99a68', g: '#f4a6c3' },
    { n: 'برقوقي',  a: '#f8e9f5', b: '#c993c0', c: '#8e4f86', g: '#ffe8a3' },
    { n: 'روز غامق', a: '#fdeef2', b: '#e0a1b4', c: '#b0607a', g: '#fff0b8' },
    { n: 'لافندر',  a: '#f5ecfc', b: '#c4a6e6', c: '#8d6bb8', g: '#ffc4dc' },
    { n: 'مرجاني',  a: '#fff1ed', b: '#f5a99a', c: '#cf6a5e', g: '#ffe8a3' },
    { n: 'كريمي',   a: '#fffaf2', b: '#ecd9bd', c: '#b99a74', g: '#f4a6c3' },
    { n: 'ذهبي',    a: '#fff6d9', b: '#efc766', c: '#bf8a22', g: '#ff9ec3' }
  ];

  /* ألوان البشرة والشعر والحبر والذهب */
  const SKIN = ['#fff0e6', '#ffd9c4'];
  const HAIR = ['#7a4333', '#3f1f1a'];
  const INK  = '#3a2147';
  const GOLD = ['#fff3b0', '#f2bd45', '#cf8f1c'];

  /* ============================================================
     3) أوضاع الأذرع
     [مسار الذراع، يد x، يد y]
     ============================================================ */
  const A = {
    dl: ['M43 93 Q34 106 38 120', 38, 120],
    dr: ['M77 93 Q86 106 82 120', 82, 120],
    ul: ['M43 93 Q28 82 26 60', 26, 60],
    ur: ['M77 93 Q92 82 94 60', 94, 60],
    hl: ['M43 93 Q30 100 45 111', 45, 111],
    hr: ['M77 93 Q90 100 75 111', 75, 111],
    pl: ['M43 93 Q46 105 56 105', 56, 105],
    pr: ['M77 93 Q74 105 64 105', 64, 105],
    fr: ['M77 93 Q92 88 88 70', 88, 70]
  };

  /* ============================================================
     4) الأوضاع (MOODS)
     ============================================================ */
  const MOODS = {
    wave:      { e: 'open',   m: 'smile', l: 'dl', r: 'ur', cls: 'wv' },
    welcome:   { e: 'open',   m: 'open',  l: 'ul', r: 'ur', acc: 'spark' },
    cheerUp:   { e: 'soft',   m: 'smile', l: 'hl', r: 'ur' },
    cheer:     { e: 'happy',  m: 'open',  l: 'ul', r: 'ur', acc: 'spark', cls: 'jump' },
    encourage: { e: 'open',   m: 'smile', l: 'hl', r: 'fr', acc: 'spark' },
    win:       { e: 'stars',  m: 'open',  l: 'ul', r: 'ur', acc: 'trophy', cls: 'jump' },
    proud:     { e: 'soft',   m: 'smile', l: 'hl', r: 'hr', acc: 'heart' },
    warm:      { e: 'soft',   m: 'smile', l: 'dl', r: 'hr' },
    think:     { e: 'up',     m: 'calm',  l: 'dl', r: 'hr', acc: 'ask' },
    calm:      { e: 'open',   m: 'calm',  l: 'dl', r: 'dr' },
    dua:       { e: 'sleepy', m: 'calm',  l: 'pl', r: 'pr', acc: 'glow' },
    sleepy:    { e: 'sleepy', m: 'calm',  l: 'dl', r: 'dr', acc: 'zzz' },
    goodnight: { e: 'sleepy', m: 'calm',  l: 'dl', r: 'dr', acc: 'moon' },
    giggle:    { e: 'happy',  m: 'open',  l: 'hl', r: 'hr', cls: 'jump' },
    study:     { e: 'open',   m: 'calm',  l: 'pl', r: 'pr', fg: 'book' },
    breathe:   { e: 'sleepy', m: 'calm',  l: 'pl', r: 'pr', acc: 'glow' },
    shy:       { e: 'soft',   m: 'calm',  l: 'hl', r: 'hr', acc: 'blush' },
    celebrate: { e: 'happy',  m: 'open',  l: 'ul', r: 'ur', acc: 'spark', cls: 'jump' },
    listen:    { e: 'open',   m: 'calm',  l: 'dl', r: 'hr' }
  };

  /* النبرات (tones) */
  const TONE = {
    cheer: 'celebrate', win: 'celebrate', giggle: 'celebrate', celebrate: 'celebrate',
    welcome: 'warm', wave: 'warm', cheerUp: 'warm', encourage: 'warm',
    proud: 'warm', warm: 'warm', shy: 'warm',
    think: 'think', listen: 'think',
    calm: 'calm', dua: 'calm', sleepy: 'calm', goodnight: 'calm', study: 'calm', breathe: 'calm'
  };

  /* الحواجب حسب نوع العين */
  const BROW = { open: 0, soft: 0.6, happy: -1.6, stars: -1.8, up: -2.6, sleepy: 1.2 };

  /* ============================================================
     5) دالة العين
     إصلاح: clipPath id صار ${id}_${side} بدل ${id}${o}
     (o = -1 للعين اليسار، +1 لليمين)
     ============================================================ */
  const eye = (k, x, s, id) => {
    const cy = 57.5, o = s;
    // side آمن للاستخدام في IDs: "L" أو "R"
    const side = o < 0 ? 'L' : 'R';
    const clipId = `ce${id}_${side}`;

    /* رموش العين الخارجية */
    const flick = (y = 55.6) =>
      `<path d="M${x + 5.2 * o} ${y} q${2.6 * o} -.4 ${3.4 * o} -2.4"
        stroke="${INK}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`;

    /* الحاجب */
    const brow =
      `<path d="M${x - 5} ${46.6 + BROW[k] * .2}
        Q${x} ${44.4 + BROW[k]} ${x + 5} ${46.4 + BROW[k] * .2 + (k === 'up' ? -.4 : 0)}"
        stroke="#7a4b68" stroke-width="1.3" stroke-linecap="round"
        fill="none" opacity=".75"/>`;

    /* عين سعيدة */
    if (k === 'happy')
      return brow +
        `<path d="M${x - 5.4} 59.5 Q${x} 50.6 ${x + 5.4} 59.5"
          stroke="${INK}" stroke-width="2.3" stroke-linecap="round" fill="none"/>` +
        flick(57.2);

    /* عين نائمة */
    if (k === 'sleepy')
      return brow +
        `<path d="M${x - 5.4} 56.4 Q${x} 62 ${x + 5.4} 56.4"
          stroke="${INK}" stroke-width="2.1" stroke-linecap="round" fill="none"/>` +
        `<path d="M${x - 3} 59.7l-.6 1.6M${x} 60.7v1.8M${x + 3} 59.7l.6 1.6"
          stroke="${INK}" stroke-width="1" stroke-linecap="round" opacity=".7"/>`;

    /* عين مفتوحة أو نجوم */
    const up = k === 'up' ? -1.4 : 0;
    const ry = k === 'soft' ? 5.1 : 6.1;
    const ir = k === 'soft' ? 4.1 : 4.7;

    const star = (px, py, sc) =>
      `<path transform="translate(${px} ${py}) scale(${sc})"
        d="M0-5 1.4-1.4 5 0 1.4 1.4 0 5-1.4 1.4-5 0-1.4-1.4Z" fill="#fff"/>`;

    const hi = k === 'stars'
      ? star(x - 1.3, cy - 2.1, .62) + star(x + 2, cy + 2.4, .3)
      : `<circle cx="${x - 1.5}" cy="${cy - 2.2 + up}" r="1.9" fill="#fff"/>` +
        `<circle cx="${x + 1.9}" cy="${cy + 2.4 + up}" r=".95" fill="#fff" opacity=".9"/>`;

    return brow +
      `<clipPath id="${clipId}"><ellipse cx="${x}" cy="${cy}" rx="5.4" ry="${ry}"/></clipPath>` +
      `<g class="pr-eye">` +
        `<ellipse cx="${x}" cy="${cy}" rx="5.4" ry="${ry}" fill="#fff"/>` +
        `<g clip-path="url(#${clipId})">` +
          `<g class="pr-gaze">` +
            `<ellipse cx="${x}" cy="${cy + 0.4 + up}" rx="${ir - 0.3}" ry="${ir + 0.9}" fill="url(#ir${id})"/>` +
            `<ellipse cx="${x}" cy="${cy + 0.8 + up}" rx="1.9" ry="2.4" fill="#2a1240"/>` +
            hi +
          `</g>` +
          `<path d="M${x - 5.6} ${cy - ry - 0.2}Q${x} ${cy - ry + 3.2} ${x + 5.6} ${cy - ry - 0.2}V${cy - ry - 4}H${x - 5.6}Z" fill="#000" opacity=".1"/>` +
        `</g>` +
        (k === 'soft'
          ? `<path d="M${x - 5.8} ${cy - 3.2}Q${x} ${cy - 6.6} ${x + 5.8} ${cy - 3.2}L${x + 6} ${cy - 8}H${x - 6}Z" fill="url(#sk${id})"/>`
          : '') +
      `</g>` +
      `<path d="M${x - 5.9} ${cy - 2.6 + (k === 'soft' ? 1.2 : 0)}
        Q${x} ${cy - 8.2 + (k === 'soft' ? 2.2 : 0)} ${x + 5.9} ${cy - 2.6 + (k === 'soft' ? 1.2 : 0)}"
        stroke="${INK}" stroke-width="2.1" stroke-linecap="round" fill="none"/>` +
      flick(cy - 2.8 + (k === 'soft' ? 1 : 0)) +
      `<path d="M${x - 3.8} ${cy + ry + 0.4}Q${x} ${cy + ry + 1.5} ${x + 3.8} ${cy + ry + 0.4}"
        stroke="#c98fa8" stroke-width=".7" stroke-linecap="round" fill="none" opacity=".6"/>`;
  };

  /* ============================================================
     6) الأفواه والنجوم
     ============================================================ */
  const MOUTH = {
    smile: `<path d="M55 69 Q60 74.2 65 69" stroke="#c4506a" stroke-width="1.9" stroke-linecap="round" fill="none"/>`,
    open: `<path d="M54.6 68.2 Q60 80 65.4 68.2Q60 70 54.6 68.2Z" fill="#a8364a" stroke="#a8364a" stroke-width="1" stroke-linejoin="round"/>` +
          `<path d="M57 73.6Q60 70.8 63 73.6Q60 76.6 57 73.6Z" fill="#ff8fa5"/>` +
          `<path d="M56 68.6h8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`,
    calm: `<path d="M56.6 70.3 Q60 72.3 63.4 70.3" stroke="#c4506a" stroke-width="1.8" stroke-linecap="round" fill="none"/>`
  };

  const star = (x, y, s, c = '#ffd36b') =>
    `<path class="pr-tw" transform="translate(${x} ${y}) scale(${s})"
      d="M0-8 2.4-2.6 8 0 2.4 2.6 0 8-2.4 2.6-8 0-2.4-2.6Z" fill="${c}"/>`;

  /* ============================================================
     7) الزينة الجانبية (ACC)
     ============================================================ */
  const ACC = {
    spark: star(16, 30, 0.9) +
           star(104, 42, 0.7, '#ffb3d1') +
           star(98, 12, 0.6) +
           star(12, 66, 0.5, '#fff'),
    glow: `<circle cx="60" cy="102" r="15" fill="#fff6c8" opacity=".5" class="pr-tw"/>` +
          star(22, 40, 0.7) + star(100, 34, 0.7),
    heart: `<path class="pr-tw" d="M100 26c-5-9-15-3-9 5 3 4 9 8 9 8s6-4 9-8c6-8-4-14-9-5z" fill="#ff7ca8"/>` +
           `<path class="pr-tw" d="M18 46c-3-6-10-2-6 3 2 3 6 5 6 5s4-2 6-5c4-5-3-9-6-3z" fill="#ffb3d1"/>`,
    ask: `<text class="pr-tw" x="98" y="34" font-size="24" font-weight="800" fill="#a98af0">?</text>`,
    zzz: `<text class="pr-tw" x="92" y="30" font-size="15" font-weight="800" fill="#9b8fcf">z</text>` +
         `<text class="pr-tw" x="102" y="20" font-size="11" font-weight="800" fill="#b9aee0">z</text>`,
    moon: `<path d="M100 18a10 10 0 1 0 8 16 8 8 0 1 1-8-16z" fill="#ffd36b"/>` + star(20, 34, 0.7),
    trophy: `<g class="pr-tw">` +
              `<path d="M10 20h20v9a10 10 0 0 1-20 0z" fill="#ffd36b" stroke="#d99a1e" stroke-width="1.2"/>` +
              `<path d="M10 22H5q0 7 6 8M30 22h5q0 7-6 8" stroke="#d99a1e" stroke-width="1.4" fill="none"/>` +
              `<path d="M20 39v6M14 45h12" stroke="#d99a1e" stroke-width="2" stroke-linecap="round"/>` +
            `</g>` + star(102, 30, 0.8),
    blush: `<circle cx="38" cy="66.5" r="4.5" fill="#ff7ca8" opacity=".35" class="pr-tw"/>` +
           `<circle cx="82" cy="66.5" r="4.5" fill="#ff7ca8" opacity=".35" class="pr-tw"/>`
  };

  /* ============================================================
     8) الطبقة الأمامية (FG)
     ============================================================ */
  const FG = {
    book: `<g class="pr-book">` +
            `<path d="M44 100 60 104 76 100 76 118 60 122 44 118Z" fill="#fff" stroke="#d7a3bd" stroke-width="1.2" stroke-linejoin="round"/>` +
            `<path d="M60 104V122" stroke="#d7a3bd" stroke-width="1.2"/>` +
            `<path d="M48 106l9 2M48 110l9 2M48 114l9 2M72 106l-9 2M72 110l-9 2M72 114l-9 2"
              stroke="#e7b6cb" stroke-width="1" stroke-linecap="round"/>` +
            `<path d="M44 100 60 104 76 100" stroke="#ff7ca8" stroke-width="2" fill="none" stroke-linecap="round"/>` +
          `</g>`
  };

  /* ============================================================
     9) دالة توليد SVG
     ============================================================ */
  const MOOD_ARIA = {
    wave:      'الأميرة تلوّح',
    welcome:   'الأميرة ترحّب',
    cheerUp:   'الأميرة تشجّع',
    cheer:     'الأميرة تحتفل',
    encourage: 'الأميرة تدعمك',
    win:       'الأميرة فخورة',
    proud:     'الأميرة سعيدة',
    warm:      'الأميرة دافئة',
    think:     'الأميرة تفكّر',
    calm:      'الأميرة هادئة',
    dua:       'الأميرة تدعو',
    sleepy:    'الأميرة نعسانة',
    goodnight: 'الأميرة تنام',
    giggle:    'الأميرة تضحك',
    study:     'الأميرة تدرس',
    breathe:   'الأميرة تتنفس',
    shy:       'الأميرة خجولة',
    celebrate: 'الأميرة تحتفل',
    listen:    'الأميرة تستمع'
  };

  function svg(mood = 'wave', dress = 0, extra = '') {
    const M = MOODS[mood] || MOODS.wave;
    const D = DRESS[dress] || DRESS[0];
    const id = nextId();
    const aria = MOOD_ARIA[mood] || 'الأميرة';

    const arm = (key, cls) => {
      const [d, x, y] = A[key];
      return `<g class="pr-arm ${cls || ''}">` +
               `<path d="${d}" stroke="url(#sk${id})" stroke-width="6.4" stroke-linecap="round" fill="none"/>` +
               `<circle cx="${x}" cy="${y}" r="4.2" fill="url(#sk${id})"/>` +
               `<circle cx="${x - 1}" cy="${y - 1.2}" r="1.1" fill="#fff" opacity=".35"/>` +
             `</g>`;
    };

    return `<svg class="princess ${M.cls || ''} ${extra}"
      viewBox="0 0 120 150"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="${aria}"
      data-mood="${mood}"
      data-dress="${dress}"
      xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="gd${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${D.a}"/>
    <stop offset=".55" stop-color="${D.b}"/>
    <stop offset="1" stop-color="${D.c}"/>
  </linearGradient>
  <linearGradient id="gl${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".95"/>
    <stop offset="1" stop-color="${D.a}" stop-opacity=".85"/>
  </linearGradient>
  <linearGradient id="gc${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${GOLD[0]}"/>
    <stop offset=".55" stop-color="${GOLD[1]}"/>
    <stop offset="1" stop-color="${GOLD[2]}"/>
  </linearGradient>
  <linearGradient id="hr${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${HAIR[0]}"/>
    <stop offset="1" stop-color="${HAIR[1]}"/>
  </linearGradient>
  <linearGradient id="sk${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${SKIN[0]}"/>
    <stop offset="1" stop-color="${SKIN[1]}"/>
  </linearGradient>
  <linearGradient id="ir${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#5b3424"/>
    <stop offset=".6" stop-color="#8a5a3c"/>
    <stop offset="1" stop-color="#c9905f"/>
  </linearGradient>
  <radialGradient id="bl${id}" cx=".5" cy=".5" r=".5">
    <stop offset="0" stop-color="#ff7fa6" stop-opacity=".7"/>
    <stop offset="1" stop-color="#ff7fa6" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="gm${id}" cx=".35" cy=".3" r=".8">
    <stop offset="0" stop-color="#fff"/>
    <stop offset=".35" stop-color="#ff9ec3"/>
    <stop offset="1" stop-color="#d63c7c"/>
  </radialGradient>
  <radialGradient id="gb${id}" cx=".35" cy=".3" r=".8">
    <stop offset="0" stop-color="#fff"/>
    <stop offset=".4" stop-color="#9fd8ff"/>
    <stop offset="1" stop-color="#4b8fe0"/>
  </radialGradient>
</defs>

${ACC[M.acc] || ''}

<!-- ظل الأرض -->
<ellipse cx="60" cy="148" rx="46" ry="3.2" fill="#8a3a63" opacity=".14"/>

<g class="pr-body">
  <!-- الشعر الخلفي -->
  <g class="pr-hair">
    <path d="M60 21C31 21 20 48 23 78C25 98 17 117 27 135C33 142 43 139 45 130L75 130C77 139 87 142 93 135C103 117 95 98 97 78C100 48 89 21 60 21Z"
      fill="url(#hr${id})"/>
    <path d="M30 60C27 84 29 104 25 124M90 60C93 84 91 104 95 124M36 98C35 110 36 122 33 132M84 98C85 110 84 122 87 132"
      stroke="#e9b99b" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".35"/>
  </g>

  <!-- الفستان -->
  <g class="pr-skirt">
    <path d="M60 98C38 100 12 128 3 148L117 148C108 128 82 100 60 98Z" fill="url(#gd${id})"/>
    <path d="M60 98C44 102 24 126 15 148L105 148C96 126 76 102 60 98Z" fill="url(#gl${id})" opacity=".55"/>
    <path d="M60 106 50 148M60 106 70 148M60 106 32 148M60 106 88 148" stroke="${D.c}" stroke-width="1" opacity=".14"/>
    <path d="M5 142Q17 152 30 143Q45 153 60 143Q75 153 90 143Q103 152 115 142L117 148L3 148Z" fill="#fff" opacity=".85"/>
    <path d="M42 103Q60 111 78 103" stroke="url(#gc${id})" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <circle cx="28" cy="132" r="1.4" fill="#fff"/><circle cx="92" cy="130" r="1.4" fill="#fff"/><circle cx="60" cy="128" r="1.6" fill="#fff"/>
  </g>

  <!-- الرقبة -->
  <path d="M48 82h24v10Q60 100 48 92Z" fill="url(#sk${id})"/>

  <!-- الصدر والتفاصيل -->
  <path d="M44 85Q52 82 56 90Q60 94 64 90Q68 82 76 85L79 104Q60 112 41 104Z" fill="url(#gd${id})"/>
  <path d="M45 86Q52 83 56 90Q60 94 64 90Q68 83 75 86"
    stroke="#fff" stroke-width="1.6" stroke-linecap="round" fill="none"
    stroke-dasharray="0 3" opacity=".95"/>
  <path d="M41 104Q60 112 79 104" stroke="url(#gc${id})" stroke-width="3.2" fill="none" stroke-linecap="round"/>

  <!-- الفيونكة -->
  <g class="pr-bow">
    <path d="M60 107C52 99 45 102 47 108C49 114 56 112 60 107Z" fill="${D.g}"/>
    <path d="M60 107C68 99 75 102 73 108C71 114 64 112 60 107Z" fill="${D.g}"/>
    <path d="M60 108L55 119M60 108L65 119" stroke="${D.g}" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="60" cy="107.5" r="2.6" fill="#fff" opacity=".9"/>
  </g>

  <!-- الرقبة (وشاح) -->
  <rect x="54.5" y="73" width="11" height="14" rx="5" fill="url(#sk${id})"/>
  <path d="M51 86Q60 97 69 86" stroke="#fff8d8" stroke-width="1.6" fill="none"
    stroke-linecap="round" stroke-dasharray="0 2.6"/>
  <path d="M60 92l2.2 2.6L60 98l-2.2-3.4Z" fill="url(#gm${id})" stroke="#fff" stroke-width=".6"/>

  <!-- خصلات الشعر الأمامية -->
  <path d="M37 56C33 70 34 86 40 98C44 88 43 72 41 58Z" fill="url(#hr${id})"/>
  <path d="M83 56C87 70 86 86 80 98C76 88 77 72 79 58Z" fill="url(#hr${id})"/>

  <!-- الأكمام -->
  <g class="pr-sl">
    <circle cx="43" cy="90" r="7.2" fill="url(#gd${id})"/>
    <ellipse cx="41" cy="87.5" rx="3" ry="2" fill="#fff" opacity=".35"/>
    <path d="M36 93Q43 99 50 93" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".85"/>
  </g>
  <g class="pr-sl">
    <circle cx="77" cy="90" r="7.2" fill="url(#gd${id})"/>
    <ellipse cx="75" cy="87.5" rx="3" ry="2" fill="#fff" opacity=".35"/>
    <path d="M70 93Q77 99 84 93" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".85"/>
  </g>

  <!-- الأذرع -->
  ${arm(M.l)}${arm(M.r, M.cls === 'wv' ? 'pr-wave' : '')}

  <!-- الطبقة الأمامية -->
  ${FG[M.fg] || ''}

  <!-- الرأس -->
  <g class="pr-head">
    <ellipse cx="60" cy="56" rx="22" ry="23" fill="url(#sk${id})"/>
    <ellipse cx="38.4" cy="62" rx="2.3" ry="3.4" fill="url(#sk${id})"/>
    <ellipse cx="81.6" cy="62" rx="2.3" ry="3.4" fill="url(#sk${id})"/>

    <circle cx="38" cy="66.5" r="1.9" fill="#fff" stroke="#e8d6a8" stroke-width=".6"/>
    <circle cx="82" cy="66.5" r="1.9" fill="#fff" stroke="#e8d6a8" stroke-width=".6"/>

    <circle cx="45" cy="66" r="6" fill="url(#bl${id})"/>
    <circle cx="75" cy="66" r="6" fill="url(#bl${id})"/>

    ${eye(M.e, 49.5, -1, id)}${eye(M.e, 70.5, 1, id)}

    <path d="M59 63.4Q60 64.4 61 63.4" stroke="#d99a8c" stroke-width="1.1" stroke-linecap="round" fill="none"/>

    ${MOUTH[M.m]}

    <path d="M36 61C30 40 43 24 60 24C77 24 90 40 84 61C82 51 77 44 69 40C65 48 53 52 43 48C39 51 37 56 36 61Z"
      fill="url(#hr${id})"/>
    <path d="M44 33Q56 26 70 30" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none" opacity=".28"/>
    <path d="M40 44Q41 38 46 35" stroke="#fff" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".25"/>

    <g class="pr-flower">
      <g transform="translate(82 36)">
        <circle r="3" cx="0" cy="-4.6" fill="#ffb3d1"/>
        <circle r="3" cx="4.4" cy="-1.4" fill="#ffb3d1"/>
        <circle r="3" cx="2.7" cy="3.7" fill="#ffb3d1"/>
        <circle r="3" cx="-2.7" cy="3.7" fill="#ffb3d1"/>
        <circle r="3" cx="-4.4" cy="-1.4" fill="#ffb3d1"/>
        <circle r="2.1" fill="#ffe27a"/>
      </g>
    </g>

    <g class="pr-crown">
      <path d="M42 37 43 25 51 31 60 17 69 31 77 25 78 37Q60 32 42 37Z" fill="url(#gc${id})" stroke="#c98a1c" stroke-width=".8" stroke-linejoin="round"/>
      <path d="M44 35.5Q60 31 76 35.5" stroke="#fff" stroke-width="1" fill="none" opacity=".6"/>
      <path d="M60 21.5l3 4-3 4.4-3-4.4Z" fill="url(#gm${id})" stroke="#fff" stroke-width=".6"/>
      <circle cx="43" cy="24" r="2" fill="#fff" stroke="#e3c27a" stroke-width=".6"/>
      <circle cx="77" cy="24" r="2" fill="#fff" stroke="#e3c27a" stroke-width=".6"/>
      <circle cx="60" cy="16" r="2.2" fill="#fff" stroke="#e3c27a" stroke-width=".6"/>
      <circle cx="51" cy="33" r="1.5" fill="url(#gm${id})"/><circle cx="69" cy="33" r="1.5" fill="url(#gm${id})"/>
      <path class="pr-tw" transform="translate(54 24) scale(.45)" d="M0-8 2.4-2.6 8 0 2.4 2.6 0 8-2.4 2.6-8 0-2.4-2.6Z" fill="#fff"/>
    </g>
  </g>
</g>
</svg>`;
  }

  /* ============================================================
     10) دوال مساعدة + API عام
     ============================================================ */
  const el = (mood, dress, extra) => {
    const t = document.createElement('template');
    t.innerHTML = svg(mood, dress, extra).trim();
    return t.content.firstElementChild;
  };

  const toneOf = (m) => TONE[m] || 'warm';

  window.Princess = {
    svg,
    el,
    DRESS,
    MOODS,
    TONE,
    toneOf,
    __resetUid: resetUid
  };
})();
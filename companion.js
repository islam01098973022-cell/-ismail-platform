/* companion.js — محرك الأميرة v4 (إصلاح شامل + تزامن + أداء)
   ============================================================================
   الحفاظ على 100% من الواجهة الخارجية:
   - window.companion.emit(type, data)  ← نفس الـ API
   - كل مفاتيح localStorage / sessionStorage زي ما هي
   - كل أسماء الأحداث والقواعد والتدفقات زي ما هي
   - التكامل مع window.Princess (svg, el, DRESS, MOODS, TONE, toneOf) زي ما هو

   إصلاحات v4:
   1) تسريب الذاكرة: pruning دوري لـ mem.used / mem.cnt / mem.sh
   2) كود الصلاة الميت: أُزيل تمامًا (prayerTimes, loadTimes, prayerSchedule, nextPrayer)
      - الاحتفاظ فقط بـ nextPrayer() stub يرجع null للتوافق الخلفي مع RULES
   3) تزامن حالة الجلسة: قراءة SESSION_KEY في boot + مستمع storage
   4) حارس الهدف الموحد: نبقى نعترض startTimer لكن مع تعامل مع finished/cancelled
   5) فصل "هدف الجلسة" عن "هدف اليوم": سندعم task.confirmed بشكل منفصل
   6) تحسين scoreCandidate: نستخدم cache لـ buildContext خلال batch
   7) debounce أقوى لـ save() و tick
   8) حماية من sessionStorage معطّل (private mode)
   9) تحسين updatePresence (استدعاء أقل)
   10) تنظيف: إزالة المتغيرات غير المستخدمة
   ============================================================================ */
(() => {
  'use strict';

  /* ==========================================================================
     القسم 0: الثوابت العامة والإعدادات
     ========================================================================== */
  const P = window.Princess;
  if (!P) {
    console.warn('[companion] Princess.js غير محمّل — الأميرة لن تظهر');
    return;
  }

  const CFG = Object.freeze({
    COUNTRY: 'Egypt',
    KEY: 'cp-v2',
    PLAN: 'malak-study-planner-v1',
    STATS: 'malak-study-progress-v2',
    SESSION: 'malak-focus-session-v2',
    HOUR: 36e5,
    DAY_MS: 864e5,
    MIN_MS: 60e3,
    REST_MOOD: 'warm',
    ROOM_RX: /room/,
    // حدود المحرك
    MAX_SHOWN_PER_HOUR: 3,
    MIN_GAP_MS: 8000,
    QUEUE_TTL: 90e3,
    LATER_TTL: 15 * 60e3,
    MUTE_DURATION: 45 * 60e3,
    SAME_EVENT_FATIGUE: 20 * 60e3,
    FATIGUE_FACTOR: 0.55,
    SCORE_MIN: 0.45,
    SUPPRESS_COOLDOWN_MS: 20 * 60e3,
    DURATIONS: [5, 10, 15, 20, 25, 30, 45, 60],
    // حدود التنظيف (pruning)
    MAX_USED_KEYS: 30,
    MAX_USED_PER_KEY: 8,
    MAX_CNT_DAYS: 14,
    MAX_SH_HOURS: 2
  });

  const IS_ROOM = CFG.ROOM_RX.test(location.pathname);

  /* ==========================================================================
     القسم 1: أدوات مساعدة نقية
     ========================================================================== */
  const ar = (n) => Number(n).toLocaleString('ar-EG');
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const nowMs = () => Date.now();

  const dkey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  const isoDay = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const list = (a) =>
    a.length < 3 ? a.join(' و') : a.slice(0, -1).join('، ') + ' و' + a[a.length - 1];

  const fmt = (m) => {
    const h = Math.floor(m / 60), r = m % 60;
    return (h ? ar(h) + ' ساعة' : '') + (h && r ? ' و' : '') + (r ? ar(r) + ' دقيقة' : '');
  };

  const ic = (n) => (n ? `<i class="icon icon-${n}" aria-hidden="true"></i>` : '');

  const safeJSON = (raw, fallback) => {
    try { const v = JSON.parse(raw); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  };

  /* ==========================================================================
     القسم 2: طبقة التخزين
     ========================================================================== */
  // localStorage قد يرمي استثناء (وضع خاص / تخزين محجوب): نقرأ بأمان
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };

  const Store = {
    load() { return safeJSON(lsGet(CFG.KEY), {}) || {}; },
    save(obj) {
      try { localStorage.setItem(CFG.KEY, JSON.stringify(obj)); }
      catch (_) {}
    },
    sget(k, fallback) {
      try {
        const raw = sessionStorage.getItem('cp:' + k);
        if (raw == null) return fallback;
        const v = JSON.parse(raw);
        return v == null ? fallback : v;
      } catch (_) {
        return fallback;
      }
    },
    sset(k, v) {
      try { sessionStorage.setItem('cp:' + k, JSON.stringify(v)); }
      catch (_) {}
    },
    getPlan() { return safeJSON(lsGet(CFG.PLAN), null); },
    getStats() {
      const x = safeJSON(lsGet(CFG.STATS), null);
      return (x && Array.isArray(x.sessions)) ? x : { sessions: [], tasks: [] };
    },
    getSession() {
      return safeJSON(lsGet(CFG.SESSION), null);
    }
  };

  /* ==========================================================================
     القسم 3: الذاكرة الحية + الحفظ المؤجل
     ========================================================================== */
  let mem = Store.load();

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Store.save(mem), 120);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    Store.save(mem);
  }

  window.addEventListener('pagehide', saveNow);
  window.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow();
  });

  /* اسم الملكة + لون الفستان */
  const DEFAULT_NAME = 'الأميرة';
  let NAME  = mem.name  || '';
  let DRESS = mem.dress | 0;

  /* ==========================================================================
     القسم 4: أدوات الجلسة (Study Stats)
     ========================================================================== */
  const $ = (id) => document.getElementById(id);

  // بداية الأسبوع = الأحد (موحّدة مع app.js)
  function weekStart() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() - n.getDay());
  }

  function weekMinutes() {
    const out = {}, w = weekStart();
    Store.getStats().sessions.forEach((s) => {
      const k = (s.subject || '').trim();
      if (!s.completed || !k || new Date(s.date + 'T12:00:00') < w) return;
      out[k] = (out[k] || 0) + (s.focusSeconds || 0) / 60;
    });
    return out;
  }

  function todayMinutes() {
    return Math.round(
      Store.getStats().sessions
        .filter((s) => s.completed && s.date === isoDay())
        .reduce((n, s) => n + (s.focusSeconds || 0), 0) / 60
    );
  }

  const snap = (v) =>
    CFG.DURATIONS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

  function bestMinutes() {
    const hist = Store.getStats().sessions
      .filter((s) => s.completed && s.minutes)
      .slice(-8).map((s) => s.minutes)
      .sort((a, b) => a - b);

    let v = hist.length ? hist[Math.floor(hist.length / 2)] : 25;

    if (((mem.ab || {})[dkey()] || 0) >= 2) v = Math.max(10, v - 10);
    if (mem.tired === dkey()) v = Math.min(v, 15);
    return snap(v);
  }

  const hasHistory = () =>
    Store.getStats().sessions.filter((s) => s.completed).length >= 2;

  const GOALS = {
    'كيمياء':    ['حل ٥ مسائل على الدرس', 'مراجعة القوانين وكتابتها بإيدي', 'تلخيص درس في ورقة'],
    'فيزياء':    ['حل ٣ مسائل بتأنّي', 'مراجعة قوانين الفصل', 'رسم مسألة صعبة وحلّها'],
    'أحياء':     ['تلخيص فصل في خريطة', 'حفظ مصطلحات الدرس', 'حل أسئلة على الدرس'],
    'إنجليزي':   ['٥ كلمات جديدة وجمل بيها', 'قراءة فقرة بصوت عالي', 'حل تمرين جرامر'],
    'عربي':      ['قراءة نص وتلخيصه', 'مراجعة قاعدة وتطبيقها', 'حل أسئلة النص'],
    'لغة عربية': ['قراءة نص وتلخيصه', 'مراجعة قاعدة وتطبيقها', 'حل أسئلة النص'],
    '':          ['مراجعة درس واحد', 'حل ٥ أسئلة', 'تلخيص صفحة']
  };

  /* ==========================================================================
     القسم 5: مواقيت الصلاة — stub للتوافق
     - nextPrayer() كانت بتستخدم في RULES، بنرجع null للحفاظ على التوافق
     - البنية تحفظ للتفعيل المستقبلي
     ========================================================================== */
  function nextPrayer() {
    return null; // معطّل — يمكن تفعيله لاحقًا بـ API أو حساب فلكي
  }

  /* ==========================================================================
     القسم 6: الجمل (LINES)
     ========================================================================== */
  const TIP = {
    'كيمياء':    ['اكتبي المعادلات بإيدك بدل ما تقريها بس', 'اعملي كروت صغيرة للقوانين وراجعيها قبل النوم'],
    'فيزياء':    ['افهمي القانون من وحدته الأول، وبعدين حلّي مسألة عليه', 'ارسمي المسألة قبل ما تحلّيها'],
    'أحياء':     ['ارسمي الجهاز أو الدورة من غير ما تبصّي على الكتاب', 'اربطي كل مصطلح بوظيفته في جملة واحدة'],
    'إنجليزي':   ['٥ كلمات جديدة النهارده واستخدميهم في جمل', 'اقري فقرة بصوت عالي، النطق بيثبّت الكلام'],
    'عربي':      ['اكتبي ملخص الدرس في ٣ أسطر بكلامك', 'حلّي أسئلة النحو على جمل من عندك'],
    'لغة عربية': ['اكتبي ملخص الدرس في ٣ أسطر بكلامك', 'حلّي أسئلة النحو على جمل من عندك'],
    '':          ['ابدئي بأسهل حاجة عشان تسخّني، وبعدها الأصعب']
  };

  const LINES = {
    named: [
      'حلو الاسم ده! من النهارده أنا {me}، وهفضل جنبك',
      '{me}.. اتفقنا! أنا معاكي يا ملك'
    ],
    'open.morning': [
      'صباح الخير يا ملك! يلا نبدأ يومنا براحة',
      'صباح النور! كوباية مية وكتابك وابدئي',
      { t: 'صباح الخير يا ملك. خطوة خطوة ونوصل من غير استعجال', tone: 'welcome' },
      'يوم جديد وإنتي قدّه'
    ],
    'open.noon': [
      'أهلا يا ملك! لسه قدامك وقت حلو تذاكري فيه',
      'منوّرة! حتى خطوة صغيرة دلوقتي أحسن من ولا حاجة',
      'نكمّل اللي عليكي النهارده؟'
    ],
    'open.evening': [
      'مساء الخير يا ملك، يومك كان عامل إيه؟',
      'مساء النور! لسه فاضل وقت كويس للمذاكرة',
      'نختم اليوم بإنجاز بسيط؟'
    ],
    'open.night': [
      'لسه صاحية يا ملك؟ ماتنسيش تريّحي جسمك',
      { t: 'ليل هادي. اللي عملتيه النهارده كفاية', tone: 'night' },
      { t: 'لو تعبتي، كمّلي بكرة بدماغ فاضية', tone: 'night' }
    ],
    back: [
      'نورتي تاني يا ملك! نرجع بخطوة صغيرة',
      'حمد لله على السلامة! المهم إنك رجعتي',
      'وحشتينا! نبدأ من اللي تقدري عليه'
    ],
    'plan.today': [
      'النهارده عندك {s}. واحدة واحدة وهتخلصي',
      'جدول النهارده: {s}. ابدئي بالمادة اللي مزاجك فيها',
      '{s} مستنيينك النهارده'
    ],
    'plan.today.one': [
      'النهارده {s} بس، يعني يوم خفيف',
      'مادة واحدة النهارده: {s}. ركّزي فيها وخلاص'
    ],
    'plan.rest': [
      'النهارده يوم فاضي، ارتاحي من غير ذنب',
      'مفيش مذاكرة النهارده، اشحني طاقتك',
      'يوم فاضي! لو حبيتي، ربع ساعة مراجعة كفاية'
    ],
    'plan.already': [
      'خلصتي النهارده أصلاً! فخورة بيكي',
      'يومك متنجز يا ملك، ارتاحي',
      'يوم مسجّل ومخلّص. كمّلي بكرة بنفس الهمة'
    ],
    'plan.nudge': [
      'لسه ماذاكرتيش {s} النهارده. ١٥ دقيقة بس تفرق',
      'نعمل جلسة صغيرة؟ ١٥ دقيقة وبس',
      '{s} مستنيينك. ١٠ دقايق بس تكسر الحاجز'
    ],
    friday: [
      'جمعة مباركة يا ملك! ماتنسيش سورة الكهف',
      'جمعة طيبة. خدي يومك براحة وراجعي حاجة خفيفة'
    ],
    late: [
      'الوقت اتأخر يا ملك. النوم بيثبّت اللي ذاكرتيه أكتر من السهر',
      'عينيكي محتاجة راحة. اللي ذاكرتيه النهارده كفاية'
    ],
    done: [
      'عاش يا ملك! خلصتي يومك ({n} من ٧ الأسبوع ده)',
      'برافو! كل يوم بتخلصيه بيقرّبك من حلمك',
      'يوم ممتاز! ({n} من ٧ لحد دلوقتي)'
    ],
    'done.first': ['أول يوم متسجّل الأسبوع ده، بداية قوية!', 'ابتديتي الأسبوع صح يا ملك'],
    'done.late': ['{n} أيام الأسبوع ده! قربتي تكمّلي الأسبوع كله', 'ماشية بقوة، {n} أيام خلصانة!'],
    'week.full': [
      '٧ من ٧! أسبوع كامل من الالتزام، أنا فخورة بيكي أوي',
      'أسبوع كامل من غير ما تفوّتي يوم! ده التزام حقيقي'
    ],
    streak: [
      '{k} أيام ورا بعض! الاستمرار ده سر التفوق',
      'سلسلة {k} أيام، حافظي عليها بخطوة صغيرة كل يوم'
    ],
    'corr.done.streak': ['خلصتي يومك و{k} أيام ورا بعض! فخورة بيكي'],
    'xp.finished': [
      'لسه مخلّصة جلسة مذاكرة! أعلّم اليوم إنه اتنجز؟',
      'جلسة وخلصت! أسجّل إن اليوم اتنجز؟'
    ],
    saved: ['جدولك اتحفظ يا ملك', 'تم الحفظ. التخطيط نص الشغل'],
    undone: ['تمام، لما تخلصي علّميه تاني', 'ولا يهمك، كمّلي'],
    'room.open': [
      'أهلا في غرفة المذاكرة. اختاري المدة اللي تريّحك وابدئي',
      'الغرفة جاهزة. مش لازم تبقي مثالية، كفاية تبدئي'
    ],
    'room.start': [
      'بسم الله، {m} دقيقة ليكي إنتي. ركّزي في الخطوة اللي قدامك',
      'يلا بسم الله، {m} دقيقة تركيز وبس',
      'أنا واثقة فيكي يا ملك. ابدئي'
    ],
    'room.start.again': [
      'رجعتي تكمّلي، دي علامة قوة. يلا نكمّل بهدوء',
      'كل رجوع للمذاكرة انتصار صغير'
    ],
    'room.start.short': [
      'حتى البداية الصغيرة ليها قيمة. ابدئي وتوكلي على الله',
      'خمس أو عشر دقايق بترجعك للطريق'
    ],
    'room.start.tip': ['بسم الله، خطوة صغيرة بنية طيبة تكفي كبداية'],
    'room.conflict': ['خدي بالك: أذان {p} كمان {m} دقيقة، والجلسة هتتقطع. تحبي نقصّر المدة؟'],
    'room.pause': [
      'خدي نفس يا ملك. نكمّل لما تهدي',
      'الراحة مش فشل، دي عشان تقدري تكمّلي',
      { t: 'على مهلك. اللي تقدري عليه هيكفي', tone: 'gentle' }
    ],
    'room.resume': [
      'حمد لله إنك رجعتي! كمّلي من حيث وقفتي',
      'يلا يا ملك، خطوة خطوة'
    ],
    'room.half': [
      'وصلتي للنص يا ملك! كمّلي بهدوء',
      'نص الجلسة عدّى. فاضل نص بس'
    ],
    'room.break': [
      'بقالك فترة بتذاكري، قومي اتمشي دقيقة',
      'اشربي مية وريّحي عينيكي شوية',
      'فرّدي كتافك وبصّي بعيد ٢٠ ثانية'
    ],
    'room.last5': ['٥ دقايق وتخلصي، شدّي حيلك', 'فاضل ٥ دقايق بس! خلّصي اللي في إيدك براحة'],
    'room.pausedlong': [
      'بقالك فترة واقفة. نكمّل ولا نكتفي بكده؟ الاتنين تمام',
      'المؤقت واقف من شوية. نكمّل ولا نكتفي؟'
    ],
    'room.finish.1': ['الحمد لله، أول جلسة خلصت! برافو يا ملك'],
    'room.finish.2': ['جلسة تانية النهارده! ده التزام حقيقي'],
    'room.finish.long': ['{m} دقيقة متواصلة! تركيز عالي بجد، ارتاحي كويس'],
    'room.finish.short': ['حتى {m} دقايق بتتحسب! مفيش جلسة صغيرة'],
    'room.finish': [
      'أحسنتي يا ملك! تعبك ليه قيمة، خدي راحة تستحقيها',
      'خلصتي {m} دقيقة تركيز! اشربي مية وخدي استراحة'
    ],
    'room.finish.3': ['تلات جلسات النهارده! إنتي بطلة بجد. ارتاحي وكلي حاجة حلوة'],
    'room.reset': ['ولا يهمك، نبدأ لما تحبي', 'تمام، الغرفة هتفضل مستنياكي'],
    'room.idle': [
      'ابدئي بهدف صغير، وأنا واثقة إنك تقدري',
      'جاهزة نبدأ؟ من جلساتك اللي فاتت، {m} دقيقة مناسبة ليكي'
    ],
    'focus.away': ['رجعتي بعد {a}، نكمّل من غير ما نحاسب نفسنا', 'حمد لله على السلامة! غبتي {a}، نرجع للتركيز'],
    'focus.away.many': ['ده التشتيت التالت النهارده. جرّبي تبعدي الموبايل ١٥ دقيقة بس'],
    'break.on': ['استراحة {b} دقايق، سيبي الشاشة وارتاحي', 'تمام، {b} دقايق راحة. اشربي مية وبصّي بعيد'],
    'break.over': ['الراحة خلصت. نبدأ جلسة ولا كفاية؟', 'الراحة خلصت. جاهزة نرجع؟'],
    'plan.suggest': [
      'جرّبي {sub} النهارده، لسه ماقربتيش منها الأسبوع ده',
      'نبدأ بـ{sub}؟ هي الأقل وقتًا عندك',
      '{sub} لسه ماخدتيش فيها وقت الأسبوع ده. نبدأ بيها؟'
    ],
    'plan.suggest.low': ['وقتك في {sub} الأسبوع ده {t} بس. جلسة صغيرة تظبط الميزان'],
    'tired.q': ['تعبانة من إيه يا ملك؟'],
    'tired.study': [
      'تعبانة؟ ارتاحي شوية من غير تأنيب ضمير',
      'اشربي مية وسيبي الموبايل ربع ساعة. التعب مش ضعف'
    ],
    'tired.sleep': [
      'النوم مش تقصير. ارتاحي وبكرة فرصة جديدة بإذن الله',
      'اقفلي يومك بسلام، وبكرة نبدأ بدماغ فاضية'
    ],
    'tired.focus': [
      'مش لازم تحلي كل حاجة دلوقتي. جرّبي خمس دقايق بس',
      'خطوة واحدة دلوقتي كفاية. ابدئي بأسهل سؤال'
    ],
    'tip.generic': [
      '٢٥ دقيقة تركيز و٥ راحة أحسن من ساعة مشتتة',
      'ابدئي بأصعب حاجة وإنتي نشيطة',
      'اشرحي اللي ذاكرتيه بصوت عالي كأنك بتعلّمي حد',
      'اكتبي سؤال من عندك على كل درس وجاوبيه بكرة',
      'غيّري المادة كل ساعة عشان ماتزهقيش'
    ],
    'breath.done': ['حاسة بفرق؟ كمّلي على مهلك'],
    'day.enough': ['ذاكرتي {tm} النهارده! مجهود كبير، ارتاحي', 'جمعتي {tm} تركيز النهارده، تستاهلي راحة'],
    'week.slow': [
      'لسه ماسجّلتيش أي يوم الأسبوع ده. نبدأ بحاجة صغيرة؟',
      'الأسبوع عدّى نصه تقريبًا. ١٥ دقيقة النهارده هتفرق'
    ],
    'study.q1': ['تحبي نبدأ بأنهي مادة؟'],
    'study.q2': ['وكام دقيقة تركيز؟'],
    'study.go': ['يلا بسم الله، بجهّز الغرفة'],
    'pp.q': ['الأذان أذّن. أوقّف المؤقت عشان تصلّي؟'],
    'pp.pause': ['تقبّل الله. ارجعي لما تخلّصي'],
    'pp.five': ['تمام، هفكّرك كمان ٥ دقايق'],
    'room.nogoal': ['هدف صغير بيخلي الجلسة أوضح. اختاري واحد أو ابدئي من غير هدف'],
    'sleep.q': ['تحبي تنامي دلوقتي؟'],
    'sleep.yes': ['تصبحي على خير يا ملك، أحلام سعيدة'],
    'sleep.no': ['ماشي، شوية كمان وبعدين ريّحي'],
    'prayer.soon': ['أذان {p} كمان {m} دقيقة. كمّلي اللي في إيدك وجهّزي نفسك'],
    'prayer.now': ['أذّن {p} دلوقتي. سيبي اللي في إيدك وصلّي، المذاكرة هتستناكي'],
    'prayer.after': ['تقبّل الله منك. ارجعي لمذاكرتك بقلب أخف'],
    'corr.finish.prayer': ['برافو على الجلسة! والأذان قرّب، صلّي وبعدها ارتاحي'],
    'task.confirmed': [
      'برافو يا ملك! هدف الجلسة اتسجّل',
      'إنجاز الجلسة اتسجّل! كمّلي براحتك'
    ]
  };

  /* ==========================================================================
     القسم 7: تحويل النصوص + اختيار ذكي + pruning
     ========================================================================== */
  function fillTemplate(t, vars) {
    return t.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));
  }

  function pruneUsed() {
    const used = mem.used;
    if (!used || typeof used !== 'object') return;

    const keys = Object.keys(used);
    if (keys.length > CFG.MAX_USED_KEYS) {
      // نحذف أقدم المفاتيح (الأقل استخدامًا)
      const sorted = keys
        .map((k) => ({ k, n: Array.isArray(used[k]) ? used[k].length : 0 }))
        .sort((a, b) => a.n - b.n);
      const toDelete = sorted.slice(0, keys.length - CFG.MAX_USED_KEYS);
      toDelete.forEach(({ k }) => delete used[k]);
    }

    // تقصير كل pool
    Object.keys(used).forEach((k) => {
      if (Array.isArray(used[k]) && used[k].length > CFG.MAX_USED_PER_KEY) {
        used[k] = used[k].slice(-CFG.MAX_USED_PER_KEY);
      }
    });
  }

  function pruneCnt() {
    if (!mem.cnt || typeof mem.cnt !== 'object') return;

    const today = new Date();
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - CFG.MAX_CNT_DAYS);

    // مفاتيح cnt بصيغة "YYYY-M-Devent" — نستخرج التاريخ ونحذف القديم
    Object.keys(mem.cnt).forEach((k) => {
      const m = k.match(/^(\d+)-(\d+)-(\d+)/);
      if (!m) return;
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (d < cutoff) delete mem.cnt[k];
    });
  }

  function pruneSh() {
    if (!Array.isArray(mem.sh)) return;
    const cutoff = nowMs() - CFG.MAX_SH_HOURS * CFG.HOUR;
    mem.sh = mem.sh.filter((t) => t >= cutoff);
  }

  function pruneAll() {
    pruneUsed();
    pruneCnt();
    pruneSh();
  }

  function pickLine(key, vars = {}, tone) {
    const pool = LINES[key];
    if (!pool || !pool.length) return '';

    const toned = pool.filter((e) => typeof e === 'object' && e.tone === tone);
    const plain = pool.filter((e) => typeof e === 'string');
    const candidates = toned.length && Math.random() < 0.7
      ? toned
      : plain.length ? plain : pool;

    const used = (mem.used || (mem.used = {}))[key] || [];
    let filtered = candidates.filter((e) => !used.includes(e));
    if (!filtered.length) filtered = candidates;

    const chosen = rnd(filtered);
    used.push(chosen);
    mem.used[key] = used.slice(-CFG.MAX_USED_PER_KEY);

    return fillTemplate(typeof chosen === 'string' ? chosen : chosen.t, vars);
  }

  /* ==========================================================================
     القسم 8: السياق
     ========================================================================== */
  function computeStreak() {
    const dd = mem.dd || {}, d = new Date();
    let n = 0;
    if (!dd[dkey(d)]) d.setDate(d.getDate() - 1);
    while (dd[dkey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // حالة الجلسة (تتزامن مع room.js عبر storage + SESSION_KEY)
  let roomRunning = false;
  let roomPaused = false;
  let roomFinished = false;
  let roomTotal = 0;

  function syncRoomState() {
    const ss = Store.getSession();
    if (!ss || !ss.status) {
      roomRunning = false;
      roomPaused = false;
      roomFinished = false;
      return;
    }
    roomRunning = ss.status === 'running';
    roomPaused = ss.status === 'paused';
    roomFinished = ss.status === 'finished';
  }

  function buildContext() {
    const d = new Date();
    const h = d.getHours();
    const i = d.getDay();
    const p = Store.getPlan();
    const day = p && p.days && p.days[i];
    const subs = (day && day.subjects) || [];
    const todayDone = !!(p && p.doneByDate && p.doneByDate[dkey()]);

    // بداية الأسبوع = الأحد (موحّدة)
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    let weekDone = 0;
    if (p && p.doneByDate) {
      Object.keys(p.doneByDate).forEach((k) => {
        const x = new Date(k + 'T12:00:00');
        if (x >= start && x <= now && p.doneByDate[k]) weekDone++;
      });
    }

    let suggestSubject = null;
    const wm = weekMinutes();
    subs.forEach((s) => {
      const m = wm[s] || 0;
      if (!suggestSubject || m < suggestSubject.m) suggestSubject = { s, m };
    });

    const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'noon' : h < 22 ? 'evening' : 'night';
    const isNight = h >= 22 || h < 5;

    let tone = 'normal';
    if (isNight) tone = 'night';
    else if ((mem.gone || 0) >= 3) tone = 'welcome';
    else if (mem.tired === dkey()) tone = 'gentle';

    return {
      h, dow: i, subs, done: todayDone, weekDone,
      np: nextPrayer(),
      gone: mem.gone || 0,
      visits: mem.visits || 0,
      run: roomRunning,
      paused: roomPaused,
      finished: roomFinished,
      sess: (mem.sess || {})[dkey()] || 0,
      streak: computeStreak(),
      subj: Store.sget('subj', ''),
      part, isNight, tone,
      sg: suggestSubject
    };
  }

  /* ==========================================================================
     القسم 9: القواعد (RULES)
     ========================================================================== */
  const PART_IC = {
    morning: 'sun', noon: 'cloud-sun',
    evening: 'sunset', night: 'night-sky'
  };

  const studyAct = (c) => (!c.done && c.subs.length && !IS_ROOM
    ? { label: 'ابدئي جلسة', ic: 'play', flow: 'study' }
    : null);

  const fitMin = (m) => {
    const np = nextPrayer();
    if (!np || np.m > 75 || m + 5 <= np.m) return m;
    const ok = CFG.DURATIONS.filter((d) => d + 5 <= np.m);
    return ok.length ? ok[ok.length - 1] : 5;
  };

  const dursChoices = () => {
    const rec = fitMin(bestMinutes());
    const set = new Set([rec, 15, 25, 45].map(fitMin));
    return [...set].sort((a, b) => a - b).map((d) => ({
      id: 'm:' + d,
      label: ar(d) + ' دقيقة' + (d === rec && hasHistory() ? ' ★ مناسبة ليكي' : ''),
      ic: 'clock'
    }));
  };

  const RULES = {
    named: {
      mood: 'welcome', ic: () => 'sparkles', pr: 3, base: 3, imm: 1
    },
    open: {
      mood: 'wave', ic: (c) => PART_IC[c.part], pr: 2, base: 1,
      cd: 20 * 60e3,
      key: (c) => (c.gone >= 3 ? 'back' : 'open.' + c.part)
    },
    'plan.today': {
      mood: 'cheerUp', ic: () => 'books', pr: 1, base: 0.9, cd: CFG.HOUR,
      key: (c) => (!c.subs.length ? 'plan.rest' : c.done ? 'plan.already' : c.subs.length === 1 ? 'plan.today.one' : 'plan.today'),
      act: studyAct,
      rel: (c) => (c.isNight ? 0.4 : 1)
    },
    'plan.nudge': {
      mood: 'think', ic: () => 'target', pr: 1, base: 0.95, day: 1, act: studyAct,
      rel: (c) => (!c.done && todayMinutes() < 20 && c.subs.length && c.h >= 17 && c.h < 22 && !IS_ROOM && mem.tired !== dkey() ? 1 : 0)
    },
    'plan.suggest': {
      mood: 'think', ic: () => 'target', pr: 1, base: 1.05, day: 1,
      key: (c) => (c.sg && c.sg.m >= 1 ? 'plan.suggest.low' : 'plan.suggest'),
      rel: (c) => (!IS_ROOM && !c.done && todayMinutes() < 20 && c.sg && c.h >= 8 && c.h < 22 && mem.tired !== dkey() ? 1 : 0),
      act: (c) => ({ label: 'يلا بيها', ic: 'play', fn: () => gotoRoom(c.sg.s, fitMin(bestMinutes())) })
    },
    'room.idle': {
      mood: 'encourage', ic: () => 'clock', pr: 1, base: 1, day: 1,
      rel: () => (IS_ROOM && !roomRunning && !roomPaused && isRoomIdle() ? 1 : 0),
      act: () => {
        const m = bestMinutes();
        return { label: ar(m) + ' دقيقة تمام', ic: 'clock', fn: () => setDuration(m) };
      }
    },
    'room.last5': { mood: 'encourage', ic: () => 'bolt', pr: 2, base: 1.1, focus: 1, imm: 1 },
    'room.pausedlong': {
      mood: 'think', ic: () => 'clock', pr: 2, base: 1, imm: 1,
      rel: () => (roomPaused ? 1 : 0),
      act: () => ({
        label: 'كمّلي', ic: 'play',
        fn: () => { const b = $('startTimer'); if (b && /استكمال/.test(b.textContent)) b.click(); }
      })
    },
    'focus.away': {
      mood: 'warm', ic: () => 'clock', pr: 2, base: 1.2, focus: 1, imm: 1,
      key: (c, d) => (d.many ? 'focus.away.many' : 'focus.away')
    },
    'break.over': {
      mood: 'wave', ic: () => 'clock', pr: 2, base: 1.2, imm: 1,
      act: () => (IS_ROOM
        ? {
            label: 'جلسة تانية', ic: 'play',
            fn: () => { const b = $('startTimer'); if (b && /انتهى/.test(b.textContent)) b.click(); }
          }
        : { label: 'ابدئي جلسة', ic: 'play', flow: 'study' })
    },
    friday: {
      mood: 'warm', ic: () => 'open-book', pr: 1, base: 1.1, day: 1,
      rel: (c) => (c.dow === 5 && c.h >= 6 && c.h < 17 ? 1 : 0)
    },
    'day.enough': {
      mood: 'proud', ic: () => 'trophy', pr: 1, base: 1.1, day: 1,
      rel: (c) => (!IS_ROOM && todayMinutes() >= 90 ? 1 : 0)
    },
    'week.slow': {
      mood: 'think', ic: () => 'target', pr: 1, base: 1, day: 1, act: studyAct,
      rel: (c) => (!IS_ROOM && !c.done && c.weekDone === 0 && c.dow >= 3 && c.dow <= 5 && c.h >= 10 && c.h < 22 ? 1 : 0)
    },
    late: {
      mood: 'goodnight', ic: () => 'moon', pr: 2, base: 1.2, day: 1,
      flow: () => 'sleep',
      rel: (c) => (c.h >= 23 || c.h < 4 ? 1 : 0)
    },
    'xp.finished': {
      mood: 'proud', ic: () => 'check-circle', pr: 2, base: 1.6,
      rel: (c) => (!c.done && c.subs.length && !IS_ROOM ? 1 : 0),
      act: (c) => ({
        label: 'علّمي اليوم تم', ic: 'check-circle',
        fn: () => {
          const b = document.querySelector(`[data-done="${c.dow}"]`);
          if (b) b.click();
        }
      })
    },
    'day.done': {
      mood: 'cheer', ic: () => 'check-circle', pr: 2, base: 1.5, focus: 1, imm: 1,
      key: (c) => (c.weekDone <= 1 ? 'done.first' : c.weekDone >= 5 ? 'done.late' : 'done')
    },
    'day.undone': { mood: 'warm', ic: () => 'check', pr: 1, base: 1, imm: 1, key: () => 'undone' },
    'week.full': { mood: 'win', ic: () => 'trophy', pr: 3, base: 2, imm: 1, moment: 1 },
    streak: {
      mood: 'win', ic: () => 'flame', pr: 1, base: 0.9,
      rel: (c) => (c.streak >= 2 ? 1 : 0)
    },
    saved: { mood: 'proud', ic: () => 'pencil', pr: 1, base: 0.9, imm: 1 },
    'task.confirmed': {
      mood: 'proud', ic: () => 'check-circle', pr: 2, base: 1.3, focus: 1, imm: 1
    },
    'room.open': { mood: 'wave', ic: () => 'headphones', pr: 1, base: 1, cd: 30 * 60e3 },
    'room.start': {
      mood: 'encourage', ic: () => 'headphones', pr: 2, base: 1.5, focus: 1, imm: 1,
      key: (c, d) => (d.mins <= 10 ? 'room.start.short' : c.sess >= 1 ? 'room.start.again' : 'room.start')
    },
    'room.conflict': { mood: 'think', ic: () => 'warning', pr: 3, base: 2, focus: 1, imm: 1 },
    'room.pause': { mood: 'warm', ic: () => 'clock', pr: 2, base: 1, focus: 1, imm: 1 },
    'room.resume': { mood: 'cheerUp', ic: () => 'play', pr: 2, base: 1, focus: 1, imm: 1 },
    'room.half': { mood: 'encourage', ic: () => 'bolt', pr: 2, base: 1.2, focus: 1, imm: 1 },
    'room.break': { mood: 'warm', ic: () => 'idea', pr: 2, base: 1.1, focus: 1, imm: 1 },
    'room.finish': {
      mood: 'cheer', ic: () => 'celebrate', pr: 2, base: 1.6, focus: 1, imm: 1,
      acts: () => [
        canConfirmTask() && {
          label: 'سجّلي إنجاز الهدف', ic: 'check-circle',
          fn: () => { const b = $('confirmTask'); if (b && !b.disabled) b.click(); }
        },
        { label: 'استراحة ٥ دقايق', ic: 'clock', fn: () => startBreak(5) }
      ].filter(Boolean),
      key: (c, d) =>
        (c.sess >= 3 ? 'room.finish.3' :
         c.sess === 2 ? 'room.finish.2' :
         d.mins >= 45 ? 'room.finish.long' :
         d.mins <= 10 ? 'room.finish.short' :
         c.sess === 1 ? 'room.finish.1' : 'room.finish')
    },
    'room.reset': { mood: 'wave', ic: () => 'refresh', pr: 1, base: 0.8, imm: 1 },
    'prayer.soon': { mood: 'dua', ic: () => 'mosque', pr: 3, base: 2, focus: 1, imm: 1 },
    'prayer.now': {
      mood: 'dua', ic: () => 'mosque', pr: 3, base: 2.5, focus: 1, imm: 1,
      flow: (c) => (c.run ? 'prayerPause' : null)
    },
    'prayer.after': { mood: 'proud', ic: () => 'dua-hands', pr: 2, base: 1, imm: 1 }
  };

  /* ==========================================================================
     القسم 10: التدفقات (FLOWS)
     ========================================================================== */
  const FLOWS = {
    study: {
      steps: [
        {
          q: 'study.q1',
          choices: (c) => c.subs
            .map((s) => ({ id: 's:' + s, label: s, ic: 'open-book' }))
            .concat([{ id: 's:', label: 'أي مادة', ic: 'sparkles' }])
        },
        { q: 'study.q2', choices: dursChoices }
      ],
      done: (path) => {
        const sub = path[0].slice(2);
        const min = path[1].slice(2);
        Store.sset('subj', sub);
        setTimeout(() => {
          location.href = `room.html?m=${min}&s=${encodeURIComponent(sub)}`;
        }, 1100);
        return { say: 'study.go', mood: 'encourage', ic: 'rocket' };
      }
    },
    prayerPause: {
      steps: [{
        q: 'pp.q',
        choices: () => [
          { id: 'pause', label: 'وقّفي المؤقت وهصلي', ic: 'mosque' },
          { id: 'five',  label: '٥ دقايق كمان', ic: 'clock' }
        ]
      }],
      done: (path, flow) => {
        if (path[0] === 'pause') {
          if (roomRunning) {
            const b = document.getElementById('startTimer');
            if (b) b.click();
          }
          return { say: 'pp.pause', mood: 'dua', ic: 'dua-hands' };
        }
        setTimeout(() => { if (roomRunning) emit('prayer.now', flow.c.d); }, 300000);
        return { say: 'pp.five', mood: 'warm', ic: 'clock' };
      }
    },
    goalPick: {
      steps: [{
        q: 'room.nogoal',
        choices: () => {
          const subj = (($('subjectInput') || {}).value || Store.sget('subj', '')).trim();
          const pool = GOALS[subj] || GOALS[''];
          return pool
            .map((g) => ({ id: 'g:' + g, label: g, ic: 'target' }))
            .concat([{ id: 'g:', label: 'ابدئي من غير هدف', ic: 'play' }]);
        }
      }],
      done: (path) => {
        const goal = path[0].slice(2);
        const gEl = $('goalInput');
        const sEl = $('subjectInput');
        if (gEl && goal) gEl.value = goal;
        if (sEl && !sEl.value.trim() && Store.sget('subj', '')) sEl.value = Store.sget('subj', '');
        bypassGoalGuard = true;
        const b = $('startTimer');
        if (b) b.click();
        bypassGoalGuard = false;
        return null;
      }
    },
    tired: {
      steps: [{
        q: 'tired.q',
        choices: () => [
          { id: 'study', label: 'مجهدة من المذاكرة', ic: 'books' },
          { id: 'sleep', label: 'نعسانة', ic: 'moon' },
          { id: 'focus', label: 'مش قادرة أركّز', ic: 'target' }
        ]
      }],
      done: (path) => {
        mem.tired = dkey();
        save();
        if (path[0] === 'study') {
          return {
            say: 'tired.study', mood: 'warm', ic: 'sparkles',
            acts: [{ label: 'دقيقة تنفّس', ic: 'moon', fn: breathe }]
          };
        }
        if (path[0] === 'sleep') return { say: 'tired.sleep', mood: 'goodnight', ic: 'moon' };
        return {
          say: 'tired.focus', mood: 'encourage', ic: 'target',
          acts: [{ label: '٥ دقايق بس', ic: 'play', fn: () => quickStart(5) }]
        };
      }
    },
    sleep: {
      steps: [{
        q: 'sleep.q',
        choices: () => [
          { id: 'yes', label: 'أه هنام', ic: 'moon' },
          { id: 'no',  label: 'شوية كمان', ic: 'clock' }
        ]
      }],
      done: (path) => (path[0] === 'yes'
        ? { say: 'sleep.yes', mood: 'goodnight', ic: 'moon' }
        : { say: 'sleep.no', mood: 'warm', ic: 'clock' })
    }
  };

  const CORRECTIONS = [
    { a: 'day.done', b: 'streak', line: 'corr.done.streak', mood: 'win', ic: 'flame' }
  ];

  /* ==========================================================================
     القسم 11: المحرك
     ========================================================================== */
  const LATER_EVENTS = ['room.finish', 'prayer.now', 'prayer.soon'];

  let pendingCandidates = [];
  let pendingTimer = 0;
  let lastShownAt = 0;
  let currentCard = null;
  let currentEvent = null;
  let activeFlow = null;
  let deferredQueue = [];
  let deferredContext = null;
  let bypassGoalGuard = false;
  let breakTimer = 0;
  let awayTimestamp = 0;

  // cache للـ context خلال batch واحد
  let contextCache = null;
  let contextCacheTime = 0;

  function getContext() {
    const t = nowMs();
    if (contextCache && t - contextCacheTime < 500) return contextCache;
    contextCache = buildContext();
    contextCacheTime = t;
    return contextCache;
  }

  function shownLastHour() {
    return (mem.sh || []).filter((t) => nowMs() - t < CFG.HOUR).length;
  }

  function hourlyBudget() {
    let b = mem.quiet ? 1 : CFG.MAX_SHOWN_PER_HOUR;
    const recent = (mem.out || []).slice(-3);
    if (recent.length === 3 && recent.every((x) => x !== 'e')) {
      b = Math.max(1, b - 2);
    }
    return b;
  }

  function checkGates(candidate) {
    const r = candidate.rule;
    const x = candidate.ctx;
    const t = nowMs();

    if (!NAME) return 'no-name';
    if (document.hidden) return 'hidden';
    if (candidate.pr >= 3) return null;
    if (candidate.pr < 2 && mem.mute > t) return 'muted';
    if (x.run && !r.focus) return 'focus-mode';
    if (document.querySelector('dialog[open], .cp-ov')) return 'dialog-open';
    if (r.cd && t - ((mem.last || {})[candidate.event] || 0) < r.cd) return 'cooldown';
    if (r.day && ((mem.cnt || {})[dkey() + candidate.event] || 0) >= r.day) return 'day-cap';
    if (candidate.pr < 2) {
      if (x.np && x.np.m <= 2) return 'prayer-near';
      if (shownLastHour() >= hourlyBudget()) return 'budget';
      if (t - lastShownAt < CFG.MIN_GAP_MS) return 'gap';
    }
    return null;
  }

  function scoreCandidate(candidate) {
    const ev = (mem.ev || {})[candidate.event];
    const last = (mem.last || {})[candidate.event] || 0;

    const fatigue = nowMs() - last < CFG.SAME_EVENT_FATIGUE ? CFG.FATIGUE_FACTOR : 1;

    let responsiveness = 1;
    if (ev && ev.n >= 3) {
      const engagementRate = (ev.e + 1) / (ev.n + 2);
      const dismissalRate = ev.x / ev.n;
      responsiveness = (0.6 + 0.8 * engagementRate) * (1 - 0.3 * dismissalRate);
    }

    return candidate.rule.base * candidate.rel * fatigue * responsiveness;
  }

  function emit(event, data = {}) {
    const rule = RULES[event];
    if (!rule) return false;

    const ctx = getContext();
    const rel = rule.rel ? rule.rel(ctx, data) : 1;
    if (!rel) return false;

    const vars = Object.assign({
      s: list(ctx.subs),
      n: ar(ctx.weekDone),
      k: ar(ctx.streak),
      me: NAME,
      sub: ctx.sg ? ctx.sg.s : '',
      t: ctx.sg ? fmt(Math.round(ctx.sg.m)) : '',
      m: ar(bestMinutes()),
      tm: fmt(todayMinutes()),
      ss: ar(ctx.sess)
    }, data);

    const cand = {
      event, rule,
      pr: rule.pr,
      ctx, data, vars,
      rel, mood: rule.mood,
      ic: rule.ic(ctx),
      force: rule.pr >= 3,
      key: rule.key ? rule.key(ctx, data) : event
    };

    if (rule.imm || rule.pr >= 3) return arbitrate([cand]);

    pendingCandidates.push(cand);
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        const batch = pendingCandidates;
        pendingCandidates = [];
        pendingTimer = 0;
        // بعد batch، نمسح الكاش عشان نضمن بيانات حديثة في الدفعة التالية
        contextCache = null;
        arbitrate(batch);
      }, 350);
    }
    return true;
  }

  function arbitrate(candidates) {
    const viable = [];

    for (const c of candidates) {
      const canForce = c.force || (c.rule.imm && currentCard && currentCard.pr <= 2.5);
      if (currentCard && currentCard.pr >= c.pr && !canForce) {
        if (c.pr >= 2 && deferredQueue.length < 3 &&
            !deferredQueue.some((i) => i.c.event === c.event) &&
            !checkGates(c)) {
          deferredQueue.push({ c, t: nowMs() });
        }
        continue;
      }

      const gate = checkGates(c);
      if (gate) {
        if (gate === 'hidden' && c.pr >= 2 && LATER_EVENTS.includes(c.event)) {
          deferredContext = { c, t: nowMs() };
        }
        continue;
      }

      c.score = scoreCandidate(c);
      if (c.pr < 2 && c.score < CFG.SCORE_MIN) continue;

      viable.push(c);
    }

    if (!viable.length) return false;

    viable.sort((a, b) => (b.score * (0.9 + Math.random() * 0.2)) - (a.score * (0.9 + Math.random() * 0.2)));
    let winner = viable[0];

    const correction = CORRECTIONS.find(
      (c) => c.a === winner.event && viable.some((v) => v.event === c.b)
    );
    if (correction) {
      winner = Object.assign({}, winner, {
        key: correction.line,
        mood: correction.mood,
        ic: correction.ic
      });
    }

    return showCard(winner);
  }

  function commitShown(c) {
    const t = nowMs();
    lastShownAt = t;
    (mem.last || (mem.last = {}))[c.event] = t;
    (mem.cnt || (mem.cnt = {}))[dkey() + c.event] =
      ((mem.cnt || {})[dkey() + c.event] || 0) + 1;
    if (c.pr < 3) {
      mem.sh = (mem.sh || []).filter((x) => t - x < CFG.HOUR).concat(t);
    }
    save();
  }

  function recordResponse(outcome) {
    if (!currentEvent || currentEvent.done) return;
    currentEvent.done = 1;

    const ev = (mem.ev || (mem.ev = {}));
    const s = ev[currentEvent.event] || (ev[currentEvent.event] = { n: 0, e: 0, x: 0 });
    s.n++;
    if (outcome === 'e') s.e++;
    if (outcome === 'x') s.x++;

    if (outcome === 'x') {
      mem.xs = (mem.xs || 0) + 1;
      if (mem.xs >= 2) {
        mem.mute = nowMs() + CFG.MUTE_DURATION;
        mem.xs = 0;
      }
    } else if (outcome === 'e') {
      mem.xs = 0;
    }

    mem.out = (mem.out || []).concat(outcome).slice(-6);
    save();
  }

  function showCard(c) {
    if (c.rule.flow) {
      const flowId = c.rule.flow(c.ctx);
      if (flowId) {
        startFlow(flowId, c);
        return true;
      }
    }

    const text = pickLine(c.key, c.vars, c.ctx.tone);
    if (!text) return false;

    cancelFlow();
    commitShown(c);

    if (c.rule.moment) {
      showMoment({ title: 'أسبوع كامل!', text, mood: c.mood });
      return true;
    }

    const actions = c.rule.acts
      ? c.rule.acts(c.ctx, c.data)
      : c.rule.act ? [c.rule.act(c.ctx, c.data)] : [];

    renderCard({
      text, mood: c.mood, ic: c.ic, pr: c.pr,
      event: c.event,
      actions: actions.filter(Boolean)
    });
    return true;
  }

  /* ==========================================================================
     القسم 12: التدفقات
     ========================================================================== */
  function startFlow(id, c) {
    cancelFlow();
    activeFlow = { id, F: FLOWS[id], i: 0, path: [], c };
    commitShown(c);
    stepFlow();
  }

  function stepFlow() {
    const step = activeFlow.F.steps[activeFlow.i];
    const ctx = getContext();

    renderCard({
      text: pickLine(step.q, activeFlow.c.vars || {}, ctx.tone),
      mood: activeFlow.c.mood,
      ic: activeFlow.c.ic,
      pr: 2.9,
      event: activeFlow.c.event,
      choices: step.choices(ctx),
      onChoice: handleFlowChoice,
      keep: 50000
    });
  }

  function handleFlowChoice(id) {
    if (!activeFlow) return;
    recordResponse('e');
    activeFlow.path.push(id);
    const f = activeFlow;

    if (f.i < f.F.steps.length - 1) {
      f.i++;
      stepFlow();
      return;
    }

    activeFlow = null;
    const result = f.F.done(f.path, f);
    hideCard();

    if (result) {
      setTimeout(() => {
        currentEvent = null;
        renderCard({
          text: pickLine(result.say, {}, 'normal'),
          mood: result.mood,
          ic: result.ic,
          pr: 2,
          event: 'flow.' + f.id,
          actions: result.acts
        });
      }, 400);
    }
  }

  function cancelFlow() {
    activeFlow = null;
  }

  /* ==========================================================================
     القسم 13: واجهة الأميرة
     ========================================================================== */
  let rootEl = null;
  let cardEl = null;
  let headerEl = null;
  let textEl = null;
  let optionsEl = null;
  let avatarBtn = null;
  let hideTimer = 0;
  let currentAvatarMood = '';
  let sleeping = false;
  let lastActivity = nowMs();
  let presenceMode = 'full';

  function setMood(mood, force = false) {
    if (!avatarBtn || (currentAvatarMood === mood && !force)) return;
    currentAvatarMood = mood;
    avatarBtn.innerHTML = '';
    const el = P.el(mood, DRESS);
    el.classList.add('pop');
    avatarBtn.appendChild(el);
    setTimeout(() => el.classList.remove('pop'), 450);
  }

  const restoreMood = () =>
    setMood(sleeping ? 'sleepy' : roomRunning ? 'study' : CFG.REST_MOOD);

  function buildUI() {
    rootEl = document.createElement('div');
    rootEl.className = 'cp';
    rootEl.innerHTML = `
      <div class="cp-card" role="status" aria-live="polite">
        <button class="cp-x" aria-label="إغلاق">${ic('close')}</button>
        <div class="cp-hd"></div>
        <div class="cp-tx"></div>
        <div class="cp-opts"></div>
        <a class="cp-ed">${ic('settings')}<span>اسمي ولوني</span></a>
      </div>
      <button class="cp-av" aria-label="الأميرة"></button>
    `;
    document.body.appendChild(rootEl);

    cardEl = rootEl.firstElementChild;
    headerEl = rootEl.querySelector('.cp-hd');
    textEl = rootEl.querySelector('.cp-tx');
    optionsEl = rootEl.querySelector('.cp-opts');
    avatarBtn = rootEl.querySelector('.cp-av');

    rootEl.querySelector('.cp-x').onclick = () => hideCard('x');
    rootEl.querySelector('.cp-ed').onclick = () => openPicker(false);
    avatarBtn.onclick = handleTap;

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cardEl.classList.contains('on')) {
        hideCard('x');
      }
    });

    setMood(CFG.REST_MOOD, true);
  }

  function renderCard(opts) {
    if (currentEvent && !currentEvent.done) recordResponse('t');
    currentEvent = { event: opts.event, done: 0 };
    currentCard = { pr: opts.pr };

    sleeping = false;
    setMood(opts.mood);
    cardEl.dataset.tone = P.toneOf(opts.mood);

    headerEl.innerHTML = ic(opts.ic) + '<span></span>';
    headerEl.lastElementChild.textContent = NAME;
    textEl.textContent = opts.text;
    optionsEl.innerHTML = '';

    const addButton = (label, icon, onClick, isMain) => {
      const b = document.createElement('button');
      b.className = 'cp-btn' + (isMain ? ' main' : '');
      b.innerHTML = ic(icon) + '<span></span>';
      b.lastElementChild.textContent = label;
      b.onclick = onClick;
      optionsEl.appendChild(b);
      return b;
    };

    (opts.choices || []).forEach((ch) => {
      addButton(ch.label, ch.ic, () => opts.onChoice(ch.id));
    });

    (opts.actions || []).forEach((a, i) => {
      addButton(a.label, a.ic, () => {
        recordResponse('e');
        hideCard();
        if (a.flow) startFlow(a.flow, {
          event: opts.event, mood: opts.mood, ic: opts.ic, pr: 2, data: {}, vars: {}
        });
        else if (a.fn) a.fn();
      }, i === 0);
    });

    cardEl.classList.remove('on');
    void cardEl.offsetWidth;
    cardEl.classList.add('on');

    clearTimeout(hideTimer);
    const baseDuration = Math.min(18000, Math.max(7000, opts.text.length * 85));
    hideTimer = setTimeout(
      () => hideCard('t'),
      (opts.keep || baseDuration) * (opts.pr >= 3 ? 1.5 : 1)
    );

    if (opts.mood === 'cheer' || opts.mood === 'win') {
      confetti(opts.pr >= 3 ? 36 : 18);
    }
  }

  function hideCard(reason) {
    if (reason) recordResponse(reason);
    cardEl.classList.remove('on');
    currentCard = null;
    clearTimeout(hideTimer);

    if (reason && activeFlow) cancelFlow();

    setTimeout(() => { if (!currentCard) restoreMood(); }, 700);

    setTimeout(() => {
      if (currentCard || activeFlow) return;
      deferredQueue = deferredQueue.filter((i) => nowMs() - i.t < CFG.QUEUE_TTL);
      const next = deferredQueue.shift();
      if (next) {
        next.c.force = 1;
        arbitrate([next.c]);
      }
    }, 900);
  }

  function statusText() {
    const ctx = getContext();
    const bits = [];

    bits.push(
      !ctx.subs.length ? 'النهاردة يوم مفتوح'
        : ctx.done ? 'خلّصتي يومك'
        : `لسه عندك ${list(ctx.subs)}`
    );

    const tm = todayMinutes();
    if (tm >= 1) bits.push(`ركّزتي ${fmt(tm)} النهاردة`);

    const greeting = rnd(['أنا هنا يا ملك', 'معاكي يا ملك', 'جاهزة يا ملك', 'قوليلي يا ملك']);
    return greeting + '. ' + bits.join('، ') + '.';
  }

  function menuChoices(ctx) {
    const a = [];
    if (!IS_ROOM && !ctx.run) a.push({ id: 'study', label: 'ابدئي جلسة', ic: 'play' });
    a.push(
      { id: 'tip', label: 'نصيحة', ic: 'idea' },
      { id: 'breathe', label: 'تنفّس معايا', ic: 'moon' },
      { id: 'tired', label: 'تعبانة', ic: 'clock' }
    );
    return a;
  }

  function handleMenuChoice(id) {
    recordResponse('e');
    hideCard();
    const ctx = getContext();
    const base = { event: 'tap', mood: 'encourage', ic: 'books', pr: 2, data: {}, vars: {} };

    if (id === 'study') {
      setTimeout(() => startFlow('study', base), 250);
    } else if (id === 'tired') {
      setTimeout(() => startFlow('tired', Object.assign(base, { mood: 'warm', ic: 'sparkles' })), 250);
    } else if (id === 'breathe') {
      setTimeout(breathe, 250);
    } else if (id === 'tip') {
      setTimeout(() => {
        const sub = ctx.subj || (ctx.subs.length ? rnd(ctx.subs) : '');
        const tip = sub && TIP[sub] ? rnd(TIP[sub]) : pickLine('tip.generic', {}, 'normal');
        currentEvent = null;
        renderCard({
          text: (sub && TIP[sub] ? `نصيحة ${sub}: ` : 'نصيحة: ') + tip,
          mood: 'think', ic: 'idea', pr: 2, event: 'tip'
        });
      }, 250);
    }
  }

  function handleTap() {
    lastActivity = nowMs();
    setPresence('full');

    if (currentCard) {
      hideCard('x');
      return;
    }

    const ctx = getContext();
    setMood('giggle');

    setTimeout(() => {
      renderCard({
        text: statusText(),
        mood: ctx.done ? 'cheer' : 'cheerUp',
        ic: 'sparkles',
        pr: 2.5,
        event: 'tap',
        choices: menuChoices(ctx),
        onChoice: handleMenuChoice,
        keep: 16000
      });
    }, 350);
  }

  /* ==========================================================================
     القسم 14: الحضور
     ========================================================================== */
  function setPresence(mode) {
    if (!rootEl || presenceMode === mode) return;
    presenceMode = mode;
    rootEl.dataset.p = mode;
  }

  function updatePresence() {
    if (!rootEl) return;
    if (currentCard || activeFlow || document.querySelector('.cp-ov')) {
      return setPresence('full');
    }
    if (roomRunning) return setPresence('focus');
    setPresence(nowMs() - lastActivity > 20000 ? 'dock' : 'full');
  }

  /* ==========================================================================
     القسم 15: أدوات مساعدة
     ========================================================================== */
  function gotoRoom(subject, minutes) {
    Store.sset('subj', subject || '');
    location.href = `room.html?m=${minutes}&s=${encodeURIComponent(subject || '')}`;
  }

  function quickStart(minutes) {
    if (IS_ROOM) setDuration(minutes);
    else gotoRoom('', minutes);
  }

  function setDuration(minutes) {
    const sel = $('durationSelect');
    if (sel && !sel.disabled) {
      sel.value = String(minutes);
      sel.dispatchEvent(new Event('change'));
    }
  }

  function isRoomIdle() {
    const b = $('startTimer');
    return !!b && /ابدئي/.test(b.textContent);
  }

  function canConfirmTask() {
    const b = $('confirmTask');
    return !!b && !b.disabled;
  }

  /* ==========================================================================
     القسم 16: استراحة
     ========================================================================== */
  function startBreak(minutes) {
    clearTimeout(breakTimer);
    mem.brk = nowMs() + minutes * CFG.MIN_MS;
    save();
    breakTimer = setTimeout(() => {
      mem.brk = 0;
      save();
      emit('break.over');
    }, minutes * CFG.MIN_MS);

    setTimeout(() => {
      currentEvent = null;
      renderCard({
        text: pickLine('break.on', { b: ar(minutes) }, 'normal'),
        mood: 'calm', ic: 'clock', pr: 2, event: 'break.on'
      });
    }, 400);
  }

  /* ==========================================================================
     القسم 17: تمرين التنفس
     ========================================================================== */
  function breathe() {
    const ov = createSheet(`
      <div class="big"></div>
      <h3>خدي نفس معايا</h3>
      <p>٣ دورات هادية: شهيق من الأنف، وزفير طويل.</p>
      <div class="cp-breath" data-s="out"><i></i><b>جاهزة</b></div>
      <button class="cp-btn main">تمام</button>
    `);
    ov.querySelector('.big').appendChild(P.el('breathe', DRESS));

    const ring = ov.querySelector('.cp-breath');
    const label = ring.querySelector('b');
    let n = 0, stopped = false;
    const timers = [];

    const set = (st, txt) => { if (stopped) return; ring.dataset.s = st; label.textContent = txt; };
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));

    const cycle = () => {
      if (stopped) return;
      if (n >= 3) { finish(true); return; }
      n++;
      set('in', 'شهيق');
      later(() => {
        set('hold', 'ثبّتي');
        later(() => {
          set('out', 'زفير');
          later(cycle, 6000);
        }, 1500);
      }, 4000);
    };

    function finish(ok) {
      stopped = true;
      timers.forEach(clearTimeout);
      ov.remove();
      if (ok) setTimeout(() => {
        currentEvent = null;
        renderCard({
          text: pickLine('breath.done', {}, 'normal'),
          mood: 'proud', ic: 'sparkles', pr: 2, event: 'breath'
        });
      }, 300);
    }

    ov.querySelector('button').onclick = () => finish(false);
    later(cycle, 900);
  }

  /* ==========================================================================
     القسم 18: القصاصات
     ========================================================================== */
  function confetti(count) {
    try {
      if (!count || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const layer = document.createElement('div');
      layer.className = 'cf-layer';
      layer.setAttribute('aria-hidden', 'true');
      const colors = ['#ff7ca8', '#e8b94f', '#6fcf9f', '#6498ef', '#a58ae8'];

      for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'cf-piece';
        p.style.left = (5 + Math.random() * 90) + '%';
        p.style.background = colors[i % 5];
        p.style.setProperty('--x', (Math.random() * 160 - 80).toFixed(0) + 'px');
        p.style.setProperty('--r', (360 + Math.random() * 540).toFixed(0) + 'deg');
        p.style.setProperty('--d', (1.8 + Math.random() * 1.2).toFixed(2) + 's');
        p.style.setProperty('--delay', (Math.random() * 0.5).toFixed(2) + 's');
        layer.appendChild(p);
      }

      document.body.appendChild(layer);
      setTimeout(() => layer.remove(), 3800);
    } catch (_) {}
  }

  /* ==========================================================================
     القسم 19: النوافذ
     ========================================================================== */
  function createSheet(html) {
    const ov = document.createElement('div');
    ov.className = 'cp-ov';
    ov.innerHTML = `<div class="cp-sheet">${html}</div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';
    const observer = new MutationObserver(() => {
      if (!document.body.contains(ov)) {
        document.body.style.overflow = '';
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
    return ov;
  }

  function showMoment(opts) {
    const ov = createSheet(`
      <div class="big"></div>
      <h3></h3>
      <p></p>
      <button class="cp-btn main">يا سلام</button>
    `);
    ov.querySelector('.big').appendChild(P.el(opts.mood, DRESS));
    ov.querySelector('h3').textContent = opts.title;
    ov.querySelector('p').textContent = opts.text;
    ov.querySelector('button').onclick = () => ov.remove();
    confetti(60);
  }

  /* ==========================================================================
     القسم 20: نافذة الاسم واللون
     ========================================================================== */
  const NAME_SUGGESTIONS = ['نَدى', 'سَكينة', 'زهرة', 'بسمة', 'لمسة', 'غيمة'];

  function openPicker(isFirst) {
    let selectedDress = DRESS;
    const opener = document.activeElement;

    const ov = createSheet(`
      <div class="big"></div>
      <h3 id="cpPickTitle">${isFirst ? 'أهلا يا ملك!' : 'غيّري اللي يعجبك'}</h3>
      <p id="cpPickDesc">${isFirst ? 'أنا أميرتك الصغيرة في المذاكرة. اختاري ليا اسم ولون فستان:' : 'اختاري اسم ولون جديد:'}</p>
      <input type="text" maxlength="14" placeholder="اكتبي اسم يعجبك" aria-label="اسم الأميرة" autocomplete="off">
      <div class="cp-row nm"></div>
      <div class="cp-row dr" role="group" aria-label="لون الفستان"></div>
      <label class="cp-sw">
        <input type="checkbox" id="cpQ">
        قلّلي الرسائل (هادية أكتر)
      </label>
      <button class="cp-btn main" type="button">تمام</button>
      <button class="cp-btn cp-skip" type="button">مش دلوقتي</button>
    `);
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'cpPickTitle');
    ov.setAttribute('aria-describedby', 'cpPickDesc');

    const big = ov.querySelector('.big');
    const input = ov.querySelector('input[type="text"]');

    const redraw = () => {
      big.innerHTML = '';
      big.appendChild(P.el('wave', selectedDress));
    };

    input.value = mem.name || '';
    ov.querySelector('#cpQ').checked = !!mem.quiet;
    redraw();

    NAME_SUGGESTIONS.forEach((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-chip';
      b.textContent = n;
      b.onclick = () => { input.value = n; input.focus(); };
      ov.querySelector('.nm').appendChild(b);
    });

    P.DRESS.forEach((d, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-dot' + (i === selectedDress ? ' sel' : '');
      b.title = d.n;
      b.setAttribute('aria-label', d.n);
      b.setAttribute('aria-pressed', String(i === selectedDress));
      b.style.background = `linear-gradient(135deg,${d.a},${d.b})`;
      b.onclick = () => {
        selectedDress = i;
        [...ov.querySelectorAll('.cp-dot')].forEach((x, j) => {
          x.classList.toggle('sel', j === i);
          x.setAttribute('aria-pressed', String(j === i));
        });
        redraw();
      };
      ov.querySelector('.dr').appendChild(b);
    });

    // إغلاق النافذة: Esc / مش دلوقتي / الضغط على الخلفية
    let closed = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); return; }
      if (e.key !== 'Tab') return;
      // حبس التركيز داخل النافذة
      const f = [...ov.querySelectorAll('button, input')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!ov.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    const closeSheet = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      const back = isFirst ? avatarBtn : opener;
      if (back && back.focus && document.contains(back)) back.focus();
    };
    const skip = () => {
      if (closed) return;
      if (isFirst && !NAME) {
        // اسم افتراضي في الذاكرة فقط (مش بنحفظه) عشان رسائل الأميرة تشتغل؛ ونسأل تاني بكرة
        NAME = DEFAULT_NAME;
        mem.skip = dkey();
        save();
        closeSheet();
        setMood(CFG.REST_MOOD, true);
        emit('open');
        return;
      }
      closeSheet();
    };

    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) skip(); });
    ov.querySelector('.cp-skip').onclick = skip;

    ov.querySelector('.cp-btn.main').onclick = () => {
      const v = input.value.trim().slice(0, 14);
      if (!v) { input.focus(); return; }

      NAME = v;
      DRESS = selectedDress;
      mem.name = v;
      mem.dress = selectedDress;
      mem.quiet = ov.querySelector('#cpQ').checked;
      delete mem.skip;
      save();

      closeSheet();
      setMood(CFG.REST_MOOD, true);

      if (isFirst) {
        emit('named');
        emit('open');
      }
    };

    setTimeout(() => { if (!closed) input.focus(); }, 120);
  }

  /* ==========================================================================
     القسم 21: حياة الأميرة
     ========================================================================== */
  function setupAmbient() {
    const de = document.documentElement;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const markActive = () => {
      lastActivity = nowMs();
      if (sleeping) { sleeping = false; restoreMood(); }
      if (presenceMode === 'dock') setPresence('full');
    };

    const lookAt = (px, py) => {
      if (!avatarBtn || reducedMotion) return;
      const r = avatarBtn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * 0.4;
      const g = (v, z) => clamp(v / z, -1, 1).toFixed(2);
      de.style.setProperty('--gx', g(px - cx, Math.max(innerWidth / 2, 200)));
      de.style.setProperty('--gy', g(py - cy, Math.max(innerHeight / 2, 200)));
    };

    let lookResetTimer = 0;
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!t || !t.getBoundingClientRect || !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const r = t.getBoundingClientRect();
      lookAt(r.left + r.width / 2, r.top + r.height / 2);
      clearTimeout(lookResetTimer);
      lookResetTimer = setTimeout(() => {
        de.style.setProperty('--gx', '0');
        de.style.setProperty('--gy', '0');
      }, 3500);
    });

    document.addEventListener('pointermove', (e) => {
      markActive();
      lookAt(e.clientX, e.clientY);
    }, { passive: true });

    ['keydown', 'touchstart', 'click'].forEach((t) =>
      document.addEventListener(t, markActive, { passive: true })
    );

    if (!reducedMotion) {
      (function blink() {
        setTimeout(() => {
          if (document.hidden) { blink(); return; }
          document.querySelectorAll('.princess').forEach((s) => s.classList.add('blink'));
          setTimeout(() => document.querySelectorAll('.princess').forEach((s) => s.classList.remove('blink')), 130);
          blink();
        }, 2500 + Math.random() * 3500);
      })();

      (function glance() {
        setTimeout(() => {
          if (nowMs() - lastActivity > 4000) {
            de.style.setProperty('--gx', (Math.random() < 0.5 ? -1 : 1) * 0.9);
            de.style.setProperty('--gy', '-0.3');
            setTimeout(() => {
              de.style.setProperty('--gx', '0');
              de.style.setProperty('--gy', '0');
            }, 1300);
          }
          glance();
        }, 7000 + Math.random() * 6000);
      })();
    }
  }

  /* ==========================================================================
     القسم 22: أحداث الصفحات
     ========================================================================== */
  let last5Timer = 0, pausedTimer = 0;

  function clearRoomTimers() {
    clearTimeout(last5Timer);
    clearTimeout(pausedTimer);
  }

  function armRoomTimers(remainingSec, isFresh) {
    clearRoomTimers();
    roomRunning = true;
    roomPaused = false;
    roomFinished = false;
    roomTotal = remainingSec;

    if (isFresh && remainingSec >= 1500) {
      last5Timer = setTimeout(() => roomRunning && emit('room.break'), 1500e3);
    }
    if (remainingSec >= 900) {
      last5Timer = setTimeout(() => roomRunning && emit('room.last5'), (remainingSec - 300) * 1000);
    }

    updatePresence();
  }

  function onPage(type, data = {}) {
    const ctx = getContext();

    switch (type) {
      case 'done': {
        // ملاحظة: هذا الحدث قد يأتي من app.js (إنجاز اليوم)
        // أو من room.js (تأكيد هدف الجلسة) — نميز بـ source
        const source = data.source || 'daily-goal';

        if (source === 'daily-goal') {
          // data.date (YYYY-MM-DD) = يوم سابق من الأسبوع؛ بدونه = اليوم
          const isPastDay = !!data.date && data.date !== isoDay();
          const dayKey = data.date ? dkey(new Date(data.date + 'T12:00:00')) : dkey();
          const dd = (mem.dd || (mem.dd = {}));
          if (data.on) dd[dayKey] = 1;
          else delete dd[dayKey];
          save();

          const after = buildContext();
          contextCache = after;
          contextCacheTime = nowMs();

          if (!data.on) { if (!isPastDay) emit('day.undone'); }
          else if (after.weekDone >= 7) emit('week.full');
          else if (!isPastDay) {
            emit('day.done');
            if (after.streak >= 2) emit('streak');
          }
        } else if (source === 'focus-session') {
          // تأكيد هدف جلسة — لا يعد إنجاز يوم كامل
          if (data.on) emit('task.confirmed');
        }
        break;
      }

      case 'saved':
        emit('saved');
        break;

      case 'roomStart': {
        const m = Math.round(data.minutes);
        roomPaused = false;
        roomFinished = false;
        const sub = data.subject || ctx.subj || (ctx.subs.length ? rnd(ctx.subs) : '');
        if (data.subject) Store.sset('subj', data.subject);

        emit('room.start', { m: ar(m), mins: m, sub });
        cancelFlow();
        armRoomTimers(data.remaining || m * 60, true);
        break;
      }

      case 'roomResume':
        emit('room.resume');
        cancelFlow();
        armRoomTimers(data.remaining || 600, false);
        break;

      case 'roomPause': {
        roomRunning = false;
        roomPaused = true;
        roomFinished = false;
        clearRoomTimers();

        const pz = mem.pz && mem.pz.d === dkey() ? mem.pz : (mem.pz = { d: dkey(), n: 0 });
        pz.n++;
        if (pz.n >= 3) mem.tired = dkey();
        save();

        pausedTimer = setTimeout(() => roomPaused && emit('room.pausedlong'), 6 * 60e3);
        emit('room.pause');
        updatePresence();
        break;
      }

      case 'roomFinish': {
        roomRunning = false;
        roomPaused = false;
        roomFinished = true;
        clearRoomTimers();

        const s = mem.sess || (mem.sess = {});
        s[dkey()] = (s[dkey()] || 0) + 1;
        save();
        Store.sset('fin', nowMs());

        emit('room.finish', { m: ar(data.minutes), mins: data.minutes });
        updatePresence();
        break;
      }

      case 'roomReset':
        if ((roomRunning || roomPaused) && data.progress < 0.6) {
          const ab = (mem.ab || (mem.ab = {}));
          ab[dkey()] = (ab[dkey()] || 0) + 1;
          save();
        }
        roomRunning = false;
        roomPaused = false;
        roomFinished = false;
        clearRoomTimers();
        emit('room.reset');
        updatePresence();
        break;
    }
  }

  /* ==========================================================================
     القسم 23: نبضة الوقت
     ========================================================================== */
  let tickInFlight = false;

  function tick() {
    if (!NAME || tickInFlight) return;
    tickInFlight = true;

    try {
      mem.lv = nowMs();
      const k = dkey();

      mem.fired = (mem.fired && mem.fired.d === k) ? mem.fired : { d: k, a: [] };

      // تنظيف دوري (كل ~10 دقائق)
      if (!mem.lastPrune || nowMs() - mem.lastPrune > 10 * 60e3) {
        pruneAll();
        mem.lastPrune = nowMs();
        save();
      }

      // مزامنة حالة الجلسة (في حالة تغيرت من room.js)
      syncRoomState();

      const ctx = getContext();
      if (ctx.h >= 23 || ctx.h < 4) emit('late');

      if (!sleeping && !roomRunning && !currentCard && nowMs() - lastActivity > 5 * 60e3) {
        sleeping = true;
        setMood('sleepy');
      }
    } finally {
      tickInFlight = false;
    }
  }

  /* ==========================================================================
     القسم 24: التشغيل
     ========================================================================== */
  window.companion = { emit: onPage };

  // مستمع storage لمزامنة حالة الجلسة من room.js
  window.addEventListener('storage', (e) => {
    if (e.key === CFG.SESSION) {
      syncRoomState();
      updatePresence();
    }
  });

  function boot() {
    // مزامنة أولية
    syncRoomState();

    buildUI();
    setupAmbient();
    pruneAll();

    const isFresh = !Store.sget('s', 0);
    const prevLv = mem.lv || 0;

    if (isFresh) {
      mem.gone = prevLv ? (nowMs() - prevLv) / CFG.DAY_MS : 0;
      mem.visits = (mem.visits || 0) + 1;
      Store.sset('s', 1);
    }

    const firstToday = mem.od !== dkey();
    mem.od = dkey();
    mem.lv = nowMs();

    const plan = Store.getPlan();
    if (plan && plan.doneByDate && plan.doneByDate[dkey()]) {
      (mem.dd || (mem.dd = {}))[dkey()] = 1;
    }
    save();

    try {
      const subj = new URLSearchParams(location.search).get('s');
      if (subj) Store.sset('subj', subj);
    } catch (_) {}

    // استرجاع حالة الجلسة من localStorage (room.js)
    if (IS_ROOM) {
      const ss = Store.getSession();
      if (ss && ss.status === 'running') {
        const rem = Math.ceil((ss.deadline - nowMs()) / 1000);
        if (rem > 0) armRoomTimers(rem, false);
        else roomFinished = true;
      } else if (ss && ss.status === 'paused') {
        roomPaused = true;
      } else if (ss && ss.status === 'finished') {
        roomFinished = true;
      }
    }

    if (mem.brk && mem.brk > nowMs()) {
      breakTimer = setTimeout(() => {
        mem.brk = 0;
        save();
        emit('break.over');
      }, mem.brk - nowMs());
    }

    // تخطّت نافذة التعريف النهاردة: نكمل بالاسم الافتراضي من غير ما نكتب اسم محفوظ
    if (!NAME && mem.skip === dkey()) NAME = DEFAULT_NAME;

    if (!NAME) {
      openPicker(true);
    } else {
      const ctx = getContext();
      const away = isFresh && prevLv && nowMs() - prevLv > 3 * CFG.HOUR;

      if (firstToday || away || (isFresh && !prevLv)) {
        emit(IS_ROOM && ctx.gone < 3 ? 'room.open' : 'open');
      } else if (IS_ROOM && mem.ro !== dkey() && isRoomIdle()) {
        mem.ro = dkey();
        save();
        emit('room.open');
      } else {
        setMood('wave');
        setTimeout(restoreMood, 2600);
      }

      if (!IS_ROOM) {
        const fin = Store.sget('fin', 0);
        const recentFinish = fin && nowMs() - fin < 20 * 60e3;
        if (fin) Store.sset('fin', 0);

        setTimeout(() => {
          if (recentFinish) emit('xp.finished');
          ['plan.today', 'plan.suggest', 'friday', 'plan.nudge', 'day.enough', 'week.slow']
            .forEach((e) => emit(e));
        }, recentFinish ? 2500 : 12000);
      } else {
        setTimeout(() => emit('room.idle'), 90000);

        // حارس الهدف قبل أول جلسة
        const startBtn = $('startTimer');
        if (startBtn) {
          startBtn.addEventListener('click', (e) => {
            if (bypassGoalGuard || roomRunning || roomPaused || roomFinished || !isRoomIdle() || !NAME) return;
            const gEl = $('goalInput');
            if (!gEl || gEl.value.trim() || (mem.ng || {}).d === dkey()) return;
            mem.ng = { d: dkey() };
            save();
            e.stopImmediatePropagation();
            e.preventDefault();
            startFlow('goalPick', {
              event: 'room.nogoal', mood: 'encourage', ic: 'target', pr: 2, data: {}, vars: {}
            });
          }, true);
        }
      }
    }

    tick();
    setInterval(tick, 30000);

    // تقليل تحديث الحضور: 3 ثواني بدل 1.5
    setInterval(updatePresence, 3000);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (roomRunning) awayTimestamp = nowMs();
        return;
      }

      const away = awayTimestamp;
      awayTimestamp = 0;

      if (away && roomRunning && nowMs() - away > 45000) {
        const dd = (mem.dist || (mem.dist = {}));
        dd[dkey()] = (dd[dkey()] || 0) + 1;
        save();
        const mins = Math.round((nowMs() - away) / CFG.MIN_MS);
        emit('focus.away', {
          a: mins >= 1 ? fmt(mins) : 'شوية',
          many: dd[dkey()] >= 3
        });
      }

      if (deferredContext && nowMs() - deferredContext.t < CFG.LATER_TTL) {
        const c = deferredContext.c;
        deferredContext = null;
        setTimeout(() => arbitrate([c]), 400);
      }

      tick();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
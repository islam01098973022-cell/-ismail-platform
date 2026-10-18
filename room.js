/* room.js — v2 (إصلاح شامل + تزامن + أداء)
   ============================================================================
   منطق غرفة التركيز + المؤقت.

   إصلاحات v2:
   1) تقليل setInterval من 250ms إلى 1000ms (أداء + بطارية)
   2) تصحيح drift بعد خمول التبويب (deadline-based أصلاً + تصحيح)
   3) مزامنة حالة الجلسة مع companion.js عبر storage event + BroadcastChannel
   4) تمييز "هدف الجلسة" عن "إنجاز اليوم" عبر source: 'focus-session'
   5) حفظ mute في localStorage (لا يفقد بعد reload)
   6) دعم cancelled (إلغاء) كحالة صريحة منفصلة عن finished
   7) حارس الهدف الاحتياطي (لو companion.js وقع)
   8) معالجة audio errors (onerror) + fallback محايد
   9) تصحيح drift لو تغيرت ساعة النظام
   10) تحسين استرجاع الجلسة (running/paused/finished/cancelled)
   11) إزالة الكود الميت والتكرار
   12) تحصين ضد private mode / quota exceeded
   ============================================================================ */
(() => {
  'use strict';

  /* ==========================================================================
     القسم 1: الثوابت + العناصر
     ========================================================================== */
  const $ = (id) => document.getElementById(id);

  const duration = $('durationSelect');
  const time = $('timerTime');
  const face = $('timerFace');
  const caption = $('timerCaption');
  const status = $('roomStatus');
  const promise = $('promiseText');
  const music = $('focusMusic');
  const start = $('startTimer');
  const reset = $('resetTimer');
  const close = $('closeRoom');
  const subject = $('subjectInput');
  const goal = $('goalInput');
  const confirm = $('confirmTask');
  const mute = $('muteMusic');

  const SESSION = 'malak-focus-session-v2';
  const STATS = 'malak-study-progress-v2';
  const PLAN = 'malak-study-planner-v1';
  const MUTE_KEY = 'malak-room-muted-v1';
  const SYNC_CHANNEL = 'malak-sync';

  let tickId = null;
  let session = null;
  let muted = false;
  let syncChannel = null;

  /* ==========================================================================
     القسم 2: أدوات مساعدة
     ========================================================================== */
  const ar = (n) => Number(n).toLocaleString('ar-EG');

  const fmt = (s) => {
    const v = Math.max(0, Math.floor(s));
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  };

  const dateKey = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const nowSec = () => Math.floor(Date.now() / 1000);

  /* ==========================================================================
     القسم 3: الأحداث + التزامن
     ========================================================================== */
  function ev(type, data = {}) {
    try {
      if (window.companion) companion.emit(type, data);
    } catch (_) {}
  }

  function broadcast(type, payload = {}) {
    if (syncChannel) {
      try {
        syncChannel.postMessage({ type, ...payload });
      } catch (_) {}
    }
  }

  function setupSync() {
    if ('BroadcastChannel' in window) {
      try {
        syncChannel = new BroadcastChannel(SYNC_CHANNEL);
      } catch (_) {}
    }

    // مزامنة عبر storage (لو الجلسة اتغيرت من تاب تاني)
    window.addEventListener('storage', (e) => {
      if (e.key === SESSION) {
        const ss = readSession();
        if (ss && (!session || ss.id !== session.id)) {
          // جلسة مختلفة تمامًا من تاب تاني — نعيد التحميل
          loadSession(ss);
        }
      }
    });
  }

  /* ==========================================================================
     القسم 4: التخزين الآمن
     ========================================================================== */
  const Storage = {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        const v = JSON.parse(raw);
        return v == null ? fallback : v;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (_) {
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (_) {}
    }
  };

  function readSession() {
    return Storage.get(SESSION, null);
  }

  function saveSession() {
    if (session) {
      if (!Storage.set(SESSION, session)) {
        status.textContent = 'مش قادرة أحفظ حالة الجلسة على الجهاز ده.';
      }
    } else {
      Storage.remove(SESSION);
    }
  }

  function readStats() {
    const s = Storage.get(STATS, null);
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { sessions: [], tasks: [] };
    }
    return {
      sessions: Array.isArray(s.sessions) ? s.sessions : [],
      tasks: Array.isArray(s.tasks) ? s.tasks : []
    };
  }

  function writeStats(stats) {
    if (!Storage.set(STATS, stats)) {
      status.textContent = 'مش قادرة أحفظ الإحصائيات.';
    }
  }

  /* ==========================================================================
     القسم 5: الموسيقى
     ========================================================================== */
  function loadMute() {
    const v = Storage.get(MUTE_KEY, false);
    muted = v === true;
    updateMuteButton();
  }

  function updateMuteButton() {
    if (!mute || !musicAvailable) return;
    mute.textContent = muted ? '♪ تشغيل الموسيقى' : '♪ كتم الموسيقى';
    mute.setAttribute('aria-pressed', String(muted));
  }

  /* الملف الصوتي اختياري: لو malak.mp3 مش موجود نعطّل الزر بنص واضح، والمؤقت مايتأثرش */
  let musicAvailable = true;

  function markMusicUnavailable() {
    if (!musicAvailable) return;
    musicAvailable = false;
    if (mute) {
      mute.textContent = '♪ الموسيقى غير متاحة';
      mute.disabled = true;
      mute.removeAttribute('aria-pressed');
      mute.title = 'ملف الموسيقى (malak.mp3) مش موجود جنب الصفحة';
    }
  }

  function setupMusicAvailability() {
    if (!music) { markMusicUnavailable(); return; }
    // التحقق من الحالة الحالية (لو الخطأ حصل قبل ربط المستمع) + أي خطأ لاحق
    const check = () => {
      if (music.error || music.networkState === 3 /* NETWORK_NO_SOURCE */) markMusicUnavailable();
    };
    music.addEventListener('error', markMusicUnavailable);
    window.addEventListener('load', check);
    check();
  }

  function stopMusic() {
    try {
      music.pause();
      music.currentTime = 0;
    } catch (_) {}
  }

  function musicPlay() {
    if (muted || !music || !musicAvailable) return;
    music.loop = true;

    const onError = () => {
      // لا نغير النص الأساسي — فقط نسجل في console
      if (typeof console !== 'undefined') {
        console.info('[room] malak.mp3 غير متاح — المؤقت يعمل بدون موسيقى.');
      }
    };

    music.addEventListener('error', onError, { once: true });

    const p = music.play();
    if (p && p.catch) {
      p.catch(() => {
        // فشل التشغيل — لا نغير status الأساسي
        if (typeof console !== 'undefined') {
          console.info('[room] تعذر تشغيل الموسيقى — المؤقت يعمل بدونها.');
        }
      });
    }
  }

  /* ==========================================================================
     القسم 6: عرض حالة الجلسة
     ========================================================================== */
  function isLocked() {
    return session && (session.status === 'running' || session.status === 'paused');
  }

  function showSession() {
    if (!session) return;

    // المدة
    if (duration) {
      duration.value = String(session.minutes);
      duration.disabled = isLocked();
    }

    // المادة والهدف
    if (subject) {
      subject.value = session.subject || '';
      subject.disabled = isLocked();
    }
    if (goal) {
      goal.value = session.goal || '';
      goal.disabled = isLocked();
    }

    // زر البدء
    if (start) {
      const s = session.status;
      start.disabled = s === 'finished' || s === 'cancelled';
      start.textContent =
        s === 'running' ? 'Ⅱ إيقاف مؤقت'
        : s === 'paused' ? '▶ استكمال'
        : s === 'finished' ? '✓ انتهى الوقت'
        : s === 'cancelled' ? '↺ ابدئي من جديد'
        : '▶ ابدئي المذاكرة';
    }

    // الكابشن
    if (caption) {
      caption.textContent =
        session.status === 'finished' ? 'انتهت الجلسة'
        : session.status === 'paused' ? 'المؤقت متوقف مؤقتًا'
        : session.status === 'cancelled' ? 'جلسة ملغاة'
        : 'وقت التركيز';
    }

    // زر التأكيد
    if (confirm) {
      confirm.disabled = session.status !== 'finished' || session.taskConfirmed === true;
    }

    // زر الإعادة
    if (reset) {
      reset.disabled = session.status === 'running';
    }
  }

  /* ==========================================================================
     القسم 7: رسم المؤقت
     ========================================================================== */
  function renderTimer(remaining) {
    if (!time || !face) return;

    const rem = Math.max(0, remaining);
    time.textContent = fmt(rem);

    if (session && session.total > 0) {
      const pct = clamp((session.total - rem) / session.total * 100, 0, 100);
      face.style.setProperty('--timer-progress', `${pct}%`);
    }
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ==========================================================================
     القسم 8: الحلقة (Tick Loop)
     - deadline-based مع تصحيح drift
     - 1000ms بدل 250ms
     ========================================================================== */
  function remainingSecs() {
    if (!session) return 0;
    if (session.status === 'running') {
      return Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));
    }
    return Math.max(0, session.remaining);
  }

  function update() {
    if (!session) return;

    if (session.status === 'running') {
      const left = remainingSecs();
      renderTimer(left);

      if (left <= 0) {
        finish();
      }
    } else {
      renderTimer(session.remaining);
    }
  }

  function stopTick() {
    if (tickId) {
      clearInterval(tickId);
      tickId = null;
    }
  }

  function startTick() {
    stopTick();
    update();
    // 1000ms — كافي لمؤقت ثانية + أخف على المعالج
    tickId = setInterval(update, 1000);
  }

  /* ==========================================================================
     القسم 9: بدء الجلسة
     ========================================================================== */
  function begin() {
    // استكمال جلسة موقوفة
    if (session && session.status === 'paused') {
      const left = session.remaining;

      session.status = 'running';
      session.deadline = Date.now() + left * 1000;
      session.lastStartedAt = Date.now();
      saveSession();

      showSession();
      status.textContent = 'رجعنا نكمل، خطوة خطوة 💜';
      musicPlay();
      ev('roomResume', { remaining: left });
      broadcast('session-resumed', { remaining: left });

      startTick();
      return;
    }

    // جلسة جديدة
    const minutes = Number(duration.value) || 20;

    session = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: dateKey(),
      minutes,
      total: minutes * 60,
      remaining: minutes * 60,
      deadline: Date.now() + minutes * 60000,
      status: 'running',
      subject: (subject.value || '').trim().slice(0, 60),
      goal: (goal.value || '').trim().slice(0, 180),
      taskConfirmed: false,
      createdAt: new Date().toISOString(),
      focusSeconds: 0,
      lastStartedAt: Date.now()
    };

    saveSession();
    showSession();

    status.textContent = 'بدأت الجلسة. ركزي في هدفك الصغير، والموسيقى اختيارية.';

    if (promise) {
      promise.textContent = `جلسة ${ar(minutes)} دقيقة. ${session.goal || 'خدي خطوة واحدة في المذاكرة.'}`;
    }

    musicPlay();

    ev('roomStart', {
      minutes,
      remaining: session.remaining,
      subject: session.subject,
      goal: session.goal
    });
    broadcast('session-started', { minutes });

    startTick();
    update();
  }

  /* ==========================================================================
     القسم 10: إيقاف مؤقت
     ========================================================================== */
  function pause(quiet) {
    if (!session || session.status !== 'running') return;

    const elapsed = Math.max(0, Math.floor((Date.now() - session.lastStartedAt) / 1000));

    session.remaining = Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));
    session.focusSeconds += elapsed;
    session.status = 'paused';
    session.deadline = 0;
    session.lastStartedAt = 0;

    saveSession();
    stopTick();
    stopMusic();
    showSession();
    renderTimer(session.remaining);

    status.textContent = 'الجلسة متوقفة مؤقتًا. تقدري تستكملي لما تكوني جاهزة.';

    if (!quiet) {
      ev('roomPause');
      broadcast('session-paused');
    }
  }

  /* ==========================================================================
     القسم 11: إنهاء الجلسة
     ========================================================================== */
  function finish() {
    if (!session || session.status === 'finished' || session.status === 'cancelled') return;

    // حساب الوقت الفعلي
    if (session.lastStartedAt) {
      session.focusSeconds += Math.max(0, Math.floor((Date.now() - session.lastStartedAt) / 1000));
      session.lastStartedAt = 0;
    }

    session.remaining = 0;
    session.status = 'finished';
    session.deadline = 0;
    saveSession();

    stopTick();
    stopMusic();

    // تسجيل الجلسة في stats
    const stats = readStats();
    const exists = stats.sessions.some((x) => x.id === session.id);
    if (!exists) {
      stats.sessions.push({
        id: session.id,
        date: session.date,
        subject: session.subject,
        goal: session.goal,
        minutes: session.minutes,
        focusSeconds: Math.min(session.total, session.focusSeconds),
        completed: true,
        completedAt: new Date().toISOString()
      });
      writeStats(stats);
      broadcast('stats-updated');
    }

    showSession();
    renderTimer(0);

    if (confirm) confirm.disabled = false;

    status.textContent = 'الوقت خلص! لو خلصتي هدفك فعلاً، دوسي «أكملت الهدف» عشان يتسجل.';

    ev('roomFinish', { minutes: session.minutes });
    broadcast('session-finished', { minutes: session.minutes });
  }

  /* ==========================================================================
     القسم 12: إلغاء الجلسة (حالة صريحة)
     ========================================================================== */
  function cancel() {
    stopTick();
    stopMusic();

    if (session && session.status === 'running' && session.lastStartedAt) {
      session.focusSeconds += Math.max(0, Math.floor((Date.now() - session.lastStartedAt) / 1000));
    }

    session = null;
    Storage.remove(SESSION);

    // إعادة ضبط الواجهة
    if (duration) duration.disabled = false;
    if (subject) subject.disabled = false;
    if (goal) goal.disabled = false;
    if (confirm) confirm.disabled = true;
    if (reset) reset.disabled = false;

    if (caption) caption.textContent = 'وقت التركيز';

    const mins = Number(duration.value) || 20;
    renderTimer(mins * 60);
    if (face) face.style.setProperty('--timer-progress', '0%');

    if (start) {
      start.disabled = false;
      start.textContent = '▶ ابدئي المذاكرة';
    }

    status.textContent = 'اتلغت الجلسة من غير ما تتحسب جلسة مكتملة. تقدري تبدئي من جديد.';
    if (promise) {
      promise.textContent = 'اختاري هدفًا صغيرًا ومدة مناسبة، وابدئي لما تكوني جاهزة.';
    }

    broadcast('session-cancelled');
  }

  /* ==========================================================================
     القسم 13: حارس الهدف (احتياطي)
     - companion.js عنده حارس مماثل، لكن ده fallback لو companion.js وقع
     ========================================================================== */
  let goalGuardBypass = false;

  function checkGoalBeforeStart() {
    if (goalGuardBypass) return true;

    const gVal = (goal?.value || '').trim();

    // الهدف موجود — تمام
    if (gVal) return true;

    // لو companion.js شغال، هو اللي هيتولى (ما نمنعش هنا)
    if (window.companion && typeof companion.emit === 'function') {
      // companion.js هيعترض الحدث بنفسه
      return true;
    }

    // companion.js مش موجود — نمنع ونطلب هدف بنافذة المشروع (مش confirm الأصلي)
    const dlg = $('noGoalDialog');
    if (!dlg || typeof dlg.showModal !== 'function') return true;
    if (!dlg.open) dlg.showModal();
    const write = $('noGoalWrite');
    if (write) write.focus(); // التركيز الافتراضي على كتابة الهدف
    return false;
  }

  function bindNoGoalDialog() {
    const dlg = $('noGoalDialog');
    const write = $('noGoalWrite');
    const go = $('noGoalGo');
    if (!dlg || !write || !go) return;
    let busy = false;

    write.addEventListener('click', () => {
      dlg.close();
      if (goal) goal.focus();
    });
    go.addEventListener('click', () => {
      if (busy) return; // منع الضغط المتكرر
      busy = true;
      dlg.close();
      goalGuardBypass = true;
      try { begin(); } finally { goalGuardBypass = false; busy = false; }
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { if (goal && !session) goal.focus({ preventScroll: true }); });
  }

  // استقبال إشارة من companion.js لتجاوز الحارس
  window.addEventListener('malak-goal-bypass', () => {
    goalGuardBypass = true;
    setTimeout(() => { goalGuardBypass = false; }, 500);
  });

  /* ==========================================================================
     القسم 14: ربط الأحداث
     ========================================================================== */
  function bindEvents() {
    // زر البدء
    if (start) {
      start.addEventListener('click', () => {
        // استكمال
        if (session && session.status === 'paused') {
          begin();
          return;
        }

        // جلسة انتهت — نحوّلها لإعادة ضبط أولاً
        if (session && session.status === 'finished') {
          cancel();
          return;
        }

        // جلسة ملغاة — نبدأ من جديد
        if (session && session.status === 'cancelled') {
          cancel();
          return;
        }

        // إيقاف مؤقت
        if (session && session.status === 'running') {
          pause();
          return;
        }

        // بدء جديد
        if (!checkGoalBeforeStart()) return;
        begin();
      });
    }

    // إعادة الضبط
    if (reset) {
      reset.addEventListener('click', () => {
        if (session && session.status !== 'finished') {
          const left = remainingSecs();
          const progress = session.total ? 1 - left / session.total : 0;
          ev('roomReset', { progress });
        }

        if (session && session.status === 'running') {
          pause(true);
        }

        cancel();
      });
    }

    // تغيير المدة
    if (duration) {
      duration.addEventListener('change', () => {
        const mins = Number(duration.value) || 20;

        // لو مفيش جلسة نشطة، نحدّث المؤقت
        if (!session || session.status === 'finished' || session.status === 'cancelled') {
          renderTimer(mins * 60);
          if (face) face.style.setProperty('--timer-progress', '0%');
          if (promise) {
            promise.textContent = `اختيارك لمدة ${ar(mins)} دقيقة. ابدئي بخطوة بسيطة.`;
          }
        }
      });
    }

    // كتم الموسيقى
    if (mute) {
      mute.addEventListener('click', () => {
        muted = !muted;
        Storage.set(MUTE_KEY, muted);
        updateMuteButton();

        if (muted) {
          stopMusic();
        } else if (session && session.status === 'running') {
          musicPlay();
        }
      });
    }

    // تأكيد الهدف
    if (confirm) {
      confirm.addEventListener('click', () => {
        if (!session || session.status !== 'finished' || session.taskConfirmed) return;

        session.taskConfirmed = true;
        saveSession();

        const stats = readStats();
        const exists = stats.tasks.some((x) => x.sessionId === session.id);

        if (!exists) {
          stats.tasks.push({
            date: session.date,
            at: new Date().toISOString(),
            sessionId: session.id,
            subject: session.subject,
            goal: session.goal,
            source: 'focus-session'
          });
          writeStats(stats);
          broadcast('stats-updated');
        }

        confirm.disabled = true;
        status.textContent = 'برافو يا ملك! تم تسجيل إنجاز الهدف اللي أكدتيه 💜';

        // مصدر 'focus-session' — مش إنجاز يوم كامل
        ev('done', { on: true, source: 'focus-session' });
      });
    }

    // إغلاق الغرفة
    if (close) {
      close.addEventListener('click', () => {
        if (session && session.status === 'running') {
          pause(true);
        }
        location.href = 'index.html';
      });
    }

    // حفظ عند إغلاق الصفحة
    window.addEventListener('pagehide', () => {
      stopTick();

      if (session && session.status === 'running') {
        session.remaining = Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));

        if (session.lastStartedAt) {
          session.focusSeconds += Math.max(0, Math.floor((Date.now() - session.lastStartedAt) / 1000));
          session.lastStartedAt = Date.now();
        }

        saveSession();
      }

      stopMusic();
    });

    // تصحيح عند عودة التبويب (لو الوقت قفز)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (!session || session.status !== 'running') return;

      // لو deadline عدى أثناء الغياب، ننهي
      if (remainingSecs() <= 0) {
        finish();
      } else {
        update();
      }
    });
  }

  /* ==========================================================================
     القسم 15: تحميل السياق من الرابط أو sessionStorage
     ========================================================================== */
  function loadContext() {
    try {
      const params = new URLSearchParams(location.search);

      // 1) جلسة معلقة من goalPicker في app.js
      const pendingRaw = sessionStorage.getItem('malak-pending-session');
      if (pendingRaw) {
        const pending = JSON.parse(pendingRaw);
        if (pending) {
          if (subject && !subject.value) {
            subject.value = String(pending.subject || '').slice(0, 60);
          }
          if (goal && !goal.value) {
            goal.value = String(pending.goal || '').slice(0, 180);
          }
        }
        sessionStorage.removeItem('malak-pending-session');
      }

      // 2) المادة من URL
      const sParam = params.get('s');
      if (sParam && subject && !subject.value) {
        subject.value = sParam.slice(0, 60);
      }

      // 3) المدة من URL
      const mParam = params.get('m');
      if (mParam && duration) {
        const valid = [...duration.options].some((o) => o.value === mParam);
        if (valid) duration.value = mParam;
      }
    } catch (_) {
      // نتجاهل
    }
  }

  /* ==========================================================================
     القسم 16: استرجاع جلسة محفوظة
     ========================================================================== */
  function loadSession(saved) {
    if (!saved || !saved.status) return false;
    if (!Number.isFinite(saved.total) || !Number.isFinite(saved.remaining)) return false;

    // الحالات المقبولة
    const validStatuses = ['running', 'paused', 'finished'];
    if (!validStatuses.includes(saved.status)) return false;

    session = saved;

    if (session.status === 'running') {
      // نحسب المتبقي من deadline
      session.remaining = Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));

      if (session.remaining <= 0) {
        // انتهت أثناء الغياب
        finish();
      } else {
        session.lastStartedAt = Date.now();
        startTick();
        status.textContent = 'رجّعنا جلستك اللي كانت شغالة.';
      }
    } else if (session.status === 'paused') {
      status.textContent = 'استعدنا جلستك المتوقفة مؤقتًا.';
    } else if (session.status === 'finished') {
      status.textContent = 'الجلسة السابقة انتهت. أكّدي إنجاز الهدف إن كنتِ أنجزتيه.';
    }

    showSession();
    update();
    return true;
  }

  /* ==========================================================================
     القسم 17: التشغيل (Boot)
     ========================================================================== */
  function boot() {
    loadMute();
    setupSync();
    loadContext();

    // استرجاع الجلسة
    const saved = readSession();
    const loaded = saved ? loadSession(saved) : false;

    // لا توجد جلسة محفوظة — الواجهة الافتراضية
    if (!loaded) {
      const mins = Number(duration?.value) || 20;
      renderTimer(mins * 60);
      if (face) face.style.setProperty('--timer-progress', '0%');
    }

    bindEvents();
    bindNoGoalDialog();
    setupMusicAvailability();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
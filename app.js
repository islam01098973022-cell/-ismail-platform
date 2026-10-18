/* app.js — v2 (إصلاح شامل + مزامنة بين الصفحات)
   ============================================================================
   منطق جدول ملك + الإحصائيات.

   إصلاحات v2:
   1) توحيد بداية الأسبوع على الأحد (متسق مع عرض الجدول)
   2) إزالة state.done القديمة (مصفوفة ميتة)
   3) تبسيط doneByDate (بدون تكرار .date)
   4) منع تكرار تسجيل المهام (idempotent)
   5) مزامنة عبر storage event + BroadcastChannel
   6) تحسين render() لتقليل فقدان focus
   7) إصلاح aria-label المقلوب على check-btn
   8) إضافة confirm dialog قبل حذف إنجاز اليوم
   9) تحصين ضد private mode / quota exceeded
   10) توحيد منطق "الأسبوع" بين app.js و companion.js
   ============================================================================ */
(() => {
  'use strict';

  /* ==========================================================================
     القسم 1: الثوابت
     ========================================================================== */
  const STORAGE_KEY = 'malak-study-planner-v1';
  const STATS_KEY = 'malak-study-progress-v2';
  const SYNC_CHANNEL = 'malak-sync';

  const DEFAULT_DAYS = [
    { name: 'الأحد',     emoji: '☀️', subjects: ['عربي'] },
    { name: 'الاثنين',   emoji: '🌸', subjects: ['كيمياء', 'إنجليزي'] },
    { name: 'الثلاثاء',  emoji: '🧪', subjects: ['كيمياء'] },
    { name: 'الأربعاء',  emoji: '🌿', subjects: ['لغة عربية', 'أحياء'] },
    { name: 'الخميس',    emoji: '🦋', subjects: ['أحياء'] },
    { name: 'الجمعة',    emoji: '🌈', subjects: ['إنجليزي', 'فيزياء'] },
    { name: 'السبت',     emoji: '⚡', subjects: ['فيزياء'] }
  ];

  const ALL_SUBJECTS = ['عربي', 'لغة عربية', 'كيمياء', 'إنجليزي', 'أحياء', 'فيزياء'];

  /* ==========================================================================
     القسم 2: أدوات التاريخ — موحّدة مع companion.js
     الأسبوع يبدأ من الأحد (getDay() = 0)
     ========================================================================== */
  const pad2 = (n) => String(n).padStart(2, '0');

  const localDate = (d = new Date()) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  const dayIndex = (d = new Date()) => d.getDay(); // 0=الأحد

  // بداية الأسبوع = الأحد (متسق مع عرض الجدول)
  const weekStart = (d = new Date()) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - x.getDay()); // نرجع للأحد
    return x;
  };

  const weekDates = () => {
    const start = weekStart();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return localDate(d);
    });
  };

  /* ==========================================================================
     القسم 3: أدوات مساعدة
     ========================================================================== */
  const ar = (n) => Number(n).toLocaleString('ar-EG');

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const $ = (id) => document.getElementById(id);

  /* ==========================================================================
     القسم 4: طبقة التخزين الآمنة
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
    }
  };

  /* ==========================================================================
     القسم 5: الحالة
     ========================================================================== */
  let state = {
    days: DEFAULT_DAYS.map((d) => ({ ...d, subjects: [...d.subjects], note: '' })),
    doneByDate: {} // { 'YYYY-MM-DD': true }
  };

  let stats = { sessions: [], tasks: [] };

  /* تحميل آمن مع هجرة من النسخة القديمة */
  function loadState() {
    const old = Storage.get(STORAGE_KEY);
    if (old && Array.isArray(old.days) && old.days.length === 7) {
      state.days = old.days.map((d, i) => ({
        name: typeof d?.name === 'string' ? d.name : DEFAULT_DAYS[i].name,
        emoji: typeof d?.emoji === 'string' ? d.emoji : DEFAULT_DAYS[i].emoji,
        subjects: Array.isArray(d?.subjects)
          ? d.subjects.filter((x) => typeof x === 'string')
          : [],
        note: typeof d?.note === 'string' ? d.note : ''
      }));
    }

    // هجرة doneByDate من الصيغة القديمة ({date: {date, ...}}) أو done (array)
    const dbd = old?.doneByDate;
    if (dbd && typeof dbd === 'object' && !Array.isArray(dbd)) {
      Object.keys(dbd).forEach((k) => {
        if (dbd[k]) state.doneByDate[k] = true;
      });
    }
  }

  function loadStats() {
    const s = Storage.get(STATS_KEY);
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      stats.sessions = Array.isArray(s.sessions) ? s.sessions : [];
      stats.tasks = Array.isArray(s.tasks) ? s.tasks : [];
    }
  }

  function persistState() {
    if (!Storage.set(STORAGE_KEY, state)) {
      toast('مش قادرة أحفظ على الجهاز ده');
    }
  }

  function persistStats() {
    if (!Storage.set(STATS_KEY, stats)) {
      toast('مش قادرة أحفظ الإحصائيات');
    }
  }

  /* ==========================================================================
     القسم 6: المزامنة بين الصفحات
     - storage event: لما room.html أو companion.js يحفظوا
     - BroadcastChannel: أسرع وأدق (لو مدعوم)
     ========================================================================== */
  let syncChannel = null;

  function setupSync() {
    // storage event
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        loadState();
        render();
      } else if (e.key === STATS_KEY) {
        loadStats();
        renderProgress();
      }
    });

    // BroadcastChannel
    if ('BroadcastChannel' in window) {
      try {
        syncChannel = new BroadcastChannel(SYNC_CHANNEL);
        syncChannel.onmessage = (e) => {
          if (e.data?.type === 'stats-updated') {
            loadStats();
            renderProgress();
          } else if (e.data?.type === 'state-updated') {
            loadState();
            render();
          }
        };
      } catch (_) { /* نتجاهل */ }
    }
  }

  function broadcast(type) {
    if (syncChannel) {
      try { syncChannel.postMessage({ type }); } catch (_) {}
    }
  }

  /* ==========================================================================
     القسم 7: التوست
     ========================================================================== */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  /* ==========================================================================
     القسم 8: العرض (Render)
     ========================================================================== */
  const schedule = $('schedule');
  const editor = $('editor');
  const daySelect = $('daySelect');
  const subjectOptions = $('subjectOptions');
  const dayNote = $('dayNote');

  function render() {
    if (!schedule) return;

    const idx = dayIndex();
    const dates = weekDates(); // تواريخ الأسبوع الجاري (الأحد → السبت)

    schedule.innerHTML = state.days.map((d, i) => {
      const date = dates[i];
      const isToday = i === idx;
      const isPast = i < idx;   // أيام سابقة في الأسبوع الجاري فقط
      const done = (isToday || isPast) && !!state.doneByDate[date];

      const subjectChips = d.subjects.length
        ? d.subjects
            .map(
              (s) =>
                `<button type="button" class="subject subject-start" data-start="${i}" data-subject="${esc(s)}" aria-label="بدء جلسة ${esc(s)}">${esc(s)} ↗</button>`
            )
            .join('')
        : '<span class="empty">يوم مفتوح 🌼</span>';

      const noteHtml = d.note
        ? `<p class="day-note">✎ ${esc(d.note)}</p>`
        : '';

      // الأيام القادمة: نص حالة فقط بدون زر معطّل
      let bottom;
      if (!isToday && !isPast) {
        bottom = `<div class="day-bottom day-bottom-state"><small>يوم قادم</small></div>`;
      } else {
        const checkLabel = done
          ? `إلغاء تأكيد إنجاز ${d.name}`
          : isToday ? 'أنجزت هدف اليوم' : `تسجيل إنجاز ${d.name}`;
        const checkText = done
          ? '✓ تم الإنجاز'
          : isToday ? 'أنجزت هدف اليوم' : 'سجّلي إنجاز اليوم';
        const caption = done
          ? (isToday ? 'تم تأكيد هدف اليوم' : 'تم تأكيد هدف اليوم السابق')
          : isToday ? 'اختاري مادة لبدء جلسة' : 'يوم سابق';
        bottom = `<div class="day-bottom">
          <small>${caption}</small>
          <button class="check-btn${isPast ? ' check-btn-past' : ''}" type="button" data-done="${i}" aria-pressed="${done}" aria-label="${checkLabel}">${checkText}</button>
        </div>`;
      }

      return `<article class="day-card ${done ? 'done' : ''} ${isToday ? 'today' : ''}" data-day="${i}">
        <div class="day-top">
          <span class="day-name">${esc(d.name)}${isToday ? ' · اليوم' : ''}</span>
          <span class="day-emoji">${esc(d.emoji || '📚')}</span>
        </div>
        <div class="subjects">${subjectChips}</div>
        ${noteHtml}
        ${bottom}
        <button class="btn btn-soft" type="button" data-edit="${i}">✎ تعديل مواد اليوم</button>
      </article>`;
    }).join('');

    renderProgress();
  }

  function renderProgress() {
    const dates = weekDates();
    const completed = dates.filter((d) => state.doneByDate[d]).length;

    // إحصائيات الأسبوع
    const weekTasks = stats.tasks.filter((x) => dates.includes(x.date)).length;
    const weekSessions = stats.sessions.filter(
      (x) => dates.includes(x.date) && x.completed === true
    ).length;
    const weekMins = stats.sessions
      .filter((x) => dates.includes(x.date) && x.completed === true)
      .reduce((n, x) => n + (Number(x.focusSeconds) || 0), 0);

    const pt = $('progressText');
    const pf = $('progressFill');

    if (pt) pt.textContent = `${ar(completed)} من ٧ أيام`;

    if (pf) {
      pf.style.width = `${(completed / 7) * 100}%`;
      const bar = pf.parentElement;
      if (bar) {
        bar.setAttribute('aria-valuenow', String(completed));
        bar.setAttribute('aria-valuetext', `${completed} من 7 أيام`);
      }
    }

    const el = $('weeklyStats');
    if (el) {
      const hrs = Math.floor(weekMins / 3600);
      const mins = Math.floor((weekMins % 3600) / 60);
      el.innerHTML = `
        <div><strong>${ar(weekTasks)}</strong><span>أهداف أكدتِها</span></div>
        <div><strong>${ar(weekSessions)}</strong><span>جلسات انتهى وقتها</span></div>
        <div><strong>${ar(hrs)} س ${ar(mins)} د</strong><span>وقت التركيز</span></div>
      `;
    }
  }

  /* ==========================================================================
     القسم 9: محرر اليوم
     ========================================================================== */
  function openEditor(index = 0) {
    if (!editor || !daySelect) return;

    daySelect.innerHTML = state.days
      .map((d, i) => `<option value="${i}">${esc(d.name)}</option>`)
      .join('');

    daySelect.value = String(index);
    buildSubjectOptions();
    editor.showModal();
  }

  function buildSubjectOptions() {
    if (!daySelect || !subjectOptions) return;

    const i = Number(daySelect.value);
    const current = state.days[i]?.subjects || [];

    subjectOptions.innerHTML = ALL_SUBJECTS.map(
      (s) =>
        `<label class="subject-option"><input type="checkbox" value="${esc(s)}" ${
          current.includes(s) ? 'checked' : ''
        }><span>${esc(s)}</span></label>`
    ).join('');

    if (dayNote) dayNote.value = state.days[i]?.note || '';

    const title = $('modalTitle');
    if (title) title.textContent = `تعديل يوم ${state.days[i]?.name || ''}`;
  }

  /* ==========================================================================
     القسم 10: ربط الأحداث
     ========================================================================== */
  function bindEvents() {
    // محرر
    if (daySelect) daySelect.addEventListener('change', buildSubjectOptions);

    const editAll = $('editAll');
    if (editAll) editAll.addEventListener('click', () => openEditor(0));

    const cancelEdit = $('cancelEdit');
    if (cancelEdit)
      cancelEdit.addEventListener('click', () => editor?.close());

    // حدث الجدول (event delegation)
    if (schedule) {
      schedule.addEventListener('click', (e) => {
        const start = e.target.closest('[data-start]');
        const edit = e.target.closest('[data-edit]');
        const done = e.target.closest('[data-done]');

        if (start) {
          openGoalPicker(start.dataset.subject);
          return;
        }

        if (edit) {
          openEditor(Number(edit.dataset.edit));
          return;
        }

        if (done) {
          handleDoneClick(Number(done.dataset.done));
        }
      });
    }

    // حفظ التعديلات
    const editForm = $('editForm');
    if (editForm) {
      editForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const i = Number(daySelect.value);
        state.days[i].subjects = [
          ...subjectOptions.querySelectorAll('input:checked')
        ].map((x) => x.value);
        state.days[i].note = dayNote.value.trim();

        persistState();
        render();
        broadcast('state-updated');
        editor.close();

        if (window.companion) companion.emit('saved');
        else toast('تم حفظ جدولك يا ملك 💜');
      });
    }

    // زر الغرفة
    const openRoom = $('openRoom');
    if (openRoom) {
      openRoom.addEventListener('click', () => {
        // لو فيه مادة مختارة في السياق، نمررها
        const subj = sessionStorage.getItem('malak-last-subject') || '';
        const url = subj
          ? `room.html?s=${encodeURIComponent(subj)}`
          : 'room.html';
        location.href = url;
      });
    }
  }

  /* ==========================================================================
     القسم 11: تأكيد الإنجاز (idempotent + confirm)
     ========================================================================== */
  function undoDone(date) {
    delete state.doneByDate[date];
    persistState();

    // شيل المهمة المرتبطة بنفس اليوم من stats
    const before = stats.tasks.length;
    stats.tasks = stats.tasks.filter(
      (x) => !(x.date === date && x.source === 'daily-goal')
    );
    if (stats.tasks.length !== before) persistStats();
  }

  function handleDoneClick(i) {
    const idx = dayIndex();
    if (i > idx) {
      toast('الأيام القادمة مش متاحة للتأكيد لسه.');
      return;
    }

    const date = weekDates()[i];
    const isToday = i === idx;
    const already = !!state.doneByDate[date];

    // لو مضغوط تاني، نسأل قبل الحذف (نافذة المشروع بدل confirm)
    if (already) {
      openUndoDialog(i);
      return;
    }

    // تأكيد الإنجاز
    state.doneByDate[date] = true;
    persistState();

    // منع تكرار المهمة (idempotent) لنفس التاريخ
    const exists = stats.tasks.some(
      (x) => x.date === date && x.source === 'daily-goal'
    );
    if (!exists) {
      stats.tasks.push({
        date,
        at: new Date().toISOString(),
        source: 'daily-goal'
      });
      persistStats();
    }

    render();
    broadcast('state-updated');
    broadcast('stats-updated');
    focusCheck(i);

    if (window.companion) companion.emit('done', { on: true, date });
    else toast(isToday ? 'عاش يا ملك! هدفك اتسجل 🎉' : 'اتسجل إنجاز اليوم السابق 🌸');
  }

  function focusCheck(i) {
    const b = schedule && schedule.querySelector(`[data-done="${i}"]`);
    if (b) b.focus({ preventScroll: true });
  }

  /* نافذة تأكيد إلغاء الإنجاز (بدل confirm الأصلي) */
  let undoIndex = -1;
  let undoing = false;

  function openUndoDialog(i) {
    const dlg = $('undoDialog');
    if (!dlg) return;
    undoIndex = i;
    const name = state.days[i]?.name || '';
    const desc = $('undoDesc');
    if (desc) desc.textContent = `هنشيل علامة إنجاز يوم ${name}، وتتشال معاها المهمة المرتبطة بيه من العدّ.`;
    const okBtn = $('confirmUndo');
    if (okBtn) okBtn.disabled = false;
    dlg.showModal();
    const noBtn = $('cancelUndo');
    if (noBtn) noBtn.focus(); // التركيز الافتراضي على «رجوع»
  }

  function bindUndo() {
    const dlg = $('undoDialog');
    const okBtn = $('confirmUndo');
    const noBtn = $('cancelUndo');
    if (!dlg || !okBtn || !noBtn) return;

    const closeAndRestore = () => {
      const i = undoIndex;
      undoIndex = -1;
      if (dlg.open) dlg.close();
      if (i >= 0) focusCheck(i);
    };

    noBtn.addEventListener('click', () => { if (!undoing) closeAndRestore(); });
    dlg.addEventListener('cancel', (e) => { if (undoing) e.preventDefault(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg && !undoing) closeAndRestore(); });

    okBtn.addEventListener('click', () => {
      if (undoing || undoIndex < 0) return; // منع الضغط المتكرر
      undoing = true;
      okBtn.disabled = true;

      const i = undoIndex;
      const date = weekDates()[i];
      undoIndex = -1;
      undoDone(date);
      undoing = false;

      dlg.close();
      render();
      broadcast('state-updated');
      broadcast('stats-updated');
      focusCheck(i);

      if (window.companion) companion.emit('done', { on: false, date });
      else toast('تم إلغاء التأكيد');
    });
  }

  /* ==========================================================================
     القسم 11-ب: إعادة تعيين الإحصائيات
     - يصفّر doneByDate داخل مفتاح الجدول (بدون المساس بالأيام/المواد/الملاحظات)
     - يصفّر sessions و tasks داخل مفتاح الإحصائيات
     - لا يلمس مفتاح الجلسة الجارية ولا أي إعدادات أخرى
     ========================================================================== */
  let resetting = false;

  function readRaw(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function parseObj(raw) {
    if (raw == null) return null;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (_) { return null; }
  }

  // يرجع true عند النجاح. لو فشلت أي كتابة نرجّع القيم القديمة حرفيًا.
  function performStatsReset() {
    const rawPlan = readRaw(STORAGE_KEY);
    const rawStats = readRaw(STATS_KEY);

    // نقرأ النسخة الحالية من التخزين (وليس الذاكرة) كي لا نكتب فوق تعديل من تبويب آخر
    const plan = parseObj(rawPlan);
    const st = parseObj(rawStats);

    try {
      if (plan) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...plan, doneByDate: {} }));
      }
      localStorage.setItem(STATS_KEY, JSON.stringify({ ...(st || {}), sessions: [], tasks: [] }));
    } catch (_) {
      try {
        if (rawPlan == null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, rawPlan);
        if (rawStats == null) localStorage.removeItem(STATS_KEY);
        else localStorage.setItem(STATS_KEY, rawStats);
      } catch (__) { /* لا شيء إضافي يمكن فعله */ }
      return false;
    }

    // تحديث الذاكرة والواجهة فورًا
    state.doneByDate = {};
    stats.sessions = [];
    stats.tasks = [];
    return true;
  }

  function bindReset() {
    const dlg = $('resetDialog');
    const openBtn = $('resetStats');
    const okBtn = $('confirmReset');
    const noBtn = $('cancelReset');
    const errEl = $('resetError');
    if (!dlg || !openBtn || !okBtn || !noBtn) return;

    const showError = (msg) => {
      if (!errEl) return;
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    };

    openBtn.addEventListener('click', () => {
      showError('');
      okBtn.disabled = false;
      dlg.showModal();
      noBtn.focus(); // التركيز الافتراضي على «إلغاء» لأن العملية لا تُسترجع
    });

    noBtn.addEventListener('click', () => { if (!resetting) dlg.close(); });
    dlg.addEventListener('cancel', (e) => { if (resetting) e.preventDefault(); });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && !resetting) dlg.close();
    });

    okBtn.addEventListener('click', () => {
      if (resetting) return; // منع الضغط المتكرر
      resetting = true;
      okBtn.disabled = true;

      const ok = performStatsReset();
      resetting = false;

      if (!ok) {
        okBtn.disabled = false;
        showError('تعذّر حفظ التغييرات على الجهاز، ولم يتغير أي شيء. جرّبي تاني.');
        return;
      }

      dlg.close();
      render();
      broadcast('state-updated');
      broadcast('stats-updated');
      toast('تمت إعادة تعيين الإحصائيات. ابدئي تقدّمك من جديد 🌸');
      openBtn.focus();
    });
  }

  /* ==========================================================================
     القسم 12: منتقي الهدف
     ========================================================================== */
  const goalPicker = $('goalPicker');
  const goalForm = $('goalForm');
  const pickedSubject = $('pickedSubject');
  const pickedGoal = $('pickedGoal');

  function openGoalPicker(subj) {
    if (!goalPicker) return;

    pickedSubject.value = String(subj || '').slice(0, 60);
    pickedGoal.value = '';

    // نحفظ المادة في sessionStorage كسياق للغرفة
    try {
      sessionStorage.setItem('malak-last-subject', pickedSubject.value);
    } catch (_) {}

    goalPicker.showModal();
    setTimeout(() => pickedGoal.focus(), 80);
  }

  function bindGoalPicker() {
    if (!goalPicker) return;

    goalPicker.addEventListener('click', (e) => {
      if (e.target === goalPicker) goalPicker.close();
    });

    const cancelGoal = $('cancelGoal');
    if (cancelGoal) cancelGoal.addEventListener('click', () => goalPicker.close());

    goalPicker.querySelectorAll('[data-goal]').forEach((b) => {
      b.addEventListener('click', () => {
        pickedGoal.value = b.dataset.goal || '';
        pickedGoal.focus();
      });
    });

    if (goalForm) {
      goalForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const subj = pickedSubject.value.trim();
        const goal = pickedGoal.value.trim();

        if (!subj || !goal) {
          pickedGoal.focus();
          return;
        }

        // تمرير السياق للغرفة
        try {
          sessionStorage.setItem(
            'malak-pending-session',
            JSON.stringify({ subject: subj, goal })
          );
          sessionStorage.setItem('malak-last-subject', subj);
        } catch (_) {
          toast('تعذر تمرير الهدف للغرفة؛ اكتبيه مرة أخرى هناك.');
        }

        location.href = 'room.html';
      });
    }
  }

  /* ==========================================================================
     القسم 13: التشغيل (Boot)
     ========================================================================== */
  function boot() {
    loadState();
    loadStats();
    render();
    bindEvents();
    bindGoalPicker();
    bindReset();
    bindUndo();
    setupSync();

    // لو الصفحة اتفتحت في نفس اللحظة اللي room.js بيحفظ فيها
    // نعمل refresh بعد لحظة قصيرة لضمان التزامن
    setTimeout(() => {
      loadStats();
      renderProgress();
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
const {
  Plugin, PluginSettingTab, Setting, Notice, AbstractInputSuggest, TextComponent, DropdownComponent,
  ExtraButtonComponent, setIcon, debounce, moment,
} = require('obsidian');

const DEFAULTS = {
  // Card filter: which cards can be colored at all
  filterMatch: 'all', // 'all' or 'any'
  filters: [], // [{ prop, op, value }]
  // Due dates
  dateProperties: 'Due',
  overdueEnabled: true,
  color: 'red', // overdue (a theme color name, or any #hex color)
  todayEnabled: true,
  todayColor: 'orange',
  soonEnabled: true,
  soonColor: 'yellow',
  soonDays: 3,
  dateScope: [], // bases where due-date colors apply; empty = everywhere
  // Property rules: [{ prop, op, value, color, useFilter, scope }]
  rules: [],
  rulesFirst: false, // false = due dates win over rules
  enabled: true, // master switch, also toggled by a command
  views: ['kanban'], // view types whose cards/rows get colored: 'kanban', 'cards', 'table', 'list'
  badge: true, // "Due: 3 days" label on each colored card/row
  highlightStyle: 'tint', // 'tint', 'border' or 'stripe'
  opacity: 15,
  collapsed: {}, // settings sections the user has collapsed, by section key
  // Property/tag colors: the value pills (like Client or Owner) in Bases views and note properties
  pillsEnabled: true,
  pillAuto: true, // give every value a consistent color based on its text
  pillColors: [], // custom colors: [{ prop, value, color }]; empty prop = any property
  pillProps: true, // also color pills in the Properties panel at the top of notes
  pillShape: true, // compact pill shape instead of the theme's default
};

// Pills in Bases views (tables use multi-select pills; Cards, Kanban and List views use value-list elements)
const PILL_SEL = '.multi-select-pill, .bases-cards-line .value-list-element, .bases-kanban-card-line .value-list-element, .bases-list-property .value-list-element';
const PROP_PILL_SEL = '.metadata-property .multi-select-pill';
// Cards/rows in each view type ("[draggable]" skips the invisible sizing card in Cards view)
const VIEW_TYPES = { kanban: 'Kanban', cards: 'Cards', table: 'Table', list: 'List' };
const ITEM_SEL = '.bases-kanban-card, .bases-cards-item[draggable], .bases-tbody > .bases-tr, .bases-list-item';
const itemType = (el) => {
  const c = el.classList;
  return c.contains('bases-kanban-card') ? 'kanban' : c.contains('bases-cards-item') ? 'cards' : c.contains('bases-tr') ? 'table' : 'list';
};

// A value's automatic color, worked out from its text so the same value is always the same color
const autoColor = (text) => {
  const t = text.replace(/\s+/g, '').replace(/[^\w\u00C0-\u017F-]/g, '');
  if (!t) return null;
  let h = 0;
  for (let i = 0; i < t.length; i++) { h = (h << 5) - h + t.charCodeAt(i); h = h & h; }
  const hex = (n) => (80 + Math.abs(n) % 120).toString(16).padStart(2, '0');
  return '#' + hex(h) + hex(h >> 8) + hex(h >> 16);
};
// Dark or light text, whichever reads better on the pill color
const textOn = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'white';
  const n = parseInt(m[1], 16);
  return (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 >= 150 ? '#1e1e1e' : 'white';
};
// Theme colors are saved by name ("red", or "muted-red" for a tone), so they follow the theme and light/dark mode
const THEME_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];
// Tones: the theme color as is, or mixed with gray, white or black (the number is how much theme color is kept)
const TONES = { vibrant: 'Vibrant', muted: 'Muted', pastel: 'Pastel', deep: 'Deep', distinct: 'Distinct' };
// The "Distinct" tab: the Okabe-Ito palette, chosen to stay easy to tell apart (including with color blindness).
// Saved as fixed colors, since they only work as a set exactly as designed.
const DISTINCT = {
  '#e69f00': 'Orange', '#56b4e9': 'Sky blue', '#009e73': 'Bluish green', '#f0e442': 'Yellow',
  '#0072b2': 'Blue', '#d55e00': 'Vermillion', '#cc79a7': 'Reddish purple', '#000000': 'Black',
};
const distinctName = (c) => DISTINCT[String(c || '').toLowerCase()];
const TONE_MIX = { muted: ['#808080', 55], pastel: ['white', 45], deep: ['black', 65] };
const THEME_RE = new RegExp('^(?:(' + Object.keys(TONE_MIX).join('|') + ')-)?(' + THEME_COLORS.join('|') + ')$');
const parseTheme = (c) => { const m = THEME_RE.exec(c || ''); return m ? { tone: m[1] || 'vibrant', name: m[2] } : null; };
const themeColor = (tone, name) => (tone === 'vibrant' ? name : tone + '-' + name);
const isThemeColor = (c) => !!parseTheme(c);
const cssColor = (c) => {
  const t = parseTheme(c);
  if (!t) return c;
  const base = 'var(--color-' + t.name + ')';
  const mix = TONE_MIX[t.tone];
  return mix ? 'color-mix(in srgb, ' + base + ' ' + mix[1] + '%, ' + mix[0] + ')' : base;
};
const colorLabel = (c) => {
  const t = parseTheme(c);
  if (!t) return distinctName(c) || 'Custom color';
  const label = (t.tone === 'vibrant' ? '' : TONES[t.tone] + ' ') + t.name;
  return label.charAt(0).toUpperCase() + label.slice(1);
};
// The #hex a color shows as right now (theme colors are looked up from the current theme)
const realColor = (c) => {
  if (!isThemeColor(c)) return c;
  const probe = document.body.createDiv();
  probe.style.display = 'none';
  probe.style.color = cssColor(c);
  const v = getComputedStyle(probe).color;
  probe.remove();
  // "rgb(229, 72, 77)", or "color(srgb 0.9 0.28 0.3)" for mixed tones
  let rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  if (rgb) rgb = rgb.slice(1, 4).map(Number);
  else { const m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v); rgb = m && m.slice(1, 4).map((n) => Math.round(n * 255)); }
  return rgb ? '#' + rgb.map((n) => Math.min(255, n).toString(16).padStart(2, '0')).join('') : '#888888';
};
// The first theme color not already used, so new rows start with a distinct color
const nextColor = (used) => THEME_COLORS.find((c) => !used.includes(c)) || THEME_COLORS[used.length % THEME_COLORS.length];
// A pill's background and readable text color
const pillPaint = (c) => ({ bg: cssColor(c), fg: textOn(realColor(c)) });
const pillText = (el) => ((el.querySelector('.multi-select-pill-content') || el).textContent || '').trim();

// Due-date states, strongest first
const DATE_STATES = ['koh-overdue', 'koh-today', 'koh-soon'];
const ALL_CLASSES = [...DATE_STATES, 'koh-rule'];
const MARK = 'koh-hl'; // on every colored card/row, so styles can target them all at once

const OPS = {
  is: 'is',
  isNot: 'is not',
  isAnyOf: 'is any of',
  contains: 'contains',
  gt: 'is greater than',
  lt: 'is less than',
  isEmpty: 'is empty',
  notEmpty: 'is not empty',
};
const NO_VALUE = new Set(['isEmpty', 'notEmpty']);

// Badge text for a due date, given days from today (negative = past)
const days = (n) => n + (n === 1 ? ' day' : ' days');
const badgeText = (d) => (d < 0 ? 'Overdue: ' + days(-d) : d === 0 ? 'Due: Today' : d === 1 ? 'Due: Tomorrow' : 'Due: ' + days(d));

// "🏷️ To-Do" -> "todo", so emoji, spaces and case don't matter when comparing text
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const isNum = (v) => v !== '' && !isNaN(Number(v));

// A date as a whole-day number, so comparisons are simple integer checks.
// "2026-04-06" (how Obsidian stores dates) takes a fast path; anything else goes through moment.
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const dayNum = (y, m, d) => Date.UTC(y, m, d) / 86400000;
const toDay = (v) => {
  const str = String(v).trim();
  const m = ISO_DAY.exec(str);
  if (m) return dayNum(+m[1], +m[2] - 1, +m[3]);
  if (!str || isNum(str)) return null;
  const d = moment(str, [moment.ISO_8601, 'MM/DD/YYYY'], true);
  return d.isValid() ? dayNum(d.year(), d.month(), d.date()) : null;
};
const todayNum = () => { const n = new Date(); return dayNum(n.getFullYear(), n.getMonth(), n.getDate()); };

// Which bases a rule applies to, by base name
const parseScope = (list) => (Array.isArray(list) ? list : []).map(norm).filter(Boolean);
const inScope = (scope, where) => !scope.length || (!!where && scope.includes(where.base));
const isBadge = (n) => n.nodeType === 1 && n.classList.contains('koh-badge');
const baseName = (path) => String(path || '').replace(/^.*\//, '').replace(/\.base$/i, '');

const getProp = (fm, name) => {
  if (!fm) return undefined;
  const key = Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : fm[key];
};

// Turn a condition row ({ prop, op, value }) into a fast test for a note's properties
const compile = (c) => {
  const prop = String(c.prop || '').trim();
  if (!prop) return null;
  const op = OPS[c.op] ? c.op : 'is';
  const raw = String(c.value == null ? '' : c.value).trim();
  const want = norm(raw);
  const anyOf = splitList(raw).map(norm);
  const num = isNum(raw) ? Number(raw) : null;
  const day = num === null ? toDay(raw) : null;
  // Numbers compare as numbers, dates as dates, everything else as text
  const eq = (v) => (num !== null && isNum(v) ? Number(v) === num : norm(v) === want);
  const diff = (v) => {
    if (num !== null) return isNum(v) ? Number(v) - num : null;
    if (day !== null) { const d = toDay(v); return d === null ? null : d - day; }
    return null;
  };
  return (fm) => {
    const vals = asArray(getProp(fm, prop)).map((v) => String(v).trim()).filter((v) => v !== '');
    switch (op) {
      case 'isEmpty': return vals.length === 0;
      case 'notEmpty': return vals.length > 0;
      case 'is': return vals.some(eq);
      case 'isNot': return !vals.some(eq);
      case 'isAnyOf': return vals.some((v) => anyOf.includes(norm(v)));
      case 'contains': return want !== '' && vals.some((v) => norm(v).includes(want));
      case 'gt': return vals.some((v) => { const x = diff(v); return x !== null && x > 0; });
      case 'lt': return vals.some((v) => { const x = diff(v); return x !== null && x < 0; });
    }
    return false;
  };
};

module.exports = class BasesKanbanCardColors extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data);
    for (const k of ['filters', 'rules', 'pillColors']) if (!Array.isArray(this.settings[k])) this.settings[k] = [];
    if (!Array.isArray(this.settings.views)) this.settings.views = [...DEFAULTS.views];
    if (!this.settings.collapsed || typeof this.settings.collapsed !== 'object') this.settings.collapsed = {};
    this.index = null;
    this.ctx = null; // prepared settings, rebuilt when settings or the date change
    this.pillMap = null; // prepared pill colors, rebuilt when settings change
    this.styleCache = new Map(); // board + note -> color decision, cleared when notes or settings change
    // Watched elements: a Bases tab, a base embedded in a note, or a note's Properties panel
    this.watched = new Map();
    this.boardInfo = new Map(); // watched element -> what it is (Bases tab, embed or Properties panel)
    this.applyColors();
    this.addSettingTab(new KohSettingTab(this.app, this));
    this.addCommand({
      id: 'toggle-card-coloring',
      name: 'Turn card/row coloring on or off',
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        this.saveSettings();
        this.scanAll(); // apply right away instead of after the usual pause
        new Notice(this.settings.enabled ? 'Card/row coloring on' : 'Card/row coloring off');
      },
    });

    this.refresh = debounce(() => this.scanAll(), 150, true);
    this.resync = debounce(() => this.syncBoards(), 100, true);
    // Settings changes show on screen instantly; the file on disk is written once you stop adjusting
    this.saveToDisk = debounce(() => this.saveData(this.settings), 500, true);

    const reindex = () => { this.index = null; this.styleCache.clear(); this.refresh(); };
    this.app.workspace.onLayoutReady(() => {
      // Listen for file changes only after startup, when Obsidian announces every existing file as "created"
      this.registerEvent(this.app.vault.on('create', reindex));
      this.registerEvent(this.app.vault.on('delete', reindex));
      this.registerEvent(this.app.vault.on('rename', reindex));
      this.syncBoards();
    });
    // A note's properties changed: forget only that note's saved color
    // (Kanban/Cards remember notes by name, tables/lists by path)
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      const byName = '\n' + file.basename, byPath = '\n' + file.path;
      for (const k of this.styleCache.keys()) if (k.endsWith(byName) || k.endsWith(byPath)) this.styleCache.delete(k);
      this.refresh();
    }));
    // Boards appear and disappear when tabs, layouts or open notes change
    this.registerEvent(this.app.workspace.on('layout-change', () => this.resync()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.resync()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.resync()));
    // A new theme or light/dark mode changes theme colors, so pills need fresh text colors
    this.registerEvent(this.app.workspace.on('css-change', () => { this.pillMap = null; this.refresh(); }));
    // Re-check every 5 minutes so colors move along after midnight without a reload
    this.registerInterval(window.setInterval(() => { this.syncBoards(); }, 5 * 60 * 1000));
  }

  onunload() {
    this.flushSave();
    for (const obs of this.watched.values()) obs.disconnect();
    this.watched.clear();
    document.querySelectorAll('.' + MARK).forEach((el) => {
      el.classList.remove(MARK, ...ALL_CLASSES);
      el.style.removeProperty('--koh-rule-color');
    });
    document.querySelectorAll('.koh-badge').forEach((el) => el.remove());
    document.querySelectorAll('.koh-has-badge').forEach((el) => { el.removeClass('koh-has-badge'); el.style.removeProperty('--koh-badge-w'); });
    document.querySelectorAll('.koh-positioned').forEach((el) => el.removeClass('koh-positioned'));
    document.querySelectorAll('.koh-pill').forEach((el) => {
      el.removeClass('koh-pill');
      el.style.removeProperty('--koh-pill-bg');
      el.style.removeProperty('--koh-pill-fg');
    });
    document.body.classList.remove('koh-pill-shape', 'koh-style-tint', 'koh-style-border', 'koh-style-stripe');
    for (const v of ['--koh-color', '--koh-today-color', '--koh-soon-color', '--koh-alpha']) document.body.style.removeProperty(v);
  }

  saveSettings() {
    this.ctx = null;
    this.pillMap = null;
    this.styleCache.clear();
    this.applyColors(); // date colors update instantly through CSS variables
    this.refresh(); // recheck cards once adjusting pauses
    this.saveToDisk();
  }

  flushSave() {
    if (this.saveToDisk && this.saveToDisk.run) this.saveToDisk.run();
  }

  applyColors() {
    const s = this.settings;
    const st = document.body.style;
    st.setProperty('--koh-color', cssColor(s.color));
    st.setProperty('--koh-today-color', cssColor(s.todayColor));
    st.setProperty('--koh-soon-color', cssColor(s.soonColor));
    st.setProperty('--koh-alpha', String(s.opacity));
    const b = document.body.classList;
    b.remove('koh-style-tint', 'koh-style-border', 'koh-style-stripe');
    b.add('koh-style-' + (['tint', 'border', 'stripe'].includes(s.highlightStyle) ? s.highlightStyle : 'tint'));
    b.toggle('koh-pill-shape', !!(s.pillsEnabled && s.pillShape));
  }

  // Find every open base (and, for pill colors, note Properties panels) and watch only those parts of the screen
  syncBoards() {
    const targets = new Set();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const root = leaf.view && leaf.view.containerEl;
      if (!root) return;
      if (leaf.view.getViewType() === 'bases') {
        // A Bases tab: watch the whole view so rebuilds (sort, group, filter, switching views) are caught
        targets.add(root);
        this.boardInfo.set(root, { leaf });
      } else {
        // A note with an embedded base: watch just the embed, not the editor
        root.querySelectorAll('.bases-view').forEach((board) => {
          const el = board.closest('.internal-embed, .bases-embed, .cm-embed-block') || board.parentElement;
          targets.add(el);
          this.boardInfo.set(el, { embed: el });
        });
        // The note's Properties panel, for pill colors
        const s = this.settings;
        const props = s.pillsEnabled && s.pillProps ? root.querySelector('.metadata-container') : null;
        if (props) { targets.add(props); this.boardInfo.set(props, { props: true }); }
      }
    });

    for (const [el, obs] of this.watched) {
      if (!targets.has(el) || !el.isConnected) {
        obs.disconnect();
        this.watched.delete(el);
        this.boardInfo.delete(el);
      }
    }
    for (const el of targets) {
      if (this.watched.has(el)) continue;
      const obs = new MutationObserver((muts) => this.onMutations(muts, el));
      obs.observe(el, { childList: true, subtree: true });
      this.watched.set(el, obs);
    }
    // Check right away so a newly opened board is colored without waiting
    this.scanAll();
  }

  // Obsidian reuses the same card boxes while you scroll, swapping new tasks into them.
  // Recolor exactly the cards that changed, right away, before the screen repaints.
  onMutations(muts, el) {
    const cards = new Set();
    const pills = new Set();
    let external = false;
    for (const m of muts) {
      // Skip changes the plugin made itself (adding or updating a badge). Badge removals are not skipped:
      // Obsidian trims extra elements off reused cards while scrolling, and the badge must be put back.
      if (isBadge(m.target) || (m.removedNodes.length === 0 && m.addedNodes.length > 0
        && [...m.addedNodes].every(isBadge))) continue;
      external = true;
      const card = m.target.closest ? m.target.closest(ITEM_SEL) : null;
      if (card) cards.add(card);
      const pill = m.target.closest ? m.target.closest('.multi-select-pill, .value-list-element') : null;
      if (pill) pills.add(pill);
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(ITEM_SEL)) cards.add(n);
        else n.querySelectorAll(ITEM_SEL).forEach((c) => cards.add(c));
        if (n.matches('.multi-select-pill, .value-list-element')) pills.add(n);
        else n.querySelectorAll('.multi-select-pill, .value-list-element').forEach((x) => pills.add(x));
      }
    }
    if (pills.size) {
      const inProps = !!(this.boardInfo.get(el) || {}).props;
      pills.forEach((x) => { if (x.matches(inProps ? PROP_PILL_SEL : PILL_SEL)) this.paintPill(x); });
    }
    if (cards.size) {
      const ctx = this.getContext();
      const where = this.where(el);
      cards.forEach((c) => this.checkCard(c, ctx, where));
    }
    if (external) this.refresh(); // one full pass after things settle, as a safety net
  }

  // Which base a watched board shows, as a normalized name
  where(el) {
    const info = this.boardInfo.get(el);
    if (!info || info.props) return null; // the Properties panel isn't a board
    if (info.leaf) {
      const v = info.leaf.view;
      const st = (info.leaf.getViewState() || {}).state || {};
      return { base: norm(v.file ? v.file.basename : baseName(st.file)) };
    }
    // Embedded board: its source looks like "Task Board.base" or "Task Board.base#View"
    return { base: norm(baseName(String(info.embed.getAttribute('src') || '').split('#')[0])) };
  }

  // Prepared settings, reused between passes; rebuilt when settings change or the day rolls over
  getContext() {
    if (!this.ctx || this.ctx.today !== todayNum()) {
      this.ctx = this.makeContext();
      this.styleCache.clear();
    }
    return this.ctx;
  }

  // Map file names to files (Kanban and Cards show the file name as their title)
  getIndex() {
    if (!this.index) {
      this.index = new Map();
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (!this.index.has(f.basename)) this.index.set(f.basename, []);
        this.index.get(f.basename).push(f);
      }
    }
    return this.index;
  }

  // Settings, conditions and dates, prepared once per pass instead of once per card
  makeContext() {
    const s = this.settings;
    const today = todayNum();
    const soonDays = Math.max(0, parseInt(s.soonDays, 10) || 0);
    const filters = s.filters.map(compile).filter(Boolean); // no conditions = no filter
    const any = s.filterMatch === 'any';
    const dateProps = splitList(s.dateProperties);
    return {
      filter: filters.length ? (fm) => (any ? filters.some((f) => f(fm)) : filters.every((f) => f(fm))) : null,
      dateProps,
      overdueEnabled: s.overdueEnabled !== false,
      todayEnabled: s.todayEnabled,
      soonEnabled: s.soonEnabled,
      today,
      soonLimit: soonDays > 0 ? today + soonDays : null, // null = any future date
      dateScope: parseScope(s.dateScope),
      rules: s.rules
        .map((r) => ({ test: compile(r), color: cssColor(r.color), useFilter: r.useFilter !== false, scope: parseScope(r.scope) }))
        .filter((r) => r.test && r.color),
      rulesFirst: !!s.rulesFirst,
      enabled: s.enabled !== false,
      views: new Set(s.views),
      badge: s.badge !== false,
      // Properties that identify the right note when two share a file name
      lookupProps: [...s.filters, ...s.rules].map((c) => c.prop).filter(Boolean).concat(dateProps),
    };
  }

  // Which note a card/row shows: a link to the file when the view has one, otherwise the file name
  noteOf(item, type) {
    const link = item.querySelector(type === 'list' ? '.bases-list-property .internal-link[data-href]'
      : '[data-property="file.name"] .internal-link[data-href]');
    if (link) return { path: link.getAttribute('data-href') };
    const titleEl = item.querySelector('[data-property="file.name"] .bases-rendered-value');
    const title = titleEl ? titleEl.textContent.trim().replace(/\.md$/i, '') : '';
    return title ? { title } : null;
  }

  frontmatterOf(note, ctx) {
    if (note.path) {
      const f = this.app.vault.getAbstractFileByPath(note.path) || this.app.metadataCache.getFirstLinkpathDest(note.path, '');
      return f ? (this.app.metadataCache.getFileCache(f) || {}).frontmatter : undefined;
    }
    return this.resolveFrontmatter(note.title, ctx);
  }

  resolveFrontmatter(title, ctx) {
    const files = this.getIndex().get(title) || [];
    const fms = files.map((f) => (this.app.metadataCache.getFileCache(f) || {}).frontmatter).filter(Boolean);
    if (fms.length <= 1) return fms[0];
    // Same file name in several folders: prefer the note that has one of the properties we use
    return fms.find((fm) => ctx.lookupProps.some((p) => getProp(fm, p) !== undefined)) || fms[0];
  }

  // The card's due-date class (overdue, today, soon) and its earliest date
  getDateInfo(fm, ctx) {
    let best = DATE_STATES.length; // index into DATE_STATES; lower = stronger
    let earliest = null;
    for (const prop of ctx.dateProps) {
      for (const v of asArray(getProp(fm, prop))) {
        const day = toDay(v);
        if (day === null) continue;
        if (earliest === null || day < earliest) earliest = day;
        if (day < ctx.today) {
          if (ctx.overdueEnabled) best = 0; // overdue always wins
          continue;
        }
        if (ctx.todayEnabled && day === ctx.today) best = Math.min(best, 1);
        else if (ctx.soonEnabled && day > ctx.today && (ctx.soonLimit === null || day <= ctx.soonLimit)) best = Math.min(best, 2);
      }
    }
    return { cls: DATE_STATES[best] || null, earliest };
  }

  // Decide a card's class and (for rules) its color
  getStyle(fm, ctx, where) {
    if (!fm || !ctx.enabled) return null;
    const passes = !ctx.filter || ctx.filter(fm);
    const info = passes && inScope(ctx.dateScope, where) ? this.getDateInfo(fm, ctx) : null;
    const dateCls = info ? info.cls : null;
    const badge = ctx.badge && info && info.earliest !== null ? badgeText(info.earliest - ctx.today) : null;
    let rule = null;
    for (const r of ctx.rules) {
      if (!inScope(r.scope, where)) continue; // rule is limited to other bases
      if ((!r.useFilter || passes) && r.test(fm)) { rule = r; break; } // first matching rule wins
    }
    if (rule && (ctx.rulesFirst || !dateCls)) return { cls: 'koh-rule', color: rule.color, badge };
    return dateCls || badge ? { cls: dateCls, badge } : null;
  }

  scanAll() {
    const ctx = this.getContext();
    for (const el of this.watched.keys()) {
      if (!el.isConnected) { this.resync(); continue; }
      // Skip boards in background tabs; they're checked when you switch to them
      if (!el.isShown()) continue;
      const where = this.where(el);
      el.querySelectorAll(ITEM_SEL).forEach((card) => this.checkCard(card, ctx, where));
      const inProps = !!(this.boardInfo.get(el) || {}).props;
      el.querySelectorAll(inProps ? PROP_PILL_SEL : PILL_SEL).forEach((x) => this.paintPill(x));
    }
  }

  // Pill colors, prepared once: custom colors by "property|value" and by value alone
  getPillMap() {
    if (!this.pillMap) {
      const byProp = new Map();
      const any = new Map();
      for (const c of this.settings.pillColors || []) {
        const v = String(c.value || '').trim().toLowerCase();
        if (!v || !c.color) continue;
        const p = String(c.prop || '').trim().toLowerCase();
        if (p) byProp.set(p + '|' + v, pillPaint(c.color)); else any.set(v, pillPaint(c.color));
      }
      this.pillMap = { byProp, any, auto: new Map() };
    }
    return this.pillMap;
  }

  // Color one pill: a custom color for this property, then any property, then the automatic color
  paintPill(el) {
    const s = this.settings;
    let paint = null;
    const text = s.pillsEnabled ? pillText(el) : '';
    if (text) {
      const m = this.getPillMap();
      const v = text.toLowerCase();
      const holder = el.closest('[data-property], [data-property-key]');
      const prop = holder ? (holder.getAttribute('data-property') || holder.getAttribute('data-property-key') || '')
        .replace(/^note\./, '').toLowerCase() : '';
      paint = (prop && m.byProp.get(prop + '|' + v)) || m.any.get(v) || null;
      if (!paint && s.pillAuto) {
        if (!m.auto.has(text)) { const a = autoColor(text); m.auto.set(text, a && pillPaint(a)); }
        paint = m.auto.get(text);
      }
    }
    // Only touch the pill when its colors actually change
    const st = el.style;
    if (st.getPropertyValue('--koh-pill-bg') === (paint ? paint.bg : '') &&
      st.getPropertyValue('--koh-pill-fg') === (paint ? paint.fg : '')) return;
    if (paint) {
      el.addClass('koh-pill');
      st.setProperty('--koh-pill-bg', paint.bg);
      st.setProperty('--koh-pill-fg', paint.fg);
    } else {
      el.removeClass('koh-pill');
      el.style.removeProperty('--koh-pill-bg');
      el.style.removeProperty('--koh-pill-fg');
    }
  }

  // Color one card/row (Kanban card, Cards card, table row or list item) and give it its badge
  checkCard(card, ctx, where) {
    const type = itemType(card);
    const note = ctx.views.has(type) ? this.noteOf(card, type) : null;
    let style = null;
    if (note) {
      // The same note can be colored differently on different boards, so the board is part of the key
      const key = (where ? where.base : '') + '\n' + (note.path || note.title);
      style = this.styleCache.get(key);
      if (style === undefined) {
        style = this.getStyle(this.frontmatterOf(note, ctx), ctx, where);
        this.styleCache.set(key, style);
      }
    }
    const cls = style ? style.cls : null;
    // Only touch the card when something actually changes, so nothing blinks
    for (const c of ALL_CLASSES) {
      const want = c === cls;
      if (card.classList.contains(c) !== want) card.classList.toggle(c, want);
    }
    if (card.classList.contains(MARK) !== !!cls) card.classList.toggle(MARK, !!cls);
    const color = style && style.color ? style.color : '';
    if (card.style.getPropertyValue('--koh-rule-color') !== color) {
      if (color) card.style.setProperty('--koh-rule-color', color);
      else card.style.removeProperty('--koh-rule-color');
    }
    // Badge ("Due: 3 days"): a card's bottom-right corner, the end of a table row's name cell,
    // or the end of a list line. Only touched when its text changes.
    const host = type === 'table' ? card.querySelector('.bases-td[data-property="file.name"]')
      : type === 'list' ? card.querySelector('.bases-list-item-properties') : card;
    const text = style && style.badge && host ? style.badge : '';
    let badge = host ? host.querySelector(':scope > .koh-badge') : null;
    if (text) {
      if (!badge) {
        badge = host.createDiv({ cls: 'koh-badge' + (type === 'list' ? ' koh-badge-inline' : type === 'table' ? ' koh-badge-cell' : '') });
        // Safeguard: if a future Obsidian update stops positioning cards, keep the badge inside its card
        if (type !== 'list' && getComputedStyle(host).position === 'static') host.addClass('koh-positioned');
      }
      if (badge.textContent !== text) {
        badge.textContent = text;
        // Table cells: keep the note name from running under the badge
        if (type === 'table') { host.addClass('koh-has-badge'); host.style.setProperty('--koh-badge-w', badge.offsetWidth + 10 + 'px'); }
      }
    } else if (badge) {
      badge.remove();
      if (type === 'table') { host.removeClass('koh-has-badge'); host.style.removeProperty('--koh-badge-w'); }
    }
  }
};

// ---------- Settings screen ----------

// Type-to-filter suggestion box attached to a text input
class ListSuggest extends AbstractInputSuggest {
  constructor(app, inputEl, getItems, onPick) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.getItems = getItems;
    this.onPick = onPick;
  }
  getSuggestions(query) {
    return this.getItems(query.trim().toLowerCase()).slice(0, 50);
  }
  renderSuggestion(item, el) {
    el.setText(item);
  }
  selectSuggestion(item) {
    this.inputEl.value = '';
    this.onPick(item);
    this.close();
  }
}

const matches = (items, q) => (q ? items.filter((i) => i.toLowerCase().includes(q)) : items);

class KohSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide() {
    this.plugin.flushSave(); // make sure the last change is written when the settings screen closes
  }

  save() {
    this.plugin.saveSettings();
  }

  // All property names in the vault, with their Obsidian type (date, text, list...)
  getProperties() {
    const out = new Map();
    try {
      const all = this.app.metadataTypeManager.getAllProperties();
      for (const key of Object.keys(all)) out.set(all[key].name || key, all[key].widget || all[key].type || '');
    } catch (e) { /* fall back to reading notes below */ }
    if (!out.size) {
      for (const f of this.app.vault.getMarkdownFiles()) {
        const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
        if (fm) for (const k of Object.keys(fm)) if (!out.has(k)) out.set(k, /^\d{4}-\d{2}-\d{2}/.test(String(fm[k])) ? 'date' : '');
      }
    }
    return out;
  }

  // Every value used for a property across the vault, most common first
  getValues(prop) {
    const counts = new Map();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
      for (const v of asArray(getProp(fm, prop))) {
        const t = String(v).trim();
        if (t) counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  }

  // ----- Building blocks -----

  // A top-level group ("Card colors", "Property/tag colors"): a large heading with an on/off switch.
  // It collapses like a section, and its contents fade while the switch is off.
  group(key, title, desc, isOn, setOn) {
    const el = this.containerEl.createDiv({ cls: 'koh-top' });
    const head = new Setting(el).setName(title).setHeading();
    if (desc) head.setDesc(desc);
    head.settingEl.addClass('koh-top-head');
    const body = el.createDiv({ cls: 'koh-top-body' });
    const fade = () => body.toggleClass('koh-off', !isOn());
    head.addToggle((t) => t.setValue(isOn()).setTooltip('Turn on or off')
      .onChange((v) => { setOn(v); fade(); }));
    fade();
    this.makeCollapsible(el, head, key);
    return body;
  }

  // Clicking a heading collapses or expands its block; the choice is remembered
  makeCollapsible(el, head, key) {
    const s = this.plugin.settings;
    head.settingEl.addClass('koh-section-head');
    const arrow = head.nameEl.createSpan({ cls: 'koh-chevron' });
    head.nameEl.prepend(arrow);
    setIcon(arrow, 'chevron-down');
    const apply = () => el.toggleClass('koh-collapsed', !!s.collapsed[key]);
    apply();
    head.infoEl.addEventListener('click', () => {
      s.collapsed[key] = !s.collapsed[key];
      apply();
      this.plugin.saveToDisk(); // layout only, so no need to recheck cards
    });
  }

  // A collapsible section inside a group: a heading followed by rows sharing one panel
  section(parent, key, title, desc) {
    const el = parent.createDiv({ cls: 'koh-section' });
    const head = new Setting(el).setName(title).setHeading();
    if (desc) head.setDesc(desc);
    this.makeCollapsible(el, head, key);
    // The section's rows share one panel, separated by thin lines
    return el.createDiv({ cls: 'koh-group' });
  }

  // A plain message row, styled like the other rows
  note(parent, text) {
    new Setting(parent).setDesc(text).settingEl.addClass('koh-note');
  }

  addButton(parent, text, onClick) {
    new Setting(parent).addButton((b) => b.setButtonText('+ ' + text).onClick(onClick)).settingEl.addClass('koh-add-row');
  }

  // Pills with a search box
  pillBox(parent, getList, setList, placeholder, getItems) {
    const box = parent.createDiv({ cls: 'multi-select-container koh-pills' });
    const pillsEl = box.createDiv({ cls: 'koh-pill-list' });
    const input = box.createEl('input', { type: 'text', cls: 'multi-select-input koh-pill-input', attr: { placeholder } });

    const values = () => getList();
    const has = (v) => values().some((x) => norm(x) === norm(v));
    const save = (list) => { setList(list); render(); };
    const add = (v) => { v = v.trim(); if (v && !has(v)) save([...values(), v]); };

    const render = () => {
      pillsEl.empty();
      for (const v of values()) {
        const pill = pillsEl.createDiv({ cls: 'multi-select-pill' });
        pill.createDiv({ cls: 'multi-select-pill-content', text: v });
        const x = pill.createDiv({ cls: 'multi-select-pill-remove-button', attr: { 'aria-label': 'Remove' } });
        setIcon(x, 'x');
        x.addEventListener('click', () => save(values().filter((o) => o !== v)));
      }
    };
    render();

    new ListSuggest(this.app, input, (q) => matches(getItems(q).filter((i) => !has(i)), q), add);
    box.addEventListener('click', (e) => { if (e.target === box || e.target === pillsEl) input.focus(); });
    // Enter adds whatever you typed, even if it isn't in the list yet; Backspace in an empty box removes the last pill
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') window.setTimeout(() => { if (input.value.trim()) { add(input.value); input.value = ''; } }, 0);
      if (e.key === 'Backspace' && !input.value && values().length) save(values().slice(0, -1));
    });
    input.addEventListener('focus', () => input.dispatchEvent(new Event('input')));
    return box;
  }

  // A property name box that suggests the vault's property names
  propInput(row, c, lookups, placeholder) {
    const t = new TextComponent(row).setPlaceholder(placeholder).setValue(c.prop || '');
    t.inputEl.addClass('koh-row-prop');
    t.onChange((v) => { c.prop = v.trim(); this.save(); });
    new ListSuggest(this.app, t.inputEl, (q) => matches(lookups.props(), q), (v) => { c.prop = v; t.setValue(v); this.save(); });
    t.inputEl.addEventListener('focus', () => t.inputEl.dispatchEvent(new Event('input')));
  }

  // A value box that suggests values already used for the chosen property
  valueInput(row, c, lookups) {
    const t = new TextComponent(row).setPlaceholder('Value').setValue(c.value || '');
    t.inputEl.addClass('koh-row-value');
    t.onChange((v) => { c.value = v; this.save(); });
    new ListSuggest(this.app, t.inputEl, () => matches(c.prop ? lookups.values(c.prop) : [], t.inputEl.value.trim().toLowerCase()),
      (v) => { c.value = v; t.setValue(v); this.save(); });
    t.inputEl.addEventListener('focus', () => t.inputEl.dispatchEvent(new Event('input')));
  }

  // One rule or filter row, written like a sentence:
  //   rule:   When [Owner] [is] [Kate] -> (color)
  //           [x] Follow the card filter   In [bases]   up down delete
  //   filter: [Status] [is any of] [To-Do x][In Progress x]   delete
  conditionRow(parent, list, i, lookups, isRule) {
    const c = list[i];
    const row = parent.createDiv({ cls: 'setting-item koh-row' });

    const render = () => {
      row.empty();
      if (isRule) row.createSpan({ cls: 'koh-word', text: 'When' });

      this.propInput(row, c, lookups, 'Property');

      const op = new DropdownComponent(row);
      for (const [k, label] of Object.entries(OPS)) op.addOption(k, label);
      op.setValue(OPS[c.op] ? c.op : 'is').onChange((v) => {
        c.op = v;
        this.save();
        render(); // the value box changes shape ("is any of" uses pills, "is empty" has none)
      });

      if (c.op === 'isAnyOf') {
        this.pillBox(row, () => splitList(c.value), (l) => { c.value = l.join(', '); this.save(); }, 'Add a value…',
          (q) => matches(c.prop ? lookups.values(c.prop) : [], q)).addClass('koh-row-pills');
      } else if (!NO_VALUE.has(c.op)) {
        this.valueInput(row, c, lookups);
      }

      if (isRule) {
        row.createSpan({ cls: 'koh-word', text: '→' });
        this.colorPicker(row, () => c.color, (v) => { c.color = v; this.save(); }, 'card');
        // Second line: filter checkbox on the left, move and delete buttons on the right
        const foot = row.createDiv({ cls: 'koh-row-foot' });
        const check = foot.createEl('label', { cls: 'koh-check', attr: { title: 'Only color cards/rows that pass the filter' } });
        const box = check.createEl('input', { type: 'checkbox' });
        box.checked = c.useFilter !== false;
        box.addEventListener('change', () => { c.useFilter = box.checked; this.save(); });
        check.appendText('Follow the filter');
        foot.createSpan({ cls: 'koh-word koh-on', text: 'In' });
        this.scopeBox(foot, c, lookups);

        const tools = foot.createDiv({ cls: 'koh-tools' });
        const move = (to) => { [list[i], list[to]] = [list[to], list[i]]; this.save(); this.display(); };
        new ExtraButtonComponent(tools).setIcon('arrow-up').setTooltip('Move up').setDisabled(i === 0).onClick(() => { if (i > 0) move(i - 1); });
        new ExtraButtonComponent(tools).setIcon('arrow-down').setTooltip('Move down').setDisabled(i === list.length - 1).onClick(() => { if (i < list.length - 1) move(i + 1); });
        new ExtraButtonComponent(tools).setIcon('trash-2').setTooltip('Delete rule').onClick(() => { list.splice(i, 1); this.save(); this.display(); });
      } else {
        const tools = row.createDiv({ cls: 'koh-tools' });
        new ExtraButtonComponent(tools).setIcon('trash-2').setTooltip('Delete condition').onClick(() => { list.splice(i, 1); this.save(); this.display(); });
      }
    };
    render();
  }

  // A color button that opens a row of theme-color swatches, plus "Custom" for any other color.
  // kind 'card' previews a tinted card; 'pill' previews a value pill with readable text.
  colorPicker(parent, get, set, kind) {
    const wrap = parent.createDiv({ cls: 'koh-color koh-color-' + kind });
    // Swatches are plain elements rather than <button>s so themes that restyle buttons leave them alone
    const swatch = (parent, label, onClick) => {
      const el = parent.createDiv({ cls: 'koh-swatch', attr: { role: 'button', tabindex: '0', 'aria-label': label } });
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
      return el;
    };
    let tone = 'vibrant'; // the tone tab being shown
    const btn = swatch(wrap, '', () => {
      if (pop.isShown()) return close();
      const cur = get(); // open on the current color's tab
      tone = parseTheme(cur) ? parseTheme(cur).tone : distinctName(cur) ? 'distinct' : tone;
      render();
      pop.show();
      doc.addEventListener('mousedown', onDown, true);
      doc.addEventListener('keydown', onKey, true);
    });
    const pop = wrap.createDiv({ cls: 'koh-swatches' });
    pop.hide();
    const paint = (el, c) => {
      el.style.setProperty('--koh-c', cssColor(c));
      if (kind === 'pill') el.style.setProperty('--koh-fg', textOn(realColor(c)));
    };
    const doc = wrap.ownerDocument;
    const onDown = (e) => { if (!wrap.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => {
      pop.hide();
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
    };
    const pick = (c) => { set(c); render(); };

    const render = () => {
      const cur = get();
      paint(btn, cur);
      if (kind === 'pill') btn.setText('Aa');
      btn.setAttr('aria-label', colorLabel(cur));
      pop.empty();
      // Tone tabs: Vibrant, Muted, Pastel, Deep, Distinct
      const tabs = pop.createDiv({ cls: 'koh-tones' });
      for (const [key, label] of Object.entries(TONES)) {
        const tab = tabs.createDiv({ cls: 'koh-tone', text: label, attr: { role: 'button', tabindex: '0' } });
        tab.toggleClass('is-active', key === tone);
        const choose = () => { tone = key; render(); };
        tab.addEventListener('click', choose);
        tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      }
      if (tone === 'distinct') pop.createDiv({ cls: 'koh-tone-note', text: 'Colors chosen to stay easy to tell apart, including for color blindness. They stay the same in every theme.' });
      const grid = pop.createDiv({ cls: 'koh-swatch-grid' });
      const colors = tone === 'distinct' ? Object.keys(DISTINCT) : THEME_COLORS.map((name) => themeColor(tone, name));
      for (const c of colors) {
        const sw = swatch(grid, colorLabel(c), () => { pick(c); close(); });
        if (kind === 'pill') sw.setText('Aa');
        paint(sw, c);
        sw.toggleClass('is-selected', String(cur).toLowerCase() === c);
      }
      // Custom: the full color wheel, for anything the theme colors don't cover
      const custom = grid.createEl('label', { cls: 'koh-swatch koh-swatch-custom', attr: { 'aria-label': 'Custom color' } });
      custom.toggleClass('is-selected', !isThemeColor(cur) && !distinctName(cur));
      const input = custom.createEl('input', { type: 'color' });
      input.value = realColor(cur);
      input.addEventListener('input', () => { set(input.value); paint(btn, input.value); });
      input.addEventListener('change', () => { pick(input.value); close(); });
    };

    render();
  }

  // Pills choosing bases. Empty means every base.
  scopeBox(parent, obj, lookups) {
    const box = this.pillBox(parent, () => (Array.isArray(obj.scope) ? obj.scope : []),
      (l) => { obj.scope = l; this.save(); }, 'All bases', (q) => matches(lookups.scopes(), q));
    box.addClass('koh-scope');
    return box;
  }

  // Every base in the vault, by name
  loadScopes() {
    return this.app.vault.getFiles().filter((x) => x.extension === 'base').map((f) => f.basename).sort();
  }

  // ----- The screen -----

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.save();
    const scroll = containerEl.scrollTop; // keep your place when the screen redraws
    containerEl.empty();

    // Read property names and values once per settings screen, not on every keystroke
    let propsCache = null;
    const valueCache = new Map();
    const props = () => propsCache || (propsCache = this.getProperties());
    let scopesCache = null;
    const lookups = {
      scopes: () => scopesCache || (scopesCache = this.loadScopes()),
      props: () => [...props().keys()],
      values: (p) => {
        const k = p.toLowerCase();
        if (!valueCache.has(k)) valueCache.set(k, this.getValues(p));
        return valueCache.get(k);
      },
    };

    // A friendly greeting with today's day, refreshed each time settings open
    containerEl.createDiv({ cls: 'koh-greeting', text: 'Happy ' + moment().format('dddd') + ' 🙂' });

    // ===== Card/row colors =====
    const cards = this.group('cards', 'Card/row colors', 'Color whole cards/rows by due date or by property.',
      () => s.enabled !== false, (v) => { s.enabled = v; save(); });

    // ----- Which view types -----
    const viewsPanel = cards.createDiv({ cls: 'koh-group koh-views-panel' });
    const viewsRow = new Setting(viewsPanel).setName('Color in these views')
      .setDesc('Tag colors work in every view.');
    const chips = viewsRow.controlEl.createDiv({ cls: 'koh-chips' });
    for (const [key, label] of Object.entries(VIEW_TYPES)) {
      const chip = chips.createDiv({ cls: 'koh-chip', text: label, attr: { role: 'button', tabindex: '0', 'aria-pressed': 'false' } });
      const paint = () => {
        const on = s.views.includes(key);
        chip.toggleClass('is-on', on);
        chip.setAttr('aria-pressed', String(on));
      };
      const flip = () => {
        s.views = s.views.includes(key) ? s.views.filter((v) => v !== key) : [...s.views, key];
        paint();
        save();
      };
      chip.addEventListener('click', flip);
      chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      paint();
    }

    // ----- Filter -----
    const filter = this.section(cards, 'filter', 'Which cards/rows can be colored',
      'The filter. Due-date rules always use it; property rules can opt in.');
    // The filter applies whenever it has at least one condition
    if (s.filters.length) {
      const match = new Setting(filter).setName('Color only cards/rows matching');
      match.addDropdown((d) => d.addOption('all', 'all').addOption('any', 'any')
        .setValue(s.filterMatch).onChange((v) => { s.filterMatch = v; save(); }));
      match.controlEl.createSpan({ cls: 'koh-word', text: 'of these conditions' });
    } else {
      this.note(filter, 'No conditions yet, so every card/row can be colored.');
    }
    s.filters.forEach((_, i) => this.conditionRow(filter, s.filters, i, lookups, false));
    this.addButton(filter, 'Add condition', () => {
      s.filters.push({ prop: '', op: 'is', value: '' });
      save();
      this.display();
    });

    // ----- Due-date rules -----
    const dates = this.section(cards, 'dates', 'Rules by due date', 'Color cards/rows by how close a date is.');
    const dateProps = new Setting(dates).setName('Date properties').setDesc('Multiple dates: the earliest one sets the color.');
    dateProps.settingEl.addClass('koh-pill-setting');
    this.pillBox(dateProps.controlEl, () => splitList(s.dateProperties), (l) => { s.dateProperties = l.join(', '); save(); }, 'Add a property…', (q) => {
      const all = props();
      const d = [...all].filter(([, t]) => t === 'date' || t === 'datetime').map(([n]) => n);
      // Show date properties; if what you type isn't one, search all properties instead
      return q && !matches(d, q).length ? [...all.keys()] : d;
    });

    const dateOn = new Setting(dates).setName('Use on these bases').setDesc('Bases that get due-date colors. Empty = all.');
    dateOn.settingEl.addClass('koh-pill-setting');
    this.scopeBox(dateOn.controlEl, { get scope() { return s.dateScope; }, set scope(v) { s.dateScope = v; } }, lookups);

    new Setting(dates)
      .setName('Overdue')
      .setDesc('The date has passed.')
      .addToggle((t) => t.setValue(s.overdueEnabled !== false).onChange((v) => { s.overdueEnabled = v; save(); }))
      .then((st) => this.colorPicker(st.controlEl, () => s.color, (v) => { s.color = v; save(); }, 'card'));
    new Setting(dates)
      .setName('Due today')
      .setDesc('The date is today.')
      .addToggle((t) => t.setValue(s.todayEnabled).onChange((v) => { s.todayEnabled = v; save(); }))
      .then((st) => this.colorPicker(st.controlEl, () => s.todayColor, (v) => { s.todayColor = v; save(); }, 'card'));
    const soon = new Setting(dates).setName('Due soon').setDesc('Set to 0 to include any future date.');
    soon.controlEl.createSpan({ cls: 'koh-word', text: 'in the next' });
    soon.addText((t) => {
      t.inputEl.type = 'number';
      t.inputEl.min = '0';
      t.inputEl.addClass('koh-days');
      t.setValue(String(s.soonDays)).onChange((v) => {
        const n = parseInt(v, 10);
        s.soonDays = Number.isFinite(n) && n >= 0 ? n : 0;
        save();
      });
    });
    soon.controlEl.createSpan({ cls: 'koh-word', text: 'days' });
    soon.addToggle((t) => t.setValue(s.soonEnabled).onChange((v) => { s.soonEnabled = v; save(); }));
    this.colorPicker(soon.controlEl, () => s.soonColor, (v) => { s.soonColor = v; save(); }, 'card');

    new Setting(dates)
      .setName('Show due badge')
      .setDesc('Adds "Due: X days", "Due: Today" or "Overdue: X days" to each card/row.')
      .addToggle((t) => t.setValue(s.badge !== false).onChange((v) => { s.badge = v; save(); }));

    // ----- Property rules -----
    const rules = this.section(cards, 'rules', 'Rules by property', 'Color cards/rows by any property, like a rating or read/unread. First match wins, top to bottom.');
    if (!s.rules.length) this.note(rules, 'No rules yet.');
    s.rules.forEach((_, i) => this.conditionRow(rules, s.rules, i, lookups, true));
    this.addButton(rules, 'Add rule', () => {
      const used = [s.color, s.todayColor, s.soonColor, ...s.rules.map((r) => r.color)];
      s.rules.push({ prop: '', op: 'is', value: '', color: nextColor(used), useFilter: true, scope: [] });
      save();
      this.display();
    });
    new Setting(rules)
      .setName('When a card/row matches both a due-date rule and a property rule')
      .addDropdown((d) => d.addOption('dates', 'Due date wins').addOption('rules', 'Property wins')
        .setValue(s.rulesFirst ? 'rules' : 'dates').onChange((v) => { s.rulesFirst = v === 'rules'; save(); }));

    // ----- Appearance -----
    const look = this.section(cards, 'look', 'Appearance', 'How colored cards/rows look.');
    new Setting(look)
      .setName('Highlight style')
      .setDesc('How colored cards/rows are marked.')
      .addDropdown((d) => d.addOption('tint', 'Tint').addOption('border', 'Border only').addOption('stripe', 'Left stripe')
        .setValue(s.highlightStyle || 'tint').onChange((v) => { s.highlightStyle = v; save(); this.display(); }));
    if ((s.highlightStyle || 'tint') === 'tint') new Setting(look)
      .setName('Highlight strength')
      .setDesc('Background tint for every color. Borders always use the full color.')
      .addSlider((sl) => sl.setLimits(5, 60, 5).setValue(s.opacity).setDynamicTooltip().onChange((v) => { s.opacity = v; save(); }));

    // ===== Property/tag colors =====
    const pillsBody = this.group('pills', 'Property/tag colors', 'Color the value pills in Bases views and note properties, like each client or owner.',
      () => !!s.pillsEnabled, (v) => { s.pillsEnabled = v; save(); this.plugin.resync(); });
    const pl = pillsBody.createDiv({ cls: 'koh-group' });
    new Setting(pl)
      .setName('Automatic colors')
      .setDesc('Every value gets its own color, always the same for the same value.')
      .addToggle((t) => t.setValue(s.pillAuto).onChange((v) => { s.pillAuto = v; save(); }));
    s.pillColors.forEach((c, i) => {
      const row = pl.createDiv({ cls: 'setting-item koh-row' });
      this.propInput(row, c, lookups, 'Any property');
      row.createSpan({ cls: 'koh-word', text: 'value' });
      this.valueInput(row, c, lookups);
      row.createSpan({ cls: 'koh-word', text: '→' });
      this.colorPicker(row, () => c.color, (v) => { c.color = v; save(); }, 'pill');
      const tools = row.createDiv({ cls: 'koh-tools' });
      new ExtraButtonComponent(tools).setIcon('trash-2').setTooltip('Delete color')
        .onClick(() => { s.pillColors.splice(i, 1); save(); this.display(); });
    });
    this.addButton(pl, 'Add custom color', () => {
      s.pillColors.push({ prop: '', value: '', color: nextColor(s.pillColors.map((x) => x.color)) });
      save();
      this.display();
    });
    new Setting(pl)
      .setName('Color properties inside notes')
      .setDesc('Also color these values in the Properties panel at the top of note pages.')
      .addToggle((t) => t.setValue(s.pillProps).onChange((v) => { s.pillProps = v; save(); this.plugin.resync(); }));
    new Setting(pl)
      .setName('Compact pill shape')
      .setDesc('Tighter padding and corners. Off: your theme\'s default pill shape.')
      .addToggle((t) => t.setValue(s.pillShape).onChange((v) => { s.pillShape = v; save(); }));

    containerEl.scrollTop = scroll;
  }
}

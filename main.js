const {
  Plugin, PluginSettingTab, Setting, Notice, AbstractInputSuggest, TextComponent, DropdownComponent, ColorComponent,
  ExtraButtonComponent, setIcon, debounce, moment,
} = require('obsidian');

const DEFAULTS = {
  // Card filter: which cards can be colored at all
  filterEnabled: false,
  filterMatch: 'all', // 'all' or 'any'
  filters: [], // [{ prop, op, value }]
  // Due dates
  dateProperties: 'Due',
  overdueEnabled: true,
  color: '#e5484d', // overdue
  todayEnabled: true,
  todayColor: '#f76b15',
  soonEnabled: true,
  soonColor: '#f5b400',
  soonDays: 3,
  dateScope: [], // bases where due-date colors apply; empty = everywhere
  // Property rules: [{ prop, op, value, color, useFilter, scope }]
  rules: [],
  rulesFirst: false, // false = due dates win over rules
  enabled: true, // master switch, also toggled by a command
  badge: true, // "Due: 3 days" label in the card's bottom-right corner
  highlightStyle: 'tint', // 'tint', 'border' or 'stripe'
  opacity: 15,
};

// Due-date states, strongest first
const DATE_STATES = ['koh-overdue', 'koh-today', 'koh-soon'];
const ALL_CLASSES = [...DATE_STATES, 'koh-rule'];

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
    if (!Array.isArray(this.settings.filters)) this.settings.filters = [];
    if (!Array.isArray(this.settings.rules)) this.settings.rules = [];
    this.index = null;
    this.ctx = null; // prepared settings, rebuilt when settings or the date change
    this.styleCache = new Map(); // card title -> color decision, cleared when notes or settings change
    // Watched elements: a Bases tab's view, or the wrapper around a board embedded in a note
    this.watched = new Map();
    this.boardInfo = new Map(); // watched element -> the Bases tab or embed it belongs to
    this.applyColors();
    this.addSettingTab(new KohSettingTab(this.app, this));
    this.addCommand({
      id: 'toggle-card-coloring',
      name: 'Turn card coloring on or off',
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        this.saveSettings();
        this.scanAll(); // apply right away instead of after the usual pause
        new Notice(this.settings.enabled ? 'Kanban card coloring on' : 'Kanban card coloring off');
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
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      const end = '\n' + file.basename;
      for (const k of this.styleCache.keys()) if (k.endsWith(end)) this.styleCache.delete(k);
      this.refresh();
    }));
    // Boards appear and disappear when tabs, layouts or open notes change
    this.registerEvent(this.app.workspace.on('layout-change', () => this.resync()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.resync()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.resync()));
    // Re-check every 5 minutes so colors move along after midnight without a reload
    this.registerInterval(window.setInterval(() => { this.syncBoards(); }, 5 * 60 * 1000));
  }

  onunload() {
    this.flushSave();
    for (const obs of this.watched.values()) obs.disconnect();
    this.watched.clear();
    document.querySelectorAll(ALL_CLASSES.map((c) => '.' + c).join(',')).forEach((el) => {
      el.classList.remove(...ALL_CLASSES);
      el.style.removeProperty('--koh-rule-color');
    });
    document.querySelectorAll('.koh-badge').forEach((el) => el.remove());
    document.querySelectorAll('.koh-positioned').forEach((el) => el.removeClass('koh-positioned'));
    document.body.classList.remove('koh-style-tint', 'koh-style-border', 'koh-style-stripe');
    for (const v of ['--koh-color', '--koh-today-color', '--koh-soon-color', '--koh-alpha']) document.body.style.removeProperty(v);
  }

  saveSettings() {
    this.ctx = null;
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
    st.setProperty('--koh-color', s.color);
    st.setProperty('--koh-today-color', s.todayColor);
    st.setProperty('--koh-soon-color', s.soonColor);
    st.setProperty('--koh-alpha', String(s.opacity));
    const b = document.body.classList;
    b.remove('koh-style-tint', 'koh-style-border', 'koh-style-stripe');
    b.add('koh-style-' + (['tint', 'border', 'stripe'].includes(s.highlightStyle) ? s.highlightStyle : 'tint'));
  }

  // Find every open Kanban board and watch only those parts of the screen
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
        // A note with an embedded board: watch just the embed, not the editor
        root.querySelectorAll('.bases-kanban-container').forEach((board) => {
          const el = board.closest('.internal-embed, .bases-embed, .cm-embed-block') || board.parentElement;
          targets.add(el);
          this.boardInfo.set(el, { embed: el });
        });
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
    let external = false;
    for (const m of muts) {
      // Skip changes the plugin made itself (adding or updating a badge). Badge removals are not skipped:
      // Obsidian trims extra elements off reused cards while scrolling, and the badge must be put back.
      if (isBadge(m.target) || (m.removedNodes.length === 0 && m.addedNodes.length > 0
        && [...m.addedNodes].every(isBadge))) continue;
      external = true;
      const card = m.target.closest ? m.target.closest('.bases-kanban-card') : null;
      if (card) cards.add(card);
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList.contains('bases-kanban-card')) cards.add(n);
        else n.querySelectorAll('.bases-kanban-card').forEach((c) => cards.add(c));
      }
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
    if (!info) return null;
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

  // Map file names to files (cards show the file name as their title)
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
    const days = Math.max(0, parseInt(s.soonDays, 10) || 0);
    const filters = s.filterEnabled ? s.filters.map(compile).filter(Boolean) : [];
    const any = s.filterMatch === 'any';
    const dateProps = splitList(s.dateProperties);
    return {
      filter: filters.length ? (fm) => (any ? filters.some((f) => f(fm)) : filters.every((f) => f(fm))) : null,
      dateProps,
      overdueEnabled: s.overdueEnabled !== false,
      todayEnabled: s.todayEnabled,
      soonEnabled: s.soonEnabled,
      today,
      soonLimit: days > 0 ? today + days : null, // null = any future date
      dateScope: parseScope(s.dateScope),
      rules: s.rules
        .map((r) => ({ test: compile(r), color: r.color, useFilter: r.useFilter !== false, scope: parseScope(r.scope) }))
        .filter((r) => r.test && r.color),
      rulesFirst: !!s.rulesFirst,
      enabled: s.enabled !== false,
      badge: s.badge !== false,
      // Properties that identify the right note when two share a file name
      lookupProps: [...s.filters, ...s.rules].map((c) => c.prop).filter(Boolean).concat(dateProps),
    };
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
      el.querySelectorAll('.bases-kanban-card').forEach((card) => this.checkCard(card, ctx, where));
    }
  }

  checkCard(card, ctx, where) {
    const titleEl = card.querySelector('[data-property="file.name"] .bases-rendered-value');
    const title = titleEl ? titleEl.textContent.trim() : '';
    let style = null;
    if (title) {
      // The same note can be colored differently on different boards, so the board is part of the key
      const key = (where ? where.base : '') + '\n' + title;
      style = this.styleCache.get(key);
      if (style === undefined) {
        style = this.getStyle(this.resolveFrontmatter(title, ctx), ctx, where);
        this.styleCache.set(key, style);
      }
    }
    const cls = style ? style.cls : null;
    // Only touch the card when something actually changes, so nothing blinks
    for (const c of ALL_CLASSES) {
      const want = c === cls;
      if (card.classList.contains(c) !== want) card.classList.toggle(c, want);
    }
    const color = style && style.color ? style.color : '';
    if (card.style.getPropertyValue('--koh-rule-color') !== color) {
      if (color) card.style.setProperty('--koh-rule-color', color);
      else card.style.removeProperty('--koh-rule-color');
    }
    // Bottom-right badge ("Due: 3 days"); only touched when its text changes
    const text = style && style.badge ? style.badge : '';
    let badge = card.querySelector(':scope > .koh-badge');
    if (text) {
      if (!badge) {
        badge = card.createDiv({ cls: 'koh-badge' });
        // Safeguard: if a future Obsidian update stops positioning cards, keep the badge inside its card
        if (getComputedStyle(card).position === 'static') card.addClass('koh-positioned');
      }
      if (badge.textContent !== text) badge.textContent = text;
    } else if (badge) badge.remove();
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

  // A section: an Obsidian-style heading (optionally with its own controls) followed by rows
  section(title, desc, addControls) {
    const el = this.containerEl.createDiv({ cls: 'koh-section' });
    const head = new Setting(el).setName(title).setHeading();
    if (desc) head.setDesc(desc);
    if (addControls) addControls(head);
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

      const prop = new TextComponent(row).setPlaceholder('Property').setValue(c.prop || '');
      prop.inputEl.addClass('koh-row-prop');
      prop.onChange((v) => { c.prop = v.trim(); this.save(); });
      new ListSuggest(this.app, prop.inputEl, (q) => matches(lookups.props(), q), (v) => { c.prop = v; prop.setValue(v); this.save(); });
      prop.inputEl.addEventListener('focus', () => prop.inputEl.dispatchEvent(new Event('input')));

      const op = new DropdownComponent(row);
      for (const [k, label] of Object.entries(OPS)) op.addOption(k, label);
      op.setValue(OPS[c.op] ? c.op : 'is').onChange((v) => {
        c.op = v;
        this.save();
        render(); // the value box changes shape ("is any of" uses pills, "is empty" has none)
      });

      const suggestValues = (q) => matches(c.prop ? lookups.values(c.prop) : [], q);
      if (c.op === 'isAnyOf') {
        const box = this.pillBox(row, () => splitList(c.value), (l) => { c.value = l.join(', '); this.save(); }, 'Add a value…', suggestValues);
        box.addClass('koh-row-pills');
      } else if (!NO_VALUE.has(c.op)) {
        const val = new TextComponent(row).setPlaceholder('Value').setValue(c.value || '');
        val.inputEl.addClass('koh-row-value');
        val.onChange((v) => { c.value = v; this.save(); });
        new ListSuggest(this.app, val.inputEl, () => suggestValues(val.inputEl.value.trim().toLowerCase()), (v) => { c.value = v; val.setValue(v); this.save(); });
        val.inputEl.addEventListener('focus', () => val.inputEl.dispatchEvent(new Event('input')));
      }

      if (isRule) {
        row.createSpan({ cls: 'koh-word', text: '→' });
        new ColorComponent(row).setValue(c.color).onChange((v) => { c.color = v; this.save(); });
        // Second line: filter checkbox on the left, move and delete buttons on the right
        const foot = row.createDiv({ cls: 'koh-row-foot' });
        const check = foot.createEl('label', { cls: 'koh-check', attr: { title: 'Only color cards that pass the card filter' } });
        const box = check.createEl('input', { type: 'checkbox' });
        box.checked = c.useFilter !== false;
        box.addEventListener('change', () => { c.useFilter = box.checked; this.save(); });
        check.appendText('Follow the card filter');
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

    // ----- Due-date rules -----
    const dates = this.section('Rules by due date', 'Color cards by how close a date is.');
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
      .addColorPicker((c) => c.setValue(s.color).onChange((v) => { s.color = v; save(); }));
    new Setting(dates)
      .setName('Due today')
      .setDesc('The date is today.')
      .addToggle((t) => t.setValue(s.todayEnabled).onChange((v) => { s.todayEnabled = v; save(); }))
      .addColorPicker((c) => c.setValue(s.todayColor).onChange((v) => { s.todayColor = v; save(); }));
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
    soon.addColorPicker((c) => c.setValue(s.soonColor).onChange((v) => { s.soonColor = v; save(); }));

    new Setting(dates)
      .setName('Show due badge')
      .setDesc('Adds "Due: X days", "Due: Today" or "Overdue: X days" to each card\'s corner.')
      .addToggle((t) => t.setValue(s.badge !== false).onChange((v) => { s.badge = v; save(); }));

    // ----- Property rules -----
    const rules = this.section('Rules by property', 'Color cards by any property, like a rating or read/unread. First match wins, top to bottom.');
    if (!s.rules.length) this.note(rules, 'No rules yet.');
    s.rules.forEach((_, i) => this.conditionRow(rules, s.rules, i, lookups, true));
    this.addButton(rules, 'Add rule', () => {
      s.rules.push({ prop: '', op: 'is', value: '', color: '#3e63dd', useFilter: true, scope: [] });
      save();
      this.display();
    });
    new Setting(rules)
      .setName('When a card matches both a due-date rule and a property rule')
      .addDropdown((d) => d.addOption('dates', 'Due date wins').addOption('rules', 'Property wins')
        .setValue(s.rulesFirst ? 'rules' : 'dates').onChange((v) => { s.rulesFirst = v === 'rules'; save(); }));

    // ----- Card filter -----
    const filter = this.section(
      'Which cards can be colored',
      'The card filter. Due-date rules always use it; property rules can opt in.',
      (h) => h.addToggle((t) => t.setValue(s.filterEnabled).setTooltip('Turn the card filter on or off')
        .onChange((v) => { s.filterEnabled = v; save(); this.display(); }))
    );
    if (s.filterEnabled) {
      const match = new Setting(filter).setName('Color only cards matching');
      match.addDropdown((d) => d.addOption('all', 'all').addOption('any', 'any')
        .setValue(s.filterMatch).onChange((v) => { s.filterMatch = v; save(); }));
      match.controlEl.createSpan({ cls: 'koh-word', text: 'of these conditions' });
      if (!s.filters.length) this.note(filter, 'No conditions yet, so every card can be colored.');
      s.filters.forEach((_, i) => this.conditionRow(filter, s.filters, i, lookups, false));
      this.addButton(filter, 'Add condition', () => {
        s.filters.push({ prop: '', op: 'is', value: '' });
        save();
        this.display();
      });
    } else {
      this.note(filter, 'Off: every card can be colored.');
    }

    // ----- Appearance -----
    const look = this.section('Appearance');
    new Setting(look)
      .setName('Color cards')
      .setDesc('Master switch. Also a command: "Turn card coloring on or off".')
      .addToggle((t) => t.setValue(s.enabled !== false).onChange((v) => { s.enabled = v; save(); }));
    new Setting(look)
      .setName('Highlight style')
      .setDesc('How colored cards are marked.')
      .addDropdown((d) => d.addOption('tint', 'Tint').addOption('border', 'Border only').addOption('stripe', 'Left stripe')
        .setValue(s.highlightStyle || 'tint').onChange((v) => { s.highlightStyle = v; save(); this.display(); }));
    if ((s.highlightStyle || 'tint') === 'tint') new Setting(look)
      .setName('Highlight strength')
      .setDesc('Background tint for every color. Borders always use the full color.')
      .addSlider((sl) => sl.setLimits(5, 60, 5).setValue(s.opacity).setDynamicTooltip().onChange((v) => { s.opacity = v; save(); }));

    containerEl.scrollTop = scroll;
  }
}

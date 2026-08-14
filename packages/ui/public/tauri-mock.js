// Full Tauri mock for browser-based visual debugging.
(function () {
  if (window.__TAURI_MOCK_INSTALLED__) return;
  window.__TAURI_MOCK_INSTALLED__ = true;

  // Query-param overrides for visual debugging: ?ui=v1|v2|v3&theme=dark|light
  const qp = new URLSearchParams(window.location.search);
  const uiOverride = qp.get('ui');
  const themeOverride = qp.get('theme');

  const store = {
    data: {
      modernUiEnabled: 'v2',
      theme: 'dark',
      guideTransparent: false,
      layoutSettingsLoaded: true,
      sourceVersion: 'v1',
      sources: [
        {
          id: 'mock-source',
          name: 'Mock Source',
          type: 'xtream',
          enabled: true,
          vod_only: false,
        },
      ],
      settings: {
        modernUiEnabled: uiOverride && ['v1', 'v2', 'v3'].includes(uiOverride) ? uiOverride : 'v2',
        theme: themeOverride === 'light' ? 'light' : 'dark',
        guideTransparent: false,
        v3DefaultMigrated: true,
        layoutSettingsLoaded: true,
      },
    },
    async get(key, fallback) {
      return key in this.data ? this.data[key] : fallback;
    },
    async set(key, value) {
      this.data[key] = value;
    },
    async save() {},
  };

  // ---------------------------------------------------------------------------
  // In-memory SQL database
  // ---------------------------------------------------------------------------
  const now = Date.now();
  const HOUR = 3600 * 1000;
  const dayStart = now - (now % HOUR) - 12 * HOUR;

  function buildChannels() {
    const chans = [];
    for (let i = 1; i <= 12; i++) {
      chans.push({
        num: String(i).padStart(3, '0'),
        name: `Channel ${i}`,
        stream_id: String(10000 + i),
        source_id: 'mock-source',
        icon: '',
        epg_channel_id: `chan${i}.example.com`,
        category_id: 1,
        category_name: 'All',
        category_ids: JSON.stringify([1]),
        is_favorite: i % 4 === 0 ? 1 : 0,
        archive: 0,
        epg_category: null,
      });
    }
    return chans;
  }

  function buildPrograms() {
    const progs = [];
    const nowHour = now - (now % HOUR); // start of current hour
    const start = nowHour - 3 * HOUR;   // 3h in the past, so a program is live now
    for (let c = 1; c <= 12; c++) {
      const chId = `chan${c}.example.com`;
      for (let h = 0; h < 14; h++) {
        progs.push({
          id: c * 1000 + h,
          stream_id: String(10000 + c),
          epg_channel_id: chId,
          title: `Program ${c}-${h}`,
          description: `Description for program ${c}-${h} on channel ${c}.`,
          start: start + h * HOUR,
          end: start + (h + 1) * HOUR,
          category: 'General',
        });
      }
    }
    return progs;
  }

  const channels = buildChannels();
  const programs = buildPrograms();
  const categories = [
    { id: 1, category_id: 1, name: 'All', category_name: 'All', alias: null, order: 0, display_order: 0, hidden: 0, enabled: 1, source_id: 'mock-source' },
    { id: 2, category_id: 2, name: 'Sports', category_name: 'Sports', alias: null, order: 1, display_order: 1, hidden: 0, enabled: 1, source_id: 'mock-source' },
  ];

  class MockDB {
    constructor() {}
    async execute(sql) { return null; }
    async select(sql, params) {
      sql = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      const ret = [];
      if (sql.includes('from channels')) {
        return channels.map((c) => ({ ...c }));
      }
      if (sql.includes('from programs')) {
        return programs.map((p) => ({ ...p }));
      }
      if (sql.includes('from programs_effective')) {
        return programs.map((p) => ({ ...p }));
      }
      if (sql.includes('from categories')) {
        return categories.map((c) => ({ ...c }));
      }
      return ret;
    }
    async insert(sql, params) { return null; }
    async update(sql, params) { return null; }
    async delete(sql, params) { return null; }
  }

  window.__TAURI_MOCK_DB__ = new MockDB();
  const dbInstance = window.__TAURI_MOCK_DB__;

  let eventId = 100;
  const invokeHandlers = {
    get_settings: async () => ({ settings: store.data.settings }),
    load_settings: async () => ({ settings: store.data.settings }),
    'plugin:store|load': async () => 1,
    'plugin:store|get': async (args) => (args && args.key in store.data ? [store.data[args.key], true] : [null, false]),
    'plugin:store|keys': async () => Object.keys(store.data),
    'plugin:store|set': async (args) => { if (args && args.key === 'settings' && args.value) { store.data.settings = { ...store.data.settings, ...args.value }; store.data.settings.modernUiEnabled = args.value.modernUiEnabled !== undefined ? args.value.modernUiEnabled : store.data.settings.modernUiEnabled; store.data.settings.theme = args.value.theme !== undefined ? args.value.theme : store.data.settings.theme; } else if (args && args.key && 'value' in args) { store.data[args.key] = args.value; } return null; },
    'plugin:event|listen': async () => eventId++,
    'plugin:event|unlisten': async () => null,
    'plugin:event|emit': async () => null,
    'plugin:sql|load': async (args) => args?.db || 'sqlite:mock.db',
    'plugin:sql|select': async (args) => dbInstance.select(args.query, args.values || []),
    'plugin:sql|execute': async (args) => { dbInstance.execute(args.query, args.values || []); return [0, 0]; },
    'plugin:sql|insert': async (args) => [0, 0],
    'plugin:sql|update': async (args) => [0, 0],
    'plugin:sql|delete': async (args) => [0, 0],
    'plugin:sql|close': async () => null,
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      window.__tauriMockCallback = cb;
      return 1;
    },
    invoke: async (cmd, args) => {
      console.log('[mock invoke]', cmd);
      if (invokeHandlers[cmd]) return invokeHandlers[cmd](args);
      return null;
    },
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
  };

  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    },
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    listeners: {},
    registerListener: function (event, handler) {
      const id = eventId++;
      this.listeners[id] = { event, handler };
      return id;
    },
    unregisterListener: function (event, id) {
      delete this.listeners[id];
    },
  };

  // @tauri-apps/plugin-sql expects Database.load to return an object with
  // select/execute/insert/update/delete. The app imports it as default.
  window.__TAURI_PLUGIN_SQL__ = {
    load: async () => dbInstance,
  };
  window.__TAURI_PLUGIN_STORE__ = { load: async () => store };
  window.__TAURI_PLUGIN_DIALOG__ = { open: async () => null, save: async () => null };
  window.__TAURI_PLUGIN_FS__ = { readFile: async () => '', writeFile: async () => {} };
  window.__TAURI_PLUGIN_LOG__ = {
    attachConsole: async () => () => {},
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  };
  window.__TAURI_PLUGIN_OPENER__ = { openPath: async () => {} };
  window.__TAURI_WINDOW__ = {
    getCurrentWindow: () => ({
      onCloseRequested: async () => () => {},
      onMoved: async () => () => {},
      onResized: async () => () => {},
      onFocusChanged: async () => () => {},
      minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {},
      startDragging: async () => {},
    }),
  };
  window.Store = { load: async () => store };
  window.Database = { load: async () => dbInstance };
})();

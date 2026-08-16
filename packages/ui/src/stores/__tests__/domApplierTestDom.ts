/**
 * Tracked fake DOM for settingsDomApplier.test.ts.
 *
 * The applier reads `document` dynamically (via root()), so per-test isolation
 * is achieved by re-creating the ENTIRE fake and re-installing it on
 * `globalThis` — no module resets needed (vi.resetModules() would re-evaluate
 * this module and orphan the test's reference).
 *
 * The fake counts every write the applier performs, so idempotency is
 * asserted by "no new writes", not by re-reading values.
 *
 * NOTE: dataset uses explicit Object.defineProperty accessors — Vite's
 * ES-module transform can mangle shorthand get/set syntax in object literals,
 * silently dropping the accessor and turning the write into a plain property
 * assignment (exactly the silent break this fake exists to catch).
 */

export interface TrackedWrites {
  style: number;
  attrs: number;
  classes: number;
  dataset: number;
  fontFace: number;
}

interface TrackedStyle {
  setProperty(prop: string, value: string): void;
  removeProperty(prop: string): void;
  getPropertyValue(prop: string): string;
}

export interface FakeHeadChild {
  id: string;
  innerHTML: string;
  rel?: string;
  href?: string;
  dataset?: Record<string, string>;
  isConnected?: boolean;
  remove(): void;
}

export interface FakeDom {
  document: {
    documentElement: HTMLElement;
    head: {
      children: Array<FakeHeadChild>;
      appendChild(el: FakeHeadChild): void;
      contains(el: FakeHeadChild): boolean;
      removeChild(el: FakeHeadChild): void;
      insertBefore(el: FakeHeadChild, anchor: FakeHeadChild | null): void;
    };
    getElementById(id: string): { id: string; innerHTML: string } | null;
    createElement(tag: string): FakeHeadChild;
    fonts: { load: () => Promise<unknown[]> };
  };
  writes: TrackedWrites;
  properties: Map<string, string>;
  classes: Set<string>;
  attributes: Map<string, string>;
  datasetData: Map<string, string>;
}

export function makeTrackedDocument(): FakeDom {
  const writes: TrackedWrites = { style: 0, attrs: 0, classes: 0, dataset: 0, fontFace: 0 };
  const properties = new Map<string, string>();
  const attributes = new Map<string, string>();
  const classes = new Set<string>();
  const data = new Map<string, string>();

  const style: TrackedStyle = {
    setProperty(prop: string, value: string) {
      if (properties.get(prop) !== value) {
        properties.set(prop, value);
        writes.style++;
      }
    },
    removeProperty(prop: string) {
      if (properties.delete(prop)) writes.style++;
    },
    getPropertyValue(prop: string) {
      return properties.get(prop) ?? '';
    },
  };

  // Proxy-backed dataset. CRITICAL: the applier does `delete el.dataset.oled`
  // when toggling off — on a real DOMStringMap that just clears the value.
  // With configurable accessor properties, `delete` would DESTROY the
  // accessor itself, turning later sets into untracked plain assignments.
  // A Proxy's deleteProperty trap intercepts the delete and clears the value
  // while keeping the trap in place, matching real dataset semantics.
  const datasetTarget: Record<string, string> = {};
  const dataset: Record<string, string> = new Proxy(datasetTarget, {
    get(t, p: string) {
      return data.get(p);
    },
    set(t, p: string, v: string) {
      if (data.get(p) !== v) {
        data.set(p, v);
        writes.dataset++;
      }
      return true;
    },
    deleteProperty(t, p: string) {
      if (data.delete(p)) writes.dataset++;
      return true;
    },
    has(t, p) {
      return data.has(String(p));
    },
    ownKeys() {
      return [...data.keys()];
    },
  });

  const documentElement = {
    style,
    classList: {
      add(...names: string[]) {
        for (const name of names) {
          if (!classes.has(name)) {
            classes.add(name);
            writes.classes++;
          }
        }
      },
      remove(...names: string[]) {
        for (const name of names) {
          if (classes.delete(name)) writes.classes++;
        }
      },
    },
    dataset: dataset as unknown as DOMStringMap,
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      if (attributes.get(name) !== value) {
        attributes.set(name, value);
        writes.attrs++;
      }
    },
  } as unknown as HTMLElement;

  const styleEl = {
    id: '',
    innerHTML: '',
    remove: () => {
      if (document.head.contains(styleEl)) {
        document.head.removeChild(styleEl);
        writes.fontFace++;
      }
    },
  };

  // Generic head child for <link>/<style> — tracks isConnected so the
  // applier's applyUiDesign (which checks link.isConnected before inserting)
  // behaves like the real DOM.
  function makeEl(): FakeHeadChild {
    return {
      id: '',
      innerHTML: '',
      dataset: {} as Record<string, string>,
      isConnected: false,
      remove() {
        if (document.head.contains(this)) {
          document.head.removeChild(this);
          writes.fontFace++;
        }
      },
    };
  }

  const document = {
    documentElement,
    head: {
      children: [] as FakeHeadChild[],
      appendChild(el: FakeHeadChild) {
        if (!this.children.includes(el)) {
          this.children.push(el);
          el.isConnected = true;
          writes.fontFace++;
        }
      },
      contains(el: FakeHeadChild) {
        return this.children.includes(el);
      },
      removeChild(el: FakeHeadChild) {
        this.children = this.children.filter((c) => c !== el);
        el.isConnected = false;
      },
      insertBefore(el: FakeHeadChild, anchor: FakeHeadChild | null) {
        if (this.children.includes(el)) {
          this.removeChild(el);
        }
        const idx = anchor ? this.children.indexOf(anchor) : -1;
        if (idx >= 0) {
          this.children.splice(idx, 0, el);
        } else {
          this.children.push(el);
        }
        el.isConnected = true;
        writes.fontFace++;
      },
    },
    getElementById: (id: string) => (id === 'custom-theme-font-face' && document.head.children.length ? styleEl : null),
    createElement: (tag: string) => (tag === 'style' ? styleEl : makeEl()),
    fonts: { load: () => Promise.resolve([]) },
  };

  return { document, writes, properties, classes, attributes, datasetData: data };
}

/**
 * Re-create the fake and install it on globalThis. The applier reads
 * `document.documentElement` dynamically through root(), so a fresh fake per
 * test gives complete isolation (fresh write counters + maps) without module
 * resets. Call from beforeEach.
 */
export function installFakeDom(): FakeDom {
  const fake = makeTrackedDocument();
  Object.defineProperty(globalThis, 'document', { value: fake.document, configurable: true, writable: true });
  return fake;
}

// getComputedStyle is only used by updateScrollbarHoverColor inside the
// applier's theme section — an empty style makes it fall through the
// luminance guard. Must be installed here (module load) because the applier
// module runs its init() at import time, before the test file's own body.
Object.defineProperty(globalThis, 'getComputedStyle', {
  value: () => ({ getPropertyValue: () => '' }),
  configurable: true,
  writable: true,
});

// Install once at module load so static imports of the applier see a document.
installFakeDom();

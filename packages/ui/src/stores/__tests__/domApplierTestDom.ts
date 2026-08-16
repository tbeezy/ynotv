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

export interface FakeDom {
  document: {
    documentElement: HTMLElement;
    head: {
      children: Array<{ id: string; innerHTML: string }>;
      appendChild(el: { id: string; innerHTML: string }): void;
      contains(el: { id: string; innerHTML: string }): boolean;
      removeChild(el: { id: string; innerHTML: string }): void;
    };
    getElementById(id: string): { id: string; innerHTML: string } | null;
    createElement(tag: string): { id: string; innerHTML: string };
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
      add(name: string) {
        if (!classes.has(name)) {
          classes.add(name);
          writes.classes++;
        }
      },
      remove(name: string) {
        if (classes.delete(name)) writes.classes++;
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

  const document = {
    documentElement,
    head: {
      children: [] as typeof styleEl[],
      appendChild(el: typeof styleEl) {
        if (!this.children.includes(el)) {
          this.children.push(el);
          writes.fontFace++;
        }
      },
      contains(el: typeof styleEl) {
        return this.children.includes(el);
      },
      removeChild(el: typeof styleEl) {
        this.children = this.children.filter((c) => c !== el);
      },
    },
    getElementById: (id: string) => (id === 'custom-theme-font-face' && document.head.children.length ? styleEl : null),
    createElement: () => styleEl,
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

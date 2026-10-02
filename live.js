// Live recalculation loop. Runs headless from index.html as soon as the board is open
// (and also from the panel, guarded by a shared "last tick" stamp so they don't double up).

const LS_PREFIX = 'pi-live:';
const STORAGE_COLLECTION = 'pi-load-live';
const STORAGE_KEY = 'allocationPlaceholderId';
const DEFAULT_INTERVAL_SEC = 20;
const MIN_GAP_MS = 4000; // never tick more often than this, whatever triggers it
const EVENT_DEBOUNCE_MS = 2500;

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(LS_PREFIX + key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable — the app still works, the panel just can't mirror status */
  }
}

let running = false;
let timer = null;
let debounceTimer = null;
let lastAllocSignature = null;

function liveEnabled() {
  return lsGet('enabled', true);
}
function liveIntervalSec() {
  const v = Number(lsGet('intervalSec', DEFAULT_INTERVAL_SEC));
  return v >= 5 ? v : DEFAULT_INTERVAL_SEC;
}

async function getSelectedIds() {
  try {
    const sel = await miro.board.getSelection();
    return new Set(sel.map((i) => i.id));
  } catch (e) {
    return new Set();
  }
}

async function findPlaceholder(snapshot) {
  const store = miro.board.storage.collection(STORAGE_COLLECTION);
  const id = await store.get(STORAGE_KEY);
  if (id) {
    try {
      const item = await miro.board.getById(id);
      if (item) return item;
    } catch (e) {
      /* deleted from the board — fall through to the colour lookup */
    }
  }
  // Adopt a placeholder made earlier (e.g. by the button-based app) rather than create a duplicate.
  const byColor = (snapshot.shapesAll || []).find(
    (s) => String((s.style && s.style.fillColor) || '').toLowerCase() === PLACEHOLDER_COLOR
  );
  return byColor || null;
}

async function createPlaceholder(data) {
  const viewport = await miro.board.viewport.get();
  const shape = await miro.board.createShape({
    content: formatAllocationContent(data),
    shape: 'rectangle',
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
    width: 460,
    height: 320,
    style: {
      fillColor: PLACEHOLDER_COLOR,
      fillOpacity: 1,
      textAlign: 'left',
      textAlignVertical: 'top',
      fontSize: 14,
    },
  });
  await miro.board.storage.collection(STORAGE_COLLECTION).set(STORAGE_KEY, shape.id);
  return shape;
}

function publishStatus(status) {
  lsSet('status', { ...status, at: Date.now() });
}

// One full recalculation. force=true ignores the hidden-tab and min-gap guards (manual button).
async function liveTick(force) {
  if (running) return;
  if (!force) {
    if (!liveEnabled()) return;
    if (document.hidden) return;
    if (Date.now() - lsGet('lastTick', 0) < MIN_GAP_MS) return;
  }
  running = true;
  lsSet('lastTick', Date.now());
  const status = { ok: true };
  try {
    const snapshot = await fetchSnapshot();
    const selectedIds = await getSelectedIds();

    // Load
    try {
      const load = await computeLoad(snapshot);
      const applied = await applyLoad(load, selectedIds);
      status.load = load.map((r) => ({ label: r.label, total: r.total, cap: r.capValue, over: r.overloaded }));
      status.failedWrites = applied.failed;
    } catch (e) {
      status.loadError = e.message;
    }

    // Allocation (only updates an existing placeholder; creating one is an explicit button press)
    try {
      const data = await computeAllocation(snapshot);
      status.alloc = data.results.map((r) => ({ category: r.category, sp: r.sp, pct: r.pct }));
      const placeholder = await findPlaceholder(snapshot);
      status.hasPlaceholder = !!placeholder;
      if (placeholder && !selectedIds.has(placeholder.id)) {
        const signature = JSON.stringify([data.results, data.unmatched, data.brokenConnectors.length]);
        if (force || signature !== lastAllocSignature) {
          // Re-read just before writing so a concurrent move/resize isn't overwritten.
          const fresh = await miro.board.getById(placeholder.id);
          fresh.content = formatAllocationContent(data);
          await fresh.sync();
          lastAllocSignature = signature;
        }
      }
    } catch (e) {
      status.allocError = e.message;
    }
  } catch (e) {
    status.ok = false;
    status.error = e.message;
  } finally {
    running = false;
    publishStatus(status);
  }
}

function scheduleSoon() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => liveTick(false), EVENT_DEBOUNCE_MS);
}

function startLive() {
  clearInterval(timer);
  timer = setInterval(() => liveTick(false), liveIntervalSec() * 1000);
  liveTick(false);
}

// Panel calls this after changing the interval/enabled flag.
function restartLive() {
  startLive();
}

function bindBoardEvents() {
  const ui = miro.board.ui;
  // Tag changes (story points) fire no board event, but a selection change right after editing a
  // card is a good proxy — that, plus the interval timer, keeps the numbers current.
  for (const ev of ['items:create', 'items:delete', 'experimental:items:update', 'selection:update']) {
    try {
      ui.on(ev, scheduleSoon);
    } catch (e) {
      /* event unsupported in this SDK build — the timer still covers it */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleSoon();
  });
}

const ALLOCATION_CATEGORIES = [
  'Стратегический эпик',
  'Эпики поезда (BAU)',
  'Регуляторные требования',
  'Инфраструктурные улучшения',
  'Архитектурные улучшения',
  'Баги и техническая поддержка',
  'Не указано',
];
const LOW_REGULATORY_THRESHOLD = 10; // %
const REGULATORY_CATEGORY = 'Регуляторные требования';

const FEATURE_COLOR = '#2d9bf0';
const STORY_COLOR = '#8fd14f';
const PLACEHOLDER_COLOR = '#c9b3f0';
const BRACKET_RE = /\[(.*?)\]/;

// Miro's internal engine can occasionally throw on ANY board.get() call — even for a type that
// has nothing to do with connectors — when some unrelated connector on the board points at a
// deleted item (e.g. "LineCoreComponent is required for destroyed object 'line'"). It's a
// transient internal-state glitch, not a real absence of data, so one retry usually clears it.
async function safeBoardGet(query) {
  try {
    return await miro.board.get(query);
  } catch (e) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      return await miro.board.get(query);
    } catch (e2) {
      return [];
    }
  }
}

function stripHtml(s) {
  const div = document.createElement('div');
  div.innerHTML = s || '';
  return (div.textContent || div.innerText || '').trim();
}

function rowYRange(shapes, minH, maxH) {
  const cells = shapes.filter(
    (s) => stripHtml(s.content) === '' && s.height && s.height >= minH && s.height <= maxH
  );
  if (!cells.length) return null;
  const yMin = Math.min(...cells.map((c) => c.y - c.height / 2));
  const yMax = Math.max(...cells.map((c) => c.y + c.height / 2));
  return [yMin, yMax];
}

// The Web SDK reports "no parent" as the literal string 'null' (not JS null/undefined).
function realParentId(item) {
  const p = item && item.parentId;
  return p && p !== 'null' ? p : null;
}

// Boards can hold more than one frame (a reference/calendar block alongside the real
// PI-planning grid, loose decorative text with no frame at all, or several teams' frames on
// one board). Anchor everything to whichever frame has the MOST "Итерация ..." headers — the
// real column headers always come as a full set, so they outnumber any stray one-off mention
// elsewhere. Items with no parent are ignored, not treated as a frame.
function findFrameId(texts) {
  const counts = new Map();
  for (const t of texts) {
    if (!stripHtml(t.content).startsWith('Итерация')) continue;
    const pid = realParentId(t);
    if (!pid) continue;
    counts.set(pid, (counts.get(pid) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [pid, count] of counts.entries()) {
    if (count > bestCount) {
      best = pid;
      bestCount = count;
    }
  }
  return best;
}

function filterToFrame(items, frameId) {
  if (!frameId) return items;
  return items.filter((it) => realParentId(it) === frameId);
}

// Feature/Story row boundary anchored on the "Feature"/"Story" row-label shapes (stable across
// teams' boards, unlike exact cell pixel heights or card colors, which teams sometimes
// customize, breaking a height/color-based heuristic). The label Y is roughly each row's
// vertical center, not the seam between rows, and the two rows aren't the same height — so the
// naive midpoint between the two labels lands inside the (tall) Story row. When actual cards are
// available, the real seam is found as the largest gap between consecutive card Y positions in
// the Feature-to-Story span, which reliably falls between the two rows regardless of their
// relative heights or exact colors used.
// Boards often carry a legend/reference panel (card-type swatches, etc.) to the side of the
// actual iteration grid, reusing the same Feature/Story colors and sometimes the same Y range —
// which corrupts both color- and gap-based row detection. The legend sits well outside the
// grid's own horizontal span, so restricting candidate cards to that span filters it out.
function gridXBounds(headerXs) {
  if (headerXs.length < 2) return [-Infinity, Infinity];
  const xs = [...headerXs].sort((a, b) => a - b);
  const spacing = (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
  return [xs[0] - spacing / 2, xs[xs.length - 1] + spacing / 2];
}

function featureStoryRanges(shapes, cards, gridXB) {
  const labelY = (text) => {
    const matches = shapes.filter((s) => stripHtml(s.content) === text).map((s) => s.y);
    return matches.length ? matches.reduce((a, b) => a + b, 0) / matches.length : null;
  };
  const featureY = labelY('Feature');
  const storyY = labelY('Story');
  if (featureY === null || storyY === null) return [null, null];

  let mid = (featureY + storyY) / 2;
  if (cards && cards.length) {
    const inGrid = gridXB ? cards.filter((c) => c.x >= gridXB[0] && c.x <= gridXB[1]) : cards;

    // An occasional card keeps the "wrong" theme color for its actual row (a facilitator's slip,
    // or a color reused for something else) — one such outlier deep in the other row would
    // otherwise anchor the whole boundary there. Only trust a color-coded card as evidence for a
    // row if it also sits closer to that row's own label than to the other one.
    const belongsToFeature = (y) => Math.abs(y - featureY) < Math.abs(y - storyY);

    // Both colors: when this team uses the standard Feature AND Story theme and the two colors'
    // Y-ranges don't overlap, the midpoint between them IS the seam — directly observed.
    const featureColoredYs = inGrid
      .filter((c) => c.style && c.style.cardTheme === FEATURE_COLOR && belongsToFeature(c.y))
      .map((c) => c.y)
      .sort((a, b) => a - b);
    const storyColoredYs = inGrid
      .filter((c) => c.style && c.style.cardTheme === STORY_COLOR && !belongsToFeature(c.y))
      .map((c) => c.y)
      .sort((a, b) => a - b);
    const span = storyY - featureY;
    const ys = inGrid
      .map((c) => c.y)
      .filter((y) => y >= featureY - span / 2 && y <= storyY + span)
      .sort((a, b) => a - b);

    // Feature-color anchor: if this team uses the standard Feature color at all, trust it and
    // ONLY it — the boundary is the midpoint between its highest card and the very next card
    // after it. This does NOT require Story to be any particular color: teams often sub-color
    // Story cards by discipline (backend/frontend/QA/...), so anchoring on Story's lowest card
    // of ONE specific color can land the boundary below other-colored Story cards sitting
    // higher up, wrongly excluding them. Feature stays a single color much more consistently.
    if (featureColoredYs.length) {
      const cutoff = featureColoredYs[featureColoredYs.length - 1];
      const after = ys.find((y) => y > cutoff);
      if (after !== undefined) return [[-Infinity, (cutoff + after) / 2], [(cutoff + after) / 2, Infinity]];
    }
    // Story-color anchor: only used when no Feature-colored card exists at all.
    if (storyColoredYs.length) {
      const cutoff = storyColoredYs[0];
      const before = [...ys].reverse().find((y) => y < cutoff);
      if (before !== undefined) return [[-Infinity, (before + cutoff) / 2], [(before + cutoff) / 2, Infinity]];
    }

    let bestGap = -1;
    let bestMid = mid;
    for (let i = 0; i < ys.length - 1; i++) {
      const gapMid = (ys[i] + ys[i + 1]) / 2;
      if (gapMid < featureY || gapMid > storyY) continue;
      const gap = ys[i + 1] - ys[i];
      if (gap > bestGap) {
        bestGap = gap;
        bestMid = gapMid;
      }
    }
    if (bestGap >= 0) mid = bestMid;
  }
  return [[-Infinity, mid], [mid, Infinity]];
}

const _tagValueCache = new Map();
async function numericTagValue(tagId) {
  if (_tagValueCache.has(tagId)) return _tagValueCache.get(tagId);
  let value = null;
  try {
    const tag = await miro.board.getById(tagId);
    const title = (tag.title || '').trim();
    if (/^\d+$/.test(title)) value = parseInt(title, 10);
  } catch (e) {
    value = null;
  }
  _tagValueCache.set(tagId, value);
  return value;
}

// Story points come from numeric tags on cards (e.g. "1", "2", "3", "5", "8", "13"...).
// A card with several numeric tags counts all of them.
async function getPointsByCard(cards) {
  const pointsByCard = new Map();
  for (const card of cards) {
    let sum = 0;
    for (const tagId of card.tagIds || []) {
      const v = await numericTagValue(tagId);
      if (v !== null) sum += v;
    }
    if (sum > 0) pointsByCard.set(card.id, sum);
  }
  return pointsByCard;
}

function zoneOf(featureRange, storyRange, y) {
  if (y === null || y === undefined) return null;
  if (y >= featureRange[0] && y <= featureRange[1]) return 'feature';
  if (y >= storyRange[0] && y <= storyRange[1]) return 'story';
  return null;
}

function colorZone(color) {
  if (color === FEATURE_COLOR) return 'feature';
  if (color === STORY_COLOR) return 'story';
  return null;
}

// One fetch of everything the Load and Allocation calculations need, so a live tick
// reads the board once instead of once per calculation.
async function fetchSnapshot() {
  _tagValueCache.clear(); // tag titles can be renamed between ticks
  const shapesAll = await safeBoardGet({ type: 'shape' });
  const textsAll = await safeBoardGet({ type: 'text' });
  const cardsAll = await safeBoardGet({ type: 'card' });
  return { shapesAll, textsAll, cardsAll };
}

async function computeAllocation(snapshot) {
  const { shapesAll, textsAll, cardsAll } = snapshot || (await fetchSnapshot());

  const frameId = findFrameId(textsAll);
  const shapes = filterToFrame(shapesAll, frameId);
  const texts = filterToFrame(textsAll, frameId);
  const cards = filterToFrame(cardsAll, frameId);

  const iterHeaderXs = texts.filter((t) => stripHtml(t.content).startsWith('Итерация')).map((t) => t.x);
  const gridXB = gridXBounds(iterHeaderXs);

  let [featureRange, storyRange] = featureStoryRanges(shapes, cards, gridXB);
  if (!featureRange || !storyRange) {
    featureRange = rowYRange(shapes, 850, 950);
    storyRange = rowYRange(shapes, 1500, 3000);
  }
  if (!featureRange || !storyRange) {
    const featureLabelCount = shapes.filter((s) => stripHtml(s.content) === 'Feature').length;
    const storyLabelCount = shapes.filter((s) => stripHtml(s.content) === 'Story').length;
    throw new Error(
      `Не найдены строки "Feature"/"Story" на доске [диагностика: shapesAll=${shapesAll.length}, textsAll=${textsAll.length}, cardsAll=${cardsAll.length}, frameId=${frameId || 'нет'}, shapes(в фрейме)=${shapes.length}, cards(в фрейме)=${cards.length}, меток Feature=${featureLabelCount}, меток Story=${storyLabelCount}]`
    );
  }

  const zone = (y) => zoneOf(featureRange, storyRange, y);

  const pointsByCard = await getPointsByCard(cards);

  let connectors = [];
  try {
    connectors = await miro.board.get({ type: 'connector' });
  } catch (e) {
    connectors = [];
  }
  // cardById is already scoped to this frame's cards, so a connector pointing outside it
  // (a different frame, or a non-card item) is naturally excluded below.
  const cardById = new Map(cards.map((c) => [c.id, c]));

  const featureToStories = new Map();
  const brokenConnectors = [];
  for (const conn of connectors) {
    // A connector pointing at a deleted item can throw when Miro's internal
    // engine touches it (e.g. "LineCoreComponent is required for destroyed
    // object 'line'") — skip that one connector instead of failing the whole calc.
    try {
      const startId = conn.start && conn.start.item;
      const endId = conn.end && conn.end.item;
      if (!startId || !endId) continue;
      const startCard = cardById.get(startId);
      const endCard = cardById.get(endId);

      const startZone =
        zone(startCard && startCard.y) || (startCard && colorZone(startCard.style && startCard.style.cardTheme));
      const endZone =
        zone(endCard && endCard.y) || (endCard && colorZone(endCard.style && endCard.style.cardTheme));

      let featureId = null;
      let storyId = null;
      if (startZone === 'feature' && endZone === 'story') {
        featureId = startId;
        storyId = endId;
      } else if (startZone === 'story' && endZone === 'feature') {
        featureId = endId;
        storyId = startId;
      } else {
        continue;
      }
      if (!featureToStories.has(featureId)) featureToStories.set(featureId, []);
      featureToStories.get(featureId).push(storyId);
    } catch (e) {
      brokenConnectors.push(conn.id || '(unknown id)');
    }
  }

  const categoryTotals = {};
  for (const cat of ALLOCATION_CATEGORIES) categoryTotals[cat] = 0;

  // Ignore parentheses/extra spaces/case when matching bracket text to a known category,
  // e.g. "[Эпики поезда BAU]" and "[Эпики поезда (BAU)]" should both match.
  const normalize = (s) => s.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const normalizedCategories = ALLOCATION_CATEGORIES.map((c) => ({ cat: c, norm: normalize(c) }));

  const unmatchedLabels = new Set();
  const linkedStoryIds = new Set();
  for (const [featureId, storyIds] of featureToStories.entries()) {
    storyIds.forEach((id) => linkedStoryIds.add(id));
    const featureCard = cardById.get(featureId);
    const title = stripHtml((featureCard && featureCard.title) || '');
    const m = BRACKET_RE.exec(title);
    let category = 'Не указано';
    if (m) {
      const bracketText = m[1].trim();
      const normBracket = normalize(bracketText);
      const found = normalizedCategories.find((c) => c.norm === normBracket);
      if (found) {
        category = found.cat;
      } else {
        unmatchedLabels.add(bracketText);
      }
    }
    const spSum = storyIds.reduce((s, id) => s + (pointsByCard.get(id) || 0), 0);
    categoryTotals[category] += spSum;
  }

  for (const card of cards) {
    if (linkedStoryIds.has(card.id)) continue;
    const sp = pointsByCard.get(card.id);
    if (!sp) continue;
    const cardZone = zone(card.y) || colorZone(card.style && card.style.cardTheme);
    if (cardZone === 'story') categoryTotals['Не указано'] += sp;
  }

  const total = Object.values(categoryTotals).reduce((a, b) => a + b, 0);
  const results = ALLOCATION_CATEGORIES.map((cat) => {
    const sp = categoryTotals[cat];
    const pct = total > 0 ? Math.round((sp / total) * 100) : 0;
    return { category: cat, sp, pct };
  });
  return { results, unmatched: [...unmatchedLabels], brokenConnectors };
}

const DIVIDER = '───────────────────';

function formatAllocationContent(data, withStamp = true) {
  const { results, unmatched, brokenConnectors } = data;
  const lines = [
    `<p><span style="font-size:18px">📊 <strong>Аллокация ёмкости</strong></span></p>`,
    `<p><span style="color:#999999">${DIVIDER}</span></p>`,
  ];
  for (const r of results) {
    const low = r.category === REGULATORY_CATEGORY && r.pct < LOW_REGULATORY_THRESHOLD;
    const line = `${low ? '⚠ ' : '• '}${r.category} — <strong>${r.sp} SP</strong> · ${r.pct}%`;
    lines.push(low ? `<p><span style="color:#df0b0b">${line}</span></p>` : `<p>${line}</p>`);
  }
  lines.push(`<p><span style="color:#999999">${DIVIDER}</span></p>`);
  if (unmatched && unmatched.length) {
    const labels = unmatched.map((u) => `"${u}"`).join(', ');
    lines.push(
      `<p><span style="font-size:11px;color:#df0b0b">Не распознано (попало в "Не указано"): ${labels} — проверьте написание категории у фичи.</span></p>`
    );
  }
  if (brokenConnectors && brokenConnectors.length) {
    lines.push(
      `<p><span style="font-size:11px;color:#df0b0b">Пропущено связей (повреждены на доске): ${brokenConnectors.length} — удалите и перерисуйте эти линии между фичей и историей.</span></p>`
    );
  }
  if (withStamp) {
    const now = new Date();
    const stamp = now.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    lines.push(`<p><span style="font-size:10px;color:#888888">Обновлено: ${stamp}</span></p>`);
  }
  return lines.join('');
}

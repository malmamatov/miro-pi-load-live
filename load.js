// Load calculation (story points per iteration vs capacity), split into compute and apply
// so the live loop can skip writes when nothing changed.

async function computeLoad(snapshot) {
  const { shapesAll, textsAll, cardsAll } = snapshot || (await fetchSnapshot());

  const frameId = findFrameId(textsAll);
  const shapes = filterToFrame(shapesAll, frameId);
  const texts = filterToFrame(textsAll, frameId);
  const cards = filterToFrame(cardsAll, frameId);

  const all = [...shapes, ...texts].map((it) => ({
    id: it.id,
    x: it.x,
    y: it.y,
    w: it.width,
    content: stripHtml(it.content),
    type: it.type,
  }));

  const iterHeaders = all
    .filter((it) => it.type === 'text' && it.content.startsWith('Итерация'))
    .sort((a, b) => a.x - b.x);
  if (!iterHeaders.length) {
    throw new Error(
      `Не найдены заголовки итераций на доске [диагностика: textsAll=${textsAll.length}, frameId=${frameId || 'нет'}, texts(в фрейме)=${texts.length}, образцы текста: ${textsAll
        .slice(0, 5)
        .map((t) => JSON.stringify(stripHtml(t.content)))
        .join(', ')}]`
    );
  }

  const centers = iterHeaders.map((it) => it.x);
  const [gridLeft, gridRight] = gridXBounds(centers);
  // First/last column's outer edge is the grid's own boundary, not -/+infinity — otherwise a
  // legend to the left or a trailing PI-summary column leaks its tagged cards into a real iteration.
  const bounds = centers.map((c, i) => [
    i === 0 ? gridLeft : (centers[i - 1] + c) / 2,
    i === centers.length - 1 ? gridRight : (c + centers[i + 1]) / 2,
  ]);

  const labelY = (text) => {
    const m = all.filter((it) => it.type === 'shape' && it.content === text).map((it) => it.y);
    return m.length ? m.reduce((a, b) => a + b, 0) / m.length : null;
  };
  const capacityY = labelY('Емкость');
  const loadY = labelY('Загрузка');
  if (capacityY === null || loadY === null) throw new Error('Не найдены строки "Емкость"/"Загрузка" на доске');

  const circles = all.filter((it) => it.type === 'shape' && it.w && it.w >= 100 && it.w <= 200);
  const nearestCircle = (targetY, left, right) => {
    const cands = circles.filter((c) => c.x >= left && c.x < right);
    if (!cands.length) return null;
    return cands.reduce((best, c) => (Math.abs(c.y - targetY) < Math.abs(best.y - targetY) ? c : best));
  };

  let [, storyRange] = featureStoryRanges(shapes, cards, gridXBounds(centers));
  if (!storyRange) storyRange = rowYRange(shapes, 1500, 3000);
  if (!storyRange) throw new Error('Не найдена строка "Story" на доске');
  const [storyYMin, storyYMax] = storyRange;

  const pointsByCard = await getPointsByCard(cards);
  const markers = cards
    .filter((c) => pointsByCard.has(c.id) && c.y >= storyYMin && c.y <= storyYMax)
    .map((c) => ({ x: c.x, value: pointsByCard.get(c.id) }));

  const results = [];
  for (let i = 0; i < bounds.length; i++) {
    const [left, right] = bounds[i];
    const total = markers.filter((m) => m.x >= left && m.x < right).reduce((s, m) => s + m.value, 0);
    const loadCircle = nearestCircle(loadY, left, right);
    const capCircle = nearestCircle(capacityY, left, right);
    const capValue = capCircle && /^\d+$/.test(capCircle.content) ? parseInt(capCircle.content, 10) : null;
    results.push({
      label: iterHeaders[i].content,
      total,
      capValue,
      overloaded: capValue !== null && total > capValue,
      loadCircleId: loadCircle ? loadCircle.id : null,
    });
  }
  return results;
}

// Writes totals into the "Загрузка" circles. Skips circles that already show the right value/colour
// (no needless writes, no noise in board history) and circles the user currently has selected
// (they may be dragging/editing it — a stale write would fight them). Returns what was done.
async function applyLoad(results, selectedIds) {
  const failed = [];
  let written = 0;
  for (const r of results) {
    if (!r.loadCircleId) continue;
    if (selectedIds && selectedIds.has(r.loadCircleId)) continue;
    try {
      // Re-read right before writing so we never push stale x/y over a concurrent move.
      const item = await miro.board.getById(r.loadCircleId);
      const color = r.overloaded ? '#df0b0b' : '#00a656';
      const same =
        stripHtml(item.content) === String(r.total) &&
        String((item.style && item.style.fillColor) || '').toLowerCase() === color;
      if (same) continue;
      item.content = `<p>${r.total}</p>`;
      item.style.fillColor = color;
      await item.sync();
      written++;
    } catch (e) {
      // e.g. 'LineCoreComponent … destroyed object "line"' from a dangling connector on the shape.
      failed.push(r.label);
    }
  }
  return { written, failed };
}

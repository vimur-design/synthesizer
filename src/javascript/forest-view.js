import { FOREST_RANGES, generateForest } from './forest-model.js'

const NS = 'http://www.w3.org/2000/svg'
const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 400
const NOTE_NAMES = [
  'C',
  'C♯',
  'D',
  'E♭',
  'E',
  'F',
  'F♯',
  'G',
  'A♭',
  'A',
  'B♭',
  'B'
]
const SHAPES = { round: 'Округлая', cone: 'Конус', fan: 'Веер' }
const clone = (value) => structuredClone(value)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
let instanceCount = 0

const GROUPS = [
  {
    id: 'shape',
    name: 'Форма',
    hint: 'Выбери крону и двигай ручки дерева. Длина, толщина и положение ветвей меняют звук.',
    fields: []
  },
  {
    id: 'tone',
    name: 'Тон и резонанс',
    hint: 'Длина ветви задаёт высоту. Свобода строя: 0% — выбранный лад, 100% — частоты по геометрии.',
    fields: [
      ['tuning', 'Центр диапазона', 'note'],
      ['spread', 'Размах высот', 'semitones'],
      ['shift', 'Сдвиг по ступеням', 'degrees'],
      ['inharmonic', 'Свобода строя', 'percent'],
      ['decay', 'Затухание', 'seconds'],
      ['algorithm', 'Характер резонанса', 'percent']
    ]
  },
  {
    id: 'air',
    name: 'Воздух и шум',
    hint: 'Шум питает резонанс ветвей. Ветер сам касается дерева.',
    fields: [
      ['noise', 'Шум', 'percent'],
      ['filter', 'Центр фильтра', 'hz'],
      ['bandwidth', 'Ширина фильтра', 'octaves'],
      ['thru', 'Шум напрямую', 'percent'],
      ['wind', 'Сила ветра', 'percent'],
      ['windSpeed', 'Скорость ветра', 'persecond']
    ]
  },
  {
    id: 'rain',
    name: 'Дождь и выход',
    hint: 'Дождь ударяет по ветвям. Поле выбирает область высот и ширину дождя: слева низкие голоса, справа высокие.',
    fields: [
      ['rain', 'Сила дождя', 'percent'],
      ['rainSpeed', 'Капли в секунду', 'persecond'],
      ['rainCenter', 'Центр дождя', 'percent'],
      ['rainSpread', 'Ширина дождя', 'percent'],
      ['lowCut', 'Нижняя граница', 'hz'],
      ['highCut', 'Верхняя граница', 'hz'],
      ['gain', 'Громкость леса', 'percent'],
      ['pan', 'Панорама', 'pan']
    ]
  }
]

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(NS, tag)
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, String(value))
  return node
}

function valueLabel(value, unit) {
  if (unit === 'percent') return `${Math.round(value * 100)}%`
  if (unit === 'hz')
    return value >= 1000
      ? `${(value / 1000).toFixed(1)} кГц`
      : `${Math.round(value)} Гц`
  if (unit === 'note')
    return `${NOTE_NAMES[Math.round(value) % 12]}${Math.floor(value / 12) - 1}`
  if (unit === 'semitones') return `${value > 0 ? '+' : ''}${value} пт`
  if (unit === 'degrees') return `${value > 0 ? '+' : ''}${value} ст`
  if (unit === 'seconds') return `${value.toFixed(1)} с`
  if (unit === 'octaves') return `${value.toFixed(1)} окт`
  if (unit === 'persecond') return `${Number(value.toFixed(2))}/с`
  if (unit === 'pan')
    return Math.abs(value) < 0.005
      ? 'Центр'
      : `${value < 0 ? 'Л' : 'П'} ${Math.round(Math.abs(value) * 100)}%`
  return Number(value.toFixed(2)).toString()
}

export function createForestView(
  container,
  {
    onChange = () => {},
    onPreview = () => {},
    onStrike = () => {},
    onAudition = () => {},
    onError = () => {}
  } = {}
) {
  const prefix = `forest-${++instanceCount}`
  const controller = new AbortController()
  const flashTimers = new Map()
  let forest = null
  let preview = null
  let generated = { trees: [], branches: [] }
  let selectedTreeId = null
  let selectedBranchId = null
  let gesture = null
  let controlEdit = null
  let audition = false
  let playing = false
  let auditionBusy = false
  let muted = false
  let disposed = false
  let activeGroup = 'shape'
  let previewFrame = null
  let pendingPreview = null

  function rangeField(key, label, unit = 'percent', tree = false) {
    const range = FOREST_RANGES[key]
    const id = `${prefix}-${tree ? 'tree-' : ''}${key}`
    const data = tree ? 'data-tree-setting' : 'data-setting'
    return `<div class="forest-control"><div class="forest-control-heading"><label for="${id}">${label}</label><output data-value="${tree ? 'tree-' : ''}${key}" data-unit="${unit}"></output></div><div class="forest-control-inputs"><input id="${id}" type="range" min="${range.min}" max="${range.max}" step="${range.step}" ${data}="${key}"><input type="number" min="${range.min}" max="${range.max}" step="${range.step}" ${data}="${key}" aria-label="${label}: точное значение"></div></div>`
  }

  container.classList.add('forest-studio', 'panel')
  container.setAttribute('aria-label', 'Редактор резонансного леса')
  container.innerHTML = `
    <div class="forest-header"><div><p class="eyebrow">РЕЗОНАНСНЫЙ ЛЕС</p><h2>Выращивай форму. Слушай ветви.</h2><p class="forest-subtitle">Длина, толщина и положение каждой ветви меняют её голос.</p></div><div class="forest-audition-wrap"><button type="button" class="forest-audition" data-action="audition" aria-pressed="false"><span class="forest-audition-dot" aria-hidden="true"></span><span data-audition-label>Слушать лес</span></button><small>Лес отдельно от композиции</small></div></div>
    <div class="forest-tree-toolbar"><div class="forest-tree-tabs" role="group" aria-label="Выбор дерева"></div><div class="forest-tree-actions"><button type="button" data-action="add" class="forest-button">+ Дерево</button><button type="button" data-action="grow" class="forest-button">Вырастить заново</button><button type="button" data-action="mute" class="forest-button" aria-pressed="false">Приглушить дерево</button><button type="button" data-action="delete" class="forest-button forest-delete">Удалить</button></div></div>
    <div class="forest-workspace"><div class="forest-scene-wrap"><svg class="forest-scene" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" preserveAspectRatio="none" role="group" aria-label="Ветви леса. Нажмите на ветвь или выберите её стрелками и сыграйте Enter."><defs><linearGradient id="${prefix}-sky" x2="0" y2="1"><stop offset="0" stop-color="#141d19"/><stop offset="1" stop-color="#263527"/></linearGradient><pattern id="${prefix}-grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#8baf8d" stroke-opacity=".055"/></pattern></defs><rect width="1000" height="400" fill="url(#${prefix}-sky)"/><rect width="1000" height="400" fill="url(#${prefix}-grid)"/><path d="M0 373H1000" stroke="#829778" stroke-opacity=".18"/><g data-branches></g><g data-handles></g><text x="24" y="30" class="forest-scene-caption">КОСНИСЬ ВЕТВИ</text><text x="24" y="391" class="forest-scene-caption forest-scene-caption-bottom">ФОРМА → ВЫСОТА · ТОЛЩИНА → ЗВОН</text></svg><div class="forest-scene-footer"><span data-branch-info>Выбери ветвь, чтобы услышать её голос.</span><span data-branch-count></span></div></div>
      <aside class="forest-tree-inspector"><h3 data-tree-heading>Дерево 1</h3><label class="forest-select-label" for="${prefix}-shape">Форма кроны<select id="${prefix}-shape" data-tree-setting="shape">${Object.entries(
        SHAPES
      )
        .map(([key, name]) => `<option value="${key}">${name}</option>`)
        .join(
          ''
        )}</select></label>${rangeField('density', 'Густота', 'percent', true)}${rangeField('height', 'Высота', 'percent', true)}${rangeField('width', 'Ширина', 'percent', true)}${rangeField('x', 'Положение', 'percent', true)}<p class="forest-help">Верхняя ручка двигает крону и меняет высоту. Боковая — ширину. Escape отменяет перетаскивание.</p></aside>
    </div>
    <div class="forest-sound-tabs" role="tablist" aria-label="Настройки звука">${GROUPS.map((group) => `<button type="button" role="tab" id="${prefix}-tab-${group.id}" aria-controls="${prefix}-panel-${group.id}" aria-selected="${group.id === 'shape'}" tabindex="${group.id === 'shape' ? 0 : -1}" data-group="${group.id}">${group.name}</button>`).join('')}</div>
    <div class="forest-sound-panels">${GROUPS.map((group) => `<section id="${prefix}-panel-${group.id}" role="tabpanel" aria-labelledby="${prefix}-tab-${group.id}" data-panel="${group.id}" ${group.id !== 'shape' ? 'hidden' : ''}><p class="forest-group-hint">${group.hint}</p><div class="forest-sound-layout"><fieldset class="forest-controls-grid"><legend class="forest-sr-only">${group.name}</legend>${group.id === 'tone' ? `<label class="forest-select-label" for="${prefix}-scale">Строй<select id="${prefix}-scale" data-setting="scale"><option value="minor">Минор</option><option value="major">Мажор</option><option value="pentatonic">Пентатоника</option><option value="chromatic">Хроматика</option><option value="free">Свободный</option></select></label><label class="forest-select-label" for="${prefix}-tonic">Тоника<select id="${prefix}-tonic" data-setting="tonic">${NOTE_NAMES.map((name, index) => `<option value="${index}">${name}</option>`).join('')}</select></label>` : ''}${group.fields.map(([key, label, unit]) => rangeField(key, label, unit)).join('')}${group.id === 'air' ? `<label class="forest-pink"><input type="checkbox" data-setting="pink">Розовый шум<small>Мягче в высоких частотах</small></label>` : ''}</fieldset>${group.id === 'rain' ? `<div class="forest-rain-field"><div class="forest-xy-heading"><span>Поле дождя</span><span data-xy-value></span></div><div class="forest-xy-pad" tabindex="0" role="group" aria-label="Поле дождя. Стрелки влево и вправо меняют область высот, вверх и вниз — ширину. Shift увеличивает шаг."><div class="forest-xy-grid"></div><div class="forest-xy-band"></div><div class="forest-xy-point"></div><span class="forest-xy-label">ШИРЕ ↑</span><span class="forest-xy-label forest-xy-label-bottom">НИЗКИЕ ← ГОЛОСА → ВЫСОКИЕ</span></div><p class="forest-help">Перетащи точку. Те же значения доступны в ползунках «Центр» и «Ширина».</p></div>` : ''}</div></section>`).join('')}</div>
    <div class="forest-status"><span data-status role="status">Ручная игра доступна по клику на ветви.</span><span class="forest-key-hint">← → выбор ветви · Enter / пробел — удар</span></div>`

  const $ = (selector) => container.querySelector(selector)
  const $$ = (selector) => [...container.querySelectorAll(selector)]
  const scene = $('.forest-scene')
  const branchLayer = $('[data-branches]')
  const handleLayer = $('[data-handles]')
  const xyPad = $('.forest-xy-pad')
  $('[data-panel="shape"] .forest-sound-layout').replaceChildren(
    $('.forest-tree-inspector')
  )
  const branchElements = new Map()
  const treeButtons = new Map()
  const handles = new Map()

  function report(error) {
    const message =
      typeof error === 'string'
        ? error
        : error?.message || 'Не удалось изменить лес.'
    $('[data-status]').textContent = message
    onError(message)
  }

  function current() {
    return preview || forest
  }
  function discardQueuedPreview() {
    if (previewFrame !== null) cancelAnimationFrame(previewFrame)
    previewFrame = null
    pendingPreview = null
  }
  function sendPreview(value) {
    try {
      Promise.resolve(onPreview(clone(value))).catch(report)
    } catch (error) {
      report(error)
    }
  }
  function queuePreview() {
    pendingPreview = clone(current())
    if (previewFrame !== null) return
    previewFrame = requestAnimationFrame(() => {
      const value = pendingPreview
      previewFrame = null
      pendingPreview = null
      if (value && !disposed) sendPreview(value)
    })
  }
  function selectedTree(value = current()) {
    return value?.trees.find((tree) => tree.id === selectedTreeId)
  }
  function normalizedNumber(key, raw) {
    const range = FOREST_RANGES[key]
    let value = clamp(Number(raw), range.min, range.max)
    value =
      range.min + Math.round((value - range.min) / range.step) * range.step
    return Number(clamp(value, range.min, range.max).toFixed(5))
  }

  function setValue(next, key, value, treeId = null) {
    if (treeId) {
      const tree = next.trees.find((item) => item.id === treeId)
      if (tree) tree[key] = value
    } else {
      next[key] = value
      if (key === 'lowCut') next.lowCut = Math.min(value, next.highCut - 10)
      if (key === 'highCut') next.highCut = Math.max(value, next.lowCut + 10)
    }
  }

  function commit(mutate) {
    if (!forest || disposed) return
    const before = clone(forest)
    const next = clone(forest)
    mutate(next)
    discardQueuedPreview()
    gesture = null
    controlEdit = null
    preview = null
    if (JSON.stringify(next) === JSON.stringify(forest)) {
      sendPreview(forest)
      refresh()
      return
    }
    try {
      forest = clone(next)
      onChange(clone(next))
      refresh()
    } catch (error) {
      forest = before
      sendPreview(forest)
      refresh()
      report(error)
    }
  }

  function applySelection() {
    for (const [id, button] of treeButtons)
      button.setAttribute('aria-pressed', String(id === selectedTreeId))
    for (const [id, group] of branchElements) {
      const branch = generated.branches.find((item) => item.id === id)
      group.classList.toggle('selected', id === selectedBranchId)
      group.classList.toggle('selected-tree', branch?.treeId === selectedTreeId)
      group.setAttribute('tabindex', id === selectedBranchId ? '0' : '-1')
    }
    const branch = generated.branches.find(
      (item) => item.id === selectedBranchId
    )
    const info = $('[data-branch-info]')
    if (branch) {
      info.textContent = `${valueLabel(branch.frequency, 'hz')} · затухание ${valueLabel(branch.decay, 'seconds')} · панорама ${valueLabel(branch.pan, 'pan')}`
      info.dataset.selectedBranch = branch.id
      info.dataset.frequency = String(branch.frequency)
      info.dataset.decay = String(branch.decay)
    } else {
      info.textContent = 'Выбери ветвь, чтобы услышать её голос.'
      delete info.dataset.selectedBranch
      delete info.dataset.frequency
      delete info.dataset.decay
    }
  }

  function drawGeometry() {
    const value = current()
    if (!value) return
    const focusedBranchId =
      document.activeElement?.closest?.('[data-branch-id]')?.dataset.branchId
    generated = generateForest(value)
    const activeIds = new Set(generated.branches.map((branch) => branch.id))
    for (const [id, element] of branchElements) {
      if (!activeIds.has(id)) {
        element.remove()
        branchElements.delete(id)
      }
    }
    if (!activeIds.has(selectedBranchId))
      selectedBranchId =
        generated.branches.find((branch) => branch.treeId === selectedTreeId)
          ?.id ?? null
    for (const branch of generated.branches) {
      let group = branchElements.get(branch.id)
      if (!group) {
        group = svgNode('g', {
          class: 'forest-branch',
          role: 'button',
          'data-branch-id': branch.id,
          tabindex: '-1'
        })
        group.append(
          svgNode('title'),
          svgNode('line', { class: 'forest-branch-visible' }),
          svgNode('line', {
            class: 'forest-branch-hit',
            'vector-effect': 'non-scaling-stroke'
          })
        )
        branchLayer.append(group)
        branchElements.set(branch.id, group)
      }
      const tree = value.trees.find((item) => item.id === branch.treeId)
      group.dataset.treeId = branch.treeId
      group.dataset.frequency = String(branch.frequency)
      group.dataset.decay = String(branch.decay)
      group.dataset.length = String(branch.length)
      group.dataset.thickness = String(branch.thickness)
      group.dataset.x1 = String(branch.x1)
      group.dataset.y1 = String(branch.y1)
      group.dataset.x2 = String(branch.x2)
      group.dataset.y2 = String(branch.y2)
      group.classList.toggle('disabled-tree', !tree?.enabled)
      group.classList.toggle('sounding', flashTimers.has(branch.id))
      const roundedMidi = Math.round(branch.midi)
      const label = `${NOTE_NAMES[roundedMidi % 12]}${Math.floor(roundedMidi / 12) - 1}, ${Math.round(branch.frequency)} Гц. Enter — удар.`
      group.setAttribute('aria-label', label)
      group.firstElementChild.textContent = label
      for (const line of group.querySelectorAll('line')) {
        line.setAttribute('x1', branch.x1 * VIEW_WIDTH)
        line.setAttribute('y1', branch.y1 * VIEW_HEIGHT)
        line.setAttribute('x2', branch.x2 * VIEW_WIDTH)
        line.setAttribute('y2', branch.y2 * VIEW_HEIGHT)
      }
      group
        .querySelector('.forest-branch-visible')
        .setAttribute(
          'stroke-width',
          clamp(
            branch.thickness < 0.05
              ? branch.thickness * VIEW_WIDTH
              : branch.thickness,
            0.85,
            8
          )
        )
    }
    drawHandles()
    applySelection()
    $('[data-branch-count]').textContent =
      `${generated.trees.length} ${generated.trees.length === 1 ? 'дерево' : 'дерева'} · ${generated.branches.length} ветвей`
    if (
      focusedBranchId &&
      activeIds.has(focusedBranchId) &&
      document.activeElement !== branchElements.get(focusedBranchId)
    )
      branchElements.get(focusedBranchId).focus({ preventScroll: true })
  }

  function drawHandles() {
    const tree = selectedTree()
    const branches = generated.branches.filter(
      (branch) => branch.treeId === selectedTreeId
    )
    if (!tree || !branches.length) {
      handleLayer.replaceChildren()
      handles.clear()
      return
    }
    const minY = Math.min(
      ...branches.flatMap((branch) => [branch.y1, branch.y2])
    )
    const maxX = Math.max(
      ...branches.flatMap((branch) => [branch.x1, branch.x2])
    )
    const minX = Math.min(
      ...branches.flatMap((branch) => [branch.x1, branch.x2])
    )
    for (const kind of ['crown', 'width']) {
      let handle = handles.get(kind)
      if (!handle) {
        handle = svgNode('g', {
          class: `forest-crown-handle forest-handle-${kind}`,
          'data-handle': kind,
          role: 'button',
          tabindex: '0',
          'aria-label':
            kind === 'crown'
              ? 'Двигать крону: стрелки меняют положение и высоту'
              : 'Изменить ширину кроны: стрелки влево и вправо'
        })
        handle.append(
          svgNode('circle', { r: '15', class: 'forest-handle-hit' }),
          svgNode('circle', { r: '6', class: 'forest-handle-core' }),
          svgNode('path', {
            d: kind === 'crown' ? 'M-3 0H3M0-3V3' : 'M-3 0H3',
            class: 'forest-handle-mark'
          })
        )
        handleLayer.append(handle)
        handles.set(kind, handle)
      }
      const x = kind === 'crown' ? tree.x : clamp(maxX + 0.018, 0.02, 0.98)
      const y =
        kind === 'crown'
          ? clamp(minY - 0.025, 0.04, 0.89)
          : clamp(minY + 0.15, 0.1, 0.85)
      handle.setAttribute(
        'transform',
        `translate(${x * VIEW_WIDTH} ${y * VIEW_HEIGHT})`
      )
      handle.dataset.treeId = tree.id
      handle.dataset.extent = String(Math.max(0.05, maxX - minX))
    }
  }

  function renderTreeTabs() {
    const value = current()
    const ids = new Set(value.trees.map((tree) => tree.id))
    for (const [id, button] of treeButtons)
      if (!ids.has(id)) {
        button.remove()
        treeButtons.delete(id)
      }
    value.trees.forEach((tree, index) => {
      let button = treeButtons.get(tree.id)
      if (!button) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'forest-tree-tab'
        button.dataset.treeSelect = tree.id
        $('.forest-tree-tabs').append(button)
        treeButtons.set(tree.id, button)
      }
      button.textContent = `Дерево ${index + 1}${tree.enabled ? '' : ' · тихо'}`
      button.setAttribute('aria-pressed', String(tree.id === selectedTreeId))
    })
  }

  function renderControls() {
    const value = current()
    const tree = selectedTree(value)
    if (!value || !tree) return
    for (const input of $$('[data-setting], [data-tree-setting]')) {
      const key = input.dataset.setting || input.dataset.treeSetting
      const entry = input.dataset.treeSetting ? tree[key] : value[key]
      if (input.type === 'checkbox') input.checked = Boolean(entry)
      else if (input !== document.activeElement || !controlEdit)
        input.value = entry
    }
    for (const output of $$('[data-value]')) {
      const key = output.dataset.value
      const unit =
        key === 'shift' && value.scale === 'free'
          ? 'semitones'
          : output.dataset.unit
      output.value = valueLabel(
        key.startsWith('tree-') ? tree[key.slice(5)] : value[key],
        unit
      )
    }
    $('[data-tree-heading]').textContent =
      `Дерево ${value.trees.findIndex((item) => item.id === tree.id) + 1}`
    $(`label[for="${prefix}-shift"]`).textContent =
      value.scale === 'free' ? 'Сдвиг в полутонах' : 'Сдвиг по ступеням'
    $('[data-action="add"]').disabled = value.trees.length >= 3
    $('[data-action="delete"]').disabled = value.trees.length <= 1
    $('[data-action="mute"]').textContent = tree.enabled
      ? 'Приглушить дерево'
      : 'Включить дерево'
    $('[data-action="mute"]').setAttribute(
      'aria-pressed',
      String(!tree.enabled)
    )
    $('[data-action="audition"]').setAttribute(
      'aria-pressed',
      String(audition || playing)
    )
    $('[data-action="audition"]').disabled = auditionBusy || playing
    $('[data-audition-label]').textContent = auditionBusy
      ? 'Запуск…'
      : playing
        ? 'В композиции'
        : audition
          ? 'Остановить лес'
          : 'Слушать лес'
    $('.forest-audition-wrap small').textContent = playing
      ? 'Пауза и Stop — наверху'
      : 'Лес отдельно от композиции'
    container.classList.toggle(
      'forest-playing',
      (audition || playing) && !muted
    )
    container.classList.toggle('forest-muted', muted)
    $('.forest-xy-point').style.left = `${value.rainCenter * 100}%`
    $('.forest-xy-point').style.top = `${(1 - value.rainSpread) * 100}%`
    $('.forest-xy-band').style.left = `${value.rainCenter * 100}%`
    $('.forest-xy-band').style.width = `${Math.max(2, value.rainSpread * 100)}%`
    $('[data-xy-value]').textContent =
      `${Math.round(value.rainCenter * 100)} / ${Math.round(value.rainSpread * 100)}%`
    xyPad.setAttribute(
      'aria-label',
      `Поле дождя: центр ${Math.round(value.rainCenter * 100)}%, ширина ${Math.round(value.rainSpread * 100)}%. Стрелки меняют значения, Shift увеличивает шаг.`
    )
    $('[data-status]').textContent = muted
      ? 'Партия ветвей приглушена. Включи её, чтобы услышать лес.'
      : playing
        ? 'Лес звучит вместе с композицией. Настройки меняют его звук во время игры.'
        : audition
          ? 'Лес звучит: ветер и дождь следуют твоим настройкам.'
          : 'Ручная игра доступна по клику на ветви.'
  }

  function refresh({ geometry = true } = {}) {
    if (!current() || disposed) return
    if (!current().trees.some((tree) => tree.id === selectedTreeId))
      selectedTreeId = current().trees[0]?.id
    renderTreeTabs()
    renderControls()
    if (geometry) drawGeometry()
  }

  function selectBranch(id, { focus = false } = {}) {
    const branch = generated.branches.find((item) => item.id === id)
    if (!branch) return
    selectedTreeId = branch.treeId
    selectedBranchId = branch.id
    renderControls()
    renderTreeTabs()
    drawHandles()
    applySelection()
    if (focus) branchElements.get(id)?.focus({ preventScroll: true })
  }

  function strike(id, velocity = 0.75) {
    if (muted) {
      report('Партия ветвей приглушена. Включи её для ручной игры.')
      return
    }
    const branch = generated.branches.find((item) => item.id === id)
    if (
      !branch ||
      !current().trees.find((tree) => tree.id === branch.treeId)?.enabled
    )
      return
    try {
      Promise.resolve(onStrike(id, velocity)).catch(report)
    } catch (error) {
      report(error)
    }
  }

  function cancelPreview() {
    const activeGesture = gesture
    gesture = null
    controlEdit = null
    preview = null
    discardQueuedPreview()
    if (activeGesture?.element.hasPointerCapture(activeGesture.pointerId))
      activeGesture.element.releasePointerCapture(activeGesture.pointerId)
    if (forest) sendPreview(forest)
    container.classList.remove('forest-dragging')
    refresh()
  }

  container.addEventListener(
    'input',
    (event) => {
      const input = event.target.closest('[data-setting], [data-tree-setting]')
      if (
        !input ||
        input.tagName === 'SELECT' ||
        input.type === 'checkbox' ||
        !forest
      )
        return
      if (input.value === '' || !input.validity.valid) return
      const key = input.dataset.setting || input.dataset.treeSetting
      if (!Number.isFinite(Number(input.value))) return
      controlEdit = {
        input,
        key,
        treeId: input.dataset.treeSetting ? selectedTreeId : null
      }
      preview = clone(forest)
      setValue(
        preview,
        key,
        normalizedNumber(key, input.value),
        controlEdit.treeId
      )
      refresh()
      queuePreview()
    },
    { signal: controller.signal }
  )

  container.addEventListener(
    'change',
    (event) => {
      const input = event.target.closest('[data-setting], [data-tree-setting]')
      if (!input || !forest) return
      const key = input.dataset.setting || input.dataset.treeSetting
      if (
        input.type === 'number' &&
        (input.value === '' || !Number.isFinite(Number(input.value)))
      ) {
        cancelPreview()
        return
      }
      const value =
        input.type === 'checkbox'
          ? input.checked
          : ['shape', 'scale'].includes(key)
            ? input.value
            : normalizedNumber(key, input.value)
      const treeId = input.dataset.treeSetting ? selectedTreeId : null
      commit((next) => setValue(next, key, value, treeId))
    },
    { signal: controller.signal }
  )

  container.addEventListener(
    'focusout',
    (event) => {
      if (controlEdit?.input !== event.target) return
      const { input, key, treeId } = controlEdit
      if (input.value === '' || !input.validity.valid) {
        cancelPreview()
        return
      }
      const value = normalizedNumber(key, input.value)
      commit((next) => setValue(next, key, value, treeId))
    },
    { signal: controller.signal }
  )

  container.addEventListener(
    'click',
    async (event) => {
      const treeButton = event.target.closest('[data-tree-select]')
      if (treeButton) {
        selectedTreeId = treeButton.dataset.treeSelect
        selectedBranchId =
          generated.branches.find((branch) => branch.treeId === selectedTreeId)
            ?.id ?? null
        cancelPreview()
        return
      }
      const groupButton = event.target.closest('[data-group]')
      if (groupButton) {
        showGroup(groupButton.dataset.group)
        return
      }
      const branch = event.target.closest('[data-branch-id]')
      if (branch && !gesture) {
        selectBranch(branch.dataset.branchId)
        strike(branch.dataset.branchId)
        return
      }
      const action = event.target.closest('[data-action]')?.dataset.action
      if (!action || !forest) return
      if (action === 'audition') {
        if (auditionBusy || playing) return
        const target = !audition
        auditionBusy = true
        renderControls()
        try {
          const result = await onAudition(target)
          if (!disposed)
            audition = typeof result === 'boolean' ? result : target
        } catch (error) {
          report(error)
        } finally {
          auditionBusy = false
          if (!disposed) renderControls()
        }
        return
      }
      const treeId = selectedTreeId
      if (action === 'add' && forest.trees.length < 3) {
        const id = `tree-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        selectedTreeId = id
        commit((next) =>
          next.trees.push({
            ...next.trees[0],
            id,
            seed: freshSeed(),
            x: next.trees.length === 1 ? 0.72 : 0.25,
            width: 0.6,
            height: 0.72,
            enabled: true
          })
        )
      } else if (action === 'delete' && forest.trees.length > 1) {
        commit((next) => {
          next.trees = next.trees.filter((tree) => tree.id !== treeId)
        })
      } else if (action === 'grow') {
        commit((next) => {
          next.trees.find((tree) => tree.id === treeId).seed = freshSeed()
        })
      } else if (action === 'mute') {
        commit((next) => {
          const tree = next.trees.find((item) => item.id === treeId)
          tree.enabled = !tree.enabled
        })
      }
    },
    { signal: controller.signal }
  )

  function freshSeed() {
    if (globalThis.crypto?.getRandomValues)
      return crypto.getRandomValues(new Uint32Array(1))[0]
    return Math.floor(Math.random() * 4294967296)
  }

  function showGroup(id, focus = false) {
    activeGroup = id
    for (const button of $$('[data-group]')) {
      const active = button.dataset.group === id
      button.setAttribute('aria-selected', String(active))
      button.tabIndex = active ? 0 : -1
      if (active && focus) button.focus()
    }
    for (const panel of $$('[data-panel]'))
      panel.hidden = panel.dataset.panel !== id
  }

  container.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && (gesture || controlEdit)) {
        event.preventDefault()
        event.stopPropagation()
        cancelPreview()
        return
      }
      if (event.key === 'Enter' && controlEdit?.input === event.target) {
        event.preventDefault()
        event.stopPropagation()
        const { input, key, treeId } = controlEdit
        if (input.value === '' || !input.validity.valid) {
          cancelPreview()
          return
        }
        const value = normalizedNumber(key, input.value)
        commit((next) => setValue(next, key, value, treeId))
        return
      }
      const tab = event.target.closest('[data-group]')
      if (
        tab &&
        ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      ) {
        event.preventDefault()
        event.stopPropagation()
        let index = GROUPS.findIndex((group) => group.id === activeGroup)
        index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? GROUPS.length - 1
              : (index +
                  (event.key === 'ArrowRight' ? 1 : -1) +
                  GROUPS.length) %
                GROUPS.length
        showGroup(GROUPS[index].id, true)
        return
      }
      const handle = event.target.closest('[data-handle]')
      if (handle && event.key.startsWith('Arrow')) {
        event.preventDefault()
        event.stopPropagation()
        const step = event.shiftKey ? 0.05 : 0.01
        const kind = handle.dataset.handle
        const treeId = selectedTreeId
        commit((next) => {
          const tree = next.trees.find((item) => item.id === treeId)
          const key =
            kind === 'width'
              ? 'width'
              : ['ArrowLeft', 'ArrowRight'].includes(event.key)
                ? 'x'
                : 'height'
          const sign = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1
          tree[key] = normalizedNumber(key, tree[key] + step * sign)
        })
        return
      }
      const branch = event.target.closest('[data-branch-id]')
      if (branch) {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat)
            strike(branch.dataset.branchId, event.shiftKey ? 1 : 0.65)
          return
        }
        if (
          [
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Home',
            'End'
          ].includes(event.key)
        ) {
          event.preventDefault()
          event.stopPropagation()
          const branches = generated.branches.filter(
            (item) => item.treeId === selectedTreeId
          )
          let index = branches.findIndex(
            (item) => item.id === branch.dataset.branchId
          )
          index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? branches.length - 1
                : (index +
                    (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) +
                    branches.length) %
                  branches.length
          selectBranch(branches[index].id, { focus: true })
        }
      }
    },
    { signal: controller.signal }
  )

  function startGesture(event, kind, element) {
    if (!forest || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = (kind === 'xy' ? xyPad : scene).getBoundingClientRect()
    const tree = selectedTree(forest)
    gesture = {
      kind,
      pointerId: event.pointerId,
      element,
      bounds,
      startPoint: scenePoint(event.clientX, event.clientY),
      treeId: tree.id,
      tree: clone(tree),
      extent: Number(element.dataset.extent) || 0.25
    }
    preview = clone(forest)
    controlEdit = null
    element.setPointerCapture(event.pointerId)
    element.focus({ preventScroll: true })
    container.classList.add('forest-dragging')
    if (kind === 'xy') moveGesture(event)
  }

  function scenePoint(clientX, clientY) {
    const point = scene.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const matrix = scene.getScreenCTM()
    if (matrix) return point.matrixTransform(matrix.inverse())
    const bounds = scene.getBoundingClientRect()
    return {
      x: ((clientX - bounds.left) / bounds.width) * VIEW_WIDTH,
      y: ((clientY - bounds.top) / bounds.height) * VIEW_HEIGHT
    }
  }

  function moveGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const { bounds, kind } = gesture
    preview = clone(forest)
    if (kind === 'xy') {
      preview.rainCenter = normalizedNumber(
        'rainCenter',
        (event.clientX - bounds.left) / bounds.width
      )
      preview.rainSpread = normalizedNumber(
        'rainSpread',
        1 - (event.clientY - bounds.top) / bounds.height
      )
    } else {
      const tree = preview.trees.find((item) => item.id === gesture.treeId)
      if (!tree) {
        cancelPreview()
        return
      }
      const point = scenePoint(event.clientX, event.clientY)
      const dx = (point.x - gesture.startPoint.x) / VIEW_WIDTH
      const dy = (point.y - gesture.startPoint.y) / VIEW_HEIGHT
      if (kind === 'crown') {
        tree.x = normalizedNumber('x', gesture.tree.x + dx)
        tree.height = normalizedNumber('height', gesture.tree.height - dy * 1.1)
      } else
        tree.width = normalizedNumber(
          'width',
          (gesture.tree.width * (gesture.extent + dx * 2)) / gesture.extent
        )
    }
    refresh({ geometry: kind !== 'xy' })
    queuePreview()
  }

  function finishGesture(event, cancelled = false) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const finished = gesture
    const values = preview
    gesture = null
    container.classList.remove('forest-dragging')
    if (finished.element.hasPointerCapture(event.pointerId))
      finished.element.releasePointerCapture(event.pointerId)
    if (cancelled || !values) {
      cancelPreview()
      return
    }
    if (finished.kind === 'xy')
      commit((next) => {
        next.rainCenter = values.rainCenter
        next.rainSpread = values.rainSpread
      })
    else {
      const changed = values.trees.find((tree) => tree.id === finished.treeId)
      commit((next) => {
        const tree = next.trees.find((item) => item.id === finished.treeId)
        if (tree && changed)
          for (const key of finished.kind === 'crown'
            ? ['x', 'height']
            : ['width'])
            tree[key] = changed[key]
      })
    }
  }

  scene.addEventListener(
    'pointerdown',
    (event) => {
      const handle = event.target.closest('[data-handle]')
      if (handle) startGesture(event, handle.dataset.handle, handle)
    },
    { signal: controller.signal }
  )
  xyPad.addEventListener(
    'pointerdown',
    (event) => startGesture(event, 'xy', xyPad),
    { signal: controller.signal }
  )
  container.addEventListener('pointermove', moveGesture, {
    signal: controller.signal
  })
  container.addEventListener('pointerup', (event) => finishGesture(event), {
    signal: controller.signal
  })
  container.addEventListener(
    'pointercancel',
    (event) => finishGesture(event, true),
    { signal: controller.signal }
  )
  container.addEventListener(
    'lostpointercapture',
    (event) => {
      if (gesture?.pointerId === event.pointerId) finishGesture(event, true)
    },
    { signal: controller.signal }
  )
  xyPad.addEventListener(
    'keydown',
    (event) => {
      if (!event.key.startsWith('Arrow') || !forest) return
      event.preventDefault()
      event.stopPropagation()
      const key = ['ArrowLeft', 'ArrowRight'].includes(event.key)
        ? 'rainCenter'
        : 'rainSpread'
      const sign = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1
      commit((next) => {
        next[key] = normalizedNumber(
          key,
          next[key] + sign * (event.shiftKey ? 0.1 : 0.02)
        )
      })
    },
    { signal: controller.signal }
  )

  return {
    render(
      next,
      {
        audition: nextAudition = false,
        muted: nextMuted = false,
        playing: nextPlaying = false
      } = {}
    ) {
      if (disposed) return
      forest = clone(next)
      audition = nextAudition
      muted = nextMuted
      playing = nextPlaying
      if (!gesture && !controlEdit) preview = null
      refresh()
    },
    flash(branchId) {
      if (disposed) return
      clearTimeout(flashTimers.get(branchId))
      branchElements.get(branchId)?.classList.add('sounding')
      flashTimers.set(
        branchId,
        setTimeout(() => {
          flashTimers.delete(branchId)
          branchElements.get(branchId)?.classList.remove('sounding')
        }, 420)
      )
    },
    dispose() {
      disposed = true
      controller.abort()
      discardQueuedPreview()
      for (const timer of flashTimers.values()) clearTimeout(timer)
      flashTimers.clear()
      gesture = null
      controlEdit = null
      preview = null
      container.replaceChildren()
    }
  }
}

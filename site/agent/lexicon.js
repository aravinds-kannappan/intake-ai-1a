/*
 * lexicon.js — the semantic vocabulary layer.
 *
 * Nothing in here names a control on any particular platform. It scores
 * arbitrary UI text against CONCEPTS (what a control is for) and against the
 * canonical field-type vocabulary (what a palette entry means). All matching
 * is token-based with weights; every score comes back with enough evidence to
 * show a human reviewer why the agent believed it.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});

  function tokenize(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .replace(/[_/&+-]/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  // Concept vocabularies. strong = defining tokens, weak = supporting tokens,
  // neg = tokens that argue this is NOT the control we want.
  const CONCEPTS = {
    visit: { strong: ['visit', 'encounter', 'timepoint', 'appointment'], weak: ['event', 'milestone', 'cycle'], neg: [] },
    schedule: { strong: ['schedule', 'plan', 'timeline', 'flowchart'], weak: ['study', 'design', 'build'], neg: ['patient', 'report', 'subject'] },
    form: { strong: ['form', 'document', 'instrument', 'crf', 'questionnaire'], weak: ['source', 'page', 'assessment'], neg: [] },
    add: { strong: ['add', 'new', 'create'], weak: ['plus', 'insert', 'attach'], neg: ['value', 'page'] },
    save: { strong: ['save', 'commit'], weak: ['apply', 'done', 'update', 'confirm', 'ok', 'keep'], neg: ['template', 'as', 'preview', 'activate', 'publish', 'cancel', 'draft', 'local', 'locally', 'copy', 'sync', 'export'] },
    cancel: { strong: ['cancel', 'discard', 'close'], weak: ['back', 'dismiss'], neg: ['save'] },
    edit: { strong: ['edit', 'design', 'designer', 'builder', 'modify'], weak: ['open', 'configure', 'compose'], neg: ['delete', 'preview'] },
    newVersion: { strong: ['version', 'revise', 'revision', 'amend'], weak: ['new', 'draft', 'create'], neg: ['delete'] },
    remove: { strong: ['delete', 'remove', 'trash', 'detach'], weak: ['clear'], neg: [] },
    name: { strong: ['name', 'title'], weak: ['label'], neg: [] },
    windowStart: { strong: ['start', 'from', 'begin', 'opens'], weak: ['window', 'day', 'first'], neg: ['end'] },
    windowEnd: { strong: ['end', 'until', 'closes'], weak: ['window', 'day', 'last', 'to'], neg: ['start'] },
    repeating: { strong: ['repeating', 'repeat', 'log', 'recurring'], weak: ['multiple', 'many', 'records'], neg: [] },
    required: { strong: ['required', 'mandatory'], weak: ['must'], neg: [] },
    labelInput: { strong: ['label', 'caption'], weak: ['name', 'title', 'text', 'question'], neg: ['placeholder', 'value', 'display'] },
    typeSelect: { strong: ['type', 'kind'], weak: ['element', 'control', 'widget', 'question'], neg: [] },
    min: { strong: ['minimum', 'min', 'lower', 'lowest'], weak: ['floor', 'low'], neg: ['max'] },
    max: { strong: ['maximum', 'max', 'upper', 'highest'], weak: ['ceiling', 'high'], neg: ['min'] },
    units: { strong: ['units', 'unit', 'uom'], weak: ['measure'], neg: [] },
    decimalPlaces: { strong: ['places', 'precision'], weak: ['decimal', 'digits'], neg: [] },
    formula: { strong: ['formula', 'expression', 'calculation', 'computation'], weak: ['derive', 'derived', 'computed', 'compute', 'rule'], neg: [] },
    valueCode: { strong: ['code', 'stored', 'key'], weak: ['value', 'id'], neg: ['label', 'display'] },
    valueLabel: { strong: ['label', 'display', 'shown'], weak: ['text', 'name'], neg: ['code', 'stored'] },
    addValue: { strong: ['value', 'values', 'option', 'options', 'choice', 'choices', 'row', 'item'], weak: ['add', 'new'], neg: ['paste', 'bulk'] },
    valuesSection: { strong: ['values', 'choices', 'codes', 'options'], weak: ['value', 'option', 'choice', 'code', 'list', 'item', 'items'], neg: [] },
    pasteBulk: { strong: ['paste', 'bulk', 'batch'], weak: ['import', 'values'], neg: [] },
    visibility: { strong: ['visibility', 'visible', 'show', 'shown', 'display', 'skip'], weak: ['condition', 'conditional', 'logic', 'rule', 'when', 'hide'], neg: ['hidden'] },
    conditionalMode: { strong: ['when', 'if', 'condition', 'conditional'], weak: ['shown', 'depends', 'rule'], neg: ['always', 'never'] },
    whenField: { strong: ['element', 'field', 'question', 'depends'], weak: ['when', 'control', 'source'], neg: ['value', 'equals'] },
    equalsValue: { strong: ['equals', 'value', 'answer', 'is'], weak: ['when'], neg: ['element', 'field', 'question'] },
    palette: { strong: ['element', 'elements', 'widget', 'widgets', 'control', 'controls', 'toolbox', 'palette', 'component', 'components'], weak: ['field', 'fields', 'question', 'questions', 'library', 'types'], neg: ['import'] },
    back: { strong: ['back', 'return'], weak: ['schedule', 'plan', 'previous'], neg: [] },
    preview: { strong: ['preview'], weak: [], neg: [] },
    activate: { strong: ['activate', 'publish', 'release'], weak: ['live', 'deploy'], neg: ['deactivate'] },
  };

  function scoreConcept(text, conceptName) {
    const concept = CONCEPTS[conceptName];
    if (!concept) throw new Error('unknown concept ' + conceptName);
    const tokens = tokenize(text);
    if (tokens.length === 0) return 0;
    let score = 0;
    for (const t of tokens) {
      if (concept.strong.includes(t)) score += 3;
      else if (concept.weak.includes(t)) score += 1;
      if (concept.neg.includes(t)) score -= 3;
    }
    // Mild brevity preference: "Save" should outrank "Save As Template".
    return score > 0 ? score / (1 + 0.15 * Math.max(0, tokens.length - 2)) : score;
  }

  // Canonical field types scored against a palette entry's visible label.
  const TYPE_LEXICON = {
    text: { strong: ['text', 'textbox', 'string', 'short', 'single', 'answer', 'line'], weak: ['free', 'input'], neg: ['multi', 'area', 'paragraph', 'long', 'number', 'rich', 'list', 'date', 'time'] },
    textarea: { strong: ['multi', 'area', 'paragraph', 'long', 'memo', 'notes', 'comment', 'essay'], weak: ['text', 'textbox', 'line'], neg: ['single', 'short', 'one', 'list', 'pick', 'select'] },
    integer: { strong: ['whole', 'integer', 'int', 'counting'], weak: ['number', 'numeric'], neg: ['decimal', 'float', 'fraction', 'fractional'] },
    decimal: { strong: ['decimal', 'float', 'fraction', 'fractional', 'real'], weak: ['number', 'numeric'], neg: ['whole', 'integer', 'counting'] },
    date: { strong: ['date', 'calendar', 'day'], weak: [], neg: ['time', 'stamp', 'birth'] },
    time: { strong: ['time', 'clock'], weak: [], neg: ['date', 'stamp'] },
    datetime: { strong: ['datetime', 'timestamp', 'stamp'], weak: ['date', 'time'], neg: [] },
    boolean: { strong: ['yes', 'no', 'boolean', 'toggle', 'switch', 'true', 'false'], weak: ['flag'], neg: ['list', 'check'] },
    single_select: { strong: ['dropdown', 'picklist', 'combo', 'select', 'pick', 'pulldown', 'menu'], weak: ['list', 'choice', 'choose', 'one', 'single'], neg: ['multi', 'check', 'radio', 'many', 'several', 'all'] },
    multi_select: { strong: ['multi', 'checklist', 'many', 'several'], weak: ['check', 'list', 'pick', 'select', 'choices', 'all'], neg: ['single', 'one', 'box', 'radio'] },
    radio: { strong: ['radio', 'option', 'exclusive'], weak: ['buttons', 'choice', 'ring'], neg: ['check', 'list', 'multi'] },
    checkbox: { strong: ['checkbox', 'tick', 'box'], weak: ['check', 'single'], neg: ['list', 'multi', 'many', 'group', 'several'] },
    calculated: { strong: ['calculated', 'computed', 'derived', 'formula', 'calculation', 'expression'], weak: ['auto', 'result'], neg: [] },
  };

  function scoreType(entryLabel, canonicalType) {
    const lex = TYPE_LEXICON[canonicalType];
    if (!lex) throw new Error('unknown canonical type ' + canonicalType);
    const tokens = tokenize(entryLabel);
    let score = 0;
    for (const t of tokens) {
      if (lex.strong.includes(t)) score += 3;
      else if (lex.weak.includes(t)) score += 1;
      if (lex.neg.includes(t)) score -= 3;
    }
    // datetime needs both halves; "Date" alone must not win datetime.
    if (canonicalType === 'datetime') {
      const hasDate = tokens.includes('date') || tokens.includes('datetime') || tokens.includes('timestamp') || tokens.includes('stamp');
      const hasTime = tokens.includes('time') || tokens.includes('datetime') || tokens.includes('timestamp') || tokens.includes('stamp');
      if (hasDate && hasTime) score += 4;
      else score -= 2;
    }
    return score;
  }

  /**
   * Rank candidates (objects with a text field extracted by getText) for a
   * concept. Returns [{candidate, score}] sorted best first, positives only.
   */
  function rank(candidates, conceptName, getText) {
    const scored = candidates
      .map((c) => ({ candidate: c, score: scoreConcept(getText(c), conceptName) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored;
  }

  /** Margin-based confidence in [0,1]: how far the best beats the runner-up. */
  function margin(scored) {
    if (scored.length === 0) return 0;
    if (scored.length === 1) return 1;
    const top = scored[0].score;
    const second = scored[1].score;
    if (top <= 0) return 0;
    return Math.max(0, Math.min(1, (top - second) / Math.abs(top)));
  }

  /** Raw token presence check that ignores concept negatives. */
  function hasToken(text, tokens) {
    const own = tokenize(text);
    return tokens.some((t) => own.includes(t));
  }

  function equalsNormalized(a, b) {
    return String(a || '').trim().replace(/\s+/g, ' ').toLowerCase() ===
      String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  NS.lexicon = { tokenize, scoreConcept, scoreType, rank, margin, CONCEPTS, TYPE_LEXICON, equalsNormalized, hasToken };
})();

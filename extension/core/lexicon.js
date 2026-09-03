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
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  /**
   * Fuzzy token match: checks whether a token is a prefix of any word in a
   * list or vice versa, to catch truncations and abbreviations.
   */
  function fuzzyTokenMatch(token, listTokens) {
    for (const lt of listTokens) {
      if (token === lt) return 1.0;
      // Prefix only when the words are almost the same length. Otherwise
      // "question" matches "questionnaire" and a field-delete button is
      // treated as a form-level control.
      const shorter = token.length <= lt.length ? token : lt;
      const longer = token.length <= lt.length ? lt : token;
      if (shorter.length >= 4 && longer.startsWith(shorter) && (longer.length - shorter.length) <= 2) return 0.7;
    }
    return 0;
  }

  // Concept vocabularies. strong = defining tokens, weak = supporting tokens,
  // neg = tokens that argue this is NOT the control we want.
  const CONCEPTS = {
    visit: {
      strong: ['visit', 'encounter', 'timepoint', 'appointment', 'epoch', 'period', 'assessment'],
      weak: ['event', 'milestone', 'cycle', 'phase', 'session', 'interval', 'occasion', 'step'],
      neg: [],
    },
    schedule: {
      strong: ['schedule', 'plan', 'timeline', 'flowchart', 'matrix', 'calendar', 'overview', 'study'],
      weak: ['design', 'build', 'structure', 'layout', 'setup', 'configure', 'manage', 'protocol'],
      neg: ['patient', 'report', 'subject', 'data'],
    },
    form: {
      strong: ['form', 'document', 'instrument', 'crf', 'questionnaire', 'worksheet', 'module', 'assessment', 'log', 'sheet'],
      weak: ['source', 'page', 'record', 'template', 'definition', 'section', 'panel', 'block'],
      neg: [],
    },
    add: {
      strong: ['add', 'new', 'create', 'insert'],
      weak: ['plus', 'attach', 'append', 'register', '＋', '+'],
      neg: ['value', 'page', 'option'],
    },
    save: {
      strong: ['save', 'commit', 'persist', 'store', 'submit'],
      weak: ['apply', 'done', 'update', 'confirm', 'ok', 'keep', 'accept', 'finish', 'complete', 'write'],
      neg: ['template', 'as', 'preview', 'activate', 'publish', 'cancel', 'draft', 'local', 'locally', 'copy', 'sync', 'export', 'print', 'close', 'discard'],
    },
    cancel: {
      strong: ['cancel', 'discard', 'close', 'dismiss', 'abort', 'nevermind'],
      weak: ['back', 'revert', 'undo', 'exit', 'quit', 'leave', 'return'],
      neg: ['save'],
    },
    edit: {
      strong: ['edit', 'design', 'designer', 'builder', 'modify', 'author', 'compose', 'construct'],
      weak: ['open', 'configure', 'manage', 'setup', 'customize', 'change', 'update', 'revise'],
      neg: ['delete', 'preview', 'view', 'read'],
    },
    newVersion: {
      strong: ['version', 'revise', 'revision', 'amend', 'amendment', 'v2', 'v3', 'iteration'],
      weak: ['new', 'draft', 'create', 'update', 'clone', 'copy', 'duplicate'],
      neg: ['delete', 'remove'],
    },
    remove: {
      strong: ['delete', 'remove', 'trash', 'detach', 'discard', 'erase', 'destroy', 'drop'],
      weak: ['clear', 'purge', 'eliminate', '×', '✕', 'x'],
      neg: [],
    },
    name: {
      strong: ['name', 'title', 'identifier', 'heading'],
      weak: ['label', 'caption', 'description', 'id', 'alias'],
      neg: [],
    },
    windowStart: {
      strong: ['start', 'from', 'begin', 'opens', 'earliest', 'first', 'lower'],
      weak: ['window', 'day', 'offset', 'range', 'minimum'],
      neg: ['end', 'close', 'last', 'to'],
    },
    windowEnd: {
      strong: ['end', 'until', 'closes', 'latest', 'last', 'upper', 'through'],
      weak: ['window', 'day', 'offset', 'range', 'maximum', 'to'],
      neg: ['start', 'begin', 'first', 'from'],
    },
    repeating: {
      strong: ['repeating', 'repeat', 'log', 'recurring', 'reusable', 'iterable', 'multi'],
      weak: ['multiple', 'many', 'records', 'entries', 'instances', 'allow'],
      neg: [],
    },
    required: {
      strong: ['required', 'mandatory', 'compulsory', 'obligatory'],
      weak: ['must', 'needed', 'necessary', 'essential'],
      neg: ['optional'],
    },
    labelInput: {
      strong: ['label', 'caption', 'question', 'prompt', 'heading', 'title'],
      weak: ['name', 'text', 'display', 'description'],
      neg: ['placeholder', 'value', 'hint', 'help', 'tooltip', 'code'],
    },
    typeSelect: {
      strong: ['type', 'kind', 'format', 'control', 'widget', 'element'],
      weak: ['class', 'category', 'style', 'input', 'question', 'field'],
      neg: [],
    },
    min: {
      strong: ['minimum', 'min', 'lower', 'lowest', 'floor', 'range'],
      weak: ['low', 'from', 'start', 'bottom', 'least'],
      neg: ['max', 'upper', 'highest'],
    },
    max: {
      strong: ['maximum', 'max', 'upper', 'highest', 'ceiling', 'limit'],
      weak: ['high', 'to', 'end', 'top', 'most', 'cap'],
      neg: ['min', 'lower', 'lowest'],
    },
    units: {
      strong: ['units', 'unit', 'uom', 'measurement'],
      weak: ['measure', 'dimension', 'metric', 'quantity'],
      neg: [],
    },
    decimalPlaces: {
      strong: ['places', 'precision', 'decimals', 'scale', 'fraction'],
      weak: ['decimal', 'digits', 'accuracy', 'dp', 'significant'],
      neg: [],
    },
    formula: {
      strong: ['formula', 'expression', 'calculation', 'computation', 'equation'],
      weak: ['derive', 'derived', 'computed', 'compute', 'rule', 'function', 'script', 'evaluate', 'auto'],
      neg: [],
    },
    valueCode: {
      strong: ['code', 'stored', 'key', 'coded', 'internal', 'identifier'],
      weak: ['value', 'id', 'data', 'system', 'encoded', 'short'],
      neg: ['label', 'display', 'shown', 'description', 'human', 'readable'],
    },
    valueLabel: {
      strong: ['label', 'display', 'shown', 'description', 'readable', 'human', 'text'],
      weak: ['name', 'caption', 'long', 'full', 'decoded'],
      neg: ['code', 'stored', 'key', 'internal', 'system', 'encoded'],
    },
    addValue: {
      strong: ['value', 'values', 'option', 'options', 'choice', 'choices', 'row', 'item', 'answer', 'response', 'entry'],
      weak: ['add', 'new', 'create', 'insert', 'append'],
      neg: ['paste', 'bulk', 'import'],
    },
    valuesSection: {
      strong: ['values', 'choices', 'codes', 'options', 'answers', 'responses', 'items', 'entries', 'codelist'],
      weak: ['value', 'option', 'choice', 'code', 'list', 'item', 'answer', 'table', 'rows'],
      neg: [],
    },
    pasteBulk: {
      strong: ['paste', 'bulk', 'batch', 'import', 'mass', 'multiple'],
      weak: ['values', 'text', 'upload', 'copy', 'csv', 'tsv', 'clipboard'],
      neg: [],
    },
    visibility: {
      strong: ['visibility', 'visible', 'show', 'shown', 'display', 'skip', 'hidden', 'conditional', 'condition'],
      weak: ['logic', 'rule', 'when', 'hide', 'appear', 'enabled', 'active', 'available', 'relevant'],
      neg: [],
    },
    conditionalMode: {
      strong: ['when', 'if', 'condition', 'conditional', 'depends', 'dependent', 'dynamic', 'rule'],
      weak: ['shown', 'based', 'triggered', 'linked'],
      neg: ['always', 'never', 'none', 'unconditional', 'static'],
    },
    whenField: {
      strong: ['element', 'field', 'question', 'depends', 'controlling', 'source', 'trigger', 'parent'],
      weak: ['when', 'control', 'reference', 'linked', 'on', 'based'],
      neg: ['value', 'equals', 'answer', 'response'],
    },
    equalsValue: {
      strong: ['equals', 'value', 'answer', 'is', 'matches', 'response', 'expected'],
      weak: ['when', 'compare', 'condition', 'target', 'result'],
      neg: ['element', 'field', 'question', 'source'],
    },
    palette: {
      strong: ['element', 'elements', 'widget', 'widgets', 'control', 'controls', 'toolbox', 'palette', 'component', 'components', 'library', 'catalog'],
      weak: ['field', 'fields', 'question', 'questions', 'types', 'tool', 'tools', 'item', 'items', 'drawer', 'panel', 'sidebar', 'rail', 'tray', 'dock'],
      neg: ['import', 'export'],
    },
    back: {
      strong: ['back', 'return', 'previous', 'parent', 'up'],
      weak: ['schedule', 'plan', 'home', 'list', 'overview', 'exit', 'leave', 'close', 'navigate', '←', '‹', '<'],
      neg: [],
    },
    preview: {
      strong: ['preview', 'view', 'readonly'],
      weak: ['test', 'sample', 'demo'],
      neg: [],
    },
    activate: {
      strong: ['activate', 'publish', 'release', 'finalize', 'lock', 'approve', 'sign'],
      weak: ['live', 'deploy', 'enable', 'go', 'production', 'active'],
      neg: ['deactivate', 'disable', 'unpublish', 'draft'],
    },
    navigation: {
      strong: ['nav', 'navigation', 'menu', 'sidebar', 'tab', 'tabs', 'breadcrumb', 'header'],
      weak: ['link', 'links', 'panel', 'bar', 'rail', 'drawer', 'tree', 'outline'],
      neg: [],
    },
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
      else {
        // Fuzzy matching for abbreviations and truncations
        const strongMatch = fuzzyTokenMatch(t, concept.strong);
        const weakMatch = fuzzyTokenMatch(t, concept.weak);
        if (strongMatch > 0) score += 3 * strongMatch;
        else if (weakMatch > 0) score += 1 * weakMatch;
      }
      if (concept.neg.includes(t)) score -= 3;
    }
    // Mild brevity preference: "Save" should outrank "Save As Template".
    return score > 0 ? score / (1 + 0.15 * Math.max(0, tokens.length - 2)) : score;
  }

  // Canonical field types scored against a palette entry's visible label.
  const TYPE_LEXICON = {
    text: {
      strong: ['text', 'textbox', 'string', 'short', 'single', 'answer', 'line', 'alphanumeric', 'freetext', 'plaintext', 'entry'],
      weak: ['free', 'input', 'small', 'brief', 'simple', 'basic', 'field'],
      neg: ['multi', 'area', 'paragraph', 'long', 'number', 'rich', 'list', 'date', 'time', 'formula', 'calculated', 'select', 'dropdown', 'radio', 'check', 'pick', 'combo'],
    },
    textarea: {
      strong: ['multi', 'area', 'paragraph', 'long', 'memo', 'notes', 'comment', 'essay', 'narrative', 'freeform', 'multiline'],
      weak: ['text', 'textbox', 'line', 'large', 'big', 'extended', 'description', 'remarks', 'block'],
      neg: ['single', 'short', 'one', 'list', 'pick', 'select', 'number', 'date'],
    },
    integer: {
      strong: ['whole', 'integer', 'int', 'counting'],
      weak: ['number', 'numeric', 'quantity', 'amount', 'count'],
      neg: ['decimal', 'float', 'fraction', 'fractional', 'real', 'point'],
    },
    decimal: {
      strong: ['decimal', 'float', 'fraction', 'fractional', 'real', 'double', 'precision', 'point'],
      weak: ['number', 'numeric', 'quantity', 'amount'],
      neg: ['whole', 'integer', 'counting', 'int'],
    },
    date: {
      strong: ['date', 'calendar', 'day'],
      weak: ['picker', 'chooser'],
      neg: ['time', 'stamp', 'datetime', 'timestamp'],
    },
    time: {
      strong: ['time', 'clock', 'hour'],
      weak: ['picker', 'chooser'],
      neg: ['date', 'stamp', 'datetime', 'timestamp'],
    },
    datetime: {
      strong: ['datetime', 'timestamp', 'stamp'],
      weak: ['date', 'time', 'combined', 'full', 'moment'],
      neg: [],
    },
    boolean: {
      strong: ['yes', 'no', 'boolean', 'toggle', 'switch', 'true', 'false', 'yesno'],
      weak: ['flag', 'binary', 'indicator', 'on', 'off', 'flip'],
      neg: ['list', 'check', 'select', 'pick', 'multi', 'radio', 'dropdown'],
    },
    single_select: {
      strong: ['dropdown', 'picklist', 'combo', 'select', 'pick', 'pulldown', 'menu', 'combobox', 'listbox'],
      weak: ['list', 'choice', 'choose', 'one', 'single', 'options', 'lookup', 'reference'],
      neg: ['multi', 'check', 'radio', 'many', 'several', 'all', 'tick', 'box', 'toggle'],
    },
    multi_select: {
      strong: ['multi', 'checklist', 'many', 'several', 'multiselect', 'checkboxgroup'],
      weak: ['check', 'list', 'pick', 'select', 'choices', 'all', 'multiple', 'options', 'group'],
      neg: ['single', 'one', 'box', 'radio', 'toggle', 'yes', 'no'],
    },
    radio: {
      strong: ['radio', 'option', 'exclusive', 'radiogroup', 'buttongroup'],
      weak: ['buttons', 'choice', 'ring', 'single', 'select', 'pick', 'one'],
      neg: ['check', 'list', 'multi', 'dropdown', 'combo', 'toggle'],
    },
    checkbox: {
      strong: ['checkbox', 'tick', 'box', 'tickbox', 'checkmark'],
      weak: ['check', 'single', 'flag', 'boolean', 'consent', 'agree', 'acknowledge'],
      neg: ['list', 'multi', 'many', 'group', 'several', 'select', 'radio', 'dropdown'],
    },
    calculated: {
      strong: ['calculated', 'computed', 'derived', 'formula', 'calculation', 'expression', 'scripted', 'auto'],
      weak: ['result', 'output', 'readonly', 'generated', 'dynamic', 'evaluate', 'compute'],
      neg: [],
    },
  };

  function scoreType(entryLabel, canonicalType) {
    const lex = TYPE_LEXICON[canonicalType];
    if (!lex) throw new Error('unknown canonical type ' + canonicalType);
    const tokens = tokenize(entryLabel);
    let score = 0;
    for (const t of tokens) {
      if (lex.strong.includes(t)) score += 3;
      else if (lex.weak.includes(t)) score += 1;
      else {
        const strongMatch = fuzzyTokenMatch(t, lex.strong);
        const weakMatch = fuzzyTokenMatch(t, lex.weak);
        if (strongMatch > 0) score += 3 * strongMatch;
        else if (weakMatch > 0) score += 1 * weakMatch;
      }
      if (lex.neg.includes(t)) score -= 3;
    }
    // datetime needs both halves in the label, OR an unambiguous marker like "moment"/"datetime".
    if (canonicalType === 'datetime') {
      const hasDate = tokens.includes('date') || tokens.includes('datetime') || tokens.includes('timestamp') || tokens.includes('stamp');
      const hasTime = tokens.includes('time') || tokens.includes('datetime') || tokens.includes('timestamp') || tokens.includes('stamp');
      const hasMoment = tokens.includes('moment') || tokens.includes('datetime');
      if ((hasDate && hasTime) || hasMoment) score += 4;
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

  /**
   * Fuzzy string similarity based on character n-grams. Returns 0..1.
   * Used when exact token matching fails to find approximate matches.
   */
  function similarity(a, b) {
    a = String(a || '').trim().toLowerCase();
    b = String(b || '').trim().toLowerCase();
    if (a === b) return 1;
    if (!a || !b) return 0;
    const n = 2;
    const grams = (s) => {
      const g = new Set();
      for (let i = 0; i <= s.length - n; i++) g.add(s.slice(i, i + n));
      return g;
    };
    const ga = grams(a), gb = grams(b);
    let inter = 0;
    for (const g of ga) if (gb.has(g)) inter++;
    return inter / Math.max(ga.size, gb.size);
  }

  NS.lexicon = { tokenize, scoreConcept, scoreType, rank, margin, CONCEPTS, TYPE_LEXICON, equalsNormalized, hasToken, similarity, fuzzyTokenMatch };
})();

/*
 * llm.js — LLM-assisted reasoning for when deterministic semantic scoring
 * fails to produce confident candidates.
 *
 * Used as a FALLBACK only: the agent first tries concept scoring and probing.
 * When those yield no candidates or very low confidence, this module asks
 * an LLM to interpret the page structure and choose among affordances.
 *
 * The LLM never sees raw DOM — it sees the same affordance abstractions the
 * agent works with, plus contextual page text.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});

  let _apiKey = null;
  let _model = 'claude-sonnet-5';

  function configure(apiKey, model) {
    _apiKey = apiKey;
    if (model) _model = model;
  }

  function isAvailable() {
    return !!_apiKey;
  }

  /**
   * Ask the LLM to pick from affordances for a given intent.
   * @param {string} intent - What the agent is trying to do
   * @param {Array} affordances - The available affordances (name, kind, context)
   * @param {Object} pageContext - Summary of the current page
   * @returns {Object|null} - { index, confidence, reason } or null
   */
  async function pickAffordance(intent, affordances, pageContext) {
    if (!_apiKey) return null;
    const truncatedAffs = affordances.slice(0, 40).map((a, i) => ({
      idx: i,
      kind: a.kind,
      name: (a.name || '').slice(0, 80),
      context: a.context.slice(0, 3).map((c) => c.slice(0, 60)),
      disabled: a.disabled,
      inModal: a.inModal,
    }));

    const prompt = [
      'You are helping a browser automation agent navigate an eSource clinical trial platform.',
      'The agent needs to: ' + intent,
      '',
      'Current page context:',
      JSON.stringify(pageContext, null, 1),
      '',
      'Available interactive elements on the page:',
      JSON.stringify(truncatedAffs, null, 1),
      '',
      'Which element (by idx) should the agent interact with?',
      'Reply ONLY with JSON: {"idx": <number>, "confidence": 0..1, "reason": "<one sentence>"}',
      'If none of these elements match, reply: {"idx": -1, "confidence": 0, "reason": "<why>"}',
    ].join('\n');

    try {
      const result = await callLLM(prompt);
      if (result && result.idx >= 0 && result.idx < affordances.length) {
        return { index: result.idx, confidence: result.confidence || 0.5, reason: result.reason || '' };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Ask the LLM to interpret the current page and identify what screen we're on
   * and what actions are available.
   */
  async function interpretPage(affordances, pageContext) {
    if (!_apiKey) return null;
    const truncatedAffs = affordances.slice(0, 50).map((a, i) => ({
      idx: i,
      kind: a.kind,
      name: (a.name || '').slice(0, 80),
      context: a.context.slice(0, 3).map((c) => c.slice(0, 60)),
    }));

    const prompt = [
      'You are analyzing an eSource clinical trial platform UI.',
      '',
      'Page context:',
      JSON.stringify(pageContext, null, 1),
      '',
      'Interactive elements:',
      JSON.stringify(truncatedAffs, null, 1),
      '',
      'Identify:',
      '1. What screen/view is this? (study plan, visit list, form builder, form preview, login, settings, etc.)',
      '2. Key navigation elements (indices of elements that navigate to other screens)',
      '3. Key action elements (indices of elements for creating, editing, saving, etc.)',
      '',
      'Reply ONLY with JSON:',
      '{"screen": "<screen type>", "navElements": [<indices>], "actionElements": [<indices>], "confidence": 0..1, "notes": "<brief>"}',
    ].join('\n');

    try {
      return await callLLM(prompt);
    } catch (e) {
      return null;
    }
  }

  /**
   * Ask the LLM to map a canonical type to a platform's palette entry
   * given the observed probe results.
   */
  async function mapType(canonicalType, entries) {
    if (!_apiKey) return null;
    const prompt = [
      'You are mapping a canonical clinical form field type to an eSource platform\'s element palette.',
      '',
      'Canonical type to map: "' + canonicalType + '"',
      '',
      'Canonical type descriptions:',
      '- text: single-line free text entry',
      '- textarea: multi-line free text entry',
      '- integer: whole number entry with optional min/max range',
      '- decimal: decimal/floating-point number entry with optional min/max range',
      '- date: date entry (no time component)',
      '- time: time entry (no date component)',
      '- datetime: combined date and time entry',
      '- boolean: yes/no or true/false toggle',
      '- single_select: pick one from a coded list (dropdown)',
      '- multi_select: pick multiple from a coded list (checklist)',
      '- radio: pick one from a coded list (radio buttons)',
      '- checkbox: single check/tick box',
      '- calculated: formula-computed field',
      '',
      'Platform palette entries with probe results:',
      JSON.stringify(entries.map((e) => ({
        label: e.label,
        inert: !!e.inert,
        bestGuess: e.inert ? null : (e.cls ? e.cls.best.type : null),
        confidence: e.inert ? 0 : (e.cls ? e.cls.confidence : 0),
        evidence: e.inert ? [] : (e.cls ? e.cls.evidence : []),
      })), null, 1),
      '',
      'Which palette entry best represents "' + canonicalType + '"?',
      'Reply ONLY with JSON: {"label": "<exact palette entry label>", "confidence": 0..1, "reason": "<one sentence>"}',
    ].join('\n');

    try {
      return await callLLM(prompt);
    } catch (e) {
      return null;
    }
  }

  /**
   * Ask the LLM to figure out how to navigate from the current screen to
   * a target screen.
   */
  async function findNavigation(targetScreen, affordances, pageContext) {
    if (!_apiKey) return null;
    const truncatedAffs = affordances.slice(0, 40).map((a, i) => ({
      idx: i,
      kind: a.kind,
      name: (a.name || '').slice(0, 80),
      context: a.context.slice(0, 2).map((c) => c.slice(0, 60)),
    }));

    const prompt = [
      'You are helping navigate an eSource clinical trial platform.',
      'Target: navigate to the ' + targetScreen + ' screen.',
      '',
      'Page context:', JSON.stringify(pageContext, null, 1),
      '',
      'Available elements:', JSON.stringify(truncatedAffs, null, 1),
      '',
      'Which element(s) should be clicked to reach the target screen?',
      'Reply ONLY with JSON: {"steps": [<indices in click order>], "confidence": 0..1, "reason": "<brief>"}',
    ].join('\n');

    try {
      return await callLLM(prompt);
    } catch (e) {
      return null;
    }
  }

  async function callLLM(prompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': _apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: _model,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('');
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }

  NS.llm = { configure, isAvailable, pickAffordance, interpretPage, mapType, findNavigation };
})();

/* Agent Console — tolerant parsers for dashboard_data.json `regions`.
 *
 * Every region is a pre-rendered HTML fragment produced by a bot's own
 * publish step. That markup is NOT a contract: it differs per bot and can
 * change without notice. So each parser here detects what it can, and
 * returns an empty result rather than throwing when it meets something new.
 * Callers render a "couldn't read this feed" affordance on empty.
 */
(function (global) {
  'use strict';

  var AC = global.AC || (global.AC = {});

  var DROP_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'];

  function docFrom(html) {
    return new DOMParser().parseFromString('<body>' + (html || '') + '</body>', 'text/html');
  }

  /* Strip anything executable and make every URL absolute against the agent's
   * dashboard. Without the rewrite, a link like `report.html#rec-NVDA...`
   * resolves against the console's own origin and 404s. */
  function scrub(root, baseUrl) {
    DROP_TAGS.forEach(function (tag) {
      Array.prototype.slice.call(root.querySelectorAll(tag)).forEach(function (n) {
        n.parentNode && n.parentNode.removeChild(n);
      });
    });
    Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0) { el.removeAttribute(attr.name); return; }
        if (name === 'href' || name === 'src') {
          var raw = attr.value || '';
          if (/^\s*javascript:/i.test(raw)) { el.removeAttribute(attr.name); return; }
          if (baseUrl) {
            try { el.setAttribute(attr.name, new URL(raw, baseUrl).href); } catch (e) { /* leave as-is */ }
          }
        }
      });
      if (el.tagName === 'A' && el.getAttribute('href')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return root;
  }

  /* Public: sanitized HTML string, safe to assign to innerHTML. */
  AC.sanitize = function (html, baseUrl) {
    return scrub(docFrom(html).body, baseUrl).innerHTML;
  };

  AC.text = function (el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  };

  /* ---- timestamps -------------------------------------------------------
   * Three formats in the wild, all meaning UTC:
   *   `2026-08-21 19:45`     (repete, repete1)
   *   `2026-08-23 01:06`     (repete3)
   *   `2026-08-19T21:15Z`    (repete2)
   */
  AC.parseTime = function (raw) {
    var s = (raw || '').replace(/\s+/g, ' ').trim();
    var m = s.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?/);
    if (!m) return null;
    var iso = m[1] + 'T' + m[2] + (m[3] || ':00') + (m[4] ? m[4].replace(/(\d{2})(\d{2})$/, '$1:$2') : 'Z');
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  };

  AC.relTime = function (date, now) {
    if (!date) return '—';
    var secs = Math.round(((now || Date.now()) - date.getTime()) / 1000);
    if (secs < 0) return 'just now';
    if (secs < 60) return secs + 's ago';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  };

  /* ---- cards ------------------------------------------------------------
   * The one convention every bot shares:
   *   .cardgroup > h3            group heading
   *   .cardgroup .card > .v, .k  value and label
   * Repete1/Repete3 nest `.pendingv` + `.pendingn` inside `.v` for
   * not-yet-meaningful stats; Repete2 carries extra data-* attributes.
   */
  AC.parseCards = function (html) {
    var doc = docFrom(html);
    var out = [];
    var groups = doc.querySelectorAll('.cardgroup');

    function readCard(card, group) {
      var v = card.querySelector('.v');
      var k = card.querySelector('.k');
      if (!v && !k) return;
      var value, note = '';
      var pv = v && v.querySelector('.pendingv');
      if (pv) { value = AC.text(pv); note = AC.text(v.querySelector('.pendingn')); }
      else { value = AC.text(v); }
      var cls = card.className || '';
      var tone = /\bwin\b/.test(cls) ? 'win' : /\bloss\b/.test(cls) ? 'loss'
               : /\bpending\b/.test(cls) ? 'pending' : 'flat';
      out.push({ group: group, label: AC.text(k), value: value, note: note, tone: tone });
    }

    if (groups.length) {
      Array.prototype.slice.call(groups).forEach(function (g) {
        var heading = AC.text(g.querySelector('h3'));
        Array.prototype.slice.call(g.querySelectorAll('.card')).forEach(function (c) { readCard(c, heading); });
      });
    } else {
      Array.prototype.slice.call(doc.querySelectorAll('.card')).forEach(function (c) { readCard(c, ''); });
    }
    return out;
  };

  /* ---- decisions --------------------------------------------------------
   * repete / repete1 : <table id=dtable>, reasoning in td.reason
   * repete3          : <table id="dtable">, reasoning in td.reason
   * repete2          : <table> with NO id and NO reasoning column
   * so: take the first table whatever its id, and locate columns by header text.
   */
  function columnIndex(headers, re) {
    for (var i = 0; i < headers.length; i++) if (re.test(headers[i])) return i;
    return -1;
  }

  AC.parseDecisions = function (html, baseUrl) {
    var doc = scrub(docFrom(html).body, baseUrl);
    var table = doc.querySelector('table');
    if (!table) return [];

    var headers = Array.prototype.slice.call(table.querySelectorAll('thead th'))
      .map(function (th) { return AC.text(th).toLowerCase(); });

    var iWhen   = columnIndex(headers, /when|time|date/);
    var iSym    = columnIndex(headers, /sym|ticker|pair|asset/);
    var iAction = columnIndex(headers, /action|decision|firm|side/);
    var iStrat  = columnIndex(headers, /strategy|desk|model/);
    var iStatus = columnIndex(headers, /status|judge/);
    var iReason = columnIndex(headers, /reason|rationale|why/);
    if (iWhen < 0) iWhen = 0;

    var rows = table.querySelectorAll('tbody tr');
    var out = [];

    Array.prototype.slice.call(rows).forEach(function (tr) {
      var tds = Array.prototype.slice.call(tr.children).filter(function (n) { return n.tagName === 'TD'; });
      if (!tds.length) return;

      // Filler rows: a single colspan cell, e.g. "30 symbols held — no entry".
      if (tds.length === 1 && tds[0].hasAttribute('colspan')) {
        var summary = AC.text(tds[0]);
        var count = (summary.match(/(\d+)/) || [])[1];
        out.push({
          kind: 'hold',
          time: null,
          summary: summary,
          heldCount: count ? parseInt(count, 10) : null,
          heldSymbols: AC.text(tds[0].querySelector('.holdsyms'))
        });
        return;
      }

      var reasonCell = tr.querySelector('td.reason') || (iReason >= 0 ? tds[iReason] : null);
      var cell = function (i) { return i >= 0 && tds[i] ? AC.text(tds[i]) : ''; };

      // Repete3 links each ticker to its full case file (the bull, the bear and
      // how each judge ruled). scrub() already made that href absolute.
      var symLink = (iSym >= 0 && tds[iSym]) ? tds[iSym].querySelector('a[href]') : null;

      out.push({
        kind: 'decision',
        time: AC.parseTime(cell(iWhen)),
        timeRaw: cell(iWhen),
        symbol: cell(iSym),
        symbolHref: symLink ? symLink.getAttribute('href') : '',
        symbolTitle: symLink ? (symLink.getAttribute('title') || '') : '',
        action: cell(iAction),
        strategy: cell(iStrat),
        status: cell(iStatus),
        reason: AC.text(reasonCell),
        reasonHtml: reasonCell ? reasonCell.innerHTML : '',
        rowClass: tr.className || ''
      });
    });

    return out;
  };

  /* ---- articles ---------------------------------------------------------
   * Repete1 publishes richer prose than any table:
   *   journal -> <article class=jentry><h3>title</h3><p class=small>ts</p>…
   *   why     -> <article class=why><h3>SYM <span class=pill>strategy</span> <span class=small>ts</span></h3>…
   */
  AC.parseArticles = function (html, baseUrl) {
    var doc = scrub(docFrom(html).body, baseUrl);
    return Array.prototype.slice.call(doc.querySelectorAll('article')).map(function (art) {
      var h = art.querySelector('h3');
      var title = AC.text(h);
      // The timestamp is either a .small inside the heading or the next .small sibling.
      var tsEl = (h && h.querySelector('.small')) || art.querySelector('.small');
      var time = AC.parseTime(AC.text(tsEl)) || AC.parseTime(title) || AC.parseTime(art.id || '');
      var body = art.cloneNode(true);
      // Repete1's journal repeats its heading and stamps the time inline; the
      // entry header already shows both, so strip them from the body.
      Array.prototype.slice.call(body.querySelectorAll('h3')).forEach(function (n, i) {
        var t = AC.text(n);
        if (i === 0 || (t && (title.indexOf(t) === 0 || t.indexOf(title) === 0))) {
          n.parentNode.removeChild(n);
        }
      });
      Array.prototype.slice.call(body.querySelectorAll('.small')).forEach(function (n) {
        if (AC.parseTime(AC.text(n)) && AC.text(n).length < 40) n.parentNode.removeChild(n);
      });
      var summary = AC.text(body).slice(0, 240);
      return { title: title, time: time, bodyHtml: body.innerHTML, text: AC.text(art), summary: summary };
    });
  };
})(window);

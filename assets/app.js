/* Agent Console — registry, fetching, rendering, routing.
 * Read-only: it consumes the public dashboard_data.json each bot already
 * publishes. It never writes to, or alters the URLs of, any dashboard.
 */
(function () {
  'use strict';

  var K_CUSTOM = 'agentConsole.custom.v1';
  var K_HIDDEN = 'agentConsole.hidden.v1';
  var K_THEME  = 'agentConsole.theme.v1';

  var PER_AGENT_CAP = 80;      // entries pulled per agent into the merged stream
  var REFRESH_MS    = 60000;

  var state = {
    agents: [],
    data: {},                  // id -> { ok, feed, error, fetchedAt }
    route: { name: 'fleet', id: null, tab: 'dashboard' },
    filter: { agents: null, q: '', holds: false },
    loading: true
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function readJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }
  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('agent-' + Date.now());
  }
  function normUrl(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    if (!/\/$/.test(s) && !/\.[a-z]{2,5}$/i.test(s.split('/').pop())) s += '/';
    return s;
  }
  function feedUrl(agent) {
    try { return new URL('dashboard_data.json', agent.url).href; } catch (e) { return null; }
  }

  /* ---------------- registry ---------------- */

  function loadRegistry() {
    return fetch('agents.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : { agents: [] }; })
      .catch(function () { return { agents: [] }; })
      .then(function (seed) {
        var hidden = readJSON(K_HIDDEN, []);
        var custom = readJSON(K_CUSTOM, []);
        var seeds = (seed.agents || []).map(function (a) { a.source = 'seed'; return a; });
        var mine  = custom.map(function (a) { a.source = 'custom'; return a; });
        state.agents = seeds.concat(mine).filter(function (a) { return hidden.indexOf(a.id) === -1; });
      });
  }

  function addCustom(agent) {
    var custom = readJSON(K_CUSTOM, []);
    custom.push(agent);
    writeJSON(K_CUSTOM, custom);
    agent.source = 'custom';
    state.agents.push(agent);
  }

  function removeAgent(id) {
    var custom = readJSON(K_CUSTOM, []).filter(function (a) { return a.id !== id; });
    writeJSON(K_CUSTOM, custom);
    var agent = state.agents.filter(function (a) { return a.id === id; })[0];
    if (agent && agent.source === 'seed') {
      var hidden = readJSON(K_HIDDEN, []);
      if (hidden.indexOf(id) === -1) { hidden.push(id); writeJSON(K_HIDDEN, hidden); }
    }
    state.agents = state.agents.filter(function (a) { return a.id !== id; });
    delete state.data[id];
  }

  /* ---------------- fetching ---------------- */

  function fetchAgent(agent) {
    var url = feedUrl(agent);
    if (!url) return Promise.resolve({ ok: false, error: 'Bad URL' });
    // Pages serves cache-control: max-age=600, so bust it to see fresh publishes.
    return fetch(url + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (feed) { return { ok: true, feed: feed, fetchedAt: Date.now() }; })
      .catch(function (err) { return { ok: false, error: err.message, fetchedAt: Date.now() }; });
  }

  function refreshAll() {
    var agents = state.agents.slice();
    return Promise.all(agents.map(function (a) {
      return fetchAgent(a).then(function (res) { state.data[a.id] = res; });
    })).then(function () {
      state.loading = false;
      $('#lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      render();
    });
  }

  /* ---------------- derivation ---------------- */

  function regions(id) {
    var d = state.data[id];
    return (d && d.ok && d.feed && d.feed.regions) ? d.feed.regions : null;
  }
  function generatedAt(id) {
    var d = state.data[id];
    return (d && d.ok && d.feed) ? AC.parseTime(d.feed.generated_at) : null;
  }
  function freshnessClass(date) {
    if (!date) return '';
    var hrs = (Date.now() - date.getTime()) / 3600000;
    return hrs < 6 ? 'fresh' : hrs < 48 ? 'aging' : 'stale';
  }

  var KPI_PRIORITY = [
    /realized/i, /unrealized/i, /win rate/i, /profit factor/i,
    /equity|balance/i, /open position|positions open|positions/i,
    /strategies enabled/i, /registered trials/i
  ];

  function agentCards(agent) {
    var r = regions(agent.id);
    if (!r || !r.cards) return [];
    try { return AC.parseCards(r.cards); } catch (e) { return []; }
  }

  function headlineKpis(agent) {
    var cards = agentCards(agent);
    if (!cards.length) return [];
    var picked = [], used = {};
    KPI_PRIORITY.forEach(function (re) {
      if (picked.length >= 3) return;
      for (var i = 0; i < cards.length; i++) {
        if (used[i]) continue;
        if (re.test(cards[i].label)) { picked.push(cards[i]); used[i] = 1; break; }
      }
    });
    for (var i = 0; i < cards.length && picked.length < 3; i++) {
      if (!used[i]) { picked.push(cards[i]); used[i] = 1; }
    }
    return picked.slice(0, 3);
  }

  /* Build one agent's thinking entries: decisions table plus, where the bot
   * publishes them, the richer journal / why article regions. */
  function agentEntries(agent) {
    var r = regions(agent.id);
    if (!r) return [];
    var out = [];

    if (r.decisions) {
      var rows = [];
      try { rows = AC.parseDecisions(r.decisions, agent.url); } catch (e) { rows = []; }
      // Hold rows carry no timestamp of their own; inherit the nearest one so
      // they can still be ordered if the reader turns them on.
      var lastTime = null;
      for (var i = rows.length - 1; i >= 0; i--) {
        if (rows[i].time) lastTime = rows[i].time; else rows[i].time = lastTime;
      }
      rows.forEach(function (row) {
        if (row.kind === 'hold') {
          out.push({
            agent: agent, kind: 'hold', time: row.time,
            title: '', html: esc(row.summary), text: row.summary, summary: row.summary
          });
        } else {
          out.push({
            agent: agent, kind: 'decision', time: row.time,
            symbol: row.symbol, action: row.action, strategy: row.strategy,
            symbolHref: row.symbolHref, symbolTitle: row.symbolTitle,
            status: row.status,
            html: row.reasonHtml || esc(row.reason),
            text: [row.symbol, row.action, row.strategy, row.status, row.reason].join(' '),
            summary: row.reason ||
              [row.action, row.strategy].filter(Boolean).join(' · ') || row.status
          });
        }
      });
    }

    ['why', 'journal', 'lessons'].forEach(function (key) {
      if (!r[key]) return;
      var arts = [];
      try { arts = AC.parseArticles(r[key], agent.url); } catch (e) { arts = []; }
      arts.forEach(function (a) {
        out.push({
          agent: agent, kind: key, time: a.time,
          title: a.title, html: a.bodyHtml, text: a.text,
          summary: a.summary || a.title
        });
      });
    });

    return out.slice(0, PER_AGENT_CAP);
  }

  function mergedStream() {
    var all = [];
    state.agents.forEach(function (a) { all = all.concat(agentEntries(a)); });
    all.sort(function (x, y) {
      var tx = x.time ? x.time.getTime() : 0, ty = y.time ? y.time.getTime() : 0;
      return ty - tx;
    });
    return all;
  }

  function applyFilters(entries) {
    var q = state.filter.q.toLowerCase();
    return entries.filter(function (e) {
      if (!state.filter.holds && e.kind === 'hold') return false;
      if (state.filter.agents && !state.filter.agents[e.agent.id]) return false;
      if (q && e.text.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  /* ---------------- rendering ---------------- */

  function badgeClass(word) {
    var w = String(word || '').toLowerCase();
    if (/veto|sell|short|close|reject/.test(w)) return 'sell';
    if (/buy|long|open|approve|exec/.test(w)) return 'buy';
    if (/hold/.test(w)) return 'hold';
    return '';
  }

  function renderNav() {
    $$('.nav-item[data-route]').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.route === state.route.name);
    });
    var host = $('#navAgents');
    host.innerHTML = state.agents.map(function (a) {
      var g = generatedAt(a.id);
      var d = state.data[a.id];
      var cls = (state.route.name === 'agent' && state.route.id === a.id) ? ' is-active' : '';
      var dot = (d && !d.ok) ? 'stale' : freshnessClass(g);
      return '<button class="nav-item' + cls + '" data-agent="' + esc(a.id) + '">' +
        '<span class="dot fdot ' + dot + '" style="background:' + esc(a.accent || '#4f8cff') + '"></span>' +
        esc(a.name) + '</button>';
    }).join('');
    $$('[data-agent]', host).forEach(function (b) {
      b.onclick = function () { go('#/agent/' + b.dataset.agent); };
    });
  }

  function netPnl(agent) {
    var r = regions(agent.id);
    try { return AC.parseNetPnl(r && r.net_pnl); } catch (e) { return null; }
  }

  function money(x, currency) {
    var sym = currency === 'CAD' ? 'C$' : currency === 'USD' ? '$' : currency + ' ';
    var s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (x < 0 ? '-' : x > 0 ? '+' : '') + sym + s;
  }

  /* Gross and net side by side (Peter, 2026-11-03), from the bot's net_pnl region. */
  function netPnlRow(agent, d) {
    var n = netPnl(agent);
    if (!n) {
      return d && d.ok
        ? '<div class="netpnl muted">Gross and net P&amp;L show here once this dashboard publishes them.</div>'
        : '';
    }
    var tone = function (x) { return x > 0 ? 'win' : x < 0 ? 'loss' : 'flat'; };
    return '<div class="netpnl" title="Since ' + esc(n.since) + '. Trading costs are simulated at the rates set on the console\'s /trading page.">' +
      '<span>Gross <b class="' + tone(n.gross) + '">' + esc(money(n.gross, n.currency)) + '</b></span>' +
      '<span>Costs <b>' + esc(money(-n.costs, n.currency)) + '</b></span>' +
      '<span>Net <b class="' + tone(n.net) + '">' + esc(money(n.net, n.currency)) + '</b></span>' +
    '</div>';
  }

  function kpiCell(k) {
    var short = String(k.value || '').replace(/\s*\([^)]*\)\s*$/, '');
    return '<div class="kpi"><div class="v ' + k.tone + '" title="' + esc(k.value) + '">' +
      esc(short || '—') + '</div><div class="k" title="' + esc(k.label) + '">' + esc(k.label) + '</div></div>';
  }

  function renderFleet() {
    var grid = $('#fleetGrid');

    if (!state.agents.length) {
      grid.innerHTML = '<div class="empty"><h3>No agents yet</h3>' +
        '<p>Add one with the button in the sidebar — paste its dashboard URL and the rest is detected.</p></div>';
      return;
    }

    var broken = state.agents.filter(function (a) {
      var d = state.data[a.id]; return d && !d.ok;
    });
    $('#fleetNote').innerHTML = broken.length
      ? '<div class="note"><strong>' + broken.length + ' feed' + (broken.length > 1 ? 's' : '') +
        ' unreachable:</strong> ' + broken.map(function (a) { return esc(a.name); }).join(', ') +
        '. Their dashboards may still be fine — open one to check.</div>'
      : '';

    grid.innerHTML = state.agents.map(function (a) {
      var d = state.data[a.id];
      var g = generatedAt(a.id);
      var kpis = headlineKpis(a);
      var entries = agentEntries(a).filter(function (e) { return e.kind !== 'hold' && e.text.trim(); });
      var latest = entries[0];

      var kpiHtml;
      if (state.loading && !d) {
        kpiHtml = '<div class="kpi"><div class="v skeleton">0000</div><div class="k skeleton">loading</div></div>'.repeat(3);
      } else if (kpis.length) {
        kpiHtml = kpis.map(kpiCell).join('');
      } else {
        kpiHtml = '<div class="kpi" style="grid-column:1/-1"><div class="k">' +
          (d && !d.ok ? 'Feed unreachable — ' + esc(d.error) : 'No stats published') + '</div></div>';
      }

      var footText = latest
        ? esc((latest.symbol ? latest.symbol + ' — ' : '') + (latest.summary || latest.text || '').slice(0, 160))
        : (d && !d.ok ? 'Could not read this feed' : 'No recent decisions');

      return '<article class="card-agent" tabindex="0" data-open="' + esc(a.id) + '" ' +
             'style="--accent:' + esc(a.accent || '#4f8cff') + '">' +
        '<div class="card-head">' +
          '<div class="avatar">' + esc(initials(a.name)) + '</div>' +
          '<div class="card-title">' +
            '<h3>' + esc(a.name) + '</h3>' +
            '<div class="meta">' + esc(a.assetClass || '') +
              (a.venue ? ' · ' + esc(a.venue) : '') + '</div>' +
          '</div>' +
          '<span class="pill">' + esc(a.mode || 'paper') + '</span>' +
        '</div>' +
        '<div style="padding:0 16px 12px"><div class="freshness">' +
          '<span class="fdot ' + (d && !d.ok ? 'stale' : freshnessClass(g)) + '"></span>' +
          (d && !d.ok ? 'offline' : (g ? 'published ' + AC.relTime(g) : 'never published')) +
        '</div></div>' +
        '<div class="kpis">' + kpiHtml + '</div>' +
        netPnlRow(a, d) +
        '<div class="card-foot"><span class="lead">Last</span><span class="body">' + footText + '</span></div>' +
      '</article>';
    }).join('');

    $$('[data-open]', grid).forEach(function (el) {
      el.onclick = function () { go('#/agent/' + el.dataset.open); };
      el.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('#/agent/' + el.dataset.open); }
      };
    });
  }

  function entryHtml(e, showAgent) {
    var head = [];
    if (showAgent) {
      head.push('<span class="entry-agent" style="color:' + esc(e.agent.accent || '#4f8cff') + '">' +
                esc(e.agent.name) + '</span>');
    }
    if (e.symbol) {
      head.push(e.symbolHref
        ? '<a class="entry-sym" href="' + esc(e.symbolHref) + '" target="_blank" rel="noopener noreferrer"' +
          (e.symbolTitle ? ' title="' + esc(e.symbolTitle) + '"' : '') + '>' + esc(e.symbol) + ' ↗</a>'
        : '<span class="entry-sym">' + esc(e.symbol) + '</span>');
    }
    if (e.action) head.push('<span class="badge ' + badgeClass(e.action) + '">' + esc(e.action) + '</span>');
    if (e.strategy) head.push('<span>' + esc(e.strategy) + '</span>');
    if (e.kind === 'why' || e.kind === 'journal' || e.kind === 'lessons') {
      head.push('<span class="badge">' + esc(e.kind) + '</span>');
      if (e.title) head.push('<span class="entry-sym">' + esc(e.title) + '</span>');
    }
    head.push('<span class="entry-time" title="' + esc(e.time ? e.time.toISOString() : '') + '">' +
              (e.time ? AC.relTime(e.time) : 'undated') + '</span>');

    var body = e.html && e.html.trim() ? e.html : '<i>no reasoning published for this decision</i>';
    var status = (e.status && e.kind === 'decision')
      ? '<div class="entry-status">' + esc(e.status) + '</div>' : '';

    return '<article class="entry' + (e.kind === 'hold' ? ' is-hold' : '') + '" ' +
           'style="--accent:' + esc(e.agent.accent || '#4f8cff') + '">' +
      '<div class="entry-head">' + head.join('') + '</div>' +
      '<div class="entry-body">' + body + '</div>' + status +
    '</article>';
  }

  function renderThinking() {
    var controls = $('#streamControls');
    var sel = state.filter.agents;

    controls.innerHTML =
      '<button class="chip' + (!sel ? ' on' : '') + '" data-f="all">All agents</button>' +
      state.agents.map(function (a) {
        var on = sel && sel[a.id] ? ' on' : '';
        return '<button class="chip' + on + '" data-f="' + esc(a.id) + '">' +
          '<span class="dot" style="background:' + esc(a.accent || '#4f8cff') + '"></span>' + esc(a.name) + '</button>';
      }).join('') +
      '<button class="chip' + (state.filter.holds ? ' on' : '') + '" data-f="__holds">Show holds</button>' +
      '<input class="search" id="streamSearch" type="search" placeholder="Search reasoning…" value="' + esc(state.filter.q) + '">';

    $$('[data-f]', controls).forEach(function (b) {
      b.onclick = function () {
        var f = b.dataset.f;
        if (f === 'all') state.filter.agents = null;
        else if (f === '__holds') state.filter.holds = !state.filter.holds;
        else {
          var next = state.filter.agents ? Object.assign({}, state.filter.agents) : {};
          if (next[f]) delete next[f]; else next[f] = true;
          state.filter.agents = Object.keys(next).length ? next : null;
        }
        renderThinking();
      };
    });

    var search = $('#streamSearch');
    search.oninput = function () {
      state.filter.q = search.value;
      var pos = search.selectionStart;
      renderStreamBody();
      var s2 = $('#streamSearch');
      if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
    };

    renderStreamBody();
  }

  function renderStreamBody() {
    var entries = applyFilters(mergedStream());
    $('#thinkingCount').textContent = entries.length ? entries.length : '';
    $('#viewSub').textContent = entries.length
      ? entries.length + ' entries across ' + state.agents.length + ' agents'
      : '';

    var host = $('#stream');
    if (state.loading) { host.innerHTML = '<div class="loading">Loading reasoning from every agent…</div>'; return; }
    if (!entries.length) {
      host.innerHTML = '<div class="empty"><h3>Nothing to show</h3><p>' +
        (state.filter.q ? 'No entry matches “' + esc(state.filter.q) + '”.' :
         'No agent published reasoning that could be read.') + '</p></div>';
      return;
    }
    host.innerHTML = entries.slice(0, 300).map(function (e) { return entryHtml(e, true); }).join('');
  }

  function renderAgent() {
    var agent = state.agents.filter(function (a) { return a.id === state.route.id; })[0];
    var host = $('#agentBody');
    if (!agent) { host.innerHTML = '<div class="empty"><h3>Unknown agent</h3></div>'; return; }

    var d = state.data[agent.id];
    var g = generatedAt(agent.id);
    var tab = state.route.tab;

    var links = (agent.links || []).map(function (l) {
      var href;
      try { href = new URL(l.href, agent.url).href; } catch (e) { href = l.href; }
      return '<a class="btn" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(l.label) + ' ↗</a>';
    }).join(' ');

    $('#topActions').innerHTML =
      links + ' <a class="btn btn-primary" href="' + esc(agent.url) + '" target="_blank" rel="noopener">Open dashboard ↗</a>';

    var cards = agentCards(agent);
    var kpiGrid = cards.length
      ? '<div class="kpi-grid">' + cards.map(function (c) {
          return '<div class="kpi-tile"><div class="g">' + esc(c.group) + '</div>' +
            '<div class="v ' + c.tone + '">' + esc(c.value || '—') + '</div>' +
            '<div class="k">' + esc(c.label) + '</div>' +
            (c.note ? '<div class="n">' + esc(c.note) + '</div>' : '') + '</div>';
        }).join('') + '</div>'
      : '';

    var body;
    if (tab === 'thinking') {
      var entries = agentEntries(agent).filter(function (e) { return state.filter.holds || e.kind !== 'hold'; });
      body = entries.length
        ? '<div class="stream">' + entries.map(function (e) { return entryHtml(e, false); }).join('') + '</div>'
        : '<div class="empty"><h3>No readable reasoning</h3><p>This agent publishes no decisions region the console recognises. ' +
          '<a href="' + esc(agent.url) + '" target="_blank" rel="noopener">Open the dashboard ↗</a></p></div>';
    } else if (tab === 'positions') {
      var r = regions(agent.id);
      body = (r && r.positions)
        ? '<div class="frame-wrap" style="padding:14px"><div class="raw">' +
            AC.sanitize(r.positions, agent.url) + '</div></div>'
        : '<div class="empty"><h3>No positions region</h3><p>This agent does not publish one.</p></div>';
    } else {
      // sandbox WITHOUT allow-top-navigation: an embedded dashboard must never
      // be able to replace the console itself. allow-same-origin lets it fetch
      // its own data; allow-popups lets its links still open in a new tab.
      var frame = '<div class="frame-wrap"><iframe src="' + esc(agent.url) + '" ' +
        'title="' + esc(agent.name) + ' dashboard" loading="lazy" referrerpolicy="no-referrer" ' +
        'sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"' +
        '></iframe></div>';
      body = (d && !d.ok)
        ? '<div class="note">The data feed for this agent is unreachable (' + esc(d.error) +
          '), but the dashboard itself may still load below.</div>' + frame
        : frame;
    }

    host.innerHTML =
      '<div class="agent-head" style="--accent:' + esc(agent.accent || '#4f8cff') + '">' +
        '<div class="avatar" style="background:' + esc(agent.accent || '#4f8cff') + '">' + esc(initials(agent.name)) + '</div>' +
        '<div><h2>' + esc(agent.name) + '</h2>' +
          '<div class="sub" style="color:var(--ink-3);font-size:12.5px">' +
            esc(agent.tagline || agent.assetClass || '') +
            (agent.venue ? ' · ' + esc(agent.venue) : '') + '</div></div>' +
        '<span class="pill">' + esc(agent.mode || 'paper') + '</span>' +
        '<div class="freshness"><span class="fdot ' + (d && !d.ok ? 'stale' : freshnessClass(g)) + '"></span>' +
          (d && !d.ok ? 'feed offline' : (g ? 'published ' + AC.relTime(g) : 'never published')) + '</div>' +
        '<div class="spacer"></div>' +
        (agent.source === 'custom' ? '<button class="btn" id="removeAgent">Remove</button>' : '') +
      '</div>' +
      kpiGrid +
      '<div class="tabs" style="--accent:' + esc(agent.accent || '#4f8cff') + '">' +
        ['dashboard', 'thinking', 'positions'].map(function (t) {
          return '<button class="tab' + (tab === t ? ' is-active' : '') + '" data-tab="' + t + '">' +
            t.charAt(0).toUpperCase() + t.slice(1) + '</button>';
        }).join('') +
      '</div>' + body;

    $$('[data-tab]', host).forEach(function (b) {
      b.onclick = function () { go('#/agent/' + agent.id + '/' + b.dataset.tab); };
    });
    var rm = $('#removeAgent');
    if (rm) rm.onclick = function () {
      if (confirm('Remove ' + agent.name + ' from the console? The dashboard itself is untouched.')) {
        removeAgent(agent.id); go('#/fleet');
      }
    };
  }

  function render() {
    var r = state.route;
    $('#view-fleet').hidden = r.name !== 'fleet';
    $('#view-thinking').hidden = r.name !== 'thinking';
    $('#view-agent').hidden = r.name !== 'agent';
    if (r.name !== 'agent') $('#topActions').innerHTML = '';

    if (r.name === 'fleet') {
      $('#viewTitle').textContent = 'Fleet';
      $('#viewSub').textContent = state.agents.length + ' agent' + (state.agents.length === 1 ? '' : 's');
      renderFleet();
    } else if (r.name === 'thinking') {
      $('#viewTitle').textContent = 'Thinking';
      renderThinking();
    } else {
      var a = state.agents.filter(function (x) { return x.id === r.id; })[0];
      $('#viewTitle').textContent = a ? a.name : 'Agent';
      $('#viewSub').textContent = '';
      renderAgent();
    }
    renderNav();
    // Keep the sidebar count current even when the stream view isn't open.
    if (r.name !== 'thinking' && !state.loading) {
      $('#thinkingCount').textContent = applyFilters(mergedStream()).length || '';
    }
  }

  /* ---------------- routing ---------------- */

  function go(hash) {
    if (location.hash === hash) parseRoute(); else location.hash = hash;
    $('#sidebar').classList.remove('is-open');
  }

  function parseRoute() {
    var parts = (location.hash || '#/fleet').replace(/^#\/?/, '').split('/');
    if (parts[0] === 'agent' && parts[1]) {
      state.route = { name: 'agent', id: decodeURIComponent(parts[1]), tab: parts[2] || 'dashboard' };
    } else if (parts[0] === 'thinking') {
      state.route = { name: 'thinking', id: null, tab: null };
    } else {
      state.route = { name: 'fleet', id: null, tab: null };
    }
    render();
    window.scrollTo(0, 0);
  }

  /* ---------------- add-agent modal ---------------- */

  var probed = null;

  function openModal() {
    probed = null;
    $('#addUrl').value = ''; $('#addName').value = '';
    $('#addClass').value = ''; $('#addVenue').value = '';
    $('#probeResult').hidden = true;
    $('#addModal').hidden = false;
    $('#addUrl').focus();
  }
  function closeModal() { $('#addModal').hidden = true; }

  function probe() {
    var url = normUrl($('#addUrl').value);
    var box = $('#probeResult');
    if (!url) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'probe';
    box.textContent = 'Checking ' + url + ' …';

    fetch(new URL('dashboard_data.json', url).href + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (feed) {
        probed = feed;
        var keys = Object.keys(feed.regions || {});
        var g = AC.parseTime(feed.generated_at);
        box.className = 'probe ok';
        box.innerHTML = '<strong>Live feed found.</strong> Published ' +
          (g ? AC.relTime(g) : 'unknown') + '.<br>' +
          '<code>' + keys.length + ' regions: ' + esc(keys.slice(0, 10).join(', ')) +
          (keys.length > 10 ? '…' : '') + '</code>' +
          (keys.indexOf('decisions') > -1
            ? '<br>Reasoning will appear in the Thinking stream.'
            : '<br>No <code>decisions</code> region — status only, no reasoning.');
        if (!$('#addName').value) {
          try { $('#addName').value = new URL(url).pathname.replace(/\//g, ' ').trim() || 'New agent'; } catch (e) {}
        }
      })
      .catch(function (err) {
        probed = null;
        box.className = 'probe warn';
        box.innerHTML = '<strong>No readable feed</strong> (' + esc(err.message) + ').<br>' +
          'It will still be added as a link tile — the dashboard opens and embeds normally, ' +
          'but the console can\'t read its stats or reasoning.';
      });
  }

  var ACCENTS = ['#4f8cff', '#f7931a', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6'];

  function saveAgent() {
    var url = normUrl($('#addUrl').value);
    if (!url) { $('#addUrl').focus(); return; }
    var name = $('#addName').value.trim() || 'New agent';
    var id = slug(name);
    if (state.agents.some(function (a) { return a.id === id; })) id = id + '-' + Date.now().toString(36);

    addCustom({
      id: id, name: name, url: url,
      assetClass: $('#addClass').value.trim(),
      venue: $('#addVenue').value.trim(),
      mode: $('#addMode').value,
      accent: ACCENTS[state.agents.length % ACCENTS.length],
      links: []
    });
    closeModal();
    var agent = state.agents[state.agents.length - 1];
    fetchAgent(agent).then(function (res) {
      state.data[agent.id] = res;
      go('#/agent/' + agent.id);
      render();
    });
  }

  function exportRegistry() {
    var payload = {
      $comment: 'Exported from the Agent Console. Commit this over agents.json to make these agents permanent and visible on every device.',
      agents: state.agents.map(function (a) {
        return {
          id: a.id, name: a.name, tagline: a.tagline || '', url: a.url,
          assetClass: a.assetClass || '', venue: a.venue || '',
          mode: a.mode || 'paper', accent: a.accent || '#4f8cff', links: a.links || []
        };
      })
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'agents.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------------- theme + boot ---------------- */

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('#themeBtn').textContent = t === 'dark' ? 'Light' : 'Dark';
    writeJSON(K_THEME, t);
  }

  function wire() {
    $$('.nav-item[data-route]').forEach(function (b) {
      b.onclick = function () { go('#/' + b.dataset.route); };
    });
    $('#refreshBtn').onclick = function () {
      $('#refreshBtn').textContent = 'Refreshing…';
      refreshAll().then(function () { $('#refreshBtn').textContent = 'Refresh'; });
    };
    $('#themeBtn').onclick = function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    };
    $('#exportBtn').onclick = exportRegistry;
    $('#addAgentNav').onclick = openModal;
    $('#addCancel').onclick = closeModal;
    $('#addSave').onclick = saveAgent;
    $('#addUrl').onchange = probe;
    $('#addUrl').onblur = probe;
    $('#addModal').onclick = function (e) { if (e.target === $('#addModal')) closeModal(); };
    $('#menuToggle').onclick = function () { $('#sidebar').classList.toggle('is-open'); };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#addModal').hidden) closeModal();
    });
    window.addEventListener('hashchange', parseRoute);
  }

  applyTheme(readJSON(K_THEME, null) ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  wire();

  loadRegistry().then(function () {
    parseRoute();
    return refreshAll();
  }).then(function () {
    setInterval(refreshAll, REFRESH_MS);
  });
})();

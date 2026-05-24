(() => {
  const API_BASE_URL = (window.__API_BASE_URL__ || '').replace(/\/$/, '');

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text) {
    const el = $('status');
    if (!el) return;
    el.textContent = text || '';
  }

  async function apiGet(path) {
    if (!API_BASE_URL) throw new Error('API_BASE_URL não configurada');
    const url = `${API_BASE_URL}${path}`;
    const resp = await fetch(url, { method: 'GET' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = data?.message || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function apiPost(path, payload) {
    if (!API_BASE_URL) throw new Error('API_BASE_URL não configurada');
    const url = `${API_BASE_URL}${path}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = data?.message || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function formatIso(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderMarkdownToHtml(md) {
    // Renderização mínima e segura: escapa HTML e transforma headings/listas/código.
    const src = escapeHtml(md || '');

    // Code fences ```...```
    const withCode = src.replace(/```([\s\S]*?)```/g, (_m, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    const lines = withCode.split(/\r?\n/);
    let html = '';
    let inList = false;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        continue;
      }

      if (line.startsWith('<pre><code>')) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        html += line;
        continue;
      }

      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        html += `<h2>${h2[1]}</h2>`;
        continue;
      }

      const h3 = line.match(/^###\s+(.*)$/);
      if (h3) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        html += `<h3>${h3[1]}</h3>`;
        continue;
      }

      const li = line.match(/^[-*]\s+(.*)$/);
      if (li) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${li[1]}</li>`;
        continue;
      }

      if (inList) {
        html += '</ul>';
        inList = false;
      }

      html += `<p>${line}</p>`;
    }

    if (inList) html += '</ul>';

    // Link autolink (http/https) simples
    html = html.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
      const u = escapeHtml(m);
      return `<a class="link" href="${u}" target="_blank" rel="noreferrer">${u}</a>`;
    });

    return html;
  }

  function getQueryParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }

  function setHidden(id, hidden) {
    const el = $(id);
    if (!el) return;
    el.hidden = !!hidden;
  }

  // ----- Feed -----
  let nextCursor = null;

  function renderFeedItems(listEl, items) {
    for (const it of items || []) {
      const li = document.createElement('li');
      li.className = 'feed-item';

      const a = document.createElement('a');
      a.href = `./materia.html?id=${encodeURIComponent(it.id)}`;

      const h = document.createElement('h3');
      h.className = 'feed-title';
      h.textContent = it.title || it.id;

      const p = document.createElement('p');
      p.className = 'feed-summary';
      const when = it.publishedAt ? ` • ${formatIso(it.publishedAt)}` : '';
      p.textContent = `${it.briefSummary || ''}${when}`.trim();

      a.appendChild(h);
      a.appendChild(p);
      li.appendChild(a);
      listEl.appendChild(li);
    }
  }

  async function loadFeed({ reset } = { reset: false }) {
    const listEl = $('feedList');
    if (!listEl) return;

    if (reset) {
      listEl.innerHTML = '';
      nextCursor = null;
      setHidden('loadMoreBtn', true);
    }

    try {
      setStatus('Carregando feed...');
      const qs = new URLSearchParams();
      qs.set('limit', '20');
      if (nextCursor) qs.set('cursor', nextCursor);

      const data = await apiGet(`/feed?${qs.toString()}`);
      renderFeedItems(listEl, data.items);
      nextCursor = data.nextCursor || null;

      setHidden('loadMoreBtn', !nextCursor);
      setStatus(data.items?.length ? '' : 'Nenhuma matéria publicada ainda.');
    } catch (err) {
      setStatus(`Erro ao carregar feed: ${err.message || err}`);
    }
  }

  // ----- Matéria -----
  function renderPoll(pk, poll) {
    const card = $('pollCard');
    if (!card) return;

    if (!poll?.pergunta || !Array.isArray(poll?.opcoes)) {
      card.hidden = true;
      return;
    }

    card.hidden = false;

    const questionEl = $('pollQuestion');
    const optionsEl = $('pollOptions');
    const hintEl = $('pollHint');

    if (questionEl) questionEl.textContent = poll.pergunta;
    if (!optionsEl) return;

    const votedKey = `voto_${pk}`;
    const hasVoted = !!localStorage.getItem(votedKey);
    if (hintEl) {
      hintEl.textContent = hasVoted
        ? 'Você já votou nesta enquete.'
        : 'Escolha uma opção (1 voto por navegador).';
    }

    optionsEl.innerHTML = '';

    for (const opt of poll.opcoes || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.disabled = hasVoted;

      const label = opt?.texto ?? '';
      const votes = Number(opt?.votos ?? 0);
      btn.textContent = `${label} (${votes})`;

      if (!hasVoted) {
        btn.addEventListener('click', async () => {
          try {
            setStatus('Registrando voto...');
            optionsEl.querySelectorAll('button').forEach((b) => (b.disabled = true));

            const resp = await apiPost(`/materias/${encodeURIComponent(pk)}/voto`, {
              optionIndex: opt.index,
            });

            localStorage.setItem(votedKey, String(opt.index));
            renderPoll(pk, resp?.poll || poll);
            setStatus('Voto registrado.');
          } catch (err) {
            setStatus(`Erro ao votar: ${err.message || err}`);
            optionsEl.querySelectorAll('button').forEach((b) => (b.disabled = false));
          }
        });
      }

      optionsEl.appendChild(btn);
    }
  }

  async function loadMateria() {
    const id = getQueryParam('id');
    const idEl = $('materiaId');
    if (idEl) idEl.textContent = id || '';
    if (!id) {
      setStatus('Parâmetro "id" ausente na URL.');
      return;
    }

    try {
      setStatus('Carregando matéria...');
      const data = await apiGet(`/materias/${encodeURIComponent(id)}`);

      const titleEl = $('title');
      const metaEl = $('meta');
      const summaryEl = $('summary');
      const contentEl = $('content');

      const full = data.content || {};
      const displayTitle = full.title || data.title || id;
      const displaySummary = full.briefSummary || data.briefSummary || '';
      const displayDate = full.date || (data.publishedAt ? formatIso(data.publishedAt) : '');

      if (titleEl) titleEl.textContent = displayTitle;
      if (summaryEl) summaryEl.textContent = displaySummary;
      if (metaEl) metaEl.textContent = displayDate ? `Data: ${displayDate}` : '';

      if (contentEl) {
        const md = full.content || '';
        contentEl.innerHTML = renderMarkdownToHtml(md);
      }

      renderPoll(id, data.poll);
      setStatus('');
    } catch (err) {
      setStatus(`Erro ao carregar matéria: ${err.message || err}`);
    }
  }

  // ----- Tema -----
  function initTheme() {
    const root = document.documentElement;
    const current = localStorage.getItem('theme');
    
    if (current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.setAttribute('data-theme', 'light');
    }

    const btn = $('themeToggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const isDark = root.getAttribute('data-theme') === 'dark';
        const newTheme = isDark ? 'light' : 'dark';
        root.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
      });
    }
  }

  // ----- Bootstrap -----
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();

    const page = document.body?.dataset?.page;
    if (page === 'feed') {
      $('refreshBtn')?.addEventListener('click', () => loadFeed({ reset: true }));
      $('loadMoreBtn')?.addEventListener('click', () => loadFeed({ reset: false }));
      loadFeed({ reset: true });
      return;
    }

    if (page === 'materia') {
      loadMateria();
    }
  });
})();

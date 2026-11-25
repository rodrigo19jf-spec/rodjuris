// RodJuris — frontend (JavaScript puro, sem etapa de build).

// ───────────── utilitários ─────────────
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(caminho, { metodo = 'GET', corpo, limiteMs } = {}) {
  // Verificações no CNJ podem demorar; as demais chamadas desistem em 30 s.
  const lento = /verificar|diagnostico|consultar/.test(caminho);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limiteMs ?? (lento ? 90_000 : 30_000));
  let res;
  try {
    res = await fetch(`/api${caminho}`, {
      method: metodo,
      headers: corpo !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? 'O servidor demorou demais para responder. Tente de novo.' : 'Sem conexão com o servidor. Verifique sua internet e tente de novo.');
  } finally {
    clearTimeout(timer);
  }
  const dados = await res.json().catch(() => ({}));
  if (res.status === 401 && !caminho.startsWith('/auth')) {
    iniciar();
    throw new Error('Sessão expirada.');
  }
  if (!res.ok) throw new Error(dados.erro || `Erro ${res.status}`);
  return dados;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('visivel');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visivel'), 3500);
}

function formatarCnj(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length !== 20) return n || '';
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}`;
}
const fmtDataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const fmtData = (iso) => {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
  }
  return new Date(iso).toLocaleDateString('pt-BR');
};
const fmtHora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hmLocal = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function relativo(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  const txt = min < 60 ? `${min} min` : h < 48 ? `${h} h` : `${d} dias`;
  return diff >= 0 ? `em ${txt}` : `há ${txt}`;
}

const TIPOS = { lembrete: 'Lembrete', prazo: 'Prazo', audiencia: 'Audiência', reuniao: 'Reunião', outro: 'Outro' };
const STATUS = { ativo: 'Ativo', suspenso: 'Suspenso', encerrado: 'Encerrado' };
const ANTECEDENCIAS = [
  [0, 'Na hora'], [15, '15 minutos antes'], [30, '30 minutos antes'], [60, '1 hora antes'], [120, '2 horas antes'],
  [1440, '1 dia antes'], [2880, '2 dias antes'], [4320, '3 dias antes'], [10080, '1 semana antes'],
];
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SE SP TO'.split(' ');

const ICONES = {
  painel: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  processos: '<path d="M4 4h10l6 6v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6M7 14h10M7 18h6"/>',
  publicacoes: '<path d="M4 5h13a2 2 0 0 1 2 2v12a2 2 0 0 0 2-2V8M4 5v13a2 2 0 0 0 2 2h13M8 9h7M8 13h7M8 17h4"/>',
  agenda: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  lembretes: '<path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zM18 16V11a6 6 0 1 0-12 0v5l-2 2h16z"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sino: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  atualizar: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  voltar: '<path d="M15 18l-6-6 6-6"/>',
  esq: '<path d="M15 18l-6-6 6-6"/>',
  dir: '<path d="M9 18l6-6-6-6"/>',
};
const icone = (n) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[n]}</svg>`;

// ───────────── modal ─────────────
function abrirModal(titulo, htmlCorpo, { aoAbrir } = {}) {
  const raiz = $('#modal-raiz');
  raiz.innerHTML = `
    <div class="modal-fundo">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-titulo">
        <header><h2 id="modal-titulo">${esc(titulo)}</h2><button class="btn icone" data-fechar aria-label="Fechar">✕</button></header>
        ${htmlCorpo}
      </div>
    </div>`;
  const fundo = $('.modal-fundo', raiz);
  const fechar = () => (raiz.innerHTML = '');
  fundo.addEventListener('click', (e) => {
    if (e.target === fundo || e.target.closest('[data-fechar]')) fechar();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      fechar();
      document.removeEventListener('keydown', esc);
    }
  });
  aoAbrir?.($('.modal', raiz), fechar);
  $('input, select, textarea', raiz)?.focus();
  return fechar;
}

function confirmar(mensagem) {
  return new Promise((ok) => {
    abrirModal('Confirmar', `<p>${esc(mensagem)}</p><footer><button class="btn" data-fechar>Cancelar</button><button class="btn primario perigo-conf">Confirmar</button></footer>`, {
      aoAbrir: (m, fechar) => {
        $('.perigo-conf', m).onclick = () => {
          fechar();
          ok(true);
        };
      },
    });
  });
}

// ───────────── estado global ─────────────
let processosCache = [];
async function carregarProcessosCache() {
  processosCache = await api('/processos');
  return processosCache;
}

// ───────────── login ─────────────
async function iniciar() {
  const estado = await fetch('/api/auth/estado').then((r) => r.json());
  if (!estado.autenticado) return telaLogin(estado.configurado);
  montarShell();
  rotear();
}

function telaLogin(configurado) {
  $('#app').innerHTML = `
    <div class="login">
      <form class="card" id="form-login">
        <img src="/icons/icon.svg" alt="">
        <h1>RodJuris</h1>
        <p class="muted small" style="text-align:center">${configurado ? 'Digite sua senha para entrar.' : 'Primeiro acesso: crie uma senha para proteger seus dados.'}</p>
        <div class="campo"><label for="senha">Senha</label><input id="senha" type="password" autocomplete="${configurado ? 'current-password' : 'new-password'}" required minlength="${configurado ? 1 : 8}"></div>
        ${configurado ? '' : '<div class="campo"><label for="senha2">Repita a senha</label><input id="senha2" type="password" autocomplete="new-password" required minlength="8"><div class="ajuda">Mínimo de 8 caracteres.</div></div>'}
        <div id="erro-login" class="alerta-caixa erro" hidden></div>
        <button class="btn primario" style="width:100%;margin-top:.5rem">${configurado ? 'Entrar' : 'Criar senha e entrar'}</button>
      </form>
    </div>`;
  $('#senha').focus();
  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const senha = $('#senha').value;
    const caixa = $('#erro-login');
    caixa.hidden = true;
    try {
      if (!configurado && senha !== $('#senha2').value) throw new Error('As senhas não conferem.');
      await api(configurado ? '/auth/entrar' : '/auth/configurar', { metodo: 'POST', corpo: { senha } });
      iniciar();
    } catch (err) {
      caixa.textContent = err.message;
      caixa.hidden = false;
    }
  };
}

// ───────────── estrutura ─────────────
const MENU = [
  ['#/', 'painel', 'Painel'],
  ['#/processos', 'processos', 'Processos'],
  ['#/publicacoes', 'publicacoes', 'Publicações'],
  ['#/agenda', 'agenda', 'Agenda'],
  ['#/lembretes', 'lembretes', 'Lembretes'],
  ['#/config', 'config', 'Ajustes'],
];

function montarShell() {
  $('#app').innerHTML = `
    <div class="shell">
      <nav class="nav" aria-label="Menu principal">
        <div class="marca"><img src="/icons/icon.svg" alt="">RodJuris</div>
        ${MENU.map(([href, ic, nome]) => `<a href="${href}" data-rota="${ic}">${icone(ic)}<span>${nome}</span>${ic === 'publicacoes' ? '<span class="contador" id="cont-pub" hidden></span>' : ''}</a>`).join('')}
      </nav>
      <div class="principal">
        <header class="topo">
          <button class="btn icone" id="btn-voltar" hidden aria-label="Voltar">${icone('voltar')}</button>
          <h1 id="titulo-pagina"></h1>
          <div id="acoes-topo" class="acoes"></div>
          <button class="btn icone sino" id="btn-sino" aria-label="Avisos">${icone('sino')}<span class="contador" id="cont-sino" hidden></span></button>
        </header>
        <div id="painel-avisos" class="painel-avisos" hidden></div>
        <main class="conteudo" id="conteudo"></main>
      </div>
    </div>`;
  $('#btn-voltar').onclick = () => history.back();
  $('#btn-sino').onclick = alternarAvisos;
  document.addEventListener('click', (e) => {
    const p = $('#painel-avisos');
    if (p && !p.hidden && !e.target.closest('#painel-avisos') && !e.target.closest('#btn-sino')) p.hidden = true;
  });
  atualizarContadores();
  clearInterval(window.__contadores);
  window.__contadores = setInterval(atualizarContadores, 60_000);
}

async function atualizarContadores() {
  try {
    const [n, painel] = await Promise.all([api('/notificacoes'), api('/painel')]);
    const cs = $('#cont-sino');
    cs.hidden = !n.naoLidas;
    cs.textContent = n.naoLidas;
    const cp = $('#cont-pub');
    cp.hidden = !painel.publicacoesNaoLidas;
    cp.textContent = painel.publicacoesNaoLidas;
  } catch {
    /* offline */
  }
}

async function alternarAvisos() {
  const p = $('#painel-avisos');
  if (!p.hidden) return (p.hidden = true);
  const n = await api('/notificacoes');
  p.innerHTML = `
    <div class="secao-titulo" style="margin:.5rem 0"><h3 style="margin:0">Avisos</h3>
      ${n.naoLidas ? '<button class="btn pequeno" id="marcar-avisos">Marcar como lidos</button>' : ''}</div>
    ${n.itens.length ? `<ul class="lista">${n.itens.map((i) => `
      <li class="${i.lida ? '' : 'nao-lida'}"><a href="${esc(i.link || '#/')}">
        <div class="titulo" style="font-weight:600">${esc(i.titulo)}</div>
        ${i.mensagem ? `<div class="small muted">${esc(i.mensagem)}</div>` : ''}
        <div class="small muted">${fmtDataHora(i.criado_em)}</div></a></li>`).join('')}</ul>` : '<p class="vazio">Nenhum aviso ainda.</p>'}`;
  p.hidden = false;
  $('#marcar-avisos', p)?.addEventListener('click', async () => {
    await api('/notificacoes/marcar-lidas', { metodo: 'POST' });
    p.hidden = true;
    atualizarContadores();
  });
  $$('a', p).forEach((a) => a.addEventListener('click', () => (p.hidden = true)));
}

function definirTopo(titulo, { voltar = false, acoes = '' } = {}) {
  $('#titulo-pagina').textContent = titulo;
  document.title = `${titulo} · RodJuris`;
  $('#btn-voltar').hidden = !voltar;
  $('#acoes-topo').innerHTML = acoes;
}

// ───────────── roteador ─────────────
async function rotear() {
  if (!$('#conteudo')) return;
  const hash = location.hash.replace(/^#/, '') || '/';
  const partes = hash.split('?')[0].split('/').filter(Boolean);
  const raiz = partes[0] || 'painel';
  $$('.nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === (raiz === 'painel' ? 'painel' : raiz)));
  const c = $('#conteudo');
  c.innerHTML = '<div class="carregando">Carregando…</div>';
  $('#painel-avisos').hidden = true;
  try {
    if (raiz === 'painel') await telaPainel(c);
    else if (raiz === 'processos' && partes[1]) await telaProcesso(c, partes[1]);
    else if (raiz === 'processos') await telaProcessos(c);
    else if (raiz === 'publicacoes') await telaPublicacoes(c);
    else if (raiz === 'agenda') await telaAgenda(c);
    else if (raiz === 'lembretes') await telaLembretes(c);
    else if (raiz === 'config') await telaConfig(c);
    else c.innerHTML = '<p class="vazio">Página não encontrada.</p>';
  } catch (err) {
    c.innerHTML = `<div class="alerta-caixa erro">${esc(err.message)}</div><p><button class="btn" id="tentar-de-novo">Tentar de novo</button></p>`;
    $('#tentar-de-novo')?.addEventListener('click', rotear);
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', rotear);

// ───────────── componentes compartilhados ─────────────
function htmlLembrete(l, { mostrarProcesso = true } = {}) {
  const atrasado = !l.concluido && new Date(l.data_hora) < new Date();
  return `
    <div class="lembrete-item tipo tipo-${esc(l.tipo)} ${atrasado ? 'atrasado' : ''} ${l.concluido ? 'concluido' : ''}">
      <div class="item-linha">
        <input type="checkbox" class="concluir" data-id="${l.id}" ${l.concluido ? 'checked' : ''} aria-label="Concluído" style="width:20px;height:20px;min-height:0;margin-top:2px">
        <div class="corpo">
          <div class="titulo">${esc(l.titulo)}</div>
          <div class="small quando">${esc(TIPOS[l.tipo] || 'Lembrete')} · ${fmtDataHora(l.data_hora)} <span class="muted">(${relativo(l.data_hora)})</span></div>
          ${mostrarProcesso && l.processo_numero ? `<div class="small"><a href="#/processos/${l.processo_id}">${esc(l.processo_titulo || formatarCnj(l.processo_numero))}</a></div>` : ''}
          ${l.descricao ? `<div class="small muted">${esc(l.descricao)}</div>` : ''}
        </div>
        <button class="btn pequeno editar-lembrete" data-id="${l.id}">Editar</button>
      </div>
    </div>`;
}

function ligarLembretes(raiz, lista, aoMudar) {
  $$('.concluir', raiz).forEach((cb) =>
    cb.addEventListener('change', async () => {
      await api(`/lembretes/${cb.dataset.id}`, { metodo: 'PUT', corpo: { concluido: cb.checked } });
      toast(cb.checked ? 'Lembrete concluído.' : 'Lembrete reaberto.');
      aoMudar();
    }),
  );
  $$('.editar-lembrete', raiz).forEach((b) =>
    b.addEventListener('click', () => formLembrete(lista.find((l) => String(l.id) === b.dataset.id), aoMudar)),
  );
}

function htmlPublicacao(p, { mostrarProcesso = true } = {}) {
  return `
    <li class="${p.lida ? '' : 'nao-lida'}" data-pub="${p.id}">
      <div class="item-linha">
        <div class="corpo">
          <div class="acoes small">
            <strong>${fmtData(p.data_disponibilizacao)}</strong>
            ${p.tribunal ? `<span class="badge">${esc(p.tribunal)}</span>` : ''}
            ${p.tipo ? `<span class="badge">${esc(p.tipo)}</span>` : ''}
            ${p.lida ? '' : '<span class="badge novo">Nova</span>'}
          </div>
          ${mostrarProcesso ? `<div class="small" style="margin-top:.25rem">${p.processo_id ? `<a href="#/processos/${p.processo_id}">${esc(p.processo_titulo || formatarCnj(p.numero_processo))}</a> · ` : ''}<span class="mono">${esc(formatarCnj(p.numero_processo))}</span>${p.processo_id ? '' : ' <span class="badge aviso">não cadastrado</span>'}</div>` : ''}
          ${p.orgao ? `<div class="small muted">${esc(p.orgao)}</div>` : ''}
          <div class="texto-publicacao recolhido">${esc(p.texto || '(sem texto)')}</div>
          <div class="acoes" style="margin-top:.5rem">
            <button class="btn pequeno expandir">Ler tudo</button>
            ${p.lida ? '' : `<button class="btn pequeno marcar-lida" data-id="${p.id}">Marcar como lida</button>`}
            ${p.link ? `<a class="btn pequeno" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Abrir no DJEN</a>` : ''}
            ${!p.processo_id && p.numero_processo ? `<button class="btn pequeno cadastrar-de-pub" data-numero="${esc(p.numero_processo)}">Cadastrar processo</button>` : ''}
          </div>
        </div>
      </div>
    </li>`;
}

function ligarPublicacoes(raiz, aoMudar) {
  $$('.expandir', raiz).forEach((b) =>
    b.addEventListener('click', () => {
      const t = $('.texto-publicacao', b.closest('li'));
      t.classList.toggle('recolhido');
      b.textContent = t.classList.contains('recolhido') ? 'Ler tudo' : 'Recolher';
    }),
  );
  $$('.marcar-lida', raiz).forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/publicacoes/${b.dataset.id}/lida`, { metodo: 'PUT', corpo: { lida: true } });
      atualizarContadores();
      aoMudar();
    }),
  );
  $$('.cadastrar-de-pub', raiz).forEach((b) => b.addEventListener('click', () => formProcesso({ numero: b.dataset.numero })));
}

// ───────────── painel ─────────────
async function telaPainel(c) {
  definirTopo('Painel', {
    acoes: `<button class="btn" id="verificar-agora">${icone('atualizar')}<span class="so-desktop">Verificar agora</span></button>`,
  });
  const d = await api('/painel');
  c.innerHTML = `
    <div class="grade grade-stats">
      <a class="card stat" href="#/processos"><div class="valor">${d.processosAtivos}</div><div class="rotulo">Processos ativos</div></a>
      <a class="card stat" href="#/processos"><div class="valor">${d.processosMonitorados}</div><div class="rotulo">Monitorados</div></a>
      <a class="card stat ${d.publicacoesNaoLidas ? 'alerta' : ''}" href="#/publicacoes"><div class="valor">${d.publicacoesNaoLidas}</div><div class="rotulo">Publicações novas</div></a>
      <a class="card stat ${d.lembretesAtrasados ? 'alerta' : ''}" href="#/lembretes"><div class="valor">${d.lembretesAtrasados}</div><div class="rotulo">Lembretes atrasados</div></a>
    </div>
    <p class="small muted" style="margin-top:.75rem">Última verificação automática: ${d.ultimaVerificacao ? `${fmtDataHora(d.ultimaVerificacao)} (${relativo(d.ultimaVerificacao)})` : 'ainda não realizada'}${d.andamentosNaoLidos ? ` · <a href="#/processos">${d.andamentosNaoLidos} andamento(s) novo(s)</a>` : ''}</p>
    <div class="grade grade-2">
      <section>
        <div class="secao-titulo"><h2>Próximos 7 dias</h2><button class="btn pequeno" id="novo-lembrete">${icone('mais')} Lembrete</button></div>
        <div class="pilha" id="lista-proximos">${d.proximos.length ? d.proximos.map((l) => htmlLembrete(l)).join('') : '<div class="card vazio">Nada agendado para os próximos dias.</div>'}</div>
      </section>
      <section>
        <div class="secao-titulo"><h2>Publicações não lidas</h2><a class="small" href="#/publicacoes">Ver todas</a></div>
        <div class="card">${d.publicacoes.length ? `<ul class="lista">${d.publicacoes.map((p) => `
          <li class="nao-lida"><a href="${p.processo_id ? `#/processos/${p.processo_id}` : '#/publicacoes'}" style="color:inherit;display:block">
            <div class="acoes small"><strong>${fmtData(p.data_disponibilizacao)}</strong>${p.tribunal ? `<span class="badge">${esc(p.tribunal)}</span>` : ''}${p.tipo ? `<span class="badge">${esc(p.tipo)}</span>` : ''}</div>
            <div class="small" style="font-weight:600">${esc(p.processo_titulo || formatarCnj(p.numero_processo))}</div>
            <div class="small muted recolhido" style="max-height:3em">${esc(p.texto)}</div></a></li>`).join('')}</ul>` : '<p class="vazio">Tudo em dia! Nenhuma publicação nova.</p>'}</div>
      </section>
    </div>`;
  ligarLembretes(c, d.proximos, () => telaPainel(c));
  $('#novo-lembrete').onclick = () => formLembrete(null, () => telaPainel(c));
  $('#verificar-agora').onclick = (e) => verificarAgora(e.currentTarget, () => telaPainel(c));
}

async function verificarAgora(botao, depois) {
  botao.disabled = true;
  toast('Consultando DJEN e DataJud… isso pode levar alguns minutos.');
  try {
    const r = await api('/verificar-agora', { metodo: 'POST' });
    toast(`${r.processos} processo(s) verificados: ${r.publicacoes} publicação(ões) e ${r.andamentos} andamento(s) novos.${r.erros.length ? ` ${r.erros.length} erro(s).` : ''}${r.pendentes ? ` Faltam ${r.pendentes} — clique de novo para continuar.` : ''}`);
    atualizarContadores();
    depois?.();
  } catch (err) {
    toast(err.message);
  } finally {
    botao.disabled = false;
  }
}

// ───────────── processos ─────────────
async function telaProcessos(c) {
  definirTopo('Processos', { acoes: `<button class="btn primario" id="novo-processo">${icone('mais')}<span class="so-desktop">Novo processo</span></button>` });
  $('#novo-processo').onclick = () => formProcesso();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  c.innerHTML = `
    <div class="filtros">
      <input type="search" id="busca" placeholder="Buscar por número, cliente, título…" value="${esc(params.get('q') || '')}" aria-label="Buscar">
      <select id="filtro-status" aria-label="Situação" style="width:auto">
        <option value="">Todas as situações</option>
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${params.get('status') === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <div id="lista-processos" class="grade grade-2"></div>`;
  const carregar = async () => {
    const q = $('#busca').value.trim();
    const status = $('#filtro-status').value;
    const lista = await api(`/processos?${new URLSearchParams({ q, status })}`);
    const alvo = $('#lista-processos');
    if (!lista.length) {
      alvo.innerHTML = `<div class="card vazio" style="grid-column:1/-1">${q || status ? 'Nenhum processo encontrado.' : 'Nenhum processo cadastrado ainda.<br><br><button class="btn primario" id="primeiro">Cadastrar meu primeiro processo</button>'}</div>`;
      $('#primeiro')?.addEventListener('click', () => formProcesso());
      return;
    }
    alvo.innerHTML = lista.map((p) => {
      const novos = p.pub_nao_lidas + p.and_nao_lidos;
      return `
      <a class="card processo-card" href="#/processos/${p.id}">
        <div class="topo-card">
          <div style="min-width:0">
            <div style="font-weight:600">${esc(p.titulo || p.cliente || 'Processo sem título')}</div>
            <div class="mono small muted">${esc(formatarCnj(p.numero))}</div>
          </div>
          ${novos ? `<span class="badge novo">${novos} nova(s)</span>` : ''}
        </div>
        <div class="acoes small" style="margin-top:.5rem">
          <span class="badge ${p.status === 'ativo' ? 'ok' : ''}">${STATUS[p.status]}</span>
          ${p.tribunal ? `<span class="badge">${esc(p.tribunal)}</span>` : ''}
          ${p.monitorar && p.status !== 'encerrado' ? '<span class="badge ok">Monitorado</span>' : '<span class="badge">Sem monitoramento</span>'}
          ${p.erro_verificacao ? '<span class="badge erro">Erro na verificação</span>' : ''}
          ${p.monitorar && p.datajud_pendente ? '<span class="badge aviso">Aguardando DataJud</span>' : ''}
        </div>
        ${p.cliente && p.titulo ? `<div class="small muted" style="margin-top:.35rem">Cliente: ${esc(p.cliente)}</div>` : ''}
        ${p.proximo_lembrete ? `<div class="small" style="margin-top:.25rem">Próximo compromisso: ${fmtDataHora(p.proximo_lembrete)}</div>` : ''}
      </a>`;
    }).join('');
  };
  let t;
  $('#busca').oninput = () => {
    clearTimeout(t);
    t = setTimeout(carregar, 250);
  };
  $('#filtro-status').onchange = carregar;
  await carregar();
}

function formProcesso(proc = null, aoSalvar) {
  const editando = !!proc?.id;
  const p = proc || {};
  abrirModal(editando ? 'Editar processo' : 'Novo processo', `
    <form id="form-proc">
      <div class="campo">
        <label for="f-numero">Número do processo (CNJ) *</label>
        <div class="acoes" style="flex-wrap:nowrap">
          <input id="f-numero" required inputmode="numeric" placeholder="0000000-00.0000.0.00.0000" value="${esc(formatarCnj(p.numero || ''))}">
          <button type="button" class="btn" id="buscar-datajud">Buscar dados</button>
        </div>
        <div class="ajuda" id="ajuda-numero">"Buscar dados" preenche tribunal, classe e vara pelo DataJud (CNJ).</div>
      </div>
      <div class="campo"><label for="f-titulo">Título / apelido</label><input id="f-titulo" placeholder="Ex.: Silva x Banco XYZ" value="${esc(p.titulo || '')}"></div>
      <div class="campos-2">
        <div class="campo"><label for="f-cliente">Cliente</label><input id="f-cliente" value="${esc(p.cliente || '')}"></div>
        <div class="campo"><label for="f-contraria">Parte contrária</label><input id="f-contraria" value="${esc(p.parte_contraria || '')}"></div>
      </div>
      <div class="campos-2">
        <div class="campo"><label for="f-tribunal">Tribunal</label><input id="f-tribunal" value="${esc(p.tribunal || '')}"></div>
        <div class="campo"><label for="f-orgao">Vara / órgão</label><input id="f-orgao" value="${esc(p.orgao || '')}"></div>
      </div>
      <div class="campos-2">
        <div class="campo"><label for="f-classe">Classe</label><input id="f-classe" value="${esc(p.classe || '')}"></div>
        <div class="campo"><label for="f-status">Situação</label><select id="f-status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(p.status || 'ativo') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="campo"><label for="f-assunto">Assunto</label><input id="f-assunto" value="${esc(p.assunto || '')}"></div>
      <div class="campo"><label for="f-obs">Observações</label><textarea id="f-obs">${esc(p.observacoes || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="f-monitorar" ${p.monitorar === 0 ? '' : 'checked'}> Monitorar publicações e andamentos e me avisar quando houver novidade</label>
      <div id="erro-proc" class="alerta-caixa erro" hidden style="margin-top:.75rem"></div>
      <footer><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button></footer>
    </form>`, {
    aoAbrir: (m, fechar) => {
      $('#buscar-datajud', m).onclick = async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        const ajuda = $('#ajuda-numero', m);
        ajuda.textContent = 'Consultando DataJud…';
        try {
          const d = await api('/processos/consultar', { metodo: 'POST', corpo: { numero: $('#f-numero', m).value } });
          const pre = (id, v) => { if (v && !$(id, m).value) $(id, m).value = v; };
          pre('#f-tribunal', d.tribunal);
          pre('#f-orgao', d.orgao);
          pre('#f-classe', d.classe);
          pre('#f-assunto', d.assunto);
          ajuda.textContent = `Encontrado: ${d.classe || ''} — ${d.orgao || ''}${d.movimentos[0] ? `. Último andamento: ${d.movimentos[0].nome} (${fmtData(d.movimentos[0].data)})` : ''}`;
        } catch (err) {
          ajuda.textContent = err.message;
        } finally {
          b.disabled = false;
        }
      };
      $('#form-proc', m).onsubmit = async (e) => {
        e.preventDefault();
        const corpo = {
          numero: $('#f-numero', m).value,
          titulo: $('#f-titulo', m).value,
          cliente: $('#f-cliente', m).value,
          parte_contraria: $('#f-contraria', m).value,
          tribunal: $('#f-tribunal', m).value,
          orgao: $('#f-orgao', m).value,
          classe: $('#f-classe', m).value,
          assunto: $('#f-assunto', m).value,
          status: $('#f-status', m).value,
          observacoes: $('#f-obs', m).value,
          monitorar: $('#f-monitorar', m).checked,
        };
        try {
          const salvo = await api(editando ? `/processos/${p.id}` : '/processos', { metodo: editando ? 'PUT' : 'POST', corpo });
          fechar();
          toast(editando ? 'Processo atualizado.' : 'Processo cadastrado. Buscando publicações e andamentos…');
          if (aoSalvar) aoSalvar(salvo);
          else location.hash = `#/processos/${salvo.id}`;
        } catch (err) {
          const caixa = $('#erro-proc', m);
          caixa.textContent = err.message;
          caixa.hidden = false;
        }
      };
    },
  });
}

async function telaProcesso(c, id, abaInicial) {
  const p = await api(`/processos/${id}`);
  definirTopo(p.titulo || formatarCnj(p.numero), {
    voltar: true,
    acoes: `<button class="btn" id="verificar">${icone('atualizar')}<span class="so-desktop">Verificar agora</span></button>`,
  });
  const naoLidasPub = p.publicacoes.filter((x) => !x.lida).length;
  const naoLidosAnd = p.andamentos.filter((x) => !x.lida).length;
  const aba = abaInicial || (naoLidosAnd && !naoLidasPub ? 'andamentos' : 'publicacoes');
  c.innerHTML = `
    <div class="card">
      <div class="secao-titulo" style="margin-top:0">
        <div><div class="mono">${esc(formatarCnj(p.numero))}</div>
          <div class="acoes small" style="margin-top:.35rem">
            <span class="badge ${p.status === 'ativo' ? 'ok' : ''}">${STATUS[p.status]}</span>
            ${p.monitorar && p.status !== 'encerrado' ? '<span class="badge ok">Monitorado</span>' : '<span class="badge">Sem monitoramento</span>'}
          </div></div>
        <div class="acoes"><button class="btn pequeno" id="editar">Editar</button><button class="btn pequeno perigo" id="excluir">Excluir</button></div>
      </div>
      <dl class="dados">
        ${[['Cliente', p.cliente], ['Parte contrária', p.parte_contraria], ['Tribunal', p.tribunal], ['Vara / órgão', p.orgao], ['Classe', p.classe], ['Assunto', p.assunto]]
          .filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>
      ${p.observacoes ? `<p class="small" style="white-space:pre-wrap;margin-bottom:0">${esc(p.observacoes)}</p>` : ''}
      <label class="check small" style="margin-top:.75rem"><input type="checkbox" id="monitorar" ${p.monitorar ? 'checked' : ''}> Monitorar e me avisar sobre novas publicações e andamentos</label>
      <p class="small muted" style="margin:.5rem 0 0">Última verificação: ${p.ultima_verificacao ? fmtDataHora(p.ultima_verificacao) : 'pendente'}</p>
      ${p.erro_verificacao ? `<div class="alerta-caixa erro small" style="margin-top:.5rem">${esc(p.erro_verificacao)}</div>` : ''}
      ${p.monitorar && p.datajud_pendente ? `<div class="alerta-caixa small" style="margin-top:.5rem">⏳ <strong>Andamentos aguardando o DataJud:</strong> o sistema do CNJ está instável. O app tenta de novo automaticamente a cada 20 minutos e preenche os dados assim que ele responder.${p.datajud_tentativa ? ` Última tentativa: ${fmtDataHora(p.datajud_tentativa)}.` : ''}</div>` : ''}
    </div>
    <div class="abas" role="tablist">
      <button data-aba="publicacoes">Publicações (${p.publicacoes.length})${naoLidasPub ? ` <span class="badge novo">${naoLidasPub}</span>` : ''}</button>
      <button data-aba="andamentos">Andamentos (${p.andamentos.length})${naoLidosAnd ? ` <span class="badge novo">${naoLidosAnd}</span>` : ''}</button>
      <button data-aba="lembretes">Prazos e lembretes (${p.lembretes.filter((l) => !l.concluido).length})</button>
    </div>
    <div id="conteudo-aba"></div>`;

  const mostrar = (nome) => {
    $$('.abas button', c).forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
    const alvo = $('#conteudo-aba', c);
    if (nome === 'publicacoes') {
      alvo.innerHTML = p.publicacoes.length
        ? `<div class="card"><ul class="lista">${p.publicacoes.map((x) => htmlPublicacao(x, { mostrarProcesso: false })).join('')}</ul></div>`
        : `<div class="card vazio">Nenhuma publicação encontrada no DJEN${p.ultima_verificacao ? '' : ' ainda (a primeira verificação pode levar alguns instantes)'}.</div>`;
      ligarPublicacoes(alvo, () => telaProcesso(c, id, 'publicacoes'));
    } else if (nome === 'andamentos') {
      alvo.innerHTML = p.andamentos.length
        ? `<div class="card"><ul class="lista">${p.andamentos.map((a) => `
            <li class="${a.lida ? '' : 'nao-lida'}"><div class="small muted">${fmtDataHora(a.data)}</div>
            <div style="font-weight:600">${esc(a.nome)} ${a.lida ? '' : '<span class="badge novo">Novo</span>'}</div>
            ${a.complemento ? `<div class="small muted">${esc(a.complemento)}</div>` : ''}</li>`).join('')}</ul></div>`
        : `<div class="card vazio">${p.datajud_em ? 'Nenhum andamento encontrado no DataJud.' : 'Ainda não foi possível consultar o DataJud (CNJ). Os andamentos aparecerão aqui assim que ele responder.'}</div>`;
    } else {
      alvo.innerHTML = `
        <div class="acoes" style="margin-bottom:.75rem"><button class="btn primario" id="novo-lemb-proc">${icone('mais')} Novo prazo / lembrete</button></div>
        <div class="pilha">${p.lembretes.length ? p.lembretes.map((l) => htmlLembrete(l, { mostrarProcesso: false })).join('') : '<div class="card vazio">Nenhum prazo ou lembrete para este processo.</div>'}</div>`;
      ligarLembretes(alvo, p.lembretes, () => telaProcesso(c, id, 'lembretes'));
      $('#novo-lemb-proc', alvo).onclick = () => formLembrete({ processo_id: p.id, tipo: 'prazo' }, () => telaProcesso(c, id, 'lembretes'));
    }
  };
  $$('.abas button', c).forEach((b) => (b.onclick = () => mostrar(b.dataset.aba)));
  mostrar(aba);

  $('#editar').onclick = () => formProcesso(p, () => telaProcesso(c, id));
  $('#excluir').onclick = async () => {
    if (!(await confirmar('Excluir este processo? As publicações e andamentos dele também serão removidos da lista do processo.'))) return;
    await api(`/processos/${id}`, { metodo: 'DELETE' });
    toast('Processo excluído.');
    location.hash = '#/processos';
  };
  $('#monitorar').onchange = async (e) => {
    await api(`/processos/${id}`, { metodo: 'PUT', corpo: { monitorar: e.target.checked } });
    toast(e.target.checked ? 'Monitoramento ativado.' : 'Monitoramento desativado.');
  };
  $('#verificar').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    toast('Consultando DJEN e DataJud…');
    try {
      const r = await api(`/processos/${id}/verificar`, { metodo: 'POST' });
      toast(r.erros.length ? `Concluído com erro: ${r.erros[0]}` : `${r.publicacoes} publicação(ões) e ${r.andamentos} andamento(s) novos.`);
      telaProcesso(c, id);
    } catch (err) {
      toast(err.message);
      b.disabled = false;
    }
  };

  // Ao abrir o processo, considera as novidades como vistas (o destaque continua até sair da tela).
  if (naoLidasPub || naoLidosAnd) {
    api(`/processos/${id}/marcar-lido`, { metodo: 'POST' }).then(atualizarContadores).catch(() => {});
  }
}

// ───────────── publicações ─────────────
async function telaPublicacoes(c) {
  definirTopo('Publicações', { acoes: '<button class="btn" id="marcar-todas">Marcar todas como lidas</button>' });
  c.innerHTML = `
    <div class="filtros">
      <input type="search" id="busca-pub" placeholder="Buscar no texto, número ou órgão…" aria-label="Buscar">
      <select id="filtro-lida" style="width:auto" aria-label="Filtro"><option value="0">Não lidas</option><option value="">Todas</option></select>
    </div>
    <div class="card"><ul class="lista" id="lista-pub"></ul><div id="mais-pub"></div></div>`;
  let offset = 0;
  const carregar = async (reiniciar = true) => {
    if (reiniciar) offset = 0;
    const r = await api(`/publicacoes?${new URLSearchParams({ q: $('#busca-pub').value, lida: $('#filtro-lida').value, offset, limite: 30 })}`);
    const ul = $('#lista-pub');
    const html = r.itens.map((p) => htmlPublicacao(p)).join('');
    if (reiniciar) ul.innerHTML = html || `<li class="vazio">${$('#filtro-lida').value === '0' ? 'Nenhuma publicação nova. 🎉' : 'Nenhuma publicação encontrada.'}</li>`;
    else ul.insertAdjacentHTML('beforeend', html);
    ligarPublicacoes(ul, () => carregar());
    offset += r.itens.length;
    $('#mais-pub').innerHTML = r.temMais ? '<button class="btn" id="carregar-mais" style="width:100%;margin-top:.5rem">Carregar mais</button>' : '';
    $('#carregar-mais')?.addEventListener('click', () => carregar(false));
  };
  let t;
  $('#busca-pub').oninput = () => {
    clearTimeout(t);
    t = setTimeout(carregar, 250);
  };
  $('#filtro-lida').onchange = () => carregar();
  $('#marcar-todas').onclick = async () => {
    await api('/publicacoes/marcar-todas', { metodo: 'POST' });
    toast('Todas marcadas como lidas.');
    atualizarContadores();
    carregar();
  };
  await carregar();
}

// ───────────── lembretes ─────────────
async function formLembrete(l = null, aoSalvar) {
  const editando = !!l?.id;
  const base = l || {};
  const quando = base.data_hora ? new Date(base.data_hora) : (() => { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d; })();
  if (base.data_inicial) {
    const [a, m, d] = base.data_inicial.split('-').map(Number);
    quando.setFullYear(a, m - 1, d);
    quando.setHours(9, 0, 0, 0);
  }
  if (!processosCache.length) await carregarProcessosCache().catch(() => {});
  const antAtual = base.antecedencia_min ?? (base.tipo === 'prazo' ? 1440 : 60);
  abrirModal(editando ? 'Editar lembrete' : 'Novo lembrete', `
    <form id="form-lemb">
      <div class="campo"><label for="l-titulo">Título *</label><input id="l-titulo" required maxlength="300" value="${esc(base.titulo || '')}" placeholder="Ex.: Prazo para contestação"></div>
      <div class="campos-2">
        <div class="campo"><label for="l-tipo">Tipo</label><select id="l-tipo">${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${(base.tipo || 'lembrete') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="campo"><label for="l-ant">Avisar</label><select id="l-ant">${ANTECEDENCIAS.map(([v, t]) => `<option value="${v}" ${antAtual === v ? 'selected' : ''}>${t}</option>`).join('')}${ANTECEDENCIAS.some(([v]) => v === antAtual) ? '' : `<option value="${antAtual}" selected>${antAtual} min antes</option>`}</select></div>
      </div>
      <div class="campos-2">
        <div class="campo"><label for="l-data">Data *</label><input id="l-data" type="date" required value="${ymdLocal(quando)}"></div>
        <div class="campo"><label for="l-hora">Hora *</label><input id="l-hora" type="time" required value="${hmLocal(quando)}"></div>
      </div>
      <div class="campo"><label for="l-proc">Processo (opcional)</label>
        <select id="l-proc"><option value="">— Nenhum —</option>${processosCache.map((p) => `<option value="${p.id}" ${String(base.processo_id || '') === String(p.id) ? 'selected' : ''}>${esc((p.titulo || p.cliente || 'Processo') + ' · ' + formatarCnj(p.numero))}</option>`).join('')}</select></div>
      <div class="campo"><label for="l-desc">Descrição</label><textarea id="l-desc">${esc(base.descricao || '')}</textarea></div>
      <div id="erro-lemb" class="alerta-caixa erro" hidden></div>
      <footer>
        ${editando ? '<button type="button" class="btn perigo" id="excluir-lemb" style="margin-right:auto">Excluir</button>' : ''}
        <button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button>
      </footer>
    </form>`, {
    aoAbrir: (m, fechar) => {
      $('#l-tipo', m).onchange = (e) => {
        if (!editando) $('#l-ant', m).value = e.target.value === 'prazo' ? '1440' : e.target.value === 'audiencia' ? '1440' : '60';
      };
      $('#excluir-lemb', m)?.addEventListener('click', async () => {
        await api(`/lembretes/${base.id}`, { metodo: 'DELETE' });
        fechar();
        toast('Lembrete excluído.');
        aoSalvar?.();
      });
      $('#form-lemb', m).onsubmit = async (e) => {
        e.preventDefault();
        const dataHora = new Date(`${$('#l-data', m).value}T${$('#l-hora', m).value}`);
        const corpo = {
          titulo: $('#l-titulo', m).value,
          tipo: $('#l-tipo', m).value,
          antecedencia_min: Number($('#l-ant', m).value),
          data_hora: dataHora.toISOString(),
          processo_id: $('#l-proc', m).value || null,
          descricao: $('#l-desc', m).value,
        };
        try {
          await api(editando ? `/lembretes/${base.id}` : '/lembretes', { metodo: editando ? 'PUT' : 'POST', corpo });
          fechar();
          toast('Lembrete salvo.');
          aoSalvar?.();
        } catch (err) {
          const caixa = $('#erro-lemb', m);
          caixa.textContent = err.message;
          caixa.hidden = false;
        }
      };
    },
  });
}

async function telaLembretes(c) {
  definirTopo('Lembretes e prazos', { acoes: `<button class="btn primario" id="novo-lemb">${icone('mais')}<span class="so-desktop">Novo lembrete</span></button>` });
  $('#novo-lemb').onclick = () => formLembrete(null, () => telaLembretes(c));
  const [pendentes, concluidos] = await Promise.all([
    api('/lembretes?concluido=0'),
    api(`/lembretes?concluido=1&de=${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}`),
  ]);
  const agora = new Date();
  const fimHoje = new Date(agora); fimHoje.setHours(23, 59, 59, 999);
  const grupos = [
    ['Atrasados', pendentes.filter((l) => new Date(l.data_hora) < agora)],
    ['Hoje', pendentes.filter((l) => new Date(l.data_hora) >= agora && new Date(l.data_hora) <= fimHoje)],
    ['Próximos', pendentes.filter((l) => new Date(l.data_hora) > fimHoje)],
  ];
  c.innerHTML = `
    ${grupos.map(([nome, lista]) => lista.length ? `<div class="secao-titulo"><h2>${nome} <span class="muted small">(${lista.length})</span></h2></div><div class="pilha">${lista.map((l) => htmlLembrete(l)).join('')}</div>` : '').join('')}
    ${pendentes.length ? '' : '<div class="card vazio">Nenhum lembrete pendente. Use “Novo lembrete” para cadastrar prazos, audiências e compromissos.</div>'}
    ${concluidos.length ? `<details style="margin-top:1.5rem"><summary class="muted">Concluídos nos últimos 30 dias (${concluidos.length})</summary><div class="pilha" style="margin-top:.75rem">${concluidos.reverse().map((l) => htmlLembrete(l)).join('')}</div></details>` : ''}`;
  ligarLembretes(c, [...pendentes, ...concluidos], () => telaLembretes(c));
}

// ───────────── agenda / calendário ─────────────
let mesAgenda = null;
let diaSelecionado = null;
async function telaAgenda(c) {
  definirTopo('Agenda', { acoes: `<button class="btn primario" id="novo-ag">${icone('mais')}<span class="so-desktop">Novo compromisso</span></button>` });
  if (!mesAgenda) {
    const h = new Date();
    mesAgenda = new Date(h.getFullYear(), h.getMonth(), 1);
  }
  if (!diaSelecionado) diaSelecionado = ymdLocal(new Date());
  const inicio = new Date(mesAgenda);
  inicio.setDate(1 - inicio.getDay());
  const fim = new Date(inicio);
  fim.setDate(fim.getDate() + 42);
  const eventos = await api(`/lembretes?${new URLSearchParams({ de: inicio.toISOString(), ate: fim.toISOString() })}`);
  const porDia = {};
  for (const e of eventos) (porDia[ymdLocal(new Date(e.data_hora))] ||= []).push(e);
  const hoje = ymdLocal(new Date());

  const dias = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(inicio);
    d.setDate(inicio.getDate() + i);
    const k = ymdLocal(d);
    const evs = porDia[k] || [];
    dias.push(`
      <button class="dia ${d.getMonth() !== mesAgenda.getMonth() ? 'fora' : ''} ${k === hoje ? 'hoje' : ''} ${k === diaSelecionado ? 'selecionado' : ''}" data-dia="${k}" aria-label="${d.toLocaleDateString('pt-BR', { dateStyle: 'full' })}${evs.length ? `, ${evs.length} compromisso(s)` : ''}">
        <span class="num">${d.getDate()}</span>
        ${evs.slice(0, 3).map((e) => `<span class="evento-chip tipo-${esc(e.tipo)} ${e.concluido ? 'feito' : ''}">${fmtHora(e.data_hora)} ${esc(e.titulo)}</span>`).join('')}
        ${evs.length > 3 ? `<span class="small muted">+${evs.length - 3}</span>` : ''}
        <span class="pontos">${evs.slice(0, 4).map((e) => `<span class="ponto tipo-${esc(e.tipo)}"></span>`).join('')}</span>
      </button>`);
  }
  const doDia = porDia[diaSelecionado] || [];
  const [a, m, d] = diaSelecionado.split('-').map(Number);
  const dataSel = new Date(a, m - 1, d);

  c.innerHTML = `
    <div class="cal-cabecalho">
      <button class="btn icone" id="mes-ant" aria-label="Mês anterior">${icone('esq')}</button>
      <h2>${(() => { const t = mesAgenda.toLocaleDateString('pt-BR', { month: 'long' }); return t[0].toUpperCase() + t.slice(1); })()} de ${mesAgenda.getFullYear()}</h2>
      <button class="btn pequeno" id="mes-hoje">Hoje</button>
      <button class="btn icone" id="mes-prox" aria-label="Próximo mês">${icone('dir')}</button>
    </div>
    <div class="calendario">
      ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((n) => `<div class="dia-semana">${n}</div>`).join('')}
      ${dias.join('')}
    </div>
    <div class="legenda">${Object.entries(TIPOS).map(([k, v]) => `<span><span class="ponto tipo-${k}"></span>${v}</span>`).join('')}</div>
    <div class="secao-titulo"><h2>${dataSel.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
      <button class="btn pequeno" id="add-dia">${icone('mais')} Adicionar neste dia</button></div>
    <div class="pilha" id="eventos-dia">${doDia.length ? doDia.map((l) => htmlLembrete(l)).join('') : '<div class="card vazio">Nenhum compromisso neste dia.</div>'}</div>`;

  const recarregar = () => telaAgenda(c);
  $('#mes-ant').onclick = () => { mesAgenda.setMonth(mesAgenda.getMonth() - 1); recarregar(); };
  $('#mes-prox').onclick = () => { mesAgenda.setMonth(mesAgenda.getMonth() + 1); recarregar(); };
  $('#mes-hoje').onclick = () => { mesAgenda = null; diaSelecionado = null; recarregar(); };
  $$('.dia', c).forEach((b) => (b.onclick = () => {
    diaSelecionado = b.dataset.dia;
    const [ya, ym] = diaSelecionado.split('-').map(Number);
    if (ym - 1 !== mesAgenda.getMonth()) mesAgenda = new Date(ya, ym - 1, 1);
    recarregar();
  }));
  $('#add-dia').onclick = () => formLembrete({ data_inicial: diaSelecionado }, recarregar);
  $('#novo-ag').onclick = () => formLembrete({ data_inicial: diaSelecionado }, recarregar);
  ligarLembretes($('#eventos-dia'), doDia, recarregar);
}

// ───────────── configurações ─────────────
async function telaConfig(c) {
  definirTopo('Configurações');
  const cfg = await api('/config');
  const pushSuportado = 'serviceWorker' in navigator && 'PushManager' in window;
  let inscrito = false;
  if (pushSuportado) {
    const reg = await navigator.serviceWorker.getRegistration();
    inscrito = !!(await reg?.pushManager.getSubscription());
  }
  c.innerHTML = `
    <div class="grade grade-2">
      <section class="card">
        <h2>Monitoramento</h2>
        <p class="small muted">Os processos marcados como “monitorados” são consultados automaticamente no <strong>DJEN</strong> (publicações e intimações) e no <strong>DataJud</strong> (andamentos), as APIs públicas do CNJ.</p>
        <form id="form-monit">
          <div class="campo"><label for="c-int">Verificar a cada</label>
            <select id="c-int">${[1, 2, 4, 6, 8, 12, 24].map((h) => `<option value="${h}" ${String(cfg.intervalo_horas) === String(h) ? 'selected' : ''}>${h} hora${h > 1 ? 's' : ''}</option>`).join('')}</select></div>
          <p class="small" style="margin-bottom:.25rem"><strong>Monitorar também pela minha OAB</strong> (opcional)</p>
          <p class="ajuda" style="margin-top:0">Avisa sobre qualquer publicação no DJEN em seu nome, mesmo de processos não cadastrados.</p>
          <div class="campos-2">
            <div class="campo"><label for="c-oab">Número OAB</label><input id="c-oab" inputmode="numeric" value="${esc(cfg.oab_numero)}" placeholder="123456"></div>
            <div class="campo"><label for="c-uf">UF</label><select id="c-uf"><option value="">—</option>${UFS.map((u) => `<option ${cfg.oab_uf === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
          </div>
          <div class="acoes"><button class="btn primario">Salvar</button><button type="button" class="btn" id="verif-agora">${icone('atualizar')} Verificar agora</button></div>
          <p class="small muted" style="margin-bottom:0">Última verificação: ${cfg.ultima_verificacao_geral ? fmtDataHora(cfg.ultima_verificacao_geral) : 'ainda não realizada'}</p>
          ${cfg.serverless ? `<p class="small" style="margin:.25rem 0 0">Agendador automático: ${
            !cfg.agendador_configurado ? '<span class="badge erro">não configurado</span> — defina a variável CRON_SECRET na Vercel (veja o README).'
            : cfg.ultimo_ciclo && Date.now() - new Date(cfg.ultimo_ciclo).getTime() < 30 * 60000 ? `<span class="badge ok">funcionando</span> <span class="muted">(última execução ${relativo(cfg.ultimo_ciclo)})</span>`
            : `<span class="badge aviso">sem execuções recentes</span> <span class="muted">${cfg.ultimo_ciclo ? '(última ' + relativo(cfg.ultimo_ciclo) + ')' : ''} — confira o cron-job.org.</span>`
          }</p>` : ''}
        </form>
        <hr style="border:0;border-top:1px solid var(--border);margin:1rem 0">
        <p class="small" style="margin-bottom:.5rem"><strong>Conexão com o CNJ</strong></p>
        <button type="button" class="btn" id="testar-cnj">Testar conexão com o CNJ</button>
        <ul class="lista small" id="resultado-cnj" style="margin-top:.5rem"></ul>
      </section>

      <section class="card">
        <h2>Notificações no celular</h2>
        ${pushSuportado ? `
          <p class="small muted">Receba alertas mesmo com o app fechado. No iPhone, primeiro adicione o app à Tela de Início (Compartilhar → Adicionar à Tela de Início) e abra por lá.</p>
          <p class="small">Este aparelho: ${inscrito ? '<span class="badge ok">ativado</span>' : '<span class="badge">desativado</span>'} · Aparelhos cadastrados: ${cfg.push_inscricoes}</p>
          <div class="acoes">
            ${inscrito ? '<button class="btn" id="push-off">Desativar neste aparelho</button>' : '<button class="btn primario" id="push-on">Ativar neste aparelho</button>'}
            <button class="btn" id="push-teste" ${cfg.push_inscricoes ? '' : 'disabled'}>Enviar teste</button>
          </div>
          ${location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? '<div class="alerta-caixa small" style="margin-top:.75rem">As notificações push só funcionam com HTTPS. Veja o README para publicar o app com HTTPS.</div>' : ''}
        ` : '<div class="alerta-caixa small">Este navegador não suporta notificações push.</div>'}
      </section>

      <section class="card">
        <h2>Avisos por e-mail</h2>
        ${cfg.email_via_env ? '<div class="alerta-caixa info small" style="margin-bottom:.75rem">O servidor de e-mail está definido pelas variáveis de ambiente (.env); os campos abaixo são ignorados.</div>' : ''}
        <form id="form-email">
          <label class="check" style="margin-bottom:.75rem"><input type="checkbox" id="e-ativo" ${cfg.email_ativo === '1' ? 'checked' : ''}> Enviar avisos por e-mail</label>
          <div class="campo"><label for="e-dest">Enviar para</label><input id="e-dest" type="email" value="${esc(cfg.email_destino)}" placeholder="voce@exemplo.com"></div>
          <div class="campos-2">
            <div class="campo"><label for="e-host">Servidor SMTP</label><input id="e-host" value="${esc(cfg.smtp_host)}" placeholder="smtp.gmail.com"></div>
            <div class="campo"><label for="e-port">Porta</label><input id="e-port" inputmode="numeric" value="${esc(cfg.smtp_port || '587')}"></div>
          </div>
          <div class="campos-2">
            <div class="campo"><label for="e-user">Usuário</label><input id="e-user" autocomplete="off" value="${esc(cfg.smtp_usuario)}"></div>
            <div class="campo"><label for="e-pass">Senha${cfg.smtp_senha_definida ? ' (já definida)' : ''}</label><input id="e-pass" type="password" autocomplete="new-password" placeholder="${cfg.smtp_senha_definida ? '••••••••' : ''}"></div>
          </div>
          <div class="campo"><label for="e-from">Remetente (opcional)</label><input id="e-from" value="${esc(cfg.smtp_remetente)}" placeholder="RodJuris &lt;voce@exemplo.com&gt;"></div>
          <label class="check small" style="margin-bottom:.75rem"><input type="checkbox" id="e-seguro" ${cfg.smtp_seguro === '1' ? 'checked' : ''}> Conexão SSL direta (porta 465)</label>
          <p class="ajuda">Gmail: use smtp.gmail.com, porta 587 e uma “senha de app” (Conta Google → Segurança → Senhas de app).</p>
          <div class="acoes"><button class="btn primario">Salvar</button><button type="button" class="btn" id="email-teste">Enviar e-mail de teste</button></div>
        </form>
      </section>

      <section class="card">
        <h2>Segurança</h2>
        <form id="form-senha">
          <div class="campo"><label for="s-atual">Senha atual</label><input id="s-atual" type="password" autocomplete="current-password" required></div>
          <div class="campo"><label for="s-nova">Nova senha</label><input id="s-nova" type="password" autocomplete="new-password" minlength="8" required></div>
          <div class="acoes"><button class="btn">Trocar senha</button><button type="button" class="btn perigo" id="sair">Sair</button></div>
        </form>
      </section>
    </div>`;

  $('#form-monit').onsubmit = async (e) => {
    e.preventDefault();
    await api('/config', { metodo: 'PUT', corpo: { intervalo_horas: $('#c-int').value, oab_numero: $('#c-oab').value, oab_uf: $('#c-uf').value } });
    toast('Configurações salvas.');
  };
  $('#verif-agora').onclick = (e) => verificarAgora(e.currentTarget, () => telaConfig(c));
  $('#testar-cnj').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    $('#resultado-cnj').innerHTML = '<li class="muted">Testando… pode levar até 1 minuto.</li>';
    try {
      const r = await api('/diagnostico', { metodo: 'POST', corpo: {} });
      $('#resultado-cnj').innerHTML = r.map((x) => `<li>${x.ok ? '✅' : '❌'} <strong>${esc(x.fonte)}:</strong> ${esc(x.mensagem)}</li>`).join('');
    } catch (err) {
      $('#resultado-cnj').innerHTML = `<li>❌ ${esc(err.message)}</li>`;
    } finally {
      b.disabled = false;
    }
  };
  const salvarEmail = () =>
    api('/config', {
      metodo: 'PUT',
      corpo: {
        email_ativo: $('#e-ativo').checked ? '1' : '0',
        email_destino: $('#e-dest').value,
        smtp_host: $('#e-host').value,
        smtp_port: $('#e-port').value,
        smtp_usuario: $('#e-user').value,
        smtp_senha: $('#e-pass').value,
        smtp_remetente: $('#e-from').value,
        smtp_seguro: $('#e-seguro').checked ? '1' : '0',
      },
    });
  $('#form-email').onsubmit = async (e) => {
    e.preventDefault();
    await salvarEmail();
    toast('Configurações de e-mail salvas.');
  };
  $('#email-teste').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try {
      await salvarEmail();
      await api('/config/testar-email', { metodo: 'POST' });
      toast('E-mail de teste enviado! Confira sua caixa de entrada.');
    } catch (err) {
      toast(err.message);
    } finally {
      e.currentTarget.disabled = false;
    }
  };
  $('#push-on')?.addEventListener('click', async () => {
    try {
      await ativarPush();
      toast('Notificações ativadas neste aparelho.');
      telaConfig(c);
    } catch (err) {
      toast(err.message);
    }
  });
  $('#push-off')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api('/push/cancelar', { metodo: 'POST', corpo: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    toast('Notificações desativadas neste aparelho.');
    telaConfig(c);
  });
  $('#push-teste')?.addEventListener('click', async () => {
    const r = await api('/push/testar', { metodo: 'POST' });
    toast(`Teste enviado para ${r.enviados} aparelho(s).`);
  });
  $('#form-senha').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/auth/trocar-senha', { metodo: 'POST', corpo: { atual: $('#s-atual').value, nova: $('#s-nova').value } });
      toast('Senha alterada.');
      e.target.reset();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#sair').onclick = async () => {
    await api('/auth/sair', { metodo: 'POST' });
    location.hash = '#/';
    iniciar();
  };
}

function base64UrlParaUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function ativarPush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permissão de notificação negada no navegador.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/chave');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlParaUint8(publicKey) });
  await api('/push/inscrever', { metodo: 'POST', corpo: sub.toJSON() });
}

// ───────────── início ─────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
iniciar();

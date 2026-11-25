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
const LIMINAR = {
  deferida: 'Liminar deferida',
  indeferida: 'Liminar indeferida',
  nao_analisada: 'Liminar não analisada',
  nao_requerida: 'Não requerida liminar',
};
const CLASSE_LIMINAR = { deferida: 'ok', indeferida: 'erro', nao_analisada: 'aviso', nao_requerida: '' };
const seloLiminar = (v) => (v && LIMINAR[v] ? `<span class="badge ${CLASSE_LIMINAR[v]}">${LIMINAR[v]}</span>` : '');
const CUMPRIMENTO = {
  pendente: 'Pendente de cumprimento',
  andamento: 'Cumprimento em andamento',
  parcial: 'Cumprida parcialmente',
  cumprida: 'Cumprida',
};
const CATEGORIAS_PROV = {
  envio: 'Envio a setor',
  solicitacao: 'Solicitação/ofício',
  cumprimento: 'Cumprimento de decisão',
  audiencia: 'Audiência',
  reuniao: 'Reunião',
  peticao: 'Petição/manifestação',
  outro: 'Outro',
};

let filtroProv = ''; // filtro por tipo na aba Providências

function htmlProvidencias(lista, { acoes = true } = {}) {
  if (!lista.length) return '<p class="small muted">Nenhuma providência registrada ainda.</p>';
  const hoje = ymdLocal(new Date());
  return `<ul class="lista">${lista.map((pr) => `<li class="item-linha">
    <div class="corpo">
      <div class="acoes small">
        <strong>${fmtData(pr.data)}${pr.hora ? ` ${esc(pr.hora)}` : ''}</strong>
        <span class="badge">${esc(CATEGORIAS_PROV[pr.categoria] || 'Providência')}</span>
        ${pr.data > hoje ? '<span class="badge aviso">Agendada</span>' : ''}
        ${pr.lembrete_id ? `<span class="badge ok" title="Lembrete criado">🔔 ${fmtDataHora(pr.lembrete_data_hora)}</span>` : ''}
      </div>
      <div style="white-space:pre-line;margin-top:.15rem">${esc(pr.descricao)}</div>
    </div>
    ${acoes ? `<div class="acoes" style="flex-wrap:nowrap">
      <button class="btn pequeno editar-prov" data-id="${pr.id}">Editar</button>
      <button class="btn pequeno perigo excluir-prov" data-id="${pr.id}" aria-label="Excluir providência">✕</button>
    </div>` : ''}
  </li>`).join('')}</ul>`;
}

/** Formulário (janela) para registrar ou editar uma providência. */
function formProvidencia(processoId, pr = null, aoSalvar, { categoria = 'envio' } = {}) {
  const editando = !!pr?.id;
  const base = pr || { data: ymdLocal(new Date()), categoria };
  abrirModal(editando ? 'Editar providência' : 'Registrar providência', `
    <form id="form-providencia">
      <div class="campos-2">
        <div class="campo"><label for="pv-data">Data *</label><input type="date" id="pv-data" required value="${esc(base.data)}"></div>
        <div class="campo"><label for="pv-hora">Hora (opcional)</label><input type="time" id="pv-hora" value="${esc(base.hora || '')}"></div>
      </div>
      <div class="campo"><label for="pv-cat">Tipo</label>
        <select id="pv-cat">${Object.entries(CATEGORIAS_PROV).map(([k, v]) => `<option value="${k}" ${(base.categoria || 'outro') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="campo"><label for="pv-desc">Descrição *</label>
        <textarea id="pv-desc" required maxlength="2000" placeholder="Ex.: Enviado memorando à DPGF solicitando o cumprimento da decisão (SEI doc. 12345678)">${esc(base.descricao || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="pv-lembrar" ${base.lembrete_id ? 'checked' : ''}> Criar lembrete nesta data</label>
      <p class="ajuda" id="pv-ajuda">Útil para audiências, reuniões e retornos agendados. Sem hora, o aviso fica para as 9h.</p>
      <div id="erro-pv" class="alerta-caixa erro" hidden></div>
      <footer><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button></footer>
    </form>`, {
    aoAbrir: (m, fechar) => {
      const sugerirLembrete = () => {
        if (editando) return;
        const futura = $('#pv-data', m).value > ymdLocal(new Date());
        const agenda = ['audiencia', 'reuniao'].includes($('#pv-cat', m).value);
        $('#pv-lembrar', m).checked = futura || (agenda && $('#pv-data', m).value >= ymdLocal(new Date()));
      };
      $('#pv-data', m).onchange = sugerirLembrete;
      $('#pv-cat', m).onchange = sugerirLembrete;
      $('#form-providencia', m).onsubmit = async (e) => {
        e.preventDefault();
        const corpo = {
          data: $('#pv-data', m).value,
          hora: $('#pv-hora', m).value || null,
          categoria: $('#pv-cat', m).value,
          descricao: $('#pv-desc', m).value,
          lembrar: $('#pv-lembrar', m).checked,
        };
        try {
          await api(editando ? `/providencias/${pr.id}` : `/processos/${processoId}/providencias`, { metodo: editando ? 'PUT' : 'POST', corpo });
          fechar();
          toast(editando ? 'Providência atualizada.' : 'Providência registrada.');
          aoSalvar?.();
        } catch (err) {
          const caixa = $('#erro-pv', m);
          caixa.textContent = err.message;
          caixa.hidden = false;
        }
      };
    },
  });
}

function ligarProvidencias(raiz, processoId, lista, aoMudar) {
  $$('.editar-prov', raiz).forEach((b) =>
    b.addEventListener('click', () => formProvidencia(processoId, lista.find((x) => String(x.id) === b.dataset.id), aoMudar)),
  );
  $$('.excluir-prov', raiz).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmar('Excluir esta providência? O lembrete ligado a ela (se houver) também será removido.'))) return;
      await api(`/providencias/${b.dataset.id}`, { metodo: 'DELETE' });
      toast('Providência excluída.');
      aoMudar();
    }),
  );
}

async function copiarTexto(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

const AVISO_AUDIENCIA = [[60, '1 hora antes'], [120, '2 horas antes'], [1440, '1 dia antes'], [2880, '2 dias antes'], [10080, '1 semana antes']];

/** "hoje às 14:00", "amanhã", "10/12/2026 às 09:30" */
function textoDataHora(data, hora) {
  const hoje = ymdLocal(new Date());
  const amanha = ymdLocal(new Date(Date.now() + 86_400_000));
  const dia = data === hoje ? 'hoje' : data === amanha ? 'amanhã' : fmtData(data);
  return `${dia}${hora ? ` às ${hora}` : ''}`;
}
/** Etiqueta da próxima audiência do processo (vinda do menu Audiências). */
function seloAudiencia(p) {
  if (!p.proxima_audiencia) return '';
  const [data, hora] = p.proxima_audiencia.split(' ');
  const urgente = data <= ymdLocal(new Date(Date.now() + 86_400_000));
  return `<span class="badge ${urgente ? 'erro' : 'audiencia'}" title="Audiência agendada (veja o menu Audiências)">🗓 Audiência ${textoDataHora(data, hora)}</span>`;
}

const cumprimentoAberto = (p) => p.liminar === 'deferida' && ['pendente', 'andamento', 'parcial'].includes(p.cumprimento_situacao);
function seloCumprimento(p) {
  if (p.liminar !== 'deferida' || !p.cumprimento_situacao) return '';
  if (p.cumprimento_situacao === 'cumprida') {
    return `<span class="badge ok">✓ Liminar cumprida${p.cumprimento_data ? ` em ${fmtData(p.cumprimento_data)}` : ''}</span>`;
  }
  const hoje = ymdLocal(new Date());
  const vencida = p.cumprimento_prazo && p.cumprimento_prazo < hoje;
  const prazo = p.cumprimento_prazo ? ` · ${vencida ? 'venceu' : p.cumprimento_prazo === hoje ? 'vence hoje' : 'vence'} ${p.cumprimento_prazo === hoje ? '' : fmtData(p.cumprimento_prazo)}` : '';
  return `<span class="badge ${vencida ? 'erro' : 'aviso'}">${CUMPRIMENTO[p.cumprimento_situacao]}${prazo}</span>`;
}
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
  audiencias: '<path d="M12 3v3M5 21h14M7 21V11h10v10M4 11h16L12 6z"/>',
  anotacoes: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
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
        <p class="login-sub">Gestão jurídica</p>
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
  // [endereço, ícone, nome, nome curto (menu inferior do celular)]
  ['#/', 'painel', 'Painel', 'Painel'],
  ['#/processos', 'processos', 'Processos', 'Processos'],
  ['#/publicacoes', 'publicacoes', 'Publicações', 'Publ.'],
  ['#/agenda', 'agenda', 'Agenda', 'Agenda'],
  ['#/lembretes', 'lembretes', 'Lembretes', 'Lembr.'],
  ['#/audiencias', 'audiencias', 'Audiências', 'Audiên.'],
  ['#/anotacoes', 'anotacoes', 'Anotações', 'Notas'],
  ['#/config', 'config', 'Ajustes', 'Ajustes'],
];

function montarShell() {
  $('#app').innerHTML = `
    <div class="shell">
      <nav class="nav" aria-label="Menu principal">
        <div class="marca"><img src="/icons/icon.svg" alt=""><div><div class="marca-nome">RodJuris</div><div class="marca-sub">Gestão jurídica</div></div></div>
        ${MENU.map(([href, ic, nome, curto]) => `<a href="${href}" data-rota="${ic}" title="${nome}"${ic === 'config' ? ' class="so-desktop-nav"' : ''}>${icone(ic)}<span class="rotulo-longo">${nome}</span><span class="rotulo-curto">${curto}</span>${ic === 'publicacoes' ? '<span class="contador" id="cont-pub" hidden></span>' : ''}</a>`).join('')}
      </nav>
      <div class="principal">
        <header class="topo">
          <button class="btn icone" id="btn-voltar" hidden aria-label="Voltar">${icone('voltar')}</button>
          <h1 id="titulo-pagina"></h1>
          <div id="acoes-topo" class="acoes"></div>
          <a class="btn icone so-celular" href="#/config" aria-label="Ajustes">${icone('config')}</a>
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
    else if (raiz === 'processos' && partes[1]) await telaProcesso(c, partes[1], new URLSearchParams(hash.split('?')[1] || '').get('aba') || undefined);
    else if (raiz === 'processos') await telaProcessos(c);
    else if (raiz === 'publicacoes') await telaPublicacoes(c);
    else if (raiz === 'agenda') await telaAgenda(c);
    else if (raiz === 'lembretes') await telaLembretes(c);
    else if (raiz === 'anotacoes') await telaAnotacoes(c);
    else if (raiz === 'audiencias') await telaAudiencias(c);
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
          <div class="titulo">${esc(l.titulo)} ${l.sugerido ? '<span class="badge aviso">Sugestão — confirme a data</span>' : ''}</div>
          <div class="small quando">${esc(TIPOS[l.tipo] || 'Lembrete')} · ${fmtDataHora(l.data_hora)} <span class="muted">(${relativo(l.data_hora)})</span></div>
          ${mostrarProcesso && l.processo_numero ? `<div class="small"><a href="#/processos/${l.processo_id}">${esc(l.processo_titulo || formatarCnj(l.processo_numero))}</a></div>` : ''}
          ${l.descricao ? `<div class="small muted" style="white-space:pre-line">${esc(l.descricao)}</div>` : ''}
        </div>
        <div class="acoes" style="flex-direction:column;align-items:stretch;gap:.35rem">
          ${l.sugerido ? `<button class="btn pequeno primario confirmar-lembrete" data-id="${l.id}">Confirmar</button>` : ''}
          <button class="btn pequeno editar-lembrete" data-id="${l.id}">Editar</button>
        </div>
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
  $$('.confirmar-lembrete', raiz).forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/lembretes/${b.dataset.id}`, { metodo: 'PUT', corpo: { sugerido: false } });
      toast('Prazo confirmado.');
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
    <div class="saudacao">
      <div class="saudacao-titulo">${(() => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; })()}!</div>
      <div class="muted">${(() => { const t = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); })()}</div>
    </div>
    <div class="grade grade-stats">
      <a class="card stat cor-azul" href="#/processos"><span class="stat-icone">${icone('processos')}</span><div><div class="valor">${d.processosAtivos}</div><div class="rotulo">Processos ativos</div></div></a>
      <a class="card stat cor-verde" href="#/processos"><span class="stat-icone">${icone('atualizar')}</span><div><div class="valor">${d.processosMonitorados}</div><div class="rotulo">Monitorados</div></div></a>
      <a class="card stat cor-roxo ${d.andamentosNaoLidos ? 'alerta' : ''}" href="#andamentos-novos"><span class="stat-icone">${icone('processos')}</span><div><div class="valor">${d.andamentosNaoLidos}</div><div class="rotulo">Andamentos novos</div></div></a>
      <a class="card stat cor-dourado ${d.publicacoesNaoLidas ? 'alerta' : ''}" href="#/publicacoes"><span class="stat-icone">${icone('publicacoes')}</span><div><div class="valor">${d.publicacoesNaoLidas}</div><div class="rotulo">Publicações novas</div></div></a>
      <a class="card stat cor-vermelho ${d.lembretesAtrasados ? 'alerta' : ''}" href="#/lembretes"><span class="stat-icone">${icone('lembretes')}</span><div><div class="valor">${d.lembretesAtrasados}</div><div class="rotulo">Lembretes atrasados</div></div></a>
    </div>
    <p class="small muted" style="margin-top:.75rem">Última verificação automática: ${d.ultimaVerificacao ? `${fmtDataHora(d.ultimaVerificacao)} (${relativo(d.ultimaVerificacao)})` : 'ainda não realizada'}</p>
    ${d.avisosEproc?.length ? `<section class="card" style="margin-top:1rem;border-color:var(--warn)">
      <div class="secao-titulo" style="margin-top:0"><h2>⚖️ Intimações pendentes no eproc (${d.avisosEproc.length})</h2>
        <a class="btn pequeno" href="https://eproc1g.tjmg.jus.br/eproc/" target="_blank" rel="noopener">Abrir o eproc</a></div>
      <p class="small muted" style="margin-top:0">O RodJuris só lista: a ciência é registrada quando você abre a comunicação no eproc.</p>
      <ul class="lista">${d.avisosEproc.map((a) => `<li class="small"><strong>${esc({ I: 'Intimação', C: 'Citação', N: 'Notificação', V: 'Vista' }[a.tipo] || 'Comunicação')}</strong> ·
        ${a.processo_id ? `<a href="#/processos/${a.processo_id}">${esc(a.processo_titulo || formatarCnj(a.numero_processo))}</a>` : `<span class="mono">${esc(formatarCnj(a.numero_processo))}</span> <button class="btn pequeno cadastrar-de-pub" data-numero="${esc(a.numero_processo)}">Cadastrar</button>`}
        ${a.disponibilizado_em ? `<span class="muted"> · ${fmtDataHora(a.disponibilizado_em)}</span>` : ''}</li>`).join('')}</ul>
    </section>` : ''}
    ${d.audiencias?.length ? `<section class="card" style="margin-top:1rem;border-left:4px solid var(--t-audiencia)">
      <div class="secao-titulo" style="margin-top:0"><h2>🗓 Próximas audiências (${d.audiencias.length})</h2><a class="small" href="#/audiencias">Ver todas</a></div>
      <ul class="lista">${d.audiencias.map((a) => `<li class="small">
        <div class="acoes"><strong>${textoDataHora(a.data, a.hora)}</strong> · <span style="font-weight:600">${esc(nomeAudiencia(a))}</span></div>
        <div class="muted">${[a.descricao, a.sei ? `SEI ${a.sei}` : null].filter(Boolean).map(esc).join(' · ')}</div>
      </li>`).join('')}</ul>
    </section>` : ''}
    ${d.liminares?.length ? `<section class="card" style="margin-top:1rem;border-left:4px solid var(--warn)">
      <div class="secao-titulo" style="margin-top:0"><h2>📌 Liminares pendentes de cumprimento (${d.liminares.length})</h2>
        <a class="small" href="#/processos?cumprimento=pendente">Ver na lista</a></div>
      <ul class="lista">${d.liminares.map((l) => `<li class="small">
        <div class="acoes"><a href="#/processos/${l.id}" style="font-weight:600">${esc(l.titulo || l.cliente || formatarCnj(l.numero))}</a> ${seloCumprimento({ ...l, liminar: 'deferida' })}</div>
        <div class="muted">${l.cumprimento_responsavel ? `Responsável: ${esc(l.cumprimento_responsavel)} · ` : ''}${l.ultima_providencia ? `Última providência: ${fmtData(l.ultima_providencia)}` : 'Nenhuma providência registrada'}${l.cumprimento_multa ? ` · Multa: ${esc(l.cumprimento_multa)}` : ''}</div>
      </li>`).join('')}</ul>
    </section>` : ''}
    <div class="grade grade-2">
      <section>
        <div class="secao-titulo"><h2>Próximos 7 dias</h2><button class="btn pequeno" id="novo-lembrete">${icone('mais')} Lembrete</button></div>
        <div class="pilha" id="lista-proximos">${d.proximos.length ? d.proximos.map((l) => htmlLembrete(l)).join('') : '<div class="card vazio">Nada agendado para os próximos dias.</div>'}</div>
      </section>
      <section>
        <div class="secao-titulo" id="andamentos-novos"><h2>Andamentos novos ${d.andamentosNaoLidos ? `<span class="badge novo">${d.andamentosNaoLidos}</span>` : ''}</h2>
          ${d.andamentosNaoLidos ? '<button class="btn pequeno" id="marcar-andamentos">Marcar como vistos</button>' : ''}</div>
        <div class="card">${d.andamentosNovos?.length ? `<ul class="lista">${d.andamentosNovos.map((a) => `
          <li class="nao-lida"><a href="#/processos/${a.processo_id}?aba=andamentos" style="color:inherit;display:block">
            <div class="acoes small"><strong>${fmtDataHora(a.data)}</strong><span class="badge">${{ pje: 'PJe TJMG', eproc: 'eproc TJMG' }[a.fonte] || 'DataJud'}</span></div>
            <div style="font-weight:600">${esc(a.nome)}</div>
            <div class="small muted">${esc(a.processo_titulo || formatarCnj(a.processo_numero))}</div></a></li>`).join('')}</ul>
            ${d.andamentosNaoLidos > d.andamentosNovos.length ? `<p class="small muted" style="margin:.5rem 0 0">E mais ${d.andamentosNaoLidos - d.andamentosNovos.length} em outros processos.</p>` : ''}`
          : '<p class="vazio">Nenhum andamento novo.</p>'}</div>
        <div class="secao-titulo"><h2>Publicações não lidas</h2><a class="small" href="#/publicacoes">Ver todas</a></div>
        <div class="card">${d.publicacoes.length ? `<ul class="lista">${d.publicacoes.map((p) => `
          <li class="nao-lida"><a href="${p.processo_id ? `#/processos/${p.processo_id}` : '#/publicacoes'}" style="color:inherit;display:block">
            <div class="acoes small"><strong>${fmtData(p.data_disponibilizacao)}</strong>${p.tribunal ? `<span class="badge">${esc(p.tribunal)}</span>` : ''}${p.tipo ? `<span class="badge">${esc(p.tipo)}</span>` : ''}</div>
            <div class="small" style="font-weight:600">${esc(p.processo_titulo || formatarCnj(p.numero_processo))}</div>
            <div class="small muted recolhido" style="max-height:3em">${esc(p.texto)}</div></a></li>`).join('')}</ul>` : '<p class="vazio">Tudo em dia! Nenhuma publicação nova.</p>'}</div>
      </section>
    </div>`;
  ligarLembretes(c, d.proximos, () => telaPainel(c));
  $$('.cadastrar-de-pub', c).forEach((b) => b.addEventListener('click', () => formProcesso({ numero: b.dataset.numero })));
  $('#novo-lembrete').onclick = () => formLembrete(null, () => telaPainel(c));
  $('#marcar-andamentos')?.addEventListener('click', async () => {
    await api('/andamentos/marcar-todos', { metodo: 'POST' });
    toast('Andamentos marcados como vistos.');
    atualizarContadores();
    telaPainel(c);
  });
  $('a.stat[href="#andamentos-novos"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    $('#andamentos-novos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#verificar-agora').onclick = (e) => verificarAgora(e.currentTarget, () => telaPainel(c));
}

async function verificarAgora(botao, depois) {
  botao.disabled = true;
  toast('Consultando DJEN e DataJud… isso pode levar alguns minutos.');
  try {
    const r = await api('/verificar-agora', { metodo: 'POST' });
    toast(`${r.processos} processo(s) verificados: ${r.publicacoes} publicação(ões) e ${r.andamentos} andamento(s) novos${r.avisosEproc ? `, ${r.avisosEproc} intimação(ões) nova(s) no eproc` : ''}.${r.erros.length ? ` ${r.erros.length} erro(s).` : ''}${r.pendentes ? ` Faltam ${r.pendentes} — clique de novo para continuar.` : ''}`);
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
      <input type="search" id="busca" placeholder="Buscar por número, SEI, cliente, título…" value="${esc(params.get('q') || '')}" aria-label="Buscar">
      <select id="filtro-status" aria-label="Situação" style="width:auto">
        <option value="">Todas as situações</option>
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${params.get('status') === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <select id="filtro-liminar" aria-label="Liminar" style="width:auto">
        <option value="">Liminar: todas</option>
        ${Object.entries(LIMINAR).map(([k, v]) => `<option value="${k}" ${params.get('liminar') === k ? 'selected' : ''}>${v}</option>`).join('')}
        <option value="sem_info" ${params.get('liminar') === 'sem_info' ? 'selected' : ''}>Liminar: não informada</option>
      </select>
      <select id="filtro-cumprimento" aria-label="Cumprimento da liminar" style="width:auto">
        <option value="">Cumprimento: todos</option>
        <option value="pendente" ${params.get('cumprimento') === 'pendente' ? 'selected' : ''}>Cumprimento: pendente</option>
        <option value="cumprida" ${params.get('cumprimento') === 'cumprida' ? 'selected' : ''}>Cumprimento: cumprida</option>
      </select>
    </div>
    <div id="lista-processos" class="grade grade-2"></div>`;
  const carregar = async () => {
    const q = $('#busca').value.trim();
    const status = $('#filtro-status').value;
    const liminar = $('#filtro-liminar').value;
    const cumprimento = $('#filtro-cumprimento').value;
    const lista = await api(`/processos?${new URLSearchParams({ q, status, liminar, cumprimento })}`);
    const alvo = $('#lista-processos');
    if (!lista.length) {
      alvo.innerHTML = `<div class="card vazio" style="grid-column:1/-1">${q || status || liminar || cumprimento ? 'Nenhum processo encontrado.' : 'Nenhum processo cadastrado ainda.<br><br><button class="btn primario" id="primeiro">Cadastrar meu primeiro processo</button>'}</div>`;
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
          ${seloAudiencia(p)}
          ${seloLiminar(p.liminar)}
          ${seloCumprimento(p)}
          ${p.tribunal ? `<span class="badge">${esc(p.tribunal)}</span>` : ''}
          ${p.monitorar && p.status !== 'encerrado' ? '<span class="badge ok">Monitorado</span>' : '<span class="badge">Sem monitoramento</span>'}
          ${p.erro_verificacao ? '<span class="badge erro">Erro na verificação</span>' : ''}
          ${p.monitorar && p.datajud_pendente && p.pje_situacao !== 'ativo' && p.eproc_situacao !== 'ativo' ? '<span class="badge aviso">Aguardando DataJud</span>' : ''}
          ${p.pje_situacao === 'ativo' ? '<span class="badge ok">PJe TJMG</span>' : ''}
          ${p.eproc_situacao === 'ativo' ? '<span class="badge ok">eproc</span>' : ''}
        </div>
        ${p.cliente && p.titulo ? `<div class="small muted" style="margin-top:.35rem">Cliente: ${esc(p.cliente)}</div>` : ''}
        ${p.sei ? `<div class="small muted">SEI: <span class="mono">${esc(p.sei)}</span></div>` : ''}
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
  $('#filtro-liminar').onchange = carregar;
  $('#filtro-cumprimento').onchange = carregar;
  await carregar();
}

function formProcesso(proc = null, aoSalvar, { focoCumprimento = false } = {}) {
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
        <div class="ajuda" id="ajuda-numero">"Buscar dados" preenche tribunal, classe e vara pelo eproc/PJe do TJMG ou pelo DataJud (CNJ).</div>
      </div>
      <div class="campos-2">
        <div class="campo"><label for="f-titulo">Título / apelido</label><input id="f-titulo" placeholder="Ex.: Silva x Banco XYZ" value="${esc(p.titulo || '')}"></div>
        <div class="campo"><label for="f-sei">Nº do processo SEI</label><input id="f-sei" inputmode="numeric" placeholder="Ex.: 1320.01.0012345/2026-12" value="${esc(p.sei || '')}"></div>
      </div>
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
      <div class="campo"><label for="f-liminar">Liminar</label>
        <select id="f-liminar">
          <option value="">— Não informado —</option>
          ${Object.entries(LIMINAR).map(([k, v]) => `<option value="${k}" ${p.liminar === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <fieldset id="bloco-cumprimento" class="bloco" ${p.liminar === 'deferida' ? '' : 'hidden'}>
        <legend>Cumprimento da liminar</legend>
        <div class="campos-2">
          <div class="campo"><label for="f-cump-sit">Situação</label>
            <select id="f-cump-sit">${Object.entries(CUMPRIMENTO).map(([k, v]) => `<option value="${k}" ${(p.cumprimento_situacao || 'pendente') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="campo"><label for="f-cump-prazo">Prazo para cumprimento</label>
            <div class="acoes" style="flex-wrap:nowrap"><input type="date" id="f-cump-prazo" value="${esc(p.cumprimento_prazo || '')}"><button type="button" class="btn" id="abrir-calc">Calcular</button></div></div>
        </div>
        <div id="calc-prazo" class="calc" hidden>
          <div class="campos-3">
            <div class="campo"><label for="calc-data">Data da intimação</label><input type="date" id="calc-data" value="${ymdLocal(new Date())}"></div>
            <div class="campo"><label for="calc-qtd">Prazo</label><input type="number" id="calc-qtd" min="1" max="3650" value="5"></div>
            <div class="campo"><label for="calc-unid">Unidade</label><select id="calc-unid"><option value="uteis">dias úteis</option><option value="corridos">dias corridos</option><option value="horas">horas</option></select></div>
          </div>
          <div class="acoes"><button type="button" class="btn pequeno primario" id="calc-usar">Calcular e usar esta data</button><span class="ajuda" id="calc-obs"></span></div>
        </div>
        <div class="campo"><label for="f-cump-resp">Setor / responsável a cobrar</label><input id="f-cump-resp" placeholder="Ex.: Diretoria de Contratos – Fulano" value="${esc(p.cumprimento_responsavel || '')}"></div>
        <div class="campos-2">
          <div class="campo"><label for="f-cump-multa">Multa fixada (opcional)</label><input id="f-cump-multa" placeholder="Ex.: R$ 1.000/dia, até R$ 30 mil" value="${esc(p.cumprimento_multa || '')}"></div>
          <div class="campo"><label for="f-cump-cobr">Lembrar de cobrar a cada</label>
            <div class="acoes" style="flex-wrap:nowrap"><input type="number" id="f-cump-cobr" min="1" max="30" value="${esc(p.cumprimento_cobranca_dias || 3)}" style="max-width:90px"><span class="small muted">dias úteis</span></div></div>
        </div>
        <div class="campo" id="campo-cump-data" ${['cumprida', 'parcial'].includes(p.cumprimento_situacao) ? '' : 'hidden'}><label for="f-cump-data">Data do cumprimento</label><input type="date" id="f-cump-data" value="${esc(p.cumprimento_data || '')}"></div>
        <p class="ajuda" style="margin:0">Enquanto pendente, o app cria o lembrete do prazo final (aviso 2 dias antes) e lembretes de cobrança no intervalo escolhido. Ao marcar como cumprida, eles são concluídos automaticamente.</p>
      </fieldset>
      <div class="campo"><label for="f-assunto">Assunto</label><input id="f-assunto" value="${esc(p.assunto || '')}"></div>
      <div class="campo"><label for="f-obs">Observações</label><textarea id="f-obs">${esc(p.observacoes || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="f-monitorar" ${p.monitorar === 0 ? '' : 'checked'}> Monitorar publicações e andamentos e me avisar quando houver novidade</label>
      <div id="erro-proc" class="alerta-caixa erro" hidden style="margin-top:.75rem"></div>
      <footer><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button></footer>
    </form>`, {
    aoAbrir: (m, fechar) => {
      $('#f-liminar', m).onchange = (e) => ($('#bloco-cumprimento', m).hidden = e.target.value !== 'deferida');
      if (focoCumprimento && !$('#bloco-cumprimento', m).hidden) {
        setTimeout(() => {
          $('#bloco-cumprimento', m).scrollIntoView({ block: 'start' });
          $('#f-cump-sit', m).focus({ preventScroll: true });
        }, 50);
      }
      $('#f-cump-sit', m).onchange = (e) => {
        const comData = ['cumprida', 'parcial'].includes(e.target.value);
        $('#campo-cump-data', m).hidden = !comData;
        if (e.target.value === 'cumprida' && !$('#f-cump-data', m).value) $('#f-cump-data', m).value = ymdLocal(new Date());
      };
      $('#abrir-calc', m).onclick = () => ($('#calc-prazo', m).hidden = !$('#calc-prazo', m).hidden);
      $('#calc-usar', m).onclick = async () => {
        try {
          const r = await api('/prazos/calcular', {
            metodo: 'POST',
            corpo: { data: $('#calc-data', m).value, quantidade: $('#calc-qtd', m).value, unidade: $('#calc-unid', m).value },
          });
          $('#f-cump-prazo', m).value = r.data;
          $('#calc-obs', m).textContent = `→ ${fmtData(r.data)}. ${r.observacao} Confira a data.`;
        } catch (err) {
          $('#calc-obs', m).textContent = err.message;
        }
      };
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
          ajuda.textContent = `Encontrado${d.fonte ? ` (${d.fonte})` : ''}: ${d.classe || ''} — ${d.orgao || ''}${d.movimentos[0] ? `. Último andamento: ${d.movimentos[0].nome} (${fmtData(d.movimentos[0].data)})` : ''}${d.migrado ? '. ⚠️ Processo migrado para o eproc.' : ''}`;
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
          sei: $('#f-sei', m).value,
          cliente: $('#f-cliente', m).value,
          parte_contraria: $('#f-contraria', m).value,
          tribunal: $('#f-tribunal', m).value,
          orgao: $('#f-orgao', m).value,
          classe: $('#f-classe', m).value,
          assunto: $('#f-assunto', m).value,
          status: $('#f-status', m).value,
          liminar: $('#f-liminar', m).value || null,
          ...($('#f-liminar', m).value === 'deferida'
            ? {
                cumprimento_situacao: $('#f-cump-sit', m).value,
                cumprimento_prazo: $('#f-cump-prazo', m).value || null,
                cumprimento_responsavel: $('#f-cump-resp', m).value,
                cumprimento_multa: $('#f-cump-multa', m).value,
                cumprimento_cobranca_dias: $('#f-cump-cobr', m).value,
                cumprimento_data: $('#campo-cump-data', m).hidden ? null : $('#f-cump-data', m).value || null,
              }
            : {}),
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
            ${seloAudiencia(p)}
            ${seloLiminar(p.liminar)}
            ${seloCumprimento(p)}
            ${p.monitorar && p.status !== 'encerrado' ? '<span class="badge ok">Monitorado</span>' : '<span class="badge">Sem monitoramento</span>'}
            ${p.pje_situacao === 'ativo' ? '<span class="badge ok" title="Andamentos lidos direto da Consulta Pública do PJe do TJMG">Andamentos via PJe TJMG</span>' : ''}
            ${p.pje_situacao === 'migrado' ? '<span class="badge aviso" title="O processo saiu do PJe">Migrado para o eproc</span>' : ''}
            ${p.eproc_situacao === 'ativo' ? '<span class="badge ok" title="Andamentos lidos pelo webservice oficial do eproc (MNI)">Andamentos via eproc</span>' : ''}
          </div></div>
        <div class="acoes"><button class="btn pequeno" id="editar">Editar</button><button class="btn pequeno perigo" id="excluir">Excluir</button></div>
      </div>
      <dl class="dados">
        ${(() => {
          const hoje = ymdLocal(new Date());
          const prox = (p.audiencias || []).filter((x) => x.data >= hoje).sort((x, y) => (x.data + (x.hora || '')).localeCompare(y.data + (y.hora || '')))[0];
          return prox ? `<div><dt>Próxima audiência</dt><dd><a href="#/audiencias">${textoDataHora(prox.data, prox.hora)}</a>${prox.descricao ? `<div class="small muted">${esc(prox.descricao)}</div>` : ''}</dd></div>` : '';
        })()}
        ${p.sei ? `<div><dt>Nº SEI</dt><dd><span class="mono">${esc(p.sei)}</span> <button class="btn pequeno" id="copiar-sei" title="Copiar para colar na pesquisa do SEI">Copiar</button></dd></div>` : ''}
        ${[['Cliente', p.cliente], ['Parte contrária', p.parte_contraria], ['Tribunal', p.tribunal], ['Vara / órgão', p.orgao], ['Classe', p.classe], ['Assunto', p.assunto]]
          .filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>
      ${p.observacoes ? `<p class="small" style="white-space:pre-wrap;margin-bottom:0">${esc(p.observacoes)}</p>` : ''}
      <label class="check small" style="margin-top:.75rem"><input type="checkbox" id="monitorar" ${p.monitorar ? 'checked' : ''}> Monitorar e me avisar sobre novas publicações e andamentos</label>
      <p class="small muted" style="margin:.5rem 0 0">Última verificação: ${p.ultima_verificacao ? fmtDataHora(p.ultima_verificacao) : 'pendente'}</p>
      ${p.erro_verificacao ? `<div class="alerta-caixa erro small" style="margin-top:.5rem">${esc(p.erro_verificacao)}</div>` : ''}
      ${p.monitorar && p.datajud_pendente && p.pje_situacao !== 'ativo' && p.eproc_situacao !== 'ativo' ? `<div class="alerta-caixa small" style="margin-top:.5rem">⏳ <strong>Andamentos aguardando o DataJud:</strong> o sistema do CNJ está instável. O app tenta de novo automaticamente a cada 20 minutos e preenche os dados assim que ele responder.${p.datajud_tentativa ? ` Última tentativa: ${fmtDataHora(p.datajud_tentativa)}.` : ''}</div>` : ''}
    </div>
    ${p.liminar === 'deferida' ? `<section class="card" style="margin-top:1rem;border-left:4px solid ${cumprimentoAberto(p) ? 'var(--warn)' : 'var(--ok)'}">
      <div class="secao-titulo" style="margin-top:0"><h2>Cumprimento da liminar</h2>${seloCumprimento(p)}</div>
      <dl class="dados">
        ${[
          ['Prazo para cumprimento', p.cumprimento_prazo ? `${fmtData(p.cumprimento_prazo)}${cumprimentoAberto(p) ? ` (${relativo(`${p.cumprimento_prazo}T18:00:00-03:00`)})` : ''}` : 'Não informado'],
          ['Setor / responsável', p.cumprimento_responsavel],
          ['Multa fixada', p.cumprimento_multa],
          cumprimentoAberto(p) ? ['Cobrança', `a cada ${p.cumprimento_cobranca_dias || 3} dia(s) útil(eis)`] : ['Cumprida em', p.cumprimento_data ? fmtData(p.cumprimento_data) : null],
        ].filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>
      <div class="acoes" style="margin-top:.75rem">
        ${cumprimentoAberto(p) ? '<button class="btn pequeno primario" id="marcar-cumprida">✓ Marcar como cumprida</button>' : '<button class="btn pequeno" id="reabrir-cumprimento">Reabrir (pendente)</button>'}
        <button class="btn pequeno" id="editar-cumprimento">Editar cumprimento</button>
        <button class="btn pequeno" id="prov-liminar">${icone('mais')} Registrar providência</button>
        <button class="btn pequeno" id="ver-provs">Ver providências (${p.providencias.length})</button>
      </div>
    </section>` : ''}
    <div class="abas" role="tablist">
      <button data-aba="publicacoes">Publicações (${p.publicacoes.length})${naoLidasPub ? ` <span class="badge novo">${naoLidasPub}</span>` : ''}</button>
      <button data-aba="andamentos">Andamentos (${p.andamentos.length})${naoLidosAnd ? ` <span class="badge novo">${naoLidosAnd}</span>` : ''}</button>
      <button data-aba="providencias">Providências (${p.providencias.length})</button>
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
            <div style="font-weight:600">${esc(a.nome)} ${a.lida ? '' : '<span class="badge novo">Novo</span>'} <span class="badge" style="font-weight:500">${{ pje: 'PJe TJMG', eproc: 'eproc TJMG' }[a.fonte] || 'DataJud'}</span></div>
            ${a.complemento ? `<div class="small muted">${esc(a.complemento)}</div>` : ''}</li>`).join('')}</ul></div>`
        : `<div class="card vazio">${p.datajud_em ? 'Nenhum andamento encontrado no DataJud.' : 'Ainda não foi possível consultar o DataJud (CNJ). Os andamentos aparecerão aqui assim que ele responder.'}</div>`;
    } else if (nome === 'providencias') {
      const tiposUsados = Object.keys(CATEGORIAS_PROV).filter((k) => p.providencias.some((x) => x.categoria === k));
      alvo.innerHTML = `
        <div class="acoes" style="margin-bottom:.75rem"><button class="btn primario" id="nova-prov">${icone('mais')} Registrar providência</button>
          ${tiposUsados.length > 1 ? `<select id="filtro-prov" aria-label="Filtrar por tipo" style="width:auto">
            <option value="">Todos os tipos (${p.providencias.length})</option>
            ${tiposUsados.map((k) => `<option value="${k}" ${filtroProv === k ? 'selected' : ''}>${CATEGORIAS_PROV[k]} (${p.providencias.filter((x) => x.categoria === k).length})</option>`).join('')}
          </select>` : ''}
          <span class="small muted">Ex.: enviado ao setor tal, solicitado cumprimento de decisão, audiência dia tal…</span></div>
        <div class="card" id="lista-provs"></div>`;
      const desenhar = () => {
        const lista = filtroProv ? p.providencias.filter((x) => x.categoria === filtroProv) : p.providencias;
        $('#lista-provs', alvo).innerHTML = htmlProvidencias(lista);
        ligarProvidencias($('#lista-provs', alvo), p.id, p.providencias, () => telaProcesso(c, id, 'providencias'));
      };
      $('#filtro-prov', alvo)?.addEventListener('change', (e) => {
        filtroProv = e.target.value;
        desenhar();
      });
      if (filtroProv && !tiposUsados.includes(filtroProv)) filtroProv = '';
      desenhar();
      $('#nova-prov', alvo).onclick = () => formProvidencia(p.id, null, () => telaProcesso(c, id, 'providencias'));
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
  $('#editar-cumprimento')?.addEventListener('click', () => formProcesso(p, () => telaProcesso(c, id), { focoCumprimento: true }));
  $('#marcar-cumprida')?.addEventListener('click', async () => {
    if (!(await confirmar('Marcar a liminar como cumprida? Os lembretes de prazo e de cobrança deste processo serão concluídos.'))) return;
    const hoje = ymdLocal(new Date());
    await api(`/processos/${id}`, { metodo: 'PUT', corpo: { cumprimento_situacao: 'cumprida', cumprimento_data: hoje } });
    await api(`/processos/${id}/providencias`, { metodo: 'POST', corpo: { data: hoje, categoria: 'cumprimento', descricao: 'Liminar marcada como cumprida.' } });
    toast('Liminar marcada como cumprida.');
    telaProcesso(c, id);
  });
  $('#reabrir-cumprimento')?.addEventListener('click', async () => {
    await api(`/processos/${id}`, { metodo: 'PUT', corpo: { cumprimento_situacao: 'pendente', cumprimento_data: null } });
    toast('Cumprimento reaberto: lembretes reativados.');
    telaProcesso(c, id);
  });
  $('#prov-liminar')?.addEventListener('click', () =>
    formProvidencia(p.id, null, () => telaProcesso(c, id, 'providencias'), { categoria: 'cumprimento' }),
  );
  $('#ver-provs')?.addEventListener('click', () => {
    mostrar('providencias');
    $('.abas', c).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#copiar-sei')?.addEventListener('click', async () => {
    await copiarTexto(p.sei);
    toast('Número SEI copiado.');
  });
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

// ───────────── audiências ─────────────
const nomeAudiencia = (a) => a.titulo || a.processo_titulo || (a.numero_processo ? formatarCnj(a.numero_processo) : a.sei ? `SEI ${a.sei}` : 'Audiência');

function formAudiencia(a = null, aoSalvar) {
  const editando = !!a?.id;
  const base = a || { antecedencia_min: 1440 };
  abrirModal(editando ? 'Editar audiência' : 'Nova audiência', `
    <form id="form-aud">
      <div class="campos-2">
        <div class="campo"><label for="a-num">Nº do processo</label><input id="a-num" inputmode="numeric" placeholder="0000000-00.0000.0.00.0000" value="${esc(formatarCnj(base.numero_processo || ''))}"></div>
        <div class="campo"><label for="a-sei">Nº SEI</label><input id="a-sei" inputmode="numeric" placeholder="Ex.: 1320.01.0012345/2026-12" value="${esc(base.sei || '')}"></div>
      </div>
      <div class="campos-2">
        <div class="campo"><label for="a-data">Data *</label><input type="date" id="a-data" required value="${esc(base.data || '')}"></div>
        <div class="campo"><label for="a-hora">Hora</label><input type="time" id="a-hora" value="${esc(base.hora || '')}"></div>
      </div>
      <div class="campos-2">
        <div class="campo"><label for="a-desc">Tipo / local / link</label><input id="a-desc" maxlength="500" placeholder="Ex.: Conciliação – sala 3 (ou link)" value="${esc(base.descricao || '')}"></div>
        <div class="campo"><label for="a-aviso">Avisar</label><select id="a-aviso">${AVISO_AUDIENCIA.map(([v, t]) => `<option value="${v}" ${Number(base.antecedencia_min || 1440) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>
      <div class="campo"><label for="a-titulo">Partes / apelido (opcional)</label><input id="a-titulo" maxlength="200" placeholder="Ex.: FHEMIG x Consórcio IGC Cetus" value="${esc(base.titulo || '')}"></div>
      <div class="campo"><label for="a-obs">Observações</label><textarea id="a-obs" maxlength="5000" placeholder="Ex.: levar preposto; testemunhas; documentos…">${esc(base.observacoes || '')}</textarea></div>
      <div id="erro-aud" class="alerta-caixa erro" hidden></div>
      <footer><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button></footer>
    </form>`, {
    aoAbrir: (m, fechar) => {
      $('#form-aud', m).onsubmit = async (e) => {
        e.preventDefault();
        const corpo = {
          numero_processo: $('#a-num', m).value,
          sei: $('#a-sei', m).value,
          data: $('#a-data', m).value,
          hora: $('#a-hora', m).value || null,
          descricao: $('#a-desc', m).value,
          antecedencia_min: Number($('#a-aviso', m).value),
          titulo: $('#a-titulo', m).value,
          observacoes: $('#a-obs', m).value,
        };
        try {
          await api(editando ? `/audiencias/${base.id}` : '/audiencias', { metodo: editando ? 'PUT' : 'POST', corpo });
          fechar();
          toast(editando ? 'Audiência atualizada.' : 'Audiência salva. O lembrete foi criado.');
          aoSalvar?.();
        } catch (err) {
          const caixa = $('#erro-aud', m);
          caixa.textContent = err.message;
          caixa.hidden = false;
        }
      };
    },
  });
}

function htmlAudiencia(a, passada = false) {
  const aviso = AVISO_AUDIENCIA.find(([v]) => v === Number(a.antecedencia_min))?.[1] || '1 dia antes';
  const hoje = ymdLocal(new Date());
  const urgente = !passada && a.data <= ymdLocal(new Date(Date.now() + 86_400_000));
  return `<article class="card audiencia-card ${passada ? 'passada' : ''}">
    <div class="aud-data ${urgente ? 'urgente' : ''}">
      <div class="dia">${a.data.slice(8, 10)}</div>
      <div class="mes">${new Date(`${a.data}T12:00:00`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')} ${a.data.slice(0, 4)}</div>
      ${a.hora ? `<div class="hora">${esc(a.hora)}</div>` : ''}
    </div>
    <div class="corpo">
      <h3 style="margin:0">${esc(nomeAudiencia(a))} ${a.data === hoje ? '<span class="badge erro">hoje</span>' : ''}</h3>
      ${a.descricao ? `<div class="small" style="margin-top:.2rem">${esc(a.descricao)}</div>` : ''}
      <div class="small" style="margin-top:.35rem">
        ${a.numero_processo ? `<div>Processo: <span class="mono">${esc(formatarCnj(a.numero_processo))}</span> <button class="btn pequeno copiar" data-texto="${esc(formatarCnj(a.numero_processo))}">Copiar</button>${a.processo_id ? ` <a href="#/processos/${a.processo_id}">ver processo</a>` : ''}</div>` : ''}
        ${a.sei ? `<div>SEI: <span class="mono">${esc(a.sei)}</span> <button class="btn pequeno copiar" data-texto="${esc(a.sei)}">Copiar</button></div>` : ''}
      </div>
      ${a.observacoes ? `<div class="small muted" style="white-space:pre-line;margin-top:.35rem">${esc(a.observacoes)}</div>` : ''}
      ${passada ? '' : `<div class="small muted" style="margin-top:.35rem">🔔 Aviso ${aviso}${a.aviso_enviado_em ? ' · enviado' : ''}</div>`}
      <div class="acoes" style="margin-top:.5rem">
        <button class="btn pequeno editar-aud" data-id="${a.id}">Editar</button>
        <button class="btn pequeno perigo excluir-aud" data-id="${a.id}">Excluir</button>
      </div>
    </div>
  </article>`;
}

async function telaAudiencias(c) {
  definirTopo('Audiências', { acoes: `<button class="btn primario" id="nova-aud">${icone('mais')}<span class="so-desktop">Nova audiência</span></button>` });
  const todas = await api('/audiencias');
  const hoje = ymdLocal(new Date());
  const proximas = todas.filter((a) => a.data >= hoje).sort((x, y) => (x.data + (x.hora || '')).localeCompare(y.data + (y.hora || '')));
  const passadas = todas.filter((a) => a.data < hoje);
  c.innerHTML = `
    <div class="secao-titulo" style="margin-top:0"><h2>Próximas <span class="muted small">(${proximas.length})</span></h2></div>
    <div class="pilha">${proximas.length ? proximas.map((a) => htmlAudiencia(a)).join('') : '<div class="card vazio">Nenhuma audiência agendada.<br><br><button class="btn primario" id="primeira-aud">Cadastrar audiência</button></div>'}</div>
    ${passadas.length ? `<details style="margin-top:1.5rem"><summary class="muted">Realizadas (${passadas.length})</summary>
      <div class="pilha" style="margin-top:.75rem">${passadas.map((a) => htmlAudiencia(a, true)).join('')}</div></details>` : ''}`;
  const recarregar = () => telaAudiencias(c);
  $('#nova-aud').onclick = () => formAudiencia(null, recarregar);
  $('#primeira-aud')?.addEventListener('click', () => formAudiencia(null, recarregar));
  $$('.editar-aud', c).forEach((b) => b.addEventListener('click', () => formAudiencia(todas.find((a) => String(a.id) === b.dataset.id), recarregar)));
  $$('.excluir-aud', c).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmar('Excluir esta audiência? O lembrete dela também será removido.'))) return;
      await api(`/audiencias/${b.dataset.id}`, { metodo: 'DELETE' });
      toast('Audiência excluída.');
      recarregar();
    }),
  );
  $$('.copiar', c).forEach((b) =>
    b.addEventListener('click', async () => {
      await copiarTexto(b.dataset.texto);
      toast('Copiado.');
    }),
  );
}

// ───────────── anotações gerais ─────────────
function formAnotacao(n = null, aoSalvar, etiquetasExistentes = [], categoriasExistentes = [], categoriaPadrao = '') {
  const editando = !!n?.id;
  const base = n || { categoria: categoriaPadrao };
  abrirModal(editando ? 'Editar anotação' : 'Nova anotação', `
    <form id="form-nota">
      <div class="campo"><label for="n-titulo">Título *</label><input id="n-titulo" required maxlength="300" placeholder="Ex.: Ação de cobrança – Fornecedor X" value="${esc(base.titulo || '')}"></div>
      <div class="campos-2">
        <div class="campo"><label for="n-numero">Nº do processo (opcional)</label><input id="n-numero" inputmode="numeric" placeholder="0000000-00.0000.0.00.0000" value="${esc(formatarCnj(base.numero_processo || ''))}"></div>
        <div class="campo"><label for="n-sei">Nº SEI (opcional)</label><input id="n-sei" inputmode="numeric" placeholder="Ex.: 1320.01.0012345/2026-12" value="${esc(base.sei || '')}"></div>
      </div>
      <div class="campo"><label for="n-cat">Tipo de ação / assunto</label>
        <input id="n-cat" list="lista-categorias" maxlength="80" placeholder="Ex.: Mandado de Segurança, Licitações e contratos, Servidores…" value="${esc(base.categoria || '')}">
        <datalist id="lista-categorias">${categoriasExistentes.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="ajuda">Funciona como uma pasta: escolha um existente ou digite um novo.</div></div>
      <div class="campo"><label for="n-etiq">Etiquetas</label>
        <input id="n-etiq" list="lista-etiquetas" placeholder="Separe por vírgula. Ex.: FHEMIG, licitação, arquivado" value="${esc(base.etiquetas || '')}">
        <datalist id="lista-etiquetas">${etiquetasExistentes.map((e) => `<option value="${esc(e)}">`).join('')}</datalist></div>
      <div class="campo"><label for="n-texto">Anotação</label><textarea id="n-texto" rows="8" maxlength="20000" placeholder="Observações, histórico, contatos, entendimento do caso…">${esc(base.texto || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="n-fixar" ${base.fixada ? 'checked' : ''}> 📌 Fixar no topo</label>
      <div id="erro-nota" class="alerta-caixa erro" hidden style="margin-top:.75rem"></div>
      <footer><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button></footer>
    </form>`, {
    aoAbrir: (m, fechar) => {
      $('#form-nota', m).onsubmit = async (e) => {
        e.preventDefault();
        const corpo = {
          titulo: $('#n-titulo', m).value,
          numero_processo: $('#n-numero', m).value,
          sei: $('#n-sei', m).value,
          categoria: $('#n-cat', m).value,
          etiquetas: $('#n-etiq', m).value,
          texto: $('#n-texto', m).value,
          fixada: $('#n-fixar', m).checked,
        };
        try {
          await api(editando ? `/anotacoes/${base.id}` : '/anotacoes', { metodo: editando ? 'PUT' : 'POST', corpo });
          fechar();
          toast(editando ? 'Anotação atualizada.' : 'Anotação salva.');
          aoSalvar?.();
        } catch (err) {
          const caixa = $('#erro-nota', m);
          caixa.textContent = err.message;
          caixa.hidden = false;
        }
      };
    },
  });
}

/** Janela para renomear, juntar ou remover tipos de anotação. */
function organizarTipos(cats, aoMudar) {
  abrirModal('Organizar tipos', `
    <p class="small muted" style="margin-top:0">Renomeie para corrigir ou padronizar. Para <strong>juntar</strong> dois tipos, renomeie um com o nome exato do outro. Ao remover, as anotações vão para "Sem tipo" (nada é apagado).</p>
    <ul class="lista">${cats.categorias.map((x) => `<li class="item-linha" data-cat="${esc(x.nome)}">
      <div class="corpo"><input class="novo-nome" value="${esc(x.nome)}" aria-label="Novo nome para ${esc(x.nome)}" maxlength="80">
        <div class="small muted">${x.total} anotação(ões)</div></div>
      <div class="acoes" style="flex-wrap:nowrap"><button class="btn pequeno salvar-tipo">Salvar</button><button class="btn pequeno perigo remover-tipo">Remover</button></div>
    </li>`).join('')}</ul>
    <footer><button type="button" class="btn" data-fechar>Fechar</button></footer>`, {
    aoAbrir: (m, fechar) => {
      const renomear = async (de, para) => {
        const r = await api('/anotacoes-categorias/renomear', { metodo: 'POST', corpo: { de, para } });
        toast(para ? `${r.alteradas} anotação(ões) agora em "${r.para}".` : `${r.alteradas} anotação(ões) movidas para "Sem tipo".`);
        fechar();
        aoMudar();
      };
      $$('.salvar-tipo', m).forEach((b) =>
        b.addEventListener('click', () => {
          const li = b.closest('li');
          const novo = $('.novo-nome', li).value.trim();
          if (!novo || novo === li.dataset.cat) return;
          renomear(li.dataset.cat, novo);
        }),
      );
      $$('.remover-tipo', m).forEach((b) =>
        b.addEventListener('click', () => renomear(b.closest('li').dataset.cat, '')),
      );
    },
  });
}

let filtroEtiqueta = '';
let filtroCategoria = ''; // '' = todas; '__sem' = sem tipo
async function telaAnotacoes(c) {
  definirTopo('Anotações', { acoes: `<button class="btn primario" id="nova-nota">${icone('mais')}<span class="so-desktop">Nova anotação</span></button>` });
  const [todas, cats] = await Promise.all([api('/anotacoes'), api('/anotacoes-categorias')]);
  const nomesCategorias = cats.categorias.map((x) => x.nome);
  if (filtroCategoria && filtroCategoria !== '__sem' && !nomesCategorias.some((n) => n.toLowerCase() === filtroCategoria.toLowerCase())) filtroCategoria = '';
  if (filtroCategoria === '__sem' && !cats.semCategoria) filtroCategoria = '';
  const categoriaPadrao = filtroCategoria && filtroCategoria !== '__sem' ? filtroCategoria : '';
  const etiquetas = [...new Set(todas.flatMap((n) => (n.etiquetas || '').split(',').map((e) => e.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  if (filtroEtiqueta && !etiquetas.includes(filtroEtiqueta)) filtroEtiqueta = '';
  c.innerHTML = `
    <p class="small muted" style="margin-top:0">Para guardar observações sobre processos que você <strong>não</strong> precisa acompanhar: aqui não há monitoramento de publicações nem avisos.</p>
    ${cats.total ? `<div class="subabas" role="tablist" aria-label="Tipos de ação / assunto">
      <button class="subaba ${!filtroCategoria ? 'ativa' : ''}" data-cat="">Todas <span class="cont">${cats.total}</span></button>
      ${cats.categorias.map((x) => `<button class="subaba ${filtroCategoria.toLowerCase() === x.nome.toLowerCase() ? 'ativa' : ''}" data-cat="${esc(x.nome)}">${esc(x.nome)} <span class="cont">${x.total}</span></button>`).join('')}
      ${cats.semCategoria && cats.categorias.length ? `<button class="subaba ${filtroCategoria === '__sem' ? 'ativa' : ''}" data-cat="__sem">Sem tipo <span class="cont">${cats.semCategoria}</span></button>` : ''}
      ${cats.categorias.length ? '<button class="btn pequeno" id="organizar-tipos" style="margin-left:auto">Organizar tipos</button>' : ''}
    </div>` : ''}
    <div class="filtros">
      <input type="search" id="busca-nota" placeholder="Buscar no título, texto, número ou SEI…" aria-label="Buscar anotações">
      ${etiquetas.length ? `<select id="filtro-etiqueta" aria-label="Etiqueta" style="width:auto">
        <option value="">Todas as etiquetas</option>
        ${etiquetas.map((e) => `<option value="${esc(e)}" ${filtroEtiqueta === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}
      </select>` : ''}
    </div>
    <div id="lista-notas" class="grade grade-2"></div>`;
  const recarregar = () => telaAnotacoes(c);
  $('#nova-nota').onclick = () => formAnotacao(null, recarregar, etiquetas, nomesCategorias, categoriaPadrao);
  $$('.subaba', c).forEach((b) =>
    b.addEventListener('click', () => {
      filtroCategoria = b.dataset.cat;
      recarregar();
    }),
  );
  $('#organizar-tipos')?.addEventListener('click', () => organizarTipos(cats, recarregar));

  const carregar = async () => {
    const q = $('#busca-nota').value.trim();
    const lista = q || filtroEtiqueta || filtroCategoria
      ? await api(`/anotacoes?${new URLSearchParams({ q, etiqueta: filtroEtiqueta, categoria: filtroCategoria })}`)
      : todas;
    const alvo = $('#lista-notas');
    if (!lista.length) {
      alvo.innerHTML = `<div class="card vazio" style="grid-column:1/-1">${q || filtroEtiqueta || filtroCategoria ? 'Nenhuma anotação encontrada.' : 'Nenhuma anotação ainda.<br><br><button class="btn primario" id="primeira-nota">Criar minha primeira anotação</button>'}</div>`;
      $('#primeira-nota')?.addEventListener('click', () => formAnotacao(null, recarregar, etiquetas, nomesCategorias));
      return;
    }
    // Em "Todas" (sem busca), mostra as anotações agrupadas por tipo.
    const agrupar = !filtroCategoria && !q && !filtroEtiqueta && cats.categorias.length > 0;
    const cartao = (n) => `
      <article class="card nota">
        <div class="topo-card">
          <h3 style="margin:0">${n.fixada ? '📌 ' : ''}${esc(n.titulo)}</h3>
        </div>
        ${n.numero_processo || n.sei ? `<div class="small" style="margin-top:.35rem">
          ${n.numero_processo ? `<span class="mono">${esc(formatarCnj(n.numero_processo))}</span> <button class="btn pequeno copiar" data-texto="${esc(formatarCnj(n.numero_processo))}">Copiar</button>` : ''}
          ${n.sei ? `<div>SEI: <span class="mono">${esc(n.sei)}</span> <button class="btn pequeno copiar" data-texto="${esc(n.sei)}">Copiar</button></div>` : ''}
        </div>` : ''}
        ${n.categoria && filtroCategoria === '' && !agrupar ? `<div class="small" style="margin-top:.35rem"><button class="badge categoria" data-cat="${esc(n.categoria)}" title="Ver este tipo">📁 ${esc(n.categoria)}</button></div>` : ''}
        ${n.etiquetas ? `<div class="acoes small" style="margin-top:.4rem">${n.etiquetas.split(',').map((e) => e.trim()).filter(Boolean).map((e) => `<button class="badge etiqueta" data-etiqueta="${esc(e)}" title="Filtrar por esta etiqueta">${esc(e)}</button>`).join('')}</div>` : ''}
        ${n.texto ? `<div class="texto-publicacao ${n.texto.length > 280 ? 'recolhido' : ''}">${esc(n.texto)}</div>` : ''}
        <div class="small muted" style="margin-top:.5rem">Atualizada em ${fmtDataHora(n.atualizado_em)}</div>
        <div class="acoes" style="margin-top:.5rem">
          ${n.texto && n.texto.length > 280 ? '<button class="btn pequeno expandir-nota">Ler tudo</button>' : ''}
          <button class="btn pequeno editar-nota" data-id="${n.id}">Editar</button>
          <button class="btn pequeno fixar-nota" data-id="${n.id}" data-fixada="${n.fixada ? 1 : 0}">${n.fixada ? 'Desafixar' : '📌 Fixar'}</button>
          ${n.numero_processo ? `<button class="btn pequeno acompanhar-nota" data-id="${n.id}" title="Cadastrar em Processos e monitorar publicações">Passar a acompanhar</button>` : ''}
          <button class="btn pequeno perigo excluir-nota" data-id="${n.id}">Excluir</button>
        </div>
      </article>`;
    if (agrupar) {
      const grupos = [...cats.categorias.map((x) => x.nome), null];
      alvo.innerHTML = grupos
        .map((g) => {
          const itens = lista.filter((n) => (n.categoria || null) === g);
          if (!itens.length) return '';
          return `<h2 class="grupo-titulo">${g ? esc(g) : 'Sem tipo'} <span class="muted small">(${itens.length})</span></h2>${itens.map(cartao).join('')}`;
        })
        .join('');
    } else {
      alvo.innerHTML = lista.map(cartao).join('');
    }

    const achar = (id) => lista.find((n) => String(n.id) === String(id));
    $$('.expandir-nota', alvo).forEach((b) =>
      b.addEventListener('click', () => {
        const t = $('.texto-publicacao', b.closest('.nota'));
        t.classList.toggle('recolhido');
        b.textContent = t.classList.contains('recolhido') ? 'Ler tudo' : 'Recolher';
      }),
    );
    $$('.copiar', alvo).forEach((b) =>
      b.addEventListener('click', async () => {
        await copiarTexto(b.dataset.texto);
        toast('Copiado.');
      }),
    );
    $$('.etiqueta', alvo).forEach((b) =>
      b.addEventListener('click', () => {
        filtroEtiqueta = b.dataset.etiqueta;
        recarregar();
      }),
    );
    $$('.editar-nota', alvo).forEach((b) => b.addEventListener('click', () => formAnotacao(achar(b.dataset.id), recarregar, etiquetas, nomesCategorias)));
    $$('.categoria', alvo).forEach((b) =>
      b.addEventListener('click', () => {
        filtroCategoria = b.dataset.cat;
        recarregar();
      }),
    );
    $$('.fixar-nota', alvo).forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/anotacoes/${b.dataset.id}`, { metodo: 'PUT', corpo: { fixada: b.dataset.fixada !== '1' } });
        recarregar();
      }),
    );
    $$('.excluir-nota', alvo).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmar('Excluir esta anotação?'))) return;
        await api(`/anotacoes/${b.dataset.id}`, { metodo: 'DELETE' });
        toast('Anotação excluída.');
        recarregar();
      }),
    );
    $$('.acompanhar-nota', alvo).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmar('Passar a acompanhar este processo? Ele será cadastrado em Processos (com monitoramento de publicações e andamentos) e o texto da anotação irá para as observações. A anotação sai desta lista.'))) return;
        try {
          const proc = await api(`/anotacoes/${b.dataset.id}/acompanhar`, { metodo: 'POST' });
          toast('Processo cadastrado e monitorado.');
          location.hash = `#/processos/${proc.id}`;
        } catch (err) {
          toast(err.message);
        }
      }),
    );
  };
  let t;
  $('#busca-nota').oninput = () => {
    clearTimeout(t);
    t = setTimeout(carregar, 250);
  };
  $('#filtro-etiqueta')?.addEventListener('change', (e) => {
    filtroEtiqueta = e.target.value;
    carregar();
  });
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
          sugerido: false, // salvar pelo formulário = data conferida
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
        <p class="small" style="margin:.5rem 0 0">eproc TJMG (login de advogado): ${cfg.eproc_configurado ? '<span class="badge ok">configurado</span>' : '<span class="badge">não configurado</span> <span class="muted">— defina EPROC_USUARIO e EPROC_SENHA na Vercel (veja o README).</span>'}</p>
        <hr style="border:0;border-top:1px solid var(--border);margin:1rem 0">
        <p class="small" style="margin-bottom:.5rem"><strong>Conexão com o CNJ e tribunais</strong></p>
        <button type="button" class="btn" id="testar-cnj">Testar conexões</button>
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

// ==UserScript==
// @name         NDD Printer M-Manager
// @namespace    https://360.nddprint.com/
// @version      4.10.0
// @description  Lista de impressoras do NDD Print 360: seleção em massa, alteração em lote da Contabilização, comparação com lista de séries e exclusão em massa via API.
// @author       Maicon
// @match        https://360.nddprint.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/maiconjs/ndd-printer-m-manager
// @supportURL   https://github.com/maiconjs/ndd-printer-m-manager/issues
// @updateURL    https://raw.githubusercontent.com/maiconjs/ndd-printer-m-manager/main/ndd-printer-m-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/maiconjs/ndd-printer-m-manager/main/ndd-printer-m-manager.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ===========================================================================
  // Endpoints (mapeados a partir do próprio Portal 360)
  //
  //  Lista:          GET  /odata/printers?$skip&$top(max 100)&$select&$count
  //  Contabilização: GET  /api/printers/{id}/accounting
  //                  POST /api/printers/accounting   (mesmo payload do botão "Salvar")
  //  Exclusão:       POST /api/printers/delete        { id }
  //                  (o portal bloqueia se a contabilização estiver habilitada, se a impressora for consolidada
  //                   ou — enquanto a fila do servidor não processa a desabilitação — "@@360PrinterIsSettingDisabled")
  //
  //  trustOrigin: 1 = Padrão do sistema | 2 = Física e Lógica | 4 = Apenas Lógica | 24 = Apenas Física
  //  hardwareMF / hardwareCollector: usados quando trustOrigin = 24
  //  forceColor:  0 = Não forçar | 1 = Forçar mono | 2 = Forçar color
  // ===========================================================================
  const API = {
    list: '/odata/printers',
    accGet: (id) => `/api/printers/${id}/accounting`,
    accSave: '/api/printers/accounting',
    del: '/api/printers/delete',
  };
  const LIST_SELECT = 'id,printerName,addressName,serialNumber,modelName,brandName,enabledAccounting,isConsolidated,isLocal,addressPort';
  const PAGE_SIZE = 100;          // limite imposto pelo servidor
  const LIST_CONCURRENCY = 8;     // páginas buscadas em paralelo
  const ACC_CONCURRENCY = 4;      // alterações de contabilização simultâneas
  const DEL_CONCURRENCY = 6;      // exclusões simultâneas (fila rápida)
  const LS_CONTRACT = 'ndd-bulk-contract-v1';

  const ORIGIN_LABEL = { 1: 'Padrão do sistema', 2: 'Física e Lógica', 4: 'Apenas Lógica', 24: 'Apenas Física' };
  const COLOR_LABEL = { 0: 'Não forçar', 1: 'Forçar mono', 2: 'Forçar color' };

  const SEL = {
    rows: 'table.k-grid-table tbody tr[role="row"]',
    headerThs: '.k-grid-header thead tr th',
    scroller: '.k-grid-content',
  };
  const NAME_COL = 1;

  // ===========================================================================
  // Estado
  // ===========================================================================
  const selected = new Map();   // id -> info {id,name,ip,serial,model,consolidated?}
  const deleted = new Set();    // ids excluídos nesta sessão
  let running = false;
  let stopRequested = false;

  // Contrato
  let contract = null;          // { fileName, keys:Set, original:Map key->texto original }
  // Resultado da comparação
  let cmp = null;               // { status:Map id->'in'|'approx'|'out'|'noserial', out:[info], noSerial:[info], missing:[serial], approx:[...] , at }
  // Cache da lista completa do NDD (compartilhado entre Comparar e Filtro por fabricante/modelo)
  let printersCache = null;     // { list:[raw], at:number }
  // Cache de filas e hosts (somente leitura): { at, queues, queuesByPrinter:Map, machines, products, err:{} }
  let envCache = null;
  let envLoading = null;
  const CACHE_TTL = 5 * 60 * 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isPrintersPage = () => location.pathname.replace(/\/+$/, '') === '/printers';

  // ===========================================================================
  // Utilidades de linha da grade
  // ===========================================================================
  function rowId(tr) {
    const a = tr.children[NAME_COL]?.querySelector('a[href*="/printers/"]');
    const m = a && a.getAttribute('href').match(/\/printers\/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  function colIndex(re) {
    return [...document.querySelectorAll(SEL.headerThs)].findIndex((th) => re.test(th.innerText.trim()));
  }
  function cellText(tr, re) {
    const i = colIndex(re);
    return i >= 0 ? (tr.children[i]?.innerText || '').trim() : '';
  }
  function rowInfo(tr) {
    return {
      id: rowId(tr),
      name: (tr.children[NAME_COL]?.innerText || '').trim(),
      ip: cellText(tr, /endere[çc]o\s*ip/i),
      serial: cellText(tr, /s[ée]rie/i),
      model: cellText(tr, /^modelo/i),
    };
  }
  function apiInfo(p) {
    return {
      id: p.id, name: p.printerName || '', ip: p.addressName || '', serial: p.serialNumber || '',
      model: p.modelName || '', brand: p.brandName || '', enabled: !!p.enabledAccounting,
      consolidated: !!p.isConsolidated, local: !!p.isLocal, port: p.addressPort || '',
    };
  }
  function infoLabel(v) {
    return [v.name, v.ip, v.serial, v.model].filter((x) => x && x !== '-').join(' | ');
  }
  function getRows() {
    return [...document.querySelectorAll(SEL.rows)].filter((tr) => tr.children.length > 2 && rowId(tr));
  }

  // ===========================================================================
  // Estilos
  // ===========================================================================
  const style = document.createElement('style');
  style.textContent = `
    .ndd-bulk-cb { width:15px; height:15px; margin:0 6px 0 0; vertical-align:middle; cursor:pointer; accent-color:#1a73c8; }
    table.k-grid-table td:first-child, .k-grid-header th:first-child { white-space:nowrap; }
    table.k-grid-table td:first-child > ndd-ng-column-wrapper,
    table.k-grid-table td:first-child > ndd-ng-column-wrapper > ng-component,
    table.k-grid-table td:first-child > ndd-ng-column-wrapper > ng-component > div { display:inline-block !important; vertical-align:middle; }
    tr.ndd-c-out > td { background: rgba(230, 126, 34, .22) !important; }
    tr.ndd-c-noserial > td { background: rgba(241, 196, 15, .20) !important; }
    tr.ndd-c-in > td:first-child { box-shadow: inset 4px 0 0 #27ae60; }
    tr.ndd-c-approx > td:first-child { box-shadow: inset 4px 0 0 #8e44ad; }
    tr.ndd-bulk-marked > td { outline: 1px solid rgba(26,115,200,.55); outline-offset:-1px; }
    tr.ndd-bulk-marked > td:first-child { background: rgba(26,115,200,.18) !important; }
    tr.ndd-deleted > td { opacity:.4; text-decoration:line-through; }
    #ndd-bulk-bar { position:fixed; right:16px; bottom:56px; z-index:99999; background:#fff; border:1px solid #c9d3de;
      border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,.18); padding:10px 12px; font:13px/1.4 "Segoe UI",Arial,sans-serif;
      color:#223; width:340px; max-height:calc(100vh - 80px); overflow-y:auto; overflow-x:hidden; box-sizing:border-box; }
    #ndd-bulk-bar .row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:6px; }
    #ndd-bulk-bar button { border:1px solid #b8c4d0; background:#f4f7fa; border-radius:4px; padding:4px 9px; cursor:pointer; font:inherit; font-size:12px; }
    #ndd-bulk-bar button:hover:not(:disabled) { background:#e6edf4; }
    #ndd-bulk-bar button:disabled { opacity:.5; cursor:default; }
    #ndd-bulk-bar button.danger { background:#d63031; border-color:#b52324; color:#fff; font-weight:600; }
    #ndd-bulk-bar button.danger:hover:not(:disabled) { background:#b52324; }
    #ndd-bulk-bar button.primary { background:#1a73c8; border-color:#155fa6; color:#fff; font-weight:600; }
    #ndd-bulk-bar button.primary:hover:not(:disabled) { background:#155fa6; }
    #ndd-bulk-bar .title { font-weight:600; display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
    #ndd-bulk-bar .title .nm { font-size:14px; color:#1a73c8; }
    #ndd-bulk-bar #ndd-bulk-count { margin-left:auto; border-radius:11px; padding:2px 10px; font-size:12px; font-weight:600;
      background:#eef2f6; border:1px solid #d5dde6; color:#667; cursor:pointer; white-space:nowrap; }
    #ndd-bulk-bar #ndd-bulk-count.has { background:#1a73c8; border-color:#155fa6; color:#fff; }
    #ndd-bulk-bar #ndd-bulk-count.has:hover { background:#155fa6; }
    #ndd-bulk-bar button.big { padding:7px 10px; font-size:13px; width:100%; margin-top:8px; }
    #ndd-bulk-bar .quick { gap:4px; flex-wrap:nowrap; margin-bottom:8px; }
    #ndd-bulk-bar .quick > button { flex:1 1 auto; padding:3px 6px; }
    #ndd-bulk-bar .quick > button.ghost { flex:0 0 26px; padding:3px 0; }
    /* seções recolhíveis (o cabeçalho mostra o resumo; o conteúdo só abre quando preciso) */
    #ndd-bulk-bar .acc { border-top:1px solid #e8edf2; }
    #ndd-bulk-bar .acc-h { display:flex; align-items:center; gap:6px; padding:6px 2px; cursor:pointer; user-select:none; font-size:12px; }
    #ndd-bulk-bar .acc-h:hover { background:#f6f9fc; }
    #ndd-bulk-bar .acc-h .car { width:10px; color:#8a97a5; font-size:10px; }
    #ndd-bulk-bar .acc-t { font-weight:600; color:#34495e; white-space:nowrap; }
    #ndd-bulk-bar .acc-s { margin-left:auto; color:#667; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:205px; text-align:right; }
    #ndd-bulk-bar .acc-s .w { color:#9a7d0a; font-weight:600; }
    #ndd-bulk-bar .acc-s .b { color:#c0392b; font-weight:600; }
    #ndd-bulk-bar .acc-b { display:none; padding:0 2px 10px 18px; }
    #ndd-bulk-bar .acc.open > .acc-b { display:block; }
    #ndd-bulk-bar .acc-b > .row:first-child { margin-top:2px; }
    #ndd-bulk-bar .actions { border-top:1px solid #e8edf2; padding-top:8px; margin-top:0; }
    #ndd-bulk-bar .logbar { display:flex; align-items:center; gap:10px; margin-top:8px; font-size:11px; color:#667; }
    #ndd-bulk-bar .logbar > span { font-weight:600; margin-right:auto; }
    #ndd-bulk-bar button.lnk { border:none; background:none; padding:0; color:#1a73c8; font-size:11px; }
    #ndd-bulk-bar button.lnk:hover:not(:disabled) { background:none; text-decoration:underline; }
    #ndd-bulk-bar button.ghost { background:#fff; color:#b52324; border-color:#e3c1c1; }
    #ndd-bulk-bar button.ghost:hover:not(:disabled) { background:#fdf0f0; }
    #ndd-bulk-toggle { border:1px solid #b8c4d0; background:#f4f7fa; border-radius:4px; width:26px; height:22px; padding:0 !important;
      display:inline-flex; align-items:center; justify-content:center; font-size:13px !important; line-height:1; cursor:pointer; }
    #ndd-bulk-toggle:hover { background:#e6edf4; }
    #ndd-bulk-bar.min { width:auto; min-width:0; padding:6px 10px; }
    #ndd-bulk-bar.min .title { gap:10px; }
    #ndd-bulk-bar label { font-weight:400 !important; margin:0; display:inline-flex; align-items:center; gap:4px; }
    #ndd-bulk-bar label.f { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:6px; font-size:12px; }
    #ndd-bulk-bar input[type=checkbox] { margin:0; }
    #ndd-bulk-bar .row { margin-top:6px; }
    #ndd-bulk-bar .row > button { flex:1 1 auto; }
    #ndd-bulk-bar .row > label.small { flex:0 0 auto; }
    #ndd-bulk-bar select { font:inherit; font-size:12px; padding:2px 4px; min-width:160px; }
    #ndd-bulk-bar .sub { margin:2px 0 0 12px; font-size:12px; display:none; }
    #ndd-bulk-bar .small { font-size:11px; color:#556; }
    #ndd-bulk-bar .acc-note { display:none; margin:4px 0 2px; padding:4px 7px; border-left:3px solid #e0a800; background:#fff8e1; color:#6b4e00; font-size:11px; line-height:1.35; border-radius:2px; }
    #ndd-cmp-summary { font-size:12px; margin-top:4px; line-height:1.5; }
    #ndd-cmp-summary .sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:4px; vertical-align:-1px; }
    #ndd-bulk-log { margin-top:4px; max-height:130px; overflow:auto; font:11px/1.35 Consolas,monospace; background:#f7f9fb;
      border:1px solid #e1e7ee; border-radius:4px; padding:4px 6px; display:none; white-space:pre-wrap; }
    #ndd-bulk-progress { height:4px; background:#e1e7ee; border-radius:2px; margin-top:6px; overflow:hidden; display:none; }
    #ndd-bulk-progress > div { height:100%; width:0; background:#1a73c8; transition:width .2s; }
    #ndd-bulk-bar.min .body { display:none; }
    #ndd-bulk-bar input[type=search] { font:inherit; font-size:12px; padding:3px 6px; width:100%; box-sizing:border-box; border:1px solid #b8c4d0; border-radius:4px; }
    #ndd-rv { position:fixed; inset:0; z-index:100000; background:rgba(20,30,40,.45); display:flex; align-items:center; justify-content:center; font:13px/1.4 "Segoe UI",Arial,sans-serif; color:#223; }
    #ndd-rv .box { background:#fff; border-radius:6px; width:min(1560px,98vw); height:min(820px,92vh); display:flex; flex-direction:column; box-shadow:0 8px 32px rgba(0,0,0,.3); }
    #ndd-rv .hd { padding:10px 14px; border-bottom:1px solid #e1e7ee; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    #ndd-rv .hd b { font-size:14px; }
    #ndd-rv .chip { margin-right:auto; border-radius:11px; padding:2px 10px; font-size:12px; font-weight:600; background:#eef2f6; color:#667; border:1px solid #d5dde6; }
    #ndd-rv .chip.has { background:#1a73c8; border-color:#155fa6; color:#fff; }
    #ndd-rv.live tbody tr { cursor:pointer; }
    #ndd-rv.live tbody tr:hover td { background:#f5f9fd; }
    #ndd-rv.live tbody tr.on td { background:#e3effc; }
    #ndd-rv.live tbody tr.on td:first-child { box-shadow: inset 3px 0 0 #1a73c8; }
    #ndd-rv .bd { flex:1; overflow:auto; }
    #ndd-rv table { border-collapse:collapse; width:100%; font-size:12px; }
    #ndd-rv th { position:sticky; top:0; background:#f4f7fa; text-align:left; padding:5px 6px; border-bottom:1px solid #d5dde6; cursor:pointer; white-space:nowrap; }
    #ndd-rv td { padding:3px 6px; border-bottom:1px solid #eef2f6; white-space:nowrap; }
    #ndd-rv tr.off td { opacity:.45; text-decoration:line-through; }
    #ndd-rv tr.off td:first-child { text-decoration:none; opacity:1; }
    #ndd-rv .ft { padding:10px 14px; border-top:1px solid #e1e7ee; display:flex; gap:8px; align-items:center; }
    #ndd-rv .ft span { margin-right:auto; margin-left:8px; }
    #ndd-rv button { border:1px solid #b8c4d0; background:#f4f7fa; border-radius:4px; padding:5px 11px; cursor:pointer; font:inherit; }
    #ndd-rv button.primary { background:#1a73c8; border-color:#155fa6; color:#fff; font-weight:600; }
    #ndd-rv input[type=search] { font:inherit; padding:4px 8px; width:260px; border:1px solid #b8c4d0; border-radius:4px; }
    #ndd-rv select { font:inherit; padding:4px 6px; border:1px solid #b8c4d0; border-radius:4px; }
    #ndd-rv .flt-info { font-size:12px; color:#8e44ad; }
    #ndd-rv th .fb { border:1px solid transparent; background:transparent; padding:0 4px !important; margin-left:4px; font-size:11px; color:#667; border-radius:3px; }
    #ndd-rv th .fb:hover { background:#e1e8f0; border-color:#c9d3de; }
    #ndd-rv th.filtered { background:#eaf2fb; }
    #ndd-rv th.filtered .fb { background:#1a73c8; color:#fff; }
    #ndd-rv th .so { color:#1a73c8; font-size:10px; }
    #ndd-rv button.danger { background:#d63031; border-color:#b52324; color:#fff; font-weight:600; }
    #ndd-rv button:disabled { opacity:.5; cursor:default; }
    #ndd-rv .dd { position:fixed; z-index:100001; width:290px; background:#fff; border:1px solid #c9d3de; border-radius:6px;
      box-shadow:0 6px 24px rgba(0,0,0,.25); padding:8px; font-size:12px; }
    #ndd-rv .dd .dd-sort { display:flex; flex-direction:column; gap:2px; margin-bottom:6px; }
    #ndd-rv .dd .dd-sort button { text-align:left; background:#fff; border:none; padding:3px 6px; font-size:12px; }
    #ndd-rv .dd .dd-sort button:hover { background:#f0f4f8; }
    #ndd-rv .dd .dd-q { width:100%; box-sizing:border-box; }
    #ndd-rv .dd label { display:flex; align-items:center; gap:6px; padding:1px 2px; cursor:pointer; font-weight:400; margin:0; }
    #ndd-rv .dd label span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #ndd-rv .dd label i { color:#889; font-style:normal; font-size:11px; }
    #ndd-rv .dd .dd-all { margin-top:6px; border-bottom:1px solid #e1e7ee; padding-bottom:3px; }
    #ndd-rv .dd .dd-list { max-height:240px; overflow:auto; margin-top:2px; }
    #ndd-rv .dd .dd-ft { display:flex; gap:6px; margin-top:8px; }
    #ndd-rv .dd .dd-ft span { flex:1; }
    #ndd-rv .dd .dd-ft button { padding:3px 10px; font-size:12px; }
    #ndd-rv .pill { display:inline-block; padding:0 6px; border-radius:8px; font-size:11px; }
    #ndd-rv td.q0 { color:#b9770e; font-weight:600; }
    #ndd-rv td.o-na, #ndd-rv td.o-load { color:#9aa5b1; }
    #ndd-rv td.o-err { color:#c0392b; }
    #ndd-rv .ld-info { font-size:12px; color:#667; }
    /* Grade das janelas de lista/revisão: largura por coluna (ajustada ao conteúdo, com teto), redimensionável;
       o que não cabe é cortado com "…" e aparece inteiro no tooltip; a última coluna (vazia) absorve a sobra */
    #ndd-rv table.grid { table-layout:fixed; width:100%; }
    #ndd-rv table.grid th, #ndd-rv table.grid td { overflow:hidden; text-overflow:ellipsis; }
    #ndd-rv table.grid th { padding:0; border-right:1px solid #e3e9ef; }
    #ndd-rv table.grid th.fill { border-right:none; cursor:default; }
    #ndd-rv table.grid th .thc { display:flex; align-items:center; gap:2px; min-width:0; padding:5px 9px 5px 6px; }
    #ndd-rv table.grid th .lb { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }
    #ndd-rv table.grid th .so { flex:none; }
    #ndd-rv table.grid th .fb { flex:none; margin-left:auto; }
    #ndd-rv table.grid th .rz { position:absolute; top:0; right:-1px; width:7px; height:100%; cursor:col-resize; z-index:1; }
    #ndd-rv table.grid th .rz:hover, #ndd-rv.rzing table.grid th .rz.act { background:linear-gradient(to right, transparent 2px, #1a73c8 2px, #1a73c8 5px, transparent 5px); }
    #ndd-rv.rzing, #ndd-rv.rzing * { cursor:col-resize !important; user-select:none; }
    #ndd-rv table.grid td.tn { font-variant-numeric:tabular-nums; }
    #ndd-rv table.grid tbody tr[data-id]:not(.on):hover td { background:#f5f9fd; }
    #ndd-rv table.grid tr.qrow > td { overflow:visible; }
    #ndd-rv .qx { border:1px solid #c9d3de; background:#fff; border-radius:3px; padding:0 6px 0 4px !important; font-size:11px; line-height:16px; color:#34495e; cursor:pointer; }
    #ndd-rv .qx:hover { background:#eaf2fb; border-color:#1a73c8; }
    #ndd-rv .qx i { font-style:normal; color:#8a97a5; margin-right:3px; font-size:9px; }
    #ndd-rv .tag { display:inline-block; margin-left:4px; padding:0 4px; border-radius:3px; font-size:10px; background:#fcf3cf; color:#7d6608; vertical-align:1px; }
    #ndd-rv tr.qrow > td { background:#f8fafc !important; padding:4px 6px 6px; white-space:normal; cursor:default; }
    #ndd-rv .ql { display:grid; grid-template-columns:max-content max-content max-content max-content; column-gap:18px; row-gap:2px; font-size:11.5px; border-left:2px solid #c9d8e8; padding-left:10px; }
    #ndd-rv .ql .h { color:#8a97a5; font-size:10px; text-transform:uppercase; letter-spacing:.03em; }
    #ndd-rv .ql .n { font-weight:600; color:#223; }
    #ndd-rv .ql span { white-space:nowrap; color:#445; }
    #ndd-rv .cm label { display:flex; align-items:center; gap:6px; padding:2px 2px; cursor:pointer; font-weight:400; margin:0; }
    #ndd-rv .cm .sep { border-top:1px solid #e1e7ee; margin:5px 0; }
    #ndd-rv .cm a { font-size:11px; }
    #ndd-rv .cm .hint { color:#8a97a5; font-style:normal; font-size:11px; }
    #ndd-rv .cm .note { margin:3px 0 5px 21px; padding:4px 7px; border-left:3px solid #e0a800; background:#fff8e1; color:#6b4e00; font-size:11px; line-height:1.35; border-radius:2px; }
    #ndd-env-sum { font-size:12px; line-height:1.5; color:#445; }
    #ndd-env-alert { font-size:12px; line-height:1.4; }
    #ndd-env-alert > div { margin-top:3px; padding:1px 0 1px 7px; border-left:3px solid #ccd; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #ndd-env-alert .warn { border-color:#d4ac0d; color:#7d6608; background:#fffbea; }
    #ndd-env-alert .bad { border-color:#c0392b; color:#922b21; background:#fdf1ef; }
    #ndd-env-alert .ok { border-color:#27ae60; color:#1e8449; background:none; }
    #ndd-bulk-bar #ndd-env-refresh { flex:0 0 auto; }
  `;
  document.head.appendChild(style);

  // ===========================================================================
  // Painel
  // ===========================================================================
  const bar = document.createElement('div');
  bar.id = 'ndd-bulk-bar';
  bar.innerHTML = `
    <div class="title" id="ndd-bulk-title"><button id="ndd-bulk-toggle" type="button" title="Recolher">▾</button><span class="nm">NDD Printer M-Manager</span><button id="ndd-bulk-count" type="button" title="Abrir a lista mostrando só as selecionadas">0 selecionadas</button></div>
    <div class="body">
      <button id="ndd-bulk-list" class="primary big" title="Abre a lista completa do NDD (todas as páginas) com busca e filtros por coluna; marque as impressoras ali">☰ Abrir lista de impressoras</button>
      <div class="row quick">
        <button id="ndd-bulk-visible" title="Seleciona as linhas que aparecem na grade agora">Visíveis</button>
        <button id="ndd-bulk-all" title="Seleciona TODAS as impressoras do NDD, de todas as páginas">Tudo</button>
        <button id="ndd-bulk-usb" title="Impressoras com porta USB (USB001, USB002…), em todas as páginas; abre revisão para exceções">Portas USB</button>
        <button id="ndd-bulk-noqueue" disabled title="Impressoras sem nenhuma fila no servidor/estações, em todas as páginas; abre revisão para exceções">Sem fila</button>
        <button id="ndd-bulk-clear" class="ghost" title="Limpar toda a seleção">✕</button>
      </div>

      <div class="acc" data-sec="env">
        <div class="acc-h" title="Filas de impressão e hosts (somente leitura)"><span class="car">▸</span><span class="acc-t">Ambiente</span><span class="acc-s" id="ndd-env-chip"></span></div>
        <div class="acc-b">
          <div id="ndd-env-sum">Ainda não carregado.</div>
          <div id="ndd-env-alert"></div>
          <div class="row">
            <button id="ndd-env-hosts" disabled title="Máquinas com produtos NDD instalados: versão e última atualização">Hosts e produtos</button>
            <button id="ndd-env-refresh" title="Ler filas e hosts de novo no NDD">↻</button>
          </div>
        </div>
      </div>

      <div class="acc" data-sec="ser">
        <div class="acc-h" title="Comparar as impressoras do NDD com um arquivo de números de série"><span class="car">▸</span><span class="acc-t">Lista de séries</span><span class="acc-s" id="ndd-ser-chip"></span></div>
        <div class="acc-b">
          <div class="row">
            <button id="ndd-cmp-load" title="Arquivo .csv ou .txt com os números de série válidos">Carregar .csv/.txt</button>
            <button id="ndd-cmp-run" class="primary" disabled title="Carregue um arquivo de séries primeiro">Comparar</button>
            <button id="ndd-cmp-clear" class="ghost" disabled title="Descarta o arquivo carregado e a comparação (para outro cliente/ambiente)">✕</button>
            <input type="file" id="ndd-cmp-file" accept=".csv,.txt,text/csv,text/plain" style="display:none">
          </div>
          <div id="ndd-cmp-summary"></div>
          <div class="row">
            <button id="ndd-cmp-select-out" disabled title="Seleciona (em todas as páginas) as impressoras cuja série não está na lista">Séries fora da lista</button>
            <label class="small" title="Incluir também as impressoras sem número de série"><input type="checkbox" id="ndd-cmp-incl-noserial"> + sem série</label>
            <button id="ndd-cmp-exp-missing" disabled title="CSV com as séries da lista que não existem no NDD">⭳ Ausentes</button>
          </div>
        </div>
      </div>

      <div class="acc" data-sec="acc">
        <div class="acc-h" title="Alterar a contabilização das impressoras selecionadas"><span class="car">▸</span><span class="acc-t">Contabilização</span><span class="acc-s" id="ndd-acc-chip"></span></div>
        <div class="acc-b">
          <label class="f">Status
            <select id="ndd-acc-enabled">
              <option value="">— manter —</option>
              <option value="1">Habilitada</option>
              <option value="0">Desabilitada</option>
            </select>
          </label>
          <label class="f">Origem
            <select id="ndd-acc-origin">
              <option value="">— manter —</option>
              <option value="1">Padrão do sistema</option>
              <option value="2">Física e Lógica</option>
              <option value="4">Apenas Lógica</option>
              <option value="24">Apenas Física</option>
            </select>
          </label>
          <div class="sub" id="ndd-acc-hw">
            <label><input type="checkbox" id="ndd-acc-mf" checked> NDD Print MF Fabricante</label><br>
            <label><input type="checkbox" id="ndd-acc-col" checked> NDD Print Client Collector Fabricante</label>
          </div>
          <label class="f">Forçar cor
            <select id="ndd-acc-color">
              <option value="">— manter —</option>
              <option value="0">Não forçar</option>
              <option value="1">Forçar mono</option>
              <option value="2">Forçar color</option>
            </select>
          </label>
          <div class="acc-note" id="ndd-acc-note"></div>
          <div class="row"><button id="ndd-acc-apply" class="primary" disabled>Aplicar contabilização</button></div>
        </div>
      </div>

      <div class="row actions">
        <button id="ndd-bulk-delete" class="danger" disabled title="Abre a revisão e exclui as impressoras selecionadas (desabilita a contabilização antes)">Excluir selecionadas</button>
        <button id="ndd-bulk-stop" disabled style="display:none" title="Interrompe a operação em andamento">■ Parar</button>
      </div>
      <div id="ndd-bulk-progress"><div></div></div>
      <div class="logbar" id="ndd-logbar" style="display:none"><span>Log</span>
        <button id="ndd-log-save" class="lnk" title="Baixa o log completo desta aba em .txt">salvar</button>
        <button id="ndd-log-clear" class="lnk" title="Apaga o log desta aba (ele já é apagado sozinho ao fechar a aba)">limpar</button>
      </div>
      <div id="ndd-bulk-log"></div>
    </div>
  `;
  document.body.appendChild(bar);

  const $ = (id) => bar.querySelector('#' + id);

  // ---------------------------------------------------------------------------
  // Log (tela + histórico completo para download)
  // ---------------------------------------------------------------------------
  //   O log fica guardado no sessionStorage: sobrevive a F5 / recarga (manual ou automática) e a troca de tela,
  //   e é apagado pelo próprio navegador quando a aba é fechada.
  const logEl = $('ndd-bulk-log');
  const SS_LOG = 'ndd-mm-log';
  const LOG_VIEW_MAX = 600;      // linhas mostradas no painel (o histórico completo vai no "Salvar log")
  const LOG_HIST_MAX = 20000;    // linhas guardadas
  let logHistory = [];
  let logView = [];
  let errorCount = 0;
  let logSaveT = null;
  function persistLogNow() {
    clearTimeout(logSaveT); logSaveT = null;
    try {
      if (logHistory.length) sessionStorage.setItem(SS_LOG, JSON.stringify({ h: logHistory.slice(-LOG_HIST_MAX), v: logView, e: errorCount }));
      else sessionStorage.removeItem(SS_LOG);
    } catch { /* sem espaço/sem storage: segue só em memória */ }
  }
  function persistLogSoon() { if (!logSaveT) logSaveT = setTimeout(persistLogNow, 250); }
  function renderLog() {
    logEl.style.display = logView.length ? 'block' : 'none';
    logEl.textContent = logView.length ? logView.join('\n') + '\n' : '';
    logEl.scrollTop = logEl.scrollHeight;
  }
  window.addEventListener('pagehide', persistLogNow);
  window.addEventListener('beforeunload', persistLogNow);
  function ts() {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function log(msg, isError = false) {
    if (isError) errorCount++;
    logHistory.push(`[${ts()}] ${msg}`);
    logView.push(msg);
    if (logView.length > LOG_VIEW_MAX) logView = logView.slice(-LOG_VIEW_MAX);
    renderLog();
    persistLogSoon();
    (isError ? console.warn : console.log)('[NDD bulk]', msg);
    refreshUi();
  }
  // separador entre operações (o log não é mais zerado a cada ação)
  function logSection() { if (logView.length) { logView.push('────────────────────────'); logHistory.push(''); } }
  // restaura o log desta aba
  try {
    const sv = JSON.parse(sessionStorage.getItem(SS_LOG) || 'null');
    if (sv?.h?.length) {
      logHistory = sv.h; logView = Array.isArray(sv.v) ? sv.v : []; errorCount = sv.e || 0;
      const note = `↻ página recarregada às ${ts().slice(11)}`;
      // recargas seguidas viram uma linha só (não enchem o log)
      if (/^↻ página recarregada/.test(logView[logView.length - 1] || '')) { logView.pop(); if (/↻ página recarregada/.test(logHistory[logHistory.length - 1] || '')) logHistory.pop(); }
      logHistory.push(`[${ts()}] ${note}`); logView.push(note);
      renderLog();
      persistLogSoon();
    }
  } catch { /* log salvo ilegível: começa vazio */ }
  function download(name, text, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob(['﻿' + text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => ts().replace(/[: ]/g, '-');
  $('ndd-log-save').addEventListener('click', () => {
    if (!logHistory.length) { alert('O log está vazio.'); return; }
    download(`ndd360-log-${stamp()}.txt`, logHistory.join('\r\n'));
  });
  $('ndd-log-clear').addEventListener('click', () => {
    if (!logHistory.length) return;
    if (!confirm(`Apagar o log desta aba (${logHistory.length} linha(s))?`)) return;
    logHistory = []; logView = []; errorCount = 0;
    renderLog(); persistLogNow(); refreshUi();
  });

  function setProgress(done, total) {
    const p = $('ndd-bulk-progress');
    p.style.display = total ? 'block' : 'none';
    p.firstElementChild.style.width = total ? (100 * done) / total + '%' : '0';
  }
  function accChangeRequested() {
    return $('ndd-acc-enabled').value !== '' || $('ndd-acc-origin').value !== '' || $('ndd-acc-color').value !== '';
  }
  function refreshUi() {
    const n = selected.size;
    const badge = $('ndd-bulk-count');
    badge.textContent = `${n} selecionada${n === 1 ? '' : 's'}`;
    badge.classList.toggle('has', n > 0);
    $('ndd-bulk-delete').disabled = running || n === 0;
    $('ndd-bulk-delete').textContent = n ? `Excluir selecionadas (${n})` : 'Excluir selecionadas';
    $('ndd-acc-apply').disabled = running || n === 0 || !accChangeRequested();
    $('ndd-acc-apply').textContent = n ? `Aplicar contabilização (${n})` : 'Aplicar contabilização';
    $('ndd-bulk-noqueue').disabled = running || !queuesOk();
    ['ndd-bulk-list', 'ndd-bulk-visible', 'ndd-bulk-all', 'ndd-bulk-clear', 'ndd-bulk-usb', 'ndd-acc-enabled', 'ndd-acc-origin', 'ndd-acc-color',
      'ndd-acc-mf', 'ndd-acc-col', 'ndd-cmp-load'].forEach((id) => { $(id).disabled = running; });
    $('ndd-cmp-run').disabled = running || !contract;
    $('ndd-cmp-clear').disabled = running || !contract;
    scheduleSaveSelection();
    $('ndd-cmp-select-out').disabled = running || !cmp;
    $('ndd-cmp-exp-missing').disabled = !cmp;
    $('ndd-bulk-stop').disabled = !running;
    $('ndd-bulk-stop').style.display = running ? '' : 'none';
    $('ndd-logbar').style.display = logHistory.length ? 'flex' : 'none';
    $('ndd-log-save').textContent = errorCount ? `salvar (${errorCount} erro${errorCount === 1 ? '' : 's'})` : 'salvar';
    $('ndd-log-clear').disabled = running || logHistory.length === 0;
    // resumo no cabeçalho das seções recolhidas
    $('ndd-ser-chip').innerHTML = !contract ? '' : cmp
      ? `<span class="${cmp.out.length ? 'w' : ''}">${cmp.out.length} fora</span> · ${cmp.missing.length} ausentes`
      : `${contract.keys.size} séries carregadas`;
    $('ndd-acc-chip').textContent = accChangeRequested() ? describe(readAccForm()) : '';
    $('ndd-acc-hw').style.display = $('ndd-acc-origin').value === '24' ? 'block' : 'none';
    const af = readAccForm(), note = $('ndd-acc-note');
    note.textContent = af.autoEnable ? 'Origem definida com Status em "manter": as impressoras com a contabilização desabilitada serão habilitadas na mesma gravação.'
      : (af.origin !== null && af.enabled === false ? 'A origem será gravada, mas a contabilização ficará desabilitada (a coluna Origem mostra N/A).' : '');
    note.style.display = note.textContent ? 'block' : 'none';
  }
  ['ndd-acc-enabled', 'ndd-acc-origin', 'ndd-acc-color', 'ndd-acc-mf', 'ndd-acc-col'].forEach((id) => $(id).addEventListener('change', refreshUi));
  // Seções recolhíveis (estado lembrado)
  const LS_ACC = 'ndd-mm-acc';
  let accOpen = {};
  try { accOpen = JSON.parse(localStorage.getItem(LS_ACC) || '{}') || {}; } catch { /* ignore */ }
  bar.querySelectorAll('.acc').forEach((sec) => {
    const k = sec.dataset.sec;
    const set = (open) => { sec.classList.toggle('open', open); sec.querySelector('.car').textContent = open ? '▾' : '▸'; };
    set(!!accOpen[k]);
    sec.querySelector('.acc-h').addEventListener('click', () => {
      const open = !sec.classList.contains('open');
      set(open); accOpen[k] = open;
      try { localStorage.setItem(LS_ACC, JSON.stringify(accOpen)); } catch { /* ignore */ }
    });
  });
  // Expandir / recolher (estado lembrado entre recarregamentos)
  const LS_MIN = 'ndd-bulk-min';
  function setMin(min) {
    bar.classList.toggle('min', min);
    const t = $('ndd-bulk-toggle');
    t.textContent = min ? '▸' : '▾';
    t.title = min ? 'Expandir' : 'Recolher';
    try { localStorage.setItem(LS_MIN, min ? '1' : '0'); } catch { /* ignore */ }
  }
  $('ndd-bulk-title').addEventListener('click', (e) => { if (!e.target.closest('#ndd-bulk-count')) setMin(!bar.classList.contains('min')); });
  try { if (localStorage.getItem(LS_MIN) === '1') setMin(true); } catch { /* ignore */ }

  // ===========================================================================
  // Checkboxes + destaque na grade (grade virtualizada: linhas recicladas)
  // ===========================================================================
  function stopAll(e) { e.stopPropagation(); }
  const CMP_CLASSES = ['ndd-c-in', 'ndd-c-approx', 'ndd-c-out', 'ndd-c-noserial'];

  function syncGrid() {
    if (!isPrintersPage()) { bar.style.display = 'none'; return; }
    bar.style.display = '';

    // cabeçalho "TIPO" é o ordenador da grade: sem checkbox ali (use "Selecionar visíveis/tudo")
    document.getElementById('ndd-bulk-cb-all')?.remove();

    getRows().forEach((tr) => {
      const id = rowId(tr);
      const td = tr.children[0];
      let cb = td.querySelector('.ndd-bulk-cb');
      if (!cb) {
        cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'ndd-bulk-cb';
        ['mousedown', 'pointerdown', 'click', 'dblclick'].forEach((ev) => cb.addEventListener(ev, stopAll, true));
        cb.addEventListener('change', () => {
          const row = cb.closest('tr');
          const info = rowInfo(row);
          if (cb.checked) selected.set(info.id, { ...(selected.get(info.id) || {}), ...info }); else selected.delete(info.id);
          row.classList.toggle('ndd-bulk-marked', cb.checked);
          refreshUi();
        });
        td.prepend(cb);
      }
      const on = selected.has(id);
      if (cb.checked !== on) cb.checked = on;
      cb.disabled = running || deleted.has(id);
      tr.classList.toggle('ndd-bulk-marked', on);
      tr.classList.toggle('ndd-deleted', deleted.has(id));

      const st = cmp ? cmp.status.get(id) : null;
      CMP_CLASSES.forEach((c) => tr.classList.toggle(c, st === c.slice(6)));
      tr.title = st === 'out' ? 'Série fora da lista' : st === 'noserial' ? 'Impressora sem número de série'
        : st === 'approx' ? `Casada com a lista por aproximação (${cmp.approxBy.get(id)})` : '';
    });
    refreshUi();
  }

  let scheduled = false;
  new MutationObserver((muts) => {
    // Ignora mudanças do próprio painel/janela: evita o laço painel -> observer -> painel (CPU a 100%)
    if (muts.every((m) => { const n = m.target.nodeType === 1 ? m.target : m.target.parentElement; return n && n.closest('#ndd-bulk-bar, #ndd-rv'); })) return;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; syncGrid(); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ===========================================================================
  // Ambiente (cliente) atual + seleções salvas por cliente
  //   • seleções: localStorage por cliente, válidas por 24 h, revalidadas contra o NDD ao restaurar
  //   • troca de cliente (logout/login em outro) -> limpa contrato, comparação, cache e seleção em memória
  // ===========================================================================
  const LS_SEL_PREFIX = 'ndd-mm-sel:';
  const SEL_TTL = 24 * 60 * 60 * 1000;
  let tenant = null;
  let restoring = false;
  function readTenant() {
    const e = document.querySelector('.layout__navbar__menu__data__item__enterprisename');
    const name = e?.textContent.trim();
    if (!name) return null;
    const p = document.querySelector('.layout__navbar__menu__data__item__partner')?.textContent.trim() || '';
    return `${name} ${p}`.trim();
  }
  let saveTimer = null;
  function saveSelectionNow() {
    clearTimeout(saveTimer);
    if (!tenant || restoring) return;
    try {
      const k = LS_SEL_PREFIX + tenant;
      if (selected.size) localStorage.setItem(k, JSON.stringify({ at: Date.now(), items: [...selected.values()] }));
      else localStorage.removeItem(k);
    } catch { /* sem storage */ }
  }
  function scheduleSaveSelection() {
    if (!tenant || restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSelectionNow, 400);
  }

  // Recarga automática da página depois de uma ação que muda a grade (exclusão / contabilização).
  //   • o log continua (sessionStorage) e a seleção também (por cliente)
  //   • a lista de séries, que normalmente some no F5, é repassada SÓ nesta recarga automática
  //     e a comparação é refeita sozinha — um F5 manual continua limpando a lista
  const AUTO_RELOAD = true;
  const SS_HANDOFF = 'ndd-mm-handoff';
  function autoReload(why) {
    if (!AUTO_RELOAD) { log(`Atualize a página (F5) para recarregar a grade.`); return; }
    log(`↻ ${why} — recarregando a página para atualizar a grade…`);
    saveSelectionNow();
    try {
      if (contract) sessionStorage.setItem(SS_HANDOFF, JSON.stringify({ tenant, fileName: contract.fileName, serials: [...contract.original.values()], compared: !!cmp, at: Date.now() }));
    } catch { /* lista grande demais: será preciso carregar de novo */ }
    persistLogNow();
    setTimeout(() => location.reload(), 1200);
  }
  let handoff = null;
  try { handoff = JSON.parse(sessionStorage.getItem(SS_HANDOFF) || 'null'); sessionStorage.removeItem(SS_HANDOFF); } catch { /* ignore */ }
  async function resumeAfterReload() {
    if (!handoff || handoff.tenant !== tenant || Date.now() - handoff.at > 120000) { handoff = null; return; }
    const h = handoff; handoff = null;
    setContract(h.fileName, h.serials, true);
    log(`📄 Lista de séries mantida após a recarga automática: ${h.fileName} — ${contract.keys.size} série(s).`);
    if (h.compared) await runCompare();
  }
  async function restoreSelection() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_SEL_PREFIX + tenant) || 'null'); } catch { /* ignore */ }
    if (!saved?.items?.length) return;
    if (Date.now() - saved.at > SEL_TTL) { try { localStorage.removeItem(LS_SEL_PREFIX + tenant); } catch { /* */ } return; }
    restoring = true;
    try {
      // revalida: só mantém impressoras que ainda existem neste cliente
      const list = await ensurePrinters(true);
      const byId = new Map(list.map((p) => [p.id, p]));
      let gone = 0;
      saved.items.forEach((i) => {
        const p = byId.get(i.id);
        if (p) selected.set(p.id, apiInfo(p)); else gone++;
      });
      if (selected.size || gone) log(`↺ ${selected.size} seleção(ões) restaurada(s) para ${tenant}${gone ? ` (${gone} não existem mais e foram descartadas)` : ''}.`);
    } catch (e) {
      log(`✖ Não foi possível restaurar a seleção salva: ${e.message}`, true);
    }
    restoring = false;
    scheduleSaveSelection();
    syncGrid();
  }
  function onTenantChange(prev, next) {
    // outro cliente: nada do anterior pode vazar para este
    selected.clear();
    deleted.clear();
    printersCache = null;
    envCache = null; renderEnvPanel(false);
    accCache.clear(); originMeta = newOriginMeta(); // a origem guardada do cliente anterior continua no localStorage dele
    logSection();
    clearContract(`cliente alterado: ${prev} → ${next}`);
  }
  setInterval(() => {
    // tela de uma impressora aberta: a contabilização pode ser editada à mão ali -> descarta o que havia em cache dela
    const onPrinter = location.pathname.match(/^\/printers\/(\d+)/);
    if (onPrinter) accForget([Number(onPrinter[1])]);
    const t = readTenant();
    if (!t || t === tenant) return; // null = tela de login/transição: não mexe em nada
    const prev = tenant;
    if (prev && originSaveT) saveOriginNow(); // grava o que faltava do cliente anterior, ainda com o nome dele
    tenant = t;
    if (prev) onTenantChange(prev, t);
    loadOriginCache();
    restoreSelection().then(resumeAfterReload).finally(() => refreshEnv(false)); // filas/hosts: leitura leve, em 2º plano
  }, 1000);

  // ===========================================================================
  // Seleção manual
  // ===========================================================================
  $('ndd-bulk-visible').addEventListener('click', () => {
    getRows().forEach((tr) => { const i = rowInfo(tr); if (!deleted.has(i.id)) selected.set(i.id, i); });
    syncGrid();
  });
  $('ndd-bulk-clear').addEventListener('click', () => { selected.clear(); syncGrid(); });
  // Selecionar portas USB: USB001, USB002… (e variações como "USB DXP01 Port"), em todas as páginas.
  // Abre a janela de revisão para desmarcar exceções antes de aplicar.
  const isUsbPort = (port) => /^\s*USB/i.test(port || '');
  async function openUsbReview() {
    if (running) return;
    running = true; stopRequested = false; refreshUi();
    let list = null;
    try { list = (await ensurePrinters(true)).filter((p) => !deleted.has(p.id) && isUsbPort(p.addressPort)); }
    catch (e) { log(`✖ Falha ao buscar impressoras: ${e.message}`, true); }
    setProgress(0, 0);
    running = false;
    syncGrid();
    if (!list) return;
    if (!list.length) { log('Nenhuma impressora com porta USB encontrada.'); return; }
    const ports = new Set(list.map((p) => (p.addressPort || '').trim().toUpperCase()));
    log(`🔌 ${list.length} impressora(s) em porta USB (${[...ports].sort().slice(0, 8).join(', ')}${ports.size > 8 ? '…' : ''}).`);
    openReview(list, `Portas USB (${list.length})`, { onRefresh: openUsbReview });
  }
  $('ndd-bulk-usb').addEventListener('click', openUsbReview);

  // Selecionar tudo: busca a lista completa do NDD (todas as páginas) e seleciona tudo
  $('ndd-bulk-all').addEventListener('click', async () => {
    if (running) return;
    running = true; stopRequested = false; refreshUi();
    try {
      const t0 = performance.now();
      const list = await ensurePrinters(true);
      let n = 0;
      list.forEach((p) => { if (!deleted.has(p.id)) { selected.set(p.id, apiInfo(p)); n++; } });
      log(`☑ Selecionar tudo: ${n} impressora(s) de todas as páginas em ${Math.round(performance.now() - t0)} ms.`);
    } catch (e) {
      log(`✖ Falha ao selecionar tudo: ${e.message}`, true);
    }
    setProgress(0, 0);
    running = false;
    syncGrid();
  });
  $('ndd-bulk-stop').addEventListener('click', () => {
    stopRequested = true;
    const n = inflightCtl.size;
    inflightCtl.forEach((c) => c.abort('stop'));
    log(`⏹ Parada solicitada${n ? ` — ${n} requisição(ões) em andamento cancelada(s) no navegador (o servidor pode concluí-las mesmo assim)` : ''}.`);
  });

  // ===========================================================================
  // HTTP
  // ===========================================================================
  function extractError(text, status) {
    try {
      const j = JSON.parse(text);
      let m = j?.error?.message || j?.message || j?.Message || j?.errors?.[0]?.message || j?.title;
      // desce até a exceção mais interna (o NDD devolve "See the inner exception for details")
      let inner = j?.innerException, deepest = null;
      while (inner) { deepest = inner.exceptionMessage || inner.message || deepest; inner = inner.innerException; }
      if (deepest && deepest !== m) m = `${m} → ${deepest}`;
      if (j?.exceptionType) m += ` [${j.exceptionType.split('.').pop()}]`;
      if (m) return `HTTP ${status} — ${m.replace(/\s+/g, ' ').slice(0, 400)}`;
    } catch { /* texto puro */ }
    return `HTTP ${status}${text ? ' — ' + text.replace(/\s+/g, ' ').slice(0, 200) : ''}`;
  }

  // Requisições em andamento (para "Parar" cancelar de verdade) + timeout por requisição
  const inflightCtl = new Set();
  const T_FAST = 60 * 1000;        // leitura / exclusão
  const T_SLOW = 6 * 60 * 1000;    // desabilitar contabilização (servidor pode levar minutos)
  async function apiJson(url, opts = {}) {
    const { timeout = T_FAST, bg = false, ...rest } = opts; // bg: leitura de 2º plano, fora do alcance do "Parar"
    const ctl = new AbortController();
    if (!bg) inflightCtl.add(ctl);
    const timer = setTimeout(() => ctl.abort('timeout'), timeout);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        ...rest,
        signal: ctl.signal,
        headers: { Accept: 'application/json, text/plain, */*', ...(rest.body ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers || {}) },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(extractError(text, res.status));
      try { return text ? JSON.parse(text) : null; } catch { return text; }
    } catch (e) {
      if (ctl.signal.aborted) throw new Error(ctl.signal.reason === 'stop' ? 'cancelado pelo usuário' : `sem resposta do servidor em ${Math.round(timeout / 1000)} s`);
      throw e;
    } finally {
      clearTimeout(timer);
      inflightCtl.delete(ctl);
    }
  }

  // "Batimento": a cada 15 s informa no log o que está demorando (o log nunca fica mudo)
  const pending = new Map(); // token -> { label, start }
  let hbTimer = null;
  function track(label) {
    const tok = Symbol();
    pending.set(tok, { label, start: Date.now() });
    if (!hbTimer) hbTimer = setInterval(() => {
      const slow = [...pending.values()].filter((p) => Date.now() - p.start > 15000);
      slow.forEach((p) => log(`   … aguardando servidor há ${Math.round((Date.now() - p.start) / 1000)} s: ${p.label}`));
      if (!pending.size) { clearInterval(hbTimer); hbTimer = null; }
    }, 15000);
    return () => pending.delete(tok);
  }

  // Executa tarefas com N em paralelo, respeitando "Parar"
  async function pool(items, concurrency, fn) {
    let idx = 0;
    const worker = async () => {
      while (!stopRequested && idx < items.length) {
        const i = idx++;
        await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  }

  // ===========================================================================
  // Origem da contabilização (SOMENTE LEITURA) — coluna "Origem" das janelas de lista/revisão
  //
  //  Medido no portal (out/2026, cliente com 909 impressoras, 878 habilitadas):
  //   • o campo não existe em nenhuma lista: conferidos todos os conjuntos OData ($metadata), os serviços que o
  //     portal usa e os outros hosts. Única fonte: GET /api/printers/{id}/accounting (1 leitura por impressora)
  //   • cada leitura custa 350–600 ms de processamento no servidor; nada no navegador reduz isso
  //   • paralelismo (leituras/s): 1 → 1,8 · 3 → 4,7 · 5 → 8,7 · 6 → 12,1 · 8 → 10,0 · 12 → 9,5 · 24 → 8,8
  //     (portal em HTTP/1.1: o navegador abre no máximo 6 conexões; acima disso só enfileira)
  //   => ler tudo é caro por natureza (≈ 13–18 min para 10 mil). O ganho real está em NÃO reler:
  //
  //  Modelo aplicado:
  //   1) a coluna vem desligada; a leitura só começa quando ela é ligada (escolha lembrada por cliente)
  //   2) leitura com 6 conexões, sempre começando pelas linhas que estão na tela
  //   3) o que foi lido fica guardado por cliente (localStorage) e é CONFERIDO pela auditoria do NDD:
  //      /odata/audits registra toda mudança de contabilização por impressora (360APrinterAcc*) e de regra/padrão
  //      de origem (360ASett*). A cada abertura, 2 consultas (~1 s) dizem o que mudou desde a última conferência
  //      e só essas impressoras são relidas. Mudança de regra/padrão, ou mudança que não dá para casar com uma
  //      impressora, descarta tudo (relê tudo).
  //   4) redes de segurança: sem acesso à auditoria uma leitura vale 60 min; com auditoria cada valor é relido
  //      de qualquer forma após 7–11 dias (escalonado, para não reler tudo no mesmo dia)
  //   • só lê impressoras com contabilização HABILITADA (desabilitada = "N/A", sem requisição)
  //   • as ações do script (contabilização/exclusão) já leem esse endpoint: o cache aproveita essas leituras
  //   • pausa sozinho enquanto uma ação está rodando e não é cancelado pelo "Parar"
  //   • "Padrão do Sistema (xxx)": xxx vem de defaultTrustOrigin, devolvido na mesma resposta
  // ===========================================================================
  const ORIGIN_CONCURRENCY = 6;
  const ORIGIN_ERR_TTL = 60 * 1000;
  const ORIGIN_SOFT_TTL = 60 * 60 * 1000;            // sem auditoria: quanto vale uma leitura
  const ORIGIN_HARD_TTL = 7 * 24 * 60 * 60 * 1000;   // com auditoria: releitura de segurança (+ até 4 dias, escalonado por id)
  const ORIGIN_SYNC_TTL = 60 * 1000;                 // uma conferência pela auditoria é reaproveitada por 1 min
  const ORIGIN_KEEP_TENANTS = 4;                     // clientes com origem guardada (os mais antigos saem)
  const AUDIT_URL = '/odata/audits';
  const AUDIT_MAX_ROWS = 20000;                      // mais mudanças que isso desde a última conferência: relê tudo
  const AUDIT_MARGIN = 25;                           // reconsulta os últimos registros (gravações ainda em andamento no servidor)
  const AUDIT_FILTER = "(startswith(actionResource,'360APrinterAcc') or startswith(actionResource,'360APrinterConsolidation')" +
    " or actionResource eq '360APrinterRemoved' or startswith(actionResource,'360ASettPrinters') or startswith(actionResource,'360ASettAcc'))";
  const LS_ORIGIN = 'ndd-mm-origin:';                // + cliente
  const accCache = new Map();        // id -> { at, en, o, mf, col, dO, dMf, dCol, fc } | { at, err }
  const originInflight = new Map();  // id -> Promise (evita ler a mesma impressora duas vezes)
  // W = id da auditoria até onde o cache está conferido; seen = registros acima de W já processados;
  // on = colunas ligadas neste cliente; syncOk = a última conferência pela auditoria funcionou
  const newOriginMeta = () => ({ W: null, seen: [], on: {}, syncAt: 0, syncOk: false, syncErr: '' });
  let originMeta = newOriginMeta();
  let originSaveT = null;
  function pruneOriginStores(keepKey, keepOthers) {
    const others = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(LS_ORIGIN) && k !== keepKey) others.push(k); }
    if (others.length <= keepOthers) return;
    const savedAt = (k) => { try { return Number((localStorage.getItem(k).match(/"at":(\d+)/) || [])[1]) || 0; } catch { return 0; } };
    others.map((k) => [k, savedAt(k)]).sort((a, b) => b[1] - a[1]).slice(keepOthers).forEach(([k]) => localStorage.removeItem(k));
  }
  function saveOriginNow() {
    clearTimeout(originSaveT); originSaveT = null;
    if (!tenant) return;
    const key = LS_ORIGIN + tenant;
    try {
      const now = Date.now(), items = [];
      accCache.forEach((c, id) => {
        if (c.err || now - c.at > 2 * ORIGIN_HARD_TTL) return;
        items.push([id, Math.round(c.at / 60000), c.o, (c.en ? 1 : 0) | (c.mf ? 2 : 0) | (c.col ? 4 : 0) | (c.dMf ? 8 : 0) | (c.dCol ? 16 : 0), c.dO ?? 0, c.fc ?? 0]);
      });
      if (!items.length && !Object.values(originMeta.on).some(Boolean)) { localStorage.removeItem(key); return; }
      const data = JSON.stringify({ v: 1, at: now, W: originMeta.W, seen: originMeta.seen, on: originMeta.on, items });
      try { localStorage.setItem(key, data); }
      catch { pruneOriginStores(key, 0); localStorage.setItem(key, data); } // sem espaço: solta a origem guardada dos outros clientes
      pruneOriginStores(key, ORIGIN_KEEP_TENANTS - 1);
    } catch { try { localStorage.removeItem(key); } catch { /* fica só em memória */ } }
  }
  const scheduleSaveOrigin = () => { if (!originSaveT) originSaveT = setTimeout(saveOriginNow, 2500); };
  function loadOriginCache() {
    originMeta = newOriginMeta();
    try { sessionStorage.removeItem('ndd-mm-origin'); } catch { /* formato da v4.6.0 */ }
    try {
      const sv = JSON.parse(localStorage.getItem(LS_ORIGIN + tenant) || 'null');
      if (!sv || sv.v !== 1) return;
      originMeta.W = typeof sv.W === 'number' ? sv.W : null;
      originMeta.seen = Array.isArray(sv.seen) ? sv.seen : [];
      originMeta.on = sv.on && typeof sv.on === 'object' ? sv.on : {};
      (sv.items || []).forEach(([id, atMin, o, f, dO, fc]) => {
        if (!accCache.has(id)) accCache.set(id, { at: atMin * 60000, en: !!(f & 1), o, mf: !!(f & 2), col: !!(f & 4), dMf: !!(f & 8), dCol: !!(f & 16), dO, fc });
      });
    } catch { /* ignore */ }
  }
  window.addEventListener('pagehide', () => { if (originSaveT) saveOriginNow(); });
  // Guarda a resposta de /api/printers/{id}/accounting. Nunca lança erro (é chamada de dentro das ações).
  function accRemember(id, a) {
    try {
      if (!a || typeof a !== 'object' || a.__error || typeof a.trustOrigin !== 'number') return false;
      accCache.set(id, { at: Date.now(), en: !!a.enabledAccounting, o: a.trustOrigin, mf: !!a.hardwareMF, col: !!a.hardwareCollector,
        dO: a.defaultTrustOrigin, dMf: !!a.defaultHardwareMF, dCol: !!a.defaultHardwareCollector, fc: a.forceColor });
      scheduleSaveOrigin();
      return true;
    } catch { return false; }
  }
  function accForget(ids) {
    let n = 0;
    ids.forEach((id) => { if (accCache.delete(id)) n++; });
    if (n) scheduleSaveOrigin();
  }
  const originTtl = (id) => (originMeta.syncOk ? ORIGIN_HARD_TTL + (id % 96) * 3600000 : ORIGIN_SOFT_TTL);
  const accFresh = (id) => { const c = accCache.get(id); return c && Date.now() - c.at < (c.err ? ORIGIN_ERR_TTL : originTtl(id)) ? c : null; };
  function readOrigin(id) {
    let p = originInflight.get(id);
    if (!p) {
      const forTenant = tenant;
      p = apiJson(API.accGet(id), { bg: true })
        .then((a) => { if (forTenant !== tenant) return; if (!accRemember(id, a)) accCache.set(id, { at: Date.now(), err: 'resposta inesperada do NDD' }); })
        .catch((e) => { if (forTenant === tenant) accCache.set(id, { at: Date.now(), err: e.message }); })
        .finally(() => originInflight.delete(id));
      originInflight.set(id, p);
    }
    return p;
  }
  // Lê a origem dos ids informados, ORIGIN_CONCURRENCY por vez. alive() = false interrompe (janela fechada).
  // prefer(todo) pode indicar qual ler primeiro (ex.: as linhas que estão na tela agora).
  async function loadOrigins(ids, alive, onItem, prefer) {
    const todo = new Set(ids);
    const take = () => {
      let id = prefer ? prefer(todo) : undefined;
      if (id === undefined || !todo.has(id)) id = todo.values().next().value;
      todo.delete(id);
      return id;
    };
    const worker = async () => {
      while (todo.size && alive()) {
        if (running) { await sleep(500); continue; } // não disputa conexões com uma ação em andamento
        const id = take();
        if (!accFresh(id)) await readOrigin(id);
        onItem(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(ORIGIN_CONCURRENCY, todo.size) }, worker));
  }

  // ---- conferência do cache pela auditoria do NDD ----
  const auditNorm = (x) => String(x ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const auditSerial = (x) => { const v = auditNorm(x); return v === '-' ? '' : v; };
  const auditKey = (name, addr, serial) => `${name}|${addr}|${serial}`;
  // A auditoria grava o objeto afetado como "Nome - Endereço - Série". Lido da direita: o nome pode conter " - ".
  function auditParse(obj) {
    const parts = String(obj ?? '').replace(/\s+-\s*$/, ' - ').split(' - ');
    const serial = auditSerial(parts.pop());
    const addr = auditNorm(parts.pop());
    const name = auditNorm(parts.join(' - '));
    return { addr, serial, key: auditKey(name, addr, serial) };
  }
  // Quais impressoras precisam ser relidas segundo os registros de auditoria. Devolve Set de ids, ou 'all'.
  //   • casa por nome+endereço+série e também só por endereço ou só por série (pega impressora renomeada depois)
  //   • registro que não casa com ninguém: ok se a impressora foi excluída depois; senão, na dúvida, relê tudo
  function auditStale(rows, printers, seen) {
    if (rows.some((r) => !seen.has(r.id) && /^360ASett/.test(r.actionResource))) return 'all'; // regra/padrão de origem mudou
    const exact = new Map(), byAddr = new Map(), bySerial = new Map();
    const add = (m, k, id) => { if (k) (m.get(k) || m.set(k, []).get(k)).push(id); };
    printers.forEach((p) => {
      const n = auditNorm(p.printerName), a = auditNorm(p.addressName), sn = auditSerial(p.serialNumber);
      add(exact, auditKey(n, a, sn), p.id); add(byAddr, a, p.id); if (sn.length >= 4) add(bySerial, sn, p.id);
    });
    const removed = new Map(); // nome/endereço/série -> maior id de auditoria de exclusão
    const mark = (k, id) => { if ((removed.get(k) || 0) < id) removed.set(k, id); };
    rows.forEach((r) => {
      if (r.actionResource !== '360APrinterRemoved') return;
      const o = auditParse(r.affectedObject);
      mark(`k:${o.key}`, r.id); if (o.addr) mark(`a:${o.addr}`, r.id); if (o.serial.length >= 4) mark(`s:${o.serial}`, r.id);
    });
    const stale = new Set();
    for (const r of rows) {
      if (seen.has(r.id) || r.actionResource === '360APrinterRemoved' || /^360ASett/.test(r.actionResource)) continue;
      const o = auditParse(r.affectedObject);
      const ids = [...(exact.get(o.key) || []), ...(byAddr.get(o.addr) || []), ...(o.serial.length >= 4 ? bySerial.get(o.serial) || [] : [])];
      if (ids.length) { ids.forEach((id) => stale.add(id)); continue; }
      const gone = Math.max(removed.get(`k:${o.key}`) || 0, removed.get(`a:${o.addr}`) || 0, o.serial.length >= 4 ? removed.get(`s:${o.serial}`) || 0 : 0);
      if (gone < r.id) return 'all';
    }
    return stale;
  }
  async function doOriginSync() {
    const forTenant = tenant;
    const q = (qs) => apiJson(`${AUDIT_URL}?language=pt-BR&${qs}`, { bg: true, timeout: 20000 });
    let ok = false, err = '';
    try {
      const head = (await q('$top=1&$orderby=id desc&$select=id')).value?.[0]?.id ?? 0; // 1º a "cabeça": nada gravado depois dela fica de fora
      const hadW = originMeta.W != null;
      const from = hadW ? originMeta.W : Math.max(0, head - AUDIT_MARGIN);
      const base = `$orderby=id&$select=id,actionResource,affectedObject&$filter=${encodeURIComponent(`id gt ${from} and ${AUDIT_FILTER}`)}`;
      const first = await q(`$top=${PAGE_SIZE}&$count=true&${base}`);
      const total = first['@odata.count'] ?? first.value.length;
      let rows = first.value, verdict = 'all'; // sem conferência anterior, ou mudanças demais: o que estava guardado não vale
      if (hadW && total <= AUDIT_MAX_ROWS) {
        const skips = [];
        for (let k = PAGE_SIZE; k < total; k += PAGE_SIZE) skips.push(k);
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(4, skips.length) }, async () => {
          while (i < skips.length) { const k = skips[i++]; rows = rows.concat((await q(`$top=${PAGE_SIZE}&$skip=${k}&${base}`)).value); }
        }));
        const printers = printersCache ? printersCache.list : await fetchAllOdata(API.list, 200000);
        if (forTenant !== tenant) return;
        verdict = auditStale(rows, printers, new Set(originMeta.seen));
        if (printersCache && Date.now() - printersCache.at < CACHE_TTL) { // lista recente: solta do cache quem não existe mais
          const alive = new Set(printers.map((p) => p.id));
          accForget([...accCache.keys()].filter((id) => !alive.has(id)));
        }
      }
      if (forTenant !== tenant) return;
      if (verdict === 'all') accCache.clear(); else accForget([...verdict]);
      originMeta.W = Math.max(hadW ? originMeta.W : 0, head - AUDIT_MARGIN);
      originMeta.seen = rows.map((r) => r.id).filter((id) => id > originMeta.W);
      ok = true;
    } catch (e) { err = e.message; }
    if (forTenant !== tenant) return;
    originMeta.syncOk = ok; originMeta.syncErr = err; originMeta.syncAt = Date.now();
    scheduleSaveOrigin();
  }
  let originSyncP = null;
  // Confere o cache pela auditoria (no máximo 1 vez por minuto, salvo force). Nunca lança erro.
  function originSync(force) {
    if (originSyncP) return originSyncP;
    if (!force && originMeta.syncAt && Date.now() - originMeta.syncAt < ORIGIN_SYNC_TTL) return Promise.resolve();
    originSyncP = doOriginSync().finally(() => { originSyncP = null; });
    return originSyncP;
  }

  const originName = (o) => ORIGIN_LABEL[o] || `Código ${o}`;
  const fmtWhen = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  // O que mostrar na coluna: "Apenas Lógica" | "Apenas Física" | "Física e Lógica" | "Padrão do Sistema (xxx)" | "N/A"
  function originView(enabled, c) {
    if (!enabled) return { state: 'na', text: 'N/A', tip: 'Contabilização desabilitada', hw: '', color: 'N/A' };
    if (!c) return { state: 'load', text: 'Carregando…', tip: 'Coletando a origem no NDD…', hw: '', color: 'Carregando…' };
    if (c.err) return { state: 'err', text: 'Erro', tip: `Não foi possível ler a origem: ${c.err}`, hw: '', color: 'Erro' };
    const isDef = c.o === 1;
    const eff = isDef ? c.dO : c.o;                                   // origem que vale de fato
    const text = isDef ? (ORIGIN_LABEL[c.dO] && c.dO !== 1 ? `Padrão do Sistema (${ORIGIN_LABEL[c.dO]})` : 'Padrão do Sistema') : originName(c.o);
    const hw = eff === 24 ? ([(isDef ? c.dMf : c.mf) && 'MF Fabricante', (isDef ? c.dCol : c.col) && 'Client Collector Fabricante'].filter(Boolean).join(' + ') || 'nenhuma marcada') : '';
    return { state: 'ok', text, hw, tip: `${hw ? `Fonte física: ${hw} · ` : ''}coletada no NDD em ${fmtWhen(c.at)}`, color: COLOR_LABEL[c.fc] ?? `Código ${c.fc}` };
  }

  // Busca TODAS as impressoras em segundo plano (páginas de 100 em paralelo)
  async function fetchAllPrinters(onProgress) {
    const url = (skip, count) =>
      `${API.list}?$skip=${skip}&$top=${PAGE_SIZE}&$orderby=id${count ? '&$count=true' : ''}&$select=${LIST_SELECT}`;
    const first = await apiJson(url(0, true));
    const total = first['@odata.count'] ?? first.value.length;
    const pages = [];
    for (let s = PAGE_SIZE; s < total; s += PAGE_SIZE) pages.push(s);
    const chunks = new Array(pages.length);
    let done = 1;
    onProgress?.(done, pages.length + 1);
    await pool(pages, LIST_CONCURRENCY, async (skip, i) => {
      for (let attempt = 1; ; attempt++) {
        try { chunks[i] = (await apiJson(url(skip))).value; break; }
        catch (e) { if (attempt >= 3) throw e; await sleep(500 * attempt); }
      }
      onProgress?.(++done, pages.length + 1);
    });
    if (stopRequested) throw new Error('interrompido pelo usuário');
    const map = new Map();
    first.value.concat(...chunks).forEach((p) => map.set(p.id, p)); // dedup por id
    return { total, list: [...map.values()] };
  }

  // ===========================================================================
  // Contrato: leitura do arquivo e normalização dos seriais
  // ===========================================================================
  // Chave de comparação: maiúsculas, só A-Z0-9, letra O tratada como zero (erro comum de digitação)
  const serialKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');
  const MIN_SERIAL = 5;

  function parseContract(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const delim = [';', '\t', ','].find((d) => lines[0].includes(d));
    const split = (l) => (delim ? l.split(delim) : [l]).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
    let col = 0;
    let start = 0;
    const head = split(lines[0]);
    const hi = head.findIndex((h) => !/\d/.test(h) && /s[ée]rie|serial|^sn$|n[ºo°]?\s*s[ée]rie/i.test(h)); // cabeçalho não tem dígitos
    if (hi >= 0) { col = hi; start = 1; }
    else if (head.length === 1 && !/\d/.test(head[0])) start = 1; // cabeçalho sem dígitos em arquivo de 1 coluna
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const v = split(lines[i])[col] || '';
      if (serialKey(v).length >= MIN_SERIAL) out.push(v);
    }
    return out;
  }

  function setContract(fileName, serials, silent) {
    const keys = new Set();
    const original = new Map();
    let dup = 0;
    serials.forEach((s) => {
      const k = serialKey(s);
      if (keys.has(k)) { dup++; return; }
      keys.add(k); original.set(k, s.trim());
    });
    contract = { fileName, keys, original };
    cmp = null;
    $('ndd-cmp-run').textContent = `Comparar (${keys.size})`;
    refreshUi();
    $('ndd-cmp-run').title = `${fileName} — ${keys.size} série(s) na lista. Busca TODAS as impressoras do NDD e compara.`;
    $('ndd-cmp-summary').innerHTML = '';
    if (!silent) log(`📄 Lista de séries carregada: ${fileName} — ${keys.size} série(s)${dup ? `, ${dup} duplicada(s) ignorada(s)` : ''}.`);
    syncGrid();
  }

  // Contrato e comparação ficam SÓ na memória da aba: recarregar, sair ou abrir outra janela/cliente limpa.
  try { localStorage.removeItem(LS_CONTRACT); } catch { /* remove dado salvo por versões antigas */ }

  function clearContract(reason) {
    const had = !!contract;
    contract = null;
    cmp = null;
    $('ndd-cmp-run').textContent = 'Comparar';
    $('ndd-cmp-run').title = 'Carregue um arquivo de séries primeiro';
    $('ndd-cmp-summary').innerHTML = '';
    if (had && reason) log(`🧹 Lista de séries e comparação limpas${reason ? ' — ' + reason : ''}.`);
    syncGrid();
  }
  $('ndd-cmp-clear').addEventListener('click', (e) => { e.stopPropagation(); clearContract('pelo usuário'); });

  $('ndd-cmp-load').addEventListener('click', () => $('ndd-cmp-file').click());
  $('ndd-cmp-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let text = await f.text();
    if (text.includes('�')) { // provável ANSI/Latin-1 (Excel)
      text = new TextDecoder('windows-1252').decode(await f.arrayBuffer());
    }
    const serials = parseContract(text);
    if (!serials.length) { alert('Nenhum número de série encontrado no arquivo.'); return; }
    setContract(f.name, serials);
  });

  // ===========================================================================
  // Comparação
  //   1) exato                           BRXXA1B234 = BRXXA1B234
  //   2) NDD com 1 caractere a mais      Z8HFB1EG40001YX -> Z8HFB1EG40001Y (Samsung/HP A3 reportam dígito extra)
  //   3) NDD truncado (sufixo, ≥7 car.)  XXA1B234 -> BRXXA1B234
  // ===========================================================================
  function matchSerial(ndKey) {
    const K = contract.keys;
    if (K.has(ndKey)) return { key: ndKey, how: null };
    if (ndKey.length >= 11 && K.has(ndKey.slice(0, -1))) return { key: ndKey.slice(0, -1), how: '+1 caractere no NDD' };
    if (ndKey.length >= 7) {
      for (const k of K) if (k.length > ndKey.length && k.endsWith(ndKey)) return { key: k, how: 'série truncada no NDD' };
    }
    return null;
  }

  async function runCompare() {
    if (running || !contract) return;
    running = true; stopRequested = false;
    refreshUi();
    const t0 = performance.now();
    log(`🔎 Buscando todas as impressoras do NDD (${PAGE_SIZE}/página, ${LIST_CONCURRENCY} em paralelo)…`);
    try {
      const { list } = await fetchAllPrinters((d, t) => setProgress(d, t));
      printersCache = { list, at: Date.now() };
      const status = new Map();
      const approxBy = new Map();
      const out = [], noSerial = [], approx = [];
      const matchedKeys = new Map(); // contractKey -> [info]
      for (const p of list) {
        if (deleted.has(p.id)) continue;
        const info = apiInfo(p);
        const k = serialKey(info.serial);
        if (k.length < MIN_SERIAL) { status.set(p.id, 'noserial'); noSerial.push(info); continue; }
        const m = matchSerial(k);
        if (!m) { status.set(p.id, 'out'); out.push(info); continue; }
        status.set(p.id, m.how ? 'approx' : 'in');
        if (m.how) { approxBy.set(p.id, `${m.how}: lista ${contract.original.get(m.key)}`); approx.push({ info, contract: contract.original.get(m.key), how: m.how }); }
        if (!matchedKeys.has(m.key)) matchedKeys.set(m.key, []);
        matchedKeys.get(m.key).push(info);
      }
      const missing = [...contract.keys].filter((k) => !matchedKeys.has(k)).map((k) => contract.original.get(k));
      const dupNdd = [...matchedKeys.entries()].filter(([, v]) => v.length > 1);
      cmp = { status, approxBy, out, noSerial, missing, approx, dupNdd, total: list.length, at: ts() };

      const ms = Math.round(performance.now() - t0);
      $('ndd-cmp-summary').innerHTML = `
        <b>${list.length}</b> no NDD · <b>${contract.keys.size}</b> na lista · ${(ms / 1000).toFixed(1)} s<br>
        <span class="sw" style="background:#27ae60"></span>Na lista: <b>${[...status.values()].filter((s) => s === 'in').length}</b>
        &nbsp;<span class="sw" style="background:#8e44ad"></span>Por aproximação: <b>${approx.length}</b><br>
        <span class="sw" style="background:#e67e22"></span>Fora da lista: <b>${out.length}</b>
        &nbsp;<span class="sw" style="background:#f1c40f"></span>Sem série: <b>${noSerial.length}</b><br>
        ⚠ Na lista e <u>não</u> no NDD: <b>${missing.length}</b>${dupNdd.length ? ` · séries repetidas no NDD: <b>${dupNdd.length}</b>` : ''}`;
      log(`✔ Comparação em ${ms} ms: ${out.length} fora da lista, ${noSerial.length} sem série, ${approx.length} por aproximação, ${missing.length} da lista não encontradas no NDD.`);
      if (missing.length) log(`   Faltantes no NDD: ${missing.join(', ')}`);
      dupNdd.forEach(([k, v]) => log(`   Série ${contract.original.get(k)} aparece ${v.length}x no NDD: ${v.map((i) => i.name + ' #' + i.id).join(' ; ')}`));
    } catch (e) {
      log(`✖ Falha na comparação: ${e.message}`, true);
    }
    setProgress(0, 0);
    running = false;
    syncGrid();
  }
  $('ndd-cmp-run').addEventListener('click', runCompare);

  function openSeriesReview() {
    if (!cmp) return;
    const incl = $('ndd-cmp-incl-noserial').checked;
    const list = cmp.out.concat(incl ? cmp.noSerial : []).filter((i) => !deleted.has(i.id));
    if (!list.length) { log('Nenhuma impressora com série fora da lista.'); return; }
    const cons = list.filter((i) => i.consolidated).length;
    if (cons) log(`ℹ ${cons} consolidada(s) entre as fora da lista — o portal não permite excluí-las.`);
    openReview(list.map((i) => rawFor(i.id, i)), `Séries fora da lista${incl ? ' + sem série' : ''} (${list.length})`,
      { onRefresh: async () => { await runCompare(); openSeriesReview(); } }); // Atualizar = comparar de novo
  }
  $('ndd-cmp-select-out').addEventListener('click', openSeriesReview);

  // ---------------------------------------------------------------------------
  // Exportações (CSV ; para abrir direto no Excel pt-BR)
  // ---------------------------------------------------------------------------
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = (rows) => rows.map((r) => r.map(csvCell).join(';')).join('\r\n');

  $('ndd-cmp-exp-missing').addEventListener('click', () => {
    if (!cmp) return;
    const rows = [['Série (lista)', 'Situação', 'Arquivo da lista', 'Comparado em']];
    cmp.missing.forEach((s) => rows.push([s, 'Na lista, não cadastrada no NDD', contract.fileName, cmp.at]));
    download(`ndd360-series-ausentes-no-ndd-${stamp()}.csv`, csv(rows), 'text/csv;charset=utf-8');
  });

  // ===========================================================================
  // Lista completa de impressoras (cache compartilhado) + utilidades de texto
  // ===========================================================================
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const brandOf = (p) => (p.brandName || '').trim() || '(sem fabricante)';
  const modelOf = (p) => (p.modelName || '').trim() || '(sem modelo)';

  async function ensurePrinters(force) {
    if (!force && printersCache && Date.now() - printersCache.at < CACHE_TTL) return printersCache.list;
    const { list } = await fetchAllPrinters((d, t) => setProgress(d, t));
    printersCache = { list, at: Date.now() };
    setProgress(0, 0);
    return list;
  }
  // ---------------------------------------------------------------------------
  // Janela de revisão (lista das impressoras da regra, com exceções)
  // ---------------------------------------------------------------------------
  const CMP_PILL = {
    in: ['Na lista', '#d5f5e3'], approx: ['Aproximação', '#e8daef'], out: ['Fora da lista', '#fbe0c8'], noserial: ['Sem série', '#fcf3cf'],
  };
  // Converte o info (painel) de volta para o formato da API quando a impressora não está no cache
  function rawFor(id, info) {
    const p = printersCache?.list.find((x) => x.id === id);
    if (p) return p;
    info = info || {};
    return { id, printerName: info.name, addressName: info.ip, addressPort: info.port, serialNumber: info.serial,
      modelName: info.model, brandName: info.brand, enabledAccounting: info.enabled, isConsolidated: info.consolidated };
  }

  // ---------------------------------------------------------------------------
  // Grade compartilhada pelas janelas (lista/revisão de impressoras e hosts):
  // largura por coluna, redimensionamento, tooltip do que foi cortado e filtro estilo Excel
  // ---------------------------------------------------------------------------
  const GRID_FONT = '12px "Segoe UI", Arial, sans-serif';
  const W_MIN = 40, W_MAX = 900;
  let gridCtx; // canvas para medir texto (undefined = ainda não tentou; null = indisponível: estima pelo nº de caracteres)
  function textW(txt, bold) {
    if (gridCtx === undefined) { try { gridCtx = document.createElement('canvas').getContext('2d') || null; } catch { gridCtx = null; } }
    if (!gridCtx) return String(txt).length * (bold ? 7.1 : 6.6);
    gridCtx.font = (bold ? '700 ' : '') + GRID_FONT;
    return gridCtx.measureText(String(txt)).width;
  }
  // Largura das colunas de uma <table class="grid"> dentro de `ov`.
  //  • padrão = ajuste ao conteúdo, entre um mínimo e um TETO por coluna (o.range[k] = [mín, teto]): um valor fora da
  //    curva não alarga a coluna inteira; ele é cortado com "…" (inteiro no tooltip)
  //  • arrastar a borda direita do cabeçalho redimensiona; duplo clique na borda ajusta ao conteúdo
  //  • a largura escolhida é lembrada em o.lsKey; reset() volta ao automático
  //  o: { rows, cols: () => colunas visíveis, byKey, range, lsKey, lead: px de uma coluna fixa inicial (0 = não há) }
  function gridSizer(ov, o) {
    const table = ov.querySelector('table.grid'), thead = ov.querySelector('thead');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(o.lsKey) || '{}') || {}; } catch { /* ignore */ }
    const save = () => { try { if (Object.keys(saved).length) localStorage.setItem(o.lsKey, JSON.stringify(saved)); else localStorage.removeItem(o.lsKey); } catch { /* ignore */ } };
    // largura que o conteúdo pede (mede só os textos mais compridos: rápido mesmo com 10 mil linhas)
    function contentW(c) {
      const head = textW(c.t, true) + 56; // rótulo + seta de ordenação + botão de filtro + respiro
      if (c.td) return Math.max(head, (o.range[c.k] || [90])[0]); // célula com botão/etiqueta: largura própria
      const top = [];
      for (const r of o.rows) {
        const v = String(c.v(r) ?? '');
        if (top.length < 4) { top.push(v); top.sort((a, b) => a.length - b.length); } else if (v.length > top[0].length) { top[0] = v; top.sort((a, b) => a.length - b.length); }
      }
      return Math.max(head, Math.max(0, ...top.map((v) => textW(v))) + 16);
    }
    const auto = new Map();
    function autoW(c) {
      if (c.o) return (o.range[c.k] || [120, 240])[1] - 20; // valores chegam aos poucos: largura fixa, sem "pular" durante a coleta
      if (!auto.has(c.k)) { const [lo, hi] = o.range[c.k] || [80, 220]; auto.set(c.k, Math.round(Math.max(lo, Math.min(hi, contentW(c))))); }
      return auto.get(c.k);
    }
    const width = (c) => (saved[c.k] >= W_MIN ? Math.min(W_MAX, saved[c.k]) : autoW(c));
    // largura mínima da tabela = soma das colunas; se sobrar espaço na janela, a coluna vazia do fim absorve
    const fit = () => { table.style.minWidth = `${o.lead + o.cols().reduce((a, c) => a + width(c), 0)}px`; };
    const setW = (k, w) => {
      saved[k] = Math.max(W_MIN, Math.min(W_MAX, Math.round(w)));
      const col = ov.querySelector(`colgroup col[data-k="${k}"]`);
      if (col) col.style.width = `${saved[k]}px`;
      fit();
      o.onChange?.();
    };
    let resizing = false;
    thead.addEventListener('mousedown', (e) => {
      const h = e.target.closest('.rz');
      if (!h || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const k = h.dataset.rz, x0 = e.clientX, w0 = width(o.byKey[k]);
      resizing = true; ov.classList.add('rzing'); h.classList.add('act');
      const move = (ev) => setW(k, w0 + ev.clientX - x0);
      const up = () => {
        document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', up, true);
        ov.classList.remove('rzing'); h.classList.remove('act');
        save();
        setTimeout(() => { resizing = false; }, 0); // o clique que encerra o arraste não pode ordenar a coluna
      };
      document.addEventListener('mousemove', move, true); document.addEventListener('mouseup', up, true);
    });
    thead.addEventListener('dblclick', (e) => {
      const h = e.target.closest('.rz');
      if (!h) return;
      e.preventDefault(); e.stopPropagation();
      setW(h.dataset.rz, Math.min(600, contentW(o.byKey[h.dataset.rz])));
      save();
    });
    return {
      width, fit,
      colgroup: () => (o.lead ? `<col style="width:${o.lead}px">` : '') + o.cols().map((c) => `<col data-k="${c.k}" style="width:${width(c)}px">`).join('') + '<col>',
      handle: (k) => `<span class="rz" data-rz="${k}" title="Arraste para redimensionar · duplo clique ajusta ao conteúdo"></span>`,
      busy: (e) => resizing || !!e.target.closest('.rz'), // clique no cabeçalho que não deve ordenar
      custom: () => Object.keys(saved).length > 0,
      reset: () => { saved = {}; save(); },
    };
  }
  // célula cortada com "…": mostra o valor inteiro ao passar o mouse (só cria o tooltip quando precisa)
  function gridTips(tb) {
    tb.addEventListener('mouseover', (e) => {
      const td = e.target.closest('td');
      if (td && !td.title && !td.firstElementChild && td.scrollWidth > td.clientWidth) td.title = td.textContent;
    });
  }
  // Filtro estilo Excel num menu `dd` ancorado no botão `btn`.
  //  o: { title, vals: Map valor -> nº de linhas (considerando os OUTROS filtros), cur: Set em vigor (ou undefined),
  //       rank: Map valor -> número para ordenar a lista (opcional; padrão = alfabética/numérica),
  //       apply(Set | null), sort(dir) }
  function excelFilter(dd, btn, o) {
    const vals = o.vals, cur = o.cur;
    const all = [...vals.entries()].sort((a, b) => (o.rank ? (o.rank.get(a[0]) ?? 0) - (o.rank.get(b[0]) ?? 0) : 0) || a[0].localeCompare(b[0], 'pt-BR', { numeric: true }));
    const chk = new Set(cur ? all.map(([v]) => v).filter((v) => cur.has(v)) : all.map(([v]) => v));
    dd.dataset.kind = 'filter'; dd.onchange = null; dd.onclick = null;
    dd.innerHTML = `
      <div class="dd-sort"><button data-s="1">Classificar A → Z</button><button data-s="-1">Classificar Z → A</button></div>
      <input type="search" class="dd-q" placeholder="Pesquisar ${esc(o.title)}…">
      <label class="dd-all"><input type="checkbox"> <b>(Selecionar tudo)</b></label>
      <div class="dd-list"></div>
      <div class="dd-ft"><button class="dd-clear">Limpar filtro</button><span></span><button class="dd-cancel">Cancelar</button><button class="dd-ok primary">OK</button></div>`;
    const listEl = dd.querySelector('.dd-list');
    const qEl = dd.querySelector('.dd-q');
    const allEl = dd.querySelector('.dd-all input');
    const shown = () => { const q = norm(qEl.value.trim()); return all.filter(([v]) => !q || norm(v).includes(q)); };
    function paint() {
      const sh = shown();
      listEl.innerHTML = sh.slice(0, 1500).map(([v, c]) =>
        `<label><input type="checkbox" data-v="${esc(v)}" ${chk.has(v) ? 'checked' : ''}> <span>${esc(v)}</span><i>${c}</i></label>`).join('') +
        (sh.length > 1500 ? `<div class="small">… ${sh.length - 1500} valores a mais — refine a pesquisa</div>` : '') +
        (sh.length ? '' : '<div class="small">Nenhum valor.</div>');
      const n = sh.filter(([v]) => chk.has(v)).length;
      allEl.checked = sh.length > 0 && n === sh.length;
      allEl.indeterminate = n > 0 && n < sh.length;
    }
    listEl.addEventListener('change', (e) => { const v = e.target.dataset.v; if (e.target.checked) chk.add(v); else chk.delete(v); paint(); });
    allEl.addEventListener('change', () => { shown().forEach(([v]) => (allEl.checked ? chk.add(v) : chk.delete(v))); paint(); });
    let t; qEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { // igual ao Excel: pesquisar já restringe a marcação aos resultados
        const q = norm(qEl.value.trim());
        chk.clear(); all.forEach(([v]) => { if (!q || norm(v).includes(q)) chk.add(v); });
        paint();
      }, 120);
    });
    const close = () => { dd.style.display = 'none'; dd.innerHTML = ''; };
    dd.querySelector('.dd-cancel').onclick = close;
    dd.querySelector('.dd-clear').onclick = () => { close(); o.apply(null); };
    dd.querySelector('.dd-ok').onclick = () => {
      let next = null;
      if (chk.size !== all.length) {
        next = new Set(chk);
        if (cur) cur.forEach((v) => { if (!vals.has(v)) next.add(v); }); // preserva valores já ocultos por outros filtros que estavam permitidos
      }
      close(); o.apply(next);
    };
    dd.querySelectorAll('.dd-sort button').forEach((b) => { b.onclick = () => { close(); o.sort(Number(b.dataset.s)); }; });
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') dd.querySelector('.dd-ok').click(); });
    paint();
    const r = btn.getBoundingClientRect();
    dd.style.display = 'block';
    dd.style.top = `${r.bottom + 4}px`;
    dd.style.left = `${Math.max(8, Math.min(r.left - 200, window.innerWidth - 300))}px`;
    qEl.focus();
  }

  // ---------------------------------------------------------------------------
  // Janela de revisão
  //   • checkbox por linha (clique em qualquer lugar da linha), cabeçalho marca/desmarca o que está filtrado
  //   • filtro por coluna estilo Excel (▾): busca + lista de valores com contagem, A→Z / Z→A
  //   • opts.mode: 'browse'           -> lista completa; marcar = selecionar, ao vivo (contador do painel acompanha)
  //                'select' (padrão) -> regra pré-marcada: Substituir / Adicionar à seleção
  //                'delete'           -> Excluir marcadas (chama opts.onDelete)
  // ---------------------------------------------------------------------------
  function openReview(list, title, opts = {}) {
    const mode = opts.mode || 'select';
    const live = mode === 'browse';
    document.getElementById('ndd-rv')?.remove();
    const keep = new Set(live ? list.filter((p) => selected.has(p.id)).map((p) => p.id) : list.map((p) => p.id));
    const snapshot = live ? new Map(selected) : null; // para "Reverter"
    const W = live ? 'selecionada' : 'marcada';       // vocabulário da janela
    let sortKey = live ? 'name' : 'brand', sortDir = 1;
    const hasQ = queuesOk(); // colunas de fila só aparecem se as filas foram lidas
    const rows = list.map((p) => {
      const q = hasQ ? (envCache.queuesByPrinter.get(p.id) || []) : [];
      return { p, info: apiInfo(p), brand: brandOf(p), model: modelOf(p), q,
        qSrv: uniq(q.map((x) => x.machineName)).sort().join(', '), qDrv: uniq(q.map((x) => x.driver)).sort().join(', '),
        qType: uniq(q.map((x) => queuePortType(x.port))).sort().join(', '), /* ordenado: valor único no filtro */ qPorts: uniq(q.map((x) => x.port)).join(', '), qNames: uniq(q.map((x) => x.printerQueueName)).join(', ') };
    });
    const EMPTY = '(vazio)';
    let oAborted = false; // leitura da origem interrompida por falhas seguidas (ex.: cliente sem permissão)
    const oView = (r) => {
      const v = originView(r.info.enabled, accFresh(r.p.id));
      return v.state === 'load' && oAborted ? { ...v, state: 'na', text: 'Não lida', color: 'Não lida', tip: 'Leitura interrompida por falhas seguidas' } : v;
    };
    const COLS = [
      // Filas vem primeiro (logo após a caixa de seleção): é o "expansor" da linha e o detalhe abre alinhado à esquerda
      ...(hasQ ? [
        // célula compacta: quantidade + botão que abre os detalhes (nome, driver, porta, servidor) logo abaixo da linha
        { k: 'nq', t: 'Filas', v: (r) => (r.q.length ? String(r.q.length) : 'Sem fila'), cls: (r) => (r.q.length ? '' : 'q0'),
          td: (r) => (r.q.length
            ? `<button class="qx" data-qx="${r.p.id}" title="Mostrar/ocultar ${r.q.length === 1 ? 'a fila' : 'as ' + r.q.length + ' filas'}"><i>${isOpen(r.p.id) ? '▼' : '▶'}</i>${r.q.length}</button>` +
              (/WSD/.test(r.qType) ? '<span class="tag" title="Tem fila em porta WSD">WSD</span>' : '')
            : 'Sem fila') },
      ] : []),
      { k: 'name', t: 'Nome', v: (r) => r.info.name },
      { k: 'ip', t: 'Endereço IP', v: (r) => r.info.ip, cls: () => 'tn' },
      { k: 'port', t: 'Porta', v: (r) => r.info.port, cls: () => 'tn' },
      { k: 'serial', t: 'Série', v: (r) => r.info.serial, cls: () => 'tn' },
      { k: 'brand', t: 'Fabricante', v: (r) => r.brand },
      { k: 'model', t: 'Modelo', v: (r) => r.model },
      { k: 'acc', t: 'Contabilização', v: (r) => (r.info.enabled ? 'Habilitada' : 'Desabilitada') + (r.info.consolidated ? ' · consolidada' : '') },
      // lidas em 2º plano (1 leitura por impressora habilitada); "o" marca as células atualizadas conforme chegam
      { k: 'origin', t: 'Origem', o: true, off: true, hint: 'coleta ao ligar', v: (r) => oView(r).text, cls: (r) => `o-${oView(r).state}`, tip: (r) => oView(r).tip },
      { k: 'fcolor', t: 'Forçar cor', o: true, off: true, hint: 'coleta ao ligar', v: (r) => oView(r).color, cls: (r) => `o-${oView(r).state}`, tip: (r) => (oView(r).state === 'err' ? oView(r).tip : '') },
      ...(cmp ? [{ k: 'cmp', t: 'Lista de séries', v: (r) => (CMP_PILL[cmp.status.get(r.p.id)] || ['—'])[0],
        td: (r) => { const st = cmp.status.get(r.p.id); return st ? `<span class="pill" style="background:${CMP_PILL[st][1]}">${CMP_PILL[st][0]}</span>` : ''; } }] : []),
      ...(hasQ ? [
        { k: 'qsrv', t: 'Servidor da fila', v: (r) => r.qSrv, off: true },
        { k: 'qdrv', t: 'Driver da fila', v: (r) => r.qDrv, off: true },
        { k: 'qtype', t: 'Porta da fila', v: (r) => r.qType, off: true, tip: (r) => r.qPorts },
        { k: 'qname', t: 'Nome da fila', v: (r) => r.qNames + ' ' + r.qPorts, hidden: true }, // só para a busca
      ] : []),
      { k: 'mark', t: 'Marcada', v: (r) => (keep.has(r.p.id) ? 'Sim' : 'Não'), hidden: true },
    ];
    const colBy = Object.fromEntries(COLS.map((c) => [c.k, c]));
    const cellVal = (r, k) => { const x = String(colBy[k].v(r) ?? '').trim(); return x && x !== '-' ? x : EMPTY; };
    const filters = new Map(); // k -> Set(valores permitidos)

    // Colunas visíveis: escolha do usuário (lembrada); as de detalhe da fila começam ocultas para a tabela ficar limpa
    const LS_COLS = 'ndd-mm-cols';
    let colPref = {};
    try { colPref = JSON.parse(localStorage.getItem(LS_COLS) || '{}') || {}; } catch { /* ignore */ }
    // "Origem"/"Forçar cor" custam leituras no NDD: começam desligadas e a escolha é lembrada por cliente (não global)
    const colOn = (c) => c.k === 'name' || (c.o ? !!originMeta.on[c.k] : (colPref[c.k] ?? !c.off));
    const visCols = () => COLS.filter((c) => !c.hidden && colOn(c));

    // Largura das colunas: [mínimo, teto] do ajuste automático ao conteúdo (ver gridSizer)
    const W_RANGE = { nq: [78, 92], name: [130, 300], ip: [96, 150], port: [70, 96], serial: [90, 170], brand: [90, 140], model: [100, 220],
      acc: [118, 170], origin: [120, 240], fcolor: [104, 120], cmp: [124, 150], qsrv: [124, 180], qdrv: [118, 240], qtype: [112, 150] };
    // Filas expandidas (por linha) ou todas
    const expanded = new Set();
    let expandAll = false;
    const isOpen = (id) => expandAll || expanded.has(id);
    const queueDetail = (r) => `<div class="ql"><span class="h">Fila</span><span class="h">Driver</span><span class="h">Porta</span><span class="h">Servidor</span>` +
      r.q.map((x) => `<span class="n">${esc(x.printerQueueName)}</span><span>${esc(x.driver)}</span><span>${esc(x.port)}${queuePortType(x.port) === 'WSD' ? '<span class="tag">WSD</span>' : ''}</span><span>${esc(x.machineName)}</span>`).join('') + '</div>';

    const ov = document.createElement('div');
    ov.id = 'ndd-rv';
    if (live) ov.className = 'live';
    ov.innerHTML = `
      <div class="box">
        <div class="hd"><b>${esc(title)}</b>
          <span class="chip" id="ndd-rv-chip"></span>
          <span class="flt-info" id="ndd-rv-flt"></span>
          <span class="ld-info" id="ndd-rv-load"></span>
          <input type="search" id="ndd-rv-q" placeholder="Buscar nome, IP, série, fabricante, modelo…">
          <select id="ndd-rv-mark" title="Mostrar">
            <option value="">Todas</option><option value="Sim">Só ${W}s</option><option value="Não">Só não ${W}s</option>
          </select>
          <button id="ndd-rv-cols" title="Escolher as colunas da tabela">Colunas ▾</button>
          ${opts.onRefresh ? '<button id="ndd-rv-refresh" title="Buscar a lista de novo no NDD">↻ Atualizar</button>' : ''}
        </div>
        <div class="bd"><table class="grid"><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
        <div class="ft">
          <button id="ndd-rv-exp-sel" title="Baixa em .csv (colunas separadas, abre direto no Excel) só as linhas ${W}s">⭳ Exportar ${W}s</button>
          <button id="ndd-rv-exp-all" title="Baixa em .csv todas as linhas desta janela, marcadas ou não">⭳ Exportar tudo</button>
          <span id="ndd-rv-count"></span>
          ${live
            ? '<button id="ndd-rv-clear" title="Desmarca todas as impressoras desta lista">✕ Limpar seleção</button><button id="ndd-rv-revert" title="Volta a seleção para como estava ao abrir a janela">↶ Reverter</button><button id="ndd-rv-done" class="primary">Concluir</button>'
            : '<button id="ndd-rv-cancel">Cancelar</button>' + (mode === 'delete'
              ? '<button id="ndd-rv-del" class="danger">Excluir marcadas</button>'
              : '<button id="ndd-rv-add" title="Soma à seleção atual do painel">Adicionar à seleção</button><button id="ndd-rv-ok" class="primary">Substituir seleção</button>')}
        </div>
      </div>
      <div class="dd" id="ndd-rv-dd" style="display:none"></div>`;
    document.body.appendChild(ov);
    const tb = ov.querySelector('tbody');
    const q$ = ov.querySelector('#ndd-rv-q');
    const dd = ov.querySelector('#ndd-rv-dd');
    let visible = rows;
    if (opts.onlySelected) ov.querySelector('#ndd-rv-mark').value = 'Sim';
    const sizer = gridSizer(ov, { rows, cols: visCols, byKey: colBy, range: W_RANGE, lsKey: 'ndd-mm-colw', lead: 30 });
    gridTips(tb);
    function renderHead() {
      ov.querySelector('colgroup').innerHTML = sizer.colgroup();
      ov.querySelector('thead').innerHTML = `<tr><th><div class="thc"><input type="checkbox" id="ndd-rv-hdr" title="Marcar/desmarcar todas as linhas filtradas"></div></th>` +
        visCols().map((c) => `<th data-k="${c.k}"><div class="thc"><span class="lb" title="${c.t}">${c.t}</span><span class="so"></span><button class="fb" data-f="${c.k}" title="Filtrar">▾</button></div>` +
          `${sizer.handle(c.k)}</th>`).join('') + '<th class="fill"></th></tr>';
      sizer.fit();
    }
    renderHead();

    // modo ao vivo: cada marcação já altera a seleção do painel (contador acompanha em tempo real)
    const rowById = new Map(rows.map((r) => [r.p.id, r]));
    let gridT;
    function setMark(id, on) {
      if (on) keep.add(id); else keep.delete(id);
      if (!live) return;
      if (on) selected.set(id, rowById.get(id).info); else selected.delete(id);
    }
    function liveSync() {
      if (!live) return;
      refreshUi();
      clearTimeout(gridT); gridT = setTimeout(syncGrid, 150);
    }
    const changed = () => {
      if (!live) return false;
      if (snapshot.size !== selected.size) return true;
      for (const id of selected.keys()) if (!snapshot.has(id)) return true;
      return false;
    };

    // linhas que passam na busca + filtros (opcionalmente ignorando uma coluna, p/ montar o próprio filtro)
    function pass(r, exceptKey) {
      const q = norm(q$.value.trim());
      if (q && !norm(COLS.map((c) => colBy[c.k].v(r)).join(' ')).includes(q)) return false;
      const mk = ov.querySelector('#ndd-rv-mark').value;
      if (mk && cellVal(r, 'mark') !== mk) return false;
      for (const [k, set] of filters) if (k !== exceptKey && !set.has(cellVal(r, k))) return false;
      return true;
    }
    function render() {
      visible = rows.filter((r) => pass(r));
      visible.sort((a, b) => cellVal(a, sortKey).localeCompare(cellVal(b, sortKey), 'pt-BR', { numeric: true }) * sortDir
        || a.info.name.localeCompare(b.info.name, 'pt-BR', { numeric: true }));
      const cols = visCols();
      trById = null;
      tb.innerHTML = visible.map((r) => {
        const on = keep.has(r.p.id);
        return `<tr data-id="${r.p.id}" class="${live ? (on ? 'on' : '') : (on ? '' : 'off')}"><td><input type="checkbox" ${on ? 'checked' : ''}></td>` +
          cols.map((c) => `<td${c.o ? ` data-o="${c.k}"` : ''}${c.cls && c.cls(r) ? ` class="${c.cls(r)}"` : ''}${c.tip ? ` title="${esc(c.tip(r))}"` : ''}>${c.td ? c.td(r) : esc(c.v(r))}</td>`).join('') + '<td></td></tr>' +
          (hasQ && r.q.length && isOpen(r.p.id) ? `<tr class="qrow"><td></td><td colspan="${cols.length + 1}">${queueDetail(r)}</td></tr>` : '');
      }).join('');
      ov.querySelectorAll('thead th[data-k]').forEach((th) => {
        const k = th.dataset.k;
        th.classList.toggle('filtered', filters.has(k));
        th.querySelector('.so').textContent = sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : '';
      });
      const nf = filters.size + (q$.value.trim() ? 1 : 0) + (ov.querySelector('#ndd-rv-mark').value ? 1 : 0);
      ov.querySelector('#ndd-rv-flt').innerHTML = nf ? `${nf} filtro(s) ativo(s) · <a href="#" id="ndd-rv-clrall">limpar filtros</a>` : '';
      count();
    }
    function count() {
      const vOn = visible.filter((r) => keep.has(r.p.id)).length;
      const hdr = ov.querySelector('#ndd-rv-hdr');
      hdr.checked = visible.length > 0 && vOn === visible.length;
      hdr.indeterminate = vOn > 0 && vOn < visible.length;
      const chip = ov.querySelector('#ndd-rv-chip');
      chip.textContent = `${keep.size} ${W}${keep.size === 1 ? '' : 's'}`;
      chip.classList.toggle('has', keep.size > 0);
      ov.querySelector('#ndd-rv-count').innerHTML = (live
        ? `<b>${keep.size}</b> de ${rows.length} selecionada(s)`
        : `<b>${keep.size}</b> de ${rows.length} marcada(s) · <b>${rows.length - keep.size}</b> mantida(s) como exceção`) +
        (visible.length !== rows.length ? ` · exibindo ${visible.length}` : '');
      ov.querySelectorAll('#ndd-rv-ok, #ndd-rv-add, #ndd-rv-del').forEach((b) => { b.disabled = keep.size === 0; });
      const set = (sel, txt) => { const b = ov.querySelector(sel); if (b) b.textContent = txt; };
      set('#ndd-rv-del', `Excluir ${keep.size} marcada(s)`);
      set('#ndd-rv-ok', `Substituir seleção (${keep.size})`);
      set('#ndd-rv-add', `Adicionar à seleção (${keep.size})`);
      if (live) {
        ov.querySelector('#ndd-rv-clear').disabled = keep.size === 0;
        ov.querySelector('#ndd-rv-revert').disabled = !changed();
      }
    }

    // ---- Origem / Forçar cor: conferência pela auditoria + leitura em 2º plano, células preenchidas conforme chegam ----
    const O_KEYS = ['origin', 'fcolor'];
    const originWanted = () => O_KEYS.some((k) => colOn(colBy[k]));
    const loadEl = ov.querySelector('#ndd-rv-load');
    const bd = ov.querySelector('.bd');
    const oDirty = new Set();
    let trById = null; // id -> <tr>, refeito a cada montagem da tabela
    const O_MAX_STREAK = 8; // falhas seguidas que interrompem a leitura (não insiste contra um endpoint que só recusa)
    let oJob = null, oPhase = '', oDone = 0, oTotal = 0, oT0 = 0, oPatchT = null, oLastFull = 0, oStreak = 0;
    const oAlive = () => ov.isConnected && originWanted() && !oAborted;
    const oNeed = () => { const seen = new Set(); return rows.filter((r) => r.info.enabled && !seen.has(r.p.id) && seen.add(r.p.id) && !accFresh(r.p.id)).map((r) => r.p.id); };
    // a ordem/filtro/busca dependem da origem? então a tabela precisa ser remontada (com parcimônia; mais espaçado em listas grandes)
    const oDepends = () => O_KEYS.includes(sortKey) || O_KEYS.some((k) => filters.has(k)) || !!q$.value.trim();
    const oFullEvery = () => Math.max(2000, rows.length * 1.5);
    // 1º as linhas que estão na tela agora (posição da rolagem), depois o restante do filtro, de cima para baixo
    function oPrefer(todo) {
      const rowH = tb.firstElementChild?.offsetHeight || 24;
      const i0 = Math.min(visible.length, Math.max(0, Math.floor(bd.scrollTop / rowH) - 1));
      for (let i = i0; i < visible.length; i++) if (todo.has(visible[i].p.id)) return visible[i].p.id;
      for (let i = 0; i < i0; i++) if (todo.has(visible[i].p.id)) return visible[i].p.id;
      return undefined;
    }
    function oPaintInfo() {
      if (!originWanted()) { loadEl.innerHTML = ''; return; }
      const errs = rows.filter((r) => r.info.enabled && accFresh(r.p.id)?.err).length;
      let h;
      if (oPhase === 'sync') h = 'Origem: conferindo mudanças na auditoria do NDD…';
      else if (oPhase === 'read') {
        const eta = oDone >= 12 ? ` · faltam ~${fmtDur(((oTotal - oDone) * (Date.now() - oT0)) / oDone)}` : '';
        h = `<span title="Desligue a coluna para interromper a coleta">Coletando origem… ${oDone}/${oTotal}${eta}</span>`;
      } else if (errs || oAborted) {
        h = `<span style="color:#c0392b">Origem: ${oAborted ? `leitura interrompida após ${O_MAX_STREAK} falhas seguidas` : `${errs} falha(s)`}</span> · <a href="#" id="ndd-rv-oretry">tentar de novo</a>`;
      } else {
        h = (originMeta.syncOk
          ? `<span title="Valores guardados neste navegador e conferidos pela auditoria do NDD: toda mudança de contabilização registrada desde a leitura faz a impressora ser relida.">Origem conferida às ${fmtWhen(originMeta.syncAt).slice(6)}</span>`
          : `<span title="${esc(originMeta.syncErr || 'sem resposta')} — sem a auditoria, cada leitura vale 60 min">Origem: auditoria indisponível</span>`) +
          ' · <a href="#" id="ndd-rv-oreread" title="Coleta novamente, direto no NDD, a origem das impressoras desta janela">atualizar</a>';
      }
      loadEl.innerHTML = h;
    }
    function oFlush(final) {
      clearTimeout(oPatchT); oPatchT = null;
      if (!ov.isConnected) return;
      const cols = visCols().filter((c) => c.o);
      if (!trById) { trById = new Map(); for (const tr of tb.children) if (tr.dataset.id) trById.set(tr.dataset.id, tr); } // índice das linhas: 1 vez por montagem da tabela
      oDirty.forEach((id) => {
        const tr = trById.get(String(id)), r = rowById.get(id);
        if (!tr || !r) return;
        cols.forEach((c) => {
          const td = tr.querySelector(`td[data-o="${c.k}"]`);
          if (!td) return;
          td.textContent = c.v(r); td.className = c.cls(r); td.title = c.tip(r);
        });
      });
      oDirty.clear();
      oPaintInfo();
      if ((final && oAborted) || (oDepends() && (final || Date.now() - oLastFull > oFullEvery()))) { oLastFull = Date.now(); render(); }
    }
    function fillOrigins() {
      if (oJob) return oJob;
      if (oAborted || !originWanted()) { oPaintInfo(); return Promise.resolve(); }
      oJob = (async () => {
        const sig = () => `${originMeta.syncOk}:${oNeed().length}`;
        const before = sig();
        oPhase = 'sync'; oPaintInfo();
        await originSync(false); // ~1 s: descobre o que mudou desde a última conferência
        if (!oAlive()) return;
        const ids = oNeed();
        if (sig() !== before) render(); // a conferência validou (ou derrubou) valores guardados
        if (!ids.length) return;
        oPhase = 'read'; oDone = 0; oTotal = ids.length; oT0 = oLastFull = Date.now(); oStreak = 0;
        oPaintInfo();
        await loadOrigins(ids, oAlive, (id) => {
          oDone++; oDirty.add(id);
          oStreak = accCache.get(id)?.err ? oStreak + 1 : 0;
          if (oStreak >= O_MAX_STREAK) oAborted = true;
          if (!oPatchT) oPatchT = setTimeout(oFlush, 300);
        }, oPrefer);
      })().catch(() => { /* erros ficam nas células */ }).finally(() => { oJob = null; oPhase = ''; oFlush(true); });
      return oJob;
    }
    loadEl.addEventListener('click', (e) => {
      if (e.target.id === 'ndd-rv-oretry') {
        e.preventDefault();
        accForget(rows.filter((r) => accCache.get(r.p.id)?.err).map((r) => r.p.id));
        oAborted = false;
        render(); fillOrigins();
      } else if (e.target.id === 'ndd-rv-oreread') {
        e.preventDefault();
        if (oJob) return;
        const ids = rows.filter((r) => r.info.enabled).map((r) => r.p.id);
        if (ids.length > 200 && !confirm(`Atualizar a origem de ${ids.length} impressora(s) direto no NDD?\n\nA coleta leva cerca de ${fmtDur((ids.length / 12) * 1000)} e roda em segundo plano.`)) return;
        accForget(ids);
        originMeta.syncAt = 0;
        render(); fillOrigins();
      }
    });

    // ---- filtro estilo Excel (ver excelFilter) ----
    function openFilter(k, btn) {
      const vals = new Map();
      rows.forEach((r) => { if (pass(r, k)) { const v = cellVal(r, k); vals.set(v, (vals.get(v) || 0) + 1); } });
      excelFilter(dd, btn, {
        title: colBy[k].t, vals, cur: filters.get(k),
        apply: (set) => { if (set) filters.set(k, set); else filters.delete(k); render(); },
        sort: (dir) => { sortKey = k; sortDir = dir; render(); },
      });
    }

    tb.addEventListener('click', (e) => {
      const qx = e.target.closest('.qx');
      if (qx) { // expandir/recolher as filas desta impressora (não altera a seleção)
        const id = Number(qx.dataset.qx);
        if (expandAll) { expandAll = false; visible.forEach((r) => { if (r.q.length) expanded.add(r.p.id); }); }
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
        return;
      }
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const id = Number(tr.dataset.id);
      const cb = tr.querySelector('input');
      if (e.target !== cb) cb.checked = !cb.checked;
      setMark(id, cb.checked);
      if (live) tr.classList.toggle('on', cb.checked); else tr.classList.toggle('off', !cb.checked);
      count();
      liveSync();
    });
    ov.querySelector('thead').addEventListener('click', (e) => {
      if (sizer.busy(e)) return;
      if (e.target.id === 'ndd-rv-hdr') { const on = e.target.checked; visible.forEach((r) => setMark(r.p.id, on)); render(); liveSync(); return; }
      const fb = e.target.closest('.fb');
      if (fb) { e.stopPropagation(); openFilter(fb.dataset.f, fb); return; }
      const th = e.target.closest('th[data-k]');
      if (!th) return;
      sortDir = sortKey === th.dataset.k ? -sortDir : 1;
      sortKey = th.dataset.k;
      render();
    });
    // Menu "Colunas": mostrar/ocultar colunas e expandir todas as filas
    ov.querySelector('#ndd-rv-cols').addEventListener('click', (ev) => {
      const btn = ev.currentTarget;
      if (dd.style.display === 'block' && dd.dataset.kind === 'cols') { dd.style.display = 'none'; dd.innerHTML = ''; return; }
      const paint = () => {
        dd.dataset.kind = 'cols';
        dd.innerHTML = '<div class="cm">' + COLS.filter((c) => !c.hidden && c.k !== 'name').map((c) => `<label><input type="checkbox" data-c="${c.k}" ${colOn(c) ? 'checked' : ''}> ${c.t}${c.hint ? ` <i class="hint">· ${c.hint}</i>` : ''}</label>` +
          (c.k === 'fcolor' ? '<div class="note"><b>Atenção:</b> em ambientes grandes, a coleta pode levar vários minutos.</div>' : '')).join('') +
          (hasQ ? `<div class="sep"></div><label><input type="checkbox" data-x="1" ${expandAll ? 'checked' : ''}> Expandir todas as filas</label>` : '') +
          '<div class="sep"></div><a href="#" data-reset="1" title="Volta as colunas visíveis e as larguras ao padrão">restaurar padrão (colunas e larguras)</a></div>';
      };
      paint();
      dd.onchange = (e) => {
        if (e.target.dataset.x) { expandAll = e.target.checked; if (!expandAll) expanded.clear(); render(); return; }
        const k = e.target.dataset.c; if (!k) return;
        if (colBy[k].o) { originMeta.on[k] = e.target.checked; scheduleSaveOrigin(); }
        else {
          colPref[k] = e.target.checked;
          try { localStorage.setItem(LS_COLS, JSON.stringify(colPref)); } catch { /* ignore */ }
        }
        if (!e.target.checked) filters.delete(k);
        renderHead(); render(); fillOrigins();
      };
      dd.onclick = (e) => {
        if (!e.target.dataset.reset) return;
        e.preventDefault(); colPref = {}; sizer.reset(); originMeta.on = {}; scheduleSaveOrigin();
        O_KEYS.forEach((k) => filters.delete(k));
        try { localStorage.removeItem(LS_COLS); } catch { /* ignore */ }
        renderHead(); render(); paint(); fillOrigins();
      };
      const r = btn.getBoundingClientRect();
      dd.style.display = 'block';
      dd.style.top = `${r.bottom + 4}px`;
      dd.style.left = `${Math.max(8, Math.min(r.right - 290, window.innerWidth - 300))}px`;
    });
    ov.querySelector('.hd').addEventListener('click', (e) => {
      if (e.target.id === 'ndd-rv-clrall') {
        e.preventDefault(); filters.clear(); q$.value = ''; ov.querySelector('#ndd-rv-mark').value = ''; render();
      }
    });
    let tq;
    q$.addEventListener('input', () => { clearTimeout(tq); tq = setTimeout(render, 120); });
    ov.querySelector('#ndd-rv-mark').addEventListener('change', render);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    let dismiss = close; // Esc / clique fora: cancela (revisão) ou conclui (lista ao vivo)
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (dd.style.display === 'block') { dd.style.display = 'none'; dd.innerHTML = ''; } else dismiss();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    if (live) {
      const before = snapshot.size;
      dismiss = () => {
        if (changed()) log(`☑ Lista de impressoras: ${selected.size} selecionada(s) (antes: ${before}).`);
        clearTimeout(gridT);
        close();
        syncGrid();
      };
      ov.querySelector('#ndd-rv-done').onclick = () => dismiss();
      ov.querySelector('#ndd-rv-clear').onclick = () => { rows.forEach((r) => setMark(r.p.id, false)); render(); liveSync(); };
      ov.querySelector('#ndd-rv-revert').onclick = () => {
        selected.clear(); snapshot.forEach((v, k) => selected.set(k, v));
        keep.clear(); rows.forEach((r) => { if (selected.has(r.p.id)) keep.add(r.p.id); });
        render(); liveSync();
      };
    } else {
      ov.querySelector('#ndd-rv-cancel').onclick = close;
    }
    ov.querySelector('#ndd-rv-refresh')?.addEventListener('click', () => { clearTimeout(gridT); originMeta.syncAt = 0; if (!originMeta.syncOk) accForget(rows.map((r) => r.p.id)); close(); syncGrid(); opts.onRefresh(); });
    ov.addEventListener('mousedown', (e) => {
      if (dd.style.display === 'block' && !dd.contains(e.target) && !e.target.closest('.fb') && !e.target.closest('#ndd-rv-cols')) { dd.style.display = 'none'; dd.innerHTML = ''; }
      if (e.target === ov) dismiss();
    });
    const split = () => ({ chosen: rows.filter((r) => keep.has(r.p.id)), except: rows.filter((r) => !keep.has(r.p.id)) });

    // Exportação .csv (separador ";" + UTF-8 com BOM: o Excel pt-BR abre já em colunas, com acentos)
    async function exportRows(list, which) {
      const withO = originWanted();
      if (withO) { // o .csv só sai com a origem completa: espera a leitura em 2º plano terminar
        const btns = [...ov.querySelectorAll('#ndd-rv-exp-sel, #ndd-rv-exp-all')];
        btns.forEach((b) => { b.disabled = true; });
        try { await fillOrigins(); } finally { btns.forEach((b) => { b.disabled = false; }); }
        if (!ov.isConnected) return; // janela fechada durante a espera
      }
      const head = ['ID', 'Nome', 'Endereço IP', 'Porta', 'Série', 'Fabricante', 'Modelo', 'Contabilização',
        ...(withO ? ['Origem', 'Fonte física', 'Forçar cor'] : []), 'Consolidada',
        ...(cmp ? ['Lista de séries', 'Detalhe da comparação'] : []),
        ...(hasQ ? ['Filas (qtd)', 'Servidor da fila', 'Nome da fila', 'Driver da fila', 'Tipo de porta da fila', 'Porta da fila'] : []), live ? 'Selecionada' : 'Marcada'];
      const out = [head];
      const sorted = [...list].sort((a, b) => cellVal(a, sortKey).localeCompare(cellVal(b, sortKey), 'pt-BR', { numeric: true }) * sortDir);
      sorted.forEach((r) => out.push([
        r.p.id, r.info.name, r.info.ip, r.info.port, r.info.serial, r.brand, r.model,
        r.info.enabled ? 'Habilitada' : 'Desabilitada',
        ...(withO ? [oView(r).text, oView(r).hw, oView(r).color] : []), r.info.consolidated ? 'Sim' : 'Não',
        ...(cmp ? [(CMP_PILL[cmp.status.get(r.p.id)] || ['—'])[0], cmp.approxBy.get(r.p.id) || ''] : []),
        ...(hasQ ? [r.q.length, r.qSrv, r.qNames, r.qDrv, r.qType, r.qPorts] : []),
        keep.has(r.p.id) ? 'Sim' : 'Não',
      ]));
      const slug = norm(title).replace(/\(\d+\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      download(`ndd360-${slug}-${which}-${stamp()}.csv`, csv(out), 'text/csv;charset=utf-8');
      log(`⭳ Exportado: ${list.length} linha(s) (${which}) — ${title}.`);
    }
    ov.querySelector('#ndd-rv-exp-sel').onclick = () => {
      const { chosen } = split();
      if (!chosen.length) { alert(`Nenhuma linha ${W}.`); return; }
      exportRows(chosen, `${W}s`);
    };
    ov.querySelector('#ndd-rv-exp-all').onclick = () => exportRows(rows, 'tudo');
    const logExcept = (except) => {
      except.slice(0, 50).forEach((r) => log(`   exceção: ${infoLabel(r.info)}`));
      if (except.length > 50) log(`   … e mais ${except.length - 50} exceção(ões)`);
    };
    if (live) {
      // nada a aplicar: a seleção já foi alterada ao vivo
    } else if (mode === 'delete') {
      ov.querySelector('#ndd-rv-del').onclick = () => {
        const { chosen, except } = split();
        const nEn = chosen.filter((r) => r.info.enabled).length;
        if (!confirm(`Excluir DEFINITIVAMENTE ${chosen.length} impressora(s)?\n\n` +
          (nEn ? `${nEn} com contabilização habilitada: serão desabilitadas e o NDD libera ~1 a cada 11 s (fila do servidor) — previsão ≈ ${fmtDur(queueEta(nEn))}.\n${chosen.length - nEn} já desabilitada(s): exclusão imediata.\n\n` : '') +
          `Trabalhos, filas e dados delas NÃO poderão ser recuperados.` +
          (except.length ? `\n\n${except.length} desmarcada(s) serão mantidas e retiradas da seleção.` : ''))) return;
        except.forEach((r) => selected.delete(r.p.id));
        if (except.length) { log(`↷ ${except.length} impressora(s) mantida(s) fora da exclusão e retirada(s) da seleção.`); logExcept(except); }
        close();
        syncGrid();
        opts.onDelete?.(chosen.map((r) => ({ ...(selected.get(r.p.id) || {}), ...r.info })));
      };
    } else {
      const apply = (replace) => {
        const { chosen, except } = split();
        if (replace) selected.clear();
        chosen.forEach((r) => selected.set(r.p.id, r.info));
        log(`☑ ${title}: ${chosen.length} impressora(s) ${replace ? 'selecionada(s)' : 'adicionada(s) à seleção'}` +
          `${except.length ? `, ${except.length} mantida(s) como exceção` : ''}. Total selecionado: ${selected.size}.`);
        logExcept(except);
        close();
        syncGrid();
      };
      ov.querySelector('#ndd-rv-ok').onclick = () => apply(true);
      ov.querySelector('#ndd-rv-add').onclick = () => apply(false);
    }
    render();
    fillOrigins(); // 2º plano: não bloqueia a janela
    q$.focus();
  }

  // ===========================================================================
  // Ambiente: filas de impressão e hosts (SOMENTE LEITURA — nenhuma ação altera nada no NDD)
  //   GET /odata/printers-queues-from-printer -> filas (nome, driver, porta, máquina) por impressora
  //   GET /odata/machines                     -> máquinas (servidores de impressão / estações)
  //   GET /odata/installed-products           -> produtos NDD por máquina: versão e "Última Atualização"
  //   Se o perfil não tiver acesso a algum deles, a parte correspondente só fica indisponível.
  // ===========================================================================
  //   Limites de dias desde a "Última Atualização" (ajuste aqui se o cliente usar outro critério):
  const HOST_WARN_DAYS = 7;      // a partir daqui: "Atenção"
  const HOST_STALE_DAYS = 30;    // a partir daqui: "Sem comunicação"

  // Lê um conjunto OData inteiro (limite do servidor: 100 por página), sem depender do botão "Parar"
  async function fetchAllOdata(path, maxRows = 20000) {
    const url = (skip, count) => `${path}?$skip=${skip}&$top=${PAGE_SIZE}&$orderby=id${count ? '&$count=true' : ''}`;
    const first = await apiJson(url(0, true));
    const total = Math.min(first['@odata.count'] ?? first.value.length, maxRows);
    const skips = [];
    for (let s = PAGE_SIZE; s < total; s += PAGE_SIZE) skips.push(s);
    const chunks = new Array(skips.length);
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(6, skips.length) }, async () => {
      while (idx < skips.length) { const i = idx++; chunks[i] = (await apiJson(url(skips[i]))).value; }
    }));
    const map = new Map();
    first.value.concat(...chunks).forEach((r) => map.set(r.id, r));
    return [...map.values()];
  }
  function ensureEnv(force) {
    if (!force && envCache && Date.now() - envCache.at < CACHE_TTL) return Promise.resolve(envCache);
    if (envLoading) return envLoading;
    const forTenant = tenant;
    envLoading = (async () => {
      const err = {};
      const get = (key, path) => fetchAllOdata(path).catch((e) => { err[key] = e.message; return []; });
      const [queues, machines, products] = await Promise.all([
        get('queues', '/odata/printers-queues-from-printer'), get('machines', '/odata/machines'), get('products', '/odata/installed-products'),
      ]);
      const queuesByPrinter = new Map();
      queues.forEach((q) => { if (!queuesByPrinter.has(q.printerDeviceID)) queuesByPrinter.set(q.printerDeviceID, []); queuesByPrinter.get(q.printerDeviceID).push(q); });
      const env = { at: Date.now(), queues, queuesByPrinter, machines, products, err };
      if (forTenant === tenant) envCache = env; // não guarda dado de outro cliente
      return env;
    })().finally(() => { envLoading = null; });
    return envLoading;
  }
  const queuesOk = () => !!envCache && !envCache.err.queues;

  // Tipo da porta da fila (no servidor/estação) — útil para achar filas WSD
  function queuePortType(port) {
    const p = String(port || '').trim();
    if (!p) return '(vazio)';
    if (/^WSD/i.test(p)) return 'WSD';
    if (/^USB/i.test(p)) return 'USB';
    if (/^(LPT|COM)\d/i.test(p)) return 'LPT/COM';
    if (/^(IP_)?\d{1,3}(\.\d{1,3}){3}/.test(p) || /^TCP/i.test(p)) return 'TCP/IP';
    return 'Outra';
  }
  const uniq = (arr) => [...new Set(arr.filter((x) => x !== null && x !== undefined && String(x).trim() !== '').map((x) => String(x).trim()))];
  const daysSince = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()), n = new Date();
    return Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - a) / 86400000);
  };
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
  const hostStatus = (days) => (days === null ? ['Sem data', '#eef2f6'] : days < HOST_WARN_DAYS ? ['Ativo', '#d5f5e3'] : days < HOST_STALE_DAYS ? ['Atenção', '#fcf3cf'] : ['Sem comunicação', '#fbd5d0']);

  // Uma linha por produto instalado (máquina sem produto aparece com "—")
  function hostRows() {
    if (!envCache) return [];
    const qByMachine = new Map();
    envCache.queues.forEach((q) => qByMachine.set(q.machineID, (qByMachine.get(q.machineID) || 0) + 1));
    const mById = new Map(envCache.machines.map((m) => [m.id, m]));
    const rows = envCache.products.map((p) => {
      const days = daysSince(p.lastDateAccess);
      return { machineID: p.machineID, machine: mById.get(p.machineID)?.machineName || (p.machineID == null ? '(sem máquina vinculada)' : `(máquina #${p.machineID})`), product: p.productName || '', version: p.productVersion || '',
        date: p.lastDateAccess, days, status: hostStatus(days), queues: qByMachine.get(p.machineID) || 0 };
    });
    const withProd = new Set(envCache.products.map((p) => p.machineID));
    envCache.machines.filter((m) => !withProd.has(m.id)).forEach((m) => rows.push({ machineID: m.id, machine: m.machineName, product: '—', version: '', date: null, days: null, status: hostStatus(null), queues: qByMachine.get(m.id) || 0 }));
    return rows;
  }
  // Situação por máquina = contato mais recente entre os produtos dela
  function machineHealth() {
    const by = new Map();
    hostRows().forEach((r) => {
      const cur = by.get(r.machineID);
      if (!cur || (r.days !== null && (cur.days === null || r.days < cur.days))) by.set(r.machineID, { machine: r.machine, days: r.days, date: r.date, queues: r.queues });
    });
    return [...by.values()];
  }

  function renderEnvPanel(loading) {
    const sum = $('ndd-env-sum'), al = $('ndd-env-alert');
    $('ndd-env-hosts').disabled = !envCache || (!envCache.machines.length && !envCache.products.length);
    $('ndd-bulk-noqueue').disabled = running || !queuesOk();
    $('ndd-bulk-noqueue').title = queuesOk() ? 'Impressoras sem nenhuma fila no servidor/estações, em todas as páginas; abre revisão para exceções'
      : 'Indisponível: as filas de impressão não puderam ser lidas neste cliente';
    const chip = $('ndd-env-chip');
    if (loading && !envCache) { sum.textContent = 'Lendo filas e hosts…'; al.innerHTML = ''; chip.textContent = 'lendo…'; return; }
    if (!envCache) { sum.textContent = 'Ainda não carregado.'; al.innerHTML = ''; chip.textContent = ''; return; }
    const e = envCache, parts = [], chips = [];
    if (!e.err.machines) parts.push(`<b>${e.machines.length}</b> máquina(s)`);
    if (!e.err.products) parts.push(`<b>${e.products.length}</b> produto(s) NDD`);
    let qLine = '';
    if (!e.err.queues) {
      parts.push(`<b>${e.queues.length}</b> fila(s)`);
      const tot = printersCache ? printersCache.list.filter((p) => !deleted.has(p.id)) : null;
      if (tot) {
        const noQ = tot.filter((p) => !e.queuesByPrinter.has(p.id)).length;
        qLine = `<br><b>${noQ}</b> de ${tot.length} impressoras sem fila`;
        chips.push(`<span class="${noQ ? 'w' : ''}">${noQ} sem fila</span>`);
      } else chips.push(`${e.queues.length} filas`);
    }
    const denied = Object.keys(e.err);
    sum.innerHTML = (parts.join(' · ') || 'Sem dados.') + qLine + (denied.length ? `<br><span title="${esc(denied.map((k) => k + ': ' + e.err[k]).join(' | '))}">ⓘ indisponível neste cliente: ${denied.map((k) => ({ queues: 'filas', machines: 'máquinas', products: 'produtos' }[k])).join(', ')}</span>` : '');
    // alertas de host (uma linha cada; detalhe no tooltip e na janela "Hosts e produtos")
    const bad = e.err.products ? [] : machineHealth().filter((m) => m.days !== null && m.days >= HOST_WARN_DAYS).sort((a, b) => b.days - a.days);
    const stale = bad.filter((m) => m.days >= HOST_STALE_DAYS);
    const line = (m) => `<div class="${m.days >= HOST_STALE_DAYS ? 'bad' : 'warn'}" title="${esc(m.machine)}: última atualização em ${fmtDate(m.date)}, há ${m.days} dia(s)${m.queues ? ` · ${m.queues} fila(s) nesta máquina` : ''}">` +
      `<b>${esc(m.machine)}</b> · ${m.days} dias sem atualizar</div>`;
    al.innerHTML = bad.length
      ? bad.slice(0, 3).map(line).join('') + (bad.length > 3 ? `<div class="${stale.length > 3 ? 'bad' : 'warn'}">+ ${bad.length - 3} máquina(s) — ver em "Hosts e produtos"</div>` : '')
      : (e.err.products || !e.products.length ? '' : '<div class="ok">hosts com atualização recente</div>');
    if (bad.length) chips.push(`<span class="${stale.length ? 'b' : 'w'}">${stale.length ? '⛔' : '⚠'} ${bad.length} host${bad.length === 1 ? '' : 's'}</span>`);
    else if (denied.length === 3) chips.push('indisponível');
    chip.innerHTML = chips.join(' · ');
  }
  async function refreshEnv(force) {
    renderEnvPanel(true);
    try { await ensureEnv(force); } catch { /* erros ficam em envCache.err */ }
    renderEnvPanel(false);
  }
  $('ndd-env-refresh').addEventListener('click', () => refreshEnv(true));

  // Janela "Hosts e produtos" (mesma grade da lista: larguras, redimensionar, filtro por coluna; só leitura)
  function openHosts() {
    if (!envCache) return;
    document.getElementById('ndd-rv')?.remove();
    const rows = hostRows();
    const EMPTY = '(vazio)';
    const ST_RANK = { Ativo: 0, 'Atenção': 1, 'Sem comunicação': 2, 'Sem data': 3 };
    // v = texto (busca, filtro, exportação) · s = valor para ordenar · td = HTML próprio da célula
    const COLS = [
      { k: 'machine', t: 'Máquina', v: (r) => r.machine },
      { k: 'product', t: 'Produto', v: (r) => r.product },
      { k: 'version', t: 'Versão', v: (r) => r.version, cls: 'tn' },
      { k: 'date', t: 'Última atualização', v: (r) => (r.date ? fmtDate(r.date) : '—'), s: (r) => (r.date ? new Date(r.date).getTime() : 0), cls: 'tn' },
      { k: 'days', t: 'Dias', v: (r) => (r.days === null ? '—' : String(r.days)), s: (r) => (r.days === null ? 1e9 : r.days), cls: 'tn' },
      { k: 'status', t: 'Situação', v: (r) => r.status[0], s: (r) => ST_RANK[r.status[0]] ?? 9, td: (r) => `<span class="pill" style="background:${r.status[1]}">${r.status[0]}</span>` },
      { k: 'queues', t: 'Filas na máquina', v: (r) => String(r.queues), s: (r) => r.queues, cls: 'tn' },
    ];
    const colBy = Object.fromEntries(COLS.map((c) => [c.k, c]));
    const cellVal = (r, k) => { const x = String(colBy[k].v(r) ?? '').trim(); return x && x !== '—' ? x : EMPTY; };
    const W_RANGE = { machine: [130, 280], product: [140, 320], version: [84, 120], date: [150, 160], days: [84, 96], status: [136, 150], queues: [134, 140] }; // [mínimo, teto]
    const filters = new Map(); // k -> Set(valores permitidos)
    let sortKey = 'days', sortDir = -1;
    const ov = document.createElement('div');
    ov.id = 'ndd-rv';
    ov.innerHTML = `
      <div class="box">
        <div class="hd"><b>Hosts e produtos NDD${tenant ? ' — ' + esc(tenant) : ''}</b>
          <span class="chip">${envCache.machines.length} máquina(s) · ${envCache.products.length} produto(s)</span>
          <span class="flt-info" id="ndd-hw-flt"></span>
          <input type="search" id="ndd-hw-q" placeholder="Buscar máquina, produto, versão…">
          <select id="ndd-hw-st" title="Atalho para o filtro da coluna Situação"><option value="">Todas</option><option>Ativo</option><option>Atenção</option><option>Sem comunicação</option><option>Sem data</option></select>
          <button id="ndd-hw-refresh" title="Ler de novo no NDD">↻ Atualizar</button>
        </div>
        <div class="bd"><table class="grid"><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
        <div class="ft">
          <button id="ndd-hw-exp" title="Baixa em .csv as linhas exibidas (com os filtros aplicados)">⭳ Exportar</button>
          <span id="ndd-hw-count"></span>
          <span class="small" style="margin-left:auto;margin-right:8px">Ativo: até ${HOST_WARN_DAYS - 1} dia(s) · Atenção: ${HOST_WARN_DAYS}–${HOST_STALE_DAYS - 1} · Sem comunicação: ${HOST_STALE_DAYS}+ dias desde a "Última atualização" do portal</span>
          <button id="ndd-hw-close" class="primary">Fechar</button>
        </div>
      </div>
      <div class="dd" id="ndd-hw-dd" style="display:none"></div>`;
    document.body.appendChild(ov);
    const tb = ov.querySelector('tbody'), q$ = ov.querySelector('#ndd-hw-q'), st$ = ov.querySelector('#ndd-hw-st'), dd = ov.querySelector('#ndd-hw-dd');
    const sizer = gridSizer(ov, { rows, cols: () => COLS, byKey: colBy, range: W_RANGE, lsKey: 'ndd-mm-colw-hosts', lead: 0, onChange: () => paintCount() });
    gridTips(tb);
    function renderHead() {
      ov.querySelector('colgroup').innerHTML = sizer.colgroup();
      ov.querySelector('thead').innerHTML = '<tr>' + COLS.map((c) => `<th data-k="${c.k}"><div class="thc"><span class="lb" title="${c.t}">${c.t}</span><span class="so"></span><button class="fb" data-f="${c.k}" title="Filtrar">▾</button></div>${sizer.handle(c.k)}</th>`).join('') + '<th class="fill"></th></tr>';
      sizer.fit();
    }
    renderHead();
    let visible = rows;
    // linhas que passam na busca + filtros (opcionalmente ignorando uma coluna, p/ montar o próprio filtro)
    function pass(r, exceptKey) {
      const q = norm(q$.value.trim());
      if (q && !norm(COLS.map((c) => c.v(r)).join(' ')).includes(q)) return false;
      for (const [k, set] of filters) if (k !== exceptKey && !set.has(cellVal(r, k))) return false;
      return true;
    }
    function paintCount() {
      ov.querySelector('#ndd-hw-count').innerHTML = `${visible.length} de ${rows.length} linha(s)` +
        (sizer.custom() ? ' · <a href="#" id="ndd-hw-wreset" title="Volta as larguras das colunas ao ajuste automático">restaurar larguras</a>' : '');
    }
    function render() {
      const col = colBy[sortKey];
      visible = rows.filter((r) => pass(r));
      visible.sort((a, b) => {
        const x = (col.s || col.v)(a), y = (col.s || col.v)(b);
        return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'pt-BR', { numeric: true })) * sortDir || a.machine.localeCompare(b.machine) || a.product.localeCompare(b.product);
      });
      tb.innerHTML = visible.map((r) => '<tr>' + COLS.map((c) => `<td${c.cls ? ` class="${c.cls}"` : ''}>${c.td ? c.td(r) : esc(c.v(r))}</td>`).join('') + '<td></td></tr>').join('') ||
        `<tr><td colspan="${COLS.length + 1}" class="small">Nada para mostrar.</td></tr>`;
      ov.querySelectorAll('thead th[data-k]').forEach((th) => {
        th.classList.toggle('filtered', filters.has(th.dataset.k));
        th.querySelector('.so').textContent = sortKey === th.dataset.k ? (sortDir > 0 ? ' ▲' : ' ▼') : '';
      });
      // o seletor "Situação" é só um atalho do filtro dessa coluna: acompanha o que estiver filtrado nela
      const stf = filters.get('status');
      st$.value = stf && stf.size === 1 ? [...stf][0] : '';
      const nf = filters.size + (q$.value.trim() ? 1 : 0);
      ov.querySelector('#ndd-hw-flt').innerHTML = nf ? `${nf} filtro(s) ativo(s) · <a href="#" id="ndd-hw-clr">limpar filtros</a>` : '';
      paintCount();
    }
    function openFilter(k, btn) {
      const vals = new Map(), rank = new Map(), c = colBy[k];
      rows.forEach((r) => {
        if (!pass(r, k)) return;
        const v = cellVal(r, k);
        vals.set(v, (vals.get(v) || 0) + 1);
        if (c.s && !rank.has(v)) rank.set(v, c.s(r)); // datas, dias e situação em ordem natural (não alfabética)
      });
      excelFilter(dd, btn, {
        title: c.t, vals, cur: filters.get(k), rank: c.s ? rank : null,
        apply: (set) => { if (set) filters.set(k, set); else filters.delete(k); render(); },
        sort: (dir) => { sortKey = k; sortDir = dir; render(); },
      });
    }
    const closeDd = () => { dd.style.display = 'none'; dd.innerHTML = ''; };
    ov.querySelector('thead').addEventListener('click', (e) => {
      if (sizer.busy(e)) return;
      const fb = e.target.closest('.fb');
      if (fb) { e.stopPropagation(); openFilter(fb.dataset.f, fb); return; }
      const th = e.target.closest('th[data-k]'); if (!th) return;
      sortDir = sortKey === th.dataset.k ? -sortDir : 1; sortKey = th.dataset.k; render();
    });
    let t; q$.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 120); });
    st$.addEventListener('change', () => { if (st$.value) filters.set('status', new Set([st$.value])); else filters.delete('status'); render(); });
    ov.querySelector('.hd').addEventListener('click', (e) => {
      if (e.target.id !== 'ndd-hw-clr') return;
      e.preventDefault(); filters.clear(); q$.value = ''; render();
    });
    ov.querySelector('.ft').addEventListener('click', (e) => {
      if (e.target.id !== 'ndd-hw-wreset') return;
      e.preventDefault(); sizer.reset(); renderHead(); render();
    });
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (dd.style.display === 'block') closeDd(); else close();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', (e) => {
      if (dd.style.display === 'block' && !dd.contains(e.target) && !e.target.closest('.fb')) closeDd();
      if (e.target === ov) close();
    });
    ov.querySelector('#ndd-hw-close').onclick = close;
    ov.querySelector('#ndd-hw-refresh').onclick = async () => { close(); await refreshEnv(true); openHosts(); };
    ov.querySelector('#ndd-hw-exp').onclick = () => {
      const out = [['Máquina', 'Produto', 'Versão', 'Última atualização', 'Dias sem atualização', 'Situação', 'Filas na máquina']];
      visible.forEach((r) => out.push([r.machine, r.product, r.version, r.date ? fmtDate(r.date) : '', r.days ?? '', r.status[0], r.queues]));
      download(`ndd360-hosts-${stamp()}.csv`, csv(out), 'text/csv;charset=utf-8');
      log(`⭳ Exportado: ${visible.length} linha(s) de hosts e produtos.`);
    };
    render();
    q$.focus();
  }
  $('ndd-env-hosts').addEventListener('click', openHosts);

  // Atalho "Sem fila": impressoras sem nenhuma fila no servidor/estações -> revisão (nada é alterado até confirmar)
  async function openNoQueueReview() {
    if (running) return;
    running = true; stopRequested = false; refreshUi();
    let list = null;
    try {
      const [printers] = await Promise.all([ensurePrinters(true), ensureEnv(true)]);
      if (!queuesOk()) throw new Error(`as filas de impressão não puderam ser lidas (${envCache?.err.queues || 'sem resposta'})`);
      list = printers.filter((p) => !deleted.has(p.id) && !envCache.queuesByPrinter.has(p.id));
    } catch (e) { log(`✖ Sem fila: ${e.message}`, true); }
    setProgress(0, 0);
    running = false;
    renderEnvPanel(false);
    syncGrid();
    if (!list) return;
    if (!list.length) { log('Todas as impressoras têm pelo menos uma fila.'); return; }
    log(`🖨 ${list.length} impressora(s) sem nenhuma fila de impressão cadastrada no NDD.`);
    openReview(list, `Impressoras sem fila (${list.length})`, { onRefresh: openNoQueueReview });
  }
  $('ndd-bulk-noqueue').addEventListener('click', openNoQueueReview);

  // Lista de impressoras: abre TODAS (todas as páginas) em modo de seleção ao vivo
  async function openList(opts = {}) {
    if (running) return;
    running = true; stopRequested = false; refreshUi();
    let list = null;
    try {
      const [printers] = await Promise.all([ensurePrinters(!!opts.force), ensureEnv(!!opts.force).catch(() => null)]); // filas: opcional
      list = printers.filter((p) => !deleted.has(p.id));
    } catch (e) { log(`✖ Falha ao buscar impressoras: ${e.message}`, true); }
    setProgress(0, 0);
    running = false;
    renderEnvPanel(false);
    syncGrid();
    if (!list) return;
    openReview(list, `Lista de impressoras${tenant ? ' — ' + tenant : ''}`, {
      mode: 'browse', onlySelected: !!opts.onlySelected, onRefresh: () => openList({ force: true }),
    });
  }
  $('ndd-bulk-list').addEventListener('click', () => openList());
  $('ndd-bulk-count').addEventListener('click', (e) => { e.stopPropagation(); openList({ onlySelected: selected.size > 0 }); });

  // ===========================================================================
  // Contabilização em lote
  // ===========================================================================
  function readAccForm() {
    const enabled = $('ndd-acc-enabled').value;
    const origin = $('ndd-acc-origin').value;
    const color = $('ndd-acc-color').value;
    // Origem só tem efeito com a contabilização habilitada (desabilitada, o NDD grava a origem mas nada muda na prática).
    // Por isso, escolher uma origem deixando o Status em "manter" habilita as que estiverem desabilitadas.
    // Para gravar a origem SEM habilitar, escolha Status = Desabilitada explicitamente.
    const autoEnable = origin !== '' && enabled === '';
    return {
      autoEnable,
      enabled: autoEnable ? true : (enabled === '' ? null : enabled === '1'),
      origin: origin === '' ? null : Number(origin),
      mf: $('ndd-acc-mf').checked,
      col: $('ndd-acc-col').checked,
      color: color === '' ? null : Number(color),
    };
  }
  function describe(f) {
    const p = [];
    if (f.enabled !== null) p.push(`Status: ${f.enabled ? 'Habilitada' : 'Desabilitada'}${f.autoEnable ? ' (automático)' : ''}`);
    if (f.origin !== null) {
      let s = `Origem: ${ORIGIN_LABEL[f.origin]}`;
      if (f.origin === 24) s += ` (${[f.mf && 'MF', f.col && 'Collector'].filter(Boolean).join(' + ')})`;
      p.push(s);
    }
    if (f.color !== null) p.push(`Forçar cor: ${COLOR_LABEL[f.color]}`);
    return p.join(' | ');
  }
  function buildAccPayload(id, cur, f) {
    const payload = {
      printerID: id,
      enabledAccounting: f.enabled !== null ? f.enabled : !!cur.enabledAccounting,
      trustOrigin: f.origin !== null ? f.origin : cur.trustOrigin,
      hardwareMF: !!cur.hardwareMF,
      hardwareCollector: !!cur.hardwareCollector,
      forceColor: f.color !== null ? f.color : cur.forceColor,
      printerGroupID: cur.printerGroupID ?? cur.printerGroupId,
    };
    if (f.origin === 24) { payload.hardwareMF = f.mf; payload.hardwareCollector = f.col; }
    else if (f.origin !== null) { payload.hardwareMF = true; payload.hardwareCollector = true; }
    return payload;
  }
  async function updateAccounting(id, f, cur) {
    cur = cur || await apiJson(API.accGet(id));
    const payload = buildAccPayload(id, cur, f);
    const unchanged = payload.enabledAccounting === !!cur.enabledAccounting && payload.trustOrigin === cur.trustOrigin &&
      payload.forceColor === cur.forceColor &&
      (payload.trustOrigin !== 24 || (payload.hardwareMF === !!cur.hardwareMF && payload.hardwareCollector === !!cur.hardwareCollector));
    if (unchanged) return { ok: true, same: true };
    // Ligar/desligar a contabilização faz o NDD reprocessar o histórico de trabalhos da impressora:
    // pode levar minutos e falhar com DbUpdateException. Por isso timeout longo.
    const toggles = payload.enabledAccounting !== !!cur.enabledAccounting;
    await apiJson(API.accSave, { method: 'POST', body: JSON.stringify(payload), timeout: toggles ? T_SLOW : T_FAST });
    accForget([id]);
    const after = await apiJson(API.accGet(id));
    accRemember(id, after);
    const good = after.enabledAccounting === payload.enabledAccounting && after.trustOrigin === payload.trustOrigin && after.forceColor === payload.forceColor;
    return good ? { ok: true } : { ok: false, msg: `gravado, mas leitura retornou origem=${after.trustOrigin} cor=${after.forceColor} status=${after.enabledAccounting}` };
  }

  // Lê a contabilização atual de vários itens em paralelo (rápido: ~100 ms cada)
  async function prefetchAccounting(items) {
    const map = new Map();
    let n = 0;
    await pool(items, 8, async (info) => {
      try { const a = await apiJson(API.accGet(info.id)); map.set(info.id, a); accRemember(info.id, a); }
      catch (e) { map.set(info.id, { __error: e.message }); }
      setProgress(++n, items.length);
    });
    return map;
  }

  // Duas filas simultâneas: rápida (paralela) e lenta (1 por vez, operações que o servidor demora)
  async function runLanes(fast, slow, fastConc, fn) {
    await Promise.all([pool(fast, fastConc, fn), pool(slow, DISABLE_CONCURRENCY, fn)]);
  }

  $('ndd-acc-apply').addEventListener('click', async () => {
    if (running || selected.size === 0) return;
    const f = readAccForm();
    if (f.enabled === null && f.origin === null && f.color === null) return;
    if (f.origin === 24 && !f.mf && !f.col) { alert('Em "Apenas Física" marque ao menos um: MF Fabricante ou Client Collector Fabricante.'); return; }
    const items = [...selected.values()];
    const preview = items.slice(0, 15).map((v) => '• ' + infoLabel(v)).join('\n') + (items.length > 15 ? `\n… e mais ${items.length - 15}` : '');
    let autoMsg = '';
    if (f.autoEnable) {
      const off = items.filter((v) => v.enabled === false).length, unknown = items.filter((v) => typeof v.enabled !== 'boolean').length;
      autoMsg = `\n\nAs impressoras com a contabilização desabilitada serão HABILITADAS para receber a origem` +
        (unknown ? '.' : off ? ` (${off} de ${items.length} nesta seleção).` : ' (nenhuma nesta seleção).') +
        (off || unknown ? ' Habilitar pode levar mais tempo no NDD.' : '');
    }
    if (!confirm(`Alterar a contabilização de ${items.length} impressora(s)?\n\n${describe(f)}${autoMsg}\n\n${preview}`)) return;

    running = true; stopRequested = false;
    logSection();
    log(`▶ Contabilização: ${describe(f)} — lendo estado atual de ${items.length}…`);
    syncGrid();
    const t0 = Date.now();
    const curMap = await prefetchAccounting(items);
    const isSlow = (i) => { const c = curMap.get(i.id); return f.enabled !== null && c && !c.__error && !!c.enabledAccounting !== f.enabled; };
    const slow = items.filter(isSlow), fast = items.filter((i) => !isSlow(i));
    log(`   ${fast.length} alteração(ões) rápida(s) em paralelo · ${slow.length} liga/desliga contabilização (${DISABLE_CONCURRENCY} por vez)`);

    let ok = 0, same = 0, fail = 0, done = 0, autoOn = 0;
    const total = items.length;
    setProgress(0, total);
    await runLanes(fast, slow, ACC_CONCURRENCY, async (info) => {
      const lbl = infoLabel(info);
      const untrack = track(lbl);
      let res;
      const c = curMap.get(info.id);
      try {
        if (c?.__error) throw new Error(c.__error);
        res = await updateAccounting(info.id, f, c);
      } catch (e) { res = { ok: false, msg: e.message }; }
      untrack();
      done++; setProgress(done, total);
      const label = `[${done}/${total}] ${lbl}`;
      if (res.ok && res.same) { same++; log(`= ${label} — já estava assim`); }
      else if (res.ok) {
        ok++;
        const turnedOn = f.autoEnable && c && !c.enabledAccounting; // estava desabilitada: habilitada junto com a origem
        if (turnedOn) autoOn++;
        log(`✔ ${label}${turnedOn ? ' — contabilização habilitada + origem aplicada' : ''}`);
      } else { fail++; log(`✖ ${label} — ${res.msg}`, true); }
    });
    setProgress(0, 0);
    running = false;
    log(`Concluído em ${Math.round((Date.now() - t0) / 1000)} s: ${ok} alterada(s)${autoOn ? ` (${autoOn} habilitada(s) automaticamente)` : ''}, ${same} sem mudança, ${fail} falha(s)${stopRequested ? ' — interrompido' : ''}.`);
    if (fail) log('Use "Salvar log" para guardar os erros.');
    syncGrid();
    if (ok) autoReload(`${ok} contabilização(ões) alterada(s)`);
  });

  // ===========================================================================
  // Exclusão em massa via API — roteiro definido por medição no portal (11 impressoras, out/2026):
  //
  //   • excluir com contabilização habilitada  -> HTTP 500 "@@360PrinterAccountingStatusIsEnabled" (regra do servidor)
  //   • desabilitar a contabilização            -> 1,3 a 2,0 s cada, aceita várias em paralelo
  //   • depois de desabilitar, o NDD processa em FILA SERIAL no servidor: libera 1 impressora a cada ~11 s,
  //     na ordem em que foram desabilitadas (19 s, 30 s, 40 s, 54 s, 65 s para 5 desabilitadas juntas).
  //     Enquanto não libera, o delete responde HTTP 500 "@@360PrinterIsSettingDisabled".
  //   • não existe campo/endpoint que indique a liberação: o único sinal é a resposta do delete
  //   • o portal é HTTP/1.1: o navegador usa no máximo 6 conexões — mais "paralelismo" que isso só enfileira
  //
  //   Roteiro:
  //   1) estado de todas numa única leitura em lote (lista do NDD), sem 1 GET por impressora
  //   2) já desabilitadas  -> exclusão direta, 6 em paralelo, sem esperar ninguém
  //   3) habilitadas       -> desabilita TODAS logo no início (entram cedo na fila do servidor) e confere
  //   4) acompanha a fila do NDD: sonda só a PRIMEIRA da fila perto do instante previsto
  //      (não fica tentando excluir todas a toda hora, o que só ocuparia as 6 conexões)
  //   O piso de tempo é do servidor: ~8 s + 11 s × (nº de impressoras que precisam desabilitar).
  // ===========================================================================
  const DISABLE_CONCURRENCY = 3;        // desabilitações simultâneas (deixa conexões livres para excluir)
  const QUEUE_RATE_GUESS = 11000;       // intervalo medido entre liberações da fila do NDD
  const FIRST_RELEASE_GUESS = 17000;    // 1ª liberação medida entre 19 e 25 s após desabilitar
  const PROBE_LEAD = 2500;              // começa a sondar um pouco antes do previsto
  const STALL_MAX = 4 * 60 * 1000;      // fila do NDD sem liberar nada por esse tempo -> desiste (ficam desabilitadas)
  let learnedRate = null;               // intervalo real observado nesta sessão (ms)
  const isReleasePending = (msg) => /PrinterIsSettingDisabled/i.test(msg || '');
  const isAccEnabledErr = (msg) => /PrinterAccountingStatusIsEnabled/i.test(msg || '');
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };
  const queueEta = (n, rate = learnedRate || QUEUE_RATE_GUESS) => (n ? FIRST_RELEASE_GUESS - QUEUE_RATE_GUESS + n * rate + 2000 : 0);

  // Semáforo: no máximo n chamadas simultâneas
  function limiter(n) {
    let active = 0;
    const q = [];
    const next = () => {
      if (active >= n || !q.length) return;
      active++;
      const { fn, res, rej } = q.shift();
      fn().then(res, rej).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
  }
  async function sleepUnlessStopped(ms) {
    const end = Date.now() + ms;
    while (!stopRequested && Date.now() < end) await sleep(Math.min(250, end - Date.now()));
  }

  function markDeleted(info) {
    deleted.add(info.id);
    selected.delete(info.id);
    if (cmp) { cmp.status.delete(info.id); cmp.out = cmp.out.filter((i) => i.id !== info.id); cmp.noSerial = cmp.noSerial.filter((i) => i.id !== info.id); }
    if (printersCache) printersCache.list = printersCache.list.filter((p) => p.id !== info.id);
  }

  // Passo 2: desabilita e confere que ficou desabilitada de fato
  async function disableAccounting(info, cur) {
    const t0 = Date.now();
    let err = null;
    try {
      await apiJson(API.accSave, { method: 'POST', body: JSON.stringify(buildAccPayload(info.id, cur, { enabled: false, origin: null, color: null })), timeout: T_SLOW });
    } catch (e) { err = e; }
    // confere sempre: o POST pode responder 200 sem aplicar, ou falhar/estourar o tempo e ter aplicado
    accForget([info.id]);
    const chk = await apiJson(API.accGet(info.id)).catch(() => null);
    accRemember(info.id, chk);
    if (chk && chk.enabledAccounting === false) return { ok: true };
    const secs = Math.round((Date.now() - t0) / 1000);
    if (err) {
      return { ok: false, msg: `falha ao desabilitar a contabilização após ${secs} s: ${err.message}` +
        (/DbUpdate|updating the entries|sem resposta/i.test(err.message) ? ' — erro/timeout no banco do NDD; tente pela tela da impressora ou abra chamado na NDD' : '') };
    }
    return { ok: false, msg: 'o NDD respondeu OK, mas a contabilização continua habilitada (conferido lendo de volta)' };
  }

  // Excluir: sempre abre a revisão (com filtros) antes; só as marcadas lá são excluídas
  async function openDeleteReview(force) {
    if (running || selected.size === 0) return;
    const items = [...selected.values()].filter((i) => !deleted.has(i.id));
    if (force || !printersCache || Date.now() - printersCache.at > CACHE_TTL) {
      running = true; refreshUi();
      try { await ensurePrinters(true); } catch (e) { log(`⚠ Lista do NDD indisponível (${e.message}); revisão com os dados da seleção.`); }
      setProgress(0, 0); running = false; refreshUi();
    }
    const ids = new Set(printersCache?.list.map((p) => p.id) || []);
    const gone = printersCache ? items.filter((i) => !ids.has(i.id)) : [];
    if (gone.length) {
      gone.forEach((i) => { selected.delete(i.id); deleted.add(i.id); });
      log(`↷ ${gone.length} selecionada(s) já não existem no NDD e foram retiradas da seleção.`);
      syncGrid();
    }
    const live = items.filter((i) => !gone.includes(i));
    if (!live.length) return;
    openReview(live.map((i) => rawFor(i.id, i)), `Revisar exclusão — ${live.length} impressora(s)`,
      { mode: 'delete', onDelete: runDelete, onRefresh: () => openDeleteReview(true) });
  }
  $('ndd-bulk-delete').addEventListener('click', () => openDeleteReview(false));

  async function runDelete(items) {
    if (running || !items.length) return;
    running = true; stopRequested = false;
    logSection();
    const t0 = Date.now();
    log(`▶ Exclusão de ${items.length} impressora(s) — lendo o estado atual no NDD…`);
    syncGrid();

    // 1) estado em lote (uma leitura da lista, em vez de 1 GET por impressora)
    const state = new Map();
    try { (await ensurePrinters(true)).forEach((p) => state.set(p.id, p)); }
    catch (e) { log(`   ⚠ lista do NDD indisponível (${e.message}) — conferindo impressora por impressora`); }
    const gone = state.size ? items.filter((i) => !state.has(i.id)) : [];
    gone.forEach((i) => markDeleted(i));
    const todo = items.filter((i) => !gone.includes(i));
    const nDis = todo.filter((i) => (state.size ? !!state.get(i.id).enabledAccounting : true)).length;
    if (gone.length) log(`   ${gone.length} já não existem no NDD (retiradas da seleção)`);
    log(`   ${todo.length - nDis} com contabilização desabilitada → exclusão direta, ${DEL_CONCURRENCY} em paralelo`);
    if (nDis) log(`   ${nDis} com contabilização HABILITADA → desabilita todas agora; o NDD libera 1 a cada ~${Math.round((learnedRate || QUEUE_RATE_GUESS) / 1000)} s (fila do servidor) → previsão ≈ ${fmtDur(queueEta(nDis))}`);

    const limDis = limiter(DISABLE_CONCURRENCY), limDel = limiter(DEL_CONCURRENCY);
    const tryDelete = (info) => limDel(() => apiJson(API.del, { method: 'POST', body: JSON.stringify({ id: info.id }) }))
      .then(() => ({ ok: true }), (e) => ({ ok: false, e }));

    // 4) fila de espera, na ordem em que o NDD recebeu as desabilitações
    const waitQ = [];
    let pumping = null, lastRelease = 0, rate = learnedRate || QUEUE_RATE_GUESS, probes = 0, releases = 0;
    const settle = (w, res) => { const i = waitQ.indexOf(w); if (i >= 0) waitQ.splice(i, 1); w.resolve(res); };
    const released = (w) => {
      const now = Date.now();
      if (lastRelease) { const iv = now - lastRelease; if (iv > 3000 && iv < 60000) { rate = Math.round(rate * 0.5 + iv * 0.5); learnedRate = rate; } }
      lastRelease = now; releases++;
      settle(w, { ok: true, waited: now - w.since });
    };
    async function pump() {
      let rr = 0, lastSweep = Date.now();
      while (waitQ.length) {
        if (stopRequested) { [...waitQ].forEach((w) => settle(w, { ok: false, stopped: true, msg: 'interrompido — a contabilização já foi desabilitada; clique em Excluir de novo para concluir' })); return; }
        const head = waitQ[0];
        const base = lastRelease ? lastRelease + rate : head.since + FIRST_RELEASE_GUESS;
        const probeAt = Math.max(base - PROBE_LEAD, head.since + 1500);
        if (Date.now() < probeAt) { await sleepUnlessStopped(Math.min(probeAt - Date.now(), 1000)); continue; }
        probes++;
        const r = await tryDelete(head.info);
        if (r.ok) { released(head); continue; }
        if (!isReleasePending(r.e.message)) { settle(head, { ok: false, msg: `falha ao excluir: ${r.e.message}` }); continue; }
        if (Date.now() - Math.max(lastRelease, head.since) > STALL_MAX) {
          [...waitQ].forEach((w) => settle(w, { ok: false, pending: true, msg: `a fila do NDD não liberou nenhuma impressora em ${fmtDur(STALL_MAX)} (contabilização já desabilitada) — clique em Excluir de novo mais tarde` }));
          return;
        }
        // de vez em quando sonda 1 fora de ordem, caso o NDD não siga exatamente a ordem
        if (waitQ.length > 1 && Date.now() - lastSweep > 6000) {
          lastSweep = Date.now();
          rr = (rr % (waitQ.length - 1)) + 1;
          const w = waitQ[rr];
          probes++;
          const r2 = await tryDelete(w.info);
          if (r2.ok) released(w);
          else if (!isReleasePending(r2.e.message)) settle(w, { ok: false, msg: `falha ao excluir: ${r2.e.message}` });
        }
        await sleepUnlessStopped(1000);
      }
    }
    function kick() {
      if (pumping) return;
      pumping = pump()
        .catch((e) => { [...waitQ].forEach((w) => settle(w, { ok: false, msg: `erro ao acompanhar a fila: ${e.message}` })); })
        .finally(() => { pumping = null; if (waitQ.length) kick(); });
    }
    const waitRelease = (info, since) => new Promise((resolve) => { waitQ.push({ info, since, resolve }); kick(); });

    let ok = 0, fail = 0, done = 0, disabledCount = 0;
    const total = todo.length;
    setProgress(0, total);
    const hb = setInterval(() => {
      if (waitQ.length) log(`   … fila do NDD: ${waitQ.length} aguardando liberação (~${Math.round(rate / 1000)} s cada, faltam ≈ ${fmtDur(waitQ.length * rate)})`);
    }, 15000);

    async function processOne(info) {
      const st = state.get(info.id);
      if (st?.isConsolidated || info.consolidated) return { ok: false, msg: 'impressora consolidada — o portal não permite excluir' };
      let needDisable = st ? !!st.enabledAccounting : true;
      // 2) já desabilitada: tenta excluir direto
      if (!needDisable) {
        const r = await tryDelete(info);
        if (r.ok) return { ok: true };
        if (isReleasePending(r.e.message)) return waitRelease(info, Date.now());      // desabilitada há pouco: entra na fila
        if (!isAccEnabledErr(r.e.message)) return { ok: false, msg: `falha ao excluir: ${r.e.message}` };
        needDisable = true;                                                           // lista estava desatualizada
      }
      // 3) desabilita (e confere)
      if (stopRequested) return { ok: false, stopped: true, msg: 'interrompido antes de desabilitar' };
      const untrack = track(`desabilitando contabilização — ${infoLabel(info)}`);
      const d = await limDis(async () => {
        if (stopRequested) return { ok: false, stopped: true, msg: 'interrompido antes de desabilitar' };
        const cur = await apiJson(API.accGet(info.id));
        if (!cur.enabledAccounting) return { ok: true, already: true };
        return disableAccounting(info, cur);
      }).catch((e) => ({ ok: false, msg: `não foi possível desabilitar a contabilização: ${e.message}` }));
      untrack();
      if (!d.ok) return d;
      if (d.already) {
        const r = await tryDelete(info);
        if (r.ok) return { ok: true };
        if (!isReleasePending(r.e.message)) return { ok: false, msg: `falha ao excluir: ${r.e.message}` };
      } else if (++disabledCount === 1) {
        log('   ⏳ contabilização desabilitada e conferida — acompanhando a fila do NDD…');
      }
      const res = await waitRelease(info, Date.now());
      return { ...res, disabled: !d.already, queued: true };
    }

    await Promise.all(todo.map(async (info) => {
      let res;
      try { res = await processOne(info); } catch (e) { res = { ok: false, msg: e.message }; }
      done++; setProgress(done, total);
      const label = `[${done}/${total}] ${infoLabel(info)}`;
      if (res.ok) {
        ok++; markDeleted(info);
        log(`✔ ${label}${res.queued ? ` (${res.disabled ? 'contabilização desabilitada; ' : ''}fila do NDD: ${fmtDur(res.waited)})` : ''}`);
      } else {
        fail++;
        log(`✖ ${label} — ${res.msg}`, !res.stopped);
      }
    }));
    clearInterval(hb);
    setProgress(0, 0);
    running = false;
    log(`Concluído em ${fmtDur(Date.now() - t0)}: ${ok} excluída(s), ${fail} falha(s)${gone.length ? `, ${gone.length} já não existiam` : ''}${stopRequested ? ' — interrompido' : ''}.` +
      (releases > 1 ? ` Fila do NDD: ~${(rate / 1000).toFixed(1)} s por impressora, ${probes} sondagem(ns).` : ''));
    if (fail) log('Use "Salvar log" para guardar os erros.');
    syncGrid();
    if (ok || gone.length) autoReload(`${ok} impressora(s) excluída(s)`);
  }

  syncGrid();
})();

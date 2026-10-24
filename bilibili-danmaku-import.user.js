// ==UserScript==
// @name         B站视频弹幕迁移填充
// @namespace    https://space.bilibili.com/166852
// @version      2.0.0
// @description  从其他B站视频导入弹幕到当前视频，支持设置和弹幕列表管理（性能优化版）
// @author       Nothentai
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================== */
  /* 0. 常量                                                             */
  /* ================================================================== */

  var PANEL_WIDTH = 320;

  // 渲染
  var ROW_HEIGHT = 30;          // 单条轨道高度(CSS px)
  var FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", sans-serif';
  var EMIT_WINDOW = 0.35;       // 弹幕时间窗: 只在 [now-0.35, now] 内发射
  var SEEK_THRESHOLD = 1.0;     // 时间跳变超过该值视为 seek
  var MAX_ACTIVE = 300;         // 同屏活动弹幕硬上限(防弹幕海炸帧)
  var FIXED_LIFETIME = 4.0;     // 顶部/底部固定弹幕停留时长
  var SCROLL_BASE_SECONDS = 7.5; // 滚动弹幕穿越屏幕的基准时长

  // 列表
  var LIST_PAGE_SIZE = 80;      // 每批 DOM 渲染条数(虚拟化分页)

  // 网络
  var MAX_SEGMENTS = 40;        // 单视频最多拉取弹幕分段数
  var FETCH_CONCURRENCY = 4;    // 分段并发数

  // 内存
  var MAX_TOTAL_DANMAKU = 60000; // 内存中弹幕总量上限, 超出丢弃最旧的批次

  var settings = {
    fontSize: 25,       // 全局字号覆盖 (12-48)
    timeMin: 0,         // 显示区间起点(秒)
    timeMax: Infinity,  // 显示区间终点(秒)
    displayArea: 1.0,   // 垂直显示区域 0.1 ~ 1.0
    opacity: 1.0        // 不透明度 0 ~ 1
  };

  /* ================================================================== */
  /* 1. 工具                                                             */
  /* ================================================================== */

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(str) {
    // 纯字符串替换, 不创建 DOM 节点(原实现每条弹幕都 new 一个 div)
    return String(str).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  function formatTime(seconds) {
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // 二分查找: 第一个 time >= t 的下标
  function lowerBound(list, t) {
    var lo = 0, hi = list.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* ================================================================== */
  /* 2. 侧边栏 UI                                                        */
  /* ================================================================== */

  function injectPanelStyle() {
    GM_addStyle(`
      #danmaku-import-container {
        position: fixed;
        top: 70px;
        right: 0;
        z-index: 99999;
        display: flex;
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
        transition: transform 0.3s ease;
        max-height: calc(100vh - 90px);
        contain: layout style;
      }
      #danmaku-import-container.collapsed {
        transform: translateX(${PANEL_WIDTH}px);
      }
      #danmaku-import-toggle {
        width: 28px;
        height: 100px;
        background: rgba(0, 0, 0, 0.7);
        border: none;
        border-radius: 6px 0 0 6px;
        color: #fff;
        font-size: 14px;
        cursor: pointer;
        align-self: center;
        display: flex;
        align-items: center;
        justify-content: center;
        writing-mode: vertical-lr;
        letter-spacing: 4px;
        padding: 0;
        flex-shrink: 0;
      }
      #danmaku-import-toggle:hover {
        background: rgba(0, 0, 0, 0.85);
      }
      #danmaku-import-panel {
        width: ${PANEL_WIDTH}px;
        background: rgba(20, 20, 30, 0.94);
        backdrop-filter: blur(10px);
        border-left: 1px solid rgba(255, 255, 255, 0.1);
        color: #e0e0e0;
        padding: 14px 14px 10px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 12px;
        max-height: calc(100vh - 90px);
        overflow-y: auto;
      }
      #danmaku-import-panel::-webkit-scrollbar {
        width: 4px;
      }
      #danmaku-import-panel::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.15);
        border-radius: 2px;
      }
      #danmaku-import-panel h3, #danmaku-import-panel h4 {
        margin: 0;
        font-size: 13px;
        color: #ff6699;
        font-weight: 600;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding-bottom: 6px;
      }
      #danmaku-import-panel h4 {
        font-size: 12px;
        color: #aa88ff;
        margin-top: 4px;
      }
      #danmaku-import-url {
        width: 100%;
        padding: 7px 8px;
        border-radius: 5px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        font-size: 12px;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.2s;
      }
      #danmaku-import-url:focus {
        border-color: #ff6699;
      }
      #danmaku-import-url::placeholder {
        color: rgba(255, 255, 255, 0.4);
      }
      #danmaku-import-options {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #999;
      }
      #danmaku-import-options input[type="checkbox"] {
        accent-color: #ff6699;
      }
      .dmi-btn {
        width: 100%;
        padding: 8px 0;
        border: none;
        border-radius: 5px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      }
      #danmaku-import-btn {
        background: #ff6699;
        color: #fff;
      }
      #danmaku-import-btn:hover {
        background: #ff4477;
      }
      #danmaku-import-btn:disabled {
        background: #666;
        cursor: not-allowed;
      }
      #danmaku-import-clear-btn {
        background: transparent;
        color: #ccc;
        border: 1px solid rgba(255, 255, 255, 0.2);
        font-size: 11px;
        font-weight: 400;
        padding: 6px 0;
      }
      #danmaku-import-clear-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #ff4d4f;
        border-color: #ff4d4f;
      }
      #danmaku-import-status {
        font-size: 11px;
        min-height: 16px;
        line-height: 1.4;
        word-break: break-all;
      }
      #danmaku-import-status.success { color: #52c41a; }
      #danmaku-import-status.error { color: #ff4d4f; }
      #danmaku-import-status.loading { color: #faad14; }

      /* Settings section */
      .dmi-setting-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        color: #bbb;
      }
      .dmi-setting-row label {
        flex-shrink: 0;
        min-width: 50px;
      }
      .dmi-setting-row input[type="range"] {
        flex: 1;
        accent-color: #ff6699;
        height: 4px;
      }
      .dmi-setting-row .dmi-val {
        min-width: 24px;
        text-align: right;
        color: #ff6699;
        font-weight: 600;
      }
      .dmi-time-input {
        width: 55px;
        padding: 4px 5px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        font-size: 11px;
        text-align: center;
        outline: none;
        box-sizing: border-box;
      }
      .dmi-time-input:focus {
        border-color: #aa88ff;
      }
      #dmi-apply-settings-btn {
        width: 100%;
        padding: 5px 0;
        border: 1px solid rgba(170, 136, 255, 0.4);
        border-radius: 4px;
        background: transparent;
        color: #aa88ff;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.2s;
      }
      #dmi-apply-settings-btn:hover {
        background: rgba(170, 136, 255, 0.15);
      }
      #dmi-display-area {
        flex: 1;
        padding: 4px 5px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        font-size: 11px;
        outline: none;
        cursor: pointer;
      }
      #dmi-display-area option {
        background: #1a1a2e;
        color: #fff;
      }
      #dmi-display-area:focus {
        border-color: #aa88ff;
      }

      /* Author info */
      #dmi-author {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        margin-bottom: 2px;
      }
      #dmi-author-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(255, 102, 153, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        flex-shrink: 0;
      }
      #dmi-author-info {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      #dmi-author-name {
        font-size: 13px;
        color: #ff6699;
        font-weight: 600;
      }
      .dmi-author-link {
        font-size: 10px;
        color: #88aaff;
        text-decoration: none;
        display: flex;
        align-items: center;
        gap: 3px;
      }
      .dmi-author-link:hover {
        text-decoration: underline;
        color: #aaccff;
      }

      /* Danmaku list */
      #dmi-list-container {
        max-height: 260px;
        overflow-y: auto;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 5px;
        background: rgba(0, 0, 0, 0.2);
        /* 列表滚动与页面布局隔离 */
        contain: content;
      }
      #dmi-list-container::-webkit-scrollbar {
        width: 4px;
      }
      #dmi-list-container::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.12);
        border-radius: 2px;
      }
      .dmi-batch-group {
        margin-bottom: 2px;
      }
      .dmi-batch-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        background: rgba(170, 136, 255, 0.1);
        cursor: pointer;
        user-select: none;
        border-radius: 3px;
        transition: background 0.15s;
      }
      .dmi-batch-header:hover {
        background: rgba(170, 136, 255, 0.2);
      }
      .dmi-batch-arrow {
        font-size: 9px;
        color: #aa88ff;
        transition: transform 0.2s;
        flex-shrink: 0;
      }
      .dmi-batch-arrow.collapsed {
        transform: rotate(-90deg);
      }
      .dmi-batch-title {
        flex: 1;
        font-size: 11px;
        color: #ccbbff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dmi-batch-count {
        font-size: 10px;
        color: #888;
        flex-shrink: 0;
      }
      .dmi-batch-delete {
        flex-shrink: 0;
        font-size: 10px;
        color: #888;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 2px;
        transition: all 0.15s;
        border: none;
        background: none;
      }
      .dmi-batch-delete:hover {
        color: #ff4d4f;
        background: rgba(255, 77, 79, 0.15);
      }
      /* 折叠动画改为纯 CSS, 不再每帧写 style.maxHeight */
      .dmi-batch-body {
        max-height: 0;
        overflow: hidden;
        transition: max-height 0.22s ease;
      }
      .dmi-batch-body.expanded {
        max-height: 220px;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .dmi-list-empty {
        padding: 20px;
        text-align: center;
        color: #666;
        font-size: 12px;
      }
      .dmi-list-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        cursor: pointer;
        transition: background 0.15s;
        contain: layout style;
      }
      .dmi-list-item:hover {
        background: rgba(255, 255, 255, 0.06);
      }
      .dmi-list-time {
        flex-shrink: 0;
        width: 48px;
        font-size: 10px;
        color: #ff6699;
        font-family: monospace;
        text-align: center;
        background: rgba(255, 102, 153, 0.1);
        border-radius: 3px;
        padding: 2px 0;
      }
      .dmi-list-text {
        flex: 1;
        font-size: 11px;
        color: #ddd;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dmi-list-count {
        font-size: 11px;
        color: #888;
        margin-bottom: 2px;
      }
      .dmi-load-more {
        padding: 6px 0;
        text-align: center;
        font-size: 10px;
        color: #777;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.02);
      }
      .dmi-load-more:hover {
        color: #aa88ff;
        background: rgba(170, 136, 255, 0.08);
      }
    `);
  }

  function createSidePanel() {
    injectPanelStyle();

    var container = document.createElement('div');
    container.id = 'danmaku-import-container';

    var toggleBtn = document.createElement('button');
    toggleBtn.id = 'danmaku-import-toggle';
    toggleBtn.textContent = '导入弹幕';
    toggleBtn.title = '导入弹幕';

    var panel = document.createElement('div');
    panel.id = 'danmaku-import-panel';
    panel.innerHTML =
      '<div id="dmi-author">' +
        '<div id="dmi-author-avatar">&#x9759;</div>' +
        '<div id="dmi-author-info">' +
          '<span id="dmi-author-name">作者: 静寂</span>' +
          '<a class="dmi-author-link" href="https://space.bilibili.com/166852" target="_blank" title="访问B站主页">B站主页</a>' +
          '<a class="dmi-author-link" href="https://github.com/Nothentai/BiliBili-Danmaku-Import" target="_blank" title="查看项目源码">项目地址</a>' +
        '</div>' +
      '</div>' +
      '<h3>弹幕导入</h3>' +
      '<input type="text" id="danmaku-import-url" placeholder="粘贴B站视频链接...">' +
      '<div id="danmaku-import-options">' +
        '<input type="checkbox" id="danmaku-import-proportional">' +
        '<label for="danmaku-import-proportional">按视频时长比例缩放</label>' +
      '</div>' +
      '<button class="dmi-btn" id="danmaku-import-btn">导入弹幕</button>' +
      '<button class="dmi-btn" id="danmaku-import-clear-btn">清除导入弹幕</button>' +
      '<div id="danmaku-import-status"></div>' +

      '<h4>显示设置</h4>' +
      '<div class="dmi-setting-row">' +
        '<label>字体大小</label>' +
        '<input type="range" id="dmi-font-size" min="12" max="48" value="' + settings.fontSize + '">' +
        '<span class="dmi-val" id="dmi-font-val">' + settings.fontSize + '</span>' +
      '</div>' +
      '<div class="dmi-setting-row">' +
        '<label>时间范围</label>' +
        '<input type="text" class="dmi-time-input" id="dmi-time-min" placeholder="0" value="0">' +
        '<span style="color:#666;">-</span>' +
        '<input type="text" class="dmi-time-input" id="dmi-time-max" placeholder="结束">' +
        '<span style="color:#888;font-size:10px;">秒</span>' +
      '</div>' +
      '<div class="dmi-setting-row">' +
        '<label>显示区域</label>' +
        '<select id="dmi-display-area">' +
          '<option value="1.0" selected>100%</option>' +
          '<option value="0.75">75%</option>' +
          '<option value="0.5">50%</option>' +
          '<option value="0.25">25%</option>' +
          '<option value="0.1">10%</option>' +
        '</select>' +
      '</div>' +
      '<div class="dmi-setting-row">' +
        '<label>不透明度</label>' +
        '<input type="range" id="dmi-opacity" min="10" max="100" value="100">' +
        '<span class="dmi-val" id="dmi-opacity-val">100%</span>' +
      '</div>' +
      '<button class="dmi-btn" id="dmi-apply-settings-btn">应用设置</button>' +

      '<h4>弹幕列表 <span class="dmi-list-count" id="dmi-list-count"></span></h4>' +
      '<div id="dmi-list-container">' +
        '<div class="dmi-list-empty">暂无导入弹幕</div>' +
      '</div>';

    container.appendChild(toggleBtn);
    container.appendChild(panel);
    document.body.appendChild(container);
    container.classList.add('collapsed');

    toggleBtn.addEventListener('click', function () {
      container.classList.toggle('collapsed');
    });

    var ui = {
      container: container,
      panel: panel,
      urlInput: panel.querySelector('#danmaku-import-url'),
      proportionalCheckbox: panel.querySelector('#danmaku-import-proportional'),
      importBtn: panel.querySelector('#danmaku-import-btn'),
      clearBtn: panel.querySelector('#danmaku-import-clear-btn'),
      statusEl: panel.querySelector('#danmaku-import-status'),
      fontSizeSlider: panel.querySelector('#dmi-font-size'),
      fontSizeVal: panel.querySelector('#dmi-font-val'),
      timeMinInput: panel.querySelector('#dmi-time-min'),
      timeMaxInput: panel.querySelector('#dmi-time-max'),
      applySettingsBtn: panel.querySelector('#dmi-apply-settings-btn'),
      displayAreaSelect: panel.querySelector('#dmi-display-area'),
      opacitySlider: panel.querySelector('#dmi-opacity'),
      opacityVal: panel.querySelector('#dmi-opacity-val'),
      listContainer: panel.querySelector('#dmi-list-container'),
      listCount: panel.querySelector('#dmi-list-count')
    };

    ui.fontSizeSlider.addEventListener('input', function () {
      var val = parseInt(this.value, 10);
      ui.fontSizeVal.textContent = val;
      settings.fontSize = val;
      softReset();
    });

    ui.opacitySlider.addEventListener('input', function () {
      var val = parseInt(this.value, 10);
      ui.opacityVal.textContent = val + '%';
      settings.opacity = val / 100;
      forceRedraw();
    });

    // 列表事件全部走委托, 不给每个条目挂监听器(否则上千个闭包常驻)
    ui.listContainer.addEventListener('click', onListClick);

    return ui;
  }

  function setStatus(ui, type, message) {
    ui.statusEl.textContent = message;
    ui.statusEl.className = type;
  }

  function setLoading(ui, loading) {
    ui.importBtn.disabled = loading;
    ui.importBtn.textContent = loading ? '导入中...' : '导入弹幕';
  }

  /* ---------------------- 弹幕列表: 虚拟化渲染 ---------------------- */

  var listObserver = null;
  var observedSentinels = [];

  function disconnectListObserver() {
    if (listObserver) {
      listObserver.disconnect();
      listObserver = null;
    }
    observedSentinels.length = 0;
  }

  function ensureListObserver() {
    if (listObserver || typeof IntersectionObserver === 'undefined') return;
    listObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) loadNextPage(entries[i].target);
      }
    }, { root: null, rootMargin: '200px 0px 200px 0px', threshold: 0 });
  }

  function loadNextPage(sentinel) {
    if (!sentinel || sentinel.dataset.busy === '1') return;
    var batchId = parseInt(sentinel.dataset.batch, 10);
    var batch = findBatch(batchId);
    var body = sentinel.parentElement;
    if (!batch || !body) return;

    sentinel.dataset.busy = '1';
    appendPage(batch, body, LIST_PAGE_SIZE);
    sentinel.dataset.busy = '0';
  }

  // 把一批弹幕的下一段渲染进 DOM(每次最多 LIST_PAGE_SIZE 条)
  function appendPage(batch, body, count) {
    var items = body.querySelector('.dmi-items');
    if (!items) return;

    var start = parseInt(items.dataset.rendered || '0', 10);
    var list = batch.list;
    if (start >= list.length) return;

    var end = Math.min(list.length, start + count);
    var html = '';
    for (var i = start; i < end; i++) {
      var d = list[i];
      html += '<div class="dmi-list-item" data-t="' + d.time + '">' +
        '<span class="dmi-list-time">' + formatTime(d.time) + '</span>' +
        '<span class="dmi-list-text" title="' + esc(d.text) + '">' + esc(d.text) + '</span>' +
        '</div>';
    }
    // 单次 insertAdjacentHTML, 避免逐条 createElement + appendChild 触发布局
    items.insertAdjacentHTML('beforeend', html);
    items.dataset.rendered = end;

    var sentinel = body.querySelector('.dmi-load-more');
    if (sentinel) {
      if (end >= list.length) {
        sentinel.remove();
      } else {
        sentinel.textContent = '加载更多 (' + end + ' / ' + list.length + ')';
      }
    }
  }

  function refreshDanmakuList(ui) {
    disconnectListObserver();

    var container = ui.listContainer;
    container.textContent = '';

    var totalCount = 0;
    for (var b = 0; b < danmakuBatches.length; b++) {
      totalCount += danmakuBatches[b].list.length;
    }

    if (danmakuBatches.length === 0) {
      container.innerHTML = '<div class="dmi-list-empty">暂无导入弹幕</div>';
      ui.listCount.textContent = '';
      return;
    }

    ui.listCount.textContent = '(' + totalCount + '条 / ' + danmakuBatches.length + '组)';
    ensureListObserver();

    var frag = document.createDocumentFragment();

    for (var bi = 0; bi < danmakuBatches.length; bi++) {
      var batch = danmakuBatches[bi];

      var group = document.createElement('div');
      group.className = 'dmi-batch-group';
      group.dataset.batch = batch.id;

      var header = document.createElement('div');
      header.className = 'dmi-batch-header';
      header.innerHTML =
        '<span class="dmi-batch-arrow">&#9660;</span>' +
        '<span class="dmi-batch-title" title="' + esc(batch.sourceTitle) + '">' + esc(batch.sourceTitle) + '</span>' +
        '<span class="dmi-batch-count">' + batch.list.length + '条</span>' +
        '<button class="dmi-batch-delete" title="删除此组弹幕">✕</button>';

      var body = document.createElement('div');
      body.className = 'dmi-batch-body expanded';
      body.innerHTML = '<div class="dmi-items"></div>';

      var sentinel = document.createElement('div');
      sentinel.className = 'dmi-load-more';
      sentinel.dataset.batch = batch.id;
      sentinel.textContent = '加载更多';
      body.appendChild(sentinel);

      group.appendChild(header);
      group.appendChild(body);
      frag.appendChild(group);

      appendPage(batch, body, LIST_PAGE_SIZE);

      if (listObserver) {
        listObserver.observe(sentinel);
        observedSentinels.push(sentinel);
      }
    }

    container.appendChild(frag);
  }

  function findBatch(batchId) {
    for (var i = 0; i < danmakuBatches.length; i++) {
      if (danmakuBatches[i].id === batchId) return danmakuBatches[i];
    }
    return null;
  }

  // 单一委托入口
  function onListClick(e) {
    var t = e.target;

    var del = t.closest ? t.closest('.dmi-batch-delete') : null;
    if (del) {
      e.stopPropagation();
      var g = del.closest('.dmi-batch-group');
      if (g) removeBatch(parseInt(g.dataset.batch, 10));
      return;
    }

    var header = t.closest ? t.closest('.dmi-batch-header') : null;
    if (header) {
      var body = header.nextElementSibling;
      if (body) {
        var collapsed = body.classList.toggle('expanded') === false;
        var arrow = header.querySelector('.dmi-batch-arrow');
        if (arrow) arrow.classList.toggle('collapsed', collapsed);
        // 展开时补渲染一页, 保证折叠期间滚动位置不丢失
        if (!collapsed) {
          var sentinel = body.querySelector('.dmi-load-more');
          if (sentinel) {
            var items = body.querySelector('.dmi-items');
            if (items && parseInt(items.dataset.rendered || '0', 10) === 0) {
              loadNextPage(sentinel);
            }
          }
        }
      }
      return;
    }

    var more = t.closest ? t.closest('.dmi-load-more') : null;
    if (more) {
      loadNextPage(more);
      return;
    }

    var item = t.closest ? t.closest('.dmi-list-item') : null;
    if (item) {
      var v = engine.videoEl || document.querySelector('video');
      if (v) v.currentTime = parseFloat(item.dataset.t);
    }
  }

  function removeBatch(batchId) {
    var removed = false;
    for (var i = danmakuBatches.length - 1; i >= 0; i--) {
      if (danmakuBatches[i].id === batchId) {
        danmakuBatches.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) return;

    if (danmakuBatches.length === 0) {
      stopRendering();
    } else {
      softReset();
    }
    refreshDanmakuList(currentUi);
  }

  /* ================================================================== */
  /* 3. 链接解析 / 视频信息                                              */
  /* ================================================================== */

  function parseBilibiliUrl(url) {
    url = url.trim();

    var bvMatch = url.match(/BV([a-zA-Z0-9]{10})/);
    if (bvMatch) return { type: 'bv', id: 'BV' + bvMatch[1] };

    var avMatch = url.match(/av(\d+)/i);
    if (avMatch) return { type: 'av', id: avMatch[1] };

    var epMatch = url.match(/ep(\d+)/i);
    if (epMatch) return { type: 'ep', id: epMatch[1] };

    var ssMatch = url.match(/ss(\d+)/i);
    if (ssMatch) return { type: 'ss', id: ssMatch[1] };

    if (url.includes('b23.tv')) return { type: 'short', id: url };

    return null;
  }

  function getVideoInfo(identifier) {
    return new Promise(function (resolve, reject) {
      var apiUrl;
      if (identifier.type === 'bv') {
        apiUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + identifier.id;
      } else if (identifier.type === 'av') {
        apiUrl = 'https://api.bilibili.com/x/web-interface/view?aid=' + identifier.id;
      } else if (identifier.type === 'ep' || identifier.type === 'ss') {
        var param = identifier.type === 'ep' ? ('ep_id=' + identifier.id) : ('season_id=' + identifier.id);
        apiUrl = 'https://api.bilibili.com/pgc/view/web/season?' + param;
      } else {
        reject(new Error('不支持的链接类型'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'GET',
        url: apiUrl,
        timeout: 15000,
        onload: function (res) {
          try {
            var data = JSON.parse(res.responseText);
            if (data.code !== 0) {
              reject(new Error('API错误: ' + (data.message || data.code)));
              return;
            }
            if (identifier.type === 'ep' || identifier.type === 'ss') {
              var episodes = data.result && data.result.episodes;
              if (!episodes || episodes.length === 0) {
                reject(new Error('未找到该番剧的剧集信息'));
                return;
              }
              var ep = episodes[0];
              var titleSuffix = identifier.type === 'ep' ? (' EP' + identifier.id) : (' (' + ep.title + ')');
              resolve({ cid: ep.cid, duration: ep.duration, title: (data.result.title || '番剧') + titleSuffix });
            } else {
              resolve({
                cid: data.data.cid,
                duration: data.data.duration,
                title: data.data.title || ('视频-' + identifier.id)
              });
            }
          } catch (e) {
            reject(new Error('解析视频信息失败: ' + e.message));
          }
        },
        onerror: function () { reject(new Error('请求视频信息失败，请检查链接是否正确')); },
        ontimeout: function () { reject(new Error('请求视频信息超时')); }
      });
    });
  }

  function resolveShortUrl(shortUrl) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: shortUrl,
        timeout: 8000,
        onload: function (res) {
          var finalUrl = res.finalUrl || '';
          resolve(finalUrl && finalUrl.includes('bilibili.com') ? finalUrl : null);
        },
        onerror: function () { resolve(null); },
        ontimeout: function () { resolve(null); }
      });
    });
  }

  /* ================================================================== */
  /* 4. 弹幕抓取                                                         */
  /* ================================================================== */

  function parseDanmakuXml(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('XML解析错误');

    var nodes = doc.getElementsByTagName('d');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var p = el.getAttribute('p');
      if (!p) continue;

      var text = el.textContent;
      if (!text) continue;

      var parts = p.split(',');
      if (parts.length < 4) continue;

      var colorNum = parseInt(parts[3], 10);

      // 只保留渲染真正需要的字段, 丢掉 sendTime/pool/userID/rowID
      // (几万条弹幕时能省掉将近一半的常驻对象字段)
      out.push({
        time: parseFloat(parts[0]) || 0,
        mode: parseInt(parts[1], 10) || 1,
        // 注意: 颜色 0 是纯黑, 不能用 || 兜底成白色
        color: isNaN(colorNum) ? 0xFFFFFF : colorNum,
        text: text,
        tw: -1,        // 文本宽度缓存, 渲染期惰性计算
        twFont: 0      // 缓存对应的字号
      });
    }
    return out;
  }

  function fetchSegment(cid, index) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://api.bilibili.com/x/v1/dm/list.so?oid=' + cid + '&segment_index=' + index,
        timeout: 20000,
        onload: function (res) {
          try {
            resolve(parseDanmakuXml(res.responseText));
          } catch (e) {
            resolve([]);
          }
        },
        onerror: function () { resolve([]); },
        ontimeout: function () { resolve([]); }
      });
    });
  }

  // 并发受限的分段抓取, 保证顺序无关但结果拼装只做一次 push
  function fetchDanmaku(cid, duration, onProgress) {
    var total = Math.ceil((duration || 0) / 360);
    total = clamp(total, 1, MAX_SEGMENTS);

    var results = new Array(total);
    var next = 0;
    var done = 0;

    return new Promise(function (resolve, reject) {
      function finish() {
        var all = [];
        for (var i = 0; i < total; i++) {
          var seg = results[i];
          if (seg) {
            for (var j = 0; j < seg.length; j++) all.push(seg[j]);
          }
        }
        if (all.length === 0) reject(new Error('获取弹幕失败：弹幕池为空或网络异常'));
        else resolve(all);
      }

      function worker() {
        if (next >= total) return;
        var idx = next++;
        fetchSegment(cid, idx + 1).then(function (list) {
          results[idx] = list;
          done++;
          if (onProgress) onProgress(done, total);
          if (done >= total) finish();
          else worker();
        });
      }

      var n = Math.min(FETCH_CONCURRENCY, total);
      for (var i = 0; i < n; i++) worker();
    });
  }

  /* ================================================================== */
  /* 5. Canvas 渲染引擎                                                  */
  /* ================================================================== */

  var engine = {
    canvas: null,
    ctx: null,
    videoEl: null,
    dpr: 1,
    width: 0,
    height: 0,
    running: false,
    rafId: 0,
    lastTime: -1,
    boundDuration: 0,    // 绑定画布时的视频时长, 用于判断是否换片
    active: [],          // 当前屏幕上的弹幕
    rowFree: new Float64Array(32),   // 每条轨道可再次使用的视频时间(滚动弹幕)
    topFree: new Float64Array(32),
    botFree: new Float64Array(32),
    rowsCap: 32,
    maxRows: 0,
    measureFont: '',
    resizeObserver: null,
    lastTs: 0            // 上一帧 rAF 时间戳, 用于高刷屏限帧
  };

  var danmakuBatches = [];   // [{ id, sourceUrl, sourceTitle, list, cursor }]
  var batchIdCounter = 0;
  var currentUi = null;
  var colorCssCache = Object.create(null);

  function colorToCSS(colorNum) {
    var css = colorCssCache[colorNum];
    if (css) return css;
    var r = (colorNum >> 16) & 0xFF;
    var g = (colorNum >> 8) & 0xFF;
    var b = colorNum & 0xFF;
    css = 'rgb(' + r + ',' + g + ',' + b + ')';
    colorCssCache[colorNum] = css;
    return css;
  }

  /* ---------------------- 画布生命周期 ---------------------- */

  function findPlayerContainer(video) {
    var node = video.parentElement;
    for (var depth = 0; node && node !== document.body && depth < 6; depth++) {
      if (node.classList &&
          (node.classList.contains('bpx-player-video-wrap') ||
           node.classList.contains('bilibili-player-video') ||
           node.tagName === 'BWP-VIDEO')) {
        return node;
      }
      node = node.parentElement;
    }
    return video.parentElement || null;
  }

  function initCanvas() {
    var video = document.querySelector('video');
    if (!video) return false;

    engine.videoEl = video;
    engine.boundDuration = video.duration || 0;
    var container = findPlayerContainer(video);
    if (!container) return false;

    // 复用已有画布, 避免重复创建(原实现每次设置变更都重建)
    var canvas = document.getElementById('imported-danmaku-canvas');
    if (!canvas || !canvas.isConnected) {
      canvas = document.createElement('canvas');
      canvas.id = 'imported-danmaku-canvas';
      canvas.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;display:block;';
      container.appendChild(canvas);
    }

    engine.canvas = canvas;
    engine.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!engine.ctx) return false;

    engine.measureFont = '';
    // 画布可能是新建的(尺寸回到默认 300x150), 必须清掉尺寸缓存强制重算
    engine.width = 0;
    engine.height = 0;

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // 用 ResizeObserver 精确跟随播放器尺寸, 并保存引用以便卸载
    if (engine.resizeObserver) engine.resizeObserver.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      engine.resizeObserver = new ResizeObserver(function () {
        if (syncCanvasSize()) {
          resetRows();
          engine.active.length = 0;
          engine.measureFont = '';
          engine.lastTime = -1;
        }
      });
      engine.resizeObserver.observe(video);
    }

    syncCanvasSize();
    return true;
  }

  function syncCanvasSize() {
    var video = engine.videoEl;
    var canvas = engine.canvas;
    if (!video || !canvas) return false;

    var rect = video.getBoundingClientRect();
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    if (w <= 0 || h <= 0) return false;
    if (w === engine.width && h === engine.height) return false;

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    engine.width = w;
    engine.height = h;
    engine.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // 所有绘制均以 CSS px 为坐标系
    engine.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function ensureRows(cap) {
    if (engine.rowsCap >= cap) return;
    var next = Math.max(cap, engine.rowsCap * 2);
    var a = new Float64Array(next);
    var b = new Float64Array(next);
    var c = new Float64Array(next);
    a.set(engine.rowFree);
    b.set(engine.topFree);
    c.set(engine.botFree);
    engine.rowFree = a;
    engine.topFree = b;
    engine.botFree = c;
    engine.rowsCap = next;
  }

  function resetRows() {
    engine.rowFree.fill(0);
    engine.topFree.fill(0);
    engine.botFree.fill(0);
  }

  function computeMaxRows() {
    var displayHeight = engine.height * settings.displayArea;
    var rows = Math.floor((displayHeight - ROW_HEIGHT) / ROW_HEIGHT);
    if (rows < 2) rows = 2;
    if (rows > 64) rows = 64;
    engine.maxRows = rows;
    ensureRows(rows);
    return rows;
  }

  /* ---------------------- 时间游标 ---------------------- */

  function resetCursors(now) {
    var t = now - EMIT_WINDOW;
    for (var i = 0; i < danmakuBatches.length; i++) {
      var b = danmakuBatches[i];
      b.cursor = lowerBound(b.list, t < 0 ? 0 : t);
    }
  }

  /* ---------------------- 弹幕发射 ---------------------- */

  function inTimeRange(t) {
    return t >= settings.timeMin && (settings.timeMax === Infinity || t <= settings.timeMax);
  }

  function emitFromBatches(now) {
    var ctx = engine.ctx;
    var w = engine.width;
    var maxRows = engine.maxRows;
    var displayHeight = engine.height * settings.displayArea;
    var font = settings.fontSize + 'px ' + FONT_FAMILY;

    if (engine.measureFont !== font) {
      ctx.font = font;
      engine.measureFont = font;
    }

    var active = engine.active;

    for (var bi = 0; bi < danmakuBatches.length; bi++) {
      var batch = danmakuBatches[bi];
      var list = batch.list;
      var c = batch.cursor;
      var len = list.length;

      while (c < len && list[c].time <= now) {
        var d = list[c];
        c++;

        // 太旧的(seek 后/卡顿跳帧)直接丢弃, 不再渲染
        if (d.time < now - EMIT_WINDOW) continue;
        if (!inTimeRange(d.time)) continue;
        if (active.length >= MAX_ACTIVE) continue;

        // 文本宽度缓存: 同一字号下只测量一次
        if (d.twFont !== settings.fontSize) {
          d.tw = ctx.measureText(d.text).width;
          d.twFont = settings.fontSize;
        }

        var mode = d.mode;
        var kind;      // 0=滚动 1=逆向 2=固定
        var life;
        var row;
        var y;

        if (mode === 4 || mode === 5) {
          kind = 2;
          life = FIXED_LIFETIME;
          if (mode === 5) {
            row = pickFixedRow(engine.topFree, maxRows, now);
            y = (row + 1) * ROW_HEIGHT;
          } else {
            row = pickFixedRow(engine.botFree, maxRows, now);
            y = displayHeight - ROW_HEIGHT - row * ROW_HEIGHT;
          }
          if (row < 0) continue;
        } else {
          kind = (mode === 6) ? 1 : 0;
          var speed = w / SCROLL_BASE_SECONDS;
          life = clamp((w + d.tw) / speed, 4, 14);
          row = pickScrollRow(engine.rowFree, maxRows, now, d.tw, w, life);
          if (row < 0) continue;    // 轨道全满 -> 丢弃, 不重叠
          y = (row + 1) * ROW_HEIGHT;
        }

        active.push({
          text: d.text,
          tw: d.tw,
          span: w + d.tw,
          font: font,
          css: colorToCSS(d.color),
          colorKey: d.color,
          kind: kind,
          start: now,
          life: life,
          y: y,
          p: 0
        });
      }
      batch.cursor = c;
    }
  }

  // 轨道空闲判定: freeAt 记录该轨道「尾巴完全进入画面」的视频时间
  function pickScrollRow(freeAt, maxRows, now, tw, w, life) {
    for (var r = 0; r < maxRows; r++) {
      if (freeAt[r] <= now) {
        // 这条弹幕完整进入画面所需的时间 = 后面的弹幕最早能进同一轨道的时刻
        // (留 5% 余量, 避免同速下左右两端贴死或轻微重叠)
        var tail = life * (tw / (w + tw));
        freeAt[r] = now + Math.max(0.15, tail * 1.05);
        return r;
      }
    }
    return -1;
  }

  function pickFixedRow(freeAt, maxRows, now) {
    for (var r = 0; r < maxRows; r++) {
      if (freeAt[r] <= now) {
        freeAt[r] = now + FIXED_LIFETIME;
        return r;
      }
    }
    return -1;
  }

  /* ---------------------- 主循环 ---------------------- */

  function renderFrame(ts) {
    if (!engine.running) return;
    engine.rafId = requestAnimationFrame(renderFrame);

    var video = engine.videoEl;
    var ctx = engine.ctx;
    var canvas = engine.canvas;
    if (!video || !ctx || !canvas || !canvas.isConnected) return;

    // 高刷屏限帧: 间隔 < 9ms 说明是 120Hz 以上屏幕, 屏幕弹幕较多时隔帧绘制
    // (60/90/100Hz 的间隔都 >= 10ms, 不会被限帧, 不会造成掉帧感)
    if (engine.active.length > 40 && engine.lastTs && ts - engine.lastTs < 9) return;
    engine.lastTs = ts;

    var now = video.currentTime;
    if (typeof now !== 'number' || !isFinite(now)) return;

    // 时间没变化(暂停/未播放) -> 完全跳过, 不重绘、不遍历
    if (now === engine.lastTime) return;

    // seek 检测: 前后跳变超过阈值就重置游标与轨道
    if (engine.lastTime >= 0) {
      var delta = now - engine.lastTime;
      if (delta < -0.05 || delta > SEEK_THRESHOLD) {
        engine.active.length = 0;
        resetRows();
        resetCursors(now);
      }
    }
    engine.lastTime = now;

    var w = engine.width;
    var h = engine.height;
    if (w <= 0 || h <= 0) return;

    computeMaxRows();

    // 1) 发射新弹幕
    emitFromBatches(now);

    // 2) 清理过期弹幕 + 计算进度
    var active = engine.active;
    var n = active.length;
    for (var i = n - 1; i >= 0; i--) {
      var dm = active[i];
      var p = (now - dm.start) / dm.life;
      if (p >= 1 || p < -0.02) {
        // swap-pop: O(1) 删除, 不用 splice 搬移内存
        active[i] = active[n - 1];
        active.pop();
        n--;
        continue;
      }
      dm.p = p;
    }

    // 3) 绘制
    ctx.clearRect(0, 0, w, h);
    if (active.length === 0) return;

    // 按颜色排序, 大幅减少 fillStyle 切换次数(状态切换是 canvas 的主要开销之一)
    if (n > 1) active.sort(byColorKey);

    ctx.globalAlpha = settings.opacity;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = Math.max(2, settings.fontSize / 8);

    var lastColor = -1;
    var lastFont = '';

    for (var j = 0; j < n; j++) {
      var d = active[j];

      if (d.font !== lastFont) { ctx.font = d.font; lastFont = d.font; }
      if (d.colorKey !== lastColor) { ctx.fillStyle = d.css; lastColor = d.colorKey; }

      var x;
      if (d.kind === 0) x = w - d.p * d.span;
      else if (d.kind === 1) x = -d.tw + d.p * d.span;
      else x = (w - d.tw) * 0.5;

      if (x > w || x + d.tw < 0) continue;

      // strokeText 描边比 shadowBlur 便宜一个数量级(无模糊卷积)
      ctx.strokeText(d.text, x, d.y);
      ctx.fillText(d.text, x, d.y);
    }

    ctx.globalAlpha = 1;
  }

  function byColorKey(a, b) {
    return a.colorKey - b.colorKey;
  }

  function startRendering() {
    if (engine.running) return false;
    if (!initCanvas()) return false;
    engine.running = true;
    engine.lastTime = -1;
    var now = engine.videoEl ? engine.videoEl.currentTime : 0;
    resetRows();
    resetCursors(now);
    engine.rafId = requestAnimationFrame(renderFrame);
    return true;
  }

  function stopRendering() {
    engine.running = false;
    if (engine.rafId) {
      cancelAnimationFrame(engine.rafId);
      engine.rafId = 0;
    }
    engine.active.length = 0;
    engine.lastTime = -1;
    engine.measureFont = '';
    resetRows();

    if (engine.resizeObserver) {
      engine.resizeObserver.disconnect();
      engine.resizeObserver = null;
    }

    var canvas = engine.canvas;
    if (canvas) {
      // 先把位图缩到 0 再摘除, 让内核立即释放显存/内存
      canvas.width = 0;
      canvas.height = 0;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
    engine.canvas = null;
    engine.ctx = null;
    engine.videoEl = null;
    engine.width = 0;
    engine.height = 0;
  }

  // 设置变更: 保留画布, 只清空活动弹幕并重算游标
  function softReset() {
    if (!engine.running) return;
    var now = engine.videoEl ? engine.videoEl.currentTime : 0;
    engine.active.length = 0;
    engine.measureFont = '';
    resetRows();
    resetCursors(now);
    engine.lastTime = -1;   // 强制下一帧重绘
  }

  function forceRedraw() {
    engine.lastTime = -1;
  }

  /* ---------------------- 导入 ---------------------- */

  function totalDanmakuCount() {
    var total = 0;
    for (var i = 0; i < danmakuBatches.length; i++) total += danmakuBatches[i].list.length;
    return total;
  }

  function injectDanmaku(danmakuList, sourceDuration, proportional, sourceTitle, sourceUrl) {
    var video = engine.videoEl || document.querySelector('video');
    var currentDuration = video ? video.duration : 0;
    if (!currentDuration || !isFinite(currentDuration)) {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.__INITIAL_STATE__ &&
          unsafeWindow.__INITIAL_STATE__.videoData) {
        currentDuration = unsafeWindow.__INITIAL_STATE__.videoData.duration || 0;
      }
    }
    if (!currentDuration) throw new Error('无法获取当前视频时长，请先播放视频');

    var scale = (proportional && sourceDuration > 0) ? (currentDuration / sourceDuration) : 1;
    var out = [];
    var limit = currentDuration + 5;

    for (var i = 0; i < danmakuList.length; i++) {
      var dm = danmakuList[i];
      var time = dm.time * scale;
      if (time > limit) continue;

      out.push({
        time: time,
        mode: dm.mode,
        color: dm.color,
        text: dm.text,
        tw: -1,
        twFont: 0
      });
    }

    if (out.length === 0) throw new Error('该视频没有可用的弹幕');
    out.sort(byTime);

    batchIdCounter++;
    var batch = {
      id: batchIdCounter,
      sourceUrl: sourceUrl || '',
      sourceTitle: sourceTitle || ('导入 #' + batchIdCounter),
      list: out,
      cursor: 0
    };
    danmakuBatches.push(batch);

    // 内存保护: 超出总量上限时丢弃最旧的批次
    while (danmakuBatches.length > 1 && totalDanmakuCount() > MAX_TOTAL_DANMAKU) {
      danmakuBatches.shift();
    }

    if (engine.running) {
      // 正在渲染: 新批次立刻参与, 只重置游标
      resetCursors(engine.lastTime >= 0 ? engine.lastTime : (engine.videoEl.currentTime || 0));
    } else if (!startRendering()) {
      danmakuBatches.pop();
      throw new Error('未找到视频元素，请确认视频正在播放');
    }

    return batch.list.length;
  }

  function byTime(a, b) { return a.time - b.time; }

  /* ================================================================== */
  /* 6. 主流程                                                           */
  /* ================================================================== */

  function main() {
    var ui = createSidePanel();
    currentUi = ui;

    ui.applySettingsBtn.addEventListener('click', function () {
      var timeMin = parseFloat(ui.timeMinInput.value) || 0;
      var timeMaxRaw = ui.timeMaxInput.value.trim();
      var timeMax = timeMaxRaw === '' ? Infinity : (parseFloat(timeMaxRaw) || Infinity);

      settings.timeMin = Math.max(0, timeMin);
      settings.timeMax = timeMax;
      settings.displayArea = parseFloat(ui.displayAreaSelect.value) || 1.0;
      settings.opacity = parseInt(ui.opacitySlider.value, 10) / 100;

      ui.opacityVal.textContent = ui.opacitySlider.value + '%';

      setStatus(ui, 'success', '设置已应用');
      softReset();
    });

    ui.importBtn.addEventListener('click', function () {
      var url = ui.urlInput.value.trim();
      if (!url) {
        setStatus(ui, 'error', '请输入B站视频链接');
        return;
      }
      var identifier = parseBilibiliUrl(url);
      if (!identifier) {
        setStatus(ui, 'error', '无法识别该链接格式，请确认是B站视频链接');
        return;
      }
      setLoading(ui, true);
      setStatus(ui, 'loading', '正在获取视频信息...');
      handleImport(ui, identifier);
    });

    ui.urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') ui.importBtn.click();
    });

    ui.clearBtn.addEventListener('click', function () {
      stopRendering();
      danmakuBatches = [];
      resetRows();
      refreshDanmakuList(ui);
      setStatus(ui, 'success', '已清除全部导入弹幕');
    });

    function handleImport(ui, identifier) {
      var sourceUrl = ui.urlInput.value.trim();
      var videoInfo = null;

      Promise.resolve().then(function () {
        if (identifier.type === 'short') {
          return resolveShortUrl(identifier.id).then(function (realUrl) {
            if (!realUrl) throw new Error('无法解析短链接，请直接粘贴完整BV/AV链接');
            var resolved = parseBilibiliUrl(realUrl);
            if (!resolved) throw new Error('短链接重定向后无法识别');
            return resolved;
          });
        }
        return identifier;
      }).then(function (resolved) {
        setStatus(ui, 'loading', '正在获取视频 CID...');
        return getVideoInfo(resolved);
      }).then(function (info) {
        videoInfo = info;
        setStatus(ui, 'loading', '正在获取弹幕数据...');
        return fetchDanmaku(info.cid, info.duration, function (done, total) {
          if (total > 1) setStatus(ui, 'loading', '正在获取弹幕数据 ' + done + '/' + total + '...');
        });
      }).then(function (danmakuList) {
        setStatus(ui, 'loading', '正在注入弹幕...');
        var count = injectDanmaku(
          danmakuList,
          videoInfo.duration,
          ui.proportionalCheckbox.checked,
          videoInfo.title,
          sourceUrl
        );

        var dur = engine.videoEl ? engine.videoEl.duration : videoInfo.duration;
        ui.timeMaxInput.placeholder = '全部 (' + Math.floor(dur || 0) + 's)';

        refreshDanmakuList(ui);
        setLoading(ui, false);
        setStatus(ui, 'success', '成功导入 ' + count + ' 条弹幕！');
      }).catch(function (e) {
        setLoading(ui, false);
        setStatus(ui, 'error', (e && e.message) || '未知错误');
      });
    }

    // SPA / 播放器重建检测: 只做轻量比较, 1.5s 一次
    var watcher = setInterval(function () {
      if (!engine.running) return;
      var v = document.querySelector('video');
      if (!v) return;
      if (v !== engine.videoEl || !engine.canvas || !engine.canvas.isConnected) {
        var prevDuration = engine.boundDuration || 0;

        // 换了个视频(时长明显不同) -> 旧弹幕已经没意义, 清掉
        var newDuration = v.duration;
        if (danmakuBatches.length && prevDuration > 0 &&
            isFinite(newDuration) && Math.abs(newDuration - prevDuration) > 5) {
          stopRendering();
          danmakuBatches = [];
          refreshDanmakuList(ui);
          setStatus(ui, 'success', '视频已切换，已清空导入弹幕');
          return;
        }

        stopRendering();
        if (startRendering()) softReset();
      }
    }, 1500);

    // 卸载: 停帧、拆观察者、移除画布与面板, 防止内存常驻
    function dispose() {
      clearInterval(watcher);
      stopRendering();
      disconnectListObserver();
      danmakuBatches = [];
      colorCssCache = Object.create(null);
      var el = document.getElementById('danmaku-import-container');
      if (el) el.remove();
    }

    // bfcache 恢复时不能拆, 否则返回页面会失去全部状态
    window.addEventListener('pagehide', function (e) {
      if (e.persisted) return;
      dispose();
    });

    window.addEventListener('beforeunload', dispose);
  }

  main();
})();

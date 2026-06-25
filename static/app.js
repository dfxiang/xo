import { createApp, ref, computed, nextTick, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

createApp({
  setup() {
    const connected = ref(false);
    const wsAlive = ref(false);
    const loading = ref(false);
    const error = ref('');
    const username = ref('');
    const password = ref('');
    const themeMode = ref(localStorage.getItem('webterm-theme') || 'light');
    document.body.className = themeMode.value;

    const activeNav = ref('terminal');
    const sidebarCollapsed = ref(false);
    const showDonate = ref(false);
    const showAbout = ref(false);
    const filePanelPath = ref('');
    const files = ref([]);
    const filePanelLoading = ref(false);
    const uploadProgress = ref(null);

    const editorVisible = ref(false);
    const editingFile = ref('');
    const editingFilePath = ref('');
    const editorContent = ref('');

    // ── Toast 通知 ──
    const toasts = ref([]);
    let _toastId = 0;
    function showToast(msg, type = 'error') {
      const id = ++_toastId;
      toasts.value.push({ id, msg, type });
      setTimeout(() => {
        toasts.value = toasts.value.filter(t => t.id !== id);
      }, 4000);
    }

    // ── 通用确认弹窗 ──
    const confirmModal = ref({ visible: false, title: '', message: '' });
    let _confirmResolve = null;
    function showConfirm(title, message) {
      return new Promise((resolve) => {
        _confirmResolve = resolve;
        confirmModal.value = { visible: true, title, message };
        nextTick(() => {
          document.querySelector('.cm-confirm-btn')?.focus();
        });
      });
    }
    function confirmOk() {
      confirmModal.value.visible = false;
      if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
    }
    function confirmCancel() {
      confirmModal.value.visible = false;
      if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
    }
    watch(editorVisible, (v) => {
      if (v) nextTick(() => {
        const ta = document.querySelector('.fei-textarea');
        if (ta) ta.focus();
        // Also focus overlay for ESC key
        const overlay = document.querySelector('.fe-modal-overlay');
        if (overlay) overlay.focus();
      });
    });

    // ── Docker 状态 ──
    const dockerTab = ref('containers');
    const dkSearch = ref('');
    const dkContainers = ref([]);
    const dkImages = ref([]);
    const dkSelected = ref([]);
    const dkLoading = ref(false);
    const dkError = ref('');
    const dkModal = ref({ visible: false, title: '', content: '' });
    const dkModalOverlay = ref(null);
    watch(() => dkModal.value.visible, (v) => {
      if (v) nextTick(() => dkModalOverlay.value?.focus());
    });

    function dkModalClose() {
      dkModal.value.visible = false;
    }

    const editorLineCount = computed(() => {
      return (editorContent.value || '').split('\n').length;
    });

    const dkSearchPlaceholder = computed(() => {
      return dockerTab.value === 'containers' ? '搜索容器名称...' : '搜索镜像标签...';
    });

    const dkShowBulkDelete = computed(() => dockerTab.value === 'images');

    const dkAllSelected = computed(() => {
      if (dkFiltered.value.length === 0) return false;
      return dkFiltered.value.every(img => dkSelected.value.includes(img.id));
    });

    function dkToggleAll() {
      if (dkAllSelected.value) {
        dkSelected.value = [];
      } else {
        dkSelected.value = dkFiltered.value.map(img => img.id);
      }
    }

    const dkFiltered = computed(() => {
      const q = dkSearch.value.toLowerCase();
      const list = dockerTab.value === 'containers' ? dkContainers.value : dkImages.value;
      if (!q) return list;
      return list.filter(item => {
        const key = dockerTab.value === 'containers' ? item.name : item.full_tag;
        return key.toLowerCase().includes(q);
      });
    });

    function onEditorScroll() {
      const gutter = document.querySelector('.fei-gutter');
      const ta = document.querySelector('.fei-textarea');
      if (gutter && ta) gutter.scrollTop = ta.scrollTop;
    }

    function scrollEditorToTop() {
      const ta = document.querySelector('.fei-textarea');
      if (ta) ta.scrollTop = 0;
    }

    function scrollEditorToBottom() {
      const ta = document.querySelector('.fei-textarea');
      if (ta) ta.scrollTop = ta.scrollHeight;
    }

    let term = null;
    let fitAddon = null;
    let ws = null;
    let _onData = null;
    let _resizeObs = null;

    function _copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => _fallbackCopy(text));
      } else {
        _fallbackCopy(text);
      }
    }

    function _fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* ignore */ }
      document.body.removeChild(ta);
      term.focus();
    }

    function _pasteFromClipboard() {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(text => {
          if (text) term.paste(text);
        }).catch(() => _fallbackPaste());
      } else {
        _fallbackPaste();
      }
    }

    function _fallbackPaste() {
      const ta = document.createElement('textarea');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      const ok = document.execCommand('paste');
      if (ok && ta.value) {
        term.paste(ta.value);
      }
      document.body.removeChild(ta);
      term.focus();
    }

    const themes = {
      dark: {
        background: '#0a0a1a',
        foreground: '#e0e0e0',
        cursor: '#4fc3f7',
        selectionBackground: '#4fc3f740',
        black:   '#1a1a2e',
        red:     '#ef5350',
        green:   '#66bb6a',
        yellow:  '#ffca28',
        blue:    '#42a5f5',
        magenta: '#ab47bc',
        cyan:    '#26c6da',
        white:   '#e0e0e0',
        brightBlack:   '#546e7a',
        brightRed:     '#ff7043',
        brightGreen:   '#81c784',
        brightYellow:  '#ffe082',
        brightBlue:    '#64b5f6',
        brightMagenta: '#ce93d8',
        brightCyan:    '#80deea',
        brightWhite:   '#ffffff',
      },
      light: {
        background: '#fafafa',
        foreground: '#2e2e2e',
        cursor: '#1976d2',
        selectionBackground: '#1976d220',
        black:   '#f5f5f5',
        red:     '#c62828',
        green:   '#2e7d32',
        yellow:  '#f57c00',
        blue:    '#1565c0',
        magenta: '#7b1fa2',
        cyan:    '#00838f',
        white:   '#424242',
        brightBlack:   '#9e9e9e',
        brightRed:     '#e53935',
        brightGreen:   '#43a047',
        brightYellow:  '#fb8c00',
        brightBlue:    '#1e88e5',
        brightMagenta: '#9c27b0',
        brightCyan:    '#00acc1',
        brightWhite:   '#212121',
      },
    };

    function toggleTheme() {
      themeMode.value = themeMode.value === 'dark' ? 'light' : 'dark';
      localStorage.setItem('webterm-theme', themeMode.value);
      document.body.className = themeMode.value;
    }

    function focusPwd() {
      // 模板 ref 在组合式 API 中需要特殊处理，这里用 DOM 查询
      document.querySelector('input[type="password"]')?.focus();
    }

    async function login() {
      if (!username.value || !password.value) {
        error.value = '请输入用户名和密码';
        return;
      }
      loading.value = true;
      error.value = '';

      try {
        const resp = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: username.value, pwd: password.value }),
        });
        if (!resp.ok) {
          const detail = await resp.json().then(d => d.detail).catch(() => '');
          error.value = detail || '用户名或密码错误';
          loading.value = false;
          return;
        }
        connected.value = true;
        loading.value = false;
        await nextTick();
        initTerminal();
      } catch {
        error.value = '无法连接到服务器';
        loading.value = false;
      }
    }

    function initTerminal() {
      document.body.className = themeMode.value;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 16,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Menlo', monospace",
        theme: themes[themeMode.value],
        allowProposedApi: true,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const container = document.getElementById('terminal-container');
      container.style.background = themes[themeMode.value].background;
      term.open(container);
      fitAddon.fit();

      // ── 自定义键盘处理：Ctrl+C 复制 / Ctrl+V 粘贴 ──
      term.attachCustomKeyEventHandler((e) => {
        // Ctrl+C：有选中文本 → 复制；无选中 → 发送 SIGINT
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
          const sel = term.getSelection();
          if (sel && sel.length > 0) {
            _copyToClipboard(sel);
            return false;
          }
          return true;
        }

        // Ctrl+V：始终粘贴
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) {
          _pasteFromClipboard();
          return false;
        }

        return true;
      });

      connectWs();
    }

    function connectWs() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        wsAlive.value = true;
        // 通知后端当前终端尺寸
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (evt) => {
        if (evt.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(evt.data));
        }
      };

      ws.onclose = () => {
        wsAlive.value = false;
        term.write('\r\n\x1b[31m[连接已断开，5 秒后重连...]\x1b[0m\r\n');
        setTimeout(connectWs, 5000);
      };

      ws.onerror = () => {
        wsAlive.value = false;
      };

      // 用户键盘输入 → WebSocket
      if (_onData) _onData.dispose();
      _onData = term.onData(data => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // 窗口大小变化 → 后端
      if (_resizeObs) _resizeObs.disconnect();
      _resizeObs = new ResizeObserver(() => {
        fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      });
      _resizeObs.observe(document.getElementById('terminal-container'));
    }

    function switchNav(nav) {
      activeNav.value = nav;
      if (nav === 'terminal') {
        nextTick(() => {
          if (fitAddon) fitAddon.fit();
        });
      } else if (nav === 'files' && files.value.length === 0) {
        listFiles('');
      } else if (nav === 'docker') {
        dkSwitchTab('containers');
      }
    }

    function toggleSidebar() {
      sidebarCollapsed.value = !sidebarCollapsed.value;
      // 侧栏宽度变化后触发终端 resize
      nextTick(() => {
        if (fitAddon) fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      });
    }

    async function listFiles(path) {
      filePanelLoading.value = true;
      try {
        const url = path ? `/api/files?path=${encodeURIComponent(path)}` : '/api/files';
        const resp = await fetch(url);
        if (!resp.ok) {
          const detail = await resp.json().then(d => d.detail).catch(() => '');
          throw new Error(detail || '读取目录失败');
        }
        const data = await resp.json();
        filePanelPath.value = data.path;
        files.value = data.entries;
      } catch (e) {
        files.value = [];
        showToast(e.message);
      } finally {
        filePanelLoading.value = false;
      }
    }

    function enterDir(name) {
      const base = filePanelPath.value === '/' ? '' : filePanelPath.value;
      listFiles(base + '/' + name);
    }

    function goUp() {
      const parent = filePanelPath.value.split('/').slice(0, -1).join('/') || '/';
      listFiles(parent);
    }

    function downloadFile(name) {
      const url = `/api/download?path=${encodeURIComponent(filePanelPath.value + '/' + name)}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    async function openFile(name) {
      const path = filePanelPath.value + '/' + name;
      try {
        const resp = await fetch(`/api/file-content?path=${encodeURIComponent(path)}`);
        if (!resp.ok) {
          const detail = await resp.json().then(d => d.detail).catch(() => '');
          throw new Error(detail || '无法读取文件');
        }
        const data = await resp.json();
        editingFile.value = name;
        editingFilePath.value = path;
        editorContent.value = data.content;
        editorVisible.value = true;
      } catch (e) {
        showToast(e.message);
      }
    }

    function closeEditor() {
      editorVisible.value = false;
      editingFile.value = '';
      editingFilePath.value = '';
      editorContent.value = '';
    }

    async function saveFile() {
      if (!(await showConfirm('保存文件', '是否确定要覆盖服务器端文件内容？'))) return;
      try {
        const resp = await fetch('/api/file-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: editingFilePath.value, content: editorContent.value }),
        });
        if (!resp.ok) {
          const detail = await resp.json().then(d => d.detail).catch(() => '');
          throw new Error(detail || '保存失败');
        }
        closeEditor();
      } catch (e) {
        showToast(e.message);
      }
    }

    function uploadFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      const xhr = new XMLHttpRequest();
      const t0 = Date.now();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const elapsed = (Date.now() - t0) / 1000;
          uploadProgress.value = {
            name: file.name,
            percent: Math.round(e.loaded / e.total * 100),
            speed: elapsed > 0 ? e.loaded / elapsed : 0,
          };
        }
      };

      xhr.onload = async () => {
        uploadProgress.value = null;
        if (xhr.status === 200) {
          await listFiles(filePanelPath.value);
        } else {
          showToast('上传失败');
        }
        event.target.value = '';
      };

      xhr.onerror = () => {
        uploadProgress.value = null;
        showToast('上传失败');
        event.target.value = '';
      };

      const fd = new FormData();
      fd.append('file', file);
      xhr.open('POST', `/api/upload?cwd=${encodeURIComponent(filePanelPath.value)}`);
      xhr.send(fd);
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(1) + ' GB';
    }

    // ── Docker 方法 ──

    function dkSwitchTab(tab) {
      dockerTab.value = tab;
      dkSearch.value = '';
      dkSelected.value = [];
      dkError.value = '';
      // 先从 localStorage 加载缓存数据，实现秒开
      const key = `webterm-docker-${tab}`;
      const cached = localStorage.getItem(key);
      if (cached) {
        try {
          const data = JSON.parse(cached);
          if (tab === 'containers') dkContainers.value = data;
          else dkImages.value = data;
        } catch (_) { /* ignore */ }
      }
      // 然后异步刷新最新数据
      if (tab === 'containers') dkLoadContainers();
      else dkLoadImages();
    }

    function dkOnSearch() { /* 搜索由 dkFiltered 计算属性自动处理 */ }

    function dkRefresh() {
      dkError.value = '';
      dkSelected.value = [];
      if (dockerTab.value === 'containers') dkLoadContainers();
      else dkLoadImages();
    }

    async function dkLoadContainers() {
      const hasCache = dkContainers.value.length > 0;
      if (!hasCache) dkLoading.value = true;
      try {
        const resp = await fetch('/api/docker/containers');
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '请求失败');
        const data = (await resp.json()).data || [];
        localStorage.setItem('webterm-docker-containers', JSON.stringify(data));
        dkContainers.value = data;
        dkError.value = '';
      } catch (e) { dkError.value = e.message; } finally { dkLoading.value = false; }
    }

    async function dkLoadImages() {
      const hasCache = dkImages.value.length > 0;
      if (!hasCache) dkLoading.value = true;
      try {
        const resp = await fetch('/api/docker/images');
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '请求失败');
        const data = (await resp.json()).data || [];
        localStorage.setItem('webterm-docker-images', JSON.stringify(data));
        dkImages.value = data;
        dkError.value = '';
      } catch (e) { dkError.value = e.message; } finally { dkLoading.value = false; }
    }

    async function dkContainerOp(id, op) {
      try {
        const resp = await fetch(`/api/docker/containers/${id}/${op}`, { method: 'POST' });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '操作失败');
        dkLoadContainers();
      } catch (e) { showToast(e.message); }
    }

    async function dkContainerLogs(id, name) {
      try {
        const resp = await fetch(`/api/docker/containers/${id}/logs?tail=500`);
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '获取日志失败');
        const text = (await resp.json()).data || '';
        dkModal.value = { visible: true, title: `日志: ${name}`, content: text || '(无日志输出)' };
      } catch (e) { showToast(e.message); }
    }

    async function dkContainerInspect(id, name) {
      try {
        const resp = await fetch(`/api/docker/containers/${id}/inspect`);
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '获取详情失败');
        dkModal.value = { visible: true, title: `Inspect: ${name}`, content: (await resp.json()).data || '' };
      } catch (e) { showToast(e.message); }
    }

    async function dkImageInspect(id, tag) {
      try {
        const resp = await fetch(`/api/docker/images/${id}/inspect`);
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '获取详情失败');
        dkModal.value = { visible: true, title: `Inspect: ${tag}`, content: (await resp.json()).data || '' };
      } catch (e) { showToast(e.message); }
    }

    async function dkDeleteImage(id) {
      if (!(await showConfirm('删除镜像', '确定要删除该镜像吗？'))) return;
      try {
        const resp = await fetch('/api/docker/images/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id] }),
        });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '删除失败');
        dkLoadImages();
      } catch (e) { showToast(e.message); }
    }

    async function dkBulkDelete() {
      const count = dkSelected.value.length;
      if (!count) return;
      if (!(await showConfirm('批量删除镜像', `确定要删除选中的 ${count} 个镜像吗？`))) return;
      try {
        const resp = await fetch('/api/docker/images/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: dkSelected.value }),
        });
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '删除失败');
        dkSelected.value = [];
        dkLoadImages();
      } catch (e) { showToast(e.message); }
    }

    function copyCellText(event) {
      const td = event.target.closest('td');
      if (!td) return;
      const text = (td.textContent || '').trim();
      if (text) {
        _copyToClipboard(text);
        showToast('已复制到剪贴板', 'success');
      }
    }

    function dkStateClass(state) {
      if (state === 'running') return 'running';
      if (!state || state.startsWith('exited') || state === 'dead') return 'exited';
      if (state === 'paused') return 'paused';
      return '';
    }

    function dkFormatSize(bytes) { return formatSize(bytes); }

    return {
      connected, wsAlive, loading, error, username, password, themeMode,
      activeNav, sidebarCollapsed, showDonate, showAbout,
      filePanelPath, files, filePanelLoading, uploadProgress,
      editorVisible, editingFile, editingFilePath, editorContent, editorLineCount, onEditorScroll,
      scrollEditorToTop, scrollEditorToBottom,
      toggleTheme, login, focusPwd,
      switchNav, toggleSidebar, listFiles, enterDir, goUp, downloadFile, uploadFile, formatSize,
      openFile, closeEditor, saveFile,
      toasts, showToast, confirmModal, confirmOk, confirmCancel,
      // Docker
      dockerTab, dkSearch, dkContainers, dkImages,
      dkSelected, dkLoading, dkError, dkModal, dkModalOverlay, dkModalClose,
      dkSearchPlaceholder, dkShowBulkDelete, dkFiltered, dkAllSelected,
      dkSwitchTab, dkToggleAll, dkOnSearch, dkRefresh,
      dkContainerOp, dkContainerLogs, dkContainerInspect,
      dkImageInspect, dkDeleteImage, dkBulkDelete,
      dkStateClass, dkFormatSize, copyCellText,
    };
  },
}).mount('#app');

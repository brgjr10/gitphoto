const el = (id) => document.getElementById(id);

const form = el('form');
const repoInput = el('repo');
const themeSelect = el('theme');
const branchInput = el('branch');
const refreshInput = el('refresh');
const submit = el('submit');
const cancel = el('cancel');
const progress = el('progress');
const errorBox = el('error');
const result = el('result');
const preview = el('preview');
const spinner = el('spinner');
const metaBox = el('meta');
const markdownBox = el('markdown');
const copyButton = el('copy');
const downloadLink = el('download');
const openLink = el('open');
const status = el('status');
const statusText = status.querySelector('.status__text');

const STAGES = ['meta', 'clone', 'detect', 'preview', 'compose'];

let stream = null;

const setStatus = (tone, text) => {
  status.dataset.tone = tone;
  statusText.textContent = text;
};

const setBusy = (busy) => {
  submit.disabled = busy;
  submit.textContent = busy ? 'Generating…' : 'Generate cover';
  cancel.hidden = !busy;
  spinner.dataset.on = busy ? '1' : '0';
  if (busy) setStatus('busy', 'Working');
};

const resetProgress = () => {
  progress.hidden = false;
  for (const item of progress.children) delete item.dataset.state;
};

const markStage = (stage) => {
  const index = STAGES.indexOf(stage);
  if (index === -1) return;
  for (const [i, item] of [...progress.children].entries()) {
    if (i < index) item.dataset.state = 'done';
    else if (i === index) item.dataset.state = 'active';
    else delete item.dataset.state;
  }
};

const completeProgress = () => {
  for (const item of progress.children) item.dataset.state = 'done';
};

const showError = (message) => {
  errorBox.hidden = false;
  errorBox.textContent = message;
  setStatus('error', 'Failed');
};

const clearError = () => {
  errorBox.hidden = true;
  errorBox.textContent = '';
};

const chip = (label, value, accent) =>
  `<span class="chip${accent ? ' chip--accent' : ''}">${label} <b>${value}</b></span>`;

const formatBytes = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const previewFrame = preview.closest('.result__frame');

const renderResult = (data) => {
  const url = `${location.origin}/api/cover.png?repo=${encodeURIComponent(data.fullName)}&theme=${data.theme}`;

  // The cover is already written to disk by the time the result arrives, and
  // /covers serves it as an immutable content-hash URL. Loading the preview from
  // the render endpoint instead re-entered the pipeline, so a cache miss made
  // the finished render look like it had not finished: the image stayed blank
  // for the length of a second clone.
  preview.src = `${location.origin}/covers/${data.fileName}`;

  downloadLink.href = `${url}&download=1`;
  openLink.href = url;

  const parts = [
    chip('strategy', data.label ?? data.strategy, true),
    chip('via', data.cached ? 'cache' : 'fresh render'),
    chip('rendered in', formatMs(data.durationMs ?? 0)),
    chip('size', formatBytes(data.bytes)),
  ];
  if (data.framework && data.framework !== 'unknown') parts.push(chip('detected', data.framework));
  metaBox.innerHTML = parts.join('');

  markdownBox.textContent = data.markdown;
  result.hidden = false;
  setStatus('ok', 'Done');
};
const stopStream = () => {
  if (stream) {
    stream.close();
    stream = null;
  }
};

const generate = () => {
  const repo = repoInput.value.trim();
  if (!repo) return;

  clearError();
  resetProgress();
  markStage('meta');
  setBusy(true);
  stopStream();

  const params = new URLSearchParams({ repo, theme: themeSelect.value });
  if (branchInput.value.trim()) params.set('branch', branchInput.value.trim());
  if (refreshInput.checked) params.set('refresh', '1');

  stream = new EventSource(`/api/stream?${params}`);

  stream.addEventListener('progress', (event) => {
    const data = JSON.parse(event.data);
    markStage(data.stage);
    if (data.detail) statusText.textContent = data.detail;
  });

  stream.addEventListener('result', (event) => {
    const data = JSON.parse(event.data);
    completeProgress();
    renderResult(data);
    setBusy(false);
    stopStream();
  });

  stream.addEventListener('error', () => {
    // The stream is closed on success too, so only surface a failure while a
    // render is genuinely still outstanding.
    if (submit.disabled) {
      setBusy(false);
      stopStream();
      showError('The connection dropped before the cover finished rendering. Try again.');
    }
  });
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  generate();
});

cancel.addEventListener('click', () => {
  stopStream();
  setBusy(false);
  setStatus('idle', 'Cancelled');
});

copyButton.addEventListener('click', async () => {
  const text = markdownBox.textContent;
  try {
    await navigator.clipboard.writeText(text);
    copyButton.textContent = 'Copied';
  } catch {
    // Clipboard access is blocked outside secure contexts; select instead.
    const range = document.createRange();
    range.selectNodeContents(markdownBox);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyButton.textContent = 'Selected';
  }
  setTimeout(() => {
    copyButton.textContent = 'Copy';
  }, 1600);
});

// Deep link support: /?repo=owner/repo fills the form and renders immediately.
const initial = new URLSearchParams(location.search);
if (initial.get('repo')) {
  repoInput.value = initial.get('repo');
  if (initial.get('theme')) themeSelect.value = initial.get('theme');
  generate();
}

fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    if (!health.installs) {
      el('foot-note').textContent =
        'Dependency installs are disabled, so repos without a prebuilt page or a README screenshot fall back to a source card.';
    }
    if (health.auth === 'anonymous') {
      el('foot-note').textContent += ' Set GITHUB_TOKEN to lift the 60 requests/hour API limit.';
    }
  })
  .catch(() => {});

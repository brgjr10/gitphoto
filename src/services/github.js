const API = 'https://api.github.com';

// A language's canonical GitHub colour is what readers already recognise from
// the repo page, so it is worth carrying through to the banner's language bar.
const LANGUAGE_COLORS = {
  javascript: '#f1e05a', typescript: '#3178c6', python: '#3572A5', java: '#b07219',
  'c++': '#f34b7d', c: '#555555', 'c#': '#178600', go: '#00ADD8', rust: '#dea584',
  ruby: '#701516', php: '#4F5D95', swift: '#F05138', kotlin: '#A97BFF', dart: '#00B4AB',
  shell: '#89e051', html: '#e34c26', css: '#563d7c', scss: '#c6538c', less: '#1d365d',
  vue: '#41b883', svelte: '#ff3e00', astro: '#ff5a03', solidity: '#AA6746', elixir: '#6e4a7e',
  erlang: '#B83998', haskell: '#5e5086', lua: '#000080', perl: '#0298c3', r: '#198CE7',
  scala: '#c22d40', clojure: '#db5855', objectivec: '#438eff', 'objective-c++': '#6866fb',
  groovy: '#4298b8', powershell: '#012456', dockerfile: '#384d54', makefile: '#427819',
  cmake: '#DA3434', hcl: '#844FBA', terraform: '#844FBA', nix: '#7e7eff', zig: '#ec915c',
  nim: '#ffc200', crystal: '#000100', julia: '#a270ba', matlab: '#e16737', assembly: '#6E4C13',
  coffeescript: '#244776', fsharp: '#b845fc', jupyter: '#DA5B0B', batchfile: '#C1F12E',
  emacs: '#c065db', vim: '#199f4b', tex: '#3D6117', 'vim script': '#199f4b',
};

const request = async (path, { accept = 'application/vnd.github+json' } = {}) => {
  const headers = { accept, 'user-agent': 'gitphoto', 'x-github-api-version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`GitHub ${response.status} on ${path}: ${detail.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

// Accepts the shapes people actually paste: `owner/repo`, a github.com URL, an
// ssh remote, or the API URL. Anything unparseable is a client error.
export const parseRepoRef = (input) => {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('A repository is required');

  const patterns = [
    /^(?:https?:\/\/|git:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i,
    /^api\.github\.com\/repos\/([^/]+)\/([^/?#]+)/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      const [, owner, repo] = match;
      if (/^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo)) return { owner, repo };
    }
  }
  throw new Error(`Could not read a repository from "${raw}". Try "owner/repo" or a GitHub URL.`);
};

const languageColor = (name) =>
  LANGUAGE_COLORS[name.toLowerCase().replace(/\s+/g, '')] ?? LANGUAGE_COLORS[name.toLowerCase()] ?? '#8b949e';

export const getRepository = async ({ owner, repo }) => {
  const [data, languages] = await Promise.all([
    request(`/repos/${owner}/${repo}`),
    request(`/repos/${owner}/${repo}/languages`).catch(() => ({})),
  ]);

  const totalBytes = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0) || 1;
  const breakdown = Object.entries(languages)
    .map(([name, bytes]) => ({ name, bytes, share: bytes / totalBytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  return {
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    description: data.description || '',
    url: data.html_url,
    avatarUrl: data.owner.avatar_url,
    stars: data.stargazers_count,
    forks: data.forks_count,
    openIssues: data.open_issues_count,
    license: data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : null,
    topics: (data.topics ?? []).slice(0, 5),
    defaultBranch: data.default_branch || 'main',
    pushedAt: data.pushed_at,
    primaryLanguage: breakdown[0]?.name ?? 'Unknown',
    languages: breakdown.map((entry) => ({ ...entry, color: languageColor(entry.name) })),
  };
};

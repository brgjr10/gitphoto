import { escapeHtml } from '../render/format.js';

// GitHub's README sanitizer strips some attributes when a raw URL is used, so the
// generated snippet is the plainest HTML that reliably renders as full width.
export const buildMarkdown = ({ origin, fileName, fullName, description }) => {
  const src = `${origin}/covers/${fileName}`;
  const alt = description ? `${fullName} — ${description}` : fullName;
  return ['<p align="center">', `  <img src="${src}" alt="${escapeHtml(alt)}" width="100%">`, '</p>'].join('\n');
};

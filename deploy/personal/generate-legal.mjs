#!/usr/bin/env node
// Reuse the server's reviewed legal text; only public contact fields enter HTML.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privacyPage } from '../../server/privacy-page.mjs';
import { termsPage } from '../../server/terms-page.mjs';
import { escapeHtml } from '../../server/public-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function renderLegalPage(kind, options, homepage) {
  if (!['privacy', 'terms'].includes(kind)) throw new Error('Unknown legal page');
  const source = kind === 'privacy' ? privacyPage(options) : termsPage(options);
  const content = kind === 'privacy' ? source.match(/<body>([\s\S]*?)<\/body>/)?.[1] : source.match(/<main>([\s\S]*?)<\/main>/)?.[1];
  const header = homepage.match(/<header>([\s\S]*?)<\/header>/)?.[0];
  const footer = homepage.match(/<footer>([\s\S]*?)<\/footer>/)?.[0];
  const origin = homepage.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  if (!content || !header || !footer || !origin) throw new Error('Public page structure changed; check the generated legal pages');
  const title = kind === 'privacy' ? 'Privacy policy' : 'Terms of Service';
  const navigation = header.replace(`href="/${kind}"`, `href="/${kind}" aria-current="page"`);
  const note = kind === 'terms' && typeof options.footer === 'string' && options.footer.trim()
    ? `<p class="ownership">${escapeHtml(options.footer.trim().slice(0, 300))}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f3ed">
  <meta name="description" content="${title} for this personal Servant server.">
  <link rel="canonical" href="${escapeHtml(new URL('/' + kind, origin).href)}">
  <link rel="stylesheet" href="/style.css">
  <title>${title} · Servant</title>
</head>
<body>
  <div class="page">
    ${navigation}
    <main class="support legal">
      ${content.trim()}
      ${note}
    </main>
    ${footer}
  </div>
</body>
</html>
`.replace(/[ \t]+\n/g, '\n');
}

export function generateLegal(configPath, output = path.join(here, 'public')) {
  // Deliberately project only public fields. Never log or copy the server config.
  const { contactEmail, footer } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const options = { contactEmail, footer };
  const homepage = fs.readFileSync(path.join(here, 'public/index.html'), 'utf8');
  fs.mkdirSync(output, { recursive: true });
  for (const kind of ['privacy', 'terms']) fs.writeFileSync(path.join(output, `${kind}.html`), renderLegalPage(kind, options, homepage));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = process.argv[2] || process.env.SERVANT_PERSONAL_CONFIG;
  if (!config) throw new Error('Pass the private server config path or set SERVANT_PERSONAL_CONFIG');
  generateLegal(config);
  console.log('Generated public privacy and terms pages');
}

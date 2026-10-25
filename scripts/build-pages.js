'use strict';

/**
 * Turns the reference SSR output into standalone static pages.
 *
 * The reference is a Next.js App Router site. Its HTML already contains the
 * fully rendered markup, so the most faithful clone is to keep that markup
 * byte-for-byte and only swap out the Next.js runtime for our own assets.
 */

const fs = require('fs');
const path = require('path');

const REF = path.join(__dirname, '..', '.ref');
const OUT = path.join(__dirname, '..', 'public');

const PAGES = [
  { file: 'index.html', out: 'en/index.html', locale: 'en', page: 'home' },
  { file: 'id.html', out: 'id/index.html', locale: 'id', page: 'home' },
  { file: 'privacy.html', out: 'en/privacy.html', locale: 'en', page: 'privacy' },
  { file: 'privacy-id.html', out: 'id/privacy.html', locale: 'id', page: 'privacy' },
  { file: 'terms.html', out: 'en/terms.html', locale: 'en', page: 'terms' },
  { file: 'terms-id.html', out: 'id/terms.html', locale: 'id', page: 'terms' },
];

// Order of the seven server-action forms in the reference markup:
// 0 login · 1 start-free (hero) · 2 Activate (Free) · 3 Buy 7d · 4 Buy 30d
// 5 Buy 90d · 6 start-free (closing CTA)
const PLAN_BY_INDEX = ['', '', 'free', '7d', '30d', '90d', '', ''];

function stripNextRuntime(html) {
  let out = html;

  // Drop every Next.js script tag (chunks, flight data, dev overlay).
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // Self-closing / empty script tags.
  out = out.replace(/<script\b[^>]*\/>/gi, '');

  // Drop the RSC placeholder container.
  out = out.replace(/<div hidden=""><!--\$--><!--\/\$--><\/div>/g, '');
  // Drop React suspense markers.
  out = out.replace(/<!--\$-->/g, '').replace(/<!--\/\$-->/g, '');

  // Next.js image proxy -> real file.
  out = out.replace(
    /srcSet="\/_next\/image\?url=%2Flogo\.png&amp;w=32&amp;q=75 1x, \/_next\/image\?url=%2Flogo\.png&amp;w=64&amp;q=75 2x"/g,
    'srcSet="/assets/logo.png 1x, /assets/logo.png 2x"'
  );
  out = out.replace(/\/_next\/image\?url=%2Flogo\.png&amp;w=\d+&amp;q=75/g, '/assets/logo.png');
  out = out.replace(/\/_next\/image\?url=%2Flogo\.png&w=\d+&q=75/g, '/assets/logo.png');

  // Static asset URLs.
  out = out.replace(/href="\/favicon\.ico"/g, 'href="/assets/favicon.ico"');
  out = out.replace(/href="\/logo\.png"/g, 'href="/assets/logo.png"');
  out = out.replace(/content="https:\/\/cenzstudio\.com\/logo\.png"/g, 'content="/assets/logo.png"');

  // Stylesheet + preloads.
  out = out.replace(
    /<link rel="stylesheet" href="\/_next\/static\/chunks\/[^"]+\.css"[^>]*>/g,
    '<link rel="stylesheet" href="/assets/cenz.css">'
  );
  out = out.replace(/<link rel="preload" as="script"[^>]*>/g, '');
  out = out.replace(/<link rel="preconnect"[^>]*>/g, '');

  return out;
}

function rewriteForms(html) {
  let out = html;
  let planIndex = 0;

  out = out.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, (form) => {
    const label = form.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const isPricing = /^(Activate|Buy Now)$/i.test(label);

    // Rebuild the button with identical attributes, minus type="submit".
    const buttonMatch = form.match(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/i);
    const inner = buttonMatch ? buttonMatch[2] : label;
    let attrs = buttonMatch ? buttonMatch[1] : '';

    const plan = PLAN_BY_INDEX[planIndex] || 'free';
    planIndex += 1;

    const href = isPricing ? `/checkout?plan=${plan}` : '/auth/discord';
    attrs = attrs.replace(/\s*type="submit"/i, '');
    attrs = attrs.replace(/\s*data-slot="button"/i, '');

    return `<a href="${href}"${attrs} role="button">${inner}</a>`;
  });

  return out;
}

function rewriteLocaleButtons(html) {
  return html.replace(/<button\b([^>]*?)lang="(en|id)"([^>]*?)>/gi, (m, before, lang, after) => {
    return `<button${before}lang="${lang}"${after} data-locale-switch="${lang}">`;
  });
}

function injectScripts(html, locale, page) {
  const script = `<script src="/js/landing.js" defer data-locale="${locale}" data-page="${page}"></script>`;
  return html.replace(/<\/body>/i, `  ${script}\n</body>`);
}

function build() {
  fs.mkdirSync(path.join(OUT, 'en'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'id'), { recursive: true });

  for (const spec of PAGES) {
    const src = path.join(REF, spec.file);
    if (!fs.existsSync(src)) {
      console.warn(`[skip] ${spec.file} missing`);
      continue;
    }

    let html = fs.readFileSync(src, 'utf8');
    html = stripNextRuntime(html);
    html = rewriteForms(html);
    html = rewriteLocaleButtons(html);
    html = injectScripts(html, spec.locale, spec.page);

    const dest = path.join(OUT, spec.out);
    fs.writeFileSync(dest, html, 'utf8');
    console.log(`[ok] ${spec.out}  (${(html.length / 1024).toFixed(1)} kB)`);
  }
}

build();

/* Landing interactions — the pieces the Next.js runtime used to provide. */

(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------- spotlight */

  function initSpotlight() {
    if (reduceMotion) return;
    document.querySelectorAll('.spotlight').forEach((el) => {
      let raf = 0;
      let px = 0;
      let py = 0;

      const paint = () => {
        raf = 0;
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--sx', `${px - rect.left}px`);
        el.style.setProperty('--sy', `${py - rect.top}px`);
      };

      el.addEventListener(
        'pointermove',
        (e) => {
          px = e.clientX;
          py = e.clientY;
          el.style.setProperty('--spot-opacity', '1');
          if (!raf) raf = requestAnimationFrame(paint);
        },
        { passive: true }
      );

      el.addEventListener('pointerleave', () => {
        el.style.setProperty('--spot-opacity', '0');
      });
    });
  }

  /* ------------------------------------------------------------------ tilt */

  function initTilt() {
    if (reduceMotion) return;
    document.querySelectorAll('.tilt').forEach((el) => {
      const MAX = 7;
      let raf = 0;
      let rx = 0;
      let ry = 0;

      const paint = () => {
        raf = 0;
        el.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
        el.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
      };

      el.addEventListener(
        'pointermove',
        (e) => {
          const rect = el.getBoundingClientRect();
          const nx = (e.clientX - rect.left) / rect.width - 0.5;
          const ny = (e.clientY - rect.top) / rect.height - 0.5;
          ry = nx * MAX * 2;
          rx = -ny * MAX * 2;
          if (!raf) raf = requestAnimationFrame(paint);
        },
        { passive: true }
      );

      el.addEventListener('pointerleave', () => {
        rx = 0;
        ry = 0;
        if (!raf) raf = requestAnimationFrame(paint);
      });
    });
  }

  /* --------------------------------------------------------- locale switch */

  function initLocale() {
    const path = location.pathname;
    const isId = /^\/id(\/|$)/.test(path);

    document.querySelectorAll('[data-locale-switch]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-locale-switch');
        if ((target === 'id') === isId) return;

        const rest = path.replace(/^\/(en|id)(?=\/|$)/, '') || '/';
        const next = `/${target}${rest === '/' ? '' : rest}`;
        location.href = next + location.hash;
      });
    });
  }

  /* ------------------------------------------------------------ smooth nav */

  function initAnchors() {
    document.documentElement.style.scrollBehavior = 'smooth';

    document.querySelectorAll('a[href^="#"], a[href*="/#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href');
        const hash = href.includes('#') ? href.slice(href.indexOf('#')) : '';
        if (!hash || hash === '#') return;

        const onThisPage = !href.startsWith('/') || href.startsWith(`${location.pathname}#`);
        const el = document.querySelector(hash);
        if (!el || !onThisPage) return;

        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', hash);
      });
    });
  }

  /* --------------------------------------------------- reveal (CSS fallback) */

  function initRevealFallback() {
    // Chrome/Edge ship animation-timeline; Safari and Firefox do not yet.
    if (CSS.supports('animation-timeline: view()')) return;
    if (reduceMotion) return;

    const items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    items.forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(16px)';
      el.style.transition = 'opacity .6s ease, transform .6s ease';
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 }
    );

    items.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------ header on scroll */

  function initHeader() {
    const header = document.querySelector('header.sticky');
    if (!header) return;

    let last = -1;
    const onScroll = () => {
      const y = window.scrollY;
      if (y === last) return;
      last = y;
      header.style.transform = y > 24 ? 'translateY(-2px)' : '';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    initSpotlight();
    initTilt();
    initLocale();
    initAnchors();
    initRevealFallback();
    initHeader();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

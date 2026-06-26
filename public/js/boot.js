// ── Unified boot ───────────────────────────────
// Runs after all scripts are loaded. Fetches initial data and starts timers.

async function unifiedBoot() {
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'initData' })
    });
    const d = await r.json();

    // 1. Load Slideshow
    if (d.slides) {
      const slides = document.querySelectorAll('#slideshow img');
      d.slides.forEach((url, i) => {
        if (!url) return;
        slideUrls[i] = url;
        if (slides[i]) slides[i].src = url;
      });
      startSlideshow();
    }

    // 2. Load Orders
    if (d.orders) {
      if (typeof allOrders === 'undefined') window.allOrders = [];
      allOrders = d.orders.map(o => ({
        order_id: o.order_id, timestamp: o.timestamp, name: o.name,
        items: o.items, total: o.total, status: o.status,
        note: o.note, comment: o.comment
      }));
      renderFeed(allOrders.reverse());
    }

    // 3. Load Game Items
    if (d.items) {
      const loadedItems = d.items.map((row, i) => ({
        id: parseInt(row.id || row.itemid) || (i + 1),
        name: row.name || row.itemname || '',
        desc: row.desc || row.description || '',
        p: {
          7:  parseFloat((row['7d']  || row.p7  || '0').toString().replace(/,/g, '')) || 0,
          15: parseFloat((row['15d'] || row.p15 || '0').toString().replace(/,/g, '')) || 0,
          30: parseFloat((row['30d'] || row.p30 || '0').toString().replace(/,/g, '')) || 0
        }
      })).filter(it => it.name);

      ITEMS.length = 0;
      loadedItems.forEach(it => ITEMS.push(it));
      qtys = {};
      ITEMS.forEach(it => { DAYS.forEach(d => { qtys[`${it.id}_${d}`] = 0; }); });

      if (typeof buildTable === 'function') { buildTable(); recalc(); }
    }

    // 4. Load Accounts
    if (typeof fetchAccounts === 'function') fetchAccounts();

    // 5. Load Ticker text
    if (d.ticker && typeof window.setTickerText === 'function') {
      window.setTickerText(d.ticker);
    }

  } catch (e) {
    console.error("Critical Boot Error:", e);
  }
}

unifiedBoot();
setInterval(fetchSheet, 30000);
setInterval(fetchAccounts, 60000);

// ── Ticker seamless loop ──────────────────────

(function() {
  const canvas = document.getElementById('tickerCanvas');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('tickerContainer');

  const FONT = 'bold 13px "Courier New", Courier, monospace';
  const COLOR = '#d4c59a';
  const BG = '#0d0d08';
  const SPEED = 3;

  let charWidths = [], totalWidth = 0, offset = 0, animId = null;
  let baseText = '';
  let hasRealText = false;
  window._tickerBaseText = baseText;

  function setup() {
    canvas.width = wrap.offsetWidth;
    canvas.height = 28;
    ctx.font = FONT;
    const spaceW = ctx.measureText(' ').width;
    const textW = ctx.measureText(baseText).width;
    const gapNeeded = Math.max(canvas.width, canvas.width - textW + 80);
    const spacesNeeded = Math.ceil(gapNeeded / spaceW);
    const padded = baseText + ' '.repeat(spacesNeeded);
    charWidths = Array.from(padded).map(c => ctx.measureText(c).width);
    totalWidth = charWidths.reduce((a, b) => a + b, 0);
    window._tickerText = padded;
  }

  function draw() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = FONT;
    ctx.fillStyle = COLOR;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000';
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.shadowBlur = 0;
    let x = -offset;
    for (let rep = 0; rep < Math.ceil(canvas.width / totalWidth) + 2; rep++) {
      for (let i = 0; i < window._tickerText.length; i++) {
        if (x + charWidths[i] > 0 && x < canvas.width) ctx.fillText(window._tickerText[i], x, 14);
        x += charWidths[i];
      }
      for (let i = 0; i < window._tickerText.length; i++) {
        if (x + charWidths[i] > 0 && x < canvas.width) ctx.fillText(window._tickerText[i], x, 14);
        x += charWidths[i];
      }
    }
    offset += SPEED;
    if (offset >= totalWidth) offset -= totalWidth;
    animId = requestAnimationFrame(draw);
  }

  function start() {
    if (!baseText) return; // nothing to show yet — wait for real text
    if (animId) cancelAnimationFrame(animId);
    offset = 0;
    setup(); draw();
  }

  window.setTickerText = function(text) {
    const clean = (text || '').toString().trim();
    if (!clean && hasRealText) return; // don't blank out a value we already have
    baseText = clean || (hasRealText ? baseText : 'Sudden Attack Shop');
    hasRealText = true;
    window._tickerBaseText = baseText;
    wrap.style.visibility = 'visible';
    start();
  };

  // Keep canvas hidden until we have real (or fallback) text, so nothing flashes on load
  wrap.style.visibility = 'hidden';

  window.addEventListener('resize', start);

  // Safety fallback: if initData hasn't responded in 4s, show a default instead of staying blank
  setTimeout(() => { if (!hasRealText) window.setTickerText('Sudden Attack Shop'); }, 4000);
})();

// ── Audio player ──────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const player   = document.getElementById('player');
  const muteBtn  = document.getElementById('muteBtn');
  const playlist = ["./audio/suddenattack1.mp3", "./audio/suddenattack2.m4a", "./audio/suddenattack3.m4a"];
  let index      = 0;
  let isMuted    = false;
  player.volume = 0.1;

  function playNext() {
    player.src = playlist[index];
    player.play().catch(err => console.error('play error:', err));
    index = (index + 1) % playlist.length;
  }

  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    player.muted = isMuted;
    muteBtn.textContent = isMuted ? '🔇' : '🔊';
  });

  document.addEventListener('click', () => {
    if (!player.src) playNext();
  });

  player.addEventListener('ended', playNext);

  // Pause music when tab/window loses focus, resume when it comes back
  let wasPlayingBeforeHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      wasPlayingBeforeHidden = !player.paused;
      if (wasPlayingBeforeHidden) player.pause();
    } else {
      if (wasPlayingBeforeHidden) player.play().catch(() => {});
    }
  });
});

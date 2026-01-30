#!/usr/bin/env node
/**
 * Demo GIF capture script
 * Uses Puppeteer to create an animated demo GIF
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const FRAMES_DIR = path.join(ASSETS_DIR, 'frames');

// Ensure directories exist
if (!fs.existsSync(FRAMES_DIR)) {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
}

// Clean old frames
fs.readdirSync(FRAMES_DIR).forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));

const conversation = [
  { type: 'user', text: 'find arbitrage over 2%' },
  { type: 'bot', text: `<strong>🔍 Scanning Polymarket, Kalshi, Betfair, Smarkets...</strong>
<pre style="margin:8px 0;color:#e0e0e0">
<span style="color:#4fc3f7">Found 3 opportunities:</span>

<span style="color:#4fc3f7">1. Bitcoin $100k by March</span>
   Polymarket YES: <span style="color:#81c784">42¢</span>  |  Kalshi NO: <span style="color:#ef5350">54¢</span>
   <span style="color:#ffd54f">→ 4.0% arb opportunity</span>

<span style="color:#4fc3f7">2. Fed Rate Cut Q1</span>
   Betfair: <span style="color:#81c784">38¢</span>  |  Polymarket: <span style="color:#81c784">35¢</span>
   <span style="color:#ffd54f">→ 3.0% spread</span>

<span style="color:#4fc3f7">3. Trump 2028</span>
   Smarkets: <span style="color:#81c784">22¢</span>  |  Manifold: <span style="color:#81c784">19¢</span>
   <span style="color:#ffd54f">→ 2.8% spread</span>
</pre>` },
  { type: 'user', text: 'buy 100 YES BTC 100k at 0.42' },
  { type: 'bot', text: `<span style="color:#4fc3f7">🔄 Executing on Polymarket...</span>
<pre style="margin:8px 0;color:#e0e0e0">
<span style="color:#81c784">✅ Order filled!</span>
   100 YES shares @ $0.42
   Total cost: $42.00
   Max payout: $100.00
   <span style="color:#888">Position tracked in portfolio</span>
</pre>` },
  { type: 'user', text: 'swap 50 USDC to SOL on Jupiter' },
  { type: 'bot', text: `<span style="color:#4fc3f7">🔄 Routing via Jupiter aggregator...</span>
<pre style="margin:8px 0;color:#e0e0e0">
<span style="color:#81c784">✅ Swap complete!</span>
   50 USDC → 0.312 SOL
   Rate: $160.25/SOL
   Slippage: 0.08%
   <span style="color:#888">MEV protected via Jito</span>
</pre>` },
  { type: 'user', text: 'track whale 0x7c22...d795' },
  { type: 'bot', text: `<span style="color:#4fc3f7">👁️ Now tracking wallet</span>
<pre style="margin:8px 0;color:#e0e0e0">
<span style="color:#ffd54f">Recent activity:</span>
• 2h ago: Bought 5000 YES "ETH ETF" @ 0.67
• 5h ago: Sold 2000 NO "Fed Cut" @ 0.45
• 1d ago: Arb trade +$340 profit

<span style="color:#888">You'll be notified of new trades</span>
</pre>` },
  { type: 'user', text: 'portfolio' },
  { type: 'bot', text: `<strong>📊 Portfolio Summary</strong>
<pre style="margin:8px 0;color:#e0e0e0">
┌────────────────────────────────────────────┐
│ Market            │ Pos    │ Entry │ P&L  │
├────────────────────────────────────────────┤
│ <span style="color:#4fc3f7">BTC $100k Mar</span>     │ 100 YES│ $0.42 │<span style="color:#81c784">+$8</span>  │
│ <span style="color:#4fc3f7">Fed Rate Cut</span>      │ 50 YES │ $0.35 │<span style="color:#81c784">+$3</span>  │
│ <span style="color:#4fc3f7">ETH ETF</span>           │ 200 YES│ $0.65 │<span style="color:#ef5350">-$4</span>  │
├────────────────────────────────────────────┤
│ <span style="color:#ffd54f">Total P&L: +$7.00 (+5.2%)</span>                 │
└────────────────────────────────────────────┘
</pre>` },
];

function generateHTML(messages) {
  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #fff;
      padding: 20px;
      min-height: 500px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-bottom: 15px;
      border-bottom: 1px solid #334155;
      margin-bottom: 15px;
    }
    .logo {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #06b6d4, #0891b2);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }
    .title { font-size: 20px; font-weight: 600; color: #f1f5f9; }
    .subtitle { font-size: 12px; color: #64748b; }
    .messages { display: flex; flex-direction: column; gap: 12px; }
    .msg {
      max-width: 90%;
      padding: 12px 16px;
      border-radius: 16px;
      line-height: 1.5;
      font-size: 14px;
    }
    .user {
      background: linear-gradient(135deg, #0891b2, #06b6d4);
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .bot {
      background: #1e293b;
      border: 1px solid #334155;
      color: #e2e8f0;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .bot pre {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .input-area {
      margin-top: 15px;
      display: flex;
      gap: 10px;
    }
    .input {
      flex: 1;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 24px;
      padding: 12px 20px;
      color: #94a3b8;
      font-size: 14px;
    }
    .send {
      background: linear-gradient(135deg, #06b6d4, #0891b2);
      border: none;
      border-radius: 24px;
      padding: 12px 24px;
      color: #fff;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🐋</div>
    <div>
      <div class="title">Clodds</div>
      <div class="subtitle">Chat anywhere. Trade everywhere.</div>
    </div>
  </div>
  <div class="messages">
    ${messages.map(m => `<div class="msg ${m.type}">${m.text}</div>`).join('\n')}
  </div>
  <div class="input-area">
    <div class="input">Type a message...</div>
    <div class="send">Send</div>
  </div>
</body>
</html>`;
}

async function captureDemo() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 500 });

    let frameNum = 0;
    const captureFrame = async (duration = 1) => {
      for (let i = 0; i < duration; i++) {
        const framePath = path.join(FRAMES_DIR, `frame_${String(frameNum++).padStart(4, '0')}.png`);
        await page.screenshot({ path: framePath, type: 'png' });
      }
    };

    // Start with empty chat
    console.log('Capturing frames...');
    await page.setContent(generateHTML([]));
    await captureFrame(10); // Pause at start

    // Add messages one by one
    const visibleMessages = [];
    for (const msg of conversation) {
      visibleMessages.push(msg);
      await page.setContent(generateHTML(visibleMessages));

      if (msg.type === 'user') {
        await captureFrame(8); // Short pause for user message
      } else {
        await captureFrame(25); // Longer pause to read bot response
      }
    }

    // Final pause
    await captureFrame(20);

    console.log(`Captured ${frameNum} frames`);

    // Generate GIF with ffmpeg
    console.log('Generating GIF...');
    const gifPath = path.join(ASSETS_DIR, 'demo.gif');

    try {
      execSync(`ffmpeg -y -framerate 10 -i "${FRAMES_DIR}/frame_%04d.png" -vf "fps=10,scale=700:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" "${gifPath}"`, {
        stdio: 'inherit'
      });
      console.log('✅ Demo GIF created:', gifPath);

      // Copy to docs public
      const docsGif = path.join(__dirname, '..', 'apps', 'docs', 'public', 'demo.gif');
      fs.copyFileSync(gifPath, docsGif);
      console.log('✅ Copied to:', docsGif);

      // Show file size
      const stats = fs.statSync(gifPath);
      console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB`);
    } catch (e) {
      console.error('ffmpeg failed:', e.message);
      console.log('Try: brew install ffmpeg');
    }

  } finally {
    await browser.close();
  }
}

captureDemo().catch(console.error);

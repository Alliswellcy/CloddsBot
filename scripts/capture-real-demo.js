#!/usr/bin/env node
/**
 * Capture REAL Clodds WebChat Demo
 * Records actual interaction with the live webchat
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const FRAMES_DIR = path.join(ASSETS_DIR, 'frames');
const WEBCHAT_URL = 'http://localhost:18789/webchat';

// Ensure directories
if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.readdirSync(FRAMES_DIR).forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));

const commands = [
  'find arbitrage opportunities over 2%',
  'search bitcoin 100k across all platforms',
  'buy 50 YES on "BTC 100k March" at 0.42 on polymarket',
  'swap 100 USDC to SOL on Jupiter',
  'show top whales on polymarket today',
  'show my portfolio with P&L',
  'copy trade wallet 0x7c22...d795 with 10% size',
];

async function captureDemo() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'],
    protocolTimeout: 120000,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 700, height: 500 });

  let frameNum = 0;
  const captureFrame = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      await page.screenshot({
        path: path.join(FRAMES_DIR, `frame_${String(frameNum++).padStart(4, '0')}.png`)
      });
    }
  };

  try {
    console.log('Loading webchat...');
    await page.goto(WEBCHAT_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await new Promise(r => setTimeout(r, 1000));
    await captureFrame(15); // Initial state

    for (const cmd of commands) {
      console.log(`Typing: ${cmd}`);

      // Type the command
      await page.type('#input', cmd, { delay: 50 });
      await captureFrame(5);

      // Send it
      await page.click('button');
      await captureFrame(5);

      // Wait for response (Claude takes time)
      console.log('Waiting for Claude response...');
      const startMsgCount = await page.$$eval('.msg', els => els.length);

      // Wait up to 60s for new message
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const currentCount = await page.$$eval('.msg', els => els.length);
        if (currentCount > startMsgCount) {
          // Wait a bit more for response to complete
          await new Promise(r => setTimeout(r, 2000));
          break;
        }
      }

      await captureFrame(30); // Capture response
    }

    await captureFrame(20); // Final pause

    console.log(`Captured ${frameNum} frames`);

    // Generate GIF
    console.log('Generating GIF...');
    const gifPath = path.join(ASSETS_DIR, 'demo.gif');
    execSync(`ffmpeg -y -framerate 10 -i "${FRAMES_DIR}/frame_%04d.png" -vf "fps=10,scale=700:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" "${gifPath}"`, { stdio: 'inherit' });

    // Copy to docs
    const docsGif = path.join(__dirname, '..', 'apps', 'docs', 'public', 'demo.gif');
    fs.copyFileSync(gifPath, docsGif);
    console.log('✅ Demo GIF saved to:', gifPath);

  } finally {
    await browser.close();
  }
}

captureDemo().catch(console.error);

// fetchAlexaActivity.js
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
require('dotenv').config({ 
  path: path.resolve(__dirname, '.env'),
  quiet: true
});

// Get credentials from environment variables
const AMAZON_EMAIL = process.env.AMAZON_EMAIL;
const AMAZON_PASSWORD = process.env.AMAZON_PASSWORD;

if (!AMAZON_EMAIL || !AMAZON_PASSWORD) {
  console.error('Error: Please set AMAZON_EMAIL and AMAZON_PASSWORD environment variables.');
  process.exit(1);
}

// Generate a unique hash for current credentials
function generateCredentialsHash(email, password) {
  return crypto.createHash('sha256').update(`${email}:${password}`).digest('hex').substring(0, 16);
}

const currentCredentialsHash = generateCredentialsHash(AMAZON_EMAIL, AMAZON_PASSWORD);

// URLs for Amazon homepage and Alexa activity page
const homeUrl = 'https://www.amazon.in';
const activityUrl = 'https://www.amazon.in/alexa-privacy/apd/rvh';

// Profile management functions
function getProfilePath() {
  return path.join(__dirname, 'chrome-user-data');
}

function getCredentialsMarkerPath() {
  return path.join(getProfilePath(), 'credentials.marker');
}

function shouldUseExistingProfile() {
  const profilePath = getProfilePath();
  const markerPath = getCredentialsMarkerPath();
  
  // If profile doesn't exist, we need to create it
  if (!fs.existsSync(profilePath)) {
    return false;
  }
  
  // If marker doesn't exist, credentials have changed or this is a fresh profile
  if (!fs.existsSync(markerPath)) {
    return false;
  }
  
  // Read the stored credentials hash
  try {
    const storedHash = fs.readFileSync(markerPath, 'utf8').trim();
    return storedHash === currentCredentialsHash;
  } catch (error) {
    console.warn('Could not read credentials marker:', error.message);
    return false;
  }
}

function cleanupProfileIfNeeded() {
  if (!shouldUseExistingProfile()) {
    const profilePath = getProfilePath();
    if (fs.existsSync(profilePath)) {
      console.log(`Credentials changed or profile invalid. Removing old profile: ${profilePath}`);
      try {
        fs.rmSync(profilePath, { recursive: true, force: true });
        console.log('Old profile removed successfully');
      } catch (error) {
        console.warn('Failed to remove old profile:', error.message);
      }
    }
    
    // Create fresh profile directory
    fs.mkdirSync(profilePath, { recursive: true });
    
    // Store current credentials hash
    const markerPath = getCredentialsMarkerPath();
    try {
      fs.writeFileSync(markerPath, currentCredentialsHash, 'utf8');
      console.log('Created new profile with current credentials');
    } catch (error) {
      console.warn('Could not create credentials marker:', error.message);
    }
  } else {
    console.log('Using existing profile with matching credentials');
  }
}

// Helper to wait for user to press Enter in terminal
function waitForUserPrompt(promptText = 'Press Enter when you have completed the required action in the browser...') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${promptText}\n`, () => {
      rl.close();
      resolve();
    });
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create a debug folder and dump page HTML, screenshot, cookies and alerts.
 * Returns the folder path.
 */
async function dumpDebugArtifacts(driver, label = 'auth-debug') {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const folder = path.join(__dirname, `${label}-${ts}`);
    fs.mkdirSync(folder, { recursive: true });

    // Save page HTML
    let html = '';
    try {
      html = await driver.executeScript('return document.documentElement.outerHTML;');
      fs.writeFileSync(path.join(folder, 'page.html'), html, 'utf8');
    } catch (e) {
      fs.writeFileSync(path.join(folder, 'page.html'), `Error capturing HTML: ${e && e.message}`, 'utf8');
    }

    // Save screenshot
    try {
      const data = await driver.takeScreenshot();
      fs.writeFileSync(path.join(folder, 'screenshot.png'), data, 'base64');
    } catch (e) {
      fs.writeFileSync(path.join(folder, 'screenshot-error.txt'), `Error capturing screenshot: ${e && e.message}`, 'utf8');
    }

    // Save cookies
    try {
      const cookies = await driver.manage().getCookies();
      fs.writeFileSync(path.join(folder, 'cookies.json'), JSON.stringify(cookies, null, 2), 'utf8');
    } catch (e) {
      fs.writeFileSync(path.join(folder, 'cookies-error.txt'), `Error reading cookies: ${e && e.message}`, 'utf8');
    }

    // Collect alert texts (common Amazon alert selectors)
    const alertSelectors = [
      '#auth-error-message-box',
      '#auth-warning-message-box',
      '.a-alert-inline',
      '.a-list-item',
      '.a-alert-container',
      '.a-alert'
    ];
    const alerts = [];
    for (const sel of alertSelectors) {
      try {
        const els = await driver.findElements(By.css(sel));
        for (const el of els) {
          let t = '';
          try { t = (await el.getText()).trim(); } catch (_) { t = ''; }
          let htmlSnippet = '';
          try { htmlSnippet = await el.getAttribute('outerHTML'); } catch (_) { htmlSnippet = ''; }
          if (t || htmlSnippet) alerts.push({ selector: sel, text: t, outerHTML: htmlSnippet });
        }
      } catch (e) {
        // ignore selector errors
      }
    }
    fs.writeFileSync(path.join(folder, 'alerts.json'), JSON.stringify(alerts, null, 2), 'utf8');

    // Also capture top-level console.log of current URL for convenience
    try {
      const cur = await driver.getCurrentUrl();
      fs.writeFileSync(path.join(folder, 'url.txt'), cur, 'utf8');
    } catch (e) {
      fs.writeFileSync(path.join(folder, 'url-error.txt'), `Error getting URL: ${e && e.message}`, 'utf8');
    }

    return folder;
  } catch (err) {
    console.warn('Failed to write debug artifacts:', err && err.message);
    return null;
  }
}

/**
 * Poll the browser for post-login outcomes: success, otp, captcha, approval, error.
 * Returns an object { status: 'success'|'otp'|'captcha'|'approval'|'error'|'timeout', info }
 */
async function detectPostLoginState(driver, timeoutMs = 120000) {
  const start = Date.now();
  const otpSelectorCandidates = [
    'input[id^="auth-mfa-otpcode"]',
    'input[name="otp"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[id^="auth-mfa"]',
    'input[name="code"]'
  ];
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'div.g-recaptcha',
    'div.recaptcha',
    'img[id*="auth-captcha-image"]',
    'div.captcha'
  ];
  const authErrorSelectors = [
    '#auth-error-message-box',
    '#auth-warning-message-box',
    '.a-alert-inline',
    '.a-list-item'
  ];
  const loginEmailSelectors = [
    '#ap_email',
    'input[name="email"]',
    'input[type="email"]',
    'input[name="emailOrPhone"]'
  ];

  // XPath phrases to detect push-approval flow (various ways sites phrase it)
  const approvalXPaths = [
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'approve sign')]",
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'approve this sign')]",
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'check your amazon app')]",
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'approve on your amazon app')]",
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'approve on your phone')]",
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'approve from your amazon app')]",
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'tap approve')]",
    "//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'approve sign-in')]"
  ];

  while (Date.now() - start < timeoutMs) {
    try {
      const currentUrl = await driver.getCurrentUrl().catch(() => '');
      // If URL moved away from /ap/ we are likely logged in
      if (currentUrl && !currentUrl.includes('/ap/')) {
        return { status: 'success', info: { url: currentUrl } };
      }

      // Check OTP presence
      for (const sel of otpSelectorCandidates) {
        const els = await driver.findElements(By.css(sel));
        if (els && els.length > 0) {
          return { status: 'otp', info: { selector: sel } };
        }
      }

      // Check captcha presence
      for (const sel of captchaSelectors) {
        const els = await driver.findElements(By.css(sel));
        if (els && els.length > 0) {
          return { status: 'captcha', info: { selector: sel } };
        }
      }

      // Check approval (push notification) presence using XPath phrases
      for (const xp of approvalXPaths) {
        try {
          const els = await driver.findElements(By.xpath(xp));
          if (els && els.length > 0) {
            return { status: 'approval', info: { xpath: xp } };
          }
        } catch (e) {
          // ignore bad xpath matches
        }
      }

      // Check explicit auth error or that we're back at the email page (which may indicate failed login)
      for (const sel of authErrorSelectors) {
        const els = await driver.findElements(By.css(sel));
        if (els && els.length > 0) {
          let text = '';
          try { text = await els[0].getText(); } catch (e) {}
          return { status: 'error', info: { selector: sel, text } };
        }
      }

      // If email input reappeared on /ap/ then likely login failed
      for (const sel of loginEmailSelectors) {
        const els = await driver.findElements(By.css(sel));
        if (els && els.length > 0) {
          const cur = await driver.getCurrentUrl().catch(() => '');
          if (cur && cur.includes('/ap/')) {
            return { status: 'error', info: { selector: sel, message: 'Returned to email input (login failed)' } };
          }
        }
      }
    } catch (e) {
      // ignore transient errors and continue polling
    }
    await sleep(1000);
  }

  return { status: 'timeout', info: { timeoutMs } };
}

/**
 * Quick helper to detect if current page is a sign-in page by URL or presence of login inputs.
 */
async function isSignInPage(driver) {
  try {
    const url = await driver.getCurrentUrl().catch(() => '');
    if (url && url.includes('/ap/')) return true;
    const loginSelectors = [
      '#ap_email',
      'input[name="email"]',
      'input[type="email"]',
      'input[name="emailOrPhone"]'
    ];
    for (const sel of loginSelectors) {
      const els = await driver.findElements(By.css(sel));
      if (els && els.length > 0) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

(async function fetchAlexaActivity() {
  // === Profile management ===
  cleanupProfileIfNeeded();
  
  // === Chrome profile (persistent) setup ===
  const userDataDir = getProfilePath();
  const options = new chrome.Options();
  options.addArguments(`--user-data-dir=${userDataDir}`);
  // options.addArguments('--headless=new'); // DON'T enable if you need manual interaction

  console.log(`Using Chrome user-data-dir: ${userDataDir}`);

  let driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

  try {
    // NAVIGATE DIRECTLY to the Alexa activity page first
    await driver.get(activityUrl);
    console.log("Waiting 1.............");

    // Give the page a moment to redirect (if it will)
    await sleep(1500);

    // Check if Amazon redirected us to a sign-in page (or shows sign-in inputs)
    const needSignIn = await isSignInPage(driver);

    if (!needSignIn) {
      // Already authenticated — skip sign-in flow and save cookies
      console.log('Already signed in (direct access to activityUrl) — saving cookies and exiting.');
      let cookies = await driver.manage().getCookies();
      const outputCookiesPath = path.join(__dirname, 'cookies.json');
      fs.writeFileSync(outputCookiesPath, JSON.stringify(cookies, null, 2));
      console.log(`Cookies have been written to ${outputCookiesPath}`);
      // Done — no HTML extraction as requested
      return;
    }

    // If we get here, we need to sign in. The activityUrl redirected us to auth, so proceed with sign-in.
    console.log("Clicking header sign-in link...");
    // attempt to find header sign-in link if present, else continue with page inputs
    try {
      await driver.wait(until.elementLocated(By.id('nav-link-accountList')), 5000);
      const signInLink = await driver.findElement(By.id('nav-link-accountList'));
      await signInLink.click();
    } catch (e) {
      // header link not necessary — page likely already shows inputs
    }

    // Wait for possible signin page (inputs) to appear
    await driver.wait(async () => {
      const url = await driver.getCurrentUrl();
      const inputs = await driver.findElements(By.css('input'));
      return url.includes('/ap/') || inputs.length > 0;
    }, 20000).catch(() => {});

    // Helper finder
    async function findFirstInput(driver, selectors, timeout = 8000) {
      for (const sel of selectors) {
        try {
          await driver.wait(until.elementLocated(By.css(sel)), timeout);
          const el = await driver.findElement(By.css(sel));
          await driver.wait(until.elementIsVisible(el), 5000);
          await driver.wait(until.elementIsEnabled(el), 5000);
          return el;
        } catch (err) {}
      }
      return null;
    }

    // Find email input
    const candidateSelectors = [
      '#ap_email',
      'input[name="email"]',
      'input[type="email"]',
      'input[name="emailOrPhone"]',
      'input[aria-label*="mobile"]',
      'input[aria-label*="email"]',
      'input[placeholder*="mobile"]',
      'input[placeholder*="email"]',
      'input[id^="ap_email"]'
    ];

    let emailField = await findFirstInput(driver, candidateSelectors, 10000);

    if (!emailField) {
      // check if inside iframe
      const iframes = await driver.findElements(By.css('iframe'));
      console.log('Found iframes count:', iframes.length);
      for (let i = 0; i < iframes.length; i++) {
        try {
          await driver.switchTo().frame(i);
          emailField = await findFirstInput(driver, candidateSelectors, 5000);
          if (emailField) {
            console.log('Email field found inside iframe index:', i);
            break;
          }
        } catch (e) {
          // ignore
        } finally {
          await driver.switchTo().defaultContent();
        }
      }
    }

    if (!emailField) {
      try {
        const xpath = `//input[
          contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'email')
          or contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'mobile')
          or contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'email')
          or contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'mobile')
          or @type='email'
        ]`;
        await driver.wait(until.elementLocated(By.xpath(xpath)), 8000);
        emailField = await driver.findElement(By.xpath(xpath));
      } catch (e) {}
    }

    if (!emailField) {
      console.warn('Email input not found — retrying header click and giving extra time...');
      try {
        await driver.wait(until.elementLocated(By.id('nav-link-accountList')), 5000);
        const signInLink = await driver.findElement(By.id('nav-link-accountList'));
        await signInLink.click();
      } catch (e) {}
      await driver.sleep(2000);
      emailField = await findFirstInput(driver, candidateSelectors, 10000);
    }

    if (!emailField) {
      console.error('Email input could not be located. Saving debug artifacts...');
      const folder = await dumpDebugArtifacts(driver, 'email-not-found');
      throw new Error('Could not find Amazon email input after multiple strategies. Debug: ' + (folder || 'no-debug'));
    }

    await emailField.clear();
    await emailField.sendKeys(AMAZON_EMAIL);

    // continue button
    const continueSelectors = ['#continue', 'input#continue', 'button#continue', 'button[name="continue"]', 'input[name="continue"]'];
    let continueButton = null;
    for (const cs of continueSelectors) {
      try {
        await driver.wait(until.elementLocated(By.css(cs)), 3000);
        const cb = await driver.findElement(By.css(cs));
        await driver.wait(until.elementIsVisible(cb), 3000);
        continueButton = cb;
        break;
      } catch (e) {}
    }
    if (!continueButton) {
      await emailField.sendKeys('\n');
    } else {
      await continueButton.click();
    }

    // password
    await driver.wait(until.elementLocated(By.id('ap_password')), 30000);
    let passwordField = await driver.findElement(By.id('ap_password'));
    await passwordField.clear();
    await passwordField.sendKeys(AMAZON_PASSWORD);

    // click sign in
    let signInSubmit = await driver.findElement(By.id('signInSubmit'));
    await signInSubmit.click();

    console.log('If prompted for 2FA or CAPTCHA, please complete it in the browser.');

    // detect post-login state
    const state = await detectPostLoginState(driver, 120000);

    if (state.status === 'success') {
      console.log('Login appears to have completed without OTP/captcha (immediate success).');
    } else if (state.status === 'otp') {
      console.log('Detected an OTP/MFA input on the page (selector:', state.info && state.info.selector, ').');
      console.log('Please enter the OTP in the browser window.');
      await waitForUserPrompt('After entering the OTP in the browser, press Enter here to continue...');
      await sleep(2000);
      const post = await detectPostLoginState(driver, 60000);
      if (post.status === 'success') {
        console.log('Login succeeded after OTP.');
      } else {
        const folder = await dumpDebugArtifacts(driver, 'otp-failed');
        throw new Error('Login did not complete after entering OTP. Debug artifacts: ' + (folder || 'no-debug'));
      }
    } else if (state.status === 'captcha') {
      console.log('CAPTCHA detected (selector: ' + (state.info && state.info.selector) + '). Please solve it in the browser window.');
      await waitForUserPrompt('After solving the CAPTCHA in the browser, press Enter here to continue...');
      await sleep(2000);
      const post = await detectPostLoginState(driver, 60000);
      if (post.status === 'success') {
        console.log('Login succeeded after CAPTCHA solved.');
      } else {
        const folder = await dumpDebugArtifacts(driver, 'captcha-failed');
        throw new Error('Login did not complete after solving CAPTCHA. Debug artifacts: ' + (folder || 'no-debug'));
      }
    } else if (state.status === 'approval') {
      console.log('Detected an "Approve sign-in" (push) flow that requires approval in your Amazon app on your phone.');
      console.log('Please open the Amazon app on your phone and approve the sign-in notification.');
      await waitForUserPrompt('After approving the sign-in on your phone, press Enter here to continue...');
      await sleep(2000);
      const post = await detectPostLoginState(driver, 60000);
      if (post.status === 'success') {
        console.log('Login succeeded after app approval.');
      } else {
        const folder = await dumpDebugArtifacts(driver, 'approval-failed');
        throw new Error('Login did not complete after app approval. Debug artifacts: ' + (folder || 'no-debug'));
      }
    } else if (state.status === 'error') {
      console.error('Authentication error detected:', state.info || '');
      const folder = await dumpDebugArtifacts(driver, 'auth-error');
      console.error('Saved debug artifacts to:', folder || 'unable-to-save-debug');
      console.error('');
      console.error('Suggested next steps:');
      console.error('- Open the saved page.html and screenshot.png in the debug folder to see what Amazon displayed.');
      console.error('- Verify AMAZON_EMAIL and AMAZON_PASSWORD in your .env are correct.');
      console.error('- If you changed account credentials recently, or logged in as another account in this profile, try using a per-account profile folder (see README) or remove the profile folder to force a fresh login.');
      console.error('');
      throw new Error('Authentication failed or returned to login. See debug artifacts: ' + (folder || 'no-debug'));
    } else if (state.status === 'timeout') {
      console.warn('Timed out waiting for post-login state. Proceeding but login may not have completed.');
    } else {
      console.warn('Unknown post-login state:', state);
    }

    // After sign-in either succeeded or timed out, navigate to activity page and save cookies
    await driver.get(activityUrl);
    console.log("Finished Waiting for activityURL")
    await driver.wait(async () => {
      const currentUrl = await driver.getCurrentUrl();
      return currentUrl.includes("/alexa-privacy/apd/");
    }, 20000, "Timed out waiting for '/alexa-privacy/apd/rvh' in the URL");
    
    console.log('Successfully navigated to the Alexa Activity Page.');

    // Save cookies (no HTML extraction)
    let cookies = await driver.manage().getCookies();
    const outputCookiesPath = path.join(__dirname, 'cookies.json');
    fs.writeFileSync(outputCookiesPath, JSON.stringify(cookies, null, 2));
    console.log(`Cookies have been written to ${outputCookiesPath}`);

  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    await driver.quit();
  }
})();
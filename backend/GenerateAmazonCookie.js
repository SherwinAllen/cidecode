// fetchAlexaActivity.js
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const http = require('http');
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
  
  if (!fs.existsSync(profilePath)) {
    return false;
  }
  
  if (!fs.existsSync(markerPath)) {
    return false;
  }
  
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
    
    fs.mkdirSync(profilePath, { recursive: true });
    
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Check if we're on target page
async function isOnTargetPage(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    return currentUrl.includes('/alexa-privacy/apd/');
  } catch (error) {
    return false;
  }
}

// Enhanced function to detect push notification page
async function isOnPushNotificationPage(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    const pageSource = await driver.getPageSource();
    
    // Check for push notification page indicators
    const pushIndicators = [
      // URL patterns for push notification
      currentUrl.includes('/ap/cv/'),
      currentUrl.includes('transactionapprox'),
      // Page content indicators
      pageSource.includes('approve the notification'),
      pageSource.includes('sent to:'),
      pageSource.includes('AmazonShopping'),
      // Element indicators
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'approve the notification')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'check your device')]"
    ];
    
    for (const indicator of pushIndicators) {
      if (typeof indicator === 'string' && indicator.startsWith('//')) {
        // XPath indicator
        try {
          const elements = await driver.findElements(By.xpath(indicator));
          if (elements.length > 0) return true;
        } catch (e) {}
      } else if (indicator === true) {
        return true;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// FIXED: Enhanced 2FA method detection - OTP FIRST, then push notification
async function detect2FAMethod(driver) {
  try {
    console.log('🔍 Detecting 2FA method...');
    
    const currentUrl = await driver.getCurrentUrl();
    const pageSource = await driver.getPageSource();
    
    // FIX: Check for OTP FIRST (highest priority)
    const otpIndicators = [
      // Input field indicators (strongest signal)
      '#auth-mfa-otpcode',
      'input[name="otpCode"]',
      'input[name="code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="otp" i]',
      // Text indicators
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'otp')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'one time password')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'verification code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'text message')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sms')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sent a code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sent an otp')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'enter code')]"
    ];
    
    // Check OTP indicators first
    for (const indicator of otpIndicators) {
      try {
        if (indicator.startsWith('//')) {
          // XPath indicator
          const elements = await driver.findElements(By.xpath(indicator));
          if (elements.length > 0) {
            console.log('✅ Detected OTP 2FA method');
            return 'OTP (SMS/Voice)';
          }
        } else {
          // CSS selector indicator
          const elements = await driver.findElements(By.css(indicator));
          if (elements.length > 0) {
            console.log('✅ Detected OTP 2FA method');
            return 'OTP (SMS/Voice)';
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // FIX: Only AFTER checking OTP, check for push notification
    if (await isOnPushNotificationPage(driver)) {
      console.log('✅ Detected Push Notification 2FA method');
      return 'Push Notification';
    }
    
    // Check other 2FA methods only if OTP and Push are not detected
    const otherMethodIndicators = {
      'Authenticator App': [
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'authenticator app')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'authentication app')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'virtual mfa')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'time-based one-time password')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'totp')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'google authenticator')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'microsoft authenticator')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'authy')]"
      ],
      'Email OTP': [
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'email verification')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sent code to your email')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sent code to your inbox')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'check your email')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'code to your email')]"
      ],
      'Backup Code': [
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'backup code')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'recovery code')]",
        "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'emergency access')]"
      ]
    };
    
    for (const [method, indicators] of Object.entries(otherMethodIndicators)) {
      for (const indicator of indicators) {
        try {
          if (indicator.startsWith('//')) {
            const elements = await driver.findElements(By.xpath(indicator));
            if (elements.length > 0) {
              console.log(`✅ Detected ${method} 2FA method`);
              return method;
            }
          } else {
            const elements = await driver.findElements(By.css(indicator));
            if (elements.length > 0) {
              console.log(`✅ Detected ${method} 2FA method`);
              return method;
            }
          }
        } catch (error) {
          continue;
        }
      }
    }
    
    // Fallback: Check for generic 2FA page elements
    const generic2FAIndicators = [
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-step verification')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-factor authentication')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '2-step verification')]",
      '#auth-mfa-otpcode',
      'input[name="otpCode"]'
    ];
    
    for (const indicator of generic2FAIndicators) {
      try {
        if (indicator.startsWith('//')) {
          const elements = await driver.findElements(By.xpath(indicator));
          if (elements.length > 0) {
            return 'Generic 2FA (Unable to determine specific type)';
          }
        } else {
          const elements = await driver.findElements(By.css(indicator));
          if (elements.length > 0) {
            return 'Generic 2FA (Unable to determine specific type)';
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    return 'Unknown 2FA Method';
  } catch (error) {
    console.warn('Error detecting 2FA method:', error.message);
    return 'Error detecting 2FA method';
  }
}

// FIXED: Enhanced function to check if we're on any kind of 2FA page - OTP FIRST
async function isOn2FAPage(driver) {
  try {
    // FIX: Check for OTP input fields FIRST (highest priority)
    const otpInputSelectors = [
      '#auth-mfa-otpcode',
      'input[name="otpCode"]',
      'input[name="code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]'
    ];
    
    for (const sel of otpInputSelectors) {
      const elements = await driver.findElements(By.css(sel));
      if (elements.length > 0) {
        return true;
      }
    }
    
    // FIX: Only AFTER checking OTP, check for push notification page
    if (await isOnPushNotificationPage(driver)) {
      return true;
    }
    
    const currentUrl = await driver.getCurrentUrl();
    
    // Check for 2FA text indicators
    const otpIndicators = [
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-step verification')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-factor authentication')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'verification code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'enter code')]"
    ];
    
    for (const xpath of otpIndicators) {
      try {
        const elements = await driver.findElements(By.xpath(xpath));
        if (elements.length > 0) {
          return true;
        }
      } catch (e) {}
    }
    
    return currentUrl.includes('/ap/') && 
           (currentUrl.includes('mfa') || 
            currentUrl.includes('otp') || 
            currentUrl.includes('verify'));
    
  } catch (error) {
    return false;
  }
}

// Enhanced wait function with better push notification handling
async function waitForRedirectAfter2FA(driver, timeout = 180000) {
  console.log('⏳ Waiting for automatic redirection to activity page after 2FA...');
  
  const startTime = Date.now();
  let lastState = '2fa_page';
  
  while (Date.now() - startTime < timeout) {
    try {
      const currentUrl = await driver.getCurrentUrl();
      
      // Check if we're on target page
      if (await isOnTargetPage(driver)) {
        console.log('✅ Automatic redirection detected! Now on target page.');
        return true;
      }
      
      // Check if we're on push notification page
      const onPushPage = await isOnPushNotificationPage(driver);
      
      // Check if we're on any 2FA page
      const on2FAPage = await isOn2FAPage(driver);
      
      // Check if we're back on login page (error condition)
      const onLoginPage = await needsFullLogin(driver);
      
      if (onLoginPage && !on2FAPage && !onPushPage) {
        console.log('❌ Unexpectedly returned to login page. 2FA might have failed or timed out.');
        return false;
      }
      
      if (onPushPage) {
        if (lastState !== 'push_page') {
          console.log('📱 On push notification page - waiting for user to approve on device...');
          lastState = 'push_page';
        }
        // Stay on push notification page and wait
        await sleep(5000);
        continue;
      }
      
      if (on2FAPage) {
        if (lastState !== '2fa_page') {
          console.log('🔐 Still on 2FA page, waiting...');
          lastState = '2fa_page';
        }
        await sleep(3000);
        continue;
      }
      
      // If we're not on 2FA page and not on target page, we might be in transition
      if (!on2FAPage && !onPushPage) {
        if (lastState !== 'transition') {
          console.log('🔄 2FA completed, waiting for final redirection...');
          lastState = 'transition';
        }
        await sleep(2000);
        continue;
      }
      
    } catch (error) {
      // If there's an error checking the page, wait and continue
      console.log('⚠️ Error checking page state, continuing to wait...');
      await sleep(5000);
    }
  }
  
  console.log('❌ Timeout waiting for automatic redirection after 2FA');
  return false;
}

// Helper to fill OTP into detected input and submit
async function fillOtpAndSubmit(driver, otp) {
  try {
    console.log('Attempting to auto-fill OTP (masked) ...');
    console.log(`OTP (masked): ${otp ? otp.replace(/\d/g, '*') : ''}`);

    const otpSelectors = [
      '#auth-mfa-otpcode',
      'input[name="otpCode"]',
      'input[name="code"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="otp" i]',
      'input[type="tel"]',
      'input[type="number"]',
      'input[inputmode="numeric"]'
    ];

    let filled = false;
    let inputEl = null;
    for (const sel of otpSelectors) {
      try {
        const els = await driver.findElements(By.css(sel));
        if (els.length > 0) {
          inputEl = els[0];
          await inputEl.clear().catch(()=>{});
          await inputEl.sendKeys(otp);
          filled = true;
          break;
        }
      } catch (e) { /* ignore and continue */ }
    }

    if (!filled) {
      try {
        const els = await driver.findElements(By.xpath("//input[@type='text' or @type='tel' or @type='number'][contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'code') or contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'otp')]"));
        if (els.length > 0) {
          inputEl = els[0];
          await inputEl.clear().catch(()=>{});
          await inputEl.sendKeys(otp);
          filled = true;
        }
      } catch (e) {}
    }

    if (filled && inputEl) {
      // small pause to allow page to react to typed input
      await sleep(400);

      // Prefer the exact selector you provided, then fallbacks
      const submitSelectors = [
        '#cvf-submit-otp-button > span > input',
        'input.a-button-input[type="submit"]',
        'button[type="submit"]',
        'input[type="submit"]'
      ];

      let clicked = false;
      for (const sel of submitSelectors) {
        try {
          const els = await driver.findElements(By.css(sel));
          if (els.length > 0) {
            // scroll into view and click
            try { await driver.executeScript('arguments[0].scrollIntoView(true);', els[0]); } catch(e){}
            try {
              await els[0].click();
              clicked = true;
              break;
            } catch (clickErr) {
              // some inputs require invoking click via JS
              try {
                await driver.executeScript('arguments[0].click();', els[0]);
                clicked = true;
                break;
              } catch (jsClickErr) {}
            }
          }
        } catch (e) { /* ignore and try next */ }
      }

      if (!clicked) {
        // Last resort: press Enter to submit form
        try {
          await driver.actions().sendKeys('\n').perform();
          clicked = true;
        } catch (e) {}
      }

      if (clicked) {
        console.log('OTP auto-submitted.');
      } else {
        console.warn('OTP filled but submit action failed.');
      }
    } else {
      console.warn('Could not locate OTP input to fill.');
    }
  } catch (err) {
    console.warn('Error in fillOtpAndSubmit:', err.message || err);
  }
}

// Helper: post JSON to server internal endpoint
function postJson(pathname, data = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: '127.0.0.1',
      port: 5000,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(options, (res) => {
      let resp = '';
      res.on('data', (d) => resp += d.toString());
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: resp });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Helper: get JSON from server internal endpoint
function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 5000, path: pathname }, (res) => {
      let data = '';
      res.on('data', (d) => data += d.toString());
      res.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (e) {
          resolve({});
        }
      });
    }).on('error', reject);
  });
}

// read REQUEST_ID from env (set by server on spawn)
const REQUEST_ID = process.env.REQUEST_ID || null;

// Set Chrome to headless mode (new headless)
const userDataDir = getProfilePath();
const options = new chrome.Options();
// add headless and common flags
options.addArguments(`--user-data-dir=${userDataDir}`);
options.addArguments('--headless=new');
options.addArguments('--no-sandbox');
options.addArguments('--disable-dev-shm-usage');
options.addArguments('--disable-gpu');

// --- Helper implementations ---

// Heuristic: check if login form (email) is present -> full login likely needed
async function needsFullLogin(driver) {
  try {
    const emailSelectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]', 'input#ap_email'];
    for (const sel of emailSelectors) {
      const els = await driver.findElements(By.css(sel));
      if (els.length > 0) return true;
    }
    const url = await driver.getCurrentUrl();
    if (url.includes('/ap/signin') || url.includes('/ap/login')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// Heuristic: detect if page looks like a lightweight re-auth (password-only) scenario
async function isTrueReAuthScenario(driver) {
  try {
    const passSelectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]'];
    for (const sel of passSelectors) {
      const els = await driver.findElements(By.css(sel));
      if (els.length > 0) return true;
    }
    const url = await driver.getCurrentUrl();
    if (url.includes('/ap/re-auth') || url.includes('/ap/mfa/')) return true;
    // fallback: check page text for re-auth hints
    const source = await driver.getPageSource();
    if (source && /re-auth|reauth|verify it's you|verify your identity/i.test(source)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// Enhanced authentication functions with better error handling
async function performFullAuthentication(driver) {
  try {
    console.log('performFullAuthentication: starting (masked credentials)');
    
    // try to fill email
    try {
      const emailEls = await driver.findElements(By.css('#ap_email, input[name="email"], input[type="email"]'));
      if (emailEls.length > 0) {
        await emailEls[0].clear().catch(()=>{});
        await emailEls[0].sendKeys(AMAZON_EMAIL);
        // click continue if present
        const cont = await driver.findElements(By.css('input#continue, button#continue, input[name="continue"]'));
        if (cont.length > 0) { 
          try { 
            await cont[0].click(); 
            await sleep(2000);
          } catch(e){}
        }
      }
    } catch (e) { 
      console.warn('performFullAuthentication: email fill failed', e.message); 
    }

    // fill password
    try {
      const passEls = await driver.findElements(By.css('#ap_password, input[name="password"], input[type="password"]'));
      if (passEls.length > 0) {
        await passEls[0].clear().catch(()=>{});
        await passEls[0].sendKeys(AMAZON_PASSWORD);
      }
      // click sign-in
      const signEls = await driver.findElements(By.css('input#signInSubmit, button#signInSubmit, button[name="signIn"], input[type="submit"]'));
      if (signEls.length > 0) {
        try { 
          await signEls[0].click(); 
        } catch (e) {}
      } else {
        await driver.actions().sendKeys('\n').perform();
      }
    } catch (e) {
      console.warn('performFullAuthentication: password/submit failed', e.message);
    }

    await sleep(3000);

    // If 2FA page detected, notify server and handle accordingly
    if (await isOn2FAPage(driver)) {
      const method = await detect2FAMethod(driver);
      console.log('performFullAuthentication: 2FA detected ->', method);
      
      if (REQUEST_ID) {
        try { 
          await postJson(`/api/internal/2fa-update/${REQUEST_ID}`, { 
            method, 
            message: method.includes('Push') ? 
              'Please check your device and approve the push notification' : 
              'Please enter the verification code sent to your device' 
          }); 
        } catch(e){}
      }

      if (method && /otp/i.test(method)) {
        // OTP flow - poll backend for OTP
        const start = Date.now();
        let otp = null;
        while (Date.now() - start < 5 * 60 * 1000) {
          await sleep(2000);
          try {
            const resp = await getJson(`/api/internal/get-otp/${REQUEST_ID}`);
            if (resp && resp.otp) { 
              otp = resp.otp; 
              break; 
            }
            if (resp && resp.userConfirmed2FA) break;
          } catch (e) {}
        }
        if (otp) {
          await fillOtpAndSubmit(driver, otp);
          const success = await waitForRedirectAfter2FA(driver);
          if (!success) {
            throw new Error('Failed to complete 2FA redirection');
          }
        } else {
          const success = await waitForRedirectAfter2FA(driver);
          if (!success) {
            throw new Error('2FA timeout or failed');
          }
        }
      } else {
        // Push notification or other non-OTP flow
        console.log('🔄 Waiting for push notification approval...');
        const success = await waitForRedirectAfter2FA(driver);
        if (!success) {
          throw new Error('Push notification approval failed or timed out');
        }
      }
    }

    // Final verification
    const onTarget = await isOnTargetPage(driver);
    if (!onTarget) {
      console.log('Current URL:', await driver.getCurrentUrl());
      throw new Error('Failed to reach target page after authentication');
    }
    
    return onTarget;
  } catch (err) {
    console.warn('performFullAuthentication error:', err.message || err);
    return false;
  }
}

// Update handleReAuth similarly
async function handleReAuth(driver) {
  try {
    console.log('handleReAuth: attempting re-auth (masked)');
    
    // try fill password
    try {
      const passEls = await driver.findElements(By.css('#ap_password, input[name="password"], input[type="password"]'));
      if (passEls.length > 0) {
        await passEls[0].clear().catch(()=>{});
        await passEls[0].sendKeys(AMAZON_PASSWORD);
      }
      const signEls = await driver.findElements(By.css('input#signInSubmit, button#signInSubmit, button[name="signIn"], input[type="submit"]'));
      if (signEls.length > 0) {
        try { 
          await signEls[0].click(); 
        } catch (e) {}
      } else {
        await driver.actions().sendKeys('\n').perform();
      }
    } catch (e) {
      console.warn('handleReAuth: password submit failed', e.message);
    }

    await sleep(2000);

    // If 2FA appears after re-auth, handle same as full auth
    if (await isOn2FAPage(driver)) {
      const method = await detect2FAMethod(driver);
      console.log('handleReAuth: 2FA detected ->', method);
      
      if (REQUEST_ID) {
        try { 
          await postJson(`/api/internal/2fa-update/${REQUEST_ID}`, { 
            method, 
            message: method.includes('Push') ? 
              'Please check your device and approve the push notification' : 
              'Please enter the verification code sent to your device' 
          }); 
        } catch(e){}
      }

      if (method && /otp/i.test(method)) {
        // OTP flow
        const start = Date.now();
        let otp = null;
        while (Date.now() - start < 5 * 60 * 1000) {
          await sleep(2000);
          try {
            const resp = await getJson(`/api/internal/get-otp/${REQUEST_ID}`);
            if (resp && resp.otp) { otp = resp.otp; break; }
            if (resp && resp.userConfirmed2FA) break;
          } catch (e) {}
        }
        if (otp) {
          await fillOtpAndSubmit(driver, otp);
          const success = await waitForRedirectAfter2FA(driver);
          if (!success) {
            throw new Error('Failed to complete 2FA redirection during re-auth');
          }
        } else {
          const success = await waitForRedirectAfter2FA(driver);
          if (!success) {
            throw new Error('2FA timeout or failed during re-auth');
          }
        }
      } else {
        // Push notification flow
        console.log('🔄 Waiting for push notification approval during re-auth...');
        const success = await waitForRedirectAfter2FA(driver);
        if (!success) {
          throw new Error('Push notification approval failed during re-auth');
        }
      }
    }

    const onTarget = await isOnTargetPage(driver);
    if (!onTarget) {
      console.log('Current URL after re-auth:', await driver.getCurrentUrl());
    }
    
    return onTarget;
  } catch (err) {
    console.warn('handleReAuth error:', err.message || err);
    return false;
  }
}

// OPTIMIZED MAIN EXECUTION FLOW
(async function fetchAlexaActivity() {
  cleanupProfileIfNeeded();
  
  const userDataDir = getProfilePath();
  const options = new chrome.Options();
  options.addArguments(`--user-data-dir=${userDataDir}`);

  console.log(`Using Chrome user-data-dir: ${userDataDir}`);

  let driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

  try {
    console.log('=== STARTING ALEXA ACTIVITY FETCH (HEADLESS) ===');
    
    // Step 1: Navigate directly to target page
    console.log('1. Navigating to Alexa activity page...');
    await driver.get(activityUrl);
    await sleep(5000);
    
    let needFinalNavigation = false;
    
    // Step 2: OPTIMIZED - Check current state with better detection
    console.log('2. Checking authentication state...');
    
    if (await isOnTargetPage(driver)) {
      console.log('✅ Already on target page!');
      // No authentication needed
    } 
    // OPTIMIZED: Check for full login FIRST (most common scenario for first run)
    else if (await needsFullLogin(driver)) {
      console.log('🔐 Full authentication required...');
      await performFullAuthentication(driver);
      needFinalNavigation = true;
    }
    // Only then check for true re-authentication
    else if (await isTrueReAuthScenario(driver)) {
      console.log('🔄 Re-authentication required...');
      const reAuthSuccess = await handleReAuth(driver);
      
      if (!reAuthSuccess || !await isOnTargetPage(driver)) {
        console.log('❌ Re-authentication failed, trying full authentication...');
        await performFullAuthentication(driver);
        needFinalNavigation = true;
      }
    }
    else {
      console.log('❓ Unknown state, assuming full authentication is needed...');
      await performFullAuthentication(driver);
      needFinalNavigation = true;
    }
    
    // Step 3: Only navigate if we're not already on the target page
    if (needFinalNavigation && !await isOnTargetPage(driver)) {
      console.log('3. Navigating to target page...');
      await driver.get(activityUrl);
      await sleep(5000);
    } else {
      console.log('3. Already on target page, skipping navigation.');
    }
    
    // Final verification
    if (await isOnTargetPage(driver)) {
      console.log('✅ Successfully reached Alexa activity page!');
      
      // Save cookies
      const cookies = await driver.manage().getCookies();
      const outputCookiesPath = path.join(__dirname, 'cookies.json');
      fs.writeFileSync(outputCookiesPath, JSON.stringify(cookies, null, 2));
      console.log(`💾 Cookies have been written to ${outputCookiesPath}`);
    } else {
      console.log('❌ Failed to reach Alexa activity page');
      const currentUrl = await driver.getCurrentUrl();
      console.log('Final URL:', currentUrl);
      await driver.quit();
      process.exit(1);
    }
  } catch (error) {
    console.error('💥 An error occurred:', error);
  } finally {
    console.log('4. Cleaning up...');
    await driver.quit();
    console.log('=== HEADLESS SESSION COMPLETED ===');
  }
})();